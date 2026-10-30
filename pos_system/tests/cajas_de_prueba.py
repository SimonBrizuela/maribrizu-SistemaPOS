"""
Varias cajas del POS en el mismo proceso, cada una con su base SQLite, su
pc_id, su nombre y su cajero, para probar "traer la venta de otra caja".

Cada caja es la pantalla de Ventas de verdad (`SalesView`). Lo único que se
reemplaza es lo que espera a una persona: la pantalla de cobro (`PagoFalso`)
y las preguntas de sí/no.

Las bases tienen los mismos productos con ids locales DISTINTOS (como pasa en
el local: cada PC numera a su manera) y el mismo `firebase_id`.
"""
import os
import sys
import time
from contextlib import contextmanager

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from PyQt5.QtWidgets import QApplication, QDialog  # noqa: E402

PRODUCTOS = [
    # nombre, precio, stock, código, firebase_id
    ('CUADERNO RIVADAVIA 50 HOJAS', 3500, 20, '7790001', 'fb-cuaderno'),
    ('BIROME BIC AZUL', 800, 50, '7790002', 'fb-birome'),
    ('HILO DE COSER NEGRO', 1200, 30, '7790003', 'fb-hilo'),
    ('BOTONES NACARADOS X 6', 950, 25, '7790004', 'fb-botones'),
]


def crear_base(ruta, corrimiento=0):
    """Base de una caja con la caja abierta. `corrimiento` mete productos de
    relleno antes para que los ids locales no coincidan entre cajas."""
    from pos_system.database.db_manager import DatabaseManager
    from pos_system.models.cash_register import CashRegister
    from pos_system.models.user import User
    base = DatabaseManager(str(ruta))
    base.initialize_database()
    User(base).ensure_default_admin()
    for n in range(corrimiento):
        base.execute_update(
            "INSERT INTO products (name, price, cost, stock, category, barcode, firebase_id) "
            "VALUES (?, 100, 50, 1, 'RELLENO', ?, ?)", (f'RELLENO {n}', f'R{n}', f'fb-relleno-{n}'))
    for nombre, precio, stock, codigo, fid in PRODUCTOS:
        base.execute_update(
            "INSERT INTO products (name, price, cost, stock, category, barcode, firebase_id) "
            "VALUES (?, ?, ?, ?, 'LIBRERIA', ?, ?)", (nombre, precio, precio * 0.6, stock, codigo, fid))
    CashRegister(base).open_register(initial_amount=1000.0)
    return base


def producto(base, firebase_id):
    filas = base.execute_query("SELECT * FROM products WHERE firebase_id = ?", (firebase_id,))
    return dict(filas[0])


def stock(base, firebase_id):
    return producto(base, firebase_id)['stock']


def sin_firebase():
    """La pantalla de Ventas arranca Firebase en otro hilo: en una prueba sería
    escribir contra la base del local."""
    import pos_system.utils.firebase_sync as fs
    fs.init_firebase_sync = lambda: None
    fs.get_firebase_sync = lambda: None


@contextmanager
def _base_fija(base):
    import pos_system.database.db_manager as dbm
    original = dbm.DatabaseManager

    class _Fija(original):
        def __new__(cls, *a, **k):
            return base
    dbm.DatabaseManager = _Fija
    try:
        yield
    finally:
        dbm.DatabaseManager = original


def abrir_caja(base, pc_id, nombre, cajero, rol='cajero', nube=None, espera_entrega=None):
    """La pantalla de Ventas de una caja, conectada a `nube` (si se pasa).
    Con el doble en memoria, cada caja usa su propia conexión (`nube.para`),
    para poder dejar a una sola sin internet."""
    from pos_system.ui.sales_view import SalesView
    usuario = {'id': 1, 'username': cajero.lower(), 'role': rol,
               'full_name': cajero, 'turno_nombre': cajero}
    with _base_fija(base):
        vista = SalesView(None, current_user=usuario, pc_id=pc_id)
    vista._nombre_caja = lambda: nombre
    vista.carrito_compartido._debounce.setInterval(20)
    if espera_entrega is not None:
        vista.carrito_compartido.espera_entrega_seg = espera_entrega
    vista.resize(1100, 700)
    if nube is not None:
        conexion = nube.para(pc_id) if hasattr(nube, 'para') else nube
        vista.carrito_compartido.conectar(conexion)
    return vista


def esperar(condicion, segundos=10):
    app = QApplication.instance()
    fin = time.time() + segundos
    while time.time() < fin:
        app.processEvents()
        if condicion():
            return True
        time.sleep(0.01)
    app.processEvents()
    return condicion()


def asentar(segundos=0.3):
    """Deja correr el debounce, el hilo de la nube y las escuchas."""
    esperar(lambda: False, segundos)


class PagoFalso(QDialog):
    """La pantalla de cobro, pagada en efectivo justo."""

    def __init__(self, parent=None, total=0.0, cart=None):
        super().__init__(parent)
        self.total = total
        self.payment_type = 'cash'
        self.payment_subtype = None
        self.cash_received = total
        self.change_given = 0.0
        self.transfer_amount = 0.0
        self.selected_profile = None
        self.selected_cliente = None
        self.nota_factura = ''

    def exec_(self):
        return QDialog.Accepted


@contextmanager
def cobro_sin_preguntas():
    """Cobrar sin ventanas: pago en efectivo, sin ticket."""
    import pos_system.ui.sales_view as sv
    from PyQt5.QtWidgets import QMessageBox
    pago, pregunta = sv.PaymentDialog, sv.QMessageBox.question
    sv.PaymentDialog = PagoFalso
    sv.QMessageBox.question = staticmethod(lambda *a, **k: QMessageBox.No)
    try:
        yield
    finally:
        sv.PaymentDialog = pago
        sv.QMessageBox.question = pregunta


@contextmanager
def avisos_capturados():
    """Los QMessageBox de información y advertencia, anotados en vez de abiertos."""
    import pos_system.ui.sales_view as sv
    vistos = []
    orig = sv.QMessageBox.information, sv.QMessageBox.warning
    sv.QMessageBox.information = staticmethod(lambda _p, t, m, *a, **k: vistos.append((t, m)))
    sv.QMessageBox.warning = staticmethod(lambda _p, t, m, *a, **k: vistos.append((t, m)))
    try:
        yield vistos
    finally:
        sv.QMessageBox.information, sv.QMessageBox.warning = orig


def ventas(base):
    return [dict(r) for r in base.execute_query("SELECT * FROM sales ORDER BY id") or []]
