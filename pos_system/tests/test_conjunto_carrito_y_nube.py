"""
Ventas de conjuntos: del carrito a la base y de la base a la nube (29-10-2026).

    QT_QPA_PLATFORM=offscreen python -m pytest pos_system/tests/test_conjunto_carrito_y_nube.py -q

Lo que se rompía, medido con datos reales:

  1. Cambiar la cantidad de un conjunto en el carrito inflaba el stock: el
     ajuste tomaba la cantidad vendida como si fuera el contenido del pack.
     ELÁSTICO ALGODÓN 9,5 → 200,92; LÁPIZ MAPED 69 → 4.752; CINTA CORRECTORA
     llegó a 119.999.976. La venta escribía ese número tal cual.
  2. Nada impedía que una venta subiera stock.
  3. La venta subía a la nube el número absoluto de la PC y pisaba lo que la
     PC no había visto; el `stock` plano de la nube no se tocaba.
  4. Al bajar de la nube, `int(stock)` perdía los decimales (metros).
  5. Un conjunto vendido sin stock quedaba en 0 sin rastro de lo que faltó.
  6. La venta #348 (presupuesto convertido) cobró conjuntos sin variedad ni
     presentación y no descontó nada.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.sale import Sale
from pos_system.models.venta_conjunto import (
    aplicar_en_doc, descontar, pedido_de_linea, simular_carrito, stock_plano,
)
from pos_system.utils import conjuntos_pendientes
from pos_system.utils.firebase_sync import stock_de_la_nube


# ── Base de prueba ─────────────────────────────────────────────────────────

@pytest.fixture
def db(tmp_path):
    base = DatabaseManager(str(tmp_path / 'pos.db'))
    base.initialize_database()
    return base


def alta(db, *, nombre, contenido, unidades=0.0, restante=0.0, colores=None,
         fid='FID1', unidad='u'):
    if colores:
        total = sum(float(c.get('unidades') or 0) * float(c.get('contenido') or contenido)
                    + float(c.get('restante') or 0) for c in colores)
        unidades = sum(float(c.get('unidades') or 0) for c in colores)
        restante = sum(float(c.get('restante') or 0) for c in colores)
    else:
        total = unidades * contenido + restante
    with db.get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO products
               (name, price, stock, firebase_id, es_conjunto, conjunto_contenido,
                conjunto_unidades, conjunto_restante, conjunto_total,
                conjunto_colores, conjunto_unidad_medida)
               VALUES (?, 1000, ?, ?, 1, ?, ?, ?, ?, ?, ?)""",
            (nombre, int(total), fid, contenido, unidades, restante, total,
             json.dumps(colores) if colores else None, unidad))
        return cur.lastrowid


def leer(db, pid):
    return db.execute_query("SELECT * FROM products WHERE id = ?", (pid,))[0]


def linea(pid, *, cantidad, vender_por='unidad', color='', unidad_base='u',
          unidad_venta=None, **extra):
    it = {
        'product_id': pid, 'product_name': 'X', 'quantity': cantidad,
        'unit_price': 100, 'subtotal': 100 * cantidad,
        'is_conjunto': True, 'conjunto_cantidad': cantidad,
        'conjunto_vender_por': vender_por, 'conjunto_unidad_base': unidad_base,
        'conjunto_unidad_venta': unidad_venta or unidad_base,
        'conjunto_color': color,
    }
    it.update(extra)
    return it


def vender(db, items):
    total = sum(float(i.get('subtotal') or 100) for i in items) or 100
    return Sale(db).create({'items': items, 'payment_type': 'cash',
                            'total_amount': total, 'cash_received': total})


def movimientos(db, pid):
    return db.execute_query(
        "SELECT * FROM stock_movimientos WHERE producto_id = ? ORDER BY id", (pid,))


def cola(db):
    return db.execute_query("SELECT * FROM conj_pendientes ORDER BY id")


# ── La cuenta pura ─────────────────────────────────────────────────────────

@pytest.mark.parametrize('u,r,c,cant,modo', [
    (0, 69, 72, 3, 'unidad'),
    (2, 3, 50, 4, 'unidad'),
    (2, 3, 50, 53, 'unidad'),
    (5, 0, 10, 2, 'conjunto'),
    (1, 0.5, 25, 7.25, 'fraccion'),
    (3, 12, 12, 30, 'unidad'),
])
def test_descontar_da_lo_mismo_que_el_dialogo_cuando_alcanza(u, r, c, cant, modo):
    from pos_system.ui.conjunto_dialog import aplicar_venta
    ok, _err, au, ar = aplicar_venta(u, c, r, cant, modo, 'u', 'u')
    assert ok
    packs, sueltos = pedido_de_linea(
        {'conjunto_cantidad': cant, 'conjunto_vender_por': modo,
         'conjunto_unidad_base': 'u', 'conjunto_unidad_venta': 'u'}, c)
    nu, nr, falta = descontar(u, r, c, packs, sueltos)
    assert (nu, falta) == (au, 0.0)
    assert nr == pytest.approx(ar)


def test_sin_stock_queda_en_cero_y_devuelve_lo_que_falto():
    assert descontar(0, 3, 10, 0, 5) == (0.0, 0.0, 2.0)
    # Un pack pedido que ya no está cerrado sale de lo suelto.
    u, r, falta = descontar(0, 30, 25, 1, 0)
    assert (u, r, falta) == (0.0, 5.0, 0.0)


def test_centimetros_se_pasan_a_metros():
    assert pedido_de_linea({'conjunto_cantidad': 50, 'conjunto_vender_por': 'fraccion',
                            'conjunto_unidad_base': 'm', 'conjunto_unidad_venta': 'cm'},
                           25) == (0.0, 0.5)


def test_stock_plano_es_el_total_entero():
    assert stock_plano(8.92) == 8
    assert stock_plano(-3) == 0
    assert stock_plano(None) == 0


# ── Bug 1: cambiar la cantidad en el carrito ──────────────────────────────

class CarritoDePrueba:
    """Lo mínimo de SalesView para cambiar cantidades sin abrir la ventana."""

    def __init__(self, db, cart):
        from pos_system.ui.sales_view import SalesView
        self.db = db
        self.cart = cart
        for nombre in ('update_quantity', '_recalcular_conjuntos_del_carrito',
                       '_leer_conjunto', '_rebuild_conjunto_name',
                       '_lineas_de_conjunto_incompletas',
                       '_conjuntos_listos_para_cobrar'):
            setattr(self, nombre, getattr(SalesView, nombre).__get__(self))

    def _reprice_conjunto_line(self, item, product=None):
        pass

    def _refresh_cart_row_pricing(self, row, item):
        pass

    def _refresh_cart_totals(self, row=None):
        pass


def test_bajar_la_cantidad_no_infla_el_lapiz_maped(db):
    # LÁPIZ MAPED: caja de 72, 69 sueltos. Se cargan 3 y se baja a 1.
    pid = alta(db, nombre='LAPIZ MAPED', contenido=72, unidades=0, restante=69)
    it = linea(pid, cantidad=3, conjunto_after_unidades=0, conjunto_after_restante=66,
               conjunto_cantidad_base=3)
    carrito = CarritoDePrueba(db, [it])
    carrito.update_quantity(0, 1)
    assert (it['conjunto_after_unidades'], it['conjunto_after_restante']) == (0, 68)
    carrito.update_quantity(0, 2)
    assert it['conjunto_after_restante'] == 67

    vender(db, [it])
    p = leer(db, pid)
    assert p['conjunto_total'] == 67
    assert p['stock'] == 67


def test_elastico_por_metro_con_cantidad_decimal(db):
    # ELÁSTICO ALGODÓN: rollo de 25 m, quedan 9,5 m. Se vende 0,58 m (entra al
    # carrito como "1 × 0,58 m") y el cajero pone 2 en el spinner: 1,16 m.
    pid = alta(db, nombre='ELASTICO ALGODON', contenido=25, unidades=0,
               restante=9.5, unidad='m')
    it = linea(pid, cantidad=0.58, vender_por='fraccion', unidad_base='m',
               conjunto_after_unidades=0, conjunto_after_restante=8.92,
               conjunto_cantidad_base=0.58)
    it['quantity'] = 1
    carrito = CarritoDePrueba(db, [it])
    carrito.update_quantity(0, 2)
    assert it['conjunto_cantidad'] == pytest.approx(1.16)
    assert it['conjunto_after_restante'] == pytest.approx(8.34)
    carrito.update_quantity(0, 1)
    assert it['conjunto_after_restante'] == pytest.approx(8.92)

    vender(db, [it])
    assert leer(db, pid)['conjunto_total'] == pytest.approx(8.92)


def test_dos_lineas_del_mismo_color_se_encadenan(db):
    colores = [{'color': 'Plata', 'unidades': 2, 'restante': 10},
               {'color': 'Oro', 'unidades': 1, 'restante': 0}]
    pid = alta(db, nombre='ARGOLLA LLAVERO', contenido=100, colores=colores)
    a = linea(pid, cantidad=1, vender_por='conjunto', color='Plata')
    b = linea(pid, cantidad=15, color='Plata')
    carrito = CarritoDePrueba(db, [a, b])
    assert carrito._recalcular_conjuntos_del_carrito() == []
    assert (a['conjunto_after_unidades'], a['conjunto_after_restante']) == (1, 10)
    assert (b['conjunto_after_unidades'], b['conjunto_after_restante']) == (0, 95)

    vender(db, [a, b])
    p = leer(db, pid)
    plata = next(c for c in json.loads(p['conjunto_colores']) if c['color'] == 'Plata')
    assert (plata['unidades'], plata['restante']) == (0, 95)
    assert p['conjunto_total'] == 195     # 95 Plata + 100 Oro


def test_variedad_con_su_propio_pack(db):
    colores = [{'color': 'Azul', 'unidades': 2, 'restante': 0, 'contenido': 12},
               {'color': 'Negro', 'unidades': 1, 'restante': 0}]
    pid = alta(db, nombre='BOLIGRAFO', contenido=50, colores=colores)
    it = linea(pid, cantidad=5, color='Azul')
    vender(db, [it])
    azul = next(c for c in json.loads(leer(db, pid)['conjunto_colores'])
                if c['color'] == 'Azul')
    assert (azul['unidades'], azul['restante']) == (1, 7)


# ── Bug 2: una venta nunca suma stock ─────────────────────────────────────

def test_la_base_manda_aunque_el_carrito_traiga_un_numero_inflado(db):
    pid = alta(db, nombre='LAPIZ MAPED', contenido=72, unidades=0, restante=69)
    it = linea(pid, cantidad=3, conjunto_after_unidades=66, conjunto_after_restante=0)
    vender(db, [it])
    assert leer(db, pid)['conjunto_total'] == 66


def test_linea_vieja_que_subiria_el_stock_se_rechaza(db):
    pid = alta(db, nombre='CINTA CORRECTORA', contenido=12, unidades=2, restante=0)
    vieja = {'product_id': pid, 'product_name': 'CINTA CORRECTORA', 'quantity': 1,
             'unit_price': 100, 'is_conjunto': True,
             'conjunto_after_unidades': 9999999, 'conjunto_after_restante': 0}
    vender(db, [vieja])
    p = leer(db, pid)
    assert p['conjunto_total'] == 24
    mov = movimientos(db, pid)
    assert mov and 'Rechazada' in mov[-1]['detalle']


def test_el_cajero_ve_el_faltante_antes_de_cobrar(db, monkeypatch):
    import pos_system.ui.sales_view as sv
    pid = alta(db, nombre='LAPIZ', contenido=10, unidades=0, restante=3)
    vistos = []

    class Caja:
        Yes, No = 1, 0

        @staticmethod
        def question(parent, titulo, texto, *a):
            vistos.append((titulo, texto))
            return Caja.No

        @staticmethod
        def warning(parent, titulo, texto, *a):
            vistos.append((titulo, texto))

    monkeypatch.setattr(sv, 'QMessageBox', Caja)
    carrito = CarritoDePrueba(db, [linea(pid, cantidad=5)])
    assert carrito._conjuntos_listos_para_cobrar() is False
    assert vistos[0][0] == 'Stock insuficiente'
    assert 'faltan 2' in vistos[0][1]


# ── Bug 5: faltante ───────────────────────────────────────────────────────

def test_vender_sin_stock_deja_cero_y_anota_lo_que_falto(db):
    pid = alta(db, nombre='LAPIZ', contenido=10, unidades=0, restante=3)
    it = linea(pid, cantidad=5)
    vender(db, [it])
    p = leer(db, pid)
    assert p['conjunto_total'] == 0
    assert it['conjunto_faltante_base'] == 2
    mov = movimientos(db, pid)[-1]
    assert mov['cantidad'] == -3
    assert 'faltaron 2' in mov['detalle'].lower()


def test_sin_nada_de_stock_el_faltante_igual_queda_en_el_historial(db):
    pid = alta(db, nombre='LAPIZ', contenido=10, unidades=0, restante=0)
    vender(db, [linea(pid, cantidad=4)])
    mov = movimientos(db, pid)
    assert mov and mov[-1]['cantidad'] == 0
    assert 'faltaron 4' in mov[-1]['detalle'].lower()


# ── Bug 6: conjuntos sin variedad o sin presentación ─────────────────────

def test_linea_sin_variedad_no_descuenta_ni_rompe_los_agregados(db):
    colores = [{'color': 'Negro', 'unidades': 3, 'restante': 0}]
    pid = alta(db, nombre='MARCADOR TRABI', contenido=12, colores=colores)
    vender(db, [linea(pid, cantidad=2, vender_por='conjunto')])
    p = leer(db, pid)
    assert p['conjunto_total'] == 36 and p['conjunto_unidades'] == 3
    assert 'sin elegir variedad' in movimientos(db, pid)[-1]['detalle']


def test_presupuesto_convertido_no_toca_el_stock_plano_de_un_conjunto(db):
    colores = [{'color': 'Negro', 'unidades': 3, 'restante': 0}]
    pid = alta(db, nombre='MARCADOR TRABI', contenido=12, colores=colores)
    plana = {'product_id': pid, 'product_name': '[Negro]  MARCADOR  ·  2 caja(s)',
             'quantity': 2, 'unit_price': 12900, 'subtotal': 25800}
    vender(db, [plana])
    p = leer(db, pid)
    assert p['stock'] == 36 and p['conjunto_total'] == 36
    assert 'Sin descontar' in movimientos(db, pid)[-1]['detalle']


def test_el_carrito_no_deja_cobrar_conjuntos_sin_presentacion(db, monkeypatch):
    import pos_system.ui.sales_view as sv
    colores = [{'color': 'Negro', 'unidades': 3, 'restante': 0}]
    pid = alta(db, nombre='MARCADOR TRABI', contenido=12, colores=colores)
    avisos = []

    class Caja:
        Yes, No = 1, 0

        @staticmethod
        def warning(parent, titulo, texto, *a):
            avisos.append(texto)

        @staticmethod
        def question(*a):
            raise AssertionError('no debía preguntar')

    monkeypatch.setattr(sv, 'QMessageBox', Caja)
    plana = {'product_id': pid, 'product_name': 'MARCADOR', 'quantity': 2,
             'unit_price': 1, 'subtotal': 2}
    assert CarritoDePrueba(db, [plana])._conjuntos_listos_para_cobrar() is False
    sin_color = linea(pid, cantidad=1, vender_por='conjunto')
    assert CarritoDePrueba(db, [sin_color])._conjuntos_listos_para_cobrar() is False
    assert len(avisos) == 2 and 'MARCADOR' in avisos[0]


# ── Bug 3: la cola de la nube ─────────────────────────────────────────────

def test_la_venta_anota_lo_que_se_llevo_no_el_numero_de_la_pc(db):
    colores = [{'color': 'Rojo', 'unidades': 2, 'restante': 4}]
    pid = alta(db, nombre='CARTULINA', contenido=10, colores=colores, fid='CART')
    sale_id = vender(db, [linea(pid, cantidad=1, vender_por='conjunto', color='Rojo'),
                          linea(pid, cantidad=6, color='Rojo')])
    filas = cola(db)
    assert [(f['packs'], f['sueltos'], f['item_idx']) for f in filas] == [(1, 0, 0), (0, 6, 1)]
    assert all(f['sale_id'] == sale_id and f['product_fid'] == 'CART'
               and f['color'] == 'Rojo' and f['fb_synced'] == 0 for f in filas)
    assert len({f['clave'] for f in filas}) == 2


def test_devolver_un_fiado_anota_la_devolucion(db):
    pid = alta(db, nombre='CINTA', contenido=25, unidades=1, restante=5, unidad='m')
    it = linea(pid, cantidad=3, vender_por='fraccion', unidad_base='m')
    sale = Sale(db)
    sale.descontar_stock_items([it])
    assert leer(db, pid)['conjunto_total'] == 27
    sale.reponer_stock_items([it])
    assert leer(db, pid)['conjunto_total'] == 30
    assert cola(db)[-1]['devolucion'] == 3


DOC = {
    'nombre': 'CARTULINA', 'es_conjunto': True, 'conjunto_contenido': 10,
    'stock': 999,
    'conjunto_colores': [
        {'color': 'Rojo', 'unidades': 2, 'restante': 4, 'stock_min': 5,
         'imagen': 'rojo.jpg'},
        {'color': 'Azul', 'unidades': 1, 'restante': 0, 'stock_min': 2},
    ],
    'conjunto_total': 34,
}


def test_la_nube_aplica_la_diferencia_sobre_su_propio_numero():
    # La nube tiene 2 packs + 4 Rojo aunque la PC creyera otra cosa: se
    # descuentan 6 sueltos de ESE número y lo del panel queda intacto.
    r = aplicar_en_doc(json.loads(json.dumps(DOC)), 'Rojo', 0, 6)
    c = r['campos']
    rojo, azul = c['conjunto_colores']
    assert (rojo['unidades'], rojo['restante']) == (1, 8)
    assert rojo['stock_min'] == 5 and rojo['imagen'] == 'rojo.jpg'
    assert azul == DOC['conjunto_colores'][1]
    assert c['conjunto_total'] == 28 and c['stock'] == 28
    assert (c['conjunto_unidades'], c['conjunto_restante']) == (2, 8)
    assert r['faltante'] == 0


def test_la_nube_sin_stock_queda_en_cero_con_faltante():
    r = aplicar_en_doc(json.loads(json.dumps(DOC)), 'Azul', 0, 15)
    assert r['faltante'] == 5
    assert r['campos']['conjunto_total'] == 24


def test_la_nube_no_inventa_variedad():
    assert 'saltado' in aplicar_en_doc(DOC, '', 1, 0)
    assert 'saltado' in aplicar_en_doc(DOC, 'Verde', 1, 0)


def test_la_nube_sin_variedades_usa_el_total():
    doc = {'es_conjunto': True, 'conjunto_contenido': 25, 'conjunto_unidades': 9,
           'conjunto_restante': 0, 'conjunto_total': 9.5}
    r = aplicar_en_doc(doc, '', 0, 0.58)
    assert r['campos']['conjunto_total'] == pytest.approx(8.92)
    assert r['campos']['stock'] == 8


def test_devolucion_en_la_nube():
    r = aplicar_en_doc(json.loads(json.dumps(DOC)), 'Rojo', 0, 0, devolucion=7)
    rojo = r['campos']['conjunto_colores'][0]
    assert rojo['unidades'] * 10 + rojo['restante'] == 31


class _Snap:
    def __init__(self, data):
        self._data = data
        self.exists = data is not None

    def to_dict(self):
        return json.loads(json.dumps(self._data)) if self._data is not None else None


class _Doc:
    def __init__(self, nube, col, did):
        self.nube, self.key = nube, (col, did)

    def get(self, transaction=None):
        return _Snap(self.nube.docs.get(self.key))

    def set(self, data, merge=False):
        actual = dict(self.nube.docs.get(self.key) or {}) if merge else {}
        actual.update(data)
        self.nube.docs[self.key] = actual


class _Col:
    def __init__(self, nube, nombre):
        self.nube, self.nombre = nube, nombre

    def document(self, did):
        return _Doc(self.nube, self.nombre, did)


class _Tx:
    def __init__(self, nube):
        self.nube = nube

    def set(self, ref, data, merge=False):
        if self.nube.cortar:
            raise ConnectionError('sin internet')
        ref.set(data, merge=merge)


class NubeDePrueba:
    def __init__(self, docs):
        self.docs = dict(docs)
        self.cortar = False

    def collection(self, nombre):
        return _Col(self, nombre)

    def transaction(self):
        return _Tx(self)


@pytest.fixture
def sync(monkeypatch):
    import firebase_admin.firestore as fa
    from pos_system.utils import firebase_sync as fs
    monkeypatch.setattr(fa, 'transactional', lambda fn: (lambda tx: fn(tx)))
    monkeypatch.setattr(fs, '_get_pc_id', lambda: 'PC1')
    fb = fs.FirebaseSync.__new__(fs.FirebaseSync)
    fb.enabled = True
    fb._run = lambda fn: fn()
    fb.avisos = []
    fb._avisar_a_la_tienda = lambda cambios: fb.avisos.extend(cambios)
    return fb


def test_subida_por_diferencia_e_idempotente(db, sync):
    colores = [{'color': 'Rojo', 'unidades': 2, 'restante': 4},
               {'color': 'Azul', 'unidades': 1, 'restante': 0}]
    pid = alta(db, nombre='CARTULINA', contenido=10, colores=colores, fid='CART')
    # Mientras tanto otra caja vendió un pack de Rojo y el panel cargó un Azul:
    nube_doc = json.loads(json.dumps(DOC))
    nube_doc['conjunto_colores'][0]['unidades'] = 1
    nube_doc['conjunto_colores'][1]['unidades'] = 2
    sync.db = NubeDePrueba({('catalogo', 'CART'): nube_doc})

    vender(db, [linea(pid, cantidad=6, color='Rojo')])
    sync.push_conjuntos_pendientes(db, en_hilo=False)

    doc = sync.db.docs[('catalogo', 'CART')]
    rojo, azul = doc['conjunto_colores']
    assert (rojo['unidades'], rojo['restante']) == (0, 8)   # 14 - 6 de la nube
    assert azul['unidades'] == 2                             # la carga del panel sigue
    assert doc['conjunto_total'] == 28 and doc['stock'] == 28
    assert rojo['stock_min'] == 5 and rojo['imagen'] == 'rojo.jpg'
    assert cola(db)[0]['fb_synced'] == 1
    marcas = [k for k in sync.db.docs if k[0] == 'conjuntos_aplicados']
    assert len(marcas) == 1
    assert sync.avisos and sync.avisos[0][0] == 'CART'

    # Se corta la luz entre el commit de la nube y la marca local: la fila
    # vuelve a pendiente y el reintento NO descuenta otra vez.
    db.execute_update("UPDATE conj_pendientes SET fb_synced = 0")
    sync.push_conjuntos_pendientes(db, en_hilo=False)
    assert sync.db.docs[('catalogo', 'CART')]['conjunto_total'] == 28
    assert cola(db)[0]['fb_synced'] == 1


def test_sin_internet_queda_en_cola_y_sube_despues(db, sync):
    pid = alta(db, nombre='LAPIZ', contenido=72, unidades=0, restante=69, fid='LAP')
    sync.db = NubeDePrueba({('catalogo', 'LAP'): {
        'es_conjunto': True, 'conjunto_contenido': 72, 'conjunto_unidades': 0,
        'conjunto_restante': 69, 'conjunto_total': 69, 'stock': 69}})
    sync.db.cortar = True
    vender(db, [linea(pid, cantidad=3)])
    sync.push_conjuntos_pendientes(db, en_hilo=False)
    assert cola(db)[0]['fb_synced'] == 0 and cola(db)[0]['intentos'] == 1
    assert sync.db.docs[('catalogo', 'LAP')]['conjunto_total'] == 69

    sync.db.cortar = False
    sync.push_conjuntos_pendientes(db, en_hilo=False)
    doc = sync.db.docs[('catalogo', 'LAP')]
    assert doc['conjunto_total'] == 66 and doc['stock'] == 66
    assert cola(db)[0]['fb_synced'] == 1


def test_el_sync_post_venta_ya_no_sube_numeros_absolutos(db, sync):
    pid = alta(db, nombre='LAPIZ', contenido=72, unidades=0, restante=69, fid='LAP')
    sync.db = NubeDePrueba({('catalogo', 'LAP'): {
        'es_conjunto': True, 'conjunto_contenido': 72, 'conjunto_unidades': 1,
        'conjunto_restante': 0, 'conjunto_total': 72, 'stock': 72}})
    escritos = []

    class Lote:
        def set(self, ref, data, merge=False):
            escritos.append((ref.key, data))

        def commit(self):
            pass

    sync.db.batch = lambda: Lote()
    sync.push_stock_movimientos = lambda *a, **k: None
    it = linea(pid, cantidad=3)
    vender(db, [it])
    sync.sync_stock_after_sale([it], db)
    assert not [k for k, _ in escritos if k[0] in ('catalogo', 'inventario')]
    # La cola aplicó la diferencia sobre el número de la nube (72), no el 66 local.
    assert sync.db.docs[('catalogo', 'LAP')]['conjunto_total'] == 69


# ── Bug 4: decimales al bajar de la nube ──────────────────────────────────

@pytest.mark.parametrize('valor,esperado', [
    (2.7, 2.7), (5, 5), (5.0, 5), ('3', 3), (None, 0), ('', 0), ('abc', 0),
    (-1, -1), (float('nan'), 0),
])
def test_stock_de_la_nube_conserva_decimales(valor, esperado):
    r = stock_de_la_nube(valor)
    assert r == esperado
    if isinstance(esperado, int):
        assert isinstance(r, int)


# ── El cálculo del carrito y el de la venta son el mismo ─────────────────

def test_simular_carrito_y_venta_coinciden(db):
    colores = [{'color': 'A', 'unidades': 3, 'restante': 7},
               {'color': 'B', 'unidades': 0, 'restante': 2}]
    pid = alta(db, nombre='MIX', contenido=20, colores=colores)
    items = [linea(pid, cantidad=1, vender_por='conjunto', color='A'),
             linea(pid, cantidad=10, color='A'),
             linea(pid, cantidad=1, color='B')]
    simular_carrito(items, lambda p: leer(db, p))
    previsto = [(i['conjunto_after_unidades'], i['conjunto_after_restante']) for i in items]
    vender(db, [dict(i) for i in items])
    cols = {c['color']: c for c in json.loads(leer(db, pid)['conjunto_colores'])}
    assert (cols['A']['unidades'], cols['A']['restante']) == previsto[1]
    assert (cols['B']['unidades'], cols['B']['restante']) == previsto[2]
    assert conjuntos_pendientes.pendientes(db)
