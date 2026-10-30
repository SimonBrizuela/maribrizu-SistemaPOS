"""
Traer la venta de otra caja contra el emulador de Firestore.

Lo mismo que `test_carritos_vivos_pantalla.py` pero con `NubeCarritos` de
verdad: transacciones, hora del servidor y escuchas de Firestore. Primero la
nube sola con muchas cajas a la vez; después tres pantallas de Ventas en el
mismo proceso, cada una con su base y su pc_id, recorriendo el caso del local:

  cargar en la Compu 1 → verla desde la Compu 3 → la 1 escanea algo justo
  antes y la 3 la pide (llega con lo último) → la 1 escanea justo después
  (venta nueva, no se pierde) → la 3 agrega mercería → la 1 no puede pedirla
  con carrito propio, lo deja pendiente y la trae de vuelta → la 1 cobrando:
  rechaza → la 1 sin internet: no responde, no se trae ni se duplica → cobrar
  en la 1: a nombre de Ana, stock una vez, desaparece de todos lados → el
  pendiente vuelve con su cajero.

Con CAPTURAS_CARRITOS=<carpeta> guarda una imagen de cada paso.

Sin emulador se saltea. Comando (desde la raíz del repo):

  firebase emulators:exec --config pos_system/tests/emulador/firebase.json \
    --only firestore --project demo-pos-pedidos \
    "python -m pytest pos_system/tests/test_carritos_vivos_emulador.py -q"
"""
import os
import sys
import threading
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

EMULADOR = os.environ.get('FIRESTORE_EMULATOR_HOST')
PROYECTO = 'demo-pos-pedidos'
CAPTURAS = os.environ.get('CAPTURAS_CARRITOS')
pytestmark = pytest.mark.skipif(not EMULADOR, reason='sin emulador de Firestore')

pytest.importorskip('PyQt5.QtWidgets')
from PyQt5.QtWidgets import QApplication  # noqa: E402

from pos_system.models import carrito_vivo as cv  # noqa: E402

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


@pytest.fixture
def nube():
    from pos_system.utils.carritos_vivos_nube import NubeCarritos
    return NubeCarritos(cliente())


def docs(nube):
    return {d.id: d.to_dict() for d in nube.db.collection(cv.COLECCION).stream()}


def con_venta(nube):
    return sorted(p for p, d in docs(nube).items() if cv.tiene_venta(d))


RENGLON = {'product_id': 12, 'product_name': 'CUADERNO', 'quantity': 1, 'unit_price': 3500.0,
           'subtotal': 3500.0}


def estado(pc, epoch, n=1, cobrando=False):
    items = [dict(RENGLON, product_name=f'CUADERNO {i}') for i in range(n)]
    return cv.armar_estado(pc, pc, epoch, cv.serializar_items(items), items, 'Ana', cobrando=cobrando)


def quien(pc):
    return {'pc_id': pc, 'pc_nombre': f'Compu {pc[-1]}', 'cajero': 'x'}


# ════════════════════════════════════════════════════════════════════════════
def pedir_y_entregar(nube, origen_pc, epoch, quien, estado_origen, sol_id):
    r = nube.pedir(origen_pc, epoch, quien, sol_id)
    if not r.ok:
        return r
    return nube.entregar(origen_pc, origen_pc, sol_id, epoch, estado_origen)


class TestNube:
    def test_ida_y_vuelta(self, nube):
        e1 = estado('pc1', 'E1')
        assert nube.publicar('pc1', 'Compu 1', 'E1', e1).accion == 'escribir'
        assert pedir_y_entregar(nube, 'pc1', 'E1', quien('pc3'), e1, 's1').ok
        assert con_venta(nube) == ['pc3']
        assert docs(nube)['pc3']['pendiente_de_cargar'] is True
        e3 = estado('pc3', 'E1', n=3)
        assert nube.publicar('pc3', 'Compu 3', 'E1', e3).accion == 'escribir'
        assert pedir_y_entregar(nube, 'pc3', 'E1', quien('pc1'), e3, 's2').ok
        assert con_venta(nube) == ['pc1']
        assert len(cv.leer_items(docs(nube)['pc1']['items_json'])) == 3
        # La publicación vieja de la que entregó no la revive.
        assert nube.publicar('pc3', 'Compu 3', 'E1', e3).accion == 'nada'

    def test_la_hora_es_del_servidor_y_la_vigencia_se_mide_con_ella(self, nube):
        nube.publicar('pc1', 'Compu 1', 'E1', estado('pc1', 'E1'))
        snap = nube.db.collection(cv.COLECCION).document('pc1').get()
        assert cv.vigente(snap.to_dict(), snap.read_time)
        assert not cv.vigente(snap.to_dict(), cv.mas(snap.read_time, cv.VIGENCIA_SEG + 1))

    def test_cobrando_no_se_pide(self, nube):
        nube.publicar('pc1', 'Compu 1', 'E1', estado('pc1', 'E1', cobrando=True))
        r = nube.pedir('pc1', 'E1', quien('pc3'), 's1')
        assert not r.ok and r.motivo == 'cobrando'

    def test_sin_respuesta_se_cancela_y_ya_no_se_puede_entregar(self, nube):
        e1 = estado('pc1', 'E1')
        nube.publicar('pc1', 'Compu 1', 'E1', e1)
        assert nube.pedir('pc1', 'E1', quien('pc3'), 's1').ok
        assert nube.cancelar('pc1', 's1').accion == 'cancelar'
        r = nube.entregar('pc1', 'Compu 1', 's1', 'E1', e1)
        assert not r.ok and r.motivo == 'cancelada'
        assert con_venta(nube) == ['pc1']

    def test_la_solicitud_vence_con_la_hora_del_servidor(self, nube):
        """No se adelanta el reloj del emulador: se escribe una solicitud con
        `pedida_en` vieja, como si la origen la viera después de un corte."""
        from datetime import timedelta
        e1 = estado('pc1', 'E1')
        nube.publicar('pc1', 'Compu 1', 'E1', e1)
        snap = nube.db.collection(cv.COLECCION).document('pc1').get()
        vieja = snap.read_time - timedelta(seconds=cv.VALIDEZ_SOLICITUD_SEG + 5)
        nube.db.collection(cv.SOLICITUDES).document('pc1').set(
            {**cv.solicitud_nueva('s1', 'E1', quien('pc3')), 'pedida_en': vieja})
        r = nube.entregar('pc1', 'Compu 1', 's1', 'E1', e1)
        assert not r.ok and r.motivo == 'vencida'
        assert con_venta(nube) == ['pc1']

    def test_seis_cajas_piden_a_la_vez_una_sola_queda(self, nube):
        from pos_system.utils.carritos_vivos_nube import NubeCarritos
        e1 = estado('pc1', 'E1')
        nube.publicar('pc1', 'Compu 1', 'E1', e1)
        resultados = {}
        barrera = threading.Barrier(6)

        def intentar(pc):
            propia = NubeCarritos(cliente())       # cada caja con su cliente
            barrera.wait()
            resultados[pc] = propia.pedir('pc1', 'E1', quien(pc), f'sol-{pc}')

        hilos = [threading.Thread(target=intentar, args=(f'pc{n}',)) for n in range(2, 8)]
        for h in hilos:
            h.start()
        for h in hilos:
            h.join()
        ganadores = [pc for pc, r in resultados.items() if r.ok]
        assert len(ganadores) == 1
        assert all(r.motivo == 'pedida_por_otra' for r in resultados.values() if not r.ok)
        assert nube.entregar('pc1', 'Compu 1', f'sol-{ganadores[0]}', 'E1', e1).ok
        assert con_venta(nube) == ganadores

    def test_cancelar_y_entregar_a_la_vez_nunca_quedan_las_dos(self, nube):
        """La que pidió se cansa justo cuando la origen entrega. Muchas
        vueltas: o se canceló (la venta sigue en la 1) o llegó (está en la 3)."""
        from pos_system.utils.carritos_vivos_nube import NubeCarritos
        origen, destino = NubeCarritos(cliente()), NubeCarritos(cliente())
        for vuelta in range(8):
            e1 = estado('pc1', f'E{vuelta}')
            for pc in ('pc1', 'pc3'):
                nube.db.collection(cv.COLECCION).document(pc).delete()
            origen.publicar('pc1', 'Compu 1', f'E{vuelta}', e1)
            sid = f's{vuelta}'
            assert destino.pedir('pc1', f'E{vuelta}', quien('pc3'), sid).ok
            res = {}
            h1 = threading.Thread(target=lambda: res.update(e=origen.entregar('pc1', 'Compu 1', sid, f'E{vuelta}', e1)))
            h2 = threading.Thread(target=lambda: res.update(c=destino.cancelar('pc1', sid)))
            h1.start(); h2.start(); h1.join(); h2.join()
            if res['e'].ok:
                assert res['c'].accion == 'llego' or res['c'].accion == 'nada'
                assert con_venta(nube) == ['pc3']
            else:
                assert res['c'].accion == 'cancelar'
                assert con_venta(nube) == ['pc1']


# ════════════════════════════════════════════════════════════════════════════
class TestTresCajas:
    def test_el_recorrido_del_local(self, app, tmp_path, monkeypatch):
        import pos_system.utils.firebase_sync as fs
        monkeypatch.setattr(fs, 'init_firebase_sync', lambda: None)
        monkeypatch.setattr(fs, 'get_firebase_sync', lambda: None)
        from pos_system.tests import cajas_de_prueba as cp
        from pos_system.utils.carritos_vivos_nube import NubeCarritos

        bases = {'pc1': cp.crear_base(tmp_path / 'c1.db'),
                 'pc2': cp.crear_base(tmp_path / 'c2.db', corrimiento=5),
                 'pc3': cp.crear_base(tmp_path / 'c3.db', corrimiento=3)}
        nubes = {pc: NubeCarritos(cliente()) for pc in bases}
        c1 = cp.abrir_caja(bases['pc1'], 'pc1', 'Compu 1', 'Ana', nube=nubes['pc1'], espera_entrega=4)
        c2 = cp.abrir_caja(bases['pc2'], 'pc2', 'Compu 2', 'Caro', nube=nubes['pc2'], espera_entrega=4)
        c3 = cp.abrir_caja(bases['pc3'], 'pc3', 'Compu 3', 'Beto', nube=nubes['pc3'], espera_entrega=4)
        cajas = (c1, c2, c3)
        for c in cajas:
            c.resize(1280, 720)
            c.show()
            _ABIERTAS.append(c)
        n = [0]

        def foto(nombre, *ventanas):
            if not CAPTURAS:
                return
            from PyQt5.QtCore import QEvent
            QApplication.processEvents()
            QApplication.sendPostedEvents(None, QEvent.DeferredDelete)
            QApplication.processEvents()
            for v in ventanas:
                n[0] += 1
                caja = v._nombre_caja() if hasattr(v, '_nombre_caja') else 'dialogo'
                v.grab().save(os.path.join(CAPTURAS, f'{n[0]:02d}_{nombre}_{caja.replace(" ", "")}.png'))

        def ve(caja, pc, renglones=None):
            def _c():
                d = next((x for x in caja.carrito_compartido.carritos() if x['pc_id'] == pc), None)
                return d is not None and (renglones is None or d['renglones'] == renglones)
            return cp.esperar(_c, 15)

        def nombres(caja):
            return [i['product_name'] for i in caja.cart]

        try:
            # 1. Cargar en la Compu 1.
            for fid in ('fb-cuaderno', 'fb-cuaderno', 'fb-birome'):
                c1.add_to_cart(cp.producto(bases['pc1'], fid))
            assert ve(c3, 'pc1', 2) and ve(c2, 'pc1', 2)
            foto('carga_en_1', c1, c3)

            # 2. Vista previa desde la Compu 3.
            from pos_system.ui.otras_cajas import CarritoAjenoDialog
            dlg = CarritoAjenoDialog(c3, 'pc1', c3.carrito_compartido.doc_de('pc1'),
                                     c3._bloqueo_para_traer, ahora=c3.carrito_compartido.ahora)
            _ABIERTAS.append(dlg)
            dlg.show()
            assert dlg._traer.isEnabled() and dlg._tabla.rowCount() == 2
            foto('vista_previa', dlg)
            dlg.hide()

            # 3. La Compu 1 escanea algo que todavía no publicó y la 3 la pide:
            #    la 1 entrega su carrito de ese momento, con lo último.
            c1.carrito_compartido._debounce.setInterval(60_000)
            c1.add_to_cart(cp.producto(bases['pc1'], 'fb-hilo'))
            capturo_pidiendo = []

            def _durante():
                if not capturo_pidiendo and c3.aviso_venta.texto().startswith('Pidiendo'):
                    capturo_pidiendo.append(1)
                    foto('pidiendo', c3)
            reloj = __import__('PyQt5.QtCore', fromlist=['QTimer']).QTimer()
            reloj.timeout.connect(_durante)
            reloj.start(30)
            c3._traer_venta('pc1', c3.carrito_compartido.doc_de('pc1'))
            reloj.stop()
            c1.carrito_compartido._debounce.setInterval(20)
            assert nombres(c3) == ['CUADERNO RIVADAVIA 50 HOJAS', 'BIROME BIC AZUL', 'HILO DE COSER NEGRO']
            assert [i['quantity'] for i in c3.cart] == [2, 1, 1]
            assert c3._cart_cajero_fijo == 'Ana'
            assert not c1.cart and c1.aviso_venta.texto() == 'La venta pasó a la Compu 3.'
            foto('traida', c3, c1)

            # 4. Escaneo en la 1 justo después de entregar: es una venta nueva.
            c1.add_to_cart(cp.producto(bases['pc1'], 'fb-botones'))
            assert nombres(c1) == ['BOTONES NACARADOS X 6']
            foto('escaneo_despues_de_entregar', c1)

            # 5. Agregar mercería en la 3; la 1 no puede pedirla con su carrito.
            c3.add_to_cart(cp.producto(bases['pc3'], 'fb-botones'))
            assert ve(c1, 'pc3', 4)
            assert c1._bloqueo_para_traer(c1.carrito_compartido.doc_de('pc3')).startswith('Tu carrito tiene')
            dlg1 = CarritoAjenoDialog(c1, 'pc3', c1.carrito_compartido.doc_de('pc3'),
                                      c1._bloqueo_para_traer, ahora=c1.carrito_compartido.ahora)
            _ABIERTAS.append(dlg1)
            dlg1.show()
            assert not dlg1._traer.isEnabled()
            foto('bloqueada_con_carrito_propio', dlg1)
            dlg1.hide()
            c1._add_to_pending()                       # deja lo suyo en pendiente

            # 6. Vuelve a la 1 con todo, a nombre de Ana.
            c1._traer_venta('pc3', c1.carrito_compartido.doc_de('pc3'))
            assert len(c1.cart) == 4 and c1._cart_cajero_fijo == 'Ana'
            assert cp.esperar(lambda: not c3.cart, 15)
            foto('vuelve_a_1', c1, c3)

            # 7. La 1 está cobrando: la 3 pide y la 1 contesta que no.
            assert ve(c3, 'pc1', 4)
            c1._cobrando_vivo = True       # pantalla de cobro abierta, todavía sin publicar
            c3._traer_venta('pc1', c3.carrito_compartido.doc_de('pc1'))
            assert not c3.cart and c3.aviso_venta.texto() == 'La están cobrando en la Compu 1.'
            assert len(c1.cart) == 4
            foto('origen_cobrando', c3)
            c1._cobrando_vivo = False

            # 8. La 1 se queda sin internet (deja de escuchar y de publicar): la
            #    3 pide, nadie contesta, se cancela y la venta sigue en la 1.
            c1.carrito_compartido._escucha_sol.unsubscribe()
            c1.carrito_compartido._escucha_sol = None
            c1.carrito_compartido._revision.stop()
            c3._traer_venta('pc1', c3.carrito_compartido.doc_de('pc1'))
            assert not c3.cart
            assert c3.aviso_venta.texto() == 'La Compu 1 no responde: la venta sigue allá.'
            assert len(c1.cart) == 4
            foto('origen_no_responde', c3)
            # Vuelve: abre la escucha, ve la solicitud cancelada y no entrega.
            c1.carrito_compartido._abrir_escuchas()
            c1.carrito_compartido._revision.start()
            cp.asentar(1.5)
            assert len(c1.cart) == 4 and con_venta(nubes['pc1']) == ['pc1']

            # 9. Cobrar en la 1: a nombre de Ana, stock una sola vez, y la venta
            #    desaparece de todos lados.
            cantidad = {i['product_name']: i['quantity'] for i in c1.cart}
            with cp.cobro_sin_preguntas():
                c1.complete_sale()
            ventas1 = cp.ventas(bases['pc1'])
            assert len(ventas1) == 1 and ventas1[0]['turno_nombre'] == 'Ana'
            assert cp.ventas(bases['pc3']) == [] and cp.ventas(bases['pc2']) == []
            assert cp.stock(bases['pc1'], 'fb-cuaderno') == 20 - cantidad['CUADERNO RIVADAVIA 50 HOJAS']
            assert cp.stock(bases['pc3'], 'fb-cuaderno') == 20
            cp.asentar(1.5)
            assert con_venta(nubes['pc1']) == []
            for c in (c2, c3):
                assert cp.esperar(lambda c=c: c.carrito_compartido.carritos() == [], 15)
            foto('cobrada', c1, c3)

            # 10. El pendiente de la 1 (los botones) vuelve a nombre de Ana.
            c1._restore_pending(c1.pending_model.get_all()[0]['id'])
            assert nombres(c1) == ['BOTONES NACARADOS X 6'] and c1._cart_cajero_fijo == 'Ana'
        finally:
            for c in cajas:
                c.carrito_compartido.detener()
                c.hide()
