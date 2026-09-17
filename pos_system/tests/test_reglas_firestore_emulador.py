"""
Las reglas de Firestore de verdad (`firestore.rules`) cargadas en el emulador.

Las otras pruebas contra el emulador corren sin reglas: prueban transacciones,
no permisos. Esta carga el archivo que se publica, así que además de mirar cada
caso confirma que las reglas compilan (con un error de sintaxis el emulador no
arranca). Sin sesión: es lo que ve un cliente de la tienda.

    firebase emulators:exec --only firestore --project demo-reglas ^
        "python -m pytest pos_system/tests/test_reglas_firestore_emulador.py -q"

(desde la raíz: usa el `firebase.json` del repo, que es el que carga las reglas).
Con el emulador sin reglas de las otras pruebas, se saltea.
"""
import json
import os
import urllib.error
import urllib.request

import pytest

EMULADOR = os.environ.get('FIRESTORE_EMULATOR_HOST')
BASE = f'http://{EMULADOR}/v1/projects/demo-reglas/databases/(default)/documents'


def crear(col, doc_id, campos):
    req = urllib.request.Request(f'{BASE}/{col}?documentId={doc_id}', data=json.dumps({'fields': campos}).encode(),
                                 method='POST', headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req).close()
        return True
    except urllib.error.HTTPError as e:
        if e.code == 403:
            return False
        raise


def _con_reglas():
    """El emulador sin reglas deja escribir todo: ahí esta prueba no dice nada."""
    if not EMULADOR:
        return False
    try:
        return crear('tienda_pedidos_eventos', 'sonda__reglas__0', {'pedido_id': {'stringValue': 'sonda'}}) is False
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _con_reglas(), reason='sin el emulador con firestore.rules cargado')


def comprobante(pid, url):
    return crear('tienda_comprobantes', pid, {
        'pedido_id': {'stringValue': pid}, 'url': {'stringValue': url},
        'tipo': {'stringValue': 'imagen'}, 'subido_en': {'timestampValue': '2026-09-16T12:00:00Z'}})


@pytest.mark.parametrize('url, permitido', [
    ('https://firebasestorage.googleapis.com/v0/b/mari-d7c71.firebasestorage.app/o/comprobantes%2Fp%2F1.webp'
     '?alt=media&token=x', True),
    ('https://firebasestorage.googleapis.com/v0/b/mari-d7c71.appspot.com/o/c.pdf?alt=media', True),
    # Con los puntos sin escapar pasaba un dominio que no es de Google.
    ('https://firebasestorage-googleapis.com/v0/b/mari-d7c71.firebasestorage.app/o/c.pdf', False),
    ('https://firebasestorageXgoogleapis.com/v0/b/mari-d7c71.firebasestorage.app/o/c.pdf', False),
    ('https://firebasestorage.googleapis.com/v0/b/otro-proyecto.appspot.com/o/c.pdf', False),
    ('https://ejemplo.com/comprobante.pdf', False),
])
def test_el_comprobante_solo_del_storage_de_la_tienda(url, permitido):
    pid = f'p{abs(hash(url)) % 10**8}'
    assert comprobante(pid, url) is permitido


def test_el_registro_de_eventos_no_lo_escribe_un_cliente():
    assert crear('tienda_pedidos_eventos', 'p1__entregar__x', {'pedido_id': {'stringValue': 'p1'}}) is False
