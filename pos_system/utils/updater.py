"""
Verificador y aplicador de actualizaciones via GitHub Releases.
Compara la versión actual, descarga el ZIP y lo aplica sin intervención del usuario.
"""
import logging
import threading
import tempfile
import zipfile
import urllib.request
from pathlib import Path

logger = logging.getLogger('__main__')

_update_cache = {
    'checked': False,
    'latest_version': None,
    'download_url': None,
    'release_url': None,
    'release_notes': None,
}


def _version_tuple(v: str):
    try:
        parts = str(v).lstrip('v').split('.')
        return tuple(int(x) for x in parts)
    except Exception:
        return (0, 0, 0)


def check_for_updates(current_version: str, repo: str, callback=None):
    """
    Consulta la API de GitHub Releases en un hilo secundario.
    Busca primero un asset .zip (portable), luego .exe (installer).
    """
    def _check():
        try:
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

            # Buscar asset: installer .exe primero, luego .zip portable
            download_url = None
            asset_type = None
            for asset in data.get('assets', []):
                name = asset.get('name', '').lower()
                if name.endswith('.exe') and 'setup' in name:
                    download_url = asset.get('browser_download_url')
                    asset_type = 'installer'
                    break
            if not download_url:
                for asset in data.get('assets', []):
                    name = asset.get('name', '').lower()
                    if name.endswith('.zip'):
                        download_url = asset.get('browser_download_url')
                        asset_type = 'zip'
                        break

            _update_cache['asset_type'] = asset_type

            has_update = _version_tuple(tag) > _version_tuple(current_version)

            _update_cache.update({
                'checked': True,
                'latest_version': tag,
                'download_url': download_url,
                'release_url': release_url,
                'release_notes': release_notes,
            })

            logger.info(f"Updater: version actual={current_version}, ultima={tag}, hay_update={has_update}, download_url={download_url or 'NINGUNA'}")
            if has_update and not download_url:
                logger.warning("Updater: hay nueva version pero no tiene asset ZIP/EXE en el release")
            if has_update and download_url:
                logger.info(f"Updater: iniciando descarga de v{tag}...")

            if callback:
                callback(has_update, _update_cache.copy())

        except Exception as e:
            logger.warning(f"Updater: error al verificar actualizaciones: {e}")
            if callback:
                callback(False, {})

    threading.Thread(target=_check, daemon=True).start()


def download_and_apply_update(download_url: str, app_dir: str,
                               on_progress=None, on_done=None):
    """
    Si el asset es un installer .exe: lo descarga y lo corre con /VERYSILENT.
    Si es un .zip: extrae y aplica via .bat.

    on_progress(stage): 'downloading' | 'extracting' | 'applying'
    on_done(success: bool)
    """
    is_installer = download_url.lower().endswith('.exe')

    def _run():
        temp_dir = None
        try:
            temp_dir = Path(tempfile.mkdtemp(prefix='spos_upd_'))

            if on_progress:
                on_progress('downloading')

            if is_installer:
                # ── Installer .exe ────────────────────────────────────────
                installer_path = temp_dir / 'SistemaPOS_Setup.exe'
                urllib.request.urlretrieve(download_url, installer_path)

                if on_progress:
                    on_progress('applying')

                import subprocess
                subprocess.Popen(
                    [str(installer_path),
                     '/VERYSILENT', '/NORESTART',
                     '/CLOSEAPPLICATIONS', '/FORCECLOSEAPPLICATIONS'],
                    creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW,
                    close_fds=True,
                )
            else:
                # ── ZIP portable ──────────────────────────────────────────
                zip_path = temp_dir / 'update.zip'
                urllib.request.urlretrieve(download_url, zip_path)

                if on_progress:
                    on_progress('extracting')

                extract_dir = temp_dir / 'extracted'
                extract_dir.mkdir()
                with zipfile.ZipFile(zip_path, 'r') as zf:
                    zf.extractall(extract_dir)
                zip_path.unlink()

                inner_dirs = [d for d in extract_dir.iterdir() if d.is_dir()]
                new_files_dir = inner_dirs[0] if inner_dirs else extract_dir
                app_dir_path = Path(app_dir)
                app_exe = app_dir_path / 'SistemaPOS.exe'

                bat_path = Path(tempfile.gettempdir()) / 'spos_update.bat'
                bat_content = (
                    '@echo off\r\n'
                    'timeout /t 4 /nobreak >nul\r\n'
                    f'xcopy /E /I /Y "{new_files_dir}\\*" "{app_dir_path}\\"\r\n'
                    f'start "" "{app_exe}"\r\n'
                    f'rd /s /q "{temp_dir}"\r\n'
                    'del "%~f0"\r\n'
                )
                bat_path.write_text(bat_content, encoding='utf-8')

                if on_progress:
                    on_progress('applying')

                import subprocess
                subprocess.Popen(
                    ['cmd', '/c', str(bat_path)],
                    creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW,
                    close_fds=True,
                )

            if on_done:
                on_done(True)

        except Exception as e:
            logger.warning(f'Updater: error al descargar/aplicar update: {e}')
            if on_done:
                on_done(False)

    threading.Thread(target=_run, daemon=True).start()


def open_release_page(release_url: str):
    import webbrowser
    if release_url:
        webbrowser.open(release_url)
