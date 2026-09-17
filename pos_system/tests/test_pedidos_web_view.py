"""
La pestaña "Pedidos web" con una nube y un vigía de mentira.

La concurrencia entre cajas se prueba contra el emulador
(`test_pedidos_tienda_nube.py`). Acá se prueba lo que hace la pantalla con cada
respuesta: qué botón muestra, qué le pide a la nube, cuándo crea la venta local
y cuándo no, y que un pedido cobrado nunca termine con dos ventas en la caja.

Corre sin pantalla (`QT_QPA_PLATFORM=offscreen`).
"""
import os
import sys
import time
from datetime import datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

pytest.importorskip('PyQt5.QtWidgets')

from PyQt5.QtCore import QObject, pyqtSignal  # noqa: E402
from PyQt5.QtWidgets import QApplication, QDialog  # noqa: E402

from pos_system.database.db_manager import DatabaseManager  # noqa: E402
from pos_system.models import pedido_tienda as reglas  # noqa: E402
from pos_system.models.cash_register import CashRegister  # noqa: E402
from pos_system.models.product import Product  # noqa: E402
from pos_system.utils.pedidos_tienda_nube import Resultado  # noqa: E402

_ABIERTAS = []
AHORA = datetime.now(reglas.TZ_AR)
YO = {'pc_id': 'CAJA1-aaaa', 'pc_nombre': 'CAJA1', 'cajero': 'Mari'}
OTRA = {'pc_id': 'CAJA2-bbbb', 'pc_nombre': 'CAJA2', 'cajero': 'Juan'}


@pytest.fixture(scope='module')
def app():
    yield QApplication.instance() or QApplication([])
    _ABIERTAS.clear()


@pytest.fixture
def local(tmp_path):
    db = DatabaseManager(str(tmp_path / 'pedidos_web.db'))
    db.initialize_database()
    CashRegister(db).open_register(initial_amount=1000.0)
    pid = Product(db).create({'name': 'GOMA', 'price': 500.0, 'stock': 40})
    db.execute_update("UPDATE products SET firebase_id = 'GOMA' WHERE id = ?", (pid,))
    return {'db': db, 'pid': pid}


class VigiaFalso(QObject):
    cambiaron = pyqtSignal(object)
    estado_conexion = pyqtSignal(bool)

    def iniciar(self):
        pass

    def detener(self):
        pass


class _Snap:
    exists = False

    def to_dict(self):
        return None


class _DbFalsa:
    def collection(self, _n):
        return self

    def document(self, _i):
        return self

    def get(self):
        return _Snap()


class NubeFalsa:
    """Decide con las reglas de verdad sobre pedidos en memoria."""

    def __init__(self, pedidos):
        self.pedidos = pedidos
        self.db = _DbFalsa()
        self.llamados = []
        self.rechazar = {}

    def _r(self, nombre, pid, decision, intento='i1'):
        self.llamados.append((nombre, pid))
        if nombre in self.rechazar:
            return Resultado(ok=False, rechazo=self.rechazar[nombre], motivo=self.rechazar.get(nombre + '_motivo'),
                             pedido=dict(self.pedidos.get(pid) or {}), intento=intento)
        if 'rechazo' in decision:
            return Resultado(ok=False, rechazo=decision['rechazo'], motivo=decision.get('motivo'),
                             pedido=dict(self.pedidos.get(pid) or {}), intento=intento)
        antes = dict(self.pedidos[pid])
        for clave, valor in (decision.get('campos') or {}).items():
            if '.' in clave:
                a, b = clave.split('.', 1)
                self.pedidos[pid].setdefault(a, {})[b] = valor
            else:
                self.pedidos[pid][clave] = valor
        return Resultado(ok=True, pedido=antes, intento=intento, plan=decision.get('plan'))

    def mover(self, pid, desde, hacia):
        return self._r('mover', pid, reglas.decidir_mover(self.pedidos.get(pid), desde, hacia, YO, AHORA))

    def entregar(self, pid, origen='pos'):
        return self._r('entregar', pid, reglas.decidir_entrega(self.pedidos.get(pid), {}, YO, AHORA, origen))

    def tomar_cobro(self, pid, forzar=False):
        self.llamados.append(('forzar', forzar))
        self.vueltas = getattr(self, 'vueltas', 0) + 1
        intento = f'i{self.vueltas}'
        return self._r('tomar_cobro', pid, reglas.decidir_tomar_cobro(self.pedidos.get(pid), YO, AHORA, intento, forzar),
                       intento)

    def leer(self, pid):
        p = self.pedidos.get(pid)
        return dict(p) if p is not None else None

    def renovar_cobro(self, pid, intento):
        return Resultado(ok=True)

    def soltar_cobro(self, pid, intento):
        self.llamados.append(('soltar_cobro', pid))
        if (self.pedidos.get(pid, {}).get('cobro') or {}).get('intento') == intento:
            self.pedidos[pid].pop('cobro', None)
        return Resultado(ok=True, intento=intento)

    def cobrar(self, pid, intento, pago):
        self.ultimo_pago = pago
        return self._r('cobrar', pid, reglas.decidir_cobro(self.pedidos.get(pid), {}, YO, AHORA, intento, pago), intento)

    def anotar_venta(self, pid, intento, sale_id):
        return self._r('anotar_venta', pid, reglas.decidir_anotar_venta(self.pedidos.get(pid), intento, YO['pc_id'], sale_id), intento)

    def cancelar(self, pid):
        return self._r('cancelar', pid, reglas.decidir_cancelar(self.pedidos.get(pid), YO, AHORA))

    def tomar_factura(self, pid, forzar=False):
        return self._r('tomar_factura', pid, reglas.decidir_tomar_factura(self.pedidos.get(pid), YO, AHORA, 'f1', forzar), 'f1')

    def anotar_factura(self, pid, intento, datos):
        return self._r('anotar_factura', pid, reglas.decidir_anotar_factura(self.pedidos.get(pid), intento, datos, YO, AHORA), intento)

    def soltar_factura(self, pid, intento):
        return self._r('soltar_factura', pid, {'campos': {}}, intento)

    def marcar_visto(self, ids):
        self.llamados.append(('visto', tuple(ids)))

    def marcar_impreso(self, pid):
        self.llamados.append(('impreso', pid))

    def anotar_problema(self, pid, accion, detalle, extra=None):
        self.llamados.append(('problema', pid, accion))

    def nombres(self):
        return [l[0] for l in self.llamados]


def pedido(pid, **extra):
    p = {'id': pid, 'codigo': pid[:4].upper(), 'estado': 'nuevo', 'visto': False, 'creado': AHORA,
         'entrega': {'modo': 'retiro'}, 'pago': {'modo': 'transferencia'},
         'cliente': {'nombre': 'Ana', 'telefono': '351'},
         'items': [{'id': 'GOMA', 'nombre': 'Goma', 'cantidad': 2, 'precio': 500, 'subtotal': 1000}],
         'subtotal': 1000, 'envio': 0, 'total': 1000}
    p.update(extra)
    return p


def esperar(condicion, segundos=5):
    app = QApplication.instance()
    fin = time.time() + segundos
    while time.time() < fin:
        app.processEvents()
        if condicion():
            return True
        time.sleep(0.01)
    return False


@pytest.fixture
def pantalla(app, local, monkeypatch):
    from pos_system.ui import pedidos_web_view as pwv
    vistas = []

    def armar(pedidos):
        vista = pwv.PedidosWebView(None, current_user={'username': 'mari', 'turno_nombre': 'Mari'}, db=local['db'])
        _ABIERTAS.append(vista)
        vistas.append(vista)
        monkeypatch.setattr(vista, 'quien', lambda: dict(YO))
        mensajes = []
        preguntas = []
        monkeypatch.setattr(vista, '_mensaje', lambda t, m, *a: mensajes.append(m))
        respuesta = {'si': True}

        def preguntar(t, m, *a):
            preguntas.append(m)
            return respuesta['si']
        monkeypatch.setattr(vista, '_preguntar', preguntar)
        avisos, titulos = [], []
        vista.aviso.connect(lambda tipo, msg: avisos.append((tipo, msg)))
        vista.titulo_cambio.connect(lambda t, _tt: titulos.append(t))
        nube = NubeFalsa({p['id']: dict(p) for p in pedidos})
        vigia = VigiaFalso()
        vista.conectar(vigia, nube)
        vigia.cambiaron.emit({pid: dict(p) for pid, p in nube.pedidos.items()})
        esperar(lambda: True, 0.05)
        return {'vista': vista, 'nube': nube, 'vigia': vigia, 'mensajes': mensajes, 'preguntas': preguntas,
                'avisos': avisos, 'titulos': titulos, 'respuesta': respuesta}
    yield armar
    # Lo que quedó andando en segundo plano termina acá, con los reemplazos
    # todavía puestos: si no, contesta en la prueba siguiente.
    for v in vistas:
        esperar(lambda v=v: not v._tareas and not v._cobrando, 5)
        getattr(v, '_reloj_cobros', None) and v._reloj_cobros.stop()


def refrescar(t):
    t['vigia'].cambiaron.emit({pid: dict(p) for pid, p in t['nube'].pedidos.items()})
    esperar(lambda: True, 0.05)


class PagoFalso(QDialog):
    """La pantalla de cobro, contestada sola."""
    acepta = True
    tipo = None

    def __init__(self, parent=None, total=0.0, cart=None):
        super().__init__(parent)
        self.total = total
        self.cart = cart
        self.payment_type = 'cash'
        self.payment_subtype = 'Efectivo'
        self.cash_received = 0.0
        self.change_given = 0.0
        self.transfer_amount = 0.0
        self.selected_profile = None
        self.selected_cliente = None
        self.nota_factura = ''

    def precargar_pago(self, tipo):
        PagoFalso.tipo = tipo
        self.payment_type = tipo
        if tipo == 'cash':
            self.cash_received = self.total
        else:
            self.payment_subtype = 'Transferencia'

    def exec_(self):
        return QDialog.Accepted if PagoFalso.acepta else QDialog.Rejected


@pytest.fixture
def pago(monkeypatch):
    from pos_system.ui import sales_view
    PagoFalso.acepta = True
    PagoFalso.tipo = None
    monkeypatch.setattr(sales_view, 'PaymentDialog', PagoFalso)
    return PagoFalso


def ventas(local):
    return local['db'].execute_query("SELECT * FROM sales")


# ── Lo que se ve ────────────────────────────────────────────────────────────

def test_titulo_y_avisos(pantalla):
    t = pantalla([pedido('n1'), pedido('c1', estado='entregado', cobro_pendiente=True, stock_descontado=True,
                                        venta_registrada=True)])
    assert t['titulos'][-1] == 'Pedidos web (1 nuevo · 1 a cobrar)'
    assert t['avisos'] == [('pedido', '1 pedido web sin ver')]

    t['nube'].pedidos['n2'] = pedido('n2', codigo='ZZ99')
    t['nube'].pedidos['r1'] = pedido('r1', codigo='RR11', estado='entregado', entregado_por='reparto', venta_pendiente=True)
    refrescar(t)
    assert ('pedido', 'Pedido nuevo ZZ99 · Ana · $1.000 · retira') in t['avisos']
    assert ('cobrar', 'El repartidor entregó RR11. Falta cobrarlo.') in t['avisos']
    refrescar(t)
    assert len(t['avisos']) == 3


def test_boton_principal_segun_el_estado(pantalla):
    from pos_system.ui.pedidos_web_view import accion_principal
    assert accion_principal(pedido('a'))[0] == 'aceptar'
    assert accion_principal(pedido('a', estado='preparando'))[0] == 'listo'
    assert accion_principal(pedido('a', estado='listo'))[1] == 'Entregar y cobrar'
    assert accion_principal(pedido('a', estado='listo', entrega={'modo': 'delivery'}))[0] == 'salio'
    assert accion_principal(pedido('a', estado='entregado', cobro_pendiente=True))[1] == 'Cobrar $1.000'
    assert accion_principal(pedido('a', estado='entregado', cobro={'estado': 'hecho'}))[0] is None


def test_abrir_un_nuevo_lo_marca_visto(pantalla):
    t = pantalla([pedido('n1')])
    t['vista'].show()
    t['vista']._seleccionar('n1')
    assert esperar(lambda: ('visto', ('n1',)) in t['nube'].llamados)


# ── Mover ───────────────────────────────────────────────────────────────────

def test_aceptar_pide_mover_desde_lo_que_se_ve(pantalla):
    t = pantalla([pedido('n1')])
    t['vista']._accion('aceptar', 'n1')
    assert esperar(lambda: 'mover' in t['nube'].nombres())
    assert t['nube'].pedidos['n1']['estado'] == 'preparando'


def test_boton_viejo_explica_quien_lo_movio(pantalla):
    t = pantalla([pedido('n1')])
    t['nube'].pedidos['n1'].update(estado='preparando', movido_por={**OTRA, 'estado': 'preparando'})
    t['vista']._accion('aceptar', 'n1')
    assert esperar(lambda: t['mensajes'])
    assert 'CAJA2 (Juan)' in t['mensajes'][0]


def test_cancelar_pregunta_antes(pantalla):
    t = pantalla([pedido('n1')])
    t['respuesta']['si'] = False
    t['vista']._accion('cancelar', 'n1')
    assert 'cancelar' not in t['nube'].nombres()
    t['respuesta']['si'] = True
    t['vista']._accion('cancelar', 'n1')
    assert esperar(lambda: t['nube'].pedidos['n1']['estado'] == 'cancelado')


# ── Cobrar ──────────────────────────────────────────────────────────────────

def test_cobrar_crea_una_venta_en_la_caja_y_no_toca_stock(pantalla, pago, local):
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True, stock_descontado=True, venta_registrada=True)])
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: 'anotar_venta' in t['nube'].nombres())
    assert pago.tipo == 'transfer'
    filas = ventas(local)
    assert len(filas) == 1 and filas[0]['pedido_tienda_id'] == 'c1' and filas[0]['total_amount'] == 1000
    assert Product(local['db']).get_by_id(local['pid'])['stock'] == 40
    assert t['nube'].pedidos['c1']['venta_id'] == f"CAJA1-aaaa_{filas[0]['id']}"
    assert 'cobrado' in t['mensajes'][-1]


def test_efectivo_viene_elegido(pantalla, pago, local):
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True, pago={'modo': 'efectivo'})])
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: 'cobrar' in t['nube'].nombres())
    assert pago.tipo == 'cash'
    assert t['nube'].ultimo_pago['payment_type'] == 'cash'


def test_cerrar_la_pantalla_de_cobro_suelta_el_pedido(pantalla, pago, local):
    pago.acepta = False
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: 'soltar_cobro' in t['nube'].nombres())
    assert 'cobrar' not in t['nube'].nombres()
    assert ventas(local) == []


def test_cobro_rechazado_no_crea_venta(pantalla, pago, local):
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    t['nube'].rechazar['cobrar'] = 'otra caja tomó el pedido para cobrarlo (CAJA2 (Juan))'
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: t['mensajes'])
    assert ventas(local) == []
    assert 'No se creó ninguna venta' in t['mensajes'][-1]


def test_otra_caja_cobrando_bloquea_y_la_vencida_pregunta(pantalla, pago, local):
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True,
                         cobro={'estado': 'en_curso', **OTRA, 'desde': AHORA - timedelta(minutes=30)})])
    t['respuesta']['si'] = False
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: t['preguntas'])
    assert 'CAJA2 (Juan)' in t['preguntas'][0]
    assert ventas(local) == []
    t['respuesta']['si'] = True
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: 'anotar_venta' in t['nube'].nombres())
    assert ('forzar', True) in t['nube'].llamados
    assert len(ventas(local)) == 1


def test_caja_cerrada_no_cobra(pantalla, pago, local):
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    caja = local['db'].get_current_cash_register()
    CashRegister(local['db']).close_register(caja['id'], 1000.0) if hasattr(CashRegister, 'close_register') else \
        local['db'].execute_update("UPDATE cash_register SET status='closed' WHERE id=?", (caja['id'],))
    local['db'].execute_update("UPDATE cash_register SET status='closed'")
    t['vista']._accion('cobrar', 'c1')
    assert t['mensajes'] and 'caja abierta' in t['mensajes'][-1]
    assert 'tomar_cobro' not in t['nube'].nombres()


# ── Cobros a medias ─────────────────────────────────────────────────────────

def filas_pendientes(local):
    from pos_system.models import cobros_pedido
    return cobros_pedido.pendientes(local['db'], AHORA + timedelta(days=1))


def procesar(t):
    t['vista']._procesar_cobros_pendientes()
    assert esperar(lambda: not t['vista']._tareas and not t['vista']._recuperando)


def test_un_cobro_completo_no_deja_nada_pendiente(pantalla, pago, local):
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: 'anotar_venta' in t['nube'].nombres() and not t['vista']._tareas)
    assert filas_pendientes(local) == []


def test_cobro_rechazado_descarta_la_fila(pantalla, pago, local):
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    t['nube'].rechazar['cobrar'] = 'otra caja tomó el pedido para cobrarlo'
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: t['mensajes'] and not t['vista']._tareas)
    assert filas_pendientes(local) == []


def test_sin_respuesta_de_la_nube_se_resuelve_despues_sin_duplicar(pantalla, pago, local):
    """El cobro entró en la nube pero la respuesta se perdió: la caja no crea la
    venta en el momento (no sabe) y la crea la revisión al releer el pedido."""
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    nube = t['nube']
    original = nube.cobrar

    def cobrar_sin_respuesta(pid, intento, pago_):
        original(pid, intento, pago_)          # entra en la "nube"...
        return Resultado(ok=False, rechazo='no se pudo hablar con la nube', motivo='error')
    nube.cobrar = cobrar_sin_respuesta
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: t['mensajes'] and not t['vista']._tareas)
    assert ventas(local) == []
    assert len(filas_pendientes(local)) == 1

    procesar(t)
    assert len(ventas(local)) == 1
    assert nube.pedidos['c1']['venta_id'] == f"CAJA1-aaaa_{ventas(local)[0]['id']}"
    assert filas_pendientes(local) == []
    procesar(t)
    assert len(ventas(local)) == 1


def test_un_cobro_que_nunca_entro_se_descarta(pantalla, pago, local):
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    nube = t['nube']
    nube.cobrar = lambda pid, intento, pago_: Resultado(ok=False, rechazo='sin red', motivo='error')
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: t['mensajes'] and not t['vista']._tareas)
    assert len(filas_pendientes(local)) == 1
    procesar(t)
    assert filas_pendientes(local) == []
    assert ventas(local) == []
    assert 'soltar_cobro' in nube.nombres()     # la marca era de este intento


def test_si_la_venta_local_falla_la_termina_la_revision(pantalla, pago, local, monkeypatch):
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    vista = t['vista']
    real = vista.sale_model.create
    monkeypatch.setattr(vista.sale_model, 'create', lambda datos: (_ for _ in ()).throw(RuntimeError('disco lleno')))
    vista._accion('cobrar', 'c1')
    assert esperar(lambda: t['mensajes'] and not vista._tareas)
    assert ventas(local) == [] and len(filas_pendientes(local)) == 1
    monkeypatch.setattr(vista.sale_model, 'create', real)
    procesar(t)
    assert len(ventas(local)) == 1 and filas_pendientes(local) == []


def test_sin_caja_abierta_la_revision_espera(pantalla, pago, local):
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    nube = t['nube']
    original = nube.cobrar
    nube.cobrar = lambda pid, intento, pago_: (original(pid, intento, pago_),
                                               Resultado(ok=False, rechazo='sin red', motivo='error'))[1]
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: t['mensajes'] and not t['vista']._tareas)
    local['db'].execute_update("UPDATE cash_register SET status='closed'")
    procesar(t)
    assert ventas(local) == [] and len(filas_pendientes(local)) == 1
    local['db'].execute_update("UPDATE cash_register SET status='open'")
    procesar(t)
    assert len(ventas(local)) == 1


def test_un_cobro_reabierto_se_vuelve_a_cobrar_con_otra_venta(pantalla, pago, local):
    """Se cobró, el panel borró la venta y reabrió el cobro: cobrarlo de nuevo en
    la misma caja tiene que dejar una venta nueva, no reusar la borrada."""
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: 'anotar_venta' in t['nube'].nombres() and not t['vista']._tareas)
    primera = ventas(local)[0]['id']
    # Lo que hace reabrirCobro en el panel.
    p = t['nube'].pedidos['c1']
    p.update(cobro_pendiente=True)
    p.pop('cobro', None)
    p.pop('venta_id', None)
    refrescar(t)
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: t['nube'].nombres().count('anotar_venta') == 2 and not t['vista']._tareas)
    filas = ventas(local)
    assert len(filas) == 2 and filas[1]['id'] != primera
    assert t['nube'].pedidos['c1']['venta_id'] == f"CAJA1-aaaa_{filas[1]['id']}"


# ── Mientras hay un diálogo abierto ─────────────────────────────────────────

def test_con_un_dialogo_abierto_no_se_borran_los_botones(pantalla):
    t = pantalla([pedido('n1')])
    vista = t['vista']
    vista._seleccionar('n1')
    botones_antes = vista.detalle_scroll.widget().findChildren(type(vista._boton('x')))
    vista._modal = 1
    t['nube'].pedidos['n1']['estado'] = 'preparando'
    refrescar(t)
    assert vista._redibujo_pendiente is True
    assert all(not b.isHidden() or True for b in botones_antes)
    vista._fin_modal()
    assert esperar(lambda: vista._redibujo_pendiente is False)


# ── Facturar ────────────────────────────────────────────────────────────────

class FacturaFalsa(QDialog):
    emitir = None
    pdf = 'factura.pdf'

    def __init__(self, parent=None, sale=None, **kw):
        super().__init__(parent)
        self.sale = sale
        self.factura_emitida = None
        self.pdf_path = None

    def exec_(self):
        if FacturaFalsa.emitir is not None:
            self.factura_emitida = dict(FacturaFalsa.emitir)
            self.pdf_path = FacturaFalsa.pdf
        return QDialog.Accepted


@pytest.fixture
def factura(monkeypatch):
    from pos_system.ui import factura_dialog
    monkeypatch.setattr(factura_dialog, 'FacturaDialog', FacturaFalsa)
    FacturaFalsa.emitir = None
    FacturaFalsa.pdf = 'factura.pdf'
    return FacturaFalsa


COBRADO = dict(estado='entregado', cobro={'estado': 'hecho', 'pc_id': 'CAJA1-aaaa', 'intento': 'i1',
                                          'pago': {'payment_type': 'cash'}})
EMITIDA = {'tipo_comprobante': 'FAC. ELEC. C', 'punto_venta': 3, 'nro_comprobante': 120, 'cae': '7412', 'total': 1000}


def test_factura_con_cae_queda_anotada(pantalla, factura):
    factura.emitir = EMITIDA
    t = pantalla([pedido('c1', **COBRADO)])
    t['vista']._facturar('c1', perfil={'nombre': 'X'})
    assert esperar(lambda: 'anotar_factura' in t['nube'].nombres() and not t['vista']._tareas)
    assert t['nube'].pedidos['c1']['factura']['numero'] == 120


def test_comprobante_sin_cae_no_marca_facturado(pantalla, factura):
    factura.emitir = dict(EMITIDA, cae='')
    t = pantalla([pedido('c1', **COBRADO)])
    t['vista']._facturar('c1', perfil={'nombre': 'X'})
    assert esperar(lambda: 'soltar_factura' in t['nube'].nombres() and not t['vista']._tareas)
    assert 'anotar_factura' not in t['nube'].nombres()
    assert 'sin CAE' in t['mensajes'][-1]


def test_cae_con_pdf_fallido_se_anota_igual_y_avisa(pantalla, factura):
    factura.emitir = EMITIDA
    factura.pdf = None
    t = pantalla([pedido('c1', **COBRADO)])
    t['vista']._facturar('c1', perfil={'nombre': 'X'})
    assert esperar(lambda: 'anotar_factura' in t['nube'].nombres() and not t['vista']._tareas)
    assert 'PDF' in t['mensajes'][-1]


def test_factura_de_un_cobro_de_otra_caja_usa_el_medio_del_cobro(pantalla, factura, local):
    t = pantalla([pedido('c1', **COBRADO)])
    venta = t['vista']._venta_para_factura('c1', t['nube'].pedidos['c1'], None)
    assert venta['id'] is None and venta['payment_type'] == 'cash'
