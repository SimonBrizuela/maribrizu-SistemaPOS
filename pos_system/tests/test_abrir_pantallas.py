"""
Abrir todas las pantallas del POS, de verdad.

Que un archivo compile no dice nada: los diálogos revientan al construirse, no
al importarse. Un campo que cambió de nombre, un producto sin un dato que el
layout da por hecho, un `QSS` global que deja el texto ilegible — todo eso
aparece recién cuando la ventana se arma, y hasta ahora aparecía con el cliente
enfrente.

Esta prueba construye las 12 pestañas y los 15 diálogos del POS contra una base
temporal, los muestra y los cierra. No prueba qué hacen: prueba que se puedan
abrir, que es la falla que más veces llegó al mostrador.

Corre sin pantalla (`QT_QPA_PLATFORM=offscreen`). Si no hay PyQt5, se saltea.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

pytest.importorskip('PyQt5.QtWidgets', reason='el POS necesita PyQt5 para abrir pantallas')

from PyQt5.QtWidgets import QApplication  # noqa: E402

from pos_system.database.db_manager import DatabaseManager  # noqa: E402
from pos_system.models.cash_register import CashRegister  # noqa: E402
from pos_system.models.product import Product  # noqa: E402
from pos_system.models.sale import Sale  # noqa: E402
from pos_system.models.user import User  # noqa: E402


@pytest.fixture(scope='module')
def app():
    """Una sola QApplication para todo el módulo: Qt no admite dos.

    Al terminar se sueltan las pantallas abiertas mientras la aplicación
    todavía está viva, que es el único orden en el que Qt no se queja.
    """
    aplicacion = QApplication.instance() or QApplication([])
    yield aplicacion
    try:
        import matplotlib.pyplot as plt
        plt.close('all')
    except Exception:
        pass
    _ABIERTAS.clear()
    aplicacion.processEvents()


@pytest.fixture(scope='module')
def local(tmp_path_factory):
    """Un local con lo mínimo para que las pantallas tengan algo que mostrar.

    Varias vistas hacen `DatabaseManager()` sin argumentos, que apunta a la base
    real de la PC. Se la cambia por la temporal en todos los módulos que ya la
    importaron, o la prueba escribiría sobre las ventas del local.
    """
    ruta = str(tmp_path_factory.mktemp('pos') / 'pantallas.db')
    base = DatabaseManager(ruta)
    base.initialize_database()

    import pos_system.database.db_manager as dbm
    original = dbm.DatabaseManager

    class BaseDePrueba(original):
        def __new__(cls, *a, **k):
            return base

    # Se anota dónde se pisó para poder devolverlo todo: si queda puesto, las
    # demás pruebas del archivo siguiente reciben ESTA base en vez de la suya y
    # fallan por algo que no tiene que ver con lo que están probando.
    pisados = [dbm]
    dbm.DatabaseManager = BaseDePrueba
    for mod in list(sys.modules.values()):
        if (mod and getattr(mod, '__name__', '').startswith('pos_system')
                and getattr(mod, 'DatabaseManager', None) is original):
            mod.DatabaseManager = BaseDePrueba
            pisados.append(mod)

    User(base).ensure_default_admin()
    admin = User(base).get_by_username('admin')
    CashRegister(base).open_register(initial_amount=1000.0)
    pid = Product(base).create({'name': 'CUADERNO PRUEBA', 'price': 3000.0,
                                'stock': 20, 'category': 'LIBRERIA'})
    sid = Sale(base).create({
        'total_amount': 3000.0, 'payment_type': 'cash', 'cash_received': 3000.0,
        'items': [{'product_id': pid, 'product_name': 'CUADERNO PRUEBA',
                   'quantity': 1, 'unit_price': 3000.0}]})

    datos = {
        'db': base,
        'admin': admin,
        'venta': Sale(base).get_by_id(sid),
        'sale_id': sid,
        'carrito': [{'product_id': pid, 'product_name': 'CUADERNO PRUEBA',
                     'quantity': 2, 'unit_price': 3000.0, 'subtotal': 6000.0,
                     'original_price': 3000.0, 'discount_amount': 0,
                     'discount_type': None, 'promo_id': None}],
        # Un rollo de 25 m: 3 cerrados y 10 sueltos.
        'conjunto': dict(Product(base).get_by_id(pid), es_conjunto=1,
                         conjunto_tipo='rollo', conjunto_unidad_medida='metros',
                         conjunto_contenido=25, conjunto_unidades=3,
                         conjunto_restante=10, conjunto_total=85,
                         conjunto_precio_unidad=200.0),
    }
    yield datos

    for mod in pisados:
        mod.DatabaseManager = original


# Las pantallas abiertas se guardan acá mientras corre el módulo.
#
# Si se las deja al recolector de Python, algunas se destruyen en medio de la
# corrida o después que la QApplication, y ahí Qt se lleva puesto el proceso
# entero: la suite moría con STATUS_STACK_BUFFER_OVERRUN sin ninguna prueba en
# rojo. Sosteniéndolas hasta el final, el orden de destrucción deja de depender
# de la suerte. (Borrarlas a mano con `sip.delete` es peor: Qt sigue teniendo
# punteros a ellas y crashea en el acto.)
_ABIERTAS = []


def destruir(app, w):
    """Cierra la pantalla y la deja guardada hasta que termine el módulo."""
    w.close()
    app.processEvents()
    _ABIERTAS.append(w)


def abrir(app, construir):
    """Arma la pantalla, la muestra, procesa los eventos y la cierra."""
    w = construir()
    w.show()
    app.processEvents()
    destruir(app, w)


# ── Las pestañas ──────────────────────────────────────────────────────────

def pestanas(d):
    from pos_system.ui.cash_view import CashView
    from pos_system.ui.dashboard import DashboardView
    from pos_system.ui.fiados_view import FiadosView
    from pos_system.ui.fiscal_view import FiscalView
    from pos_system.ui.observations_view import ObservationsView
    from pos_system.ui.presupuestos_view import PresupuestosView
    from pos_system.ui.products_view import ProductsView
    from pos_system.ui.promos_readonly_view import PromosReadOnlyView
    from pos_system.ui.promotions_view import PromotionsView
    from pos_system.ui.sales_history_view import SalesHistoryView
    from pos_system.ui.sales_view import SalesView
    from pos_system.ui.users_view import UsersView

    u = d['admin']
    return {
        'Ventas':        lambda: SalesView(None, current_user=u),
        'Caja':          lambda: CashView(None, current_user=u),
        'Historial':     lambda: SalesHistoryView(None),
        'Observaciones': lambda: ObservationsView(None, current_user=u),
        'Presupuestos':  lambda: PresupuestosView(None, current_user=u),
        'Fiados':        lambda: FiadosView(None, current_user=u),
        'Promociones':   lambda: PromosReadOnlyView(None),
        'Productos':     lambda: ProductsView(None),
        'Fiscal AFIP':   lambda: FiscalView(None),
        'Cajeros':       lambda: UsersView(None, current_user=u),
        'Dashboard':     lambda: DashboardView(None),
        'Promos (alta)': lambda: PromotionsView(None),
    }


@pytest.mark.parametrize('nombre', list(pestanas({'admin': {}}).keys()))
def test_la_pestana_abre(app, local, nombre):
    abrir(app, pestanas(local)[nombre])


# ── Los diálogos ──────────────────────────────────────────────────────────

def dialogos(d):
    from pos_system.ui.arca_perfil_dialog import ArcoPerfilDialog
    from pos_system.ui.cliente_perfil_dialog import ClientePerfilDialog
    from pos_system.ui.conjunto_dialog import ConjuntoDialog
    from pos_system.ui.descuento_dialog import DescuentoDialog
    from pos_system.ui.editar_colores_dialog import EditarColoresDialog
    from pos_system.ui.factura_dialog import FacturaDialog
    from pos_system.ui.fiado_dialogs import FiadoClienteDialog, FiadoClientePicker
    from pos_system.ui.fiados_view import MontoDialog
    from pos_system.ui.login_dialog import LoginDialog
    from pos_system.ui.mp_variant_dialog import MPVariantDialog
    from pos_system.ui.nota_credito_dialog import NotaCreditoDialog
    from pos_system.ui.presupuesto_dialog import PresupuestoDialog
    from pos_system.ui.promotions_view import PromoDialog
    from pos_system.ui.sales_history_view import EditSaleDialog
    from pos_system.ui.sales_view import PaymentDialog
    from pos_system.ui.sync_progress_dialog import SyncProgressDialog
    from pos_system.ui.turno_dialog import TurnoDialog

    return {
        'Login':            lambda: LoginDialog(d['db']),
        'Turno':            lambda: TurnoDialog(None, current_user=d['admin']),
        'Cobro':            lambda: PaymentDialog(None, total=6000.0, cart=d['carrito']),
        'Descuento (F6)':   lambda: DescuentoDialog(None, cart=d['carrito']),
        'Editar venta':     lambda: EditSaleDialog(None, sale=d['venta']),
        'Conjunto':         lambda: ConjuntoDialog(d['conjunto']),
        'Editar colores':   lambda: EditarColoresDialog(d['conjunto'], d['db']),
        'Factura':          lambda: FacturaDialog(None, sale=d['venta']),
        'Nota de crédito':  lambda: NotaCreditoDialog({
                                'total': 3000.0, 'tipo': 'C', 'punto_venta': 1,
                                'numero': 1, 'cae': '123', 'sale_id': d['sale_id']}),
        'Perfil ARCA':      lambda: ArcoPerfilDialog(None),
        'Perfil cliente':   lambda: ClientePerfilDialog(None),
        'Presupuesto':      lambda: PresupuestoDialog(None),
        'Variante madre':   lambda: MPVariantDialog({'id': 'p', 'nombre': 'X'}, [], []),
        'Sincronización':   lambda: SyncProgressDialog(None),
        'Promo (alta)':     lambda: PromoDialog(None),
        'Cliente fiado':    lambda: FiadoClienteDialog(None),
        'Buscar cliente':   lambda: FiadoClientePicker(None, db=d['db']),
        'Pago a cuenta':    lambda: MontoDialog(None, titulo='Pago a cuenta'),
    }


@pytest.mark.parametrize('nombre', list(dialogos({
    'db': None, 'admin': {}, 'carrito': [], 'venta': {}, 'conjunto': {}, 'sale_id': 0,
}).keys()))
def test_el_dialogo_abre(app, local, nombre):
    abrir(app, dialogos(local)[nombre])


def test_la_ventana_principal_abre_con_todas_sus_pestanas(app, local, monkeypatch):
    """El POS entero, como lo ve el cajero al entrar.

    Arma la ventana con las diez pestañas adentro de una: es lo que agarra un
    error que sólo aparece cuando conviven, aunque por separado abran bien.

    Se le neutralizan tres cosas que no hacen a lo que se prueba y que sin
    alguien delante dejan el proceso colgado:

      · los listeners de Firebase, el heartbeat de la PC y el escucha de
        comandos remotos;
      · el diálogo de turno, que se abre solo 300 ms después y espera respuesta;
      · el `closeEvent`, que con la caja abierta pregunta "¿seguro que querés
        salir?" en un modal — cerrar la ventana sin nadie que conteste se
        llevaba puesto el proceso entero.
    """
    from pos_system.ui.main_window import MainWindow

    monkeypatch.setattr(MainWindow, '_start_realtime_sync_listeners',
                        lambda self: None, raising=True)
    monkeypatch.setattr(MainWindow, '_prompt_turno', lambda self: None, raising=True)
    monkeypatch.setattr(MainWindow, 'closeEvent',
                        lambda self, ev: ev.accept(), raising=True)

    w = MainWindow(current_user=local['admin'])
    try:
        w.show()
        app.processEvents()
        titulos = [w.tabs.tabText(i) for i in range(w.tabs.count())]
        assert 'Ventas' in titulos
        assert 'Fiados' in titulos
        assert 'Historial' in titulos
        assert 'Presupuestos' in titulos
        # Con un admin se ven también las pestañas restringidas.
        assert 'Productos' in titulos
        assert 'Cajeros' in titulos
        assert 'Fiscal AFIP' in titulos
    finally:
        destruir(app, w)


# ── El caso que motivó todo esto ──────────────────────────────────────────

def test_editar_una_venta_mixta_no_le_cambia_el_medio_de_pago(app, local):
    """El diálogo sólo ofrecía Efectivo y Transferencia: abrir una venta mixta
    y aceptar la convertía en transferencia sin que nadie lo eligiera."""
    from pos_system.ui.sales_history_view import EditSaleDialog

    mixta = dict(local['venta'], payment_type='mixed', total_amount=10000.0,
                 cash_received=4000.0, change_given=0.0, transfer_amount=6000.0)
    dlg = EditSaleDialog(None, sale=mixta)
    try:
        dlg.show()
        app.processEvents()
        assert [dlg.pay_combo.itemText(i) for i in range(dlg.pay_combo.count())] \
            == ['Efectivo', 'Transferencia', 'Mixto']
        assert dlg.pay_combo.currentData() == 'mixed'
        dlg._on_accept()
        assert dlg.new_payment_type == 'mixed'
    finally:
        destruir(app, dlg)
