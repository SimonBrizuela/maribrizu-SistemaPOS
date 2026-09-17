"""
El cobro de un pedido de la tienda del lado de la PC: la venta local, lo que
sube a la nube, la pantalla de cobro precargada y el número de ARCA.

  · la venta entra a la caja del día con el medio de pago que se eligió,
  · el stock NO se toca (salió al entregar),
  · un pedido no puede tener dos ventas en la misma PC, ni apretando dos veces,
  · cada renglón sube con el producto y las unidades del pedido, para que
    borrar la venta desde el panel sepa qué era,
  · si otra caja le ganó el número a ARCA, se reintenta en vez de ofrecer una
    factura sin CAE.
"""
import json
import os
import sys
from datetime import datetime

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

from pos_system.database.db_manager import DatabaseManager  # noqa: E402
from pos_system.models import pedido_tienda as pt  # noqa: E402
from pos_system.models.cash_register import CashRegister  # noqa: E402
from pos_system.models.product import Product  # noqa: E402
from pos_system.models.sale import Sale, VentaDePedidoRepetida  # noqa: E402

PEDIDO = {
    'codigo': 'CU01', 'subtotal': 20400, 'envio': 1500, 'descuento': 2040, 'total': 19860,
    'pago': {'modo': 'transferencia'},
    'cupon': {'codigo': 'BIENVENIDA', 'valor': 10, 'descuento': 2040, 'envio_gratis': False,
              'renglones': [{'id': 'FB_RESMA', 'variedad': None, 'es_pack': False, 'descuento': 1800},
                            {'id': 'FB_LAPIZ', 'variedad': None, 'es_pack': False, 'descuento': 240}]},
    'items': [{'id': 'FB_RESMA', 'nombre': 'Resma', 'cantidad': 1, 'precio': 18000, 'subtotal': 18000},
              {'id': 'FB_LAPIZ', 'nombre': 'Lápiz', 'cantidad': 3, 'precio': 800, 'subtotal': 2400,
               'es_pack': False}],
}


@pytest.fixture
def local(tmp_path):
    db = DatabaseManager(str(tmp_path / 'cobro.db'))
    db.initialize_database()
    CashRegister(db).open_register(initial_amount=5000.0)
    pid = Product(db).create({'name': 'RESMA PAMPA A4', 'price': 18000.0, 'stock': 12})
    db.execute_update("UPDATE products SET firebase_id = 'FB_RESMA' WHERE id = ?", (pid,))
    return {'db': db, 'ventas': Sale(db), 'pid': pid}


def cobrar(local, pedido_id='doc1', payment_type='transfer', intento='i1', **extra):
    ids = {r['firebase_id']: r['id'] for r in local['db'].execute_query(
        "SELECT id, firebase_id FROM products WHERE firebase_id IS NOT NULL")}
    lineas = pt.renglones_de_cobro(PEDIDO, pedido_id, ids)
    return local['ventas'].create({
        'total_amount': pt.total_a_cobrar(PEDIDO), 'payment_type': payment_type,
        'cash_received': 0, 'change_given': 0, 'transfer_amount': 0,
        'items': lineas, 'turno_nombre': 'Mari',
        'pedido_tienda_id': pedido_id, 'pedido_tienda_codigo': 'CU01', 'pedido_tienda_intento': intento, **extra,
    })


class TestVentaLocal:

    def test_entra_a_la_caja_sin_tocar_el_stock(self, local):
        sale_id = cobrar(local)
        venta = local['ventas'].get_by_id(sale_id)
        assert venta['total_amount'] == 19860
        assert venta['pedido_tienda_id'] == 'doc1' and venta['pedido_tienda_codigo'] == 'CU01'
        assert Product(local['db']).get_by_id(local['pid'])['stock'] == 12
        caja = local['db'].get_current_cash_register()
        assert caja['transfer_sales'] == pytest.approx(19860)
        assert caja['cash_sales'] == pytest.approx(0)

    def test_cada_renglon_guarda_de_que_producto_del_pedido_es(self, local):
        venta = local['ventas'].get_by_id(cobrar(local))
        resma, lapiz, envio = venta['items']
        assert resma['product_id'] == local['pid']
        assert lapiz['product_id'] == 0 and envio['product_id'] == 0
        assert json.loads(lapiz['tienda_json'])['producto_id'] == 'FB_LAPIZ'
        assert resma['subtotal'] == pytest.approx(16200)
        assert sum(i['subtotal'] for i in venta['items']) == pytest.approx(19860)

    def test_el_mismo_pedido_no_tiene_dos_ventas(self, local):
        primera = cobrar(local)
        with pytest.raises(VentaDePedidoRepetida) as err:
            cobrar(local)
        assert err.value.sale_id == primera
        assert len(local['db'].execute_query("SELECT id FROM sales")) == 1
        caja = local['db'].get_current_cash_register()
        assert caja['transfer_sales'] == pytest.approx(19860)

    def test_un_cobro_reabierto_se_cobra_con_otra_venta(self, local):
        """Se borró la venta desde el panel y el pedido volvió a "a cobrar": el
        nuevo cobro tiene otro intento y tiene que dejar su propia venta, no
        devolver la vieja (que el panel ya sacó de las ventas)."""
        primera = cobrar(local, intento='i1')
        segunda = cobrar(local, intento='i2')
        assert segunda != primera
        with pytest.raises(VentaDePedidoRepetida):
            cobrar(local, intento='i2')

    def test_dos_pedidos_distintos_y_ventas_comunes_conviven(self, local):
        cobrar(local, 'doc1')
        cobrar(local, 'doc2')
        for _ in range(2):
            local['ventas'].create({
                'total_amount': 100, 'payment_type': 'cash', 'cash_received': 100,
                'items': [{'product_id': local['pid'], 'product_name': 'RESMA', 'quantity': 1, 'unit_price': 100}]})
        assert len(local['db'].execute_query("SELECT id FROM sales")) == 4

    def test_efectivo_va_al_cajon(self, local):
        cobrar(local, payment_type='cash', cash_received=19860)
        caja = local['db'].get_current_cash_register()
        assert caja['cash_sales'] == pytest.approx(19860)


# ── Lo que sube ─────────────────────────────────────────────────────────────

class _Doc:
    def __init__(self, db, col, doc_id):
        self.db, self.col, self.doc_id = db, col, doc_id

    def set(self, datos, merge=False):
        self.db.escritos[(self.col, self.doc_id)] = dict(datos)


class _Col:
    def __init__(self, db, nombre):
        self.db, self.nombre = db, nombre

    def document(self, doc_id):
        return _Doc(self.db, self.nombre, doc_id)


class _Lote:
    def __init__(self, db):
        self.db = db
        self.pendiente = []

    def set(self, ref, datos, merge=False):
        self.pendiente.append((ref, datos))

    def commit(self):
        for ref, datos in self.pendiente:
            ref.set(datos)


class _Nube:
    def __init__(self):
        self.escritos = {}

    def collection(self, nombre):
        return _Col(self, nombre)

    def batch(self):
        return _Lote(self)


@pytest.fixture
def nube(monkeypatch):
    from pos_system.utils import firebase_sync as fs
    db = _Nube()
    sync = fs.FirebaseSync(db)
    monkeypatch.setattr(sync, '_run', lambda fn: fn())
    monkeypatch.setattr(fs, '_get_pc_id', lambda: 'CAJA1-aaaa')
    return sync, db


def test_la_venta_sube_atada_al_pedido(local, nube):
    sync, db = nube
    venta = local['ventas'].get_by_id(cobrar(local))
    sync.sync_sale(venta)
    doc = db.escritos[('ventas', f"CAJA1-aaaa_{venta['id']}")]
    assert doc['origen'] == 'tienda' and doc['pedido_id'] == 'doc1' and doc['pedido_codigo'] == 'CU01'

    sync.sync_sale_detail_by_day(venta, db_manager=local['db'])
    renglones = {k[1]: v for k, v in db.escritos.items() if k[0] == 'ventas_por_dia'}
    lapiz = renglones[f"CAJA1-aaaa_{venta['id']}_1"]
    # Sin `origen`: un panel viejo que borre la venta no tiene que devolver el
    # stock, que salió al entregar.
    assert 'origen' not in lapiz and lapiz['producto_id'] == 'FB_LAPIZ' and lapiz['pedido_id'] == 'doc1'
    assert lapiz['es_pack'] is False and lapiz['consumibles_procesado'] is True
    assert lapiz['descuento_tipo'] == 'cupon' and lapiz['descuento_monto'] == 240
    envio = renglones[f"CAJA1-aaaa_{venta['id']}_2"]
    assert envio['producto'] == 'ENVIO A DOMICILIO' and envio['producto_id'] == ''


def test_una_venta_comun_no_sube_campos_de_pedido(local, nube):
    sync, db = nube
    sid = local['ventas'].create({
        'total_amount': 100, 'payment_type': 'cash', 'cash_received': 100,
        'items': [{'product_id': local['pid'], 'product_name': 'RESMA', 'quantity': 1, 'unit_price': 100}]})
    venta = local['ventas'].get_by_id(sid)
    sync.sync_sale(venta)
    sync.sync_sale_detail_by_day(venta, db_manager=local['db'])
    for (col, _id), datos in db.escritos.items():
        assert 'origen' not in datos and 'pedido_id' not in datos


# ── El número de ARCA ───────────────────────────────────────────────────────

class _Arca:
    def __init__(self, rechazos):
        self.rechazos = list(rechazos)
        self.pedidos = []
        self.ultimo = 40

    def ultimo_comprobante(self, tipo, pv):
        return self.ultimo

    def solicitar_cae(self, **kw):
        self.pedidos.append(kw['nro_comprobante'])
        if self.rechazos:
            error = self.rechazos.pop(0)
            self.ultimo += 1          # otra caja se llevó ese número
            raise error
        return {'cae': '999', 'vto_cae': '20260930', 'nro_comprobante': kw['nro_comprobante'], 'resultado': 'A'}


def test_numero_ganado_por_otra_caja_se_reintenta():
    from pos_system.ui.factura_dialog import pedir_cae
    arca = _Arca([RuntimeError('AFIP rechazó el comprobante: [10016] El numero no se corresponde')])
    r = pedir_cae(arca, 'FAC. ELEC. C', 1, 100, 100, 0, 0, None, 'Consumidor Final', esperar=lambda s: None)
    assert r['nro_comprobante'] == 42
    assert arca.pedidos == [41, 42]


def test_otro_rechazo_no_se_reintenta():
    from pos_system.ui.factura_dialog import pedir_cae
    arca = _Arca([RuntimeError('AFIP rechazó el comprobante: [10015] CUIT inválido')])
    with pytest.raises(RuntimeError):
        pedir_cae(arca, 'FAC. ELEC. C', 1, 100, 100, 0, 0, None, 'Consumidor Final', esperar=lambda s: None)
    assert arca.pedidos == [41]


def test_reintentos_con_tope():
    from pos_system.ui.factura_dialog import pedir_cae
    arca = _Arca([RuntimeError('AFIP rechazó el comprobante: [10016] El numero no se corresponde')] * 10)
    with pytest.raises(RuntimeError):
        pedir_cae(arca, 'FAC. ELEC. C', 1, 100, 100, 0, 0, None, 'CF', reintentos=3, esperar=lambda s: None)
    assert len(arca.pedidos) == 4


# ── La pantalla de cobro precargada ─────────────────────────────────────────

_ABIERTAS = []


@pytest.fixture(scope='module')
def app():
    pytest.importorskip('PyQt5.QtWidgets')
    from PyQt5.QtWidgets import QApplication
    yield QApplication.instance() or QApplication([])
    _ABIERTAS.clear()


def test_pantalla_de_cobro_con_transferencia(app, local, monkeypatch):
    from pos_system.ui import sales_view
    dlg = sales_view.PaymentDialog(None, total=19860.0, cart=pt.renglones_de_cobro(PEDIDO, 'doc1'))
    _ABIERTAS.append(dlg)
    dlg.precargar_pago('transfer')
    assert dlg.payment_type == 'transfer'
    assert dlg.payment_subtype == 'Transferencia'
    assert dlg._subtype_btns['Transferencia'].isChecked()
    dlg._confirm()
    assert dlg.transfer_amount == 0 and dlg.cash_received == 0


def test_pantalla_de_cobro_con_efectivo_justo(app, local):
    from pos_system.ui import sales_view
    dlg = sales_view.PaymentDialog(None, total=19860.5, cart=[])
    _ABIERTAS.append(dlg)
    dlg.precargar_pago('cash')
    assert dlg.payment_type == 'cash'
    assert dlg._raw_amount == '19860.5'
    dlg._confirm()
    assert dlg.cash_received == pytest.approx(19860.5)
    assert dlg.change_given == pytest.approx(0)


# ── La cola offline no vuelve a descontar ───────────────────────────────────

def test_el_renglon_guarda_que_su_stock_ya_salio(local):
    venta = local['ventas'].get_by_id(cobrar(local))
    assert all(i['stock_descontado'] == 1 for i in venta['items'])


def test_resubir_la_venta_no_descuenta_otra_vez(local, nube, monkeypatch):
    """La venta no llegó a subir (la caja estaba sin nube) y la cola offline la
    resube con `sync_stock_after_sale`: los renglones del pedido y los de un
    fiado cobrado ya descontaron, un renglón común sí descuenta."""
    sync, db = nube
    llamados = []
    monkeypatch.setattr(sync, '_run', lambda fn: llamados.append(fn))
    venta = local['ventas'].get_by_id(cobrar(local))
    sync.sync_stock_after_sale(venta['items'], local['db'])
    del llamados[:]
    sync.sync_stock_after_sale(venta['items'], local['db'])
    assert not [f for f in llamados if 'sync_stock_after_sale' in f.__qualname__]

    sid = local['ventas'].create({
        'total_amount': 100, 'payment_type': 'cash', 'cash_received': 100,
        'items': [{'product_id': local['pid'], 'product_name': 'RESMA', 'quantity': 1, 'unit_price': 100}]})
    comun = local['ventas'].get_by_id(sid)
    del llamados[:]
    sync.sync_stock_after_sale(comun['items'], local['db'])
    assert len([f for f in llamados if 'sync_stock_after_sale' in f.__qualname__]) == 1


def test_un_error_de_red_con_esos_digitos_no_se_reintenta():
    """Un CUIT o un importe con 10016 adentro no es el rechazo de numeración:
    reintentar después de que ARCA autorizó emitiría dos facturas."""
    from pos_system.ui.factura_dialog import es_rechazo_de_numero
    assert es_rechazo_de_numero(RuntimeError('AFIP rechazó el comprobante: [10016] El numero no se corresponde'))
    assert es_rechazo_de_numero(RuntimeError('WSFE Error cabecera: [10016] numero'))
    assert not es_rechazo_de_numero(RuntimeError('Error al llamar WSFE FECAESolicitar: timeout cuit 20100160000'))
    assert not es_rechazo_de_numero(RuntimeError('AFIP rechazó el comprobante: [10015] importe 10016'))


def test_la_tabla_vieja_de_cobros_gana_la_columna_de_la_caja(tmp_path):
    from pos_system.models import cobros_pedido
    db = DatabaseManager(str(tmp_path / 'vieja.db'))
    db.initialize_database()
    with db.get_connection() as conn:
        conn.execute(cobros_pedido.TABLA.replace(',\n        caja_id       INTEGER', ''))
    columnas = {f['name'] for f in db.execute_query("PRAGMA table_info(cobros_pedido_pendientes)")}
    assert 'caja_id' not in columnas
    cobros_pedido.anotar(db, intento='i1', pedido_id='p1', codigo='AB12', pedido={}, pago={}, lineas=[], caja_id=7)
    assert cobros_pedido.obtener(db, 'i1')['caja_id'] == 7
    cobros_pedido.anotar(db, intento='i2', pedido_id='p1', codigo='AB12', pedido={}, pago={}, lineas=[])
    assert cobros_pedido.obtener(db, 'i2')['caja_id'] is None


def test_la_subida_y_la_sincronizacion_completa_arman_la_misma_venta():
    """La sincronización completa armaba la venta a mano y sin `merge`: perdía
    la caja, la transferencia del pago mixto, el fiado y el pedido web, y
    revivía las ventas borradas en el panel."""
    from pos_system.utils.firebase_sync import documento_de_venta
    venta = {'id': 57, 'payment_type': 'mixed', 'total_amount': 1000, 'cash_received': 400,
             'transfer_amount': 600, 'cash_register_id': 12, 'turno_nombre': 'Mari',
             'pedido_tienda_id': 'k1', 'pedido_tienda_codigo': 'K7M2',
             'items': [{'product_name': 'GOMA', 'quantity': 2.0}]}
    doc = documento_de_venta(venta, 'CAJA1-a', datetime(2026, 9, 16, 12, 0))
    assert doc['sale_id'] == 57 and doc['cash_register_id'] == 12 and doc['transfer_amount'] == 600
    assert doc['origen'] == 'tienda' and doc['pedido_id'] == 'k1' and doc['pedido_codigo'] == 'K7M2'
    assert doc['cajero'] == 'Mari' and doc['productos'] == 'GOMA x2'
    assert 'deleted' not in doc
    fuente = open(os.path.join(os.path.dirname(__file__), '..', 'ui', 'sync_progress_dialog.py'),
                  encoding='utf-8').read()
    assert 'documento_de_venta(s, _pc_id' in fuente and 'merge=True' in fuente

