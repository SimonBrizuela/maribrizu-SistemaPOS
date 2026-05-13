"""
Ejecuta comandos CMD desde la webapp via Firestore.
Escucha remote_terminal/{hostname} → ejecuta → escribe respuesta.
"""
import os
import socket
import subprocess
import logging

from PyQt5.QtCore import QThread

logger = logging.getLogger(__name__)

_CREATE_NO_WINDOW = 0x08000000  # Suprimir ventana CMD en Windows


class RemoteTerminalListener(QThread):
    """
    Hilo daemon: escucha remote_terminal/{hostname} en Firestore.
    Cuando status='pending', ejecuta el comando y escribe la respuesta.
    """

    def __init__(self, firebase_db):
        super().__init__()
        self.setDaemon(True)
        self._db   = firebase_db
        self._host = socket.gethostname()
        self._cwd  = None   # directorio de sesión actual
        self._watch = None  # Firestore watcher
        self._busy  = False # evitar ejecución concurrente

    def run(self):
        doc_ref = self._db.collection('remote_terminal').document(self._host)

        def _on_snapshot(doc_snaps, changes, read_time):
            if not doc_snaps:
                return
            try:
                snap = doc_snaps[0]
                if not snap.exists:
                    return
                data = snap.to_dict() or {}
                if data.get('status') != 'pending':
                    return
                if self._busy:
                    return
                self._busy = True
                try:
                    self._execute(doc_ref, data)
                finally:
                    self._busy = False
            except Exception as e:
                logger.error(f'RemoteTerminal: callback error: {e}')

        try:
            self._watch = doc_ref.on_snapshot(_on_snapshot)
            logger.info(f'RemoteTerminal: escuchando remote_terminal/{self._host}')
        except Exception as e:
            logger.error(f'RemoteTerminal: no se pudo iniciar listener: {e}')
            return

        self.exec_()  # Qt event loop — mantiene el hilo vivo

    def _execute(self, doc_ref, data):
        from firebase_admin import firestore as _fs

        cmd = (data.get('cmd') or '').strip()
        cwd = data.get('cwd') or self._cwd or None

        if not cmd:
            return

        try:
            doc_ref.set({'status': 'running'}, merge=True)
        except Exception:
            pass

        try:
            # Comando 'cd' — cambia directorio sin subprocess
            parts = cmd.split(None, 1)
            if parts[0].lower() == 'cd':
                target = parts[1].strip() if len(parts) > 1 else ''
                if not target:
                    new_cwd = os.path.expanduser('~')
                else:
                    target = os.path.expandvars(target)
                    if cwd and not os.path.isabs(target):
                        new_cwd = os.path.normpath(os.path.join(cwd, target))
                    else:
                        new_cwd = os.path.normpath(target)

                if os.path.isdir(new_cwd):
                    self._cwd = new_cwd
                    doc_ref.set({
                        'status':       'done',
                        'output':       '',
                        'cwd':          new_cwd,
                        'responded_at': _fs.SERVER_TIMESTAMP,
                    }, merge=True)
                else:
                    doc_ref.set({
                        'status':       'error',
                        'output':       f'No existe el directorio: {new_cwd}',
                        'responded_at': _fs.SERVER_TIMESTAMP,
                    }, merge=True)
                return

            result = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                cwd=cwd,
                timeout=30,
                creationflags=_CREATE_NO_WINDOW,
                encoding='utf-8',
                errors='replace',
            )
            output = (result.stdout or '') + (result.stderr or '')
            if not output.strip():
                output = '(sin salida)'

            if cwd is None:
                cwd = os.getcwd()

            doc_ref.set({
                'status':       'done',
                'output':       output[:8000],
                'cwd':          cwd,
                'responded_at': _fs.SERVER_TIMESTAMP,
            }, merge=True)

        except subprocess.TimeoutExpired:
            doc_ref.set({
                'status':       'error',
                'output':       'Timeout: el comando tardó más de 30 segundos.',
                'responded_at': _fs.SERVER_TIMESTAMP,
            }, merge=True)
        except Exception as e:
            logger.error(f"RemoteTerminal: error ejecutando '{cmd}': {e}")
            try:
                doc_ref.set({
                    'status':       'error',
                    'output':       f'Error: {e}',
                    'responded_at': _fs.SERVER_TIMESTAMP,
                }, merge=True)
            except Exception:
                pass

    def stop(self):
        if self._watch:
            try:
                self._watch.unsubscribe()
            except Exception:
                pass
        self.quit()
