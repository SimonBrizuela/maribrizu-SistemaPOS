import logging
import threading
from pathlib import Path
from PyQt5.QtWidgets import (QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
                             QTabWidget, QLabel, QStatusBar, QShortcut,
                             QPushButton, QMessageBox, QSizePolicy, QApplication)
from PyQt5.QtCore import pyqtSignal
from PyQt5.QtCore import Qt, QTimer
from PyQt5.QtGui import QFont, QKeySequence
from datetime import datetime, timedelta, timezone
from pos_system.utils.firebase_sync import now_ar

from pos_system.ui.products_view import ProductsView
from pos_system.ui.sales_view import SalesView
from pos_system.ui.cash_view import CashView
from pos_system.ui.sales_history_view import SalesHistoryView
from pos_system.ui.observations_view import ObservationsView
from pos_system.ui.components import MessageBox, Toast
from pos_system.models.cash_register import CashRegister
from pos_system.models.product import Product

logger = logging.getLogger(__name__)


class MainWindow(QMainWindow):
    cloud_sync_done  = pyqtSignal()        # restaurar botón al terminar sync
    cloud_sync_ok    = pyqtSignal()        # toast éxito (thread-safe)
    cloud_sync_error = pyqtSignal(str)     # toast error (thread-safe)
    cloud_sync_info  = pyqtSignal(str)     # toast info  (thread-safe)
    # Señales thread-safe para eventos de caja desde Firebase
    _sig_caja_open  = pyqtSignal(int)      # reg_id abierto remotamente
    _sig_caja_close = pyqtSignal(str, int) # (session_id, register_id) cerrado remotamente
    # Señal thread-safe: admin de otra PC disparó sync → 'upload' o 'download'
    _sig_remote_sync = pyqtSignal(str, str)  # (command, pc_id)
    # Señal thread-safe: auto-update terminó (éxito/fallo)
    _sig_update_ready = pyqtSignal(bool)
    # Señal thread-safe: iniciar descarga de update desde hilo principal
    _sig_start_download = pyqtSignal(object)
    # Señal thread-safe: delta sync de productos al arranque terminó
    _sig_delta_sync_done = pyqtSignal(int)  # n_updated
    # Señal thread-safe: listener de stock detectó cambios → refrescar UI
    _sig_stock_refresh = pyqtSignal()

    def __init__(self, current_user: dict = None):
        super().__init__()
        from pos_system.database.db_manager import DatabaseManager
        self.db = DatabaseManager()
        self.cash_register = CashRegister(self.db)
        self.product_model = Product(self.db)
        self.current_user = current_user or {'username': 'admin', 'role': 'admin', 'full_name': 'Admin'}
        # turno_nombre: nombre del cajero de turno (puede ser diferente al usuario logueado)
        # Se inicializa en _prompt_turno() si el usuario es admin
        if 'turno_nombre' not in self.current_user:
            self.current_user['turno_nombre'] = self.current_user.get('full_name') or self.current_user.get('username', '')
        self._listeners_started = False
        self.init_ui()
        # Después de construir la UI, preguntar quién está en el turno (solo admins)
        from PyQt5.QtCore import QTimer as _QT
        _QT.singleShot(300, self._prompt_turno)

    def init_ui(self):
        from pos_system.config import APP_NAME, WINDOW_WIDTH, WINDOW_HEIGHT, WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT
        
        # Iniciar listeners de sincronización en tiempo real
        self._start_realtime_sync_listeners()

        self.setWindowTitle(APP_NAME)

        # ── Adaptar ventana a la resolución de pantalla disponible ──────
        screen = QApplication.primaryScreen().availableGeometry()
        # Usar el 92% del ancho/alto disponible (máximo), pero respetar el mínimo
        target_w = max(WINDOW_MIN_WIDTH, min(WINDOW_WIDTH, int(screen.width()  * 0.92)))
        target_h = max(WINDOW_MIN_HEIGHT, min(WINDOW_HEIGHT, int(screen.height() * 0.92)))
        # Centrar la ventana en la pantalla
        x = screen.x() + (screen.width()  - target_w) // 2
        y = screen.y() + (screen.height() - target_h) // 2
        self.setGeometry(x, y, target_w, target_h)
        self.setMinimumSize(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT)

        self.load_styles()

        # Widget central
        central_widget = QWidget()
        self.setCentralWidget(central_widget)

        main_layout = QVBoxLayout(central_widget)
        main_layout.setContentsMargins(16, 16, 16, 16)
        main_layout.setSpacing(12)

        # Header
        header = self.create_header()
        main_layout.addWidget(header)

        # Tabs
        self.tabs = QTabWidget()
        self.tabs.setFont(QFont('Segoe UI', 10))

        is_admin = self.current_user.get('role') == 'admin'

        # Crear vistas — pasando current_user donde aplica
        self.sales_view = SalesView(self, current_user=self.current_user)
        self.cash_view = CashView(self, current_user=self.current_user)
        self.history_view = SalesHistoryView(self)
        self.observations_view = ObservationsView(self, current_user=self.current_user)

        # Vista de promociones (solo lectura) — visible para todos
        from pos_system.ui.promos_readonly_view import PromosReadOnlyView
        self.promos_readonly_view = PromosReadOnlyView(self)

        # Vistas solo para admin
        if is_admin:
            self.products_view = ProductsView(self)
            # Promociones se gestionan desde la webapp (Firebase) — no hay tab local
            self.promotions_view = None
            self.fiscal_view = None
            from pos_system.ui.users_view import UsersView
            self.users_view = UsersView(self, current_user=self.current_user)
        else:
            self.products_view = None
            self.promotions_view = None
            self.fiscal_view = None
            self.users_view = None

        # Pestañas para cajero: Ventas, Historial, Promociones (solo lectura)
        self.tabs.addTab(self.sales_view, 'Ventas')
        self.tabs.addTab(self.history_view, 'Historial')
        if is_admin:
            self.tabs.addTab(self.cash_view, 'Caja')
        self.tabs.addTab(self.promos_readonly_view, '🏷️ Promociones')
        self.tabs.addTab(self.observations_view, 'Observaciones')

        # Pestañas adicionales solo para admin
        if is_admin:
            self.tabs.addTab(self.products_view, 'Productos')
            # Promociones ya no tiene tab — se gestionan desde la webapp
            self.tabs.addTab(self.users_view, 'Cajeros')

        main_layout.addWidget(self.tabs)

        # Barra de estado
        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)
        self.update_status_bar()

        # Timer para actualizar barra de estado cada segundo
        self.timer = QTimer()
        self.timer.timeout.connect(self.update_status_bar)
        self.timer.start(1000)

        # Timer para verificar stock bajo cada 5 minutos
        self.stock_timer = QTimer()
        self.stock_timer.timeout.connect(self._check_low_stock_badge)
        self.stock_timer.start(300000)

        # Timer auto-sync Google Sheets cada 40 minutos (en background, no lagea)
        self.cloud_sync_timer = QTimer()
        self.cloud_sync_timer.timeout.connect(self._auto_cloud_sync)
        self.cloud_sync_timer.start(40 * 60 * 1000)  # 40 minutos en ms

        # Conectar señales de sync (thread-safe → hilo principal)
        self.cloud_sync_done.connect(self._restore_cloud_btn)
        self.cloud_sync_done.connect(self._restore_promos_btn)
        self.cloud_sync_ok.connect(lambda: Toast.success(self, 'Sincronizacion completada correctamente'))
        self.cloud_sync_error.connect(lambda msg: Toast.error(self, f'Error al sincronizar: {msg}'))
        self.cloud_sync_info.connect(lambda msg: Toast.info(self, msg))

        # (sin timer de estado Firebase — ya no usamos listeners en tiempo real)

        self.tabs.currentChanged.connect(self.on_tab_changed)
        self.setup_shortcuts()
        self.check_cash_register_status()
        self._check_low_stock_badge()

        from PyQt5.QtCore import QTimer as _QT2
        _QT2.singleShot(8000, self._check_for_updates)

        # Poller de sync remoto: detecta comando del admin → sube o descarga en silencio
        self._last_sync_trigger_ts = None
        self._sig_remote_sync.connect(self._on_remote_sync_detected)
        self._sig_update_ready.connect(self._on_update_ready)
        self._sig_start_download.connect(self._auto_start_download)
        self._remote_sync_poller = QTimer()
        self._remote_sync_poller.timeout.connect(self._poll_sync_trigger)
        self._remote_sync_poller.start(60_000)  # cada 60 segundos

        # Delta sync de productos al arranque: 8s de retraso para no entorpecer el inicio
        self._sig_delta_sync_done.connect(self._on_delta_sync_done)
        QTimer.singleShot(8_000, self._start_delta_product_sync)

    def setup_shortcuts(self):
        """Setup keyboard shortcuts"""
        QShortcut(QKeySequence("Ctrl+1"), self, lambda: self.tabs.setCurrentIndex(0))
        QShortcut(QKeySequence("Ctrl+2"), self, lambda: self.tabs.setCurrentIndex(1))
        QShortcut(QKeySequence("Ctrl+3"), self, lambda: self.tabs.setCurrentIndex(2))
        QShortcut(QKeySequence("Ctrl+4"), self, lambda: self.tabs.setCurrentIndex(3))
        QShortcut(QKeySequence("Ctrl+5"), self, lambda: self.tabs.setCurrentIndex(4))
        QShortcut(QKeySequence("F1"), self, lambda: self.tabs.setCurrentIndex(0))
        QShortcut(QKeySequence("F5"), self, self.refresh_all_views)
        QShortcut(QKeySequence("Ctrl+L"), self, self._logout)
        logger.debug("Keyboard shortcuts configured")

    def load_styles(self):
        try:
            import os
            style_path = os.path.join(os.path.dirname(__file__), 'styles.qss')
            if os.path.exists(style_path):
                with open(style_path, 'r', encoding='utf-8') as f:
                    self.setStyleSheet(f.read())
        except Exception as e:
            logger.warning(f"Error cargando estilos: {e}")

    def create_header(self):
        from pos_system.config import APP_VERSION

        screen = QApplication.primaryScreen().availableGeometry()
        sw = screen.width()
        # Tres niveles: grande ≥1400, normal ≥1100, pequeño <1100
        if sw >= 1400:
            fs = 10; pad = '5px 14px'; h = 46; sp = 8
        elif sw >= 1100:
            fs = 9;  pad = '4px 10px'; h = 42; sp = 6
        else:
            fs = 8;  pad = '3px 8px';  h = 38; sp = 5

        def _btn_style(bg, hover, color='white', border='none'):
            return f'''QPushButton {{
                background:{bg}; border:{border}; border-radius:6px;
                padding:{pad}; color:{color}; font-size:{fs}px; font-weight:bold;
            }} QPushButton:hover {{ background:{hover}; }}
            QPushButton:pressed {{ background:{hover}; }}
            QPushButton:disabled {{ background:#adb5bd; color:#f8f9fa; }}'''

        header = QWidget()
        header.setObjectName('headerWidget')
        header.setStyleSheet('''
            QWidget#headerWidget {
                background: qlineargradient(x1:0,y1:0,x2:1,y2:0,stop:0 #ffffff,stop:1 #f8f9fa);
                border-radius: 8px; border: 1px solid #e1e4e8;
            }
        ''')
        header.setFixedHeight(h)

        hl = QHBoxLayout(header)
        hl.setContentsMargins(12, 0, 12, 0)
        hl.setSpacing(sp)

        hl.addStretch()

        user_role = self.current_user.get('role', '')
        full_name = self.current_user.get('full_name', 'Usuario')
        role_txt  = 'Admin' if user_role == 'admin' else 'Cajero'
        color_role = '#0d6efd' if user_role == 'admin' else '#198754'

        # ── Usuario (una sola línea en pantallas pequeñas) ────────────────
        if sw < 1100:
            # Pantalla chica: solo nombre + rol en un label
            user_lbl = QLabel(f'<b style="color:#212529">{full_name}</b>'
                              f' <span style="color:{color_role};font-size:{fs-1}px">({role_txt})</span>')
            user_lbl.setTextFormat(Qt.RichText)
            user_lbl.setStyleSheet('background:transparent;')
            hl.addWidget(user_lbl)
        else:
            user_container = QVBoxLayout()
            user_container.setSpacing(0)
            n_lbl = QLabel(full_name)
            n_lbl.setFont(QFont('Segoe UI', fs, QFont.Bold))
            n_lbl.setStyleSheet('color:#212529; background:transparent;')
            r_lbl = QLabel(role_txt)
            r_lbl.setFont(QFont('Segoe UI', fs - 1))
            r_lbl.setStyleSheet(f'color:{color_role}; background:transparent;')
            user_container.addWidget(n_lbl)
            user_container.addWidget(r_lbl)
            hl.addLayout(user_container)

        # ── Turno (solo admin) ────────────────────────────────────────────
        self._turno_lbl = None
        if user_role == 'admin':
            turno_nombre = self.current_user.get('turno_nombre') or full_name
            self._turno_lbl = QPushButton(f'Turno: {turno_nombre}')
            self._turno_lbl.setStyleSheet(f'''
                QPushButton {{
                    background:#fff3cd; border:1.5px solid #ffc107; border-radius:6px;
                    padding:{pad}; color:#856404; font-size:{fs}px; font-weight:bold;
                }}
                QPushButton:hover {{ background:#ffe69c; border-color:#e0a800; }}
            ''')
            self._turno_lbl.setFont(QFont('Segoe UI', fs, QFont.Bold))
            self._turno_lbl.setToolTip('Click para cambiar el cajero de turno')
            self._turno_lbl.clicked.connect(self._prompt_turno)
            hl.addWidget(self._turno_lbl)
        else:
            cajero_nombre = self.current_user.get('full_name') or self.current_user.get('username', '')
            cajero_lbl = QLabel(cajero_nombre)
            cajero_lbl.setStyleSheet(f'''
                background:#d1e7dd; border:1.5px solid #198754; border-radius:6px;
                padding:{pad}; color:#0f5132; font-size:{fs}px; font-weight:bold;
            ''')
            cajero_lbl.setFont(QFont('Segoe UI', fs, QFont.Bold))
            hl.addWidget(cajero_lbl)

        # ── Promociones ───────────────────────────────────────────────────
        promo_txt = 'Promos' if sw < 1200 else 'Promociones'
        self.promos_btn = QPushButton(promo_txt)
        self.promos_btn.setStyleSheet(_btn_style('#198754', '#157347'))
        self.promos_btn.setFont(QFont('Segoe UI', fs, QFont.Bold))
        self.promos_btn.setToolTip('Sincronizar promociones desde Firebase')
        self.promos_btn.clicked.connect(self._sync_promos_now)
        hl.addWidget(self.promos_btn)
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync as _gfs
            _fb = _gfs()
            self.promos_btn.setVisible(_fb is not None and _fb.enabled)
        except Exception:
            self.promos_btn.setVisible(False)

        # ── Sincronizar ───────────────────────────────────────────────────
        sync_txt = 'Sync' if sw < 1100 else 'Sincronizar'
        self.cloud_btn = QPushButton(sync_txt)
        self.cloud_btn.setStyleSheet(_btn_style('#0d6efd', '#0b5ed7'))
        self.cloud_btn.setFont(QFont('Segoe UI', fs, QFont.Bold))
        self.cloud_btn.setToolTip('Sincronizar con Firebase (Subir / Descargar datos)')
        self.cloud_btn.clicked.connect(self._open_cloud_menu)
        hl.addWidget(self.cloud_btn)
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            self.cloud_btn.setVisible(fb is not None and fb.enabled)
        except Exception:
            self.cloud_btn.setVisible(True)

        # ── Actualización (oculto por defecto) ────────────────────────────
        self.update_btn = QPushButton('Actualizando...')
        self.update_btn.setStyleSheet(_btn_style('#fff3cd', '#ffe69c', color='#856404', border='1.5px solid #ffc107'))
        self.update_btn.setFont(QFont('Segoe UI', fs, QFont.Bold))
        self.update_btn.setEnabled(False)
        self.update_btn.setVisible(False)
        hl.addWidget(self.update_btn)

        # ── Auto-inicio (solo admin) ──────────────────────────────────────
        if user_role == 'admin':
            self._autostart_btn = QPushButton()
            self._autostart_btn.setFont(QFont('Segoe UI', fs))
            self._autostart_btn.clicked.connect(self._toggle_autostart)
            self._autostart_btn.setToolTip('Inicio automatico al encender la PC')
            hl.addWidget(self._autostart_btn)
            self._refresh_autostart_btn()

        # ── Cerrar sesión ─────────────────────────────────────────────────
        logout_txt = 'Salir' if sw < 1100 else 'Cerrar Sesion'
        logout_btn = QPushButton(logout_txt)
        logout_btn.setStyleSheet(f'''
            QPushButton {{
                background:#f8f9fa; border:1px solid #dee2e6; border-radius:6px;
                padding:{pad}; color:#495057; font-size:{fs}px;
            }}
            QPushButton:hover {{ background:#e9ecef; border-color:#adb5bd; }}
        ''')
        logout_btn.setFont(QFont('Segoe UI', fs))
        logout_btn.clicked.connect(self._logout)
        logout_btn.setToolTip('Cerrar sesion (Ctrl+L)')
        hl.addWidget(logout_btn)

        return header

    def update_status_bar(self):
        now = now_ar()
        date_time = now.strftime('%d/%m/%Y %H:%M:%S')

        try:
            current_register = self.cash_register.get_current()
            if current_register:
                cash_status = f'Caja Abierta | Monto Inicial: ${current_register["initial_amount"]:.2f}'
            else:
                cash_status = 'Caja Cerrada'
        except Exception:
            cash_status = 'Caja Cerrada'

        user_info = f'{self.current_user.get("username", "")} ({self.current_user.get("role", "")})'
        turno = self.current_user.get('turno_nombre', '')
        turno_str = f'  |  Turno: {turno}' if turno and turno != self.current_user.get('username') else ''
        self.status_bar.showMessage(f'{date_time}  |  {cash_status}  |  {user_info}{turno_str}')

    def _check_low_stock_badge(self):
        """Actualiza el badge de la pestaña Productos si hay stock bajo"""
        if self.products_view is None:
            return
        try:
            # Solo considerar stock real > 0 para el badge (stock 0 es normal en este sistema)
            low_stock = self.product_model.get_low_stock(threshold=3)
            # Filtrar los que tienen stock > 0 pero bajo (no los que son 0 por defecto)
            real_low = [p for p in low_stock if p.get('stock', 0) > 0]
            products_tab_index = self.tabs.indexOf(self.products_view)
            if products_tab_index >= 0:
                if real_low:
                    self.tabs.setTabText(products_tab_index, f'Productos ({len(real_low)} bajo stock)')
                    self.tabs.setTabToolTip(products_tab_index,
                                           f'{len(real_low)} producto(s) con stock bajo')
                else:
                    self.tabs.setTabText(products_tab_index, 'Productos')
                    self.tabs.setTabToolTip(products_tab_index, '')
        except Exception as e:
            logger.debug(f"Error checking low stock: {e}")

    def _start_realtime_sync_listeners(self):
        """Inicia listeners de sincronizacion en tiempo real para ventas y cierres de caja."""
        if self._listeners_started:
            return
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if not fb:
                # Firebase todavía inicializando en background — reintentar en 2s
                QTimer.singleShot(2000, self._start_realtime_sync_listeners)
                return
            self._listeners_started = True

            # Firebase listo: mostrar botones que se ocultaron durante la inicialización
            if hasattr(self, 'cloud_btn'):
                self.cloud_btn.setVisible(True)
            if hasattr(self, 'promos_btn'):
                self.promos_btn.setVisible(True)

            # IMPORTANTE: estos callbacks corren en hilo de Firebase (background).
            # Usar señales Qt (pyqtSignal) para comunicación cross-thread → thread-safe.

            # 1. Listener de CAJA (caja_activa/current) - el mas directo y confiable.
            # Cuando PC-A abre la caja, ensure_local_register crea el mismo ID en PC-B.
            # Cuando PC-A la cierra, on_register_close actualiza la SQLite de PC-B.
            # Conectar señales (main thread) a slots antes de iniciar el listener
            self._sig_caja_open.connect(self._on_caja_open_slot)
            self._sig_caja_close.connect(self._on_caja_close_slot)

            def on_register_open(reg_id):
                self._sig_caja_open.emit(int(reg_id))

            def on_register_close(session_id='', register_id=None):
                try:
                    rid = int(register_id) if register_id else 0
                except Exception:
                    rid = 0
                self._sig_caja_close.emit(session_id or '', rid)

            fb.start_register_listener(self.db, on_open=on_register_open, on_close=on_register_close)

            # Si hay una caja abierta localmente, asegurarse de que Firebase la tenga.
            # Cubre el caso donde sync_open_register falló la vez anterior (red caída, etc.)
            #
            # IMPORTANTE: si la caja remota está EXPLÍCITAMENTE cerrada (status='closed')
            # con el mismo id que la local, NO re-pushear como abierta — esto pasaría si la
            # caja se cerró desde la web mientras esta PC estaba offline. En ese caso
            # cerrar la caja local para reflejar el estado autorizado en Firebase.
            def _push_local_register_if_needed():
                try:
                    local_reg = self.cash_register.get_current()
                    if not local_reg:
                        return
                    # Leer el doc raw (no get_active_register, que filtra por status='open')
                    try:
                        doc_snap = fb.db.collection('caja_activa').document('current').get()
                        remote_doc = doc_snap.to_dict() if doc_snap.exists else None
                    except Exception:
                        remote_doc = None
                    remote_status = (remote_doc or {}).get('status')
                    remote_id = (remote_doc or {}).get('id') or (remote_doc or {}).get('register_id')

                    # Caso A: remoto está cerrado con el mismo id → la cerraron desde otra
                    # parte (web u otra PC) mientras esta PC estaba offline. Cerrar local.
                    if remote_status == 'closed' and remote_id and int(remote_id) == int(local_reg['id']):
                        from pos_system.utils.firebase_sync import now_ar as _now_ar
                        self.db.execute_update(
                            "UPDATE cash_register SET status='closed', closing_date=?, notes=? WHERE id=?",
                            (_now_ar().isoformat(), 'Cerrado remotamente (offline)', local_reg['id'])
                        )
                        logger.info(f"Startup: Caja #{local_reg['id']} cerrada remotamente — actualizada en SQLite local.")
                        # Re-mergear el reporte de cierre con datos locales
                        try:
                            from pos_system.models.cash_register import CashRegister as _CR
                            rep = _CR(self.db).get_closing_report(local_reg['id'])
                            sid = (remote_doc or {}).get('session_id') or _now_ar().strftime('%Y-%m-%d')
                            rep['session_id'] = sid
                            fb.sync_cash_closing(rep, session_id=sid)
                            logger.info(f"Startup: Reporte de cierre #{local_reg['id']} mergeado a Firestore.")
                        except Exception as e2:
                            logger.error(f"Startup: Error mergeando reporte de cierre: {e2}")
                        # Refrescar UI para que vea el cierre — desde main thread
                        try:
                            from PyQt5.QtCore import QTimer
                            QTimer.singleShot(0, self.refresh_all_views)
                        except Exception:
                            pass
                        return

                    # Caso B: remoto vacío o sin id → re-sincronizar como abierta
                    # (cubre el caso original: sync_open_register falló y hay que reintentar)
                    if not remote_doc or not remote_id:
                        reg_with_cajero = dict(local_reg)
                        reg_with_cajero['cajero'] = (
                            self.current_user.get('turno_nombre')
                            or self.current_user.get('full_name')
                            or self.current_user.get('username', '')
                        )
                        fb.sync_open_register(reg_with_cajero)
                        logger.info(f"Startup: Caja local #{local_reg['id']} re-sincronizada a Firebase.")
                        return

                    # Caso C: remoto abierto con OTRO id → otra caja ya se abrió (web
                    # u otra PC). Adoptar la remota: cerrar la local vieja y dejar que
                    # el listener de caja_activa abra la nueva localmente.
                    if remote_status == 'open' and int(remote_id) != int(local_reg['id']):
                        from pos_system.utils.firebase_sync import now_ar as _now_ar
                        self.db.execute_update(
                            "UPDATE cash_register SET status='closed', closing_date=?, notes=? WHERE id=?",
                            (_now_ar().isoformat(),
                             f'Cerrada en startup: remoto ya tenia #{remote_id} abierta',
                             local_reg['id'])
                        )
                        logger.info(
                            f"Startup: Caja local #{local_reg['id']} cerrada — "
                            f"remoto tiene #{remote_id} abierta (nueva fuente de verdad)."
                        )
                        try:
                            from PyQt5.QtCore import QTimer
                            QTimer.singleShot(0, self.refresh_all_views)
                        except Exception:
                            pass
                        return
                except Exception as e:
                    logger.warning(f"Startup: No se pudo verificar caja en Firebase: {e}")
            threading.Thread(target=_push_local_register_if_needed, daemon=True).start()

            # 2. Listener de VENTAS desde otras computadoras.
            # Bug anterior: refresh_all_views() solo leia la SQLite local (vacia en PC-B).
            # Solucion: insertar la venta en la SQLite local antes de refrescar la vista.
            def on_new_sale(sale_data):
                sale_id = sale_data.get('sale_id')
                from pos_system.utils.firebase_sync import _get_pc_id
                # Ignorar ventas de esta misma PC (rebote de Firebase tras subir)
                if sale_data.get('pc_id') == _get_pc_id():
                    return
                logger.info(f"Firebase: Nueva venta remota #{sale_id} (de {sale_data.get('pc_id','?')})")
                _sale = dict(sale_data)

                def _do_insert_sale():
                    try:
                        if not sale_id:
                            self.refresh_all_views()
                            return
                        # No insertar si ya existe localmente (evitar duplicados)
                        existing = self.db.execute_query(
                            "SELECT id FROM sales WHERE id = ?", (sale_id,)
                        )
                        if existing:
                            self.refresh_all_views()
                            return
                        # Caja a la que pertenece la venta: preferir la de la venta remota,
                        # sino la caja local activa (fallback).
                        remote_reg_id = _sale.get('cash_register_id')
                        try:
                            remote_reg_id = int(remote_reg_id) if remote_reg_id else None
                        except Exception:
                            remote_reg_id = None
                        current = self.cash_register.get_current()
                        local_open_id = current['id'] if current else None
                        cash_register_id = remote_reg_id or local_open_id
                        # Parsear fecha: convertir siempre a hora AR para matchear ventas locales
                        created_at_raw = _sale.get('created_at')
                        if hasattr(created_at_raw, 'timestamp'):
                            from datetime import timezone as _tz, timedelta as _td
                            _ar = _tz(_td(hours=-3))
                            created_at = datetime.fromtimestamp(
                                created_at_raw.timestamp(), tz=_tz.utc
                            ).astimezone(_ar).strftime('%Y-%m-%d %H:%M:%S')
                        elif isinstance(created_at_raw, str):
                            # ISO con offset (ej. '2026-04-18T10:30:00-03:00') → hora AR
                            try:
                                _s = created_at_raw.replace('Z', '+00:00')
                                _dt = datetime.fromisoformat(_s)
                                if _dt.tzinfo is not None:
                                    from datetime import timezone as _tz, timedelta as _td
                                    _ar = _tz(_td(hours=-3))
                                    created_at = _dt.astimezone(_ar).strftime('%Y-%m-%d %H:%M:%S')
                                else:
                                    created_at = _dt.strftime('%Y-%m-%d %H:%M:%S')
                            except Exception:
                                created_at = created_at_raw[:19].replace('T', ' ')
                        else:
                            created_at = now_ar().strftime('%Y-%m-%d %H:%M:%S')
                        total        = float(_sale.get('total_amount', 0) or 0)
                        payment_type = _sale.get('payment_type', 'cash')
                        cajero       = _sale.get('cajero') or _sale.get('username', '')
                        # Insertar venta con el mismo ID que tiene en Firebase y en PC-A
                        self.db.execute_update(
                            """INSERT OR IGNORE INTO sales
                               (id, total_amount, payment_type, cash_received, change_given,
                                created_at, cash_register_id, turno_nombre, notes)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                            (sale_id, total, payment_type,
                             float(_sale.get('cash_received', 0) or 0),
                             float(_sale.get('change_given', 0) or 0),
                             created_at, cash_register_id, cajero,
                             'Sincronizado desde otra PC')
                        )
                        # Solo actualizar totales de la caja si la venta pertenece
                        # a la caja local actualmente ABIERTA (evita sumar ventas
                        # de cajas viejas o de otras PCs a la caja local nueva).
                        if (cash_register_id
                                and local_open_id
                                and cash_register_id == local_open_id):
                            if payment_type == 'cash':
                                self.db.execute_update(
                                    "UPDATE cash_register SET cash_sales = cash_sales + ?, total_sales = total_sales + ? WHERE id = ?",
                                    (total, total, cash_register_id)
                                )
                            else:
                                self.db.execute_update(
                                    "UPDATE cash_register SET transfer_sales = transfer_sales + ?, total_sales = total_sales + ? WHERE id = ?",
                                    (total, total, cash_register_id)
                                )
                        logger.info(f"Firebase: Venta #{sale_id} insertada localmente (${total:.2f}, {payment_type}).")
                    except Exception as e:
                        logger.error(f"Firebase: Error insertando venta remota #{sale_id}: {e}")
                    self.refresh_all_views()

                QTimer.singleShot(0, _do_insert_sale)

            fb.start_sales_listener(on_new_sale)

            # 3. Listener de PERFILES DE FACTURACIÓN desde la web
            # Migración one-shot: refresca certs desde Firestore por si quedaron viejos.
            try:
                fb.force_refresh_certs_oneshot(self.db)
            except Exception as _e:
                logger.warning(f"Firebase: refresh oneshot de certs falló: {_e}")
            fb.start_perfiles_listener(self.db)

            # 4. Listener de CLIENTES DE FACTURACIÓN desde la web
            fb.start_clientes_listener(self.db)

            # 5. Listener de EMISOR ACTIVO HOY desde la web
            fb.start_emisor_activo_listener(self.db)

            # 6. Listener de STOCK (inventario) en tiempo real.
            # Cuando otra PC vende o la web edita, Firebase dispara el snapshot
            # y sincronizamos la SQLite local. Refresca la UI en el main thread.
            self._sig_stock_refresh.connect(self._on_stock_refresh_slot)
            def _on_stock_refresh():
                self._sig_stock_refresh.emit()
            fb.start_stock_sync_listener(self.db, on_refresh=_on_stock_refresh)

            # 7. Listener de OBSERVACIONES en tiempo real (compartidas entre PCs).
            def _on_obs_change():
                try:
                    if hasattr(self, 'observations_view') and self.observations_view is not None:
                        self.observations_view.refresh_requested.emit()
                except Exception as e:
                    logger.warning(f"Obs refresh emit: {e}")
            fb.start_observations_listener(self.db, on_change=_on_obs_change)

            logger.info("Listeners de sincronizacion en tiempo real activados (thread-safe).")
        except Exception as e:
            logger.warning(f"No se pudo activar listeners de sincronizacion: {e}")


    def check_cash_register_status(self):
        pass  # No mostrar popup: la caja se abre manualmente desde la pestaña Caja

    def on_tab_changed(self, index):
        current_widget = self.tabs.currentWidget()
        if hasattr(current_widget, 'refresh_data'):
            current_widget.refresh_data()

    # ── Slots para eventos de caja remotos (thread-safe via señales Qt) ──
    def _on_caja_open_slot(self, reg_id):
        logger.info(f"Firebase: Caja #{reg_id} abierta remotamente → refrescando.")
        self.refresh_all_views()

    def _on_stock_refresh_slot(self):
        """Firebase reportó cambios de stock — refrescar vistas de productos/ventas."""
        try:
            if self.products_view is not None:
                self.products_view.refresh_data()
        except Exception as e:
            logger.warning(f"Stock refresh: products_view: {e}")
        try:
            if self.sales_view is not None:
                self.sales_view.refresh_data()
        except Exception as e:
            logger.warning(f"Stock refresh: sales_view: {e}")
        try:
            self._check_low_stock_badge()
        except Exception:
            pass

    def _on_caja_close_slot(self, session_id, register_id=0):
        logger.info(
            f"Firebase: Cierre remoto detectado (sesión {session_id}, caja #{register_id})."
        )
        try:
            current = self.cash_register.get_current()
            if not current:
                # No hay caja abierta localmente — nada que cerrar
                self.refresh_all_views()
                return

            # Si el evento trae register_id, SOLO cerrar si matchea la caja local abierta.
            # Evita que un 'closed' stale en caja_activa/current cierre una caja
            # recién abierta en otra PC.
            if register_id and int(register_id) != int(current['id']):
                logger.info(
                    f"Firebase: Cierre remoto ignorado — corresponde a caja #{register_id}, "
                    f"pero la caja local abierta es #{current['id']}."
                )
                self.refresh_all_views()
                return

            sid = session_id or now_ar().strftime('%Y-%m-%d')
            self.db.execute_update(
                "UPDATE cash_register SET status='closed', closing_date=?, notes=? WHERE id=?",
                (now_ar().isoformat(), 'Cerrado remotamente', current['id'])
            )
            try:
                from pos_system.models.cash_register import CashRegister as _CR
                from pos_system.utils.firebase_sync import get_firebase_sync
                rep = _CR(self.db).get_closing_report(current['id'])
                rep['session_id'] = sid
                fb2 = get_firebase_sync()
                if fb2:
                    fb2.sync_cash_closing(rep, session_id=sid)
                    logger.info(f"Firebase: Cierre #{current['id']} subido (sesión {sid}).")
            except Exception as e2:
                logger.error(f"Firebase: Error subiendo cierre: {e2}")
        except Exception as e:
            logger.error(f"Firebase: Error cerrando caja local: {e}")
        self.refresh_all_views()

    def refresh_all_views(self):
        for view in [self.products_view, self.sales_view, self.cash_view,
                     self.history_view, self.promotions_view, self.fiscal_view,
                     self.users_view, self.promos_readonly_view]:
            if view is None:
                continue
            try:
                view.refresh_data()
            except Exception as e:
                logger.warning(f"Error refreshing {view.__class__.__name__}: {e}")

        self.update_status_bar()
        self._check_low_stock_badge()

    def _refresh_autostart_btn(self):
        """Actualiza el texto y estilo del botón de autostart según el estado actual."""
        if not hasattr(self, '_autostart_btn'):
            return
        try:
            from pos_system.utils.autostart import is_autostart_enabled
            enabled = is_autostart_enabled()
        except Exception:
            enabled = False

        if enabled:
            self._autostart_btn.setText('Auto: ON')
            self._autostart_btn.setStyleSheet('''
                QPushButton {
                    background: #d1e7dd; border: 1.5px solid #198754;
                    border-radius: 6px; padding: 3px 10px;
                    color: #0f5132; font-size: 10px; font-weight: bold;
                }
                QPushButton:hover { background: #badbcc; }
            ''')
        else:
            self._autostart_btn.setText('Auto: OFF')
            self._autostart_btn.setStyleSheet('''
                QPushButton {
                    background: #f8f9fa; border: 1px solid #dee2e6;
                    border-radius: 6px; padding: 3px 10px;
                    color: #6c757d; font-size: 10px;
                }
                QPushButton:hover { background: #e9ecef; }
            ''')

    def _toggle_autostart(self):
        """Habilita o deshabilita el inicio automático con Windows."""
        try:
            from pos_system.utils.autostart import is_autostart_enabled, set_autostart
            currently = is_autostart_enabled()
            ok = set_autostart(not currently)
            if ok:
                estado = 'habilitado' if not currently else 'deshabilitado'
                QMessageBox.information(
                    self, 'Inicio Automático',
                    f'El inicio automático al encender la PC fue {estado}.'
                )
                self._refresh_autostart_btn()
            else:
                QMessageBox.warning(
                    self, 'Inicio Automático',
                    'No se pudo modificar el inicio automático.\n'
                    'Verificá que la app tenga permisos para escribir en el registro.'
                )
        except Exception as e:
            logger.error(f"Toggle autostart error: {e}")
            QMessageBox.warning(self, 'Error', f'No se pudo cambiar el inicio automático:\n{e}')

    def _logout(self):
        """Cerrar sesión y mostrar login nuevamente"""
        try:
            current_register = self.cash_register.get_current()
            if current_register:
                reply = QMessageBox.question(
                    self, 'Cerrar Sesión',
                    'La caja está abierta. ¿Desea cerrar sesión de todas formas?\n\n'
                    'Recomendación: cierre la caja antes de salir.',
                    QMessageBox.Yes | QMessageBox.No, QMessageBox.No
                )
                if reply != QMessageBox.Yes:
                    return
            else:
                if not MessageBox.confirm(self, 'Cerrar Sesión', '¿Está seguro que desea cerrar sesión?'):
                    return
        except Exception:
            pass

        logger.info(f"User logged out: {self.current_user.get('username')}")
        self.timer.stop()
        self.stock_timer.stop()

        # Reabrir con selección de turno (sin pantalla de login)
        from pos_system.database.db_manager import DatabaseManager
        from pos_system.models.user import User as _User
        _db = DatabaseManager()
        _um  = _User(_db)
        _um.ensure_default_admin()
        _admins = _db.execute_query(
            "SELECT * FROM users WHERE role='admin' AND is_active=1 LIMIT 1"
        )
        if _admins:
            new_user = _admins[0]
        else:
            new_user = {'id': 0, 'username': 'admin', 'role': 'admin',
                        'full_name': 'Administrador', 'is_active': 1}
        new_window = MainWindow(current_user=new_user)
        new_window.show()
        self.close()

    def _do_cloud_sync(self, full_history=False):
        """
        Realiza la sincronizacion completa en un hilo de fondo.

        Args:
            full_history: Si True, sube TODAS las ventas historicas.
                          Si False, solo sube las ventas del dia actual.
        """
        try:
            from pos_system.utils.google_sheets_sync import get_sync, \
                _synced_sale_ids, _synced_withdrawal_ids, _synced_closing_ids, _synced_day_summaries
            from pos_system.models.sale import Sale
            from pos_system.models.cash_register import CashRegister
            from pos_system.database.db_manager import DatabaseManager
            from collections import defaultdict
            import pos_system.utils.google_sheets_sync as _gs_mod

            sync = get_sync()
            if not sync or not sync.enabled:
                return

            db = DatabaseManager()
            sale_model = Sale(db)
            register_model = CashRegister(db)

            # Si es historial completo, limpiar cache y activar modo sincronico
            if full_history:
                _gs_mod._synced_sale_ids.clear()
                _gs_mod._synced_withdrawal_ids.clear()
                _gs_mod._synced_closing_ids.clear()
                _gs_mod._synced_day_summaries.clear()
                sync._sync_mode = True  # Envios uno a la vez, sin hilos paralelos

            errores = []

            # 1. Inventario completo (siempre)
            products = self.product_model.get_all()
            sync.sync_inventory(products)

            if full_history:
                # Limpiar hojas antes de re-sync para evitar duplicados
                from pos_system.utils.google_sheets_sync import _month_name
                import datetime as _dt
                all_sales_pre = sale_model.get_all()
                # Obtener todos los meses distintos que tienen ventas
                meses_con_ventas = set()
                for s in all_sales_pre:
                    dt = sync._parse_dt(s.get('created_at'))
                    meses_con_ventas.add(_month_name(dt))
                # Limpiar hojas fijas
                sync.clear_sheet('Historial Diario', 'resumen_dia')
                sync.clear_sheet('Ventas por Dia', 'ventas_dia')
                sync.clear_sheet('Resumen Mensual', 'resumen')
                sync.clear_sheet('Cierres de Caja', 'cierre')
                sync.clear_sheet('Retiros', 'retiro')
                # Limpiar hoja de cada mes con ventas
                for mes in meses_con_ventas:
                    sync.clear_sheet(mes, 'venta')
                all_sales = all_sales_pre
                logger.info(f"Google Sheets: Sincronizando historial completo ({len(all_sales)} ventas)...")

                sales_by_day = defaultdict(list)
                for s in all_sales:
                    dt = sync._parse_dt(s.get('created_at'))
                    day_key = dt.strftime('%Y-%m-%d')
                    sales_by_day[day_key].append(s)
                    if 'username' not in s:
                        s['username'] = str(s.get('user_id', ''))

                # Ventas + detalle por dia (sincronico, uno a la vez)
                for s in all_sales:
                    sync.sync_sale(s)
                    sync.sync_sale_detail_by_day(s, db=db)

                # Resumen diario por cada dia
                for day_key in sorted(sales_by_day.keys()):
                    dt = datetime.strptime(day_key, '%Y-%m-%d')
                    sync.sync_daily_summary(sales_by_day[day_key], date=dt)

                # Cierres de caja historicos
                all_registers = register_model.get_all(status='closed', limit=200)
                for reg in all_registers:
                    closing_report = register_model.get_closing_report(reg['id'])
                    sync.sync_cash_closing(closing_report)
                    for w in (closing_report.get('withdrawals_list') or []):
                        sync.sync_withdrawal(w, register_id=reg['id'])

                # Ranking de productos mas vendidos
                sync.sync_top_products(db)

                sync._sync_mode = False  # Volver a modo asincrono
                logger.info(f"Google Sheets: Historial completo sincronizado ({len(all_sales)} ventas, {len(sales_by_day)} dias, {len(all_registers)} cierres)")

                # Firebase: subir todo el historial en un solo hilo (sin lanzar thread por venta)
                try:
                    from pos_system.utils.firebase_sync import get_firebase_sync
                    fb = get_firebase_sync()
                    if fb:
                        def _fb_full_sync():
                            try:
                                firedb = fb.db
                                from pos_system.utils.firebase_sync import _month_name, _get_pc_id
                                pc_id = _get_pc_id()
                                # Ventas — batch de hasta 500, ID compuesto para no pisar otras PCs
                                batch = firedb.batch()
                                count = 0
                                for s in all_sales:
                                    sale_id = str(s.get('id') or s.get('sale_id', ''))
                                    if not sale_id:
                                        continue
                                    created_at = fb._parse_dt(s.get('created_at'))
                                    items = s.get('items') or []
                                    def _fmt_q(q):
                                        q = float(q or 0)
                                        return str(int(q)) if q == int(q) else f"{q:.2f}".rstrip('0').rstrip('.')
                                    productos_str = ', '.join(
                                        f"{it.get('product_name', it.get('name','?'))} x{_fmt_q(it.get('quantity',1))}"
                                        for it in items[:3]
                                    )
                                    if len(items) > 3:
                                        productos_str += f' (+{len(items)-3} más)'
                                    fb_doc_id = f"{pc_id}_{sale_id}"
                                    ref = firedb.collection('ventas').document(fb_doc_id)
                                    batch.set(ref, {
                                        'sale_id':          int(sale_id),
                                        'pc_id':            pc_id,
                                        'created_at':       created_at,
                                        'payment_type':     s.get('payment_type', ''),
                                        'total_amount':     float(s.get('total_amount', 0) or 0),
                                        'cash_received':    float(s.get('cash_received', 0) or 0),
                                        'change_given':     float(s.get('change_given', 0) or 0),
                                        'items_count':      len(items) if items else int(s.get('items_count', 0) or 0),
                                        'productos':        productos_str,
                                        'username':         s.get('username') or str(s.get('user_id', '')),
                                        'discount':         float(s.get('discount', 0) or 0),
                                        'cash_register_id': int(s.get('cash_register_id') or 0) or None,
                                    })
                                    count += 1
                                    if count % 500 == 0:
                                        batch.commit()
                                        batch = firedb.batch()
                                batch.commit()

                                # Historial diario
                                for day_key, day_sales in sales_by_day.items():
                                    dt2 = datetime.strptime(day_key, '%Y-%m-%d')
                                    fb.sync_daily_summary(day_sales, date=dt2)

                                # Cierres de caja
                                for reg in all_registers:
                                    fb.sync_cash_closing(register_model.get_closing_report(reg['id']))

                                # Inventario completo (con limpieza de eliminados)
                                _products = self.product_model.get_all()
                                fb.sync_inventory(_products)

                                # Ranking productos
                                fb.sync_top_products(db)
                                logger.info("Firebase: Historial completo sincronizado.")
                            except Exception as _e:
                                logger.warning(f"Firebase sync (historial): {_e}")

                        import threading as _th
                        _th.Thread(target=_fb_full_sync, daemon=True).start()
                except Exception as _fbe:
                    logger.warning(f"Firebase sync (historial): {_fbe}")

            else:
                today_sales = sale_model.get_today_sales()
                for s in today_sales:
                    if 'username' not in s:
                        s['username'] = str(s.get('user_id', ''))
                    sync.sync_sale(s)
                    sync.sync_sale_detail_by_day(s, db=db)

                if today_sales:
                    sync.sync_daily_summary(today_sales)

                # Ranking de productos mas vendidos
                sync.sync_top_products(db)

                logger.info(f"Google Sheets: Auto-sync completado ({len(today_sales)} ventas hoy, {len(products)} productos)")

            # Notificar resultado al hilo principal
            if errores:
                self.cloud_sync_error.emit(errores[0])
            else:
                self.cloud_sync_ok.emit()

        except Exception as e:
            logger.error(f"Google Sheets: Error en sync: {e}")
            try:
                sync._sync_mode = False
            except Exception:
                pass
            self.cloud_sync_error.emit(str(e))

    def _check_firebase_status(self):
        pass  # Ya no se usa — eliminados los listeners en tiempo real

    def _auto_cloud_sync(self):
        """Sync automatico cada 40 min — solo ventas del dia, en background."""
        self.cloud_sync_info.emit('Sincronizando con Google Sheets...')
        t = threading.Thread(target=self._do_cloud_sync, args=(False,), daemon=True)
        t.start()
        logger.info("Google Sheets: Auto-sync iniciado en background.")

    def _prompt_turno(self):
        """
        Muestra el diálogo de selección de turno.
        - Admin: puede elegir cualquier cajero registrado o poner un nombre libre.
          Si elige un cajero (rol 'cajero'), se ocultan las pestañas de admin.
          Si elige admin o nombre libre, se muestran todas las pestañas.
        - Cajero: ya tiene su nombre fijo, no se pregunta.
        """
        if self.current_user.get('role') != 'admin':
            return  # Cajeros usan su propio nombre directamente

        from pos_system.ui.turno_dialog import TurnoDialog
        dlg = TurnoDialog(self, self.current_user)
        if dlg.exec_():
            nombre = dlg.turno_nombre
            turno_role = dlg.turno_role  # 'cajero', 'admin' o None (nombre libre)
            if nombre:
                self.current_user['turno_nombre'] = nombre
                self.current_user['turno_role'] = turno_role
                self._update_turno_display(nombre)
                # Propagar el turno a las vistas que lo necesiten
                if hasattr(self.sales_view, 'current_user'):
                    self.sales_view.current_user['turno_nombre'] = nombre
                if hasattr(self.cash_view, 'current_user'):
                    self.cash_view.current_user['turno_nombre'] = nombre
                # Ajustar visibilidad de pestañas según el rol del turno
                self._apply_turno_tab_visibility(turno_role)

    def _apply_turno_tab_visibility(self, turno_role: str):
        """
        Muestra u oculta las pestañas de admin según el rol del turno activo.
        - turno_role == 'cajero' → ocultar Productos, Cajeros
        - turno_role == 'admin' o None (nombre libre) → mostrar todo
        """
        admin_views = [
            (self.cash_view,       'Caja'),
            (self.products_view,   'Productos'),
            (self.users_view,      'Cajeros'),
        ]
        show_admin_tabs = (turno_role != 'cajero')

        for view, tab_name in admin_views:
            if view is None:
                continue
            idx = self.tabs.indexOf(view)
            if show_admin_tabs:
                # Mostrar: si no está en tabs, agregar
                if idx < 0:
                    self.tabs.addTab(view, tab_name)
            else:
                # Ocultar: si está en tabs, quitar
                if idx >= 0:
                    self.tabs.removeTab(idx)

        # Si se ocultaron tabs y la pestaña actual quedó inválida, ir a Ventas
        if not show_admin_tabs:
            self.tabs.setCurrentIndex(0)

        logger.info(f"Turno: tabs ajustadas para rol '{turno_role}' (show_admin={show_admin_tabs})")

    def _update_turno_display(self, nombre: str):
        """Actualiza el label de turno en el header y la status bar."""
        try:
            if hasattr(self, '_turno_lbl') and self._turno_lbl:
                self._turno_lbl.setText(f'Turno: {nombre}')
            self.update_status_bar()
        except Exception:
            pass

    def _open_cloud_menu(self):
        """Abre el menú de sincronización con opciones Subir / Descargar.
        También dispara un firebase_full_sync para refrescar promos/precios."""
        # Disparar sync Firebase en background al abrir el menú
        if hasattr(self, 'sales_view') and hasattr(self.sales_view, '_firebase_full_sync'):
            import threading
            threading.Thread(target=self.sales_view._firebase_full_sync, daemon=True).start()
        if hasattr(self, 'promos_readonly_view'):
            from PyQt5.QtCore import QTimer
            QTimer.singleShot(500, self.promos_readonly_view.refresh_data)

        from pos_system.ui.sync_progress_dialog import CloudSyncMenu
        CloudSyncMenu.show(
            parent_widget=self.cloud_btn,
            main_window=self,
            restore_btn_cb=self._restore_cloud_btn,
        )

    def _manual_cloud_sync(self):
        """Compatibilidad — ahora redirige al menú."""
        self._open_cloud_menu()

    def _restore_cloud_btn(self):
        """Restaura el boton nube despues del sync (llamado desde hilo principal)."""
        self.cloud_btn.setEnabled(True)
        self.cloud_btn.setText('Sincronizar')

    def _restore_promos_btn(self):
        """Restaura el botón de promociones después de la descarga."""
        if hasattr(self, 'promos_btn'):
            self.promos_btn.setEnabled(True)
            self.promos_btn.setText('Promociones')

    def _sync_promos_now(self):
        """
        Sincroniza todo desde Firebase (promos, rubros, precios) y actualiza el POS.
        Muestra feedback inmediato en el botón y un toast al terminar.
        """
        self.promos_btn.setEnabled(False)
        self.promos_btn.setText('Cargando...')

        def _do_with_callback():
            try:
                # Disparar el full sync del sales_view (promos + rubros + precios)
                if hasattr(self, 'sales_view') and hasattr(self.sales_view, '_firebase_full_sync'):
                    self.sales_view._firebase_full_sync()
                    # Resetear el timer para que cuente 2hs desde ahora
                    from PyQt5.QtCore import QTimer
                    QTimer.singleShot(0, lambda: self.sales_view._firebase_sync_timer.start())
                # También actualizar la vista de promos readonly
                if hasattr(self, 'promos_readonly_view'):
                    from PyQt5.QtCore import QTimer
                    QTimer.singleShot(0, self.promos_readonly_view.refresh_data)
                promos = getattr(self.sales_view, '_firebase_promos', [])
                activas = sum(1 for p in promos if p.get('activo') is True)
                self.cloud_sync_info.emit(f'Firebase sincronizado — {activas} promo(s) activa(s)')
            except Exception as e:
                self.cloud_sync_error.emit(str(e))
            finally:
                self.cloud_sync_done.emit()

        import threading
        threading.Thread(target=_do_with_callback, daemon=True).start()

    def _check_for_updates(self):
        """Verifica si hay una nueva versión disponible y lanza auto-update."""
        try:
            from pos_system.config import APP_VERSION, GITHUB_REPO
            from pos_system.utils.updater import check_for_updates

            def on_result(has_update, info):
                if has_update and info.get('download_url'):
                    self._update_info = info
                    self._sig_start_download.emit(info)

            check_for_updates(APP_VERSION, GITHUB_REPO, callback=on_result)
        except Exception as e:
            logger.debug(f"Error verificando actualizaciones: {e}")

    def _auto_start_download(self, info: dict):
        """Inicia la descarga e instalación automática en background."""
        import sys
        from pos_system.utils.updater import download_and_apply_update

        version = info.get('latest_version', '')
        download_url = info.get('download_url', '')
        app_dir = str(Path(sys.executable).parent)

        self.update_btn.setText(f'⬇ Descargando v{version}...')
        self.update_btn.setVisible(True)

        def on_progress(stage):
            labels = {
                'downloading': f'⬇ Descargando v{version}...',
                'extracting':  f'📦 Preparando v{version}...',
                'applying':    f'✓ Instalando v{version}...',
            }
            text = labels.get(stage, stage)
            QTimer.singleShot(0, lambda: self.update_btn.setText(text))

        def on_done(success):
            self._sig_update_ready.emit(success)

        download_and_apply_update(download_url, app_dir,
                                  on_progress=on_progress, on_done=on_done)

    def _on_update_ready(self, success: bool):
        """Llamado desde hilo principal cuando el update está listo para aplicarse."""
        if success:
            self.update_btn.setText('✓ Reiniciando...')
            QTimer.singleShot(800, QApplication.instance().quit)
        else:
            self.update_btn.setText('⚠ Error al actualizar')

    def _poll_sync_trigger(self):
        """Corre cada 60s — detecta si el admin disparó un sync desde otra PC."""
        def _check():
            try:
                from pos_system.utils.firebase_sync import get_firebase_sync, _get_pc_id
                fb = get_firebase_sync()
                if not fb or not fb.enabled:
                    return
                trigger = fb.read_sync_trigger()
                if not trigger:
                    return
                ts  = trigger.get('timestamp', '')
                pc  = trigger.get('pc_id', '')
                cmd = trigger.get('command', 'upload')
                # Si somos la PC que originó el trigger, solo actualizar el timestamp conocido
                if pc == _get_pc_id():
                    self._last_sync_trigger_ts = ts
                    return
                # Ignorar si ya procesamos este timestamp
                if ts == self._last_sync_trigger_ts:
                    return
                # Primera vez que corremos (arranque de la app): marcar el trigger actual
                # como visto sin procesarlo. Evita re-ejecutar syncs de sesiones anteriores.
                if self._last_sync_trigger_ts is None:
                    self._last_sync_trigger_ts = ts
                    logger.debug(f"_poll_sync_trigger: trigger previo ignorado al inicio ({ts})")
                    return
                self._last_sync_trigger_ts = ts
                self._sig_remote_sync.emit(cmd, pc)
            except Exception as e:
                logger.debug(f"_poll_sync_trigger: {e}")
        import threading
        threading.Thread(target=_check, daemon=True).start()

    def _on_remote_sync_detected(self, command: str, remote_pc: str):
        """El admin disparó un sync — ejecutar silenciosamente el mismo comando."""
        from pos_system.ui.components import Toast
        from pos_system.ui.sync_progress_dialog import SyncWorker, DownloadWorker

        # Evitar iniciar un segundo sync si ya hay uno corriendo
        if getattr(self, '_silent_sync_worker', None) and self._silent_sync_worker.isRunning():
            logger.debug(f"_on_remote_sync_detected: sync ya en curso, ignorando trigger de {remote_pc}")
            return

        if command == 'upload':
            Toast.info(self, f'Sincronización iniciada por {remote_pc} — subiendo datos...')
            worker = SyncWorker(self, full_history=True, write_trigger=False)
        else:
            Toast.info(self, f'Sincronización iniciada por {remote_pc} — descargando datos...')
            worker = DownloadWorker(main_window=self, write_trigger=False)

        worker.finished.connect(lambda ok, msg: self._on_silent_sync_done(ok, command, remote_pc))
        worker.start()
        self._silent_sync_worker = worker  # evitar GC

    def _on_silent_sync_done(self, success: bool, command: str, remote_pc: str):
        from pos_system.ui.components import Toast
        accion = 'subida' if command == 'upload' else 'descarga'
        if success:
            self.refresh_all_views()
            self._check_low_stock_badge()
            Toast.success(self, f'Sincronización ({accion}) completada')
        else:
            Toast.error(self, f'Error en sincronización automática ({accion})')
        self._silent_sync_worker = None

    def _start_delta_product_sync(self):
        """Lanza el delta sync de productos en background (sin bloquear la UI)."""
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if not fb or not fb.enabled:
                return
            logger.debug("Delta sync de productos: iniciando en background...")
            fb.delta_sync_products_startup(
                local_db=self.db,
                on_done=lambda n: self._sig_delta_sync_done.emit(n),
            )
        except Exception as e:
            logger.debug(f"Delta sync productos: no iniciado ({e})")

    def _on_delta_sync_done(self, n_updated: int):
        """Slot ejecutado en hilo principal cuando el delta sync termina."""
        if n_updated > 0:
            self.products_view.refresh_data()
            Toast.info(self, f'{n_updated} producto{"s" if n_updated != 1 else ""} actualizado{"s" if n_updated != 1 else ""} desde Firebase')
            logger.info(f"Delta sync: {n_updated} productos aplicados a la vista.")

    def closeEvent(self, event):
        try:
            current_register = self.cash_register.get_current()
            if current_register:
                if MessageBox.confirm(
                    self,
                    'Confirmar Cierre',
                    'La caja está abierta. ¿Está seguro que desea cerrar la aplicación?\n\n'
                    'Recomendación: cierre la caja antes de salir.'
                ):
                    logger.info("Application closed with open cash register")
                    event.accept()
                else:
                    event.ignore()
            else:
                logger.info("Application closed normally")
                event.accept()
        except Exception as e:
            logger.error(f"Error during close: {e}")
            event.accept()
