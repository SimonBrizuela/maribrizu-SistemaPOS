"""
Login dialog for POS System
"""
import logging
from PyQt5.QtWidgets import (QDialog, QVBoxLayout, QHBoxLayout, QLabel,
                             QLineEdit, QPushButton, QMessageBox, QFrame,
                             QApplication, QSizePolicy, QScrollArea, QWidget)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont, QKeySequence
from PyQt5.QtWidgets import QShortcut

from pos_system.models.user import User
from pos_system.database.db_manager import DatabaseManager

logger = logging.getLogger(__name__)


class LoginDialog(QDialog):
    """Login dialog shown at application startup"""

    def __init__(self, db: DatabaseManager):
        super().__init__()
        self.db = db
        self.user_model = User(db)
        self.logged_user = None
        self._ensure_default_admin()
        self.init_ui()

    def _ensure_default_admin(self):
        created = self.user_model.ensure_default_admin()
        if created:
            logger.info("Admin por defecto creado")

    def init_ui(self):
        from pos_system.config import APP_NAME, APP_VERSION
        self.setWindowTitle(f'{APP_NAME} — Iniciar Sesión')
        self.setWindowFlags(Qt.Dialog | Qt.WindowTitleHint)
        self.setModal(True)

        # ── Tamaño adaptable a la pantalla ───────────────────────────────
        screen = QApplication.primaryScreen().availableGeometry()
        w = max(440, min(520, int(screen.width()  * 0.36)))
        h = max(560, min(700, int(screen.height() * 0.82)))
        self.resize(w, h)
        self.setMinimumSize(400, 520)
        # Centrar
        self.move(
            screen.x() + (screen.width()  - w) // 2,
            screen.y() + (screen.height() - h) // 2,
        )

        self.setStyleSheet("""
            QDialog { background-color: #f0f2f5; }
            QScrollArea { border: none; background: transparent; }
            QWidget#scrollContent { background: transparent; }
            QLabel#loginTitle {
                color: #1a1a1a; font-size: 20px; font-weight: bold;
            }
            QLabel#loginSubtitle { color: #6c757d; font-size: 11px; }
            QLineEdit {
                border: 1.5px solid #dee2e6; border-radius: 8px;
                padding: 10px 14px; font-size: 13px;
                background: white; color: #212529;
            }
            QLineEdit:focus { border-color: #0d6efd; }
            QPushButton#btnLogin {
                background-color: #0d6efd; color: white;
                border: none; border-radius: 8px;
                padding: 13px; font-size: 14px; font-weight: bold;
            }
            QPushButton#btnLogin:hover    { background-color: #0b5ed7; }
            QPushButton#btnLogin:pressed  { background-color: #0a58ca; }
            QFrame#card {
                background: white; border: 1px solid #dee2e6;
                border-radius: 14px;
            }
        """)

        # ── Layout raíz con scroll para que todo quepa ───────────────────
        root_layout = QVBoxLayout(self)
        root_layout.setContentsMargins(0, 0, 0, 0)
        root_layout.setSpacing(0)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)

        content = QWidget()
        content.setObjectName('scrollContent')
        main_layout = QVBoxLayout(content)
        main_layout.setContentsMargins(28, 28, 28, 28)
        main_layout.setSpacing(16)

        scroll.setWidget(content)
        root_layout.addWidget(scroll)

        # ── Header ───────────────────────────────────────────────────────
        title = QLabel(APP_NAME)
        title.setObjectName('loginTitle')
        title.setFont(QFont('Segoe UI', 20, QFont.Bold))
        title.setAlignment(Qt.AlignCenter)
        main_layout.addWidget(title)

        subtitle = QLabel(f'Sistema de Punto de Venta  v{APP_VERSION}')
        subtitle.setObjectName('loginSubtitle')
        subtitle.setFont(QFont('Segoe UI', 10))
        subtitle.setAlignment(Qt.AlignCenter)
        main_layout.addWidget(subtitle)

        # ── Card de login ─────────────────────────────────────────────────
        card = QFrame()
        card.setObjectName('card')
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(24, 22, 24, 22)
        card_layout.setSpacing(12)

        login_title = QLabel('Iniciar Sesión')
        login_title.setFont(QFont('Segoe UI', 14, QFont.Bold))
        login_title.setStyleSheet('color: #212529;')
        login_title.setAlignment(Qt.AlignCenter)
        card_layout.addWidget(login_title)

        # Usuario
        user_label = QLabel('Usuario')
        user_label.setFont(QFont('Segoe UI', 10, QFont.Bold))
        user_label.setStyleSheet('color: #495057;')
        card_layout.addWidget(user_label)

        self.username_input = QLineEdit()
        self.username_input.setPlaceholderText('Ingrese su usuario')
        self.username_input.setFont(QFont('Segoe UI', 12))
        self.username_input.setMinimumHeight(42)
        card_layout.addWidget(self.username_input)

        # Contraseña
        pass_label = QLabel('Contraseña')
        pass_label.setFont(QFont('Segoe UI', 10, QFont.Bold))
        pass_label.setStyleSheet('color: #495057;')
        card_layout.addWidget(pass_label)

        self.password_input = QLineEdit()
        self.password_input.setEchoMode(QLineEdit.Password)
        self.password_input.setPlaceholderText('Ingrese su contraseña')
        self.password_input.setFont(QFont('Segoe UI', 12))
        self.password_input.setMinimumHeight(42)
        self.password_input.returnPressed.connect(self.attempt_login)
        card_layout.addWidget(self.password_input)

        # Botón login
        self.login_btn = QPushButton('Ingresar al Sistema')
        self.login_btn.setObjectName('btnLogin')
        self.login_btn.setMinimumHeight(48)
        self.login_btn.setFont(QFont('Segoe UI', 13, QFont.Bold))
        self.login_btn.clicked.connect(self.attempt_login)
        card_layout.addWidget(self.login_btn)

        # Error
        self.error_label = QLabel('')
        self.error_label.setStyleSheet('color: #dc3545; font-size: 11px;')
        self.error_label.setAlignment(Qt.AlignCenter)
        self.error_label.setWordWrap(True)
        card_layout.addWidget(self.error_label)

        main_layout.addWidget(card)

        # Hint
        hint = QLabel('Primer inicio: usuario <b>admin</b> · contraseña <b>admin123</b>')
        hint.setStyleSheet('color: #6c757d; font-size: 10px;')
        hint.setAlignment(Qt.AlignCenter)
        hint.setFont(QFont('Segoe UI', 9))
        main_layout.addWidget(hint)

        # ── Botón Primera Instalación ─────────────────────────────────────
        self._add_first_install_button(main_layout)

        main_layout.addStretch()

        self.username_input.setFocus()

    def attempt_login(self):
        username = self.username_input.text().strip()
        password = self.password_input.text()

        if not username:
            self.show_error('Por favor ingrese su usuario')
            self.username_input.setFocus()
            return
        if not password:
            self.show_error('Por favor ingrese su contraseña')
            self.password_input.setFocus()
            return

        self.login_btn.setEnabled(False)
        self.login_btn.setText('Verificando...')
        self.error_label.setText('')

        user = self.user_model.authenticate(username, password)

        self.login_btn.setEnabled(True)
        self.login_btn.setText('Ingresar al Sistema')

        if user:
            self.logged_user = user
            logger.info(f"Login exitoso: {user['username']} ({user['role']})")
            self.accept()
        else:
            self.show_error('Usuario o contraseña incorrectos')
            self.password_input.clear()
            self.password_input.setFocus()

    def show_error(self, message: str):
        self.error_label.setText(message)

    # ── Primera Instalación ───────────────────────────────────────────────

    def _add_first_install_button(self, layout):
        """Agrega el botón de Primera Instalación si Firebase está disponible."""
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            firebase_ok = fb is not None and fb.enabled
        except Exception:
            firebase_ok = False

        sep_row = QHBoxLayout()
        sep_left = QFrame(); sep_left.setFrameShape(QFrame.HLine)
        sep_left.setStyleSheet('color: #dee2e6;')
        sep_right = QFrame(); sep_right.setFrameShape(QFrame.HLine)
        sep_right.setStyleSheet('color: #dee2e6;')
        sep_lbl = QLabel('ó')
        sep_lbl.setStyleSheet('color: #adb5bd; font-size: 11px;')
        sep_lbl.setAlignment(Qt.AlignCenter)
        sep_row.addWidget(sep_left, 1)
        sep_row.addWidget(sep_lbl)
        sep_row.addWidget(sep_right, 1)
        layout.addLayout(sep_row)

        self.install_btn = QPushButton('Primera Instalación — Descargar datos desde Firebase')
        self.install_btn.setStyleSheet('''
            QPushButton {
                background: #f0fdf4;
                border: 1.5px solid #86efac;
                border-radius: 8px;
                padding: 10px 14px;
                color: #166534;
                font-size: 12px;
                font-weight: bold;
                text-align: center;
            }
            QPushButton:hover {
                background: #dcfce7;
                border-color: #4ade80;
            }
            QPushButton:pressed {
                background: #bbf7d0;
            }
            QPushButton:disabled {
                background: #f1f5f9;
                border-color: #cbd5e1;
                color: #94a3b8;
            }
        ''')
        self.install_btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
        self.install_btn.setMinimumHeight(44)
        self.install_btn.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)

        if firebase_ok:
            self.install_btn.setToolTip(
                'Descarga todos los productos, precios, rubros y códigos de barra\n'
                'desde Firebase hacia este POS.\n\n'
                'Ideal para instalar el sistema en una PC nueva.'
            )
            self.install_btn.clicked.connect(self._run_first_install)
        else:
            self.install_btn.setEnabled(False)
            self.install_btn.setText('Primera Instalación  (Firebase no configurado)')
            self.install_btn.setToolTip(
                'Firebase no está configurado o no se pudo conectar.\n'
                'Verifica que firebase_key.json esté presente.')

        layout.addWidget(self.install_btn)

    def _run_first_install(self):
        """Ejecuta la descarga completa desde Firebase para primera instalación."""
        reply = QMessageBox.question(
            self,
            'Primera Instalación',
            'Esta acción descargará desde Firebase:\n\n'
            '  • Todos los productos y precios\n'
            '  • Rubros y categorías\n'
            '  • Códigos de barra\n\n'
            'Los datos existentes en este equipo serán actualizados\n'
            'solo si Firebase tiene una versión más nueva.\n\n'
            '¿Continuar?',
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.Yes
        )
        if reply != QMessageBox.Yes:
            return

        self.install_btn.setEnabled(False)
        self.install_btn.setText('Descargando...')

        # Crear un objeto "main_window" mínimo que solo tenga product_model
        # (el DownloadWorker solo lo usa para refresh al final, que es opcional)
        class _MinimalWindow:
            def __init__(self):
                from pos_system.database.db_manager import DatabaseManager
                from pos_system.models.product import Product
                db = DatabaseManager()
                self.product_model = Product(db)
            def refresh_all_views(self): pass
            def _check_low_stock_badge(self): pass

        from pos_system.ui.sync_progress_dialog import SyncProgressDialog

        dlg = SyncProgressDialog(self, mode='download', full_history=True)

        def on_done(result_code):
            self.install_btn.setEnabled(True)
            self.install_btn.setText('Descarga completada — Ahora podés iniciar sesión')
            self.install_btn.setStyleSheet('''
                QPushButton {
                    background: #dcfce7;
                    border: 1.5px solid #4ade80;
                    border-radius: 8px;
                    padding: 10px 14px;
                    color: #166534;
                    font-size: 12px;
                    font-weight: bold;
                }
            ''')

        dlg.finished.connect(on_done)
        dlg.start_sync(_MinimalWindow())
        dlg.exec_()
