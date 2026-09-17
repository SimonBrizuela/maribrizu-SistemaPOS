"""
Dos cajas con la pestaña Pedidos web de verdad, contra el emulador de Firestore.

Las otras pruebas separan las piezas: reglas solas, transacciones solas,
pantalla con una nube falsa. Esta arma todo junto como en el local: cada caja
con su pestaña, su base SQLite, su `NubePedidos` y su `VigiaPedidos` reales.
Lo único que se reemplaza es lo que espera a una persona (la pantalla de cobro
y los cartelitos).

Mismo requisito y comando que `test_pedidos_tienda_nube.py`; sin emulador se
saltea.
"""
import os
import sys
import time
import urllib.request
from datetime import datetime

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

EMULADOR = os.environ.get('FIRESTORE_EMULATOR_HOST')
PROYECTO = 'demo-pos-pedidos'
pytestmark = pytest.mark.skipif(not EMULADOR, reason='sin emulador de Firestore')

pytest.importorskip('PyQt5.QtWidgets')
from PyQt5.QtWidgets import QApplication, QDialog  # noqa: E402

_ABIERTAS = []


@pytest.fixture(scope='module')
def app():
    yield QApplication.instance() or QApplication([])
    _ABIERTAS.clear()


def cliente():
    from google.auth.credentials import AnonymousCredentials
    from google.cloud import firestore
    return firestore.Client(project=PROYECTO, credentials=AnonymousCredentials())


@pytest.fixture(autouse=True)
def base_vacia():
    if EMULADOR:
        req = urllib.request.Request(
            f'http://{EMULADOR}/emulator/v1/projects/{PROYECTO}/databases/(default)/documents', method='DELETE')
        urllib.request.urlopen(req).close()
    yield


def esperar(condicion, segundos=25):
    app = QApplication.instance()
    fin = time.time() + segundos
    while time.time() < fin:
        app.processEvents()
        if condicion():
            return True
        time.sleep(0.03)
    return False


class PagoFalso(QDialog):
    """La pantalla de cobro. `durante` corre con la pantalla "abierta"."""
    durante = None

    def __init__(self, parent=None, total=0.0, cart=None):
        super().__init__(parent)
        self.total = total
        self.payment_type = 'transfer'
        self.payment_subtype = 'Transferencia'
        self.cash_received = self.change_given = self.transfer_amount = 0.0
        self.selected_profile = self.selected_cliente = None
        self.nota_factura = ''

    def precargar_pago(self, tipo):
        self.payment_type = tipo
        if tipo == 'cash':
            self.cash_received = self.total

    def exec_(self):
        if PagoFalso.durante:
            PagoFalso.durante()
        return QDialog.Accepted


@pytest.fixture
def cajas(app, tmp_path, monkeypatch):
    from pos_system.database.db_manager import DatabaseManager
    from pos_system.models.cash_register import CashRegister
    from pos_system.ui import pedidos_web_view as pwv
    from pos_system.ui.pedidos_web_aviso import FranjaPedidos
    from pos_system.ui import sales_view
    from pos_system.utils.pedidos_tienda_nube import NubePedidos
    from pos_system.utils.pedidos_tienda_watcher import VigiaPedidos

    monkeypatch.setattr(sales_view, 'PaymentDialog', PagoFalso)
    PagoFalso.durante = None
    armadas = []
    for i in (1, 2):
        db_local = DatabaseManager(str(tmp_path / f'caja{i}.db'))
        db_local.initialize_database()
        CashRegister(db_local).open_register(initial_amount=0)
        quien = {'pc_id': f'CAJA{i}-000{i}', 'pc_nombre': f'CAJA{i}', 'cajero': f'Cajero {i}'}
        vista = pwv.PedidosWebView(None, current_user={'username': f'c{i}', 'turno_nombre': quien['cajero']},
                                   db=db_local)
        _ABIERTAS.append(vista)
        monkeypatch.setattr(vista, 'quien', lambda q=quien: dict(q))
        caja = {'vista': vista, 'db': db_local, 'mensajes': [], 'avisos': [], 'sonidos': []}
        # La franja de arriba del POS, conectada como en la ventana principal.
        franja = FranjaPedidos(None, sonar=lambda c=caja: c['sonidos'].append(1))
        _ABIERTAS.append(franja)
        franja.show()
        vista.pendientes_cambio.connect(franja.actualizar)
        vista.aviso.connect(lambda tipo, _m, f=franja: tipo in ('pedido', 'cobrar') and f.avisar_llegada())
        caja['franja'] = franja
        monkeypatch.setattr(vista, '_mensaje', lambda t, m, *a, c=caja: c['mensajes'].append(m))
        monkeypatch.setattr(vista, '_preguntar', lambda *a: True)
        vista.aviso.connect(lambda tipo, msg, c=caja: c['avisos'].append((tipo, msg)))
        nube = NubePedidos(cliente(), quien=vista.quien, avisar_cliente=False)
        vigia = VigiaPedidos(nube.db, nube)
        _ABIERTAS.append(vigia)
        vista.conectar(vigia, nube)
        caja['nube'] = nube
        caja['vigia'] = vigia
        armadas.append(caja)
    yield armadas
    for c in armadas:
        esperar(lambda c=c: not c['vista']._tareas, 10)
        c['vigia'].detener()
        c['vista']._reloj_cobros.stop()


def sembrar(pid, **extra):
    db = cliente()
    db.collection('catalogo').document('GOMA').set({'nombre': 'GOMA', 'stock': 40})
    p = {'codigo': pid[:4], 'estado': 'nuevo', 'visto': False, 'creado': datetime.now(),
         'entrega': {'modo': 'retiro'}, 'pago': {'modo': 'transferencia'},
         'cliente': {'nombre': 'Ana', 'telefono': '351'},
         'items': [{'id': 'GOMA', 'nombre': 'Goma', 'cantidad': 3, 'precio': 500, 'subtotal': 1500}],
         'subtotal': 1500, 'envio': 0, 'total': 1500}
    p.update(extra)
    db.collection('tienda_pedidos').document(pid).set(p)
    return db


def estado_en(caja, pid):
    return (caja['vista']._pedidos.get(pid) or {}).get('estado')


def test_de_punta_a_punta_con_dos_cajas(cajas):
    caja1, caja2 = cajas
    db = cliente()
    assert esperar(lambda: caja1['vista']._nube and caja2['vista']._nuevos_vistos is not None)

    sembrar('AB12xx')
    assert esperar(lambda: estado_en(caja1, 'AB12xx') == 'nuevo' and estado_en(caja2, 'AB12xx') == 'nuevo')
    assert any(t == 'pedido' and 'AB12' in m for t, m in caja2['avisos'])

    assert esperar(lambda: caja1['franja'].isVisible() and caja2['franja'].isVisible())
    assert caja1['sonidos'] and caja2['sonidos']

    caja1['vista']._accion('aceptar', 'AB12xx')
    assert esperar(lambda: estado_en(caja2, 'AB12xx') == 'preparando')
    # La caja 1 lo aceptó: en la 2 la franja se va sola y el recordatorio no suena.
    assert esperar(lambda: not caja2['franja'].isVisible() and not caja1['franja'].isVisible())
    sonidos = len(caja2['sonidos'])
    caja2['franja']._ultimo_sonido = -10_000
    caja2['franja'].revisar_recordatorio()
    assert len(caja2['sonidos']) == sonidos
    # La otra caja aprieta el botón viejo: rechazo con nombre, nada cambia.
    caja2['vista']._mover('AB12xx', 'nuevo', 'preparando')
    assert esperar(lambda: caja2['mensajes'])
    assert 'CAJA1' in caja2['mensajes'][-1]

    caja1['vista']._accion('listo', 'AB12xx')
    assert esperar(lambda: estado_en(caja1, 'AB12xx') == 'listo' and estado_en(caja2, 'AB12xx') == 'listo')

    visto_desde_la_otra = {}

    def mientras_cobra():
        # Con la pantalla de cobro abierta en la caja 1, la caja 2 ve la marca y
        # no puede cobrar ni cancelar.
        esperar(lambda: ((caja2['vista']._pedidos.get('AB12xx') or {}).get('cobro') or {}).get('estado') == 'en_curso')
        visto_desde_la_otra['marca'] = (caja2['vista']._pedidos['AB12xx'].get('cobro') or {}).get('pc_nombre')
        r = caja2['nube'].tomar_cobro('AB12xx')
        visto_desde_la_otra['tomar'] = r.motivo
        visto_desde_la_otra['cancelar'] = caja2['nube'].cancelar('AB12xx').ok
    PagoFalso.durante = mientras_cobra

    caja1['vista']._accion('cobrar', 'AB12xx')
    assert esperar(lambda: 'venta_id' in (db.collection('tienda_pedidos').document('AB12xx').get().to_dict() or {}))
    assert visto_desde_la_otra == {'marca': 'CAJA1', 'tomar': 'ocupado', 'cancelar': False}

    pedido = db.collection('tienda_pedidos').document('AB12xx').get().to_dict()
    ventas1 = caja1['db'].execute_query("SELECT * FROM sales")
    assert len(ventas1) == 1 and pedido['venta_id'] == f"CAJA1-0001_{ventas1[0]['id']}"
    assert caja2['db'].execute_query("SELECT * FROM sales") == []
    assert db.collection('catalogo').document('GOMA').get().to_dict()['stock'] == 37
    assert pedido['estado'] == 'entregado' and pedido['cobro']['estado'] == 'hecho'
    assert esperar(lambda: not caja1['vista']._tareas)
    from pos_system.models import cobros_pedido
    assert cobros_pedido.pendientes(caja1['db']) == []
    assert esperar(lambda: (caja2['vista']._pedidos.get('AB12xx') or {}).get('cobro', {}).get('estado') == 'hecho')


def test_lo_que_entrega_el_repartidor_lo_descuenta_una_caja_y_se_cobra_en_la_otra(cajas):
    caja1, caja2 = cajas
    db = cliente()
    sembrar('RR11xx', estado='listo', entrega={'modo': 'delivery'})
    assert esperar(lambda: estado_en(caja1, 'RR11xx') == 'listo' and estado_en(caja2, 'RR11xx') == 'listo')
    # Lo que escribe reparto-mover.
    db.collection('tienda_pedidos').document('RR11xx').update({
        'estado': 'entregado', 'venta_pendiente': True, 'entregado_por': 'reparto',
        'entregado_en': datetime.now(), 'entregado_dia': datetime.now().strftime('%Y-%m-%d')})
    assert esperar(lambda: (db.collection('tienda_pedidos').document('RR11xx').get().to_dict() or {})
                   .get('cobro_pendiente') is True, 40)
    assert db.collection('catalogo').document('GOMA').get().to_dict()['stock'] == 37
    assert esperar(lambda: any(t == 'cobrar' and 'RR11' in m for t, m in caja2['avisos']))

    caja2['vista']._accion('cobrar', 'RR11xx')
    assert esperar(lambda: 'venta_id' in (db.collection('tienda_pedidos').document('RR11xx').get().to_dict() or {}))
    assert len(caja2['db'].execute_query("SELECT * FROM sales")) == 1
    assert caja1['db'].execute_query("SELECT * FROM sales") == []
    assert db.collection('catalogo').document('GOMA').get().to_dict()['stock'] == 37
    entregas = [d.to_dict() for d in db.collection('tienda_pedidos_eventos').stream()
                if d.to_dict().get('accion') == 'entregar' and d.to_dict().get('stock')]
    assert len(entregas) == 1
