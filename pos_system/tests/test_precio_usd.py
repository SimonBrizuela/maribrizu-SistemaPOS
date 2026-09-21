"""
Los productos que se compran en dolares, del lado del POS.

`tienda/pruebas/precio_usd.test.js` ya compara esta cuenta con la del panel
sobre los mismos casos. Lo que se prueba aca es lo otro: que el POS pueda
vender un producto en dolares pase lo que pase con la red, que el precio no se
escale al convertir dos veces, y que un producto en pesos no cambie nunca.
"""
import json
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.database.db_manager import DatabaseManager
from pos_system.utils import cotizacion_usd as cot
from pos_system.utils.precio_usd import (
    convertir_producto, convertir_variedad, cotizacion_valida, costo_en_pesos,
    es_usd, precio_desde_costo, precio_en_pesos, precio_unidad_en_pesos,
    redondear_centena, tiene_precios_usd,
)

CASOS = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    'tienda', 'pruebas', 'casos_precio_usd.json',
)


@pytest.fixture
def casos():
    with open(CASOS, encoding='utf-8') as f:
        return json.load(f)


class TestLaCuenta:
    def test_todos_los_casos_compartidos(self, casos):
        """Los mismos casos que corre el panel, del lado de Python."""
        for c in casos['casos']:
            salida = convertir_producto(c['producto'], c.get('cotizacion'))
            for campo, esperado in c['espera'].items():
                assert salida[campo] == esperado, f"{c['que']} → {campo}"

    def test_el_producto_que_entra_no_se_toca(self):
        producto = {
            'moneda_costo': 'USD', 'precio_usd': 35, 'precio_venta': 1,
            'conjunto_colores': [{'color': 'Plata', 'precio_pack_usd': 35, 'precio_pack': 1}],
        }
        antes = json.dumps(producto, sort_keys=True)
        salida = convertir_producto(producto, 1420)
        assert json.dumps(producto, sort_keys=True) == antes
        assert salida['precio_venta'] == 49700
        assert producto['conjunto_colores'][0]['precio_pack'] == 1

    def test_convertir_dos_veces_da_lo_mismo(self, casos):
        """El POS convierte al listar y otra vez al agregar al carrito.

        Si la cuenta se apoyara en el precio en pesos en vez de en el de
        dolares, el precio se iria escalando en cada pasada.
        """
        for c in casos['casos']:
            una = convertir_producto(c['producto'], c.get('cotizacion'))
            dos = convertir_producto(una, c.get('cotizacion'))
            assert dos == una, c['que']

    def test_sin_cotizacion_nunca_queda_en_cero(self):
        """Lo mas importante de todo: que se pueda vender igual."""
        producto = {'moneda_costo': 'USD', 'precio_usd': 35, 'price': 45500}
        for sin_nada in (0, None, '', -1, 'nada', float('nan'), 2_000_000):
            salida = convertir_producto(producto, sin_nada)
            assert salida['price'] == 45500

    def test_no_se_cae_con_basura(self):
        assert convertir_producto(None, 1420) is None
        assert convertir_producto('no es un producto', 1420) == 'no es un producto'
        assert convertir_producto({}, 1420) == {}
        assert convertir_variedad(None, 1420) is None
        assert precio_en_pesos(float('nan'), 1420) == 0
        assert precio_en_pesos(35, float('inf')) == 0
        assert costo_en_pesos(-3, 1420) == 0
        assert precio_unidad_en_pesos(None, 1420) == 0

    def test_una_variedad_que_no_es_un_diccionario_no_rompe(self):
        salida = convertir_producto({
            'moneda_costo': 'USD', 'precio_usd': 35, 'precio_venta': 1,
            'conjunto_colores': [None, 'basura', {'color': 'Plata', 'precio_pack_usd': 35}],
        }, 1420)
        assert salida['conjunto_colores'][0] is None
        assert salida['conjunto_colores'][1] == 'basura'
        assert salida['conjunto_colores'][2]['precio_pack'] == 49700

    def test_el_costo_no_se_redondea_a_la_centena(self):
        """El costo es lo que se paga, no un precio de mostrador."""
        assert costo_en_pesos(2.9057, 1420) == 4126.09
        assert precio_en_pesos(2.9057, 1420) == 4100

    def test_el_precio_por_metro_tampoco(self):
        """Un metro de cinta a $150 pasaria a $200: un 33% mas."""
        assert precio_unidad_en_pesos(0.1056, 1420) == 149.95
        assert precio_en_pesos(0.1056, 1420) == 100

    def test_el_redondeo_empata_para_arriba(self):
        assert redondear_centena(250) == 300
        assert redondear_centena(249.99) == 200
        assert redondear_centena(45) == 50
        assert redondear_centena(4) == 4
        assert redondear_centena(0) == 0
        assert redondear_centena(-5) == 0

    def test_que_producto_esta_en_dolares(self):
        assert es_usd({'moneda_costo': 'USD'})
        assert es_usd({'moneda_costo': ' usd '})
        assert not es_usd({'moneda_costo': 'ARS'})
        assert not es_usd({'costo_usd': 10})
        assert not es_usd(None)

    def test_marcado_pero_sin_nada_cargado(self):
        assert not tiene_precios_usd({'moneda_costo': 'USD'})
        assert tiene_precios_usd({'moneda_costo': 'USD', 'precio_usd': 35})
        assert tiene_precios_usd({'moneda_costo': 'USD', 'costo_usd': 10})
        assert tiene_precios_usd({
            'moneda_costo': 'USD',
            'conjunto_colores': [{'color': 'Plata', 'precio_pack_usd': 35}],
        })
        assert not tiene_precios_usd({'precio_usd': 35})

    def test_el_precio_sale_del_costo_y_el_margen(self, casos):
        for c in casos['precio_desde_costo']:
            assert precio_desde_costo(c['costo_usd'], c['margen']) == c['espera'], c['que']


class TestLaCotizacion:
    """Como consiguen el dolar las cinco PCs del local sin pisarse."""

    @pytest.fixture(autouse=True)
    def limpio(self):
        cot._resetear_para_pruebas()
        yield
        cot._resetear_para_pruebas()

    @pytest.fixture
    def db(self, tmp_path):
        base = DatabaseManager(str(tmp_path / 'cotizacion.db'))
        base.initialize_database()
        return base

    def test_el_valor_sobrevive_a_cerrar_el_pos(self, db):
        """Sin internet al abrir, se vende con el dolar de la ultima vez."""
        uno = cot.CotizacionUSD()
        uno._db = db
        uno._guardar(1550, 'dolarapi', 'blue')

        otro = cot.CotizacionUSD()
        otro._db = db
        otro._cargar_de_local()
        assert otro.valor() == 1550
        assert otro.estado()['tipo'] == 'blue'

    def test_un_valor_guardado_absurdo_se_ignora(self, db):
        db.execute_update(
            "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
            ('cotizacion_usd_valor', '99999999'))
        c = cot.CotizacionUSD()
        c._db = db
        c._cargar_de_local()
        assert c.valor() == 0

    def test_no_sale_a_la_api_si_otra_pc_ya_lo_hizo(self, monkeypatch):
        """El punto de todo esto: cinco cajas, una sola consulta."""
        c = cot.CotizacionUSD()
        consultas = []
        monkeypatch.setattr(c, '_pedir_a_la_api',
                            lambda tipo, timeout: consultas.append(tipo) or {'valor': 1600, 'tipo': tipo})
        # Lo que dejo otra PC hace un minuto.
        monkeypatch.setattr(c, '_leer_de_la_nube', lambda: {
            'valor': 1550, 'tipo': 'blue', 'manual': False, 'fuente': 'dolarapi',
            'ts': time.time() - 60, 'refresco_minutos': 30,
        })
        c._tomar_de_la_nube(c._leer_de_la_nube())

        assert c._refrescar_si_hace_falta() is False
        assert consultas == []
        assert c.valor() == 1550
        assert c.estado()['fuente'] == 'otra PC'

    def test_si_esta_vencida_sale_una_sola(self, monkeypatch):
        c = cot.CotizacionUSD()
        consultas = []

        def _api(tipo, timeout):
            consultas.append(tipo)
            return {'valor': 1600, 'tipo': tipo}

        monkeypatch.setattr(c, '_pedir_a_la_api', _api)
        monkeypatch.setattr(c, '_leer_de_la_nube', lambda: None)
        monkeypatch.setattr(c, '_subir_a_la_nube', lambda v, t: True)
        monkeypatch.setattr(cot, 'VENTANA_DESFASAJE', 0)

        assert c._refrescar_si_hace_falta() is True
        assert consultas == ['blue']
        assert c.valor() == 1600
        # Y enseguida ya no le toca.
        assert c._refrescar_si_hace_falta() is False
        assert consultas == ['blue']

    def test_la_que_se_adelanto_gana_la_carrera(self, monkeypatch):
        """Dos cajas ven el documento vencido; una sube primero.

        La segunda mira de nuevo despues del desfasaje y se planta.
        """
        c = cot.CotizacionUSD()
        consultas = []
        monkeypatch.setattr(c, '_pedir_a_la_api',
                            lambda tipo, timeout: consultas.append(tipo) or {'valor': 1600, 'tipo': tipo})
        monkeypatch.setattr(cot, 'VENTANA_DESFASAJE', 0)
        # Durante el desfasaje, otra PC dejo el valor fresco.
        monkeypatch.setattr(c, '_leer_de_la_nube', lambda: {
            'valor': 1590, 'tipo': 'blue', 'manual': False, 'fuente': 'dolarapi',
            'ts': time.time(), 'refresco_minutos': 30,
        })

        assert c._refrescar_si_hace_falta() is False
        assert consultas == []
        assert c.valor() == 1590

    def test_el_modo_a_mano_no_consulta_nada(self, monkeypatch):
        c = cot.CotizacionUSD()
        monkeypatch.setattr(c, '_pedir_a_la_api',
                            lambda tipo, timeout: pytest.fail('no tenia que consultar'))
        monkeypatch.setattr(c, '_leer_de_la_nube', lambda: None)
        assert c.fijar_a_mano(1700) is True
        assert c.valor() == 1700
        assert c.esta_fresca() is True          # a mano no vence
        assert c._vencida_para_la_api() is False
        assert c._refrescar_si_hace_falta() is False

    def test_a_mano_no_acepta_cualquier_cosa(self):
        c = cot.CotizacionUSD()
        for malo in (0, -5, 'mil', None, 9_999_999):
            assert c.fijar_a_mano(malo) is False
        assert c.valor() == 0

    def test_una_respuesta_rota_de_la_api_no_pisa_el_valor_bueno(self, monkeypatch):
        c = cot.CotizacionUSD()
        c._guardar(1550, 'dolarapi', 'blue')
        monkeypatch.setattr(c, '_pedir_a_la_api', lambda tipo, timeout: None)
        monkeypatch.setattr(c, '_leer_de_la_nube', lambda: None)
        assert c.refrescar() is False
        assert c.valor() == 1550

    def test_la_nube_con_un_valor_viejo_no_pisa_al_nuevo(self):
        c = cot.CotizacionUSD()
        c._guardar(1600, 'dolarapi', 'blue')
        c._tomar_de_la_nube({
            'valor': 1400, 'tipo': 'blue', 'manual': False, 'fuente': 'dolarapi',
            'ts': time.time() - 3600, 'refresco_minutos': 30,
        })
        assert c.valor() == 1600

    def test_pero_el_valor_a_mano_gana_siempre(self):
        c = cot.CotizacionUSD()
        c._guardar(1600, 'dolarapi', 'blue')
        c._tomar_de_la_nube({
            'valor': 1700, 'tipo': 'manual', 'manual': True, 'fuente': 'a mano',
            'ts': time.time() - 3600, 'refresco_minutos': 30,
        })
        assert c.valor() == 1700
        assert c.estado()['manual'] is True

    def test_avisa_a_la_pantalla_cuando_cambia(self):
        c = cot.CotizacionUSD()
        vistos = []
        c.al_cambiar(vistos.append)
        c._guardar(1550, 'dolarapi', 'blue')
        c._guardar(1550, 'dolarapi', 'blue')      # mismo valor: no avisa de nuevo
        c._guardar(1600, 'dolarapi', 'blue')
        assert vistos == [1550, 1600]

    def test_un_aviso_que_explota_no_frena_a_los_demas(self):
        c = cot.CotizacionUSD()
        vistos = []

        def _explota(_v):
            raise RuntimeError('la pantalla ya no existe')

        c.al_cambiar(_explota)
        c.al_cambiar(vistos.append)
        c._guardar(1550, 'dolarapi', 'blue')
        assert vistos == [1550]

    def test_dos_refrescos_a_la_vez_no_se_apilan(self, monkeypatch):
        c = cot.CotizacionUSD()
        entro = threading.Event()
        seguir = threading.Event()
        consultas = []

        def _api(tipo, timeout):
            consultas.append(tipo)
            entro.set()
            seguir.wait(2)
            return {'valor': 1600, 'tipo': tipo}

        monkeypatch.setattr(c, '_pedir_a_la_api', _api)
        monkeypatch.setattr(c, '_leer_de_la_nube', lambda: None)
        monkeypatch.setattr(c, '_subir_a_la_nube', lambda v, t: True)

        hilo = threading.Thread(target=c.refrescar, daemon=True)
        hilo.start()
        entro.wait(2)
        assert c.refrescar() is False        # el segundo no entra
        seguir.set()
        hilo.join(3)
        assert consultas == ['blue']

    def test_la_fecha_de_la_nube_se_entiende_en_todas_sus_formas(self):
        """El `actualizado` del documento llega de cuatro formas distintas.

        El POS lo escribe como texto ISO con zona, la webapp puede dejar un
        Timestamp de Firestore (que baja como datetime) y un script podria
        poner epoch. Si alguna no se entiende, la cotizacion parece de 1970 y
        todas las PCs salen a consultar de nuevo todo el tiempo.
        """
        from datetime import datetime, timezone
        ahora = time.time()
        esperado = datetime(2026, 9, 21, 16, 56, tzinfo=timezone.utc).timestamp()
        assert cot._ts_de_iso('') == 0
        assert cot._ts_de_iso('no es una fecha') == 0
        assert abs(cot._ts_de_iso('2026-09-21T16:56:00.000Z') - esperado) < 1
        assert abs(cot._ts_de_iso('2026-09-21T13:56:00-03:00') - esperado) < 1
        assert abs(cot._ts_de_iso(datetime.fromtimestamp(ahora, tz=timezone.utc)) - ahora) < 1
        assert abs(cot._ts_de_iso(ahora) - ahora) < 1
        assert abs(cot._ts_de_iso(ahora * 1000) - ahora) < 1

    def test_el_documento_compartido_se_lee_con_cuidado(self):
        leer = cot.CotizacionUSD._leer_documento
        assert leer(None) is None
        assert leer({}) is None
        assert leer({'valor': 0}) is None
        assert leer({'valor': 'mil'}) is None
        d = leer({'valor': 1550, 'tipo': 'BLUE', 'manual': 'si',
                  'actualizado': '2026-09-21T16:56:00Z', 'refresco_minutos': 60})
        assert d['valor'] == 1550
        assert d['tipo'] == 'blue'
        assert d['manual'] is False           # solo el booleano True vale
        assert d['refresco_minutos'] == 60
        # Un refresco absurdo se acota o se ignora, nunca se acepta: un 0
        # dejaria a las cinco PCs consultando en bucle.
        assert leer({'valor': 1550, 'refresco_minutos': 0})['refresco_minutos'] == 30
        assert leer({'valor': 1550, 'refresco_minutos': -5})['refresco_minutos'] == 1
        assert leer({'valor': 1550, 'refresco_minutos': 0.5})['refresco_minutos'] == 1
        assert leer({'valor': 1550, 'refresco_minutos': 99999})['refresco_minutos'] == 1440
        assert leer({'valor': 1550, 'refresco_minutos': 'nada'})['refresco_minutos'] == 30

    def test_si_se_cae_la_primera_api_se_usa_la_segunda(self, monkeypatch):
        """El dia que dolarapi deje de andar, el local no se queda a ciegas."""
        c = cot.CotizacionUSD()
        pedidos = []

        def _pedir(url, camino, timeout):
            pedidos.append(url)
            if 'dolarapi' in url:
                return None                     # se cayo
            assert camino == ('blue', 'value_sell')
            return 1550.0

        monkeypatch.setattr(cot.CotizacionUSD, '_pedir_a', staticmethod(_pedir))
        datos = c._pedir_a_la_api('blue', 4)
        assert datos['valor'] == 1550.0
        assert len(pedidos) == 2
        assert 'bluelytics' in pedidos[1]

    def test_si_ninguna_api_contesta_no_inventa_nada(self, monkeypatch):
        c = cot.CotizacionUSD()
        monkeypatch.setattr(cot.CotizacionUSD, '_pedir_a',
                            staticmethod(lambda url, camino, timeout: None))
        assert c._pedir_a_la_api('blue', 4) is None

    def test_un_tipo_de_dolar_desconocido_cae_al_blue(self, monkeypatch):
        c = cot.CotizacionUSD()
        pedidos = []
        monkeypatch.setattr(cot.CotizacionUSD, '_pedir_a',
                            staticmethod(lambda url, camino, timeout: pedidos.append(url) or 1550.0))
        datos = c._pedir_a_la_api('cripto', 4)
        assert datos['valor'] == 1550.0
        assert 'blue' in pedidos[0]

    def test_cotizacion_valida_es_la_ultima_linea(self):
        assert cotizacion_valida(1550)
        assert not cotizacion_valida(0)
        assert not cotizacion_valida(-1)
        assert not cotizacion_valida(1_000_000)
        assert not cotizacion_valida(float('nan'))
        assert not cotizacion_valida(None)
