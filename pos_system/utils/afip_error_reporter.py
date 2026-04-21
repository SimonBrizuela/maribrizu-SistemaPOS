"""
Reporter de errores AFIP → Firestore.

Cuando falla una operación contra AFIP (CAE, WSAA, etc.), sube un documento
a la colección 'error_reports' con stack trace, últimas líneas del log y
metadata de la PC. Permite diagnosticar problemas en sucursales remotas sin
pedir el archivo de log.
"""

import logging
import platform
import socket
import traceback
from collections import deque
from pathlib import Path

logger = logging.getLogger(__name__)

_LOG_TAIL_LINES = 80


def _leer_log_tail(path: Path, max_lines: int = _LOG_TAIL_LINES) -> str:
    """Lee las últimas max_lines del archivo de log."""
    try:
        if not path.exists():
            return '(sin archivo de log)'
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            tail = deque(f, maxlen=max_lines)
        return ''.join(tail)
    except Exception as e:
        return f'(error leyendo log: {e})'


def _version_app() -> str:
    try:
        from pos_system.config import APP_VERSION
        return str(APP_VERSION)
    except Exception:
        return 'desconocida'


def _hostname() -> str:
    try:
        return socket.gethostname() or 'desconocido'
    except Exception:
        return 'desconocido'


def report_afip_error(exc: BaseException, context: dict = None) -> None:
    """
    Loguea el error al archivo y lo sube a Firestore en background.

    Args:
        exc: la excepción que se produjo
        context: dict con info de la operación (tipo_comprobante, punto_venta,
                 total, cuit_receptor, etc.). Puede ser None.
    """
    context = context or {}
    stack = traceback.format_exception(type(exc), exc, exc.__traceback__)
    stack_str = ''.join(stack)

    # 1. Log local con stack trace completo
    logger.error(
        'AFIP error (%s): %s | contexto=%s',
        type(exc).__name__, exc, context,
    )
    logger.debug('Stack trace AFIP:\n%s', stack_str)

    # 2. Upload a Firestore en background (no bloquear UI)
    try:
        from pos_system.utils.firebase_sync import get_firebase_sync, _get_pc_id, now_ar
    except Exception:
        return

    sync = get_firebase_sync()
    if sync is None or not getattr(sync, 'enabled', False):
        return

    try:
        from pos_system.config import LOG_FILE
        log_tail = _leer_log_tail(Path(LOG_FILE))
    except Exception:
        log_tail = '(no se pudo leer log)'

    payload = {
        'fecha':         now_ar(),
        'pc_id':         _get_pc_id(),
        'hostname':      _hostname(),
        'plataforma':    f'{platform.system()} {platform.release()}',
        'version_app':   _version_app(),
        'tipo_error':    type(exc).__name__,
        'mensaje':       str(exc)[:2000],
        'stack_trace':   stack_str[:8000],
        'log_tail':      log_tail[:8000],
        'contexto':      {k: str(v)[:500] for k, v in context.items()},
    }

    def _subir():
        try:
            sync.db.collection('error_reports').add(payload)
            logger.info('AFIP error reportado a Firestore (error_reports).')
        except Exception as e:
            logger.warning('No se pudo subir error_report a Firestore: %s', e)

    try:
        sync._run(_subir)
    except Exception as e:
        logger.warning('No se pudo lanzar thread para error_report: %s', e)
