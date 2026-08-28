"""
Lo que mantiene viva a cada caja: el actualizador, el arranque con Windows, el
registro de errores y la terminal remota.

Son piezas que nadie mira hasta que fallan, y cuando fallan lo hacen calladas:
una PC que se queda en una versión vieja sigue vendiendo, pero deja de entender
lo que escriben las demás. Por eso lo que más se prueba acá es la comparación de
versiones y qué pasa cuando algo del camino no está.

La terminal remota es la puerta más grande que tiene el sistema: desde el panel
se le manda una línea de comandos a una PC del local. Lo que importa es que la
salida vuelva completa, que un comando colgado no deje la PC tomada para
siempre, y que dos comandos no se pisen.
"""
import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.utils import updater
from pos_system.utils.logger import get_logger, setup_logger


# ── Comparar versiones ───────────────────────────────────────────────────────

class TestVersiones:
    """`_version_tuple` decide si una PC se actualiza o se queda atrás."""

    def test_una_version_mas_nueva_gana(self):
        assert updater._version_tuple('3.0.66') > updater._version_tuple('3.0.65')
        assert updater._version_tuple('3.1.0') > updater._version_tuple('3.0.99')
        assert updater._version_tuple('4.0.0') > updater._version_tuple('3.9.9')

    def test_el_numero_se_compara_como_numero_no_como_texto(self):
        # Como texto, "3.0.9" sería mayor que "3.0.10" y la PC no se
        # actualizaría nunca más a partir de la décima versión del mes.
        assert updater._version_tuple('3.0.10') > updater._version_tuple('3.0.9')
        assert updater._version_tuple('3.0.100') > updater._version_tuple('3.0.99')

    def test_la_v_de_adelante_no_molesta(self):
        # Los tags de GitHub vienen como `v3.0.65`.
        assert updater._version_tuple('v3.0.65') == updater._version_tuple('3.0.65')

    def test_la_misma_version_no_es_mas_nueva(self):
        assert not (updater._version_tuple('3.0.65') > updater._version_tuple('3.0.65'))

    def test_una_version_con_menos_partes_se_ordena_igual(self):
        assert updater._version_tuple('3.1') > updater._version_tuple('3.0.65')
        assert updater._version_tuple('3.0') < updater._version_tuple('3.0.1')

    def test_algo_que_no_es_una_version_queda_ultimo(self):
        # Ante la duda no se ofrece la actualización: bajar un release con el
        # tag mal escrito es peor que quedarse en la versión que anda.
        assert updater._version_tuple('main') == (0, 0, 0)
        assert updater._version_tuple('') == (0, 0, 0)
        assert updater._version_tuple(None) == (0, 0, 0)
        assert not (updater._version_tuple('main') > updater._version_tuple('3.0.65'))


# ── Buscar la actualización ──────────────────────────────────────────────────

class RespuestaFalsa:
    def __init__(self, cuerpo):
        import json
        self._cuerpo = json.dumps(cuerpo).encode('utf-8')

    def read(self):
        return self._cuerpo

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


def release(tag, assets):
    return {
        'tag_name': tag,
        'html_url': f'https://github.com/x/y/releases/tag/{tag}',
        'body': 'Notas de la versión',
        'assets': [{'name': n, 'browser_download_url': f'https://d/{n}'}
                   for n in assets],
    }


def consultar(monkeypatch, actual, datos):
    """Corre el chequeo y devuelve (hay_update, info). Sin hilo: se espera."""
    monkeypatch.setattr(updater.urllib.request, 'urlopen',
                        lambda req, timeout=None: RespuestaFalsa(datos))
    resultado = {}

    def anotar(hay, info):
        resultado['hay'] = hay
        resultado['info'] = info

    updater.check_for_updates(actual, 'x/y', anotar)
    import time
    for _ in range(200):
        if resultado:
            break
        time.sleep(0.01)
    return resultado.get('hay'), resultado.get('info', {})


class TestBuscarActualizacion:

    def test_avisa_cuando_hay_una_nueva(self, monkeypatch):
        hay, info = consultar(monkeypatch, '3.0.65',
                              release('v3.0.66', ['SistemaPOS-setup.exe']))
        assert hay is True
        assert info['latest_version'] == '3.0.66'
        assert info['download_url'].endswith('SistemaPOS-setup.exe')

    def test_estando_al_dia_no_avisa(self, monkeypatch):
        hay, _ = consultar(monkeypatch, '3.0.66',
                           release('v3.0.66', ['SistemaPOS-setup.exe']))
        assert hay is False

    def test_prefiere_el_instalador_al_zip(self, monkeypatch):
        # El .zip portable no actualiza el acceso directo ni las asociaciones:
        # se usa sólo cuando no hay instalador.
        _, info = consultar(monkeypatch, '3.0.65',
                            release('v3.0.66', ['SistemaPOS.zip',
                                                'SistemaPOS-setup.exe']))
        assert info['download_url'].endswith('.exe')
        assert info['asset_type'] == 'installer'

    def test_sin_instalador_se_queda_con_el_zip(self, monkeypatch):
        _, info = consultar(monkeypatch, '3.0.65',
                            release('v3.0.66', ['SistemaPOS.zip']))
        assert info['download_url'].endswith('.zip')
        assert info['asset_type'] == 'zip'

    def test_una_version_nueva_sin_archivo_no_ofrece_nada_para_bajar(self, monkeypatch):
        # Pasa cuando el build de GitHub Actions falló: el tag está, el
        # instalador no.
        hay, info = consultar(monkeypatch, '3.0.65', release('v3.0.66', []))
        assert hay is True
        assert info['download_url'] is None

    def test_sin_internet_no_rompe_el_arranque_del_pos(self, monkeypatch):
        def revienta(req, timeout=None):
            raise OSError('sin red')

        monkeypatch.setattr(updater.urllib.request, 'urlopen', revienta)
        resultado = {}
        updater.check_for_updates('3.0.65', 'x/y',
                                  lambda hay, info: resultado.update(hay=hay))
        import time
        for _ in range(200):
            if resultado:
                break
            time.sleep(0.01)
        assert resultado['hay'] is False


# ── El registro ──────────────────────────────────────────────────────────────

class TestRegistro:

    def test_devuelve_un_logger_usable(self):
        log = setup_logger('prueba_pos')
        log.info('algo')          # no tiene que tirar nada
        assert log.name == 'prueba_pos'

    def test_pedirlo_dos_veces_no_duplica_los_mensajes(self):
        # Con dos handlers, cada línea sale dos veces y el archivo del día se
        # vuelve ilegible.
        uno = setup_logger('prueba_repetida')
        cuantos = len(uno.handlers)
        otro = setup_logger('prueba_repetida')
        assert len(otro.handlers) == cuantos

    def test_get_logger_devuelve_el_mismo(self):
        assert get_logger('prueba_pos') is get_logger('prueba_pos')


# ── Arranque con Windows ─────────────────────────────────────────────────────

class TestArranqueConWindows:

    def test_se_puede_preguntar_sin_romper(self):
        from pos_system.utils import autostart
        assert autostart.is_autostart_enabled() in (True, False)

    def test_prender_y_apagar_deja_el_registro_como_estaba(self):
        from pos_system.utils import autostart
        antes = autostart.is_autostart_enabled()
        try:
            if autostart.set_autostart(True):
                assert autostart.is_autostart_enabled() is True
            if autostart.set_autostart(False):
                assert autostart.is_autostart_enabled() is False
        finally:
            autostart.set_autostart(antes)


# ── La terminal remota ───────────────────────────────────────────────────────

class DocFalso:
    def __init__(self):
        self.escrituras = []

    def set(self, datos, merge=False):
        self.escrituras.append(dict(datos))

    @property
    def ultimo(self):
        return self.escrituras[-1] if self.escrituras else {}


@pytest.fixture
def terminal(monkeypatch):
    from pos_system.ui import remote_terminal_listener as rt
    monkeypatch.setattr(rt, '_get_pc_id', lambda: 'PC-CAJA')
    # `QThread.__init__` necesita una QApplication; se saltea porque lo que se
    # prueba es la ejecución del comando, no el hilo.
    monkeypatch.setattr(rt.QThread, '__init__', lambda self: None)
    t = rt.RemoteTerminalListener(firebase_db=None)
    t._cwd = None
    t._busy = False
    return t


class TestTerminalRemota:

    def test_lo_que_imprime_el_comando_vuelve_al_panel(self, terminal, monkeypatch):
        import pos_system.ui.remote_terminal_listener as rt

        def corrida_falsa(cmd, **kw):
            return subprocess.CompletedProcess(cmd, 0, stdout='hola\n', stderr='')

        monkeypatch.setattr(rt.subprocess, 'run', corrida_falsa)
        doc = DocFalso()
        terminal._execute(doc, {'cmd': 'echo hola'})

        assert doc.escrituras[0]['status'] == 'running'
        assert doc.ultimo['status'] == 'done'
        assert 'hola' in doc.ultimo['output']

    def test_lo_que_sale_por_error_tambien(self, terminal, monkeypatch):
        # Es justamente lo que se quiere ver desde el panel cuando algo falla.
        import pos_system.ui.remote_terminal_listener as rt
        monkeypatch.setattr(rt.subprocess, 'run',
                            lambda cmd, **kw: subprocess.CompletedProcess(
                                cmd, 1, stdout='', stderr='no se reconoce'))
        doc = DocFalso()
        terminal._execute(doc, {'cmd': 'comando_inventado'})
        assert 'no se reconoce' in doc.ultimo['output']

    def test_un_comando_mudo_no_devuelve_una_respuesta_vacia(self, terminal, monkeypatch):
        # Una respuesta en blanco se lee como "no llegó"; el cartel dice que sí
        # corrió y no dijo nada.
        import pos_system.ui.remote_terminal_listener as rt
        monkeypatch.setattr(rt.subprocess, 'run',
                            lambda cmd, **kw: subprocess.CompletedProcess(
                                cmd, 0, stdout='', stderr=''))
        doc = DocFalso()
        terminal._execute(doc, {'cmd': 'cls'})
        assert doc.ultimo['output'] == '(sin salida)'

    def test_una_salida_enorme_se_recorta(self, terminal, monkeypatch):
        # Un `dir /s` del disco entero no entra en un documento de Firestore.
        import pos_system.ui.remote_terminal_listener as rt
        monkeypatch.setattr(rt.subprocess, 'run',
                            lambda cmd, **kw: subprocess.CompletedProcess(
                                cmd, 0, stdout='x' * 50_000, stderr=''))
        doc = DocFalso()
        terminal._execute(doc, {'cmd': 'dir /s'})
        assert len(doc.ultimo['output']) <= 8000

    def test_un_comando_colgado_corta_a_los_treinta_segundos(self, terminal, monkeypatch):
        # Sin el corte, la PC queda tomada y no acepta ningún comando más.
        import pos_system.ui.remote_terminal_listener as rt

        def se_cuelga(cmd, **kw):
            raise subprocess.TimeoutExpired(cmd, 30)

        monkeypatch.setattr(rt.subprocess, 'run', se_cuelga)
        doc = DocFalso()
        terminal._execute(doc, {'cmd': 'pause'})
        assert doc.ultimo['status'] == 'error'
        assert 'Timeout' in doc.ultimo['output']

    def test_un_error_inesperado_igual_contesta(self, terminal, monkeypatch):
        # Si no contestara, el panel se queda con el cartel de "ejecutando".
        import pos_system.ui.remote_terminal_listener as rt

        def revienta(cmd, **kw):
            raise OSError('no se pudo abrir la consola')

        monkeypatch.setattr(rt.subprocess, 'run', revienta)
        doc = DocFalso()
        terminal._execute(doc, {'cmd': 'algo'})
        assert doc.ultimo['status'] == 'error'
        assert 'no se pudo abrir' in doc.ultimo['output']

    def test_un_comando_vacio_no_hace_nada(self, terminal):
        doc = DocFalso()
        terminal._execute(doc, {'cmd': '   '})
        terminal._execute(doc, {})
        assert doc.escrituras == []

    def test_cambiar_de_carpeta_se_recuerda_para_el_proximo(self, terminal, tmp_path):
        # Sin memoria, cada comando arrancaría de cero y `cd` sería inútil.
        doc = DocFalso()
        terminal._execute(doc, {'cmd': f'cd {tmp_path}'})
        assert doc.ultimo['status'] == 'done'
        assert os.path.normcase(terminal._cwd) == os.path.normcase(str(tmp_path))
        assert os.path.normcase(doc.ultimo['cwd']) == os.path.normcase(str(tmp_path))

    def test_cd_relativo_parte_de_donde_estaba(self, terminal, tmp_path):
        (tmp_path / 'adentro').mkdir()
        doc = DocFalso()
        terminal._execute(doc, {'cmd': f'cd {tmp_path}'})
        terminal._execute(doc, {'cmd': 'cd adentro'})
        assert doc.ultimo['status'] == 'done'
        assert terminal._cwd.endswith('adentro')

    def test_cd_a_una_carpeta_que_no_existe_lo_dice_y_no_se_mueve(self, terminal, tmp_path):
        doc = DocFalso()
        terminal._execute(doc, {'cmd': f'cd {tmp_path}'})
        terminal._execute(doc, {'cmd': 'cd carpeta_que_no_existe'})
        assert doc.ultimo['status'] == 'error'
        assert 'No existe' in doc.ultimo['output']
        assert os.path.normcase(terminal._cwd) == os.path.normcase(str(tmp_path))

    def test_cd_solo_lleva_a_la_carpeta_del_usuario(self, terminal):
        doc = DocFalso()
        terminal._execute(doc, {'cmd': 'cd'})
        assert doc.ultimo['status'] == 'done'
        assert terminal._cwd == os.path.expanduser('~')

    def test_el_comando_corre_donde_dejo_el_cd(self, terminal, monkeypatch, tmp_path):
        import pos_system.ui.remote_terminal_listener as rt
        visto = {}

        def espia(cmd, **kw):
            visto['cwd'] = kw.get('cwd')
            return subprocess.CompletedProcess(cmd, 0, stdout='ok', stderr='')

        monkeypatch.setattr(rt.subprocess, 'run', espia)
        doc = DocFalso()
        terminal._execute(doc, {'cmd': f'cd {tmp_path}'})
        terminal._execute(doc, {'cmd': 'dir'})
        assert os.path.normcase(visto['cwd']) == os.path.normcase(str(tmp_path))

    def test_no_abre_una_ventana_de_consola_en_la_caja(self, terminal, monkeypatch):
        # La PC está atendiendo: una ventana negra que aparece sola asusta.
        import pos_system.ui.remote_terminal_listener as rt
        visto = {}

        def espia(cmd, **kw):
            visto.update(kw)
            return subprocess.CompletedProcess(cmd, 0, stdout='ok', stderr='')

        monkeypatch.setattr(rt.subprocess, 'run', espia)
        terminal._execute(DocFalso(), {'cmd': 'dir'})
        assert visto['creationflags'] == rt._CREATE_NO_WINDOW
        assert visto['timeout'] == 30
