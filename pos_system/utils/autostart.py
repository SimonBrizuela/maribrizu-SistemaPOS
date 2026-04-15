"""
Utilidad para habilitar/deshabilitar el inicio automático de la app con Windows.
Usa el registro HKCU\Software\Microsoft\Windows\CurrentVersion\Run.
"""
import sys
import os
import logging

logger = logging.getLogger(__name__)

_REG_PATH = r"Software\Microsoft\Windows\CurrentVersion\Run"
_APP_KEY   = "SistemaPOS"


def _open_run_key(write=False):
    import winreg
    access = winreg.KEY_SET_VALUE if write else winreg.KEY_READ
    return winreg.OpenKey(winreg.HKEY_CURRENT_USER, _REG_PATH, 0, access)


def is_autostart_enabled() -> bool:
    try:
        import winreg
        key = _open_run_key()
        try:
            winreg.QueryValueEx(key, _APP_KEY)
            return True
        except FileNotFoundError:
            return False
        finally:
            winreg.CloseKey(key)
    except Exception as e:
        logger.warning(f"Autostart: no se pudo leer el registro: {e}")
        return False


def set_autostart(enabled: bool) -> bool:
    """
    Habilita o deshabilita el autostart.
    Devuelve True si tuvo éxito.
    """
    try:
        import winreg
        key = _open_run_key(write=True)
        try:
            if enabled:
                if getattr(sys, 'frozen', False):
                    # Ejecutable compilado (PyInstaller)
                    cmd = f'"{sys.executable}"'
                else:
                    # Corriendo como script Python
                    script = os.path.abspath(sys.argv[0])
                    cmd = f'"{sys.executable}" "{script}"'
                winreg.SetValueEx(key, _APP_KEY, 0, winreg.REG_SZ, cmd)
                logger.info(f"Autostart habilitado: {cmd}")
            else:
                try:
                    winreg.DeleteValue(key, _APP_KEY)
                    logger.info("Autostart deshabilitado.")
                except FileNotFoundError:
                    pass
        finally:
            winreg.CloseKey(key)
        return True
    except Exception as e:
        logger.error(f"Autostart: error al escribir registro: {e}")
        return False
