"""
Corre las reglas del sync sobre los casos de prueba y escupe el resultado como
JSON: `armar_documento()`, `se_publica()`, `contar_rubros()` y los descuentos.

Existe para una sola cosa: que las pruebas de la tienda puedan comparar lo que
hace el sync con lo que hace el panel. `tienda/pruebas/espejo.test.js` compara
el documento y la regla de rubros contra `webapp/src/tienda_espejo.js`,
`tienda/pruebas/recuento_rubros.test.js` compara el conteo de la portada contra
`recomputarRubros()`, y `tienda/pruebas/descuentos_regla.test.js` compara los
descuentos contra `webapp/src/tienda_descuentos_regla.js`. Son dos
implementaciones de la misma regla, en dos lenguajes, y si se separan la tienda
muestra una cosa hasta que corre el sync y otra despues.

    python scripts/casos_espejo.py

No toca Firestore ni necesita credenciales.
"""
import json
import os
import sys
from datetime import datetime

RAIZ = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, RAIZ)

# sync_tienda importa firebase_admin al abrirse, pero solo lo usa dentro de
# conectar(). El SERVER_TIMESTAMP que mete armar_documento se descarta abajo:
# es un centinela, no un valor.
from sync_tienda import (  # noqa: E402
    aplicar_descuento, armar_documento, contar_rubros, descuentos_vigentes,
    nombre_bonito, se_publica,
)

CASOS = os.path.join(os.path.dirname(RAIZ), 'tienda', 'pruebas', 'casos_espejo.json')

# Casos de la regla rubro / subrubro. El panel corre la suya sobre estos mismos
# datos y compara: si una de las dos implementaciones cambia sola, el sync
# termina republicando lo que el panel saco.
CASOS_PUBLICACION = [
    {
        'que_prueba': 'rubro habilitado, sin subrubros excluidos',
        'datos': {'nombre': 'Cuaderno', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos'},
        'rubros': ['LIBRERIA'], 'excluidos': {},
    },
    {
        'que_prueba': 'subrubro excluido dentro de un rubro habilitado',
        'datos': {'nombre': 'Abrochadora', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'LIBRERIA', 'sub_rubro': 'Abrochadora'},
        'rubros': ['LIBRERIA'], 'excluidos': {'LIBRERIA': ['ABROCHADORA']},
    },
    {
        'que_prueba': 'el subrubro se compara sin importar como este escrito',
        'datos': {'nombre': 'Abrochadora', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'LIBRERIA', 'sub_rubro': '  abrochadora '},
        'rubros': ['LIBRERIA'], 'excluidos': {'LIBRERIA': ['ABROCHADORA']},
    },
    {
        'que_prueba': 'el mismo subrubro en otro rubro no se toca',
        'datos': {'nombre': 'Abrochadora chica', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'PAPELERA', 'sub_rubro': 'Abrochadora'},
        'rubros': ['LIBRERIA', 'PAPELERA'], 'excluidos': {'LIBRERIA': ['ABROCHADORA']},
    },
    {
        'que_prueba': 'el rubro apagado gana sobre todo lo demas',
        'datos': {'nombre': 'Cuaderno', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'JUGUETERIA', 'sub_rubro': 'Cuadernos'},
        'rubros': ['LIBRERIA'], 'excluidos': {},
    },
    # "Publicar siempre" fuerza ADENTRO de un rubro prendido: sirve para sacar
    # un producto de un subrubro excluido o para adelantarlo antes de que le
    # saquen la foto. Fuera de eso no manda.
    {
        'que_prueba': 'incluido a mano le gana al subrubro excluido',
        'datos': {'nombre': 'Abrochadora', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'LIBRERIA', 'sub_rubro': 'Abrochadora',
                  'tienda_publicar': True},
        'rubros': ['LIBRERIA'], 'excluidos': {'LIBRERIA': ['ABROCHADORA']},
    },
    {
        'que_prueba': 'incluido a mano le gana a la falta de foto en un rubro prendido',
        'datos': {'nombre': 'Cuaderno', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos',
                  'tienda_publicar': True},
        'rubros': ['LIBRERIA'], 'excluidos': {},
    },
    # Desde el 2026-09-08 el rubro apagado le gana a la marca a mano: la dueña
    # destildo Cotillon y Merceria en Configuracion de la Tienda y tres
    # productos marcados con "publicar siempre" siguieron en la vidriera.
    {
        'que_prueba': 'incluido a mano NO le gana al rubro apagado',
        'datos': {'nombre': 'Guirnalda', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'JUGUETERIA', 'sub_rubro': 'Cotillon',
                  'tienda_publicar': True},
        'rubros': ['LIBRERIA'], 'excluidos': {},
    },
    {
        'que_prueba': 'sin stock no sale, aunque el subrubro este permitido',
        'datos': {'nombre': 'Cuaderno', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 0, 'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos'},
        'rubros': ['LIBRERIA'], 'excluidos': {},
    },
    # Sin lista de rubros = "contestame por el resto de las reglas". Asi
    # pregunta quien quiere saber por que un producto no esta en la tienda.
    # El sync reventaba con TypeError donde el panel contestaba.
    {
        'que_prueba': 'sin lista de rubros contesta por el resto de las reglas',
        'datos': {'nombre': 'Cuaderno', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'JUGUETERIA', 'sub_rubro': 'Cuadernos'},
        'rubros': None, 'excluidos': {},
    },
    {
        'que_prueba': 'sin lista de rubros el subrubro excluido igual pesa',
        'datos': {'nombre': 'Abrochadora', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'LIBRERIA', 'sub_rubro': 'Abrochadora'},
        'rubros': None, 'excluidos': {'LIBRERIA': ['ABROCHADORA']},
    },
    {
        'que_prueba': 'sin lista de rubros el que no tiene stock sigue sin salir',
        'datos': {'nombre': 'Cuaderno', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 0, 'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos'},
        'rubros': None, 'excluidos': {},
    },
    # Hay stock, pero menos que la venta minima: no se puede comprar, asi que
    # no se ofrece. Medido en el catalogo real: tres productos entraban al
    # pedido y desaparecian al confirmarlo.
    {
        'que_prueba': 'con menos stock que la venta minima no sale',
        'datos': {'nombre': 'Ojos Moviles', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 42, 'rubro': 'LIBRERIA', 'sub_rubro': 'Apliques',
                  'tienda_minimo': 50},
        'rubros': ['LIBRERIA'], 'excluidos': {},
    },
    {
        'que_prueba': 'con stock justo para la venta minima si sale',
        'datos': {'nombre': 'Ojos Moviles', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 50, 'rubro': 'LIBRERIA', 'sub_rubro': 'Apliques',
                  'tienda_minimo': 50},
        'rubros': ['LIBRERIA'], 'excluidos': {},
    },
    # Rubro apagado Y subrubro excluido a la vez: las dos implementaciones
    # tienen que nombrar la MISMA regla, o el panel dice una cosa y el
    # diagnostico del sync otra sobre el mismo producto. Con la lista de rubros
    # puesta el rubro se mira primero, asi que los dos culpan al rubro: es lo
    # que hay que ir a arreglar (prender el rubro, no destildar el subrubro).
    {
        'que_prueba': 'rubro apagado y subrubro excluido: gana el rubro en los dos',
        'datos': {'nombre': 'Abrochadora', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'JUGUETERIA', 'sub_rubro': 'Abrochadora'},
        'rubros': ['LIBRERIA'], 'excluidos': {'JUGUETERIA': ['ABROCHADORA']},
    },
]

# La misma regla se llama distinto de cada lado ("rubro no habilitado" contra
# "el rubro no está habilitado"). Para comparar interesa CUAL regla disparo, no
# como esta redactada: cada motivo se lleva a una de estas claves.
def clave_de_motivo(motivo):
    m = str(motivo or '').lower()
    if 'subrubro' in m:
        return 'subrubro'
    if 'rubro' in m:
        return 'rubro'
    if 'stock' in m:
        return 'stock'
    if 'precio' in m:
        return 'precio'
    if 'foto' in m:
        return 'foto'
    if 'activo' in m:
        return 'activo'
    if 'duplicado' in m:
        return 'duplicado'
    if 'nombre' in m:
        return 'nombre'
    if 'interno' in m:
        return 'interno'
    if 'mano' in m:
        return 'mano'
    return 'ok'


def publicacion():
    """Corre `se_publica()` sobre los casos de la regla rubro / subrubro."""
    salida = []
    for caso in CASOS_PUBLICACION:
        excluidos = {r: set(s) for r, s in caso['excluidos'].items()}
        rubros = None if caso['rubros'] is None else set(caso['rubros'])
        ok, motivo = se_publica(caso['datos'], rubros, excluidos)
        salida.append({'que_prueba': caso['que_prueba'], 'datos': caso['datos'],
                       'rubros': caso['rubros'], 'excluidos': caso['excluidos'],
                       'publica': bool(ok), 'motivo': motivo,
                       'regla': clave_de_motivo(motivo) if not ok else 'ok'})
    return salida


def _publicable(nombre, rubro, sub_rubro, **extra):
    """Un producto del catalogo que pasa todas las reglas de curado.

    Del conteo solo interesan rubro, subrubro y grupo de tamaños; el resto son
    los campos minimos para que `se_publica()` lo deje salir a la vidriera.
    """
    datos = {'nombre': nombre, 'estado': 'activo', 'precio_venta': 100,
             'stock': 5, 'rubro': rubro, 'sub_rubro': sub_rubro,
             'tienda_imagenes': ['foto.jpg']}
    datos.update(extra)
    return datos


# Casos del conteo de la portada (`tienda_config/rubros`: que rubros y
# subrubros hay publicados y cuantos productos tiene cada uno). Lo escriben los
# DOS lados: contar_rubros() en cada corrida del sync y recomputarRubros() en el
# panel unos segundos despues de cada cambio suelto.
#
# Nadie los comparaba y estaban separados: el sync agrupa los subrubros por el
# nombre que PUBLICA (nombre_bonito, o sea "BOLIGRAFO" y "BOLÍGRAFO" son el
# mismo cajon) y el panel lo hacia por el texto crudo del catalogo. La segunda
# fila de filtros de la tienda mostraba el mismo subrubro dos veces, con la
# mitad de los productos en cada uno, hasta la corrida siguiente del sync.
CASOS_CONTEO = [
    {
        'que_prueba': 'cuenta por rubro y por subrubro lo que quedo publicado',
        'rubros': ['LIBRERIA'], 'excluidos': {},
        'productos': [
            {'doc_id': 'a1', 'datos': _publicable('AROS DE METAL', 'LIBRERIA', 'AROS CARPETA')},
            {'doc_id': 'a2', 'datos': _publicable('CUADERNO', 'LIBRERIA', 'CUADERNOS')},
            {'doc_id': 'a3', 'datos': _publicable('CUADERNO CHICO', 'LIBRERIA', 'CUADERNOS')},
            # Rubro apagado: ni el rubro ni sus subrubros entran a la portada.
            {'doc_id': 'a4', 'datos': _publicable('LANA', 'MERCERIA', 'LANA')},
            # Marcado a mano, pero en un rubro apagado: tampoco cuenta.
            {'doc_id': 'a5', 'datos': _publicable('BENGALA', 'COTILLON', 'BENGALAS',
                                                  tienda_publicar=True)},
        ],
    },
    {
        'que_prueba': 'el mismo subrubro escrito distinto es UN solo filtro',
        # En el catalogo el mismo cajon aparece como "BOLIGRAFO", "BOLÍGRAFO" y
        # " boligrafo ", y "AROS  CARPETA" con dos espacios. La tienda los junta
        # porque compara el subrubro ya publicado; el conteo tiene que decir lo
        # mismo o quedan filtros repetidos con la mitad de los productos.
        'rubros': ['LIBRERIA'], 'excluidos': {},
        'productos': [
            {'doc_id': 'b1', 'datos': _publicable('BOLIGRAFO AZUL', 'LIBRERIA', 'BOLIGRAFO')},
            {'doc_id': 'b2', 'datos': _publicable('BOLIGRAFO ROJO', 'LIBRERIA', 'BOLÍGRAFO')},
            {'doc_id': 'b3', 'datos': _publicable('BOLIGRAFO NEGRO', 'LIBRERIA', '  boligrafo ')},
            {'doc_id': 'b4', 'datos': _publicable('AROS', 'LIBRERIA', 'AROS  CARPETA')},
            {'doc_id': 'b5', 'datos': _publicable('AROS GRANDES', 'LIBRERIA', 'Aros Carpeta')},
        ],
    },
    {
        'que_prueba': 'un grupo de tamaños cuenta una sola vez por rubro y por subrubro',
        # La tienda pliega los tamaños de un mismo grupo en UNA card. Contando
        # cada medida, la portada prometia cuarenta productos y adentro se veian
        # doce cards.
        'rubros': ['LIBRERIA'], 'excluidos': {},
        'productos': [
            {'doc_id': 'c1', 'datos': _publicable('CIERRE 10', 'LIBRERIA', 'CIERRES',
                                                  tienda_grupo='Cierre Común',
                                                  tienda_tamano='10 cm')},
            # El grupo se compara normalizado: el panel puede cambiarle las
            # mayusculas o las tildes al nombre visible sin partirlo en dos.
            {'doc_id': 'c2', 'datos': _publicable('CIERRE 12', 'LIBRERIA', 'CIERRES',
                                                  tienda_grupo='cierre comun',
                                                  tienda_tamano='12 cm')},
            # El mismo grupo en otro subrubro: suma en ese subrubro, pero el
            # rubro lo sigue contando una sola vez.
            {'doc_id': 'c3', 'datos': _publicable('CIERRE 14', 'LIBRERIA', 'MERCERIA FINA',
                                                  tienda_grupo='Cierre Común',
                                                  tienda_tamano='14 cm')},
            {'doc_id': 'c4', 'datos': _publicable('CUADERNO', 'LIBRERIA', 'CUADERNOS')},
        ],
    },
    {
        'que_prueba': 'el subrubro excluido y el que no tiene foto no entran al conteo',
        'rubros': ['LIBRERIA'], 'excluidos': {'LIBRERIA': ['ABROCHADORA']},
        'productos': [
            {'doc_id': 'd1', 'datos': _publicable('ABROCHADORA', 'LIBRERIA', 'Abrochadora')},
            # Adentro de un rubro prendido la marca a mano le gana al subrubro
            # excluido: este si esta en la tienda, asi que si cuenta.
            {'doc_id': 'd2', 'datos': _publicable('ABROCHADORA CHICA', 'LIBRERIA', 'Abrochadora',
                                                  tienda_publicar=True)},
            {'doc_id': 'd3', 'datos': _publicable('CUADERNO SIN FOTO', 'LIBRERIA', 'CUADERNOS',
                                                  tienda_imagenes=[])},
            {'doc_id': 'd4', 'datos': _publicable('CUADERNO', 'LIBRERIA', 'CUADERNOS')},
        ],
    },
    {
        'que_prueba': 'dos rubros prendidos a la vez no se mezclan',
        # "Abrochadora" existe como subrubro en Libreria y en Papelera: cada
        # rubro cuenta el suyo, y el destildado de uno no toca al otro.
        'rubros': ['LIBRERIA', 'PAPELERA'], 'excluidos': {'PAPELERA': ['ABROCHADORA']},
        'productos': [
            {'doc_id': 'e1', 'datos': _publicable('ABROCHADORA', 'LIBRERIA', 'Abrochadora')},
            {'doc_id': 'e2', 'datos': _publicable('ABROCHADORA CHICA', 'PAPELERA', 'Abrochadora')},
            {'doc_id': 'e3', 'datos': _publicable('RESMA', 'PAPELERA', 'RESMAS')},
            {'doc_id': 'e4', 'datos': _publicable('RESMA CHICA', 'PAPELERA', 'RESMAS')},
        ],
    },
    {
        'que_prueba': 'el producto sin subrubro cuenta en el rubro y no inventa un filtro vacio',
        'rubros': ['LIBRERIA'], 'excluidos': {},
        'productos': [
            {'doc_id': 'f1', 'datos': _publicable('SUELTO', 'LIBRERIA', '')},
            {'doc_id': 'f2', 'datos': _publicable('CUADERNO', 'LIBRERIA', 'CUADERNOS')},
        ],
    },
]


def conteo():
    """Corre `contar_rubros()` sobre los casos del conteo de la portada.

    El sync no cuenta el catalogo crudo: cuenta los documentos que ya paso por
    `se_publica()` y `armar_documento()`. Aca se hace igual, porque de ahi sale
    la diferencia que importa: el subrubro del documento viene con las tildes
    que le pone `nombre_bonito()`.

    Lo facturado no viaja: sale de las ventas del local, el panel no lo tiene y
    solo sirve para ordenar los rubros de la portada.
    """
    salida = []
    for caso in CASOS_CONTEO:
        excluidos = {r: set(s) for r, s in caso['excluidos'].items()}
        rubros = None if caso['rubros'] is None else set(caso['rubros'])
        publicables = {}
        for p in caso['productos']:
            ok, _motivo = se_publica(p['datos'], rubros, excluidos)
            if ok:
                publicables[p['doc_id']] = armar_documento(p['doc_id'], p['datos'])
        cantidades, con_stock, _factura, subrubros = contar_rubros(publicables)
        salida.append({
            'que_prueba': caso['que_prueba'], 'rubros': caso['rubros'],
            'excluidos': caso['excluidos'], 'productos': caso['productos'],
            'publicables': list(publicables),
            # Los rubros van sin ordenar a proposito: el sync los ordena por lo
            # que factura cada uno y el panel conserva el orden que ya tenia la
            # portada. Son dos ordenes distintos y los dos correctos; lo que
            # tiene que coincidir son los numeros y los subrubros de cada rubro.
            'rubros_contados': [
                {'clave': r, 'nombre': nombre_bonito(r), 'cantidad': n,
                 'con_stock': con_stock.get(r, 0),
                 'subrubros': [{'clave': s, 'nombre': nombre_bonito(s), 'cantidad': c}
                               for s, c in sorted(subrubros.get(r, {}).items(),
                                                  key=lambda x: -x[1])]}
                for r, n in cantidades.items()
            ],
        })
    return salida


# Casos de los descuentos de la tienda (`tienda_descuentos`). El panel rebaja el
# precio en el momento de espejar un producto y el sync lo vuelve a calcular en
# cada corrida, sobre el documento que dejo el panel: si las dos cuentas no dan
# EXACTAMENTE lo mismo, el precio de la vidriera cambia solo cada seis horas.
#
# `ahora` va siempre con zona horaria: las fechas de Firestore vienen con la
# suya y compararlas contra una fecha pelada revienta.
CASOS_DESCUENTOS = [
    {
        'que_prueba': 'un porcentaje sobre el rubro, con el pack rebajado igual',
        'ahora': '2026-09-08T12:00:00+00:00',
        'descuentos': [
            {'id': 'd1', 'datos': {'nombre': 'Semana del cuaderno', 'tipo': 'porcentaje',
                                   'valor': 20, 'alcance': 'rubro', 'objetivo': 'LIBRERIA'}},
        ],
        'productos': [
            # El objetivo se guarda desde el catalogo crudo, sin tilde, y el
            # rubro del producto la tiene: comparados tal cual no pegaban nunca.
            # Y el pack sigue la misma rebaja, o llevarse el rollo entero sale
            # mas caro por unidad que comprar suelto y el cliente lo nota.
            {'doc_id': 'p1', 'doc': {'rubro': 'LIBRERÍA', 'sub_rubro': 'Cuadernos',
                                     'precio': 6500, 'precio_pack': 60000}},
            {'doc_id': 'p2', 'doc': {'rubro': 'MERCERIA', 'sub_rubro': 'Cintas',
                                     'precio': 6500, 'precio_pack': 60000}},
        ],
    },
    {
        'que_prueba': 'el subrubro pega aunque el catalogo lo escriba con tilde',
        'ahora': '2026-09-08T12:00:00+00:00',
        'descuentos': [
            {'id': 'd1', 'datos': {'nombre': 'Boligrafos', 'tipo': 'porcentaje', 'valor': 15,
                                   'alcance': 'subrubro', 'objetivo': 'LIBRERÍA|BOLIGRAFO'}},
        ],
        'productos': [
            {'doc_id': 'p1', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Bolígrafo',
                                     'precio': 1200}},
            {'doc_id': 'p2', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos',
                                     'precio': 1200}},
        ],
    },
    {
        'que_prueba': 'manda el mas puntual: rubro < subrubro < producto',
        'ahora': '2026-09-08T12:00:00+00:00',
        # Desordenados a proposito: la coleccion se lee en cualquier orden y las
        # dos implementaciones tienen que elegir el mismo igual.
        'descuentos': [
            {'id': 'z-producto', 'datos': {'nombre': 'Craft', 'tipo': 'porcentaje', 'valor': 30,
                                           'alcance': 'producto', 'objetivo': 'CRAFT1'}},
            {'id': 'a-rubro', 'datos': {'nombre': 'Libreria', 'tipo': 'porcentaje', 'valor': 10,
                                        'alcance': 'rubro', 'objetivo': 'LIBRERIA'}},
            {'id': 'm-subrubro', 'datos': {'nombre': 'Cuadernos', 'tipo': 'porcentaje',
                                           'valor': 20, 'alcance': 'subrubro',
                                           'objetivo': 'LIBRERIA|CUADERNOS'}},
        ],
        'productos': [
            {'doc_id': 'p1', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Lapices',
                                     'precio': 1000}},
            {'doc_id': 'p2', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos',
                                     'precio': 1000}},
            # Hay codigos con minusculas (Craft1, Eco1) y el panel guarda el
            # objetivo en mayusculas: comparados tal cual, el descuento del
            # articulo no encontraba a su articulo.
            {'doc_id': 'Craft1', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos',
                                         'precio': 1000}},
        ],
    },
    {
        'que_prueba': 'un monto fijo, y el que sale menos que el monto no se rebaja',
        'ahora': '2026-09-08T12:00:00+00:00',
        'descuentos': [
            {'id': 'd1', 'datos': {'nombre': '$500 menos', 'tipo': 'monto', 'valor': 500,
                                   'alcance': 'rubro', 'objetivo': 'LIBRERIA'}},
        ],
        'productos': [
            {'doc_id': 'p1', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos',
                                     'precio': 2000}},
            # Antes estos quedaban a $1: un precio en un peso se lee como error,
            # no como rebaja, y deja pasar pedidos que no se pueden cobrar.
            {'doc_id': 'p2', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Gomas',
                                     'precio': 400}},
            {'doc_id': 'p3', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Gomas',
                                     'precio': 500}},
        ],
    },
    {
        'que_prueba': 'redondear a la centena, salvo cuando empujaria el precio para arriba',
        'ahora': '2026-09-08T12:00:00+00:00',
        'descuentos': [
            {'id': 'd1', 'datos': {'nombre': 'Redondo', 'tipo': 'porcentaje', 'valor': 12,
                                   'alcance': 'rubro', 'objetivo': 'LIBRERIA',
                                   'redondear': True}},
        ],
        'productos': [
            {'doc_id': 'p1', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos',
                                     'precio': 6900}},
            # En un producto barato la centena anulaba el descuento entero: 79
            # redondeado a 100 quedaba ARRIBA del precio de lista.
            {'doc_id': 'p2', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Gomas',
                                     'precio': 90}},
            {'doc_id': 'p3', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Gomas',
                                     'precio': 40}},
        ],
    },
    {
        'que_prueba': 'el medio peso: 12,5% redondeado igual en los dos lenguajes',
        'ahora': '2026-09-08T12:00:00+00:00',
        # round() de Python redondea al par (878,5 -> 878) y Math.round() de
        # JavaScript siempre para arriba (878,5 -> 879). Los dos usan
        # floor(x + 0.5), que es la unica forma que escriben igual.
        'descuentos': [
            {'id': 'd1', 'datos': {'nombre': 'Doce y medio', 'tipo': 'porcentaje',
                                   'valor': 12.5, 'alcance': 'rubro', 'objetivo': 'LIBRERIA'}},
        ],
        'productos': [
            {'doc_id': 'p1', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos',
                                     'precio': 1004}},
        ],
    },
    {
        'que_prueba': 'mas del 90% no es un descuento, es un error de tipeo',
        'ahora': '2026-09-08T12:00:00+00:00',
        'descuentos': [
            {'id': 'd1', 'datos': {'nombre': 'Liquidacion', 'tipo': 'porcentaje', 'valor': 95,
                                   'alcance': 'rubro', 'objetivo': 'LIBRERIA'}},
        ],
        'productos': [
            {'doc_id': 'p1', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos',
                                     'precio': 1000}},
        ],
    },
    {
        'que_prueba': 'apagado, vencido, futuro o en cero no rigen, y lo rebajado vuelve a lista',
        'ahora': '2026-09-08T12:00:00+00:00',
        'descuentos': [
            {'id': 'apagado', 'datos': {'nombre': 'Apagado', 'valor': 50, 'activo': False,
                                        'alcance': 'rubro', 'objetivo': 'LIBRERIA'}},
            {'id': 'vencido', 'datos': {'nombre': 'Vencido', 'valor': 50, 'alcance': 'rubro',
                                        'objetivo': 'LIBRERIA',
                                        'hasta': '2026-09-01T00:00:00+00:00'}},
            {'id': 'futuro', 'datos': {'nombre': 'Futuro', 'valor': 50, 'alcance': 'rubro',
                                       'objetivo': 'LIBRERIA',
                                       'desde': '2026-12-01T00:00:00+00:00'}},
            {'id': 'sin valor', 'datos': {'nombre': 'Sin valor', 'valor': 0, 'alcance': 'rubro',
                                          'objetivo': 'LIBRERIA'}},
            {'id': 'vigente', 'datos': {'nombre': 'Merceria', 'valor': 10, 'alcance': 'rubro',
                                        'objetivo': 'MERCERIA',
                                        'desde': '2026-09-01T00:00:00+00:00',
                                        'hasta': '2026-09-30T00:00:00+00:00'}},
        ],
        'productos': [
            # Ya estaba rebajado por un descuento que se apago: tiene que
            # volver al precio de lista, no quedarse rebajado para siempre.
            {'doc_id': 'p1', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos',
                                     'precio': 800, 'precio_anterior': 1000,
                                     'precio_pack': 8000, 'precio_pack_anterior': 10000,
                                     'descuento': {'id': 'apagado', 'nombre': 'Apagado',
                                                   'porcentaje': 20}}},
            {'doc_id': 'p2', 'doc': {'rubro': 'MERCERIA', 'sub_rubro': 'Cintas',
                                     'precio': 1000}},
        ],
    },
    {
        'que_prueba': 'dos del mismo alcance sobre el mismo rubro: decide el id',
        'ahora': '2026-09-08T12:00:00+00:00',
        'descuentos': [
            {'id': 'zz', 'datos': {'nombre': 'El ultimo', 'valor': 30, 'alcance': 'rubro',
                                   'objetivo': 'LIBRERIA'}},
            {'id': 'aa', 'datos': {'nombre': 'El primero', 'valor': 10, 'alcance': 'rubro',
                                   'objetivo': 'LIBRERIA'}},
        ],
        'productos': [
            {'doc_id': 'p1', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos',
                                     'precio': 1000}},
        ],
    },
    {
        'que_prueba': 'el precio propio de cada color se rebaja igual que el del producto',
        'ahora': '2026-09-08T12:00:00+00:00',
        # La tienda le cobra al cliente el precio de la variedad cuando lo tiene
        # (precioDeRenglon en tienda/src/precios.js, y lo mismo el servidor al
        # armar el pedido). Dejandolo a precio de lista, la card anunciaba -20%
        # y al elegir el color el precio SUBIA al entero, que era ademas el que
        # se cobraba.
        'descuentos': [
            {'id': 'd1', 'datos': {'nombre': 'Semana del papel', 'tipo': 'porcentaje',
                                   'valor': 20, 'alcance': 'rubro', 'objetivo': 'LIBRERIA'}},
        ],
        'productos': [
            {'doc_id': 'p1', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Papeles',
                                     'precio': 600, 'precio_pack': 5600,
                                     'variedades': [
                                         # Con precio propio: se reescala igual.
                                         {'nombre': 'Celeste', 'stock': 12, 'precio': 1874,
                                          'imagen': None},
                                         # Sin precio propio: paga el del producto y
                                         # no hay nada que tocar.
                                         {'nombre': 'Rosa Viejo', 'stock': 5, 'precio': None,
                                          'imagen': None},
                                     ]}},
            # Rubro sin descuento y ya rebajado de antes: los colores vuelven a
            # su precio de lista, no se quedan rebajados para siempre.
            {'doc_id': 'p2', 'doc': {'rubro': 'MERCERIA', 'sub_rubro': 'Cintas',
                                     'precio': 800, 'precio_anterior': 1000,
                                     'descuento': {'id': 'viejo', 'nombre': 'Vieja oferta',
                                                   'porcentaje': 20},
                                     'variedades': [
                                         {'nombre': 'Rojo', 'stock': 3, 'precio': 1600,
                                          'precio_anterior': 2000, 'imagen': None},
                                     ]}},
        ],
    },
    {
        'que_prueba': 'sin precio no hay nada que rebajar',
        'ahora': '2026-09-08T12:00:00+00:00',
        'descuentos': [
            {'id': 'd1', 'datos': {'nombre': 'Libreria', 'valor': 20, 'alcance': 'rubro',
                                   'objetivo': 'LIBRERIA'}},
        ],
        'productos': [
            {'doc_id': 'p1', 'doc': {'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos',
                                     'precio': 0}},
        ],
    },
]


def descuentos():
    """Corre `descuentos_vigentes()` y `aplicar_descuento()` sobre los casos.

    De cada producto van los dos pasos: el documento recien rebajado y el
    mismo documento pasado por la regla otra vez. El sync corre siempre sobre
    lo que dejo escrito el panel, asi que aplicarlo dos veces tiene que dar lo
    mismo; si se recalculara sobre el precio ya rebajado, cada corrida
    descontaria de nuevo sobre lo descontado.
    """
    salida = []
    for caso in CASOS_DESCUENTOS:
        ahora = datetime.fromisoformat(caso['ahora'])
        vigentes = descuentos_vigentes(
            [(d['id'], d['datos']) for d in caso['descuentos']], ahora)
        resultado = []
        for p in caso['productos']:
            documento = aplicar_descuento(p['doc_id'], dict(p['doc']), vigentes)
            otra_vez = aplicar_descuento(p['doc_id'], dict(documento), vigentes)
            resultado.append({'doc_id': p['doc_id'], 'documento': documento,
                              'otra_vez': otra_vez})
        salida.append({
            'que_prueba': caso['que_prueba'], 'ahora': caso['ahora'],
            'descuentos': caso['descuentos'], 'productos': caso['productos'],
            'vigentes': [d['id'] for d in vigentes], 'resultado': resultado,
        })
    return salida


def main():
    # En Windows la consola sale en cp1252 y "Cordón" viaja roto. Lo lee otro
    # programa, no una persona: tiene que ser UTF-8 siempre.
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

    with open(CASOS, encoding='utf-8') as f:
        casos = json.load(f)

    salida = []
    for caso in casos:
        doc = armar_documento(caso['doc_id'], caso['datos'])
        doc.pop('actualizado', None)
        salida.append({'doc_id': caso['doc_id'], 'documento': doc})

    print(json.dumps({'documentos': salida, 'publicacion': publicacion(),
                      'conteo': conteo(), 'descuentos': descuentos()},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
