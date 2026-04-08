import logging
import threading
from PyQt5.QtWidgets import (QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
                             QTabWidget, QLabel, QStatusBar, QShortcut,
                             QPushButton, QMessageBox, QSizePolicy, QApplication)
from PyQt5.QtCore import pyqtSignal
from PyQt5.QtCore import Qt, QTimer
from PyQt5.QtGui import QFont, QKeySequence
from datetime import datetime, timedelta

from pos_system.ui.products_view import ProductsView
from pos_system.ui.sales_view import SalesView
from pos_system.ui.cash_view import CashView
from pos_system.ui.sales_history_view import SalesHistoryView
from pos_system.ui.components import MessageBox, Toast
from pos_system.models.cash_register import CashRegister
from pos_system.models.product import Product

logger = logging.getLogger(__name__)


class MainWindow(QMainWindow):
    cloud_sync_done  = pyqtSignal()        # restaurar botón al terminar sync
    cloud_sync_ok    = pyqtSignal()        # toast éxito (thread-safe)
    cloud_sync_error = pyqtSignal(str)     # toast error (thread-safe)
    cloud_sync_info  = pyqtSignal(str)     # toast info  (thread-safe)

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
        self.init_ui()
        # Después de construir la UI, preguntar quién está en el turno (solo admins)
        from PyQt5.QtCore import QTimer as _QT
        _QT.singleShot(300, self._prompt_turno)

    def init_ui(self):
        from pos_system.config import APP_NAME, WINDOW_WIDTH, WINDOW_HEIGHT, WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT

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

        # Vista de promociones (solo lectura) — visible para todos
        from pos_system.ui.promos_readonly_view import PromosReadOnlyView
        self.promos_readonly_view = PromosReadOnlyView(self)

        # Vistas solo para admin
        if is_admin:
            self.products_view = ProductsView(self)
            # Promociones se gestionan desde la webapp (Firebase) — no hay tab local
            self.promotions_view = None
            from pos_system.ui.fiscal_view import FiscalView
            self.fiscal_view = FiscalView(self)
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

        # Pestañas adicionales solo para admin
        if is_admin:
            self.tabs.addTab(self.products_view, 'Productos')
            # Promociones ya no tiene tab — se gestionan desde la webapp
            self.tabs.addTab(self.fiscal_view, 'Fiscal')
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

        # Verificar actualizaciones en segundo plano (30s de retraso para no entorpecer el inicio)
        from PyQt5.QtCore import QTimer as _QT2
        _QT2.singleShot(30000, self._check_for_updates)

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
        from pos_system.config import APP_NAME, APP_VERSION

        # ── Detectar tamaño de pantalla para ajustar el header ──────────
        screen = QApplication.primaryScreen().availableGeometry()
        small_screen = screen.width() < 1200   # Pantallas pequeñas (< 1200px)
        title_font_size  = 13 if small_screen else 17
        sub_font_size    = 8  if small_screen else 9
        btn_font_size    = 8  if small_screen else 9
        btn_padding      = '5px 10px' if small_screen else '6px 16px'
        header_max_h     = 42 if small_screen else 48

        header = QWidget()
        header.setObjectName("headerWidget")
        header.setStyleSheet('''
            QWidget#headerWidget {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 #ffffff, stop:1 #f8f9fa);
                border-radius: 10px;
                border: 1px solid #e1e4e8;
            }
        ''')
        header.setMaximumHeight(header_max_h)
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(16, 4, 16, 4)
        header_layout.setSpacing(10)

        header_layout.addStretch()

        # ── Info del usuario activo ───────────────────────────────────────
        user_role = self.current_user.get('role', '')
        role_label_text = 'Administrador' if user_role == 'admin' else 'Cajero'
        user_container = QVBoxLayout()
        user_container.setSpacing(1)

        user_name_label = QLabel(self.current_user.get('full_name', 'Usuario'))
        user_name_label.setFont(QFont('Segoe UI', 10, QFont.Bold))
        user_name_label.setStyleSheet('color: #212529; background: transparent;')

        role_label = QLabel(role_label_text)
        role_label.setFont(QFont('Segoe UI', sub_font_size))
        color = '#0d6efd' if user_role == 'admin' else '#198754'
        role_label.setStyleSheet(f'color: {color}; background: transparent;')

        user_container.addWidget(user_name_label)
        user_container.addWidget(role_label)
        header_layout.addLayout(user_container)

        # ── Label de turno activo (clickeable para cambiar si es admin) ──
        self._turno_lbl = None
        if user_role == 'admin':
            turno_nombre = self.current_user.get('turno_nombre') or self.current_user.get('full_name', '')
            self._turno_lbl = QPushButton(f'Turno: {turno_nombre}')
            self._turno_lbl.setStyleSheet(f'''
                QPushButton {{
                    background: #fff3cd;
                    border: 1.5px solid #ffc107;
                    border-radius: 6px;
                    padding: {btn_padding};
                    color: #856404;
                    font-size: {btn_font_size + 1}px;
                    font-weight: bold;
                }}
                QPushButton:hover {{
                    background: #ffe69c;
                    border-color: #e0a800;
                }}
            ''')
            self._turno_lbl.setFont(QFont('Segoe UI', btn_font_size, QFont.Bold))
            self._turno_lbl.setToolTip('Click para cambiar el cajero de turno')
            self._turno_lbl.clicked.connect(self._prompt_turno)
            header_layout.addWidget(self._turno_lbl)
        else:
            # Cajero: mostrar su nombre como etiqueta fija (no clickeable)
            cajero_nombre = self.current_user.get('full_name') or self.current_user.get('username', '')
            cajero_lbl = QLabel(f'{cajero_nombre}')
            cajero_lbl.setStyleSheet(f'''
                background: #d1e7dd;
                border: 1.5px solid #198754;
                border-radius: 6px;
                padding: {btn_padding};
                color: #0f5132;
                font-size: {btn_font_size + 1}px;
                font-weight: bold;
            ''')
            cajero_lbl.setFont(QFont('Segoe UI', btn_font_size, QFont.Bold))
            cajero_lbl.setToolTip('Cajero activo')
            header_layout.addWidget(cajero_lbl)

        # ── Botón Promociones (descarga en tiempo real desde Firebase) ───
        self.promos_btn = QPushButton('Promociones')
        self.promos_btn.setStyleSheet(f'''
            QPushButton {{
                background: #198754;
                border: none;
                border-radius: 6px;
                padding: {btn_padding};
                color: white;
                font-size: {btn_font_size + 1}px;
                font-weight: bold;
            }}
            QPushButton:hover {{ background: #157347; }}
            QPushButton:pressed {{ background: #146c43; }}
            QPushButton:disabled {{ background: #6c757d; color: #ced4da; }}
        ''')
        self.promos_btn.setFont(QFont('Segoe UI', btn_font_size, QFont.Bold))
        self.promos_btn.setToolTip('Sincronizar promociones desde Firebase en tiempo real')
        self.promos_btn.clicked.connect(self._sync_promos_now)
        header_layout.addWidget(self.promos_btn)

        # Mostrar solo si Firebase está disponible
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync as _gfs
            _fb = _gfs()
            self.promos_btn.setVisible(_fb is not None and _fb.enabled)
        except Exception:
            self.promos_btn.setVisible(False)

        # ── Botón Sincronizar con la Nube (abre menú Subir/Descargar) ────
        self.cloud_btn = QPushButton('Sincronizar')
        self.cloud_btn.setStyleSheet(f'''
            QPushButton {{
                background: #0d6efd;
                border: none;
                border-radius: 6px;
                padding: {btn_padding};
                color: white;
                font-size: {btn_font_size + 2}px;
                font-weight: bold;
            }}
            QPushButton:hover {{ background: #0b5ed7; }}
            QPushButton:pressed {{ background: #0a58ca; }}
            QPushButton:disabled {{
                background: #6c757d;
                color: #ced4da;
            }}
        ''')
        self.cloud_btn.setFont(QFont('Segoe UI', btn_font_size, QFont.Bold))
        self.cloud_btn.setToolTip(
            'Sincronizar con Firebase:\n'
            '• Subir Datos → ventas, cierres, inventario → nube\n'
            '• Descargar Datos → productos, precios, rubros → este POS'
        )
        self.cloud_btn.clicked.connect(self._open_cloud_menu)
        header_layout.addWidget(self.cloud_btn)

        # Mostrar botón si Firebase está disponible
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            self.cloud_btn.setVisible(fb is not None and fb.enabled)
        except Exception:
            self.cloud_btn.setVisible(True)

        # ── Botón de actualización disponible (oculto por defecto) ──────
        self.update_btn = QPushButton('🔔 Actualización disponible')
        self.update_btn.setStyleSheet(f'''
            QPushButton {{
                background: #fff3cd;
                border: 1.5px solid #ffc107;
                border-radius: 6px;
                padding: {btn_padding};
                color: #856404;
                font-size: {btn_font_size}px;
                font-weight: bold;
            }}
            QPushButton:hover {{ background: #ffe69c; border-color: #e0a800; }}
            QPushButton:pressed {{ background: #ffd866; }}
        ''')
        self.update_btn.setFont(QFont('Segoe UI', btn_font_size, QFont.Bold))
        self.update_btn.setVisible(False)
        self.update_btn.clicked.connect(self._on_update_clicked)
        header_layout.addWidget(self.update_btn)

        # ── Botón logout ──────────────────────────────────────────────────
        logout_btn = QPushButton('Cerrar Sesión')
        logout_btn.setStyleSheet(f'''
            QPushButton {{
                background: #f8f9fa;
                border: 1px solid #dee2e6;
                border-radius: 6px;
                padding: {btn_padding};
                color: #495057;
                font-size: {btn_font_size + 2}px;
            }}
            QPushButton:hover {{
                background: #e9ecef;
                border-color: #adb5bd;
            }}
        ''')
        logout_btn.setFont(QFont('Segoe UI', btn_font_size))
        logout_btn.clicked.connect(self._logout)
        logout_btn.setToolTip('Cerrar sesión (Ctrl+L)')
        header_layout.addWidget(logout_btn)

        return header

    def update_status_bar(self):
        now = datetime.now()
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

    def check_cash_register_status(self):
        try:
            current_register = self.cash_register.get_current()
            if not current_register:
                if MessageBox.confirm(
                    self,
                    'Caja Cerrada',
                    '¿Desea abrir la caja para comenzar a trabajar?'
                ):
                    self.tabs.setCurrentWidget(self.cash_view)
        except Exception as e:
            logger.error(f"Error checking cash register status: {e}")

    def on_tab_changed(self, index):
        current_widget = self.tabs.currentWidget()
        if hasattr(current_widget, 'refresh_data'):
            current_widget.refresh_data()

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

        # Relanzar login
        from pos_system.ui.login_dialog import LoginDialog
        from pos_system.database.db_manager import DatabaseManager
        db = DatabaseManager()
        login = LoginDialog(db)
        if login.exec_() == LoginDialog.Accepted:
            new_user = login.logged_user
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
                                # Ventas — batch de hasta 500
                                batch = firedb.batch()
                                count = 0
                                for s in all_sales:
                                    sale_id = str(s.get('id') or s.get('sale_id', ''))
                                    if not sale_id:
                                        continue
                                    from pos_system.utils.firebase_sync import _month_name
                                    created_at = fb._parse_dt(s.get('created_at'))
                                    items = s.get('items') or []
                                    productos_str = ', '.join(
                                        f"{it.get('product_name', it.get('name','?'))} x{it.get('quantity',1)}"
                                        for it in items[:3]
                                    )
                                    if len(items) > 3:
                                        productos_str += f' (+{len(items)-3} más)'
                                    ref = firedb.collection('ventas').document(sale_id)
                                    batch.set(ref, {
                                        'sale_id':       int(sale_id),
                                        'created_at':    created_at,
                                        'payment_type':  s.get('payment_type', ''),
                                        'total_amount':  float(s.get('total_amount', 0) or 0),
                                        'cash_received': float(s.get('cash_received', 0) or 0),
                                        'change_given':  float(s.get('change_given', 0) or 0),
                                        'items_count':   len(items) if items else int(s.get('items_count', 0) or 0),
                                        'productos':     productos_str,
                                        'username':      s.get('username') or str(s.get('user_id', '')),
                                        'discount':      float(s.get('discount', 0) or 0),
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
        - turno_role == 'cajero' → ocultar Productos, Fiscal, Cajeros
        - turno_role == 'admin' o None (nombre libre) → mostrar todo
        """
        admin_views = [
            (self.cash_view,       'Caja'),
            (self.products_view,   'Productos'),
            (self.fiscal_view,     'Fiscal'),
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
        """Verifica si hay una nueva versión disponible en GitHub Releases."""
        try:
            from pos_system.config import APP_VERSION, GITHUB_REPO
            from pos_system.utils.updater import check_for_updates
            from PyQt5.QtCore import QMetaObject, Qt, Q_ARG

            def on_result(has_update, info):
                if has_update:
                    version = info.get('latest_version', '')
                    self._update_info = info
                    # Actualizar UI desde el hilo principal
                    QTimer.singleShot(0, lambda: self._show_update_btn(version))

            check_for_updates(APP_VERSION, GITHUB_REPO, callback=on_result)
        except Exception as e:
            logger.debug(f"Error verificando actualizaciones: {e}")

    def _show_update_btn(self, version: str):
        """Muestra el botón de actualización en el header (llamado desde hilo principal)."""
        if hasattr(self, 'update_btn'):
            self.update_btn.setText(f'🔔 v{version} disponible')
            self.update_btn.setVisible(True)
            self.update_btn.setToolTip(
                f'Nueva versión v{version} disponible.\n'
                'Click para ver y descargar la actualización.'
            )

    def _on_update_clicked(self):
        """Muestra diálogo con info de la actualización y opción de descargar."""
        info = getattr(self, '_update_info', {})
        version = info.get('latest_version', '?')
        release_url = info.get('release_url', '')
        download_url = info.get('download_url', '')
        notes = info.get('release_notes', '') or ''

        from pos_system.config import APP_VERSION
        notes_preview = notes[:400] + ('...' if len(notes) > 400 else '')

        msg = QMessageBox(self)
        msg.setWindowTitle('Actualización disponible')
        msg.setIcon(QMessageBox.Information)
        msg.setText(
            f'<b>Nueva versión v{version} disponible</b><br>'
            f'Versión actual: v{APP_VERSION}'
        )
        if notes_preview:
            msg.setInformativeText(notes_preview)

        btn_download = msg.addButton('⬇️ Descargar', QMessageBox.AcceptRole)
        btn_web      = msg.addButton('🌐 Ver en GitHub', QMessageBox.HelpRole)
        msg.addButton('Más tarde', QMessageBox.RejectRole)

        msg.exec_()

        clicked = msg.clickedButton()
        from pos_system.utils.updater import download_and_open, open_release_page
        if clicked == btn_download and download_url:
            download_and_open(download_url)
        elif clicked == btn_web and release_url:
            open_release_page(release_url)

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
