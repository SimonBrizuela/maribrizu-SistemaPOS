"""
Marcar un producto en dolares desde el panel y que la caja se entere.

Las otras pruebas del dolar cortan la cadena en algun lado: la cuenta sola, la
pantalla con una nube falsa, el carrito con la cotizacion puesta a mano. Esta
arma la cadena entera contra un Firestore de verdad (el emulador):

    el panel escribe el producto en `catalogo` con moneda_costo: USD
        -> el POS lo baja (al abrir, y con el POS ya abierto)
        -> queda en el SQLite de la caja con sus precios en dolares
        -> el buscador lo muestra al precio de hoy
        -> se vende a ese precio

Y la cotizacion viaja por el mismo camino: una caja la deja en
`config/cotizacion_usd` y la otra la lee de ahi sin salir a internet.

Necesita el emulador (Java + firebase-tools). Sin el, se saltea:

    firebase emulators:exec --config pos_system/tests/emulador/firebase.json ^
        --only firestore --project demo-pos-usd ^
        "python -m pytest pos_system/tests/test_usd_emulador.py -q"

El proyecto `demo-*` no existe en Google: aunque algo saliera mal, no hay forma
de que esta prueba escriba en la base del local.
"""
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

EMULADOR = os.environ.get('FIRESTORE_EMULATOR_HOST')
PROYECTO = 'demo-pos-usd'
pytestmark = pytest.mark.skipif(not EMULADOR, reason='sin emulador de Firestore')

pytest.importorskip('PyQt5.QtWidgets')
from PyQt5.QtWidgets import QApplication  # noqa: E402

from pos_system.database.db_manager import DatabaseManager  # noqa: E402
from pos_system.models.cash_register import CashRegister  # noqa: E402
from pos_system.models.user import User  # noqa: E402
from pos_system.utils import cotizacion_usd as cot_mod  # noqa: E402

DOLAR = 1550.0
_ABIERTAS = []


def cliente():
    from google.auth.credentials import AnonymousCredentials
    from google.cloud import firestore
    return firestore.Client(project=PROYECTO, credentials=AnonymousCredentials())


@pytest.fixture(scope='module')
def app():
    yield QApplication.instance() or QApplication([])
    _ABIERTAS.clear()


@pytest.fixture
def nube():
    """Firestore vacio para cada prueba."""
    req = urllib.request.Request(
        f'http://{EMULADOR}/emulator/v1/projects/{PROYECTO}/databases/(default)/documents',
        method='DELETE')
    urllib.request.urlopen(req).close()
    return cliente()


@pytest.fixture
def sync(nube, monkeypatch):
    """El FirebaseSync del POS, apuntando al emulador."""
    from pos_system.utils.firebase_sync import FirebaseSync
    fb = FirebaseSync(nube)
    monkeypatch.setattr('pos_system.utils.firebase_sync.get_firebase_sync', lambda: fb)
    yield fb
    for w in list(getattr(fb, '_listeners', [])):
        try:
            w.unsubscribe()
        except Exception:
            pass


@pytest.fixture(autouse=True)
def datos_aparte(tmp_path, monkeypatch):
    """Los marcadores del sync, en una carpeta temporal.

    El delta sync guarda en `DATA_DIR/last_product_sync.txt` hasta donde bajo,
    y el listener del catalogo hace lo mismo con el suyo. Sin esto, la prueba
    leeria el marcador de la PC del local —y arrancaria creyendo que ya bajo
    todo— y ademas se lo pisaria.
    """
    carpeta = tmp_path / 'datos'
    carpeta.mkdir()
    import pos_system.config as cfg
    monkeypatch.setattr(cfg, 'DATA_DIR', carpeta)
    return carpeta


@pytest.fixture
def caja(tmp_path):
    """El SQLite de una PC del local, vacio."""
    base = DatabaseManager(str(tmp_path / 'caja.db'))
    base.initialize_database()
    User(base).ensure_default_admin()
    return base


def _ahora_iso():
    return datetime.now(timezone.utc).isoformat()


def _producto_en_dolares(extra=None):
    """Lo que escribe el panel al guardar la ficha en dolares.

    Los dos numeros: el de dolares, que manda, y el de pesos, que es el ultimo
    calculado. Es exactamente lo que arma `catalogo.js`.
    """
    d = {
        'nombre': 'ARGOLLITAS CHIQUITAS DE PLATA',
        'codigo': '988155',
        'cod_barra': '988155',
        'rubro': 'ACCESORIOS',
        'categoria': 'AROS',
        'sub_rubro': 'AROS',
        'marca': 'SIN MARCA',
        'proveedor': 'SIN PROVEEDOR',
        'estado': 'activo',
        'stock': 3,
        'moneda_costo': 'USD',
        'costo_usd': 2.67,
        'precio_usd': 9.35,
        'cotizacion_usada': DOLAR,
        # Lo que dio la cuenta cuando se guardo: 9,35 x 1.550 = 14.492 -> 14.500
        'costo': 4138.5,
        'precio_venta': 14500,
        'ultima_actualizacion': datetime.now(timezone.utc),
    }
    d.update(extra or {})
    return d


def esperar(condicion, segundos=20):
    """Espera a que pase algo, procesando los eventos de Qt mientras tanto."""
    aplicacion = QApplication.instance()
    fin = time.time() + segundos
    while time.time() < fin:
        if aplicacion:
            aplicacion.processEvents()
        if condicion():
            return True
        time.sleep(0.15)
    return False


def fila(base, nombre='ARGOLLITAS CHIQUITAS DE PLATA'):
    filas = base.execute_query(
        "SELECT * FROM products WHERE name = ? LIMIT 1", (nombre,)) or []
    return dict(filas[0]) if filas else None


class TestElProductoLlegaALaCaja:
    """La cadena: el panel lo marca en dolares y la caja se entera."""

    def test_al_abrir_el_pos_baja_con_sus_precios_en_dolares(self, nube, sync, caja):
        # El panel guarda la ficha.
        nube.collection('catalogo').document('988155').set(_producto_en_dolares())
        nube.collection('config').document('catalogo_meta').set(
            {'last_updated': _ahora_iso()})

        # La caja arranca.
        listo = {'n': None}
        sync.delta_sync_products_startup(caja, on_done=lambda n: listo.update(n=n))
        assert esperar(lambda: listo['n'] is not None), 'el delta sync no termino'

        p = fila(caja)
        assert p is not None, 'el producto no bajo a la caja'
        assert p['moneda_costo'] == 'USD'
        assert p['costo_usd'] == 2.67
        assert p['precio_usd'] == 9.35
        # Y el precio en pesos, el ultimo calculado, tambien esta.
        assert p['price'] == 14500

    def test_con_el_pos_abierto_el_cambio_llega_solo(self, nube, sync, caja):
        """El caso de todos los dias: la caja ya esta abierta y alguien marca
        el producto en dolares desde el panel."""
        # Primero existe en pesos y la caja lo tiene.
        nube.collection('catalogo').document('988155').set({
            'nombre': 'ARGOLLITAS CHIQUITAS DE PLATA', 'codigo': '988155',
            'cod_barra': '988155', 'rubro': 'ACCESORIOS', 'categoria': 'AROS',
            'estado': 'activo', 'stock': 3, 'costo': 4145, 'precio_venta': 14500,
            'ultima_actualizacion': datetime.now(timezone.utc),
        })
        nube.collection('config').document('catalogo_meta').set(
            {'last_updated': _ahora_iso()})
        listo = {'n': None}
        sync.delta_sync_products_startup(caja, on_done=lambda n: listo.update(n=n))
        assert esperar(lambda: listo['n'] is not None)
        assert fila(caja)['moneda_costo'] is None

        # Se prende el listener, como cuando el POS queda abierto.
        sync.start_stock_sync_listener(caja)

        # El panel lo pasa a dolares.
        nube.collection('catalogo').document('988155').update({
            'moneda_costo': 'USD', 'costo_usd': 2.67, 'precio_usd': 9.35,
            'ultima_actualizacion': datetime.now(timezone.utc),
        })

        assert esperar(lambda: (fila(caja) or {}).get('moneda_costo') == 'USD'), \
            'el cambio a dolares no llego a la caja'
        p = fila(caja)
        assert p['precio_usd'] == 9.35
        assert p['costo_usd'] == 2.67

    def test_volver_a_pesos_tambien_llega(self, nube, sync, caja):
        """Al revés: se desmarca en el panel y la caja tiene que olvidarse.

        Si el `precio_usd` quedara dado vuelta en la caja, seguiria
        recalculando el precio con el dolar y pisaria el que se cargo a mano.
        """
        nube.collection('catalogo').document('988155').set(_producto_en_dolares())
        nube.collection('config').document('catalogo_meta').set(
            {'last_updated': _ahora_iso()})
        listo = {'n': None}
        sync.delta_sync_products_startup(caja, on_done=lambda n: listo.update(n=n))
        assert esperar(lambda: listo['n'] is not None)
        assert fila(caja)['moneda_costo'] == 'USD'

        sync.start_stock_sync_listener(caja)
        nube.collection('catalogo').document('988155').update({
            'moneda_costo': None, 'costo_usd': None, 'precio_usd': None,
            'precio_venta': 15000, 'costo': 4300,
            'ultima_actualizacion': datetime.now(timezone.utc),
        })

        assert esperar(lambda: (fila(caja) or {}).get('moneda_costo') is None), \
            'la caja siguio pensando que era en dolares'
        p = fila(caja)
        assert p['precio_usd'] is None
        assert p['price'] == 15000


class TestLaCotizacionViajaIgual:
    """Una caja la consigue y la otra la lee, sin salir a internet."""

    @pytest.fixture(autouse=True)
    def limpio(self):
        cot_mod._resetear_para_pruebas()
        yield
        cot_mod._resetear_para_pruebas()

    def test_la_segunda_caja_la_toma_de_la_nube(self, nube, sync, caja, monkeypatch):
        # La primera caja sale a internet y la deja escrita.
        primera = cot_mod.CotizacionUSD()
        monkeypatch.setattr(primera, '_pedir_a_la_api',
                            lambda tipo, timeout: {'valor': DOLAR, 'tipo': tipo})
        assert primera.refrescar() is True
        assert nube.collection('config').document('cotizacion_usd').get().to_dict()['valor'] == DOLAR

        # La segunda no tiene internet: la lee del documento compartido.
        segunda = cot_mod.CotizacionUSD()
        segunda._db = caja
        monkeypatch.setattr(segunda, '_pedir_a_la_api',
                            lambda tipo, timeout: pytest.fail('no tenia que salir a internet'))
        datos = segunda._leer_de_la_nube()
        assert datos is not None
        segunda._tomar_de_la_nube(datos)

        assert segunda.valor() == DOLAR
        assert segunda.estado()['fuente'] == 'otra PC'
        assert segunda._vencida_para_la_api() is False
        # Y le queda guardada en su propia base, para arrancar sin internet.
        guardado = caja.execute_query(
            "SELECT value FROM config WHERE key = 'cotizacion_usd_valor'")
        assert float(guardado[0]['value']) == DOLAR

    def test_el_valor_a_mano_del_panel_manda_en_las_cajas(self, nube, sync, caja):
        # El dueño lo fija desde el panel.
        nube.collection('config').document('cotizacion_usd').set({
            'valor': 1700, 'tipo': 'manual', 'fuente': 'a mano', 'manual': True,
            'actualizado': _ahora_iso(),
        })
        c = cot_mod.CotizacionUSD()
        c._db = caja
        c._tomar_de_la_nube(c._leer_de_la_nube())

        assert c.valor() == 1700
        assert c.estado()['manual'] is True
        assert c.esta_fresca() is True          # lo que fija el dueño no vence


class TestBuscarloYVenderlo:
    """Lo ultimo de la cadena: el cajero lo busca y lo cobra."""

    @pytest.fixture
    def ventas(self, app, nube, sync, caja, monkeypatch):
        """La pantalla de Ventas de esa caja, con el producto ya bajado."""
        nube.collection('catalogo').document('988155').set(_producto_en_dolares())
        nube.collection('catalogo').document('7790001').set({
            'nombre': 'CUADERNO RIVADAVIA 48 HOJAS', 'codigo': '7790001',
            'cod_barra': '7790001', 'rubro': 'LIBRERIA', 'categoria': 'CUADERNOS',
            'estado': 'activo', 'stock': 20, 'costo': 2100, 'precio_venta': 3500,
            'ultima_actualizacion': datetime.now(timezone.utc),
        })
        nube.collection('config').document('catalogo_meta').set(
            {'last_updated': _ahora_iso()})
        nube.collection('config').document('cotizacion_usd').set({
            'valor': DOLAR, 'tipo': 'blue', 'fuente': 'dolarapi', 'manual': False,
            'actualizado': _ahora_iso(),
        })

        listo = {'n': None}
        sync.delta_sync_products_startup(caja, on_done=lambda n: listo.update(n=n))
        assert esperar(lambda: listo['n'] is not None)

        # La caja consigue el dolar del documento compartido, sin internet.
        cot_mod._resetear_para_pruebas()
        c = cot_mod.get_cotizacion()
        c._db = caja
        monkeypatch.setattr(c, '_pedir_a_la_api',
                            lambda tipo, timeout: pytest.fail('no tenia que salir a internet'))
        c._tomar_de_la_nube(c._leer_de_la_nube())
        assert c.valor() == DOLAR

        import pos_system.database.db_manager as dbm
        original = dbm.DatabaseManager

        class BaseDePrueba(original):
            def __new__(cls, *a, **k):
                return caja

        pisados = [dbm]
        dbm.DatabaseManager = BaseDePrueba
        for mod in list(sys.modules.values()):
            if (mod and getattr(mod, '__name__', '').startswith('pos_system')
                    and getattr(mod, 'DatabaseManager', None) is original):
                mod.DatabaseManager = BaseDePrueba
                pisados.append(mod)

        CashRegister(caja).open_register(initial_amount=1000.0)
        from pos_system.ui.sales_view import SalesView
        v = SalesView(None, current_user=User(caja).get_by_username('admin'))
        v.show()
        app.processEvents()
        _ABIERTAS.append(v)

        yield v

        v.cart.clear()
        v.close()
        app.processEvents()
        for mod in pisados:
            mod.DatabaseManager = original
        cot_mod._resetear_para_pruebas()

    def test_el_buscador_lo_muestra_al_precio_del_dia(self, app, ventas):
        from pos_system.ui.sales_view import SpotlightDialog
        dlg = SpotlightDialog(parent=ventas, db=ventas.db, initial_text='ARGOLL')
        _ABIERTAS.append(dlg)
        dlg.show()
        for _ in range(8):
            app.processEvents()
        try:
            encontrado = [p for p in dlg._results if 'ARGOLLITAS' in (p.get('name') or '')]
            assert encontrado, 'el buscador no lo encontro'
            assert encontrado[0]['moneda_costo'] == 'USD'
            assert encontrado[0]['price'] == 14500      # 9,35 x 1.550
        finally:
            dlg.close()
            app.processEvents()

    def test_se_cobra_ese_precio(self, app, ventas):
        producto = fila(ventas.db)
        ventas.add_to_cart(dict(producto))
        app.processEvents()

        assert ventas.cart[0]['unit_price'] == 14500
        assert ventas.cart[0]['usd_cotizacion'] == DOLAR
        assert ventas.cart[0]['usd_precio'] == 9.35
        assert 'U$S 9.35' in ventas._usd_hint_lbl.text()

    def test_si_el_dolar_sube_el_precio_acompana_sin_tocar_nada(self, app, ventas, nube):
        """Lo que pidio el local: que el precio siga al dolar solo."""
        ventas.add_to_cart(dict(fila(ventas.db)))
        app.processEvents()
        assert ventas.cart[0]['unit_price'] == 14500

        # Otra caja consigue un dolar mas alto y lo deja en el documento.
        nube.collection('config').document('cotizacion_usd').set({
            'valor': 1700, 'tipo': 'blue', 'fuente': 'dolarapi', 'manual': False,
            'actualizado': _ahora_iso(),
        })
        c = cot_mod.get_cotizacion()
        c._tomar_de_la_nube(c._leer_de_la_nube())

        ventas.cart.clear()
        ventas.add_to_cart(dict(fila(ventas.db)))
        app.processEvents()
        # 9,35 x 1.700 = 15.895 -> $15.900 a la centena
        assert ventas.cart[0]['unit_price'] == 15900

    def test_el_producto_en_pesos_no_se_entera_de_nada(self, app, ventas):
        cuaderno = fila(ventas.db, 'CUADERNO RIVADAVIA 48 HOJAS')
        assert cuaderno is not None
        ventas.add_to_cart(dict(cuaderno))
        app.processEvents()

        assert ventas.cart[0]['unit_price'] == 3500
        assert 'usd_cotizacion' not in ventas.cart[0]
        assert ventas._usd_hint_lbl.isVisible() is False
