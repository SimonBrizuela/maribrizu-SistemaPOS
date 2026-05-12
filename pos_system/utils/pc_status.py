"""
PC Status / Heartbeat.

Escribe el estado de esta PC en `pcs/{pc_id}` cada HEARTBEAT_SECONDS
y escucha comandos remotos en `pc_commands/{pc_id}` (sync_upload,
sync_download, reconcile_orphans, restart).

Pensado para que la webapp pueda ver online/offline, version, cajero
activo, ultimo sync, y disparar acciones puntuales sobre cada PC.
"""

import logging
import platform as _platform
import socket as _socket
import sys as _sys
import threading
import time as _time
from datetime import datetime
from typing import Callable, Optional

from pos_system.config import APP_VERSION
from pos_system.utils.firebase_sync import (
    _get_pc_id, get_firebase_sync, now_ar_iso,
)

logger = logging.getLogger(__name__)

HEARTBEAT_SECONDS = 20 * 60          # 20 minutos
ONLINE_THRESHOLD_SECONDS = 25 * 60   # 25 minutos (margen) — la webapp lo aplica


class PCStatusReporter:
    """Escribe heartbeat periodico y procesa comandos remotos."""

    def __init__(self, db_manager, get_context: Callable[[], dict],
                 handlers: dict):
        """
        db_manager: para contar productos locales.
        get_context: callable que devuelve {cajero, cash_register_id}
                     en el momento de cada heartbeat.
        handlers: dict de comando -> callable. Comandos soportados:
                  'sync_upload', 'sync_download', 'reconcile_orphans',
                  'restart', 'ping'.
        """
        self.db_manager = db_manager
        self.get_context = get_context
        self.handlers = handlers
        self.pc_id = _get_pc_id()
        self.started_at = now_ar_iso()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._cmd_watch = None
        # Estado en memoria para reportar en el heartbeat
        self.last_sync_at: Optional[str] = None
        self.last_sync_summary: Optional[dict] = None
        self.last_error: Optional[str] = None
        self._last_seen_command_ts: Optional[str] = None
        # Guard para no ejecutar dos comandos en paralelo (apretar el boton
        # varias veces escribe varios docs con issued_at distintos).
        self._busy_lock = threading.Lock()
        self._busy_command: Optional[str] = None

    # ── Heartbeat ─────────────────────────────────────────────────
    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True,
                                        name='pc-status-heartbeat')
        self._thread.start()
        self._start_command_listener()
        # Escribir un heartbeat inmediato para que la webapp vea la PC online
        self._write_heartbeat(initial=True)
        logger.info(f"PC Status: heartbeat iniciado para {self.pc_id}")

    def stop(self):
        self._stop_event.set()
        try:
            if self._cmd_watch:
                self._cmd_watch.unsubscribe()
        except Exception:
            pass
        # No escribimos online_hint=False: dejamos que la webapp lo deduzca
        # por last_seen. Si ponemos False y el proceso sigue corriendo por
        # algun motivo, la PC se queda marcada offline aunque siga viva.

    def _loop(self):
        while not self._stop_event.is_set():
            try:
                self._write_heartbeat()
            except Exception as e:
                logger.debug(f"PC Status: error en heartbeat: {e}")
            # Esperar HEARTBEAT_SECONDS o hasta que pidan parar
            self._stop_event.wait(HEARTBEAT_SECONDS)

    def _count_productos_locales(self) -> int:
        try:
            rows = self.db_manager.execute_query(
                "SELECT COUNT(*) AS n FROM products"
            )
            return int(rows[0]['n']) if rows else 0
        except Exception:
            return 0

    def _write_heartbeat(self, initial: bool = False):
        ctx = {}
        try:
            ctx = self.get_context() or {}
        except Exception as e:
            logger.debug(f"PC Status: get_context fallo: {e}")

        payload = {
            'pc_id':            self.pc_id,
            'hostname':         _socket.gethostname(),
            'app_version':      APP_VERSION,
            'last_seen':        now_ar_iso(),
            'started_at':       self.started_at,
            'os':               f"{_platform.system()} {_platform.release()}",
            'python_version':   _sys.version.split()[0],
            'cajero_actual':    ctx.get('cajero') or '',
            'turno_actual':     ctx.get('turno_nombre') or '',
            'cash_register_id': ctx.get('cash_register_id'),
            'productos_locales': self._count_productos_locales(),
            'last_sync_at':     self.last_sync_at,
            'last_sync_summary': self.last_sync_summary,
            'last_error':       self.last_error,
            'online_hint':      True,
        }
        if initial:
            payload['initial_at'] = self.started_at
        self._write_status(payload)

    def _write_status(self, payload: dict):
        fb = get_firebase_sync()
        if not fb or not fb.enabled:
            return
        try:
            fb.db.collection('pcs').document(self.pc_id).set(
                payload, merge=True
            )
        except Exception as e:
            logger.debug(f"PC Status: error escribiendo pcs/{self.pc_id}: {e}")

    # ── Command listener ──────────────────────────────────────────
    def _start_command_listener(self):
        fb = get_firebase_sync()
        if not fb or not fb.enabled:
            logger.debug("PC Status: Firebase no disponible, no se inicia listener")
            return

        doc_ref = fb.db.collection('pc_commands').document(self.pc_id)

        def _on_snapshot(doc_snapshot, changes, read_time):
            try:
                if not doc_snapshot:
                    return
                snap = doc_snapshot[0]
                if not snap.exists:
                    return
                data = snap.to_dict() or {}
                self._process_command(doc_ref, data)
            except Exception as e:
                logger.debug(f"PC Status: error en listener de comandos: {e}")

        try:
            self._cmd_watch = doc_ref.on_snapshot(_on_snapshot)
            logger.info(f"PC Status: listener de comandos activo para {self.pc_id}")
        except Exception as e:
            logger.warning(f"PC Status: no se pudo iniciar listener de comandos: {e}")

    def _process_command(self, doc_ref, data: dict):
        cmd_id  = str(data.get('issued_at') or '')
        command = str(data.get('command') or '').strip()
        status  = str(data.get('status') or '').strip()
        if not command or not cmd_id:
            return
        # Ignorar comandos ya finalizados o que ya procesamos
        if status in ('done', 'failed'):
            return
        if cmd_id == self._last_seen_command_ts:
            return
        # Ignorar comandos emitidos antes de que esta sesion arrancara
        # (ej. la app se cerro mientras corria un comando y al reabrir
        #  no queremos reejecutar comandos pasados). Si el comando quedo
        #  pending/running, marcarlo abandonado para limpiar el banner web.
        if cmd_id < self.started_at:
            self._last_seen_command_ts = cmd_id
            if status in ('pending', 'running'):
                try:
                    doc_ref.set({
                        'status':      'failed',
                        'result':      'abandonado (POS reinicio sin finalizar)',
                        'finished_at': now_ar_iso(),
                    }, merge=True)
                except Exception:
                    pass
            return
        self._last_seen_command_ts = cmd_id

        handler = self.handlers.get(command)
        if not handler:
            logger.warning(f"PC Status: comando desconocido '{command}'")
            try:
                doc_ref.set({
                    'status': 'failed',
                    'result': f'comando no soportado: {command}',
                    'finished_at': now_ar_iso(),
                }, merge=True)
            except Exception:
                pass
            return

        # Si hay un comando en curso, rechazar este. Evita que apretar
        # el boton varias veces dispare N workers en paralelo.
        if not self._busy_lock.acquire(blocking=False):
            logger.info(
                f"PC Status: comando '{command}' ignorado — "
                f"'{self._busy_command}' ya en curso"
            )
            try:
                doc_ref.set({
                    'status': 'failed',
                    'result': f'otro comando en curso ({self._busy_command})',
                    'finished_at': now_ar_iso(),
                }, merge=True)
            except Exception:
                pass
            return
        self._busy_command = command

        def _run():
            try:
                doc_ref.set({
                    'status': 'running',
                    'started_at': now_ar_iso(),
                }, merge=True)
            except Exception:
                pass
            ok, result = True, ''
            try:
                out = handler(data.get('param'))
                if isinstance(out, tuple) and len(out) == 2:
                    ok, result = out
                else:
                    result = str(out or 'ok')
            except Exception as e:
                ok = False
                result = f"{type(e).__name__}: {e}"
                logger.error(f"PC Status: handler '{command}' fallo: {e}")
            try:
                doc_ref.set({
                    'status': 'done' if ok else 'failed',
                    'result': result,
                    'finished_at': now_ar_iso(),
                }, merge=True)
            except Exception:
                pass
            # Refrescar heartbeat para que la webapp vea el cambio rapido
            try:
                self._write_heartbeat()
            except Exception:
                pass
            # Liberar el lock para permitir el siguiente comando
            self._busy_command = None
            try:
                self._busy_lock.release()
            except Exception:
                pass

        threading.Thread(target=_run, daemon=True,
                         name=f'pc-cmd-{command}').start()

    # ── API publica para que el POS actualice metricas ────────────
    def record_sync(self, summary: dict):
        self.last_sync_at = now_ar_iso()
        self.last_sync_summary = summary or {}
        try:
            self._write_heartbeat()
        except Exception:
            pass

    def record_error(self, message: str):
        self.last_error = f"[{now_ar_iso()}] {message[:200]}"


# Singleton
_reporter: Optional[PCStatusReporter] = None


def get_reporter() -> Optional[PCStatusReporter]:
    return _reporter


def init_reporter(db_manager, get_context, handlers) -> PCStatusReporter:
    global _reporter
    if _reporter is not None:
        return _reporter
    _reporter = PCStatusReporter(db_manager, get_context, handlers)
    _reporter.start()
    return _reporter


def stop_reporter():
    global _reporter
    if _reporter is not None:
        try:
            _reporter.stop()
        except Exception:
            pass
        _reporter = None
