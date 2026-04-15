"""
Diálogo de selección de turno.
Aparece cuando un administrador inicia sesión y permite elegir
quién está trabajando en el turno actual (puede ser un cajero diferente).
"""
import logging
from PyQt5.QtWidgets import (QDialog, QVBoxLayout, QHBoxLayout, QLabel,
                             QLineEdit, QPushButton, QListWidget, QListWidgetItem,
                             QFrame, QApplication, QSizePolicy, QMessageBox,
                             QScrollArea, QWidget)
from PyQt5.QtCore import Qt, QTimer
from PyQt5.QtGui import QFont

AUTOSELECT_SECONDS = 30

logger = logging.getLogger(__name__)


class TurnoDialog(QDialog):
    """
    Diálogo para seleccionar el cajero del turno actual.

    El admin puede:
      1. Seleccionar un cajero registrado en el sistema
      2. Escribir un nombre libre (ej: "Carlos" aunque no esté en el sistema)
      3. Quedarse como "admin" (si presiona Cancelar o cierra)
    """

    def __init__(self, parent=None, current_user: dict = None):
        super().__init__(parent)
        self.current_user  = current_user or {}
        self.turno_nombre  = (
            current_user.get('turno_nombre')
            or current_user.get('full_name')
            or current_user.get('username', 'admin')
        )
        self.turno_role = current_user.get('turno_role', 'admin')  # rol del turno activo
        self._cajeros_data = {}  # nombre -> role
        self.setWindowTitle('Quién está en el turno')
        self.setModal(True)
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowContextHelpButtonHint)

        # Tamaño adaptable a la pantalla disponible
        screen = QApplication.primaryScreen().availableGeometry()
        w = max(340, min(440, int(screen.width() * 0.30)))
        h = max(360, min(520, int(screen.height() * 0.60)))
        self.resize(w, h)
        self.setMinimumSize(300, 320)

        # Centrar
        self.move(
            screen.x() + (screen.width()  - self.width())  // 2,
            screen.y() + (screen.height() - self.height()) // 2,
        )

        self._countdown = AUTOSELECT_SECONDS
        self._timer = QTimer(self)
        self._timer.setInterval(1000)
        self._timer.timeout.connect(self._on_tick)

        self._init_ui()
        self._load_cajeros()
        self._timer.start()

    def _init_ui(self):
        screen = QApplication.primaryScreen().availableGeometry()
        small = screen.height() < 700

        self.setStyleSheet('''
            QDialog { background: #f8f9fa; }
            QScrollArea { background: transparent; border: none; }
            QWidget#scrollContent { background: transparent; }
            QLabel#title {
                font-size: 15px; font-weight: bold; color: #1e293b;
            }
            QLabel#subtitle {
                font-size: 10px; color: #64748b;
            }
            QListWidget {
                border: 1.5px solid #dee2e6;
                border-radius: 8px;
                background: white;
                font-size: 12px;
                padding: 2px;
            }
            QListWidget::item {
                padding: 8px 12px;
                border-radius: 5px;
                margin: 1px 2px;
                color: #212529;
            }
            QListWidget::item:selected { background: #0d6efd; color: white; }
            QListWidget::item:hover:!selected { background: #e8f0fe; }
            QLineEdit {
                border: 1.5px solid #ced4da;
                border-radius: 6px;
                padding: 6px 10px;
                font-size: 12px;
                background: white;
                color: #212529;
            }
            QLineEdit:focus { border-color: #ffc107; }
            QPushButton#confirmBtn {
                background: #198754; border: none; border-radius: 7px;
                padding: 9px 20px; color: white; font-size: 12px; font-weight: bold;
            }
            QPushButton#confirmBtn:hover { background: #157347; }
            QPushButton#skipBtn {
                background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 7px;
                padding: 9px 16px; color: #495057; font-size: 12px;
            }
            QPushButton#skipBtn:hover { background: #e9ecef; }
        ''')

        # Layout externo: scroll + botones fijos abajo
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        # Área scrolleable
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)

        content = QWidget()
        content.setObjectName('scrollContent')
        layout = QVBoxLayout(content)
        margin = 14 if small else 18
        layout.setContentsMargins(margin, margin, margin, 8)
        layout.setSpacing(10 if small else 12)

        # ── Título ──────────────────────────────────────────────────────
        title_lbl = QLabel('Quien esta en el turno')
        title_lbl.setObjectName('title')
        title_lbl.setAlignment(Qt.AlignCenter)
        layout.addWidget(title_lbl)

        subtitle_lbl = QLabel(
            'Selecciona un cajero de la lista o escribe el nombre.\n'
            'Las ventas de este turno quedaran registradas a su nombre.'
        )
        subtitle_lbl.setObjectName('subtitle')
        subtitle_lbl.setAlignment(Qt.AlignCenter)
        subtitle_lbl.setWordWrap(True)
        layout.addWidget(subtitle_lbl)

        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet('color: #e9ecef;')
        layout.addWidget(sep)

        # ── Lista de cajeros ─────────────────────────────────────────────
        list_lbl = QLabel('Cajeros registrados:')
        list_lbl.setFont(QFont('Segoe UI', 9, QFont.Bold))
        list_lbl.setStyleSheet('color: #495057;')
        layout.addWidget(list_lbl)

        self.cajeros_list = QListWidget()
        list_h = 130 if small else 160
        self.cajeros_list.setMaximumHeight(list_h)
        self.cajeros_list.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        self.cajeros_list.itemClicked.connect(self._on_list_click)
        self.cajeros_list.itemDoubleClicked.connect(self._on_list_double_click)
        layout.addWidget(self.cajeros_list)

        # ── Nombre libre ─────────────────────────────────────────────────
        libre_lbl = QLabel('O escribe el nombre del turno:')
        libre_lbl.setFont(QFont('Segoe UI', 9, QFont.Bold))
        libre_lbl.setStyleSheet('color: #495057;')
        layout.addWidget(libre_lbl)

        self.nombre_input = QLineEdit()
        self.nombre_input.setPlaceholderText('Ej: Carlos, Maria, Turno Noche...')
        self.nombre_input.setText(self.turno_nombre)
        self.nombre_input.setMinimumHeight(36)
        self.nombre_input.returnPressed.connect(self._confirm)
        self.nombre_input.textChanged.connect(lambda _: self._reset_timer())
        layout.addWidget(self.nombre_input)

        # ── Countdown ────────────────────────────────────────────────────
        self._countdown_lbl = QLabel(f'Se seleccionara automaticamente en {AUTOSELECT_SECONDS}s...')
        self._countdown_lbl.setStyleSheet('color: #6c757d; font-size: 9px;')
        self._countdown_lbl.setAlignment(Qt.AlignCenter)
        layout.addWidget(self._countdown_lbl)

        scroll.setWidget(content)
        outer.addWidget(scroll, 1)

        # ── Botones (fijos abajo, fuera del scroll) ───────────────────────
        btn_bar = QWidget()
        btn_bar.setStyleSheet('background: #f8f9fa; border-top: 1px solid #e9ecef;')
        btn_row = QHBoxLayout(btn_bar)
        btn_row.setContentsMargins(14, 10, 14, 10)
        btn_row.setSpacing(10)

        skip_btn = QPushButton('Omitir')
        skip_btn.setObjectName('skipBtn')
        skip_btn.setMinimumHeight(38)
        skip_btn.clicked.connect(self._skip)
        btn_row.addWidget(skip_btn)

        confirm_btn = QPushButton('Confirmar Turno')
        confirm_btn.setObjectName('confirmBtn')
        confirm_btn.setMinimumHeight(38)
        confirm_btn.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        confirm_btn.clicked.connect(self._confirm)
        btn_row.addWidget(confirm_btn, 2)

        outer.addWidget(btn_bar)

    def _load_cajeros(self):
        """Carga la lista de cajeros activos desde la base de datos."""
        try:
            from pos_system.database.db_manager import DatabaseManager
            db = DatabaseManager()
            # Mostrar primero cajeros, luego admins, solo activos
            users = db.execute_query(
                "SELECT full_name, username, role FROM users "
                "WHERE is_active = 1 ORDER BY role ASC, full_name ASC"
            )
            self._cajeros_data = {}
            self.cajeros_list.clear()
            for u in users:
                nombre = u.get('full_name') or u.get('username', '')
                role   = u.get('role', '')
                self._cajeros_data[nombre] = role  # guardar mapa nombre→rol
                role_txt = 'Admin' if role == 'admin' else 'Cajero'
                item   = QListWidgetItem(f'{nombre}  ({role_txt})')
                item.setData(Qt.UserRole, nombre)
                self.cajeros_list.addItem(item)

                # Pre-seleccionar el turno actual
                if nombre == self.turno_nombre:
                    self.cajeros_list.setCurrentItem(item)

        except Exception as e:
            logger.warning(f'TurnoDialog: No se pudieron cargar cajeros: {e}')

    def _reset_timer(self):
        """Reinicia el countdown cuando el usuario interactúa."""
        self._countdown = AUTOSELECT_SECONDS
        self._countdown_lbl.setText(f'Se seleccionará automáticamente en {AUTOSELECT_SECONDS}s...')

    def _on_tick(self):
        """Descuenta 1 segundo; al llegar a 0 auto-confirma con el primer cajero."""
        self._countdown -= 1
        if self._countdown <= 0:
            self._timer.stop()
            self._autoselect_first_cajero()
        else:
            self._countdown_lbl.setText(f'Se seleccionará automáticamente en {self._countdown}s...')

    def _autoselect_first_cajero(self):
        """Selecciona el primer cajero de la lista y confirma automáticamente."""
        # Buscar primer usuario con rol 'cajero'
        first_cajero = None
        for nombre, role in self._cajeros_data.items():
            if role == 'cajero':
                first_cajero = nombre
                break
        # Si no hay cajeros registrados, usar el primer usuario que haya
        if not first_cajero and self._cajeros_data:
            first_cajero = next(iter(self._cajeros_data))

        if first_cajero:
            self.nombre_input.setText(first_cajero)
            self.turno_nombre = first_cajero
            self.turno_role = self._cajeros_data.get(first_cajero, 'cajero')
            logger.info(f'Turno auto-seleccionado por inactividad: {first_cajero}')
            self.accept()
        else:
            # Sin cajeros registrados, simplemente aceptar con lo que hay
            self.turno_nombre = self.nombre_input.text().strip() or 'Cajero'
            self.turno_role = 'cajero'
            self.accept()

    def _on_list_click(self, item: QListWidgetItem):
        """Al hacer clic en un cajero, poner su nombre en el campo de texto."""
        self._reset_timer()
        nombre = item.data(Qt.UserRole)
        if nombre:
            self.nombre_input.setText(nombre)

    def _on_list_double_click(self, item: QListWidgetItem):
        """Doble clic confirma directamente."""
        self._reset_timer()
        nombre = item.data(Qt.UserRole)
        if nombre:
            self.nombre_input.setText(nombre)
            self._confirm()

    ADMIN_PASSWORD = 'agustin1212'

    def _confirm(self):
        self._timer.stop()
        nombre = self.nombre_input.text().strip()
        if not nombre:
            QMessageBox.warning(self, 'Nombre requerido',
                                'Por favor escribí el nombre del cajero de turno.')
            self.nombre_input.setFocus()
            return
        self.turno_nombre = nombre
        # Determinar el rol: si el nombre coincide con un usuario registrado, usar su rol
        # Si es nombre libre (no está en la BD), tratar como admin (acceso completo)
        rol_destino = self._cajeros_data.get(nombre, 'admin')

        # Si el destino es admin, pedir contraseña
        if rol_destino == 'admin':
            pwd, ok = self._pedir_password()
            if not ok or pwd != self.ADMIN_PASSWORD:
                QMessageBox.warning(self, 'Contraseña incorrecta',
                                    'La contraseña de administrador es incorrecta.')
                return

        self.turno_role = rol_destino
        logger.info(f'Turno iniciado: {nombre} (rol: {self.turno_role})')
        self.accept()

    def _pedir_password(self):
        """Muestra un diálogo para ingresar la contraseña de administrador."""
        from PyQt5.QtWidgets import QInputDialog
        pwd, ok = QInputDialog.getText(
            self, 'Contraseña de Administrador',
            'Ingresá la contraseña para acceder como administrador:',
            QLineEdit.Password
        )
        return pwd, ok

    def _skip(self):
        """Omitir: mantener el nombre actual."""
        self._timer.stop()
        self.turno_nombre = self.nombre_input.text().strip() or self.turno_nombre
        rol_destino = self._cajeros_data.get(self.turno_nombre, 'admin')

        # Si el destino es admin, pedir contraseña
        if rol_destino == 'admin':
            pwd, ok = self._pedir_password()
            if not ok or pwd != self.ADMIN_PASSWORD:
                QMessageBox.warning(self, 'Contraseña incorrecta',
                                    'La contraseña de administrador es incorrecta.')
                return

        self.turno_role = rol_destino
        self.accept()
