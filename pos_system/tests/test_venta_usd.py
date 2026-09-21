"""
Vender un producto que se compra en dolares, en la caja de verdad.

Se arma la pantalla de Ventas contra una base temporal, se agrega el producto
como lo haria el cajero y se mira lo que queda en el carrito: el precio en
pesos del dia, el cartelito con la cuenta y la marca de a cuanto estaba el
dolar (que despues viaja al historial).

Lo que mas importa esta al final: que la caja siga vendiendo cuando no hay
internet. Un producto en dolares tiene que cobrarse igual, con el ultimo precio
que bajo del catalogo, y decirlo.

Corre sin pantalla (`QT_QPA_PLATFORM=offscreen`).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

pytest.importorskip('PyQt5.QtWidgets', reason='el POS necesita PyQt5')

from PyQt5.QtWidgets import QApplication  # noqa: E402

from pos_system.database.db_manager import DatabaseManager  # noqa: E402
from pos_system.models.cash_register import CashRegister  # noqa: E402
from pos_system.models.user import User  # noqa: E402
from pos_system.utils import cotizacion_usd as cot_mod  # noqa: E402

DOLAR = 1550.0

_ABIERTAS = []


@pytest.fixture(autouse=True)
def sin_firebase_de_verdad(monkeypatch):
    """La vista de Ventas arranca la conexion a Firebase en otro hilo. En una
    prueba eso seria escribir contra la base del local."""
    import pos_system.utils.firebase_sync as fs
    monkeypatch.setattr(fs, 'init_firebase_sync', lambda: None)
    monkeypatch.setattr(fs, 'get_firebase_sync', lambda: None)


@pytest.fixture(scope='module')
def app():
    aplicacion = QApplication.instance() or QApplication([])
    yield aplicacion
    _ABIERTAS.clear()
    aplicacion.processEvents()


@pytest.fixture(scope='module')
def local(tmp_path_factory):
    """Un local con tres productos: uno en pesos, uno en dolares y un rollo."""
    ruta = str(tmp_path_factory.mktemp('pos_usd') / 'ventas.db')
    base = DatabaseManager(ruta)
    base.initialize_database()

    import pos_system.database.db_manager as dbm
    original = dbm.DatabaseManager

    class BaseDePrueba(original):
        def __new__(cls, *a, **k):
            return base

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

    # En pesos, de toda la vida.
    base.execute_update(
        """INSERT INTO products (name, price, cost, stock, category, barcode)
           VALUES ('CUADERNO RIVADAVIA', 3500, 2100, 20, 'LIBRERIA', '7790001')"""
    )
    # En dolares. El precio en pesos guardado es de una cotizacion vieja (1400).
    base.execute_update(
        """INSERT INTO products (name, price, cost, stock, category, barcode,
                                 moneda_costo, costo_usd, precio_usd)
           VALUES ('ARGOLLITAS DE PLATA', 49000, 14000, 5, 'ACCESORIOS',
                   '988155', 'USD', 10, 35)"""
    )
    # En dolares y fraccionado: un rollo de 50 m a U$S 1,20 el metro.
    base.execute_update(
        """INSERT INTO products (name, price, cost, stock, category, barcode,
                                 moneda_costo, costo_usd, precio_usd,
                                 conjunto_precio_unidad_usd,
                                 es_conjunto, conjunto_tipo, conjunto_unidad_medida,
                                 conjunto_contenido, conjunto_unidades,
                                 conjunto_restante, conjunto_total,
                                 conjunto_precio_unidad)
           VALUES ('CINTA IMPORTADA', 70000, 28000, 2, 'MERCERIA', '988200',
                   'USD', 20, 50, 1.2,
                   1, 'rollo', 'metros', 50, 2, 0, 100, 1680)"""
    )

    filas = base.execute_query("SELECT * FROM products WHERE id != 0 ORDER BY id")
    datos = {
        'db': base,
        'admin': admin,
        'pesos': dict(filas[0]),
        'usd': dict(filas[1]),
        'rollo': dict(filas[2]),
    }
    yield datos

    for mod in pisados:
        mod.DatabaseManager = original


@pytest.fixture
def dolar():
    """La cotizacion, con un valor puesto a mano y sin salir a internet."""
    cot_mod._resetear_para_pruebas()
    c = cot_mod.get_cotizacion()
    c._guardar(DOLAR, 'dolarapi', 'blue')
    yield c
    cot_mod._resetear_para_pruebas()


@pytest.fixture
def sin_dolar():
    """Ninguna cotizacion: ni en memoria, ni en la nube, ni en internet."""
    cot_mod._resetear_para_pruebas()
    c = cot_mod.get_cotizacion()
    c._leer_de_la_nube = lambda: None
    c._pedir_a_la_api = lambda tipo, timeout: None
    yield c
    cot_mod._resetear_para_pruebas()


@pytest.fixture
def ventas(app, local):
    """La pantalla de Ventas, armada de verdad."""
    from pos_system.ui.sales_view import SalesView
    v = SalesView(None, current_user=local['admin'])
    v.show()
    app.processEvents()
    _ABIERTAS.append(v)
    yield v
    v.cart.clear()
    v.close()
    app.processEvents()


def _cartel(vista):
    lbl = vista._usd_hint_lbl
    return lbl.text() if lbl.isVisible() else ''


class TestElPrecioQueSeCobra:
    def test_un_producto_en_dolares_entra_al_precio_de_hoy(self, app, ventas, local, dolar):
        # Guardado tiene $49.000 (dolar a 1.400). Hoy esta a 1.550:
        # U$S 35 x 1.550 = 54.250 -> $54.300 a la centena.
        ventas.add_to_cart(dict(local['usd']))
        app.processEvents()

        assert len(ventas.cart) == 1
        assert ventas.cart[0]['unit_price'] == 54300
        assert ventas.cart[0]['subtotal'] == 54300

    def test_uno_en_pesos_no_cambia_nada(self, app, ventas, local, dolar):
        ventas.add_to_cart(dict(local['pesos']))
        app.processEvents()

        assert ventas.cart[0]['unit_price'] == 3500
        assert _cartel(ventas) == ''          # ni cartel se muestra

    def test_el_cartel_muestra_la_cuenta_hecha(self, app, ventas, local, dolar):
        ventas.add_to_cart(dict(local['usd']))
        app.processEvents()

        texto = _cartel(ventas)
        assert 'U$S 35' in texto
        assert '1,550' in texto or '1.550' in texto
        assert '54,300' in texto or '54.300' in texto

    def test_el_renglon_se_lleva_a_cuanto_estaba_el_dolar(self, app, ventas, local, dolar):
        # Sin esto no hay forma de reconstruir el margen de una venta vieja.
        ventas.add_to_cart(dict(local['usd']))
        app.processEvents()

        assert ventas.cart[0]['usd_cotizacion'] == DOLAR
        assert ventas.cart[0]['usd_precio'] == 35
        assert ventas.cart[0]['usd_costo'] == 10

    def test_el_de_pesos_no_se_lleva_ninguna_marca(self, app, ventas, local, dolar):
        ventas.add_to_cart(dict(local['pesos']))
        app.processEvents()
        assert 'usd_cotizacion' not in ventas.cart[0]

    def test_sumar_otra_unidad_mantiene_el_precio_del_dia(self, app, ventas, local, dolar):
        producto = dict(local['usd'])
        ventas.add_to_cart(producto)
        ventas.add_to_cart(producto)
        app.processEvents()

        assert len(ventas.cart) == 1
        assert ventas.cart[0]['quantity'] == 2
        assert ventas.cart[0]['unit_price'] == 54300
        assert ventas.cart[0]['subtotal'] == 108600

    def test_si_el_dolar_sube_el_proximo_entra_mas_caro(self, app, ventas, local, dolar):
        ventas.add_to_cart(dict(local['usd']))
        app.processEvents()
        assert ventas.cart[0]['unit_price'] == 54300

        dolar._guardar(1600, 'dolarapi', 'blue')
        ventas.cart.clear()
        ventas.add_to_cart(dict(local['usd']))
        app.processEvents()
        assert ventas.cart[0]['unit_price'] == 56000      # 35 x 1600

    def test_el_producto_que_entro_no_se_modifica(self, app, ventas, local, dolar):
        # La fila viene del catalogo local; si se la tocara, el precio viejo
        # quedaria escrito en memoria y el proximo calculo saldria de ahi.
        producto = dict(local['usd'])
        ventas.add_to_cart(producto)
        app.processEvents()
        assert producto['price'] == 49000


class TestSinInternet:
    """Lo mas importante de todo: la caja sigue vendiendo."""

    def test_se_cobra_el_ultimo_precio_que_bajo(self, app, ventas, local, sin_dolar):
        ventas.add_to_cart(dict(local['usd']))
        app.processEvents()

        assert len(ventas.cart) == 1
        assert ventas.cart[0]['unit_price'] == 49000      # el del catalogo
        assert ventas.cart[0]['subtotal'] == 49000

    def test_y_el_cartel_lo_dice(self, app, ventas, local, sin_dolar):
        ventas.add_to_cart(dict(local['usd']))
        app.processEvents()
        assert 'No se pudo averiguar' in _cartel(ventas)

    def test_el_renglon_no_miente_sobre_la_cotizacion(self, app, ventas, local, sin_dolar):
        ventas.add_to_cart(dict(local['usd']))
        app.processEvents()
        assert 'usd_cotizacion' not in ventas.cart[0]

    def test_uno_en_pesos_no_se_entera_de_nada(self, app, ventas, local, sin_dolar):
        ventas.add_to_cart(dict(local['pesos']))
        app.processEvents()
        assert ventas.cart[0]['unit_price'] == 3500
        assert _cartel(ventas) == ''


class TestConLaCotizacionVieja:
    def test_se_espera_y_se_cobra_con_la_nueva(self, app, ventas, local, monkeypatch):
        """La cotizacion vencio: se sale a buscarla antes de poner el precio."""
        cot_mod._resetear_para_pruebas()
        c = cot_mod.get_cotizacion()
        c._guardar(1400, 'dolarapi', 'blue', ts=1.0)      # de 1970, bien vieja
        c._leer_de_la_nube = lambda: None
        c._pedir_a_la_api = lambda tipo, timeout: {'valor': DOLAR, 'tipo': tipo}
        c._subir_a_la_nube = lambda v, t: True
        try:
            ventas.add_to_cart(dict(local['usd']))
            app.processEvents()
            assert ventas.cart[0]['unit_price'] == 54300
        finally:
            cot_mod._resetear_para_pruebas()

    def test_si_no_contesta_nadie_se_cobra_lo_ultimo_conocido(self, app, ventas, local):
        cot_mod._resetear_para_pruebas()
        c = cot_mod.get_cotizacion()
        c._guardar(1400, 'dolarapi', 'blue', ts=1.0)
        c._leer_de_la_nube = lambda: None
        c._pedir_a_la_api = lambda tipo, timeout: None
        try:
            ventas.add_to_cart(dict(local['usd']))
            app.processEvents()
            # 35 x 1400 = 49.000: viejo, pero es el ultimo dolar que se supo.
            assert ventas.cart[0]['unit_price'] == 49000
            assert 'hace un rato' in _cartel(ventas)
        finally:
            cot_mod._resetear_para_pruebas()


class TestElRolloEnDolares:
    """Un producto fraccionado: el rollo entero y el metro suelto."""

    def test_el_precio_del_metro_sale_de_los_dolares(self, app, ventas, local, dolar):
        # U$S 1,20 el metro x 1.550 = $1.860. Guardado tenia 1.680.
        convertido = ventas._producto_con_precio_del_dia(dict(local['rollo']))
        assert convertido['conjunto_precio_unidad'] == 1860
        assert convertido['price'] == 77500          # 50 x 1.550

    def test_el_precio_por_metro_no_se_redondea_a_la_centena(self, app, ventas, local, dolar):
        # Redondear el metro a la centena lo subiria de $1.860 a $1.900: un 2%
        # en cada metro. La centena es para el precio del rollo entero.
        convertido = ventas._producto_con_precio_del_dia(dict(local['rollo']))
        assert convertido['conjunto_precio_unidad'] % 100 != 0

    def test_el_dialogo_del_rollo_abre_con_el_precio_del_dia(self, app, ventas, local, dolar):
        from pos_system.ui.conjunto_dialog import ConjuntoDialog
        convertido = ventas._producto_con_precio_del_dia(dict(local['rollo']))
        dlg = ConjuntoDialog(convertido, parent=None)
        _ABIERTAS.append(dlg)
        dlg.show()
        app.processEvents()
        try:
            assert dlg.precio_unidad == 1860
        finally:
            dlg.close()
            app.processEvents()

    def test_sin_cotizacion_el_rollo_se_vende_con_lo_ultimo_que_bajo(self, app, ventas, local, sin_dolar):
        convertido = ventas._producto_con_precio_del_dia(dict(local['rollo']))
        assert convertido['conjunto_precio_unidad'] == 1680
        assert convertido['price'] == 70000


class TestLasListasDeLaPantalla:
    """El precio que se ve en la lista tiene que ser el que se cobra."""

    def test_la_grilla_muestra_el_precio_del_dia(self, app, ventas, local, dolar):
        # Antes se veia $49.000 en la lista y el carrito decia $54.300: el
        # mismo producto con dos precios en la misma pantalla.
        ventas._populate_products_table([dict(local['usd']), dict(local['pesos'])])
        app.processEvents()

        texto = ' | '.join(
            ventas.products_table.item(f, c).text()
            for f in range(ventas.products_table.rowCount())
            for c in range(ventas.products_table.columnCount())
            if ventas.products_table.item(f, c)
        )
        assert '54300' in texto
        assert '49000' not in texto
        assert '3500' in texto           # el de pesos, intacto

    def test_sin_cotizacion_la_grilla_muestra_lo_ultimo_conocido(self, app, ventas, local, sin_dolar):
        ventas._populate_products_table([dict(local['usd'])])
        app.processEvents()
        texto = ' | '.join(
            ventas.products_table.item(f, c).text()
            for f in range(ventas.products_table.rowCount())
            for c in range(ventas.products_table.columnCount())
            if ventas.products_table.item(f, c)
        )
        assert '49000' in texto

    def test_la_fila_guarda_el_producto_ya_convertido(self, app, ventas, local, dolar):
        # De esa fila sale el producto al carrito: si guardara el viejo, el
        # precio volveria a bajar al agregarlo.
        ventas._populate_products_table([dict(local['usd'])])
        app.processEvents()
        from PyQt5.QtCore import Qt
        guardado = ventas.products_table.item(0, 0).data(Qt.UserRole)
        assert guardado['price'] == 54300


class TestLaFichaDelPos:
    """La pestaña Productos del POS no edita en pesos lo que se compra en dolares."""

    def test_el_precio_queda_de_solo_lectura_y_lo_explica(self, app, local, dolar):
        from pos_system.ui.products_view import ProductDialog
        dlg = ProductDialog(None, dict(local['usd']))
        _ABIERTAS.append(dlg)
        dlg.show()
        app.processEvents()
        try:
            assert dlg.price_input.isReadOnly()
            assert dlg.cost_input.isReadOnly()
            texto = ' '.join(
                w.text() for w in dlg.findChildren(__import__(
                    'PyQt5.QtWidgets', fromlist=['QLabel']).QLabel)
            )
            assert 'dolares' in texto.lower()
            assert 'U$S 35' in texto
        finally:
            dlg.close()
            app.processEvents()

    def test_en_un_producto_en_pesos_se_edita_como_siempre(self, app, local, dolar):
        from pos_system.ui.products_view import ProductDialog
        dlg = ProductDialog(None, dict(local['pesos']))
        _ABIERTAS.append(dlg)
        dlg.show()
        app.processEvents()
        try:
            assert not dlg.price_input.isReadOnly()
            assert dlg.price_input.value() == 3500
        finally:
            dlg.close()
            app.processEvents()
