"""
Verificador de actualizaciones via GitHub Releases.
Compara la versión actual con el último release publicado en GitHub.
"""
import logging
import threading

logger = logging.getLogger(__name__)

_update_cache = {
    'checked': False,
    'latest_version': None,
    'download_url': None,
    'release_url': None,
    'release_notes': None,
}


def _version_tuple(v: str):
    """Convierte '2.1.0' en tupla (2, 1, 0) para comparar."""
    try:
        parts = str(v).lstrip('v').split('.')
        return tuple(int(x) for x in parts)
    except Exception:
        return (0, 0, 0)


def check_for_updates(current_version: str, repo: str, callback=None):
    """
    Consulta la API de GitHub Releases en un hilo secundario.
    No bloquea la UI.

    Args:
        current_version: Versión actual del sistema (ej: "2.0.0")
        repo: Repositorio GitHub en formato "usuario/repo"
        callback: función(has_update: bool, info: dict) llamada cuando termina
    """
    def _check():
        try:
            import urllib.request
            import json

            url = f"https://api.github.com/repos/{repo}/releases/latest"
            req = urllib.request.Request(url, headers={
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'SistemaPOS-Updater'
            })
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode())

            tag = data.get('tag_name', '').lstrip('v')
            release_url = data.get('html_url', '')
            release_notes = data.get('body', '')

            # Buscar el .exe entre los assets
            download_url = None
            for asset in data.get('assets', []):
                if asset.get('name', '').endswith('.exe'):
                    download_url = asset.get('browser_download_url')
                    break

            has_update = _version_tuple(tag) > _version_tuple(current_version)

            _update_cache['checked'] = True
            _update_cache['latest_version'] = tag
            _update_cache['download_url'] = download_url
            _update_cache['release_url'] = release_url
            _update_cache['release_notes'] = release_notes

            logger.info(f"Updater: versión actual={current_version}, última={tag}, hay_update={has_update}")

            if callback:
                callback(has_update, _update_cache.copy())

        except Exception as e:
            logger.debug(f"Updater: no se pudo verificar actualizaciones: {e}")
            if callback:
                callback(False, {})

    t = threading.Thread(target=_check, daemon=True)
    t.start()


def open_release_page(release_url: str):
    """Abre la página del release en el navegador."""
    import webbrowser
    if release_url:
        webbrowser.open(release_url)


def download_and_open(download_url: str):
    """Abre la URL de descarga del .exe en el navegador."""
    import webbrowser
    if download_url:
        webbrowser.open(download_url)
