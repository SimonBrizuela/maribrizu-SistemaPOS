"""
Credenciales de Firebase para el POS, obtenidas de forma remota.

Antes cada instalacion llevaba `firebase_key.json` adentro del ejecutable, y
el instalador se publica en un GitHub Release publico: cualquiera podia bajar
el ZIP, extraer la service account y quedarse con Admin SDK sobre todo el
proyecto, salteando las reglas de Firestore.

Ahora la service account vive solo en Netlify. La PC pide un access token al
endpoint /api/provision, lo usa una hora y lo renueva sola. En disco no queda
ninguna credencial de larga vida.

Orden de resolucion al iniciar:
  1. Provisioning remoto (lo normal desde v3.0.54).
  2. firebase_key.json local, si existe — respaldo para instalaciones viejas
     y para correr scripts de mantenimiento desde la maquina de desarrollo.

Si el endpoint no responde, el POS sigue funcionando: las ventas se graban en
SQLite igual y la sincronizacion se reintenta despues.
"""

import json
import logging
import os
import sys
import threading
import urllib.error
import urllib.request
from datetime import datetime, timedelta

import google.auth.credentials
from firebase_admin import credentials as fb_credentials

logger = logging.getLogger(__name__)

DEFAULT_PROVISION_URL = "https://posmr87.netlify.app/api/provision"
DEFAULT_PROJECT_ID    = "mari-d7c71"

# Margen antes del vencimiento real: renovamos temprano para que nunca se use
# un token que expira en pleno request.
_EXPIRY_MARGIN_SECONDS = 300
_HTTP_TIMEOUT = 20


def _bundle_dir() -> str:
    """Carpeta donde viven los recursos, tanto congelado como en desarrollo."""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def _limpio(valor: str) -> str:
    """Saca BOM, zero-width y espacios de los bordes.

    El endpoint compara el secreto byte a byte. Un BOM invisible arrastrado
    desde un archivo generado con Out-File devuelve 401 y la PC arranca sin
    credenciales, muda y sin sincronizar (paso en la v3.0.54).
    """
    return str(valor or '').lstrip('﻿​').strip().strip('﻿​')


def load_provision_config() -> dict:
    """Lee la URL y el secreto de provisioning.

    Prioridad: variables de entorno (utiles para probar) y despues el
    provision.json que el instalador deja junto al ejecutable.
    """
    url    = _limpio(os.environ.get('POS_PROVISION_URL')) or DEFAULT_PROVISION_URL
    secret = _limpio(os.environ.get('POS_BOOTSTRAP_SECRET'))
    if secret:
        return {
            'url':        url,
            'secret':     secret,
            'project_id': _limpio(os.environ.get('POS_PROJECT_ID')) or DEFAULT_PROJECT_ID,
        }

    base = _bundle_dir()
    for candidate in (
        os.path.join(base, 'provision.json'),
        os.path.join(base, '_internal', 'provision.json'),
    ):
        if os.path.exists(candidate):
            try:
                # utf-8-sig: si el archivo quedo con BOM al inicio, json.load
                # con 'utf-8' explota antes de llegar a leer el secreto.
                with open(candidate, 'r', encoding='utf-8-sig') as fh:
                    data = json.load(fh)
                secret = _limpio(data.get('secret'))
                if secret:
                    return {
                        'url':        _limpio(data.get('url')) or DEFAULT_PROVISION_URL,
                        'secret':     secret,
                        'project_id': _limpio(data.get('project_id')) or DEFAULT_PROJECT_ID,
                    }
            except Exception as e:
                logger.warning(f"Firebase: provision.json ilegible ({candidate}): {e}")

    return {}


def find_local_key() -> str:
    """Ruta al firebase_key.json local, si quedo alguno. '' si no hay."""
    base = _bundle_dir()
    for candidate in (
        os.path.join(base, 'firebase_key.json'),
        os.path.join(base, '_internal', 'firebase_key.json'),
        os.path.join(os.path.dirname(__file__), '..', '..', 'firebase_key.json'),
        'firebase_key.json',
    ):
        if os.path.exists(candidate):
            return candidate
    return ''


class _RemoteToken(google.auth.credentials.Credentials):
    """Access token de Google pedido a la Netlify Function.

    google-auth llama a refresh() solo cuando hace falta: al inicio y cada vez
    que el token queda vencido. El SDK de Firestore usa estas credenciales
    tanto para REST como para los canales gRPC de los listeners.
    """

    def __init__(self, url: str, secret: str, pc_id: str, hostname: str, app_version: str):
        super().__init__()
        self._url         = url
        self._secret      = secret
        self._pc_id       = pc_id
        self._hostname    = hostname
        self._app_version = app_version
        self._lock        = threading.Lock()

    def refresh(self, request):  # noqa: ARG002 — la firma la impone google-auth
        payload = json.dumps({
            'pc_id':       self._pc_id,
            'hostname':    self._hostname,
            'app_version': self._app_version,
            'secret':      self._secret,
        }).encode('utf-8')

        req = urllib.request.Request(
            self._url,
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )

        with self._lock:
            try:
                with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
                    data = json.loads(resp.read().decode('utf-8'))
            except urllib.error.HTTPError as e:
                detalle = e.read().decode('utf-8', errors='replace')[:200]
                raise RuntimeError(
                    f"provisioning rechazado (HTTP {e.code}): {detalle}"
                ) from e
            except Exception as e:
                raise RuntimeError(f"provisioning inalcanzable: {e}") from e

            token = data.get('access_token')
            if not token:
                raise RuntimeError("provisioning no devolvio access_token")

            vida = int(data.get('expires_in') or 3600)
            self.token = token
            # google-auth compara contra un datetime naive en UTC.
            self.expiry = datetime.utcnow() + timedelta(
                seconds=max(60, vida - _EXPIRY_MARGIN_SECONDS)
            )
            logger.info(f"Firebase: token renovado, vigente {vida}s")


class RemoteCredential(fb_credentials.Base):
    """Adaptador para que firebase_admin acepte el token remoto."""

    def __init__(self, url: str, secret: str, pc_id: str, hostname: str, app_version: str):
        self._credential = _RemoteToken(url, secret, pc_id, hostname, app_version)

    def get_credential(self):
        return self._credential


def resolve_credential(pc_id: str, hostname: str, app_version: str):
    """Decide con que credencial arrancar.

    Devuelve (credencial, project_id, descripcion). Si no hay ninguna
    disponible devuelve (None, None, motivo) y el sync queda desactivado.

    El provisioning remoto se valida pidiendo un token de entrada: si el
    endpoint esta caido preferimos caer al key local (cuando existe) antes que
    dejar la PC sin sincronizar.
    """
    cfg = load_provision_config()

    if cfg:
        cred = RemoteCredential(cfg['url'], cfg['secret'], pc_id, hostname, app_version)
        try:
            cred.get_credential().refresh(None)
            return cred, cfg['project_id'], 'provisioning remoto'
        except Exception as e:
            logger.error(f"Firebase: provisioning remoto fallo ({e}).")

    key_path = find_local_key()
    if key_path:
        return (fb_credentials.Certificate(key_path), None,
                f'service account local ({key_path})')

    if cfg:
        return None, None, 'el provisioning remoto fallo y no hay key local'
    return None, None, 'sin provision.json ni firebase_key.json'
