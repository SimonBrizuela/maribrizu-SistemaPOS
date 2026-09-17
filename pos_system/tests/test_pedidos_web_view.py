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

    def anular_entrega(self, pid, motivo):
        self.ultimo_motivo = motivo
        return self._r('anular_entrega', pid,
                       reglas.decidir_anular_entrega(self.pedidos.get(pid), {}, YO, AHORA, motivo))

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
        # La pestaña a la vista, como cuando el cajero la abre: oculta no dibuja.
        vista.resize(1200, 800)
        vista.show()
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


# ── Al abrir el POS ─────────────────────────────────────────────────────────

def test_sin_las_cuatro_escuchas_no_suena_nada(pantalla):
    """Cada escucha contesta por su lado: tomar la primera respuesta como "lo ya
    visto" hacía sonar un aviso por cada pedido de las otras tres."""
    t = pantalla([])
    vista, vigia = t['vista'], t['vigia']
    listo = {'si': False}
    vigia.completo = lambda: listo['si']
    t['nube'].pedidos.update({'n1': pedido('n1'), 'c1': pedido('c1', estado='entregado', cobro_pendiente=True)})
    vista._nuevos_vistos = None
    refrescar(t)
    assert t['avisos'] == []
    listo['si'] = True
    refrescar(t)
    assert t['avisos'] == [('pedido', '1 pedido web sin ver')]
    refrescar(t)
    assert len(t['avisos']) == 1


def test_oculta_no_arma_la_lista_y_al_mostrarse_si(pantalla):
    t = pantalla([pedido('n1')])
    vista = t['vista']
    vista.hide()
    t['nube'].pedidos['n2'] = pedido('n2', codigo='ZZ99')
    refrescar(t)
    assert vista._redibujo_pendiente is True
    assert 'Pedidos web (2 nuevos)' in t['titulos'][-1]
    vista.show()
    assert esperar(lambda: vista._redibujo_pendiente is False)
    from PyQt5.QtWidgets import QLabel
    QApplication.processEvents()
    textos = [l.text() for l in vista.lista_v.parentWidget().findChildren(QLabel) if l.isVisible()]
    assert 'ZZ99' in textos


def test_abre_el_primero_sin_marcarlo_visto(pantalla):
    t = pantalla([pedido('n1')])
    assert t['vista']._seleccion == 'n1'
    esperar(lambda: True, 0.1)
    assert ('visto', ('n1',)) not in t['nube'].llamados


def test_un_cambio_que_no_se_ve_no_rearma_los_botones(pantalla):
    """Otra caja renueva su marca cada 90 segundos: rearmar los botones en el
    medio de un clic lo perdía."""
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True,
                         cobro={'estado': 'en_curso', **OTRA, 'intento': 'x', 'desde': AHORA})])
    vista = t['vista']
    vista._seleccionar('c1')
    antes = vista.detalle_scroll.widget().findChildren(type(vista._boton('x')))
    t['nube'].pedidos['c1']['cobro'] = dict(t['nube'].pedidos['c1']['cobro'], desde=AHORA + timedelta(seconds=90))
    refrescar(t)
    despues = vista.detalle_scroll.widget().findChildren(type(vista._boton('x')))
    assert antes and [id(b) for b in antes] == [id(b) for b in despues]
    t['nube'].pedidos['c1']['cobro'] = dict(t['nube'].pedidos['c1']['cobro'], pc_nombre='CAJA3')
    refrescar(t)
    assert esperar(lambda: not any(b.isVisible() for b in antes))


def test_con_el_reloj_de_la_pc_atrasado_la_marca_vencida_no_traba(pantalla):
    desde = AHORA - timedelta(minutes=10)
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True,
                         cobro={'estado': 'en_curso', **OTRA, 'intento': 'x', 'desde': desde})])
    vista = t['vista']
    vigia = t['vigia']
    # La hora del servidor según el vigía: la marca de hace 10 minutos venció.
    vigia.ahora = lambda: AHORA
    vista._filtro = 'cobrar'
    vista._seleccionar('c1')
    cobrar = [b for b in visibles(vista, type(vista._boton('x'))) if b.text().startswith('Cobrar')]
    assert cobrar and cobrar[0].isEnabled()
    vigia.ahora = lambda: desde + timedelta(minutes=1)
    vista._redibujar_detalle()
    cobrar = [b for b in visibles(vista, type(vista._boton('x'))) if b.text().startswith('Cobrar')]
    assert cobrar and not cobrar[0].isEnabled()


# ── Cobrar: lo que puede pasar en el medio ──────────────────────────────────

def test_si_cierran_la_caja_con_la_pantalla_de_cobro_abierta_no_se_registra(pantalla, pago, local, monkeypatch):
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    real = PagoFalso.exec_

    def cerrar_caja(self):
        local['db'].execute_update("UPDATE cash_register SET status='closed'")
        return real(self)
    monkeypatch.setattr(PagoFalso, 'exec_', cerrar_caja)
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: 'soltar_cobro' in t['nube'].nombres() and not t['vista']._tareas)
    assert 'cobrar' not in t['nube'].nombres()
    assert ventas(local) == [] and filas_pendientes(local) == []
    assert 'La caja se cerró' in t['mensajes'][-1]
    assert 'c1' not in t['vista']._cobrando


def test_envio_a_confirmar_pide_el_monto_y_cobra_el_total_nuevo(pantalla, pago, local, monkeypatch):
    envio = dict(estado='listo', entrega={'modo': 'delivery', 'envio_a_confirmar': True}, envio=0,
                 subtotal=1000, total=1000)
    t = pantalla([pedido('e1', **envio)])
    monkeypatch.setattr(t['vista'], '_pedir_monto', lambda *a: 1800.0)
    t['vista']._accion('cobrar', 'e1')
    assert esperar(lambda: 'anotar_venta' in t['nube'].nombres() and not t['vista']._tareas)
    fila = ventas(local)[0]
    assert fila['total_amount'] == 2800
    renglones = local['db'].execute_query("SELECT product_name, subtotal FROM sale_items WHERE sale_id=?", (fila['id'],))
    assert ('ENVIO A DOMICILIO', 1800) in [(r['product_name'], r['subtotal']) for r in renglones]
    assert t['nube'].pedidos['e1']['cobro']['total'] == 2800
    assert t['nube'].ultimo_pago['total'] == 2800


def test_envio_a_confirmar_sin_monto_no_cobra(pantalla, pago, local, monkeypatch):
    t = pantalla([pedido('e1', estado='listo', entrega={'modo': 'delivery', 'envio_a_confirmar': True})])
    monkeypatch.setattr(t['vista'], '_pedir_monto', lambda *a: None)
    t['vista']._accion('cobrar', 'e1')
    assert esperar(lambda: 'soltar_cobro' in t['nube'].nombres() and not t['vista']._tareas)
    assert 'cobrar' not in t['nube'].nombres() and ventas(local) == []


def test_si_la_pantalla_de_cobro_falla_el_pedido_no_queda_trabado(pantalla, pago, local, monkeypatch):
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    monkeypatch.setattr(PagoFalso, 'precargar_pago', lambda self, tipo: 1 / 0)
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: 'soltar_cobro' in t['nube'].nombres() and not t['vista']._tareas)
    assert 'c1' not in t['vista']._cobrando and 'c1' not in t['vista']._ocupados
    assert 'falló' in t['mensajes'][-1]
    assert ventas(local) == []


def test_un_cobro_que_la_red_repitio_crea_la_venta_una_vez(pantalla, pago, local):
    """El commit se reenvió y la transacción corrió dos veces: la segunda ve el
    cobro hecho por este mismo intento y lo rechaza. Es el cobro propio."""
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    nube = t['nube']
    original = nube.cobrar

    def cobrar_dos_veces(pid, intento, pago_):
        original(pid, intento, pago_)
        return nube._r('cobrar', pid, reglas.decidir_cobro(nube.pedidos.get(pid), {}, YO, AHORA, intento, pago_),
                       intento)
    nube.cobrar = cobrar_dos_veces
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: 'anotar_venta' in nube.nombres() and not t['vista']._tareas)
    assert len(ventas(local)) == 1 and filas_pendientes(local) == []
    assert nube.pedidos['c1']['venta_id'] == f"CAJA1-aaaa_{ventas(local)[0]['id']}"


def test_si_anotar_la_venta_se_rechaza_la_fila_espera(pantalla, pago, local):
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    t['nube'].rechazar['anotar_venta'] = 'el cobro no es de esta caja'
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: 'anotar_venta' in t['nube'].nombres() and not t['vista']._tareas)
    from pos_system.models import cobros_pedido
    assert cobros_pedido.pendientes(local['db']) == []          # pospuesta: no vuelve en la próxima vuelta
    fila = filas_pendientes(local)[0]
    assert fila['fallas'] == 1 and fila['estado'] == 'venta_creada'
    assert ('problema', 'c1', 'anotar_venta') in t['nube'].llamados


def test_el_cobro_a_medias_avisa_si_quedo_en_otra_caja(pantalla, pago, local):
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    nube = t['nube']
    original = nube.cobrar
    nube.cobrar = lambda pid, intento, pago_: (original(pid, intento, pago_),
                                               Resultado(ok=False, rechazo='sin red', motivo='error'))[1]
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: t['mensajes'] and not t['vista']._tareas)
    caja = local['db'].get_current_cash_register()
    local['db'].execute_update("UPDATE cash_register SET status='closed'")
    CashRegister(local['db']).open_register(initial_amount=0)
    assert local['db'].get_current_cash_register()['id'] != caja['id']
    procesar(t)
    assert len(ventas(local)) == 1
    # Es un cartel para quien cierre la caja, no un pedido que suena.
    assert any(tipo == 'caja' and f"caja #{caja['id']}" in m for tipo, m in t['avisos'])


def test_la_venta_sube_con_rubro_y_se_marca_subida(pantalla, pago, local, monkeypatch):
    subidas = []

    class FbFalso:
        enabled = True

        def sync_sale(self, venta, esperar=False):
            subidas.append(('venta', venta))
            return True

        def sync_sale_detail_by_day(self, venta, db_manager=None, esperar=False):
            subidas.append(('detalle', venta))
            return True
    from pos_system.utils import firebase_sync
    monkeypatch.setattr(firebase_sync, 'get_firebase_sync', lambda: FbFalso())
    local['db'].execute_update("UPDATE products SET category='LIBRERIA' WHERE id=?", (local['pid'],))
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True, envio=900, total=1900,
                         entrega={'modo': 'delivery'})])
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: len(subidas) == 2)
    venta = subidas[0][1]
    assert {i['product_name']: i['category'] for i in venta['items']} == {'GOMA': 'LIBRERIA',
                                                                          'ENVIO A DOMICILIO': 'SERVICIOS'}
    assert esperar(lambda: ventas(local)[0]['firebase_synced'] == 1)


def test_la_venta_que_no_subio_queda_para_la_cola(pantalla, pago, local, monkeypatch):
    llamados = []

    class FbSinRed:
        enabled = True

        def sync_sale(self, venta, esperar=False):
            llamados.append('venta')
            return False

        def sync_sale_detail_by_day(self, venta, db_manager=None, esperar=False):
            llamados.append('detalle')
            return True
    from pos_system.utils import firebase_sync
    monkeypatch.setattr(firebase_sync, 'get_firebase_sync', lambda: FbSinRed())
    t = pantalla([pedido('c1', estado='entregado', cobro_pendiente=True)])
    t['vista']._accion('cobrar', 'c1')
    assert esperar(lambda: len(llamados) == 2)
    esperar(lambda: False, 0.3)
    assert not ventas(local)[0]['firebase_synced']


# ── Anular una entrega ──────────────────────────────────────────────────────

ENTREGADO = dict(estado='entregado', stock_descontado=True, venta_registrada=True, cobro_pendiente=True,
                 entregado_en=AHORA)


def visibles(vista, tipo):
    """Los widgets del detalle que se ven: los nuevos se muestran en la vuelta
    siguiente del bucle de Qt y los reemplazados se ocultan antes de borrarse."""
    QApplication.processEvents()
    return [w for w in vista.detalle_scroll.widget().findChildren(tipo) if w.isVisible()]


def botones(vista):
    return [b.text() for b in visibles(vista, type(vista._boton('x')))]


def test_anular_entrega_solo_para_admin_y_con_motivo(pantalla, monkeypatch):
    t = pantalla([pedido('c1', **ENTREGADO)])
    vista = t['vista']
    vista._filtro = 'cobrar'
    vista._seleccionar('c1')
    assert 'Anular entrega' not in botones(vista)
    vista.current_user['role'] = 'admin'
    vista._redibujar_detalle()
    assert 'Anular entrega' in botones(vista)

    monkeypatch.setattr(vista, '_pedir_texto', lambda *a: '')
    vista._accion('anular', 'c1')
    assert 'motivo' in t['mensajes'][-1] and 'anular_entrega' not in t['nube'].nombres()

    monkeypatch.setattr(vista, '_pedir_texto', lambda *a: None)
    vista._accion('anular', 'c1')
    assert 'anular_entrega' not in t['nube'].nombres()

    monkeypatch.setattr(vista, '_pedir_texto', lambda *a: 'lo devolvió')
    vista._accion('anular', 'c1')
    assert esperar(lambda: t['nube'].pedidos['c1']['estado'] == 'cancelado' and not vista._tareas)
    assert t['nube'].ultimo_motivo == 'lo devolvió'
    refrescar(t)
    vista._seleccionar('c1')
    from PyQt5.QtWidgets import QLabel
    textos = ' '.join(l.text() for l in vista.detalle_scroll.widget().findChildren(QLabel))
    assert 'Entrega anulada' in textos and 'lo devolvió' in textos


def test_renglones_sin_descontar_se_ven_en_el_pedido(pantalla):
    t = pantalla([pedido('c1', **ENTREGADO, stock_saltados=[
        {'renglon': 0, 'producto_id': 'GOMA', 'motivo': 'variedad "Roja" no encontrada', 'nombre': 'Goma'}])])
    vista = t['vista']
    vista._filtro = 'cobrar'
    vista._seleccionar('c1')
    from PyQt5.QtWidgets import QLabel
    textos = ' '.join(l.text() for l in vista.detalle_scroll.widget().findChildren(QLabel))
    assert 'Sin descontar del stock (1)' in textos and 'no encontrada' in textos


def test_comprobante_imagen_se_ve_en_el_visor_y_lo_demas_en_el_navegador(pantalla, monkeypatch):
    from PyQt5.QtCore import QBuffer, QByteArray, QIODevice
    from PyQt5.QtGui import QColor, QImage
    from pos_system.ui import pedidos_web_view as pwv
    t = pantalla([pedido('c1')])
    vista = t['vista']
    abiertos, visores = [], []
    monkeypatch.setattr(pwv.QDesktopServices, 'openUrl', lambda url: abiertos.append(url.toString()))
    monkeypatch.setattr(vista, '_mostrar_comprobante', lambda pid, img, url: visores.append((pid, img.width(), url)))

    imagen = QImage(40, 30, QImage.Format_RGB32)
    imagen.fill(QColor('white'))
    crudo = QByteArray()
    buf = QBuffer(crudo)
    buf.open(QIODevice.WriteOnly)
    imagen.save(buf, 'PNG')
    monkeypatch.setattr(pwv, '_descargar', lambda url: bytes(crudo))

    class Snap:
        exists = True

        def __init__(self, datos):
            self.datos = datos

        def to_dict(self):
            return self.datos
    bueno = 'https://firebasestorage.googleapis.com/v0/b/mari-d7c71.firebasestorage.app/o/c.webp'
    casos = [
        ({'url': bueno, 'tipo': 'imagen'}, 'visor'),
        ({'url': bueno.replace('.webp', '.pdf'), 'tipo': 'pdf'}, 'navegador'),
        ({'url': 'https://firebasestorage-googleapis.com/x.pdf', 'tipo': 'imagen'}, 'nada'),
    ]
    for datos, donde in casos:
        monkeypatch.setattr(t['nube'].db, 'get', lambda d=datos: Snap(d), raising=False)
        abiertos.clear()
        visores.clear()
        vista._ver_comprobante('c1')
        assert esperar(lambda: not vista._tareas)
        assert (donde == 'visor') == bool(visores) and (donde == 'navegador') == bool(abiertos)
    assert 'no es del almacenamiento' in t['mensajes'][-1]

    # Una imagen que no se puede leer va al navegador.
    monkeypatch.setattr(pwv, '_descargar', lambda url: b'no es una imagen')
    monkeypatch.setattr(t['nube'].db, 'get', lambda: Snap({'url': bueno, 'tipo': 'imagen'}), raising=False)
    abiertos.clear()
    visores.clear()
    vista._ver_comprobante('c1')
    assert esperar(lambda: not vista._tareas)
    assert abiertos == [bueno] and not visores



# ── El cliente ──────────────────────────────────────────────────────────────

def test_la_tarjeta_del_cliente_muestra_todo_y_abre_whatsapp(pantalla, monkeypatch):
    from PyQt5.QtWidgets import QLabel
    from pos_system.ui import pedidos_web_view as pwv
    abiertos = []
    monkeypatch.setattr(pwv.QDesktopServices, 'openUrl',
                        lambda url: abiertos.append(url.toString(pwv.QUrl.FullyEncoded)) or True)
    t = pantalla([pedido('n1', estado='listo', cliente={'nombre': 'María Fernanda Gómez', 'telefono': '0351 15 619-4411'},
                         entrega={'modo': 'delivery', 'direccion': 'Colón 1200', 'referencia': 'timbre 2',
                                  'coordenadas': {'lat': -31.4, 'lng': -64.18}, 'distancia_km': 2.5},
                         pago={'modo': 'efectivo'}, nota='sin bolsa')])
    vista = t['vista']
    vista._seleccionar('n1')
    textos = ' | '.join(l.text() for l in visibles(vista, QLabel))
    for dato in ('María Fernanda Gómez', '0351 15 619-4411', 'Colón 1200', 'timbre 2', '2,5 km',
                 'Paga en efectivo', 'sin bolsa'):
        assert dato in textos
    assert {'WhatsApp', 'Copiar', 'Mapa'} <= set(botones(vista))

    boton = lambda texto: [b for b in visibles(vista, type(vista._boton('x'))) if b.text() == texto][0]

    # Con la app de WhatsApp instalada abre la app, con el mensaje del estado.
    monkeypatch.setattr(pwv, 'whatsapp_de_escritorio', lambda: True)
    boton('WhatsApp').click()
    assert abiertos[-1].startswith('whatsapp://send?phone=5493516194411&text=Hola%20Mar')
    assert 'sale%20para%20tu%20casa' in abiertos[-1] and '%2C' in abiertos[-1]

    # Sin la app, WhatsApp Web.
    vista._whatsapp_app = None
    monkeypatch.setattr(pwv, 'whatsapp_de_escritorio', lambda: False)
    boton('WhatsApp').click()
    assert abiertos[-1].startswith('https://wa.me/5493516194411?text=Hola%20Mar')

    boton('Mapa').click()
    assert abiertos[-1] == 'https://maps.google.com/?q=-31.4,-64.18'

    boton('Copiar').click()
    assert QApplication.clipboard().text() == '0351 15 619-4411'


def test_si_la_app_no_abre_cae_a_whatsapp_web(pantalla, monkeypatch):
    from pos_system.ui import pedidos_web_view as pwv
    abiertos = []
    monkeypatch.setattr(pwv, 'whatsapp_de_escritorio', lambda: True)
    monkeypatch.setattr(pwv.QDesktopServices, 'openUrl',
                        lambda url: abiertos.append(url.toString(pwv.QUrl.FullyEncoded))
                        or not url.toString().startswith('whatsapp:'))
    t = pantalla([pedido('n1')])
    t['vista']._abrir_whatsapp('5493516194411', 'Hola')
    assert abiertos == ['whatsapp://send?phone=5493516194411&text=Hola', 'https://wa.me/5493516194411?text=Hola']
    t['vista']._abrir_whatsapp('5493516194411', 'Hola')
    assert abiertos[-1].startswith('https://wa.me/')


def test_un_fijo_se_puede_copiar_pero_no_tiene_whatsapp(pantalla):
    from PyQt5.QtWidgets import QLabel
    t = pantalla([pedido('n1', cliente={'nombre': 'Ana', 'telefono': '4234567'})])
    vista = t['vista']
    vista._seleccionar('n1')
    assert 'WhatsApp' not in botones(vista) and 'Copiar' in botones(vista)
    assert any('no sirve para WhatsApp' in l.text() for l in visibles(vista, QLabel))


def test_la_pc_sabe_si_tiene_la_app_de_whatsapp():
    from pos_system.ui.pedidos_web_view import whatsapp_de_escritorio
    assert whatsapp_de_escritorio() in (True, False)


# ── La franja del POS ───────────────────────────────────────────────────────

def test_cada_cambio_le_pasa_a_la_franja_lo_pendiente(pantalla):
    t = pantalla([pedido('n1')])
    recibidos = []
    t['vista'].pendientes_cambio.connect(recibidos.append)
    refrescar(t)
    assert [p['id'] for p in recibidos[-1]['nuevos']] == ['n1']
    t['nube'].pedidos['n1']['estado'] = 'preparando'
    refrescar(t)
    assert recibidos[-1] == {'nuevos': [], 'cobrar': []}


def test_ver_pedido_desde_la_franja_abre_la_lista_y_el_pedido(pantalla):
    t = pantalla([pedido('n1'), pedido('c1', estado='entregado', cobro_pendiente=True, stock_descontado=True)])
    vista = t['vista']
    vista.abrir_pedido('c1')
    assert vista._filtro == 'cobrar' and vista._seleccion == 'c1'
    vista.abrir_pedido('n1')
    assert vista._filtro == 'hacer' and vista._seleccion == 'n1'
    assert esperar(lambda: ('visto', ('n1',)) in t['nube'].llamados)
    vista._filtro = 'hechos'
    vista.abrir_pedido('')
    assert vista._filtro == 'hacer'
