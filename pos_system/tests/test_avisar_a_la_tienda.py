"""
Lo que la venta del mostrador le avisa a la tienda online.

El POS vende los 8.312 productos del catalogo y en la tienda hay 1.077: casi
nueve de cada diez ventas son de algo que no esta publicado. Por eso el aviso
tiene que ser barato, no puede inventar fichas a medias, y sobre todo no puede
voltear una venta.

    python -m pytest pos_system/tests/test_avisar_a_la_tienda.py -q
"""
import os
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, RAIZ)

import pytest

from pos_system.utils.firebase_sync import (
    FirebaseSync,
    descontar_del_conteo,
    entero_de_tienda,
    minimo_publicado,
    variedades_con_stock_nuevo,
)


# ── Una nube de mentira ────────────────────────────────────────────────────

class SnapFalso:
    def __init__(self, datos, version=1):
        self._datos = datos
        self.exists = datos is not None
        self.update_time = version

    def to_dict(self):
        return dict(self._datos) if self._datos is not None else None


class DocFalso:
    def __init__(self, db, coleccion, doc_id):
        self.db = db
        self.coleccion = coleccion
        self.doc_id = doc_id

    def get(self):
        self.db.lecturas.append((self.coleccion, self.doc_id))
        if self.db.explota_al_leer:
            raise RuntimeError('la nube no contesta')
        return SnapFalso(self.db.datos.get(self.coleccion, {}).get(self.doc_id),
                         self.db.versiones.get((self.coleccion, self.doc_id), 1))

    def update(self, datos, option=None):
        actual = self.db.datos.get(self.coleccion, {}).get(self.doc_id)
        if actual is None:
            raise RuntimeError('no existe')
        if option is not None and option != self.db.versiones.get(
                (self.coleccion, self.doc_id), 1):
            raise RuntimeError('cambio en el medio')
        actual.update(datos)
        self.db.escrituras.append(('update', self.coleccion, self.doc_id, dict(datos)))

    def delete(self):
        self.db.datos.get(self.coleccion, {}).pop(self.doc_id, None)
        self.db.escrituras.append(('delete', self.coleccion, self.doc_id, None))


class ColFalsa:
    def __init__(self, db, nombre):
        self.db = db
        self.nombre = nombre

    def document(self, doc_id):
        return DocFalso(self.db, self.nombre, doc_id)


class DbFalsa:
    def __init__(self, datos=None):
        self.datos = datos or {}
        self.versiones = {}
        self.lecturas = []
        self.escrituras = []
        self.explota_al_leer = False

    def collection(self, nombre):
        return ColFalsa(self, nombre)

    def write_option(self, last_update_time=None):
        return last_update_time


@pytest.fixture(autouse=True)
def sin_anotaciones_viejas():
    """La lista negra es de la clase: la comparten todas las instancias y, sin
    esto, un test le dejaria productos anotados al siguiente."""
    FirebaseSync._fuera_de_la_tienda.clear()
    yield
    FirebaseSync._fuera_de_la_tienda.clear()


def sync_con(publicados=None, rubros=None):
    datos = {'tienda_productos': publicados or {}}
    if rubros is not None:
        datos['tienda_config'] = {'rubros': {'lista': rubros}}
    db = DbFalsa(datos)
    return FirebaseSync(db), db


# ── La venta minima ────────────────────────────────────────────────────────

def test_por_debajo_de_la_venta_minima_se_va_de_la_vidriera():
    """Ojos moviles que se venden de a 50 y quedaron 42: el cliente los podia
    poner en el pedido y al confirmar desaparecian."""
    sync, db = sync_con({'p1': {'stock': 92, 'minimo': 50, 'paso': 50,
                                'rubro': 'REGALERIA', 'sub_rubro': 'Ojos'}})

    sync._avisar_a_la_tienda([('p1', 42)])

    assert ('delete', 'tienda_productos', 'p1', None) in db.escrituras
    assert 'p1' not in db.datos['tienda_productos']


def test_con_stock_de_sobra_para_la_minima_se_actualiza_el_numero():
    sync, db = sync_con({'p1': {'stock': 92, 'minimo': 50}})

    sync._avisar_a_la_tienda([('p1', 60)])

    assert db.datos['tienda_productos']['p1']['stock'] == 60


def test_sin_venta_minima_alcanza_con_que_quede_algo():
    sync, db = sync_con({'p1': {'stock': 5}})

    sync._avisar_a_la_tienda([('p1', 1)])

    assert db.datos['tienda_productos']['p1']['stock'] == 1


def test_en_cero_se_da_de_baja():
    sync, db = sync_con({'p1': {'stock': 3}})

    sync._avisar_a_la_tienda([('p1', 0)])

    assert 'p1' not in db.datos['tienda_productos']


# ── Los decimales ──────────────────────────────────────────────────────────

def test_los_metros_sueltos_se_redondean_como_en_el_panel():
    """2,7 metros de cinta: `int()` publicaba 2 y el panel 3, asi que el numero
    de la vidriera cambiaba solo segun quien escribiera ultimo."""
    sync, db = sync_con({'p1': {'stock': 9}})

    sync._avisar_a_la_tienda([('p1', 2.7)])

    assert db.datos['tienda_productos']['p1']['stock'] == 3


def test_entero_de_tienda_usa_floor_mas_medio_y_no_baja_de_cero():
    assert entero_de_tienda(2.7) == 3
    assert entero_de_tienda(2.4) == 2
    # round() de Python redondea al par: 2,5 le daria 2 y 3,5 le daria 4.
    assert entero_de_tienda(2.5) == 3
    assert entero_de_tienda(3.5) == 4
    assert entero_de_tienda(-4) == 0
    assert entero_de_tienda(None) == 0
    assert entero_de_tienda('cualquier cosa') == 0


# ── Las variedades ─────────────────────────────────────────────────────────

COLORES = [{'color': 'CELESTE', 'unidades': 2, 'restante': 3},
           {'color': 'ROJO', 'unidades': 0, 'restante': 4}]

PUBLICADAS = [{'nombre': 'Celeste', 'stock': 40, 'precio': 900,
               'imagen': 'celeste.webp'},
              {'nombre': 'Rojo', 'stock': 12, 'precio': None, 'imagen': None}]

# Lo que el panel decidio de cada color, tal como vive en `tienda_variedades`:
# la clave es el nombre del catalogo normalizado, no el que ve el cliente.
RENOMBRE_CELESTE = {'celeste': {'nombre': 'Celeste Pastel'}}


def test_cada_color_queda_con_su_stock_nuevo():
    """Antes viajaba solo el total: el cliente elegia un color agotado y el
    pedido se caia al confirmarlo."""
    sync, db = sync_con({'p1': {'stock': 52, 'variedades': list(PUBLICADAS)}})

    sync._avisar_a_la_tienda([('p1', 27, COLORES, 10)])

    doc = db.datos['tienda_productos']['p1']
    assert [(v['nombre'], v['stock']) for v in doc['variedades']] == [
        ('Celeste', 23), ('Rojo', 4)]
    # El total es la suma de lo que se ofrece.
    assert doc['stock'] == 27


def test_el_nombre_el_precio_y_la_foto_de_la_variedad_no_se_tocan():
    """Los decide el panel y no viajan en la venta: rearmarlos desde el
    catalogo local los borraria."""
    sync, db = sync_con({'p1': {'stock': 52, 'variedades': list(PUBLICADAS)}})

    sync._avisar_a_la_tienda([('p1', 27, COLORES, 10)])

    celeste = db.datos['tienda_productos']['p1']['variedades'][0]
    assert celeste['precio'] == 900
    assert celeste['imagen'] == 'celeste.webp'


def test_una_variedad_renombrada_desde_el_panel_cruza_igual():
    """El caso que descuadraba la vidriera.

    El panel deja renombrar un color de cara al cliente: el catalogo dice
    "CELESTE" y la tienda muestra "Celeste Pastel". El POS cruzaba el nombre
    del catalogo contra el nombre publicado, no encontraba nada, y esa variedad
    se quedaba con el stock viejo mientras el total viajaba actualizado: la
    ficha decia 27 y los colores sumaban 44.

    Se cruza por el nombre del catalogo normalizado, que es la clave de
    `tienda_variedades` y la misma que usan el sync y el panel.
    """
    publicadas = [{'nombre': 'Celeste Pastel', 'stock': 40},
                  {'nombre': 'Rojo', 'stock': 12}]
    sync, db = sync_con({'p1': {'stock': 52, 'variedades': publicadas}})

    sync._avisar_a_la_tienda([('p1', 27, COLORES, 10, RENOMBRE_CELESTE)])

    doc = db.datos['tienda_productos']['p1']
    assert [(v['nombre'], v['stock']) for v in doc['variedades']] == [
        ('Celeste Pastel', 23), ('Rojo', 4)]
    assert doc['stock'] == 27


def test_el_total_publicado_es_la_suma_de_los_colores_publicados():
    """Se vende una unidad del color renombrado.

    Es la unica cuenta que el cliente puede verificar: el numero grande de la
    ficha tiene que dar lo mismo que sumar color por color, o elige uno y no
    esta.
    """
    publicadas = [{'nombre': 'Celeste Pastel', 'stock': 24},
                  {'nombre': 'Rojo', 'stock': 4}]
    sync, db = sync_con({'p1': {'stock': 28, 'variedades': publicadas}})

    # CELESTE queda en 2 packs de 10 mas 2 sueltas: se vendio una de las tres.
    despues_de_la_venta = [{'color': 'CELESTE', 'unidades': 2, 'restante': 2},
                           {'color': 'ROJO', 'unidades': 0, 'restante': 4}]

    sync._avisar_a_la_tienda(
        [('p1', 26, despues_de_la_venta, 10, RENOMBRE_CELESTE)])

    doc = db.datos['tienda_productos']['p1']
    assert [(v['nombre'], v['stock']) for v in doc['variedades']] == [
        ('Celeste Pastel', 22), ('Rojo', 4)]
    assert doc['stock'] == sum(v['stock'] for v in doc['variedades'])
    assert doc['stock'] == 26


def test_un_color_borrado_del_catalogo_queda_en_cero():
    """No es un renombre: el color ya no existe.

    Los colores viajan completos en cada venta, asi que sabiendo lo que el
    panel renombro, una variedad publicada que no cruza no tiene stock detras.
    Dejarle el numero viejo la sigue ofreciendo y el pedido se cae al
    confirmarlo. La fila se conserva (el nombre, el precio y la foto son del
    panel) y el sync la saca en la proxima corrida.
    """
    publicadas = [{'nombre': 'Celeste', 'stock': 40, 'precio': 900,
                   'imagen': 'celeste.webp'},
                  {'nombre': 'Verde Agua', 'stock': 12, 'precio': 900,
                   'imagen': 'verde.webp'}]
    sync, db = sync_con({'p1': {'stock': 52, 'variedades': publicadas}})

    # El catalogo ya no tiene VERDE AGUA y el panel no lo renombro.
    sync._avisar_a_la_tienda([('p1', 27, COLORES, 10, {})])

    doc = db.datos['tienda_productos']['p1']
    assert [(v['nombre'], v['stock']) for v in doc['variedades']] == [
        ('Celeste', 23), ('Verde Agua', 0)]
    assert doc['stock'] == 23
    # El resto de la fila es del panel y no se toca.
    assert doc['variedades'][1]['imagen'] == 'verde.webp'


def test_sin_lo_que_decidio_el_panel_la_variedad_que_no_cruza_se_deja_como_esta():
    """La lectura del catalogo puede fallar (la nube no contesta) y ahi no hay
    forma de separar un renombre de un color borrado. Ponerla en cero sacaria
    de la venta un color que existe, asi que se deja igual y lo arregla el
    sync."""
    publicadas = [{'nombre': 'Celeste Pastel', 'stock': 40},
                  {'nombre': 'Rojo', 'stock': 12}]
    sync, db = sync_con({'p1': {'stock': 52, 'variedades': publicadas}})

    sync._avisar_a_la_tienda([('p1', 27, COLORES, 10, None)])

    doc = db.datos['tienda_productos']['p1']
    assert [(v['nombre'], v['stock']) for v in doc['variedades']] == [
        ('Celeste Pastel', 40), ('Rojo', 4)]
    # Aun asi el total sigue siendo la suma de lo que se ofrece.
    assert doc['stock'] == sum(v['stock'] for v in doc['variedades'])


def test_un_color_escondido_y_renombrado_no_se_lleva_puesto_a_otro():
    """`tienda_variedades` guarda todo junto: los escondidos tambien pueden
    tener nombre propio. Ese nombre no esta en la lista publicada y no tiene
    que pisar el stock de ningun otro color."""
    publicadas = [{'nombre': 'Rojo', 'stock': 12}]
    ajustes = {'celeste': {'nombre': 'Rojo', 'publicar': False}}
    sync, db = sync_con({'p1': {'stock': 52, 'variedades': publicadas}})

    sync._avisar_a_la_tienda([('p1', 27, COLORES, 10, ajustes)])

    doc = db.datos['tienda_productos']['p1']
    # Gana el color del catalogo que de verdad se llama asi.
    assert doc['variedades'] == [{'nombre': 'Rojo', 'stock': 4}]


def test_una_variedad_escondida_no_vuelve_a_aparecer():
    """El panel la saco de la lista publicada; el POS no la agrega ni la suma
    al total."""
    publicadas = [{'nombre': 'Celeste', 'stock': 40}]
    sync, db = sync_con({'p1': {'stock': 52, 'variedades': publicadas}})

    sync._avisar_a_la_tienda([('p1', 27, COLORES, 10)])

    doc = db.datos['tienda_productos']['p1']
    assert [v['nombre'] for v in doc['variedades']] == ['Celeste']
    assert doc['stock'] == 23


def test_sin_variedades_publicadas_solo_viaja_el_total():
    sync, db = sync_con({'p1': {'stock': 52}})

    sync._avisar_a_la_tienda([('p1', 27, COLORES, 10)])

    assert db.datos['tienda_productos']['p1']['stock'] == 27
    assert 'variedades' not in db.escrituras[0][3]


def test_variedades_con_stock_nuevo_avisa_cuando_no_hay_nada_que_hacer():
    assert variedades_con_stock_nuevo(None, COLORES, 10) is None
    assert variedades_con_stock_nuevo([], COLORES, 10) is None
    assert variedades_con_stock_nuevo(PUBLICADAS, [], 10) is None
    # Ninguna cruza y no llego lo que decidio el panel: no hay con que saber si
    # es un renombre o un color borrado, asi que manda el total y la lista no se
    # toca.
    otras = [{'nombre': 'Verde Agua', 'stock': 5}]
    assert variedades_con_stock_nuevo(otras, COLORES, 10) is None


def test_todas_las_variedades_en_cero_dan_de_baja_el_producto():
    vacios = [{'color': 'CELESTE', 'unidades': 0, 'restante': 0},
              {'color': 'ROJO', 'unidades': 0, 'restante': 0}]
    sync, db = sync_con({'p1': {'stock': 52, 'variedades': list(PUBLICADAS)}})

    sync._avisar_a_la_tienda([('p1', 0, vacios, 10)])

    assert 'p1' not in db.datos['tienda_productos']


# ── Lo que no esta publicado ───────────────────────────────────────────────

def test_lo_que_no_esta_en_la_tienda_no_se_escribe_ni_se_inventa():
    sync, db = sync_con({})

    sync._avisar_a_la_tienda([('p1', 5)])

    assert db.escrituras == []
    assert 'p1' in FirebaseSync._fuera_de_la_tienda


def test_el_anotado_no_se_vuelve_a_preguntar_en_la_misma_media_hora():
    sync, db = sync_con({})

    sync._avisar_a_la_tienda([('p1', 5)])
    sync._avisar_a_la_tienda([('p1', 4)])

    assert len(db.lecturas) == 1


def test_la_anotacion_vence_y_el_recien_publicado_vuelve_a_recibir_el_stock():
    """Paso el 08-09: al prender dos rubros, 35 productos pasaron a estar
    publicados y las PCs los tenian anotados desde la mañana."""
    sync, db = sync_con({})

    sync._avisar_a_la_tienda([('p1', 5)])
    assert db.escrituras == []

    # El panel lo publica y pasa el plazo.
    db.datos['tienda_productos']['p1'] = {'stock': 9}
    FirebaseSync._fuera_de_la_tienda['p1'] -= (
        FirebaseSync._MINUTOS_DE_LA_ANOTACION * 60 + 1)

    sync._avisar_a_la_tienda([('p1', 4)])

    assert db.datos['tienda_productos']['p1']['stock'] == 4
    # Y ya no esta anotado: la proxima venta le avisa sin esperar nada.
    assert 'p1' not in FirebaseSync._fuera_de_la_tienda


def test_el_que_se_dio_de_baja_queda_anotado_y_no_se_relee_enseguida():
    sync, db = sync_con({'p1': {'stock': 1}})

    sync._avisar_a_la_tienda([('p1', 0)])
    sync._avisar_a_la_tienda([('p1', 0)])

    assert db.lecturas.count(('tienda_productos', 'p1')) == 1


# ── El conteo de la portada ────────────────────────────────────────────────

LISTA = [{'nombre': 'Regaleria', 'clave': 'REGALERIA', 'cantidad': 12,
          'con_stock': 12,
          'subrubros': [{'nombre': 'Aros', 'clave': 'AROS', 'cantidad': 1},
                        {'nombre': 'Anillos', 'clave': 'ANILLOS', 'cantidad': 11}]},
         {'nombre': 'Papelera', 'clave': 'PAPELERA', 'cantidad': 30,
          'con_stock': 30, 'subrubros': []}]


def test_la_ultima_unidad_vendida_baja_el_filtro_de_la_portada():
    """El "Aros 1" que promete un filtro y adentro no hay nada."""
    sync, db = sync_con(
        {'p1': {'stock': 1, 'rubro': 'REGALERIA', 'sub_rubro': 'Aros'}},
        rubros=[dict(r, subrubros=[dict(s) for s in r['subrubros']]) for r in LISTA])

    sync._avisar_a_la_tienda([('p1', 0)])

    lista = db.datos['tienda_config']['rubros']['lista']
    assert lista[0]['cantidad'] == 11
    assert lista[0]['con_stock'] == 11
    assert lista[0]['subrubros'][0]['cantidad'] == 0
    assert lista[0]['subrubros'][1]['cantidad'] == 11
    # El otro rubro no se toca.
    assert lista[1]['cantidad'] == 30


def test_un_producto_de_un_grupo_de_tamaños_no_descuenta():
    """La tienda muestra el grupo como una sola card y sigue ahi mientras quede
    otro tamaño: restarlo esconderia un filtro que si tiene productos."""
    sync, db = sync_con(
        {'p1': {'stock': 1, 'rubro': 'REGALERIA', 'sub_rubro': 'Aros',
                'grupo': 'Aro Argolla'}},
        rubros=[dict(r, subrubros=[dict(s) for s in r['subrubros']]) for r in LISTA])

    sync._avisar_a_la_tienda([('p1', 0)])

    assert db.datos['tienda_config']['rubros']['lista'][0]['cantidad'] == 12


def test_el_conteo_no_se_toca_si_solo_cambio_el_stock():
    sync, db = sync_con(
        {'p1': {'stock': 9, 'rubro': 'REGALERIA', 'sub_rubro': 'Aros'}},
        rubros=[dict(r) for r in LISTA])

    sync._avisar_a_la_tienda([('p1', 4)])

    assert ('tienda_config', 'rubros') not in db.lecturas


def test_si_alguien_reescribio_la_lista_en_el_medio_la_baja_no_pisa_nada():
    """El sync y el panel rehacen `tienda_config/rubros` entero: sin la version
    como condicion, esta PC devolvia la portada al conteo viejo."""
    sync, db = sync_con(
        {'p1': {'stock': 1, 'rubro': 'REGALERIA', 'sub_rubro': 'Aros'}},
        rubros=[dict(r) for r in LISTA])
    db.versiones[('tienda_config', 'rubros')] = 7

    class DocQueCambia(DocFalso):
        def update(self, datos, option=None):
            if self.coleccion == 'tienda_config':
                # El sync commiteo entre la lectura y la escritura.
                self.db.versiones[('tienda_config', 'rubros')] = 8
            return super().update(datos, option)

    db.collection = lambda nombre: type(
        'C', (), {'document': lambda _s, doc_id: DocQueCambia(db, nombre, doc_id)})()

    # No revienta, el producto igual se dio de baja y la lista quedo como la
    # dejo el que escribio ultimo.
    sync._avisar_a_la_tienda([('p1', 0)])

    assert 'p1' not in db.datos['tienda_productos']
    assert db.datos['tienda_config']['rubros']['lista'][0]['cantidad'] == 12


def test_descontar_del_conteo_no_baja_de_cero_ni_inventa_rubros():
    lista = [{'clave': 'REGALERIA', 'cantidad': 1, 'con_stock': 1,
              'subrubros': [{'clave': 'AROS', 'cantidad': 0}]}]

    nueva = descontar_del_conteo(lista, [('REGALERIA', 'Aros'),
                                         ('REGALERIA', 'Aros')])

    assert nueva[0]['cantidad'] == 0
    assert nueva[0]['con_stock'] == 0
    assert nueva[0]['subrubros'][0]['cantidad'] == 0
    # Sin coincidencias no hay escritura que hacer.
    assert descontar_del_conteo(lista, [('LIBRERIA', 'Boligrafo')]) is None
    assert descontar_del_conteo(None, [('REGALERIA', 'Aros')]) is None
    assert descontar_del_conteo(lista, []) is None


def test_descontar_del_conteo_no_le_pega_al_rubro_que_no_es():
    lista = [dict(r, subrubros=[dict(s) for s in r['subrubros']]) for r in LISTA]

    nueva = descontar_del_conteo(lista, [(' regaleria ', 'aros')])

    assert nueva[0]['cantidad'] == 11
    assert nueva[0]['subrubros'][0]['cantidad'] == 0


# ── Nada de esto puede voltear una venta ───────────────────────────────────

def test_si_la_nube_no_contesta_el_aviso_se_traga_solo():
    sync, db = sync_con({'p1': {'stock': 5}})
    db.explota_al_leer = True

    sync._avisar_a_la_tienda([('p1', 4)])

    assert db.escrituras == []
    assert 'p1' in FirebaseSync._fuera_de_la_tienda


def test_sin_sync_habilitado_no_se_hace_nada():
    sync, db = sync_con({'p1': {'stock': 5}})
    sync.enabled = False

    sync._avisar_a_la_tienda([('p1', 4)])

    assert db.lecturas == []


def test_el_aviso_de_una_vinculacion_sigue_llegando_con_dos_datos():
    """La cola de vinculos (el papel de una impresion) avisa `(id, total)`, sin
    colores: la forma vieja tiene que seguir andando."""
    sync, db = sync_con({'papel': {'stock': 500}})

    sync._avisar_a_la_tienda([('papel', 480.4)])

    assert db.datos['tienda_productos']['papel']['stock'] == 480


def test_minimo_publicado_aguanta_lo_que_venga():
    assert minimo_publicado({'minimo': 50}) == 50
    assert minimo_publicado({'minimo': None}) == 0
    assert minimo_publicado({}) == 0
    assert minimo_publicado({'minimo': 'medio metro'}) == 0
