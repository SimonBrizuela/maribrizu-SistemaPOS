"""
El latido de cada caja y los comandos que se le mandan desde el panel.

Cada PC avisa cada 20 minutos que sigue viva, con qué versión corre, quién está
atendiendo y cuándo sincronizó por última vez. Es lo que lee "Estado de PCs" en
el panel, y es la única forma de enterarse de que una caja dejó de sincronizar
antes de que falte un día de ventas.

Por el mismo camino viajan los comandos: desde el panel se le puede pedir a una
PC que suba lo que tiene, que baje el catálogo o que se reinicie. Ahí lo que
importa es lo que NO tiene que pasar:

  · un comando de antes de que arrancara esta sesión no se ejecuta (si no, al
    reabrir el POS se repetiría lo que quedó a medias);
  · el mismo comando no se ejecuta dos veces aunque el listener re-emita;
  · apretar el botón tres veces no dispara tres sincronizaciones en paralelo.
"""
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.utils import pc_status
from pos_system.utils.pc_status import PCStatusReporter


class DocFalso:
    """El documento del comando en Firestore: guarda lo que se le escribe."""

    def __init__(self):
        self.escrituras = []

    def set(self, datos, merge=False):
        self.escrituras.append(dict(datos))

    @property
    def ultimo(self):
        return self.escrituras[-1] if self.escrituras else {}

    @property
    def estados(self):
        return [e.get('status') for e in self.escrituras if 'status' in e]


class BaseFalsa:
    def __init__(self, productos=0, revienta=False):
        self.productos = productos
        self.revienta = revienta

    def execute_query(self, *_a, **_k):
        if self.revienta:
            raise RuntimeError('base cerrada')
        return [{'n': self.productos}]


class FirebaseFalso:
    """Lo mínimo que toca `_write_status`: `db.collection().document().set()`."""

    def __init__(self, enabled=True):
        self.enabled = enabled
        self.escrituras = []
        fb = self

        class _Doc:
            def __init__(self, pc_id):
                self.pc_id = pc_id

            def set(self, datos, merge=False):
                fb.escrituras.append((self.pc_id, dict(datos)))

        class _Col:
            def __init__(self, nombre):
                self.nombre = nombre

            def document(self, pc_id):
                return _Doc(pc_id)

        class _Db:
            def collection(self, nombre):
                return _Col(nombre)

        self.db = _Db()


@pytest.fixture
def firebase(monkeypatch):
    fb = FirebaseFalso()
    monkeypatch.setattr(pc_status, 'get_firebase_sync', lambda: fb)
    monkeypatch.setattr(pc_status, '_get_pc_id', lambda: 'PC-CAJA')
    return fb


def armar(firebase=None, contexto=None, handlers=None, productos=12, base=None):
    """Un reportero listo para usar, sin arrancar el hilo del latido."""
    return PCStatusReporter(
        base if base is not None else BaseFalsa(productos),
        (lambda: contexto) if contexto is not None else (lambda: {}),
        handlers or {},
    )


def esperar_hilos():
    """Los comandos corren en su propio hilo: se espera a que terminen."""
    for _ in range(200):
        if not any(h.name.startswith('pc-cmd-') for h in threading.enumerate()):
            return
        time.sleep(0.01)


# ── El latido ────────────────────────────────────────────────────────────────

def test_el_latido_dice_quien_es_y_como_esta(firebase):
    r = armar(contexto={'cajero': 'Marta', 'turno_nombre': 'Mañana',
                        'cash_register_id': 7})
    r._write_heartbeat()

    pc_id, datos = firebase.escrituras[-1]
    assert pc_id == 'PC-CAJA'
    assert datos['pc_id'] == 'PC-CAJA'
    assert datos['cajero_actual'] == 'Marta'
    assert datos['turno_actual'] == 'Mañana'
    assert datos['cash_register_id'] == 7
    assert datos['productos_locales'] == 12
    assert datos['app_version']
    assert datos['last_seen']
    assert datos['online_hint'] is True


def test_el_primer_latido_se_marca_como_arranque(firebase):
    r = armar()
    r._write_heartbeat(initial=True)
    assert 'initial_at' in firebase.escrituras[-1][1]

    r._write_heartbeat()
    assert 'initial_at' not in firebase.escrituras[-1][1]


def test_sin_cajero_no_escribe_none_en_el_panel(firebase):
    # El panel muestra este campo tal cual: un "None" ahí se lee como un error.
    r = armar(contexto={})
    r._write_heartbeat()
    datos = firebase.escrituras[-1][1]
    assert datos['cajero_actual'] == ''
    assert datos['turno_actual'] == ''


def test_si_el_contexto_revienta_la_pc_igual_avisa_que_esta_viva(firebase):
    # Una caja que deja de latir se lee como caída. Que falle leer quién está
    # atendiendo no puede tener esa consecuencia.
    def contexto_roto():
        raise RuntimeError('la ventana se cerro')

    r = PCStatusReporter(BaseFalsa(), contexto_roto, {})
    r._write_heartbeat()
    assert firebase.escrituras[-1][1]['pc_id'] == 'PC-CAJA'


def test_si_la_base_local_no_responde_el_latido_sale_igual(firebase):
    r = armar(base=BaseFalsa(revienta=True))
    r._write_heartbeat()
    assert firebase.escrituras[-1][1]['productos_locales'] == 0


def test_sin_firebase_no_rompe_ni_escribe(monkeypatch):
    monkeypatch.setattr(pc_status, 'get_firebase_sync', lambda: None)
    monkeypatch.setattr(pc_status, '_get_pc_id', lambda: 'PC-CAJA')
    armar()._write_heartbeat()   # no tiene que tirar nada


def test_firebase_apagado_tampoco(monkeypatch):
    fb = FirebaseFalso(enabled=False)
    monkeypatch.setattr(pc_status, 'get_firebase_sync', lambda: fb)
    monkeypatch.setattr(pc_status, '_get_pc_id', lambda: 'PC-CAJA')
    armar()._write_heartbeat()
    assert fb.escrituras == []


def test_lo_que_sincronizo_queda_en_el_proximo_latido(firebase):
    r = armar()
    r.record_sync({'ventas': 12, 'productos': 3})
    datos = firebase.escrituras[-1][1]
    assert datos['last_sync_summary'] == {'ventas': 12, 'productos': 3}
    assert datos['last_sync_at']


def test_un_error_queda_anotado_y_recortado(firebase):
    # El panel lo muestra en una línea: un stack trace entero lo desarma.
    r = armar()
    r.record_error('x' * 500)
    r._write_heartbeat()
    assert len(firebase.escrituras[-1][1]['last_error']) < 260


# ── Los comandos del panel ───────────────────────────────────────────────────

def test_un_comando_se_ejecuta_y_queda_marcado_como_hecho(firebase):
    hechos = []
    r = armar(handlers={'sync_upload': lambda p: hechos.append(p) or 'listo'})
    doc = DocFalso()

    r._process_command(doc, {'issued_at': '9999-01-01T00:00:00',
                             'command': 'sync_upload', 'status': 'pending',
                             'param': None})
    esperar_hilos()

    assert hechos == [None]
    assert doc.estados == ['running', 'done']
    assert doc.ultimo['result'] == 'listo'
    assert doc.ultimo['finished_at']


def test_un_handler_que_falla_no_deja_el_comando_colgado(firebase):
    # Si quedara en "running", el panel muestra el cartel para siempre.
    def revienta(_):
        raise ValueError('se cayo la red')

    r = armar(handlers={'sync_upload': revienta})
    doc = DocFalso()
    r._process_command(doc, {'issued_at': '9999-01-01T00:00:00',
                             'command': 'sync_upload', 'status': 'pending'})
    esperar_hilos()

    assert doc.estados[-1] == 'failed'
    assert 'se cayo la red' in doc.ultimo['result']


def test_un_handler_puede_contestar_que_no_pudo(firebase):
    r = armar(handlers={'sync_upload': lambda p: (False, 'sin conexion')})
    doc = DocFalso()
    r._process_command(doc, {'issued_at': '9999-01-01T00:00:00',
                             'command': 'sync_upload', 'status': 'pending'})
    esperar_hilos()

    assert doc.estados[-1] == 'failed'
    assert doc.ultimo['result'] == 'sin conexion'


def test_un_comando_que_no_existe_se_rechaza_con_su_motivo(firebase):
    r = armar(handlers={'sync_upload': lambda p: 'ok'})
    doc = DocFalso()
    r._process_command(doc, {'issued_at': '9999-01-01T00:00:00',
                             'command': 'formatear_todo', 'status': 'pending'})

    assert doc.estados == ['failed']
    assert 'no soportado' in doc.ultimo['result']


def test_un_comando_de_antes_de_arrancar_no_se_reejecuta(firebase):
    # El POS se cerró con un sync a medias. Al reabrir, ese comando quedó
    # "pending" en la base: volver a correrlo sería repetir lo que quedó
    # colgado sin que nadie lo pidiera.
    corridos = []
    r = armar(handlers={'sync_upload': lambda p: corridos.append(p)})
    doc = DocFalso()

    r._process_command(doc, {'issued_at': '2000-01-01T00:00:00',
                             'command': 'sync_upload', 'status': 'pending'})
    esperar_hilos()

    assert corridos == []
    assert doc.estados == ['failed']
    assert 'abandonado' in doc.ultimo['result']


def test_uno_viejo_ya_terminado_se_deja_como_esta(firebase):
    r = armar(handlers={'sync_upload': lambda p: 'ok'})
    doc = DocFalso()
    r._process_command(doc, {'issued_at': '2000-01-01T00:00:00',
                             'command': 'sync_upload', 'status': 'done'})
    assert doc.escrituras == []


def test_el_mismo_comando_no_se_ejecuta_dos_veces(firebase):
    # El listener re-emite el documento cada vez que algo cambia —incluido el
    # propio "running" que escribe el POS—. Sin recordar cuál ya se procesó,
    # cada comando se ejecutaría en bucle.
    corridos = []
    r = armar(handlers={'sync_upload': lambda p: corridos.append(1)})
    doc = DocFalso()
    orden = {'issued_at': '9999-01-01T00:00:00', 'command': 'sync_upload',
             'status': 'pending'}

    r._process_command(doc, orden)
    esperar_hilos()
    r._process_command(doc, orden)
    esperar_hilos()

    assert len(corridos) == 1


def test_apretar_el_boton_tres_veces_no_dispara_tres_sincronizaciones(firebase):
    # Cada toque escribe un documento con otro `issued_at`, así que la defensa
    # de "ya lo vi" no alcanza: hace falta el candado.
    arrancados = threading.Event()
    seguir = threading.Event()
    corridos = []

    def lento(_):
        corridos.append(1)
        arrancados.set()
        seguir.wait(2)
        return 'ok'

    r = armar(handlers={'sync_upload': lento})
    doc1, doc2, doc3 = DocFalso(), DocFalso(), DocFalso()

    r._process_command(doc1, {'issued_at': '9999-01-01T00:00:01',
                              'command': 'sync_upload', 'status': 'pending'})
    assert arrancados.wait(2)

    r._process_command(doc2, {'issued_at': '9999-01-01T00:00:02',
                              'command': 'sync_upload', 'status': 'pending'})
    r._process_command(doc3, {'issued_at': '9999-01-01T00:00:03',
                              'command': 'sync_upload', 'status': 'pending'})

    assert doc2.estados == ['failed']
    assert 'en curso' in doc2.ultimo['result']
    assert doc3.estados == ['failed']

    seguir.set()
    esperar_hilos()
    assert len(corridos) == 1


def test_terminado_uno_se_puede_mandar_el_siguiente(firebase):
    # El candado tiene que soltarse: si no, la PC queda sorda para siempre.
    corridos = []
    r = armar(handlers={'sync_upload': lambda p: corridos.append(1) or 'ok'})

    for i in (1, 2):
        doc = DocFalso()
        r._process_command(doc, {'issued_at': f'9999-01-01T00:00:0{i}',
                                 'command': 'sync_upload', 'status': 'pending'})
        esperar_hilos()

    assert len(corridos) == 2


def test_un_comando_sin_nombre_o_sin_fecha_se_ignora(firebase):
    r = armar(handlers={'sync_upload': lambda p: 'ok'})
    doc = DocFalso()
    r._process_command(doc, {'issued_at': '', 'command': 'sync_upload'})
    r._process_command(doc, {'issued_at': '9999-01-01T00:00:00', 'command': ''})
    r._process_command(doc, {})
    assert doc.escrituras == []


def test_el_parametro_llega_al_handler(firebase):
    recibido = []
    r = armar(handlers={'sync_download': lambda p: recibido.append(p) or 'ok'})
    doc = DocFalso()
    r._process_command(doc, {'issued_at': '9999-01-01T00:00:00',
                             'command': 'sync_download', 'status': 'pending',
                             'param': {'desde': '2026-08-01'}})
    esperar_hilos()
    assert recibido == [{'desde': '2026-08-01'}]


def test_al_terminar_un_comando_la_pc_vuelve_a_latir(firebase):
    # Así el panel ve el resultado sin esperar los 20 minutos del próximo latido.
    r = armar(handlers={'sync_upload': lambda p: 'ok'})
    firebase.escrituras.clear()
    r._process_command(DocFalso(), {'issued_at': '9999-01-01T00:00:00',
                                    'command': 'sync_upload', 'status': 'pending'})
    esperar_hilos()
    assert any(pc == 'PC-CAJA' for pc, _ in firebase.escrituras)


# ── El singleton ─────────────────────────────────────────────────────────────

def test_el_reportero_se_arranca_una_sola_vez(firebase, monkeypatch):
    monkeypatch.setattr(pc_status, '_reporter', None)
    monkeypatch.setattr(PCStatusReporter, 'start', lambda self: None)

    uno = pc_status.init_reporter(BaseFalsa(), lambda: {}, {})
    otro = pc_status.init_reporter(BaseFalsa(), lambda: {}, {})

    assert uno is otro
    assert pc_status.get_reporter() is uno
    monkeypatch.setattr(pc_status, '_reporter', None)


def test_parar_no_marca_la_pc_como_caida(firebase):
    # Si escribiera online_hint=False y el proceso siguiera vivo por algún
    # motivo, la PC quedaría marcada offline aunque esté atendiendo.
    r = armar()
    firebase.escrituras.clear()
    r.stop()
    assert all(d.get('online_hint') is not False for _, d in firebase.escrituras)
