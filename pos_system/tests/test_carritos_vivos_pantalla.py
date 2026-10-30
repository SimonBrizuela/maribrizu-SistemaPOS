"""
Traer la venta de otra caja, con las pantallas de Ventas de verdad.

Tres cajas en el mismo proceso (Compu 1, Compu 2, Compu 3), cada una con su
base, su pc_id, su cajero y su conexión, hablando con la nube en memoria
(`doble_carritos.py`, transacciones optimistas como Firestore). Los productos
tienen ids locales distintos en cada caja, como en el local. Traer = pedir: la
caja de origen entrega su carrito; si no contesta, la venta se queda allá.

Lo que se mira es lo que ve y cobra el cajero: la lista EN OTRAS CAJAS, la vista
previa, el carrito que llega, el que queda vacío con su aviso, la venta a
nombre de quien la empezó y el stock descontado una sola vez.

Corre sin pantalla (`QT_QPA_PLATFORM=offscreen`).
"""
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
pytest.importorskip('PyQt5.QtWidgets', reason='el POS necesita PyQt5')

from PyQt5.QtCore import QPoint, QRect  # noqa: E402
from PyQt5.QtWidgets import QApplication  # noqa: E402

from pos_system.models import carrito_vivo as cv  # noqa: E402
from pos_system.tests import cajas_de_prueba as cp  # noqa: E402
from pos_system.tests.doble_carritos import NubeCarritosMemoria  # noqa: E402

_ABIERTAS = []


@pytest.fixture(scope='module')
def app():
    yield QApplication.instance() or QApplication([])
    _ABIERTAS.clear()


@pytest.fixture(autouse=True)
def sin_firebase_de_verdad(monkeypatch):
    import pos_system.utils.firebase_sync as fs
    monkeypatch.setattr(fs, 'init_firebase_sync', lambda: None)
    monkeypatch.setattr(fs, 'get_firebase_sync', lambda: None)


@pytest.fixture
def local(app, tmp_path):
    """Tres cajas y la nube. La 3 numera los productos corrida en 3 y la 2 en 5."""
    nube = NubeCarritosMemoria()
    bases = {
        'pc1': cp.crear_base(tmp_path / 'c1.db'),
        'pc2': cp.crear_base(tmp_path / 'c2.db', corrimiento=5),
        'pc3': cp.crear_base(tmp_path / 'c3.db', corrimiento=3),
    }
    cajas = {
        'pc1': cp.abrir_caja(bases['pc1'], 'pc1', 'Compu 1', 'Ana', nube=nube,
                              espera_entrega=1.5),
        'pc2': cp.abrir_caja(bases['pc2'], 'pc2', 'Compu 2', 'Caro', nube=nube,
                              espera_entrega=1.5),
        'pc3': cp.abrir_caja(bases['pc3'], 'pc3', 'Compu 3', 'Beto', nube=nube,
                              espera_entrega=1.5),
    }
    for c in cajas.values():
        c.show()
        _ABIERTAS.append(c)
    cp.asentar(0.2)
    yield nube, bases, cajas
    for c in cajas.values():
        c.carrito_compartido.detener()
        c.hide()


def cargar(caja, base, *fids):
    for fid in fids:
        caja.add_to_cart(cp.producto(base, fid))


def ve(caja, pc_id, cuantos=None):
    """La caja ve la venta de `pc_id` en EN OTRAS CAJAS (con `cuantos` renglones)."""
    def _cond():
        doc = next((c for c in caja.carrito_compartido.carritos() if c['pc_id'] == pc_id), None)
        return doc is not None and (cuantos is None or doc['renglones'] == cuantos)
    return cp.esperar(_cond, 5)


def traer(destino, origen_pc):
    destino._traer_venta(origen_pc, destino.carrito_compartido.doc_de(origen_pc))


def aviso_visible(caja):
    return not caja.aviso_venta.isHidden() and not caja._aviso_box.isHidden()


# ════════════════════════════════════════════════════════════════════════════
class TestLaLista:
    def test_las_otras_cajas_ven_la_venta_con_cajero_items_y_total(self, local):
        nube, bases, cajas = local
        cargar(cajas['pc1'], bases['pc1'], 'fb-cuaderno', 'fb-cuaderno', 'fb-birome')
        assert ve(cajas['pc3'], 'pc1') and ve(cajas['pc2'], 'pc1')
        c = cajas['pc3'].carrito_compartido.carritos()[0]
        assert (c['nombre'], c['cajero'], c['cantidad'], c['total']) == ('Compu 1', 'Ana', 3, 7800.0)
        # La propia no se lista a sí misma.
        assert cajas['pc1'].carrito_compartido.carritos() == []
        # La tarjeta muestra una fila.
        tarjeta = cajas['pc3']._otras_cajas_card
        assert len(tarjeta._filas) == 1 and tarjeta._contador.text() == '1'

    def test_un_carrito_vacio_no_aparece(self, local):
        nube, bases, cajas = local
        cargar(cajas['pc1'], bases['pc1'], 'fb-birome')
        assert ve(cajas['pc3'], 'pc1')
        cajas['pc1'].remove_from_cart(0)
        assert cp.esperar(lambda: cajas['pc3'].carrito_compartido.carritos() == [], 5)

    def test_una_caja_que_dejo_de_dar_senales_sale_de_la_lista(self, local):
        nube, bases, cajas = local
        cargar(cajas['pc1'], bases['pc1'], 'fb-birome')
        assert ve(cajas['pc3'], 'pc1')
        nube.adelantar(cv.VIGENCIA_SEG + 30)
        cajas['pc3'].carrito_compartido._desfase = nube.ahora() - cv.ahora_utc()
        cajas['pc3'].carrito_compartido._revisar()
        assert cajas['pc3'].carrito_compartido.carritos() == []


class TestVistaPrevia:
    def test_muestra_los_renglones_y_deja_traer(self, local):
        from pos_system.ui.otras_cajas import CarritoAjenoDialog
        nube, bases, cajas = local
        cargar(cajas['pc1'], bases['pc1'], 'fb-cuaderno', 'fb-hilo')
        assert ve(cajas['pc3'], 'pc1', 2)
        c3 = cajas['pc3']
        dlg = CarritoAjenoDialog(c3, 'pc1', c3.carrito_compartido.doc_de('pc1'),
                                 c3._bloqueo_para_traer, ahora=c3.carrito_compartido.ahora)
        _ABIERTAS.append(dlg)
        assert dlg._tabla.rowCount() == 2
        assert dlg._tabla.item(0, 0).text() == 'CUADERNO RIVADAVIA 50 HOJAS'
        assert dlg._tabla.item(1, 3).text() == '$1,200'
        assert dlg._total.text() == '$4,700'
        assert 'Ana' in dlg._cabeza.text()
        assert dlg._traer.isEnabled() and dlg._motivo.isHidden()

    def test_se_actualiza_si_alla_siguen_cargando(self, local):
        from pos_system.ui.otras_cajas import CarritoAjenoDialog
        nube, bases, cajas = local
        cargar(cajas['pc1'], bases['pc1'], 'fb-cuaderno')
        assert ve(cajas['pc3'], 'pc1', 1)
        c3 = cajas['pc3']
        dlg = CarritoAjenoDialog(c3, 'pc1', c3.carrito_compartido.doc_de('pc1'),
                                 c3._bloqueo_para_traer, ahora=c3.carrito_compartido.ahora)
        _ABIERTAS.append(dlg)
        c3._dialogo_ajeno = dlg
        try:
            cargar(cajas['pc1'], bases['pc1'], 'fb-botones')
            assert cp.esperar(lambda: dlg._tabla.rowCount() == 2, 5)
            # Allá la cobran: la vista previa lo dice y no deja traer.
            with cp.cobro_sin_preguntas():
                cajas['pc1'].complete_sale()
            # Primero se ve "la están cobrando" y, cobrada, que ya no está.
            assert cp.esperar(lambda: 'ya no está abierta' in dlg._motivo.text(), 5)
            assert not dlg._traer.isEnabled()
        finally:
            c3._dialogo_ajeno = None


class TestCarritoPropio:
    def test_con_productos_en_esta_caja_no_se_puede_traer(self, local):
        nube, bases, cajas = local
        cargar(cajas['pc1'], bases['pc1'], 'fb-cuaderno')
        cargar(cajas['pc3'], bases['pc3'], 'fb-hilo')
        assert ve(cajas['pc3'], 'pc1')
        c3 = cajas['pc3']
        motivo = c3._bloqueo_para_traer(c3.carrito_compartido.doc_de('pc1'))
        assert motivo.startswith('Tu carrito tiene productos. Cobralo o dejalo pendiente')
        with cp.avisos_capturados() as vistos:
            traer(c3, 'pc1')
        assert vistos and 'Cobralo o dejalo pendiente' in vistos[0][1]
        # Nada se movió: cada una con lo suyo.
        assert [i['product_name'] for i in c3.cart] == ['HILO DE COSER NEGRO']
        assert [i['product_name'] for i in cajas['pc1'].cart] == ['CUADERNO RIVADAVIA 50 HOJAS']
        assert ('pedir', 'pc1') not in nube.transacciones


class TestTraer:
    def test_la_venta_pasa_entera_y_el_origen_queda_vacio_con_aviso(self, local):
        nube, bases, cajas = local
        c1, c3 = cajas['pc1'], cajas['pc3']
        cargar(c1, bases['pc1'], 'fb-cuaderno', 'fb-cuaderno', 'fb-hilo')
        assert ve(c3, 'pc1', 2)
        traer(c3, 'pc1')

        # Destino: mismos renglones con SUS ids locales (corridos en 3).
        assert [(i['product_id'], i['quantity']) for i in c3.cart] == [
            (cp.producto(bases['pc3'], 'fb-cuaderno')['id'], 2),
            (cp.producto(bases['pc3'], 'fb-hilo')['id'], 1)]
        assert c3._cart_cajero_fijo == 'Ana'
        assert aviso_visible(c3) and 'Se cobra a nombre de Ana' in c3.aviso_venta.texto()
        assert c3._venta_origen_lbl.text().startswith('Vino de la Compu 1')

        # Origen: vacío y con el aviso de adónde fue.
        assert cp.esperar(lambda: not c1.cart, 5)
        assert aviso_visible(c1) and c1.aviso_venta.texto() == 'La venta pasó a la Compu 3.'
        # En la nube la venta está en un solo lugar.
        cp.asentar(0.2)
        assert [p for p, d in nube.docs.items() if cv.tiene_venta(d)] == ['pc3']
        # La Compu 2 la ve ahora en la 3.
        assert ve(cajas['pc2'], 'pc3', 2)

    def test_ida_y_vuelta_con_lo_que_se_agrego(self, local):
        nube, bases, cajas = local
        c1, c3 = cajas['pc1'], cajas['pc3']
        cargar(c1, bases['pc1'], 'fb-cuaderno')
        assert ve(c3, 'pc1')
        traer(c3, 'pc1')
        cargar(c3, bases['pc3'], 'fb-hilo', 'fb-botones')
        assert ve(c1, 'pc3', 3)
        traer(c1, 'pc3')

        assert [i['product_name'] for i in c1.cart] == [
            'CUADERNO RIVADAVIA 50 HOJAS', 'HILO DE COSER NEGRO', 'BOTONES NACARADOS X 6']
        assert [i['product_id'] for i in c1.cart] == [
            cp.producto(bases['pc1'], f)['id'] for f in ('fb-cuaderno', 'fb-hilo', 'fb-botones')]
        assert c1._cart_cajero_fijo == 'Ana'
        assert cp.esperar(lambda: not c3.cart, 5)
        assert c3.aviso_venta.texto() == 'La venta pasó a la Compu 1.'
        # Y otra vuelta más: sigue andando.
        assert ve(c3, 'pc1', 3)
        traer(c3, 'pc1')
        assert len(c3.cart) == 3 and cp.esperar(lambda: not c1.cart, 5)

    def test_el_descuento_con_nombre_viaja_con_la_venta(self, local):
        nube, bases, cajas = local
        c1, c3 = cajas['pc1'], cajas['pc3']
        cargar(c1, bases['pc1'], 'fb-cuaderno', 'fb-birome')
        c1.descuento_manual = {'nombre': 'Jubilados', 'tipo': 'porcentaje', 'valor': 10, 'filas': None}
        c1.update_cart_display()
        assert cp.esperar(lambda: (c3.carrito_compartido.doc_de('pc1') or {}).get('total') == 3870.0, 5)
        traer(c3, 'pc1')
        assert c3.descuento_manual['nombre'] == 'Jubilados'
        assert c3._descuento_total() == pytest.approx(430.0)


class TestCobrar:
    def test_se_cobra_en_la_otra_caja_a_nombre_de_quien_la_empezo(self, local):
        nube, bases, cajas = local
        c1, c3 = cajas['pc1'], cajas['pc3']
        cargar(c1, bases['pc1'], 'fb-cuaderno', 'fb-cuaderno', 'fb-hilo')
        assert ve(c3, 'pc1')
        traer(c3, 'pc1')
        with cp.cobro_sin_preguntas():
            c3.complete_sale()

        # Una sola venta, en la caja que cobró, a nombre de Ana (no de Beto).
        ventas3 = cp.ventas(bases['pc3'])
        assert [(v['turno_nombre'], v['total_amount']) for v in ventas3] == [('Ana', 8200.0)]
        assert cp.ventas(bases['pc1']) == []
        # Stock descontado una vez, en los productos correctos de la Compu 3.
        assert cp.stock(bases['pc3'], 'fb-cuaderno') == 18
        assert cp.stock(bases['pc3'], 'fb-hilo') == 29
        # El relleno con el id que tenía el cuaderno en la Compu 1 no se tocó.
        assert all(r['stock'] == 1 for r in bases['pc3'].execute_query(
            "SELECT stock FROM products WHERE category = 'RELLENO'"))
        assert cp.stock(bases['pc1'], 'fb-cuaderno') == 20

        # Desaparece de todos lados.
        assert not c3.cart and not c1.cart
        cp.asentar(0.3)
        assert not any(cv.tiene_venta(d) for d in nube.docs.values())
        for c in cajas.values():
            assert cp.esperar(lambda c=c: c.carrito_compartido.carritos() == [], 5)
        # La próxima venta de la Compu 3 vuelve a ser de su cajero.
        cargar(c3, bases['pc3'], 'fb-birome')
        with cp.cobro_sin_preguntas():
            c3.complete_sale()
        assert cp.ventas(bases['pc3'])[-1]['turno_nombre'] == 'Beto'

    def test_mientras_se_cobra_nadie_la_puede_traer(self, local):
        nube, bases, cajas = local
        c1, c3 = cajas['pc1'], cajas['pc3']
        cargar(c1, bases['pc1'], 'fb-cuaderno')
        assert ve(c3, 'pc1')
        assert c1._reservar_cobro_vivo()      # se abrió la pantalla de cobro
        assert cp.esperar(lambda: (c3.carrito_compartido.doc_de('pc1') or {}).get('cobrando'), 5)
        assert 'La están cobrando en la Compu 1' in c3._bloqueo_para_traer(c3.carrito_compartido.doc_de('pc1'))
        # Canceló el cobro: se puede traer de nuevo.
        c1._soltar_cobro_vivo()
        assert cp.esperar(lambda: not (c3.carrito_compartido.doc_de('pc1') or {}).get('cobrando'), 5)
        assert c3._bloqueo_para_traer(c3.carrito_compartido.doc_de('pc1')) == ''

    def test_si_la_piden_con_el_cobro_abierto_la_origen_no_la_entrega(self, local):
        """La Compu 1 abrió el cobro y la 3 pide antes de que la nube se entere
        de que está cobrando: la 1 contesta que no, con el motivo."""
        nube, bases, cajas = local
        c1, c3 = cajas['pc1'], cajas['pc3']
        cargar(c1, bases['pc1'], 'fb-cuaderno')
        assert ve(c3, 'pc1')
        visto = dict(c3.carrito_compartido.doc_de('pc1'))
        c1._cobrando_vivo = True              # pantalla de cobro abierta, sin publicar aún
        c3._traer_venta('pc1', visto)
        assert not c3.cart
        assert c3.aviso_venta.texto() == 'La están cobrando en la Compu 1.'
        assert [i['product_name'] for i in c1.cart] == ['CUADERNO RIVADAVIA 50 HOJAS']
        assert nube.solicitudes['pc1']['estado'] == 'rechazada'
        c1._cobrando_vivo = False


class TestNadaSePierde:
    def test_lo_escaneado_justo_antes_de_entregar_viaja_con_la_venta(self, local):
        """La 3 vio un renglón; la 1 escaneó otro que todavía no publicó. La 1
        entrega lo que tiene en el carrito: llegan los dos."""
        nube, bases, cajas = local
        c1, c3 = cajas['pc1'], cajas['pc3']
        cargar(c1, bases['pc1'], 'fb-cuaderno')
        assert ve(c3, 'pc1', 1)
        cp.asentar(0.2)
        c1.carrito_compartido._debounce.setInterval(60_000)   # no llegó a publicarse
        cargar(c1, bases['pc1'], 'fb-hilo')
        traer(c3, 'pc1')
        assert [i['product_name'] for i in c3.cart] == ['CUADERNO RIVADAVIA 50 HOJAS', 'HILO DE COSER NEGRO']
        assert not c1.cart and c1.aviso_venta.texto() == 'La venta pasó a la Compu 3.'

    def test_lo_escaneado_mientras_entrega_arranca_una_venta_nueva(self, local):
        """Justo mientras la 1 entrega, el cajero escanea los botones: no se
        pierden; quedan en la 1 como venta nueva, y el aviso aparece igual."""
        nube, bases, cajas = local
        c1, c3 = cajas['pc1'], cajas['pc3']
        cargar(c1, bases['pc1'], 'fb-cuaderno')
        assert ve(c3, 'pc1', 1)
        botones = cp.producto(bases['pc1'], 'fb-botones')
        nube.hueco_en = 'entregar'
        nube.entre_lectura_y_escritura = lambda accion: (
            c1.add_to_cart(botones) if accion == 'entregar' else None)
        epoch_vieja = c1._venta_epoch
        traer(c3, 'pc1')
        assert [i['product_name'] for i in c3.cart] == ['CUADERNO RIVADAVIA 50 HOJAS']
        assert [i['product_name'] for i in c1.cart] == ['BOTONES NACARADOS X 6']
        assert c1._venta_epoch and c1._venta_epoch != epoch_vieja
        assert c1.aviso_venta.texto() == 'La venta pasó a la Compu 3.'
        # Y esa venta nueva se publica: la 3 la ve como otra venta de la 1.
        assert ve(c3, 'pc1', 1)

    def test_lo_escaneado_despues_de_entregar_es_una_venta_nueva(self, local):
        nube, bases, cajas = local
        c1, c3 = cajas['pc1'], cajas['pc3']
        cargar(c1, bases['pc1'], 'fb-cuaderno')
        assert ve(c3, 'pc1')
        traer(c3, 'pc1')
        cargar(c1, bases['pc1'], 'fb-botones')
        assert [i['product_name'] for i in c1.cart] == ['BOTONES NACARADOS X 6']
        assert [i['product_name'] for i in c3.cart] == ['CUADERNO RIVADAVIA 50 HOJAS']
        cp.asentar(0.3)
        assert sorted(p for p, d in nube.docs.items() if cv.tiene_venta(d)) == ['pc1', 'pc3']
        assert nube.docs['pc1']['epoch'] != nube.docs['pc3']['epoch']

    def test_lo_escaneado_en_la_destino_mientras_espera_entra_despues(self, local):
        nube, bases, cajas = local
        c1, c3 = cajas['pc1'], cajas['pc3']
        cargar(c1, bases['pc1'], 'fb-cuaderno')
        assert ve(c3, 'pc1')
        hilo = cp.producto(bases['pc3'], 'fb-hilo')
        nube.hueco_en = 'entregar'
        nube.entre_lectura_y_escritura = lambda accion: (
            c3.add_to_cart(hilo) if accion == 'entregar' else None)
        traer(c3, 'pc1')
        assert [i['product_name'] for i in c3.cart] == ['CUADERNO RIVADAVIA 50 HOJAS', 'HILO DE COSER NEGRO']
        assert c3._cart_cajero_fijo == 'Ana'


class TestCarreras:
    def test_dos_cajas_la_piden_a_la_vez(self, local):
        nube, bases, cajas = local
        c1, c2, c3 = cajas['pc1'], cajas['pc2'], cajas['pc3']
        cargar(c1, bases['pc1'], 'fb-cuaderno')
        assert ve(c3, 'pc1') and ve(c2, 'pc1')
        visto = dict(c2.carrito_compartido.doc_de('pc1'))
        # La 3 pide justo antes que la 2 (y la 1 todavía no contestó).
        assert nube.pedir('pc1', visto['epoch'], {'pc_id': 'pc3', 'pc_nombre': 'Compu 3', 'cajero': 'Beto'},
                          'sol-3', _pc='pc3').ok
        c2._traer_venta('pc1', visto)
        assert not c2.cart
        assert c2.aviso_venta.texto() in ('La Compu 3 la está pidiendo en este momento.',
                                          'Esa venta ya no está abierta: la cobraron, la vaciaron o pasó a otra caja.')
        cp.asentar(0.3)
        assert [p for p, d in nube.docs.items() if cv.tiene_venta(d)] in (['pc1'], ['pc3'])


class TestSinInternet:
    def test_la_origen_sin_internet_no_entrega_y_la_venta_sigue_alla(self, local):
        nube, bases, cajas = local
        c1, c3 = cajas['pc1'], cajas['pc3']
        cargar(c1, bases['pc1'], 'fb-cuaderno', 'fb-birome')
        assert ve(c3, 'pc1', 2)
        nube.desconectar('pc1')
        traer(c3, 'pc1')
        assert not c3.cart
        assert c3.aviso_venta.texto() == 'La Compu 1 no responde: la venta sigue allá.'
        assert len(c1.cart) == 2 and nube.solicitudes['pc1']['estado'] == 'cancelada'
        # Vuelve internet en la 1: ve la solicitud cancelada y no entrega nada.
        nube.reconectar('pc1')
        cp.asentar(0.5)
        assert len(c1.cart) == 2
        assert [p for p, d in nube.docs.items() if cv.tiene_venta(d)] == ['pc1']
        # Y se puede cobrar allá, una sola vez.
        with cp.cobro_sin_preguntas():
            c1.complete_sale()
        assert len(cp.ventas(bases['pc1'])) == 1 and cp.ventas(bases['pc3']) == []

    def test_esta_caja_sin_internet_avisa_y_no_deja_traer(self, local):
        nube, bases, cajas = local
        c1, c3 = cajas['pc1'], cajas['pc3']
        cargar(c1, bases['pc1'], 'fb-cuaderno')
        assert ve(c3, 'pc1')
        nube.desconectar('pc3')
        c3.carrito_compartido._vueltas_sin_carrito = 1
        c3.carrito_compartido._renovar()     # la lectura de prueba falla
        assert cp.esperar(lambda: c3.carrito_compartido.en_linea is False, 5)
        assert 'Sin conexión' in c3._bloqueo_para_traer(c3.carrito_compartido.doc_de('pc1'))
        textos = [w.text() for w in c3._otras_cajas_card.findChildren(type(c3.aviso_venta._texto))]
        assert any('Sin conexión' in t for t in textos)

    def test_sin_internet_se_cobra_igual_sin_esperar(self, local):
        nube, bases, cajas = local
        c1 = cajas['pc1']
        cargar(c1, bases['pc1'], 'fb-cuaderno', 'fb-birome')
        cp.asentar(0.2)
        nube.desconectar('pc1')
        cargar(c1, bases['pc1'], 'fb-hilo')
        cp.asentar(0.2)
        assert len(c1.cart) == 3
        inicio = time.monotonic()
        with cp.cobro_sin_preguntas():
            c1.complete_sale()
        assert time.monotonic() - inicio < 2
        assert [(v['turno_nombre'], v['total_amount']) for v in cp.ventas(bases['pc1'])] == [('Ana', 5500.0)]


class TestVentaQueLlegaTarde:
    """Una entrega que llegó cuando la caja ya había dejado de esperar (o con
    el POS cerrado) no se pierde ni se pisa."""

    def _entregar_a(self, nube, destino_pc, destino_nombre):
        estado = cv.armar_estado('pc9', 'Compu 9', 'E9', cv.serializar_items([
            {'product_id': 0, 'product_name': 'Fotocopias', 'quantity': 10, 'unit_price': 100.0,
             'subtotal': 1000.0, 'is_varios': True}]), [{'quantity': 10, 'subtotal': 1000.0}], 'Lili')
        nube.publicar('pc9', 'Compu 9', 'E9', estado)
        quien = {'pc_id': destino_pc, 'pc_nombre': destino_nombre, 'cajero': 'x'}
        assert nube.pedir('pc9', 'E9', quien, 's9', _pc='pc9').ok
        assert nube.entregar('pc9', 'Compu 9', 's9', 'E9', estado).ok

    def test_con_el_carrito_vacio_entra_al_carrito(self, local):
        nube, bases, cajas = local
        c3 = cajas['pc3']
        self._entregar_a(nube, 'pc3', 'Compu 3')
        assert cp.esperar(lambda: len(c3.cart) == 1, 5)
        assert c3._cart_cajero_fijo == 'Lili'
        assert c3.aviso_venta.texto() == 'Llegó la venta de la Compu 9.'

    def test_con_otra_venta_en_curso_queda_en_pendientes(self, local):
        nube, bases, cajas = local
        c3 = cajas['pc3']
        cargar(c3, bases['pc3'], 'fb-hilo')
        cp.asentar(0.2)
        # La caja tiene su venta: la entrega no se puede hacer (destino ocupado)...
        estado = cv.armar_estado('pc9', 'Compu 9', 'E9', '[]', [], 'Lili')
        nube.publicar('pc9', 'Compu 9', 'E9', {**estado, 'renglones': 1})
        assert nube.pedir('pc9', 'E9', {'pc_id': 'pc3', 'pc_nombre': 'Compu 3', 'cajero': 'x'},
                          's9', _pc='pc9').ok
        r = nube.entregar('pc9', 'Compu 9', 's9', 'E9', {**estado, 'renglones': 1})
        assert not r.ok and r.motivo == 'destino_ocupado'
        # ...pero si llegó antes de que la caja empezara otra (la escucha de
        # esta caja no se enteró), al publicar no la pisa: va a Pendientes.
        c3.carrito_compartido._escucha.unsubscribe()
        llegada = cv.doc_entregado(cv.armar_estado('pc9', 'Compu 9', 'E8', cv.serializar_items([
            {'product_id': 0, 'product_name': 'Fotocopias', 'quantity': 10, 'unit_price': 100.0,
             'subtotal': 1000.0}]), [{'quantity': 10, 'subtotal': 1000.0}], 'Lili'),
            cv.solicitud_nueva('s8', 'E8', {'pc_id': 'pc3', 'pc_nombre': 'Compu 3'}))
        with nube._lock:
            nube.docs['pc3'] = {**llegada, 'actualizado': nube.ahora()}
            nube.versiones[('carritos', 'pc3')] = nube.versiones.get(('carritos', 'pc3'), 0) + 1
        cargar(c3, bases['pc3'], 'fb-botones')      # publica: la regla dice "adoptar"
        assert cp.esperar(lambda: c3.pending_model.count() == 1, 5)
        p = c3.pending_model.get_all()[0]
        assert p['cajero_original'] == 'Lili' and p['items'][0]['product_name'] == 'Fotocopias'
        assert [i['product_name'] for i in c3.cart] == ['HILO DE COSER NEGRO', 'BOTONES NACARADOS X 6']
        cp.asentar(0.5)
        assert nube.docs['pc3']['epoch'] == c3._venta_epoch and not nube.docs['pc3'].get('pendiente_de_cargar')


class TestPendientesConSuCajero:
    def test_la_retoma_otro_cajero_y_se_cobra_a_nombre_de_quien_la_empezo(self, local):
        nube, bases, cajas = local
        c1 = cajas['pc1']
        cargar(c1, bases['pc1'], 'fb-cuaderno')
        c1._add_to_pending()
        assert c1.pending_model.get_all()[0]['cajero_original'] == 'Ana'
        c1.current_user['turno_nombre'] = 'Beto'      # cambió el turno
        c1._restore_pending(c1.pending_model.get_all()[0]['id'])
        assert c1._cart_cajero_fijo == 'Ana'
        assert c1._venta_origen_lbl.text() == 'Se cobra a nombre de Ana'
        with cp.cobro_sin_preguntas():
            c1.complete_sale()
        assert cp.ventas(bases['pc1'])[-1]['turno_nombre'] == 'Ana'
        c1.current_user['turno_nombre'] = 'Ana'

    def test_una_venta_traida_dejada_pendiente_conserva_su_cajero(self, local):
        nube, bases, cajas = local
        c1, c3 = cajas['pc1'], cajas['pc3']
        cargar(c1, bases['pc1'], 'fb-cuaderno')
        assert ve(c3, 'pc1')
        traer(c3, 'pc1')
        c3._add_to_pending()
        c3._restore_pending(c3.pending_model.get_all()[0]['id'])
        assert c3._cart_cajero_fijo == 'Ana'
        with cp.cobro_sin_preguntas():
            c3.complete_sale()
        assert cp.ventas(bases['pc3'])[-1]['turno_nombre'] == 'Ana'

    def test_los_pendientes_de_antes_siguen_cobrandose_con_el_turno(self, local):
        nube, bases, cajas = local
        c1 = cajas['pc1']
        pid = c1.pending_model.create([{'product_id': cp.producto(bases['pc1'], 'fb-birome')['id'],
                                        'product_name': 'BIROME BIC AZUL', 'quantity': 1,
                                        'unit_price': 800.0, 'original_price': 800.0, 'subtotal': 800.0}],
                                      cajero_nombre='Viejo')
        assert c1.pending_model.get_by_id(pid)['cajero_original'] is None
        c1._restore_pending(pid)
        assert c1._cart_cajero_fijo is None and c1._venta_origen_lbl.isHidden()
        with cp.cobro_sin_preguntas():
            c1.complete_sale()
        assert cp.ventas(bases['pc1'])[-1]['turno_nombre'] == 'Ana'


class TestFaltanProductos:
    def test_si_esta_caja_no_tiene_un_producto_no_deja_traer_y_dice_cual(self, local):
        nube, bases, cajas = local
        c1, c3 = cajas['pc1'], cajas['pc3']
        bases['pc3'].execute_update("DELETE FROM products WHERE firebase_id = 'fb-botones'")
        cargar(c1, bases['pc1'], 'fb-cuaderno', 'fb-botones')
        assert ve(c3, 'pc1', 2)
        motivo = c3._bloqueo_para_traer(c3.carrito_compartido.doc_de('pc1'))
        assert 'BOTONES NACARADOS X 6' in motivo and 'Sincronizá' in motivo


class TestAviso:
    def test_un_aviso_nuevo_reemplaza_al_anterior_y_se_va_solo(self, local):
        nube, bases, cajas = local
        c1 = cajas['pc1']
        c1._mostrar_aviso('La venta pasó a la Compu 3.')
        c1._mostrar_aviso('La venta pasó a la Compu 2.')
        assert c1.aviso_venta.texto() == 'La venta pasó a la Compu 2.'
        assert len(c1.findChildren(type(c1.aviso_venta))) == 1
        assert c1.aviso_venta._timer.isActive() and c1.aviso_venta._timer.interval() == 4000
        c1.aviso_venta._timer.timeout.emit()
        assert not aviso_visible(c1)

    def test_se_cierra_con_un_toque(self, local):
        from PyQt5.QtCore import QEvent, Qt
        from PyQt5.QtGui import QMouseEvent
        nube, bases, cajas = local
        c1 = cajas['pc1']
        c1._mostrar_aviso('La venta pasó a la Compu 3.')
        ev = QMouseEvent(QEvent.MouseButtonPress, QPoint(5, 5), Qt.LeftButton, Qt.LeftButton, Qt.NoModifier)
        QApplication.sendEvent(c1.aviso_venta, ev)
        assert not aviso_visible(c1)

    def test_no_tapa_el_boton_cobrar(self, local):
        nube, bases, cajas = local
        c1 = cajas['pc1']
        cargar(c1, bases['pc1'], 'fb-cuaderno')
        c1._mostrar_aviso('La venta pasó a la Compu 3.')
        QApplication.processEvents()
        aviso = QRect(c1.aviso_venta.mapTo(c1, QPoint(0, 0)), c1.aviso_venta.size())
        cobrar = QRect(c1._cobrar_btn.mapTo(c1, QPoint(0, 0)), c1._cobrar_btn.size())
        tabla = QRect(c1.cart_table.mapTo(c1, QPoint(0, 0)), c1.cart_table.size())
        assert not aviso.intersects(cobrar)
        assert aviso.bottom() < tabla.top()       # va arriba del carrito, en su lugar
        assert c1._cobrar_btn.isVisible()


def widgets_visibles_en_la_tabla(caja):
    """Widgets de celda que se ven en la tabla del carrito (los que quedan de un
    redibujado anterior y no se ocultaron cuentan: son los fantasmas)."""
    from PyQt5.QtWidgets import QWidget
    vp = caja.cart_table.viewport()
    return [w for w in vp.findChildren(QWidget, options=__import__('PyQt5.QtCore', fromlist=['Qt']).Qt.FindDirectChildrenOnly)
            if w.isVisibleTo(vp)]


class TestTablaSinFantasmas:
    """Cada renglón tiene exactamente dos widgets (cantidad y Quitar): ni uno
    de más tras agregar, quitar, traer o restaurar un pendiente."""

    def _revisar(self, caja):
        QApplication.processEvents()
        assert len(widgets_visibles_en_la_tabla(caja)) == 2 * len(caja.cart)
        for fila in range(caja.cart_table.rowCount()):
            assert caja.cart_table.cellWidget(fila, 1) is not None
            assert caja.cart_table.cellWidget(fila, 4) is not None

    def test_agregar_y_quitar(self, local):
        nube, bases, cajas = local
        c1 = cajas['pc1']
        for fid in ('fb-cuaderno', 'fb-birome', 'fb-hilo', 'fb-cuaderno', 'fb-botones'):
            c1.add_to_cart(cp.producto(bases['pc1'], fid))
        self._revisar(c1)
        c1.update_quantity(0, 3)              # redibujo parcial de la fila
        self._revisar(c1)
        c1.remove_from_cart(1)
        self._revisar(c1)
        c1.remove_from_cart(0)
        c1.remove_from_cart(0)
        self._revisar(c1)

    def test_traer_y_restaurar_pendiente(self, local):
        nube, bases, cajas = local
        c1, c3 = cajas['pc1'], cajas['pc3']
        cargar(c1, bases['pc1'], 'fb-cuaderno', 'fb-hilo', 'fb-birome')
        assert ve(c3, 'pc1', 3)
        traer(c3, 'pc1')
        self._revisar(c3)
        assert cp.esperar(lambda: not c1.cart, 8)
        self._revisar(c1)
        c3._add_to_pending()
        self._revisar(c3)
        pid = c3.pending_model.get_all()[0]['id']
        c3._restore_pending(pid)
        self._revisar(c3)
