"""
Diálogo de selección de turno.
Aparece cuando un administrador inicia sesión y permite elegir
quién está trabajando en el turno actual (puede ser un cajero diferente).
"""
import logging
from PyQt5.QtWidgets import (QDialog, QVBoxLayout, QHBoxLayout, QLabel,
                             QLineEdit, QPushButton, QListWidget, QListWidgetItem,
                             QFrame, QApplication, QSizePolicy, QMessageBox)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont

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
        self.setWindowTitle('¿Quién está en el turno?')
        self.setModal(True)
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowContextHelpButtonHint)

        # Tamaño adaptable
        screen = QApplication.primaryScreen().availableGeometry()
        w = max(380, min(460, int(screen.width() * 0.32)))
        h = max(420, min(540, int(screen.height() * 0.58)))
        self.resize(w, h)
        self.setMinimumSize(340, 380)

        # Centrar
        self.move(
            screen.x() + (screen.width()  - self.width())  // 2,
            screen.y() + (screen.height() - self.height()) // 2,
        )

        self._init_ui()
        self._load_cajeros()

    def _init_ui(self):
        self.setStyleSheet('''
            QDialog { background: #f8f9fa; }
            QLabel#title {
                font-size: 16px; font-weight: bold; color: #1e293b;
            }
            QLabel#subtitle {
                font-size: 11px; color: #64748b;
            }
            QListWidget {
                border: 1.5px solid #dee2e6;
                border-radius: 8px;
                background: white;
                font-size: 13px;
                padding: 4px;
            }
            QListWidget::item {
                padding: 10px 14px;
                border-radius: 6px;
                margin: 2px 2px;
                color: #212529;
            }
            QListWidget::item:selected {
                background: #0d6efd;
                color: white;
            }
            QListWidget::item:hover:!selected {
                background: #e8f0fe;
            }
            QLineEdit {
                border: 1.5px solid #ced4da;
                border-radius: 6px;
                padding: 8px 12px;
                font-size: 13px;
                background: white;
                color: #212529;
            }
            QLineEdit:focus { border-color: #ffc107; }
            QPushButton#confirmBtn {
                background: #198754;
                border: none;
                border-radius: 8px;
                padding: 10px 24px;
                color: white;
                font-size: 13px;
                font-weight: bold;
            }
            QPushButton#confirmBtn:hover { background: #157347; }
            QPushButton#skipBtn {
                background: #f8f9fa;
                border: 1px solid #dee2e6;
                border-radius: 8px;
                padding: 10px 20px;
                color: #495057;
                font-size: 13px;
            }
            QPushButton#skipBtn:hover { background: #e9ecef; }
        ''')

        layout = QVBoxLayout(self)
        layout.setContentsMargins(22, 20, 22, 20)
        layout.setSpacing(14)

        # ── Ícono + título ───────────────────────────────────────────────
        title_lbl = QLabel('¿Quién está en el turno?')
        title_lbl.setObjectName('title')
        title_lbl.setAlignment(Qt.AlignCenter)
        layout.addWidget(title_lbl)

        subtitle_lbl = QLabel(
            'Seleccioná un cajero de la lista o escribí el nombre.\n'
            'Las ventas de este turno quedarán registradas a su nombre.'
        )
        subtitle_lbl.setObjectName('subtitle')
        subtitle_lbl.setAlignment(Qt.AlignCenter)
        subtitle_lbl.setWordWrap(True)
        layout.addWidget(subtitle_lbl)

        # ── Separador ───────────────────────────────────────────────────
        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet('color: #e9ecef;')
        layout.addWidget(sep)

        # ── Lista de cajeros ─────────────────────────────────────────────
        list_lbl = QLabel('Cajeros registrados:')
        list_lbl.setFont(QFont('Segoe UI', 10, QFont.Bold))
        list_lbl.setStyleSheet('color: #495057;')
        layout.addWidget(list_lbl)

        self.cajeros_list = QListWidget()
        self.cajeros_list.setMaximumHeight(180)
        self.cajeros_list.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        self.cajeros_list.itemClicked.connect(self._on_list_click)
        self.cajeros_list.itemDoubleClicked.connect(self._on_list_double_click)
        layout.addWidget(self.cajeros_list)

        # ── Nombre libre ─────────────────────────────────────────────────
        libre_lbl = QLabel('O escribí el nombre del turno:')
        libre_lbl.setFont(QFont('Segoe UI', 10, QFont.Bold))
        libre_lbl.setStyleSheet('color: #495057;')
        layout.addWidget(libre_lbl)

        self.nombre_input = QLineEdit()
        self.nombre_input.setPlaceholderText('Ej: Carlos, María, Turno Noche...')
        self.nombre_input.setText(self.turno_nombre)
        self.nombre_input.setMinimumHeight(40)
        self.nombre_input.returnPressed.connect(self._confirm)
        layout.addWidget(self.nombre_input)

        # ── Botones ───────────────────────────────────────────────────────
        btn_row = QHBoxLayout()
        btn_row.setSpacing(10)

        skip_btn = QPushButton('Omitir')
        skip_btn.setObjectName('skipBtn')
        skip_btn.setMinimumHeight(42)
        skip_btn.clicked.connect(self._skip)
        btn_row.addWidget(skip_btn)

        confirm_btn = QPushButton('Confirmar Turno')
        confirm_btn.setObjectName('confirmBtn')
        confirm_btn.setMinimumHeight(42)
        confirm_btn.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        confirm_btn.clicked.connect(self._confirm)
        btn_row.addWidget(confirm_btn, 2)

        layout.addLayout(btn_row)

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

    def _on_list_click(self, item: QListWidgetItem):
        """Al hacer clic en un cajero, poner su nombre en el campo de texto."""
        nombre = item.data(Qt.UserRole)
        if nombre:
            self.nombre_input.setText(nombre)

    def _on_list_double_click(self, item: QListWidgetItem):
        """Doble clic confirma directamente."""
        nombre = item.data(Qt.UserRole)
        if nombre:
            self.nombre_input.setText(nombre)
            self._confirm()

    ADMIN_PASSWORD = 'agustin1212'

    def _confirm(self):
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
