"""
Con qué credencial arranca cada caja.

Desde el blindaje de la v3.0.54, la clave de servicio ya no viaja adentro del
instalador: cada PC pide un token de una hora a una función de Netlify, con un
secreto que le dejó el instalador y atado a su `pc_id`.

Es la parte del sistema donde un error no se ve: la PC arranca, atiende todo el
día y no sincroniza nada. Lo que se prueba acá es exactamente eso —qué pasa
cuando algo del camino falla— y una trampa que ya costó una versión: **un BOM
invisible en el archivo del secreto**. El endpoint compara byte a byte, así que
un caracter que no se ve devuelve 401 y la caja queda muda.
"""
import json
import os
import sys
import urllib.error

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.utils import firebase_credentials as fc


@pytest.fixture(autouse=True)
def entorno_limpio(monkeypatch, tmp_path):
    """Sin variables de entorno y con una carpeta propia como 'bundle'."""
    for var in ('POS_PROVISION_URL', 'POS_BOOTSTRAP_SECRET', 'POS_PROJECT_ID'):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(fc, '_bundle_dir', lambda: str(tmp_path))
    monkeypatch.chdir(tmp_path)
    return tmp_path


# ── Limpiar el secreto ───────────────────────────────────────────────────────

def test_el_bom_invisible_se_saca():
    # Costó la v3.0.54: un archivo generado con Out-File arrastra un BOM que no
    # se ve en ningún editor. El endpoint compara byte a byte, contesta 401 y la
    # PC arranca sin credenciales, muda y sin sincronizar.
    assert fc._limpio('﻿SECRETO') == 'SECRETO'
    assert fc._limpio('SECRETO﻿') == 'SECRETO'
    assert fc._limpio('​SECRETO​') == 'SECRETO'
    assert fc._limpio('  SECRETO\n') == 'SECRETO'


def test_lo_vacio_no_se_convierte_en_texto():
    assert fc._limpio(None) == ''
    assert fc._limpio('') == ''
    assert fc._limpio('   ') == ''


def test_un_secreto_normal_no_se_toca():
    assert fc._limpio('abc-123_XYZ') == 'abc-123_XYZ'


# ── De dónde sale la configuración ───────────────────────────────────────────

def test_las_variables_de_entorno_mandan(monkeypatch, entorno_limpio):
    # Es lo que permite probar contra otro proyecto sin tocar el instalador.
    (entorno_limpio / 'provision.json').write_text(
        json.dumps({'url': 'https://del-archivo', 'secret': 'DEL-ARCHIVO'}),
        encoding='utf-8')
    monkeypatch.setenv('POS_PROVISION_URL', 'https://del-entorno')
    monkeypatch.setenv('POS_BOOTSTRAP_SECRET', 'DEL-ENTORNO')
    monkeypatch.setenv('POS_PROJECT_ID', 'proyecto-de-prueba')

    cfg = fc.load_provision_config()
    assert cfg['url'] == 'https://del-entorno'
    assert cfg['secret'] == 'DEL-ENTORNO'
    assert cfg['project_id'] == 'proyecto-de-prueba'


def test_sin_entorno_lee_el_archivo_del_instalador(entorno_limpio):
    (entorno_limpio / 'provision.json').write_text(
        json.dumps({'url': 'https://provision', 'secret': 'S3CR3T0',
                    'project_id': 'mari-d7c71'}),
        encoding='utf-8')
    cfg = fc.load_provision_config()
    assert cfg['secret'] == 'S3CR3T0'
    assert cfg['project_id'] == 'mari-d7c71'


def test_el_archivo_con_bom_se_lee_igual(entorno_limpio):
    # Con `utf-8` a secas, json.load explota antes de llegar al secreto.
    (entorno_limpio / 'provision.json').write_text(
        json.dumps({'url': 'https://provision', 'secret': 'S3CR3T0'}),
        encoding='utf-8-sig')
    assert fc.load_provision_config()['secret'] == 'S3CR3T0'


def test_el_secreto_con_bom_adentro_del_json_tambien(entorno_limpio):
    (entorno_limpio / 'provision.json').write_text(
        json.dumps({'url': 'https://provision', 'secret': '﻿S3CR3T0 '}),
        encoding='utf-8')
    assert fc.load_provision_config()['secret'] == 'S3CR3T0'


def test_tambien_lo_busca_donde_lo_deja_el_empaquetador(entorno_limpio):
    interno = entorno_limpio / '_internal'
    interno.mkdir()
    (interno / 'provision.json').write_text(
        json.dumps({'secret': 'DESDE-INTERNAL'}), encoding='utf-8')
    assert fc.load_provision_config()['secret'] == 'DESDE-INTERNAL'


def test_un_archivo_roto_no_voltea_el_arranque(entorno_limpio):
    (entorno_limpio / 'provision.json').write_text('{esto no es json',
                                                   encoding='utf-8')
    assert fc.load_provision_config() == {}


def test_un_archivo_sin_secreto_no_cuenta(entorno_limpio):
    (entorno_limpio / 'provision.json').write_text(
        json.dumps({'url': 'https://provision'}), encoding='utf-8')
    assert fc.load_provision_config() == {}


def test_sin_nada_devuelve_vacio(entorno_limpio):
    assert fc.load_provision_config() == {}


def test_la_clave_local_se_encuentra_si_quedo_alguna(entorno_limpio):
    (entorno_limpio / 'firebase_key.json').write_text('{}', encoding='utf-8')
    assert fc.find_local_key().endswith('firebase_key.json')


def test_sin_clave_local_devuelve_vacio(entorno_limpio, monkeypatch):
    # `find_local_key` también mira la raíz del repo, que en la máquina de
    # desarrollo sí tiene una clave: se aísla para probar la PC del local, que
    # es la que no la tiene.
    monkeypatch.setattr(fc.os.path, 'exists', lambda ruta: False)
    assert fc.find_local_key() == ''


# ── Pedir el token ───────────────────────────────────────────────────────────

class RespuestaFalsa:
    def __init__(self, cuerpo):
        self._cuerpo = json.dumps(cuerpo).encode('utf-8')

    def read(self):
        return self._cuerpo

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


def token_remoto(**extra):
    return fc._RemoteToken('https://provision', 'S3CR3T0',
                           'PC-CAJA', 'DESKTOP-X', '3.0.65', **extra)


def test_el_token_se_pide_con_la_identidad_de_esta_pc(monkeypatch):
    # El token queda atado al pc_id: sin eso, el secreto de una PC serviría
    # para cualquiera.
    enviados = {}

    def falso_urlopen(req, timeout=None):
        enviados['url'] = req.full_url
        enviados['cuerpo'] = json.loads(req.data.decode('utf-8'))
        return RespuestaFalsa({'access_token': 'ya29.TOKEN', 'expires_in': 3600})

    monkeypatch.setattr(fc.urllib.request, 'urlopen', falso_urlopen)

    t = token_remoto()
    t.refresh(None)

    assert enviados['url'] == 'https://provision'
    assert enviados['cuerpo'] == {
        'pc_id': 'PC-CAJA', 'hostname': 'DESKTOP-X',
        'app_version': '3.0.65', 'secret': 'S3CR3T0',
    }
    assert t.token == 'ya29.TOKEN'


def test_el_token_se_da_por_vencido_antes_de_tiempo(monkeypatch):
    # Con margen cero, una consulta larga arranca con un token vivo y termina
    # con uno vencido, y el error sale del lado del listener.
    monkeypatch.setattr(fc.urllib.request, 'urlopen',
                        lambda req, timeout=None: RespuestaFalsa(
                            {'access_token': 'T', 'expires_in': 3600}))
    t = token_remoto()
    t.refresh(None)

    faltan = (t.expiry - fc.datetime.utcnow()).total_seconds()
    assert faltan < 3600
    assert faltan > 3600 - 600


def test_un_token_de_vida_cortita_igual_dura_algo(monkeypatch):
    monkeypatch.setattr(fc.urllib.request, 'urlopen',
                        lambda req, timeout=None: RespuestaFalsa(
                            {'access_token': 'T', 'expires_in': 10}))
    t = token_remoto()
    t.refresh(None)
    assert (t.expiry - fc.datetime.utcnow()).total_seconds() >= 55


def test_un_rechazo_del_endpoint_se_explica(monkeypatch):
    # 401 es el síntoma del secreto mal copiado: el mensaje tiene que traer el
    # código y lo que contestó el servidor, o no hay por dónde empezar.
    class Http401(urllib.error.HTTPError):
        def __init__(self):
            super().__init__('https://provision', 401, 'Unauthorized', {}, None)

        def read(self):
            return b'secreto invalido'

    def revienta(req, timeout=None):
        raise Http401()

    monkeypatch.setattr(fc.urllib.request, 'urlopen', revienta)

    with pytest.raises(RuntimeError) as e:
        token_remoto().refresh(None)
    assert '401' in str(e.value)
    assert 'secreto invalido' in str(e.value)


def test_sin_red_lo_dice_sin_tirar_un_stack(monkeypatch):
    def revienta(req, timeout=None):
        raise OSError('no route to host')

    monkeypatch.setattr(fc.urllib.request, 'urlopen', revienta)
    with pytest.raises(RuntimeError) as e:
        token_remoto().refresh(None)
    assert 'inalcanzable' in str(e.value)


def test_una_respuesta_sin_token_no_pasa_por_buena(monkeypatch):
    monkeypatch.setattr(fc.urllib.request, 'urlopen',
                        lambda req, timeout=None: RespuestaFalsa({'ok': True}))
    with pytest.raises(RuntimeError) as e:
        token_remoto().refresh(None)
    assert 'access_token' in str(e.value)


# ── Con qué se arranca ───────────────────────────────────────────────────────

def test_con_provisioning_andando_se_usa_el_token(monkeypatch, entorno_limpio):
    (entorno_limpio / 'provision.json').write_text(
        json.dumps({'url': 'https://provision', 'secret': 'S3CR3T0',
                    'project_id': 'mari-d7c71'}), encoding='utf-8')
    monkeypatch.setattr(fc.urllib.request, 'urlopen',
                        lambda req, timeout=None: RespuestaFalsa(
                            {'access_token': 'T', 'expires_in': 3600}))

    cred, project, como = fc.resolve_credential('PC-CAJA', 'DESKTOP-X', '3.0.65')
    assert cred is not None
    assert project == 'mari-d7c71'
    assert 'remoto' in como


def test_si_el_endpoint_esta_caido_se_cae_a_la_clave_local(monkeypatch, entorno_limpio):
    # Preferimos la clave local antes que dejar la caja sin sincronizar: un día
    # sin subir ventas se arrastra en el balance del mes.
    (entorno_limpio / 'provision.json').write_text(
        json.dumps({'url': 'https://provision', 'secret': 'S3CR3T0'}),
        encoding='utf-8')
    (entorno_limpio / 'firebase_key.json').write_text('{}', encoding='utf-8')

    def revienta(req, timeout=None):
        raise OSError('caido')

    monkeypatch.setattr(fc.urllib.request, 'urlopen', revienta)
    monkeypatch.setattr(fc.fb_credentials, 'Certificate', lambda ruta: ('CERT', ruta))

    cred, project, como = fc.resolve_credential('PC-CAJA', 'DESKTOP-X', '3.0.65')
    assert cred[0] == 'CERT'
    assert 'local' in como


def test_sin_endpoint_ni_clave_lo_dice_con_todas_las_letras(monkeypatch, entorno_limpio):
    monkeypatch.setattr(fc, 'find_local_key', lambda: '')
    (entorno_limpio / 'provision.json').write_text(
        json.dumps({'url': 'https://provision', 'secret': 'S3CR3T0'}),
        encoding='utf-8')

    def revienta(req, timeout=None):
        raise OSError('caido')

    monkeypatch.setattr(fc.urllib.request, 'urlopen', revienta)

    cred, project, como = fc.resolve_credential('PC-CAJA', 'DESKTOP-X', '3.0.65')
    assert cred is None
    assert 'no hay key local' in como


def test_una_pc_sin_configurar_lo_dice_distinto(entorno_limpio, monkeypatch):
    # Es otro problema: a esta PC nunca le llegó el instalador nuevo.
    monkeypatch.setattr(fc, 'find_local_key', lambda: '')
    cred, project, como = fc.resolve_credential('PC-CAJA', 'DESKTOP-X', '3.0.65')
    assert cred is None
    assert 'sin provision.json' in como


def test_sin_provisioning_pero_con_clave_local_arranca(monkeypatch, entorno_limpio):
    (entorno_limpio / 'firebase_key.json').write_text('{}', encoding='utf-8')
    monkeypatch.setattr(fc.fb_credentials, 'Certificate', lambda ruta: ('CERT', ruta))

    cred, project, como = fc.resolve_credential('PC-CAJA', 'DESKTOP-X', '3.0.65')
    assert cred[0] == 'CERT'
    assert project is None
