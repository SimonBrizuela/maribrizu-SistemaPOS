"""
User management view - only accessible by admin role.
Permite crear/editar/desactivar cajeros desde el panel de administrador.
"""
import logging
from PyQt5.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QTableWidget,
                             QTableWidgetItem, QPushButton, QLabel, QDialog,
                             QFormLayout, QLineEdit, QComboBox, QMessageBox,
                             QHeaderView, QFrame, QSizePolicy)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont, QColor

from pos_system.models.user import User, ROLES
from pos_system.database.db_manager import DatabaseManager

logger = logging.getLogger(__name__)


class UsersView(QWidget):
    """Vista de gestión de cajeros (solo admin)."""

    def __init__(self, parent=None, current_user: dict = None):
        super().__init__(parent)
        self.db = DatabaseManager()
        self.user_model = User(self.db)
        self.current_user = current_user or {}
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.setSpacing(16)

        # ── Header ────────────────────────────────────────────────────────
        header_layout = QHBoxLayout()

        icon_title = QLabel('Gestión de Cajeros')
        icon_title.setFont(QFont('Segoe UI', 17, QFont.Bold))
        icon_title.setStyleSheet('color: #1c1c1e;')
        header_layout.addWidget(icon_title)
        header_layout.addStretch()

        nuevo_cajero_btn = QPushButton('Nuevo Cajero')
        nuevo_cajero_btn.setObjectName('btnSuccess')
        nuevo_cajero_btn.setMinimumHeight(40)
        nuevo_cajero_btn.setMinimumWidth(150)
        nuevo_cajero_btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
        nuevo_cajero_btn.setStyleSheet('''
            QPushButton {
                background: #3d7a3a;
                color: white;
                border: none;
                border-radius: 8px;
                padding: 8px 20px;
                font-size: 11px;
                font-weight: bold;
            }
            QPushButton:hover { background: #2f5e2c; }
            QPushButton:pressed { background: #2f5e2c; }
        ''')
        nuevo_cajero_btn.clicked.connect(self.add_user)
        header_layout.addWidget(nuevo_cajero_btn)
        layout.addLayout(header_layout)

        # ── Banner informativo ────────────────────────────────────────────
        info_banner = QLabel(
            'Los cajeros pueden acceder a  Ventas, Historial y Caja.  '
            'Solo el administrador ve Productos, Promociones, Fiscal y esta sección.'
        )
        info_banner.setStyleSheet(
            'background: #fbeee5; color: #b07020; border: 1.5px solid #b07020; '
            'border-radius: 8px; padding: 10px 14px; font-size: 11px;'
        )
        info_banner.setWordWrap(True)
        info_banner.setFont(QFont('Segoe UI', 10))
        layout.addWidget(info_banner)

        # ── Tabla ─────────────────────────────────────────────────────────
        self.table = QTableWidget()
        self.table.setColumnCount(6)
        self.table.setHorizontalHeaderLabels([
            'ID', 'Usuario', 'Nombre Completo', 'Rol', 'Estado', 'Último Acceso'
        ])
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        self.table.verticalHeader().setVisible(False)
        self.table.setStyleSheet('''
            QTableWidget {
                border: 1.5px solid #dcd6c8;
                border-radius: 8px;
                background: white;
                gridline-color: #fafaf7;
                font-size: 12px;
            }
            QTableWidget::item { padding: 6px 10px; }
            QTableWidget::item:selected { background: #e8f0fe; color: #1c1c1e; }
            QHeaderView::section {
                background: #fafaf7;
                border: none;
                border-bottom: 2px solid #dcd6c8;
                padding: 8px 10px;
                font-weight: bold;
                font-size: 11px;
                color: #5a5448;
            }
        ''')
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.Stretch)
        self.table.setColumnWidth(0, 45)
        self.table.setColumnWidth(1, 130)
        self.table.setColumnWidth(3, 130)
        self.table.setColumnWidth(4, 90)
        self.table.setColumnWidth(5, 170)
        self.table.doubleClicked.connect(self.edit_user)
        layout.addWidget(self.table)

        # ── Botones de acción ─────────────────────────────────────────────
        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet('color: #ece8df; margin: 0px;')
        layout.addWidget(sep)

        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(10)

        edit_btn = QPushButton('Editar')
        edit_btn.setMinimumHeight(38)
        edit_btn.setStyleSheet(self._btn_style('#c1521f', '#a3441a'))
        edit_btn.clicked.connect(self.edit_user)
        btn_layout.addWidget(edit_btn)

        change_pass_btn = QPushButton('Cambiar Contraseña')
        change_pass_btn.setMinimumHeight(38)
        change_pass_btn.setStyleSheet(self._btn_style('#6f6a5d', '#5c636a'))
        change_pass_btn.clicked.connect(self.change_password)
        btn_layout.addWidget(change_pass_btn)

        deactivate_btn = QPushButton('Desactivar')
        deactivate_btn.setMinimumHeight(38)
        deactivate_btn.setStyleSheet(self._btn_style('#a01616', '#b02a37'))
        deactivate_btn.clicked.connect(self.deactivate_user)
        btn_layout.addWidget(deactivate_btn)

        delete_btn = QPushButton('Eliminar')
        delete_btn.setMinimumHeight(38)
        delete_btn.setStyleSheet(self._btn_style('#6f1a1a', '#4a1010'))
        delete_btn.clicked.connect(self.delete_user)
        btn_layout.addWidget(delete_btn)

        btn_layout.addStretch()

        # Hint de doble clic
        hint = QLabel('Doble clic para editar un cajero')
        hint.setStyleSheet('color: #9b958a; font-size: 10px;')
        hint.setFont(QFont('Segoe UI', 9))
        btn_layout.addWidget(hint)

        layout.addLayout(btn_layout)

        self.refresh_data()

    def _btn_style(self, bg: str, hover: str) -> str:
        return f'''
            QPushButton {{
                background: {bg};
                color: white;
                border: none;
                border-radius: 7px;
                padding: 7px 18px;
                font-size: 11px;
                font-weight: bold;
            }}
            QPushButton:hover {{ background: {hover}; }}
        '''

    def refresh_data(self):
        users = self.user_model.get_all()
        self.table.setRowCount(len(users))

        for row, user in enumerate(users):
            self.table.setRowHeight(row, 42)

            id_item = QTableWidgetItem(str(user['id']))
            id_item.setTextAlignment(Qt.AlignCenter)
            self.table.setItem(row, 0, id_item)

            self.table.setItem(row, 1, QTableWidgetItem(user['username']))
            self.table.setItem(row, 2, QTableWidgetItem(user['full_name']))

            role_label = ROLES.get(user['role'], user['role'])
            role_item = QTableWidgetItem(role_label)
            role_item.setTextAlignment(Qt.AlignCenter)
            if user['role'] == 'admin':
                role_item.setForeground(QColor('#c1521f'))
                role_item.setFont(QFont('Segoe UI', 9, QFont.Bold))
            else:
                role_item.setForeground(QColor('#3d7a3a'))
                role_item.setFont(QFont('Segoe UI', 9))
            self.table.setItem(row, 3, role_item)

            is_active = user.get('is_active', 1)
            status_text = 'Activo' if is_active else 'Inactivo'
            status_item = QTableWidgetItem(status_text)
            status_item.setTextAlignment(Qt.AlignCenter)
            status_item.setForeground(QColor('#3d7a3a') if is_active else QColor('#a01616'))
            self.table.setItem(row, 4, status_item)

            last_login = user.get('last_login') or 'Nunca'
            if last_login != 'Nunca':
                try:
                    from pos_system.utils.firebase_sync import now_ar
                    dt = datetime.fromisoformat(last_login)
                    last_login = dt.strftime('%d/%m/%Y %H:%M')
                except Exception:
                    pass
            self.table.setItem(row, 5, QTableWidgetItem(last_login))

    def _get_selected_user_id(self):
        row = self.table.currentRow()
        if row < 0:
            QMessageBox.warning(self, 'Atención', 'Seleccioná un cajero de la lista primero.')
            return None
        return int(self.table.item(row, 0).text())

    def _sync_users_firebase(self):
        """Sube todos los cajeros a Firebase en background."""
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if fb:
                fb.sync_users(self.db)
        except Exception as e:
            logger.warning(f"No se pudo sincronizar cajeros con Firebase: {e}")

    def add_user(self):
        dialog = UserDialog(self)
        if dialog.exec_() == QDialog.Accepted:
            try:
                self.user_model.create(
                    username=dialog.username_input.text().strip(),
                    password=dialog.password_input.text(),
                    full_name=dialog.fullname_input.text().strip(),
                    role=dialog.role_combo.currentData()
                )
                role_label = ROLES.get(dialog.role_combo.currentData(), '')
                QMessageBox.information(
                    self, 'Cajero creado',
                    f'{role_label} "{dialog.fullname_input.text().strip()}" creado correctamente.\n'
                    f'Usuario: {dialog.username_input.text().strip()}'
                )
                self.refresh_data()
                self._sync_users_firebase()
            except Exception as e:
                QMessageBox.critical(self, 'Error al crear', str(e))

    def edit_user(self):
        user_id = self._get_selected_user_id()
        if not user_id:
            return
        user = self.user_model.get_by_id(user_id)
        dialog = UserDialog(self, user=user)
        if dialog.exec_() == QDialog.Accepted:
            try:
                self.user_model.update(
                    user_id,
                    full_name=dialog.fullname_input.text().strip(),
                    role=dialog.role_combo.currentData()
                )
                QMessageBox.information(self, 'Actualizado', 'Cajero actualizado correctamente.')
                self.refresh_data()
                self._sync_users_firebase()
            except Exception as e:
                QMessageBox.critical(self, 'Error', str(e))

    def change_password(self):
        user_id = self._get_selected_user_id()
        if not user_id:
            return
        user = self.user_model.get_by_id(user_id)
        dialog = ChangePasswordDialog(self, user_name=user.get('full_name', ''))
        if dialog.exec_() == QDialog.Accepted:
            try:
                self.user_model.change_password(user_id, dialog.new_password_input.text())
                QMessageBox.information(self, 'Contraseña cambiada',
                                        'Contraseña actualizada correctamente.')
            except Exception as e:
                QMessageBox.critical(self, 'Error', str(e))

    def deactivate_user(self):
        user_id = self._get_selected_user_id()
        if not user_id:
            return
        if user_id == self.current_user.get('id'):
            QMessageBox.warning(self, 'Error', 'No podés desactivar tu propio usuario.')
            return
        row = self.table.currentRow()
        nombre = self.table.item(row, 2).text() if row >= 0 else 'este cajero'
        reply = QMessageBox.question(
            self, 'Confirmar desactivación',
            f'¿Desactivar a "{nombre}"?\n\nEl cajero no podrá iniciar sesión hasta que sea reactivado.',
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No
        )
        if reply == QMessageBox.Yes:
            # Obtener username antes de desactivar para eliminarlo de Firebase
            user_row = self.user_model.get_by_id(user_id)
            username = user_row.get('username', '') if user_row else ''
            self.user_model.delete(user_id)
            # Eliminar de Firebase inmediatamente para que no reaparezca en otras PCs
            if username:
                try:
                    from pos_system.utils.firebase_sync import get_firebase_sync
                    fb = get_firebase_sync()
                    if fb and fb.enabled:
                        fb.delete_user_from_firebase(username)
                except Exception:
                    pass
            QMessageBox.information(self, 'Desactivado', f'"{nombre}" fue desactivado.')
            self.refresh_data()
            self._sync_users_firebase()


    def delete_user(self):
        user_id = self._get_selected_user_id()
        if not user_id:
            return
        if user_id == self.current_user.get('id'):
            QMessageBox.warning(self, 'Error', 'No podés eliminar tu propio usuario.')
            return
        row = self.table.currentRow()
        nombre = self.table.item(row, 2).text() if row >= 0 else 'este cajero'
        username = self.table.item(row, 1).text() if row >= 0 else ''
        reply = QMessageBox.question(
            self, 'Eliminar cajero',
            f'¿Eliminar permanentemente a "{nombre}" (@{username})?\n\nEsta acción NO se puede deshacer.',
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No
        )
        if reply != QMessageBox.Yes:
            return
        # Segunda confirmación
        reply2 = QMessageBox.question(
            self, 'Confirmar eliminación',
            f'Confirmá: eliminar "{nombre}" para siempre.',
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No
        )
        if reply2 != QMessageBox.Yes:
            return
        self.user_model.hard_delete(user_id)
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if fb and fb.enabled:
                fb.delete_user_from_firebase(username)
        except Exception:
            pass
        QMessageBox.information(self, 'Eliminado', f'"{nombre}" fue eliminado permanentemente.')
        self.refresh_data()
        self._sync_users_firebase()


class UserDialog(QDialog):
    """Diálogo para crear o editar un cajero/admin."""

    def __init__(self, parent=None, user: dict = None):
        super().__init__(parent)
        self.user = user
        is_new = user is None
        self.setWindowTitle('Nuevo Cajero' if is_new else 'Editar Cajero')
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowContextHelpButtonHint)
        self.setMinimumWidth(420)
        self.setStyleSheet('''
            QDialog { background: #fafaf7; }
            QLineEdit, QComboBox {
                border: 1.5px solid #dcd6c8;
                border-radius: 6px;
                padding: 8px 10px;
                font-size: 12px;
                background: white;
                min-height: 34px;
            }
            QLineEdit:focus, QComboBox:focus { border-color: #c1521f; }
            QLabel { font-size: 12px; color: #5a5448; }
        ''')
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.setSpacing(14)

        # Título
        is_new = self.user is None
        title = QLabel('Nuevo Cajero' if is_new else 'Editar Cajero')
        title.setFont(QFont('Segoe UI', 14, QFont.Bold))
        title.setStyleSheet('color: #1c1c1e;')
        layout.addWidget(title)

        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet('color: #ece8df;')
        layout.addWidget(sep)

        form = QFormLayout()
        form.setSpacing(10)
        form.setLabelAlignment(Qt.AlignRight)

        # Usuario
        self.username_input = QLineEdit()
        self.username_input.setPlaceholderText('ej: maria, carlos123')
        if self.user:
            self.username_input.setText(self.user['username'])
            self.username_input.setEnabled(False)
            self.username_input.setStyleSheet('background: #ece8df; color: #6f6a5d; border-radius: 6px; padding: 8px;')
        form.addRow('Usuario:', self.username_input)

        # Nombre completo
        self.fullname_input = QLineEdit()
        self.fullname_input.setPlaceholderText('Nombre y apellido')
        if self.user:
            self.fullname_input.setText(self.user['full_name'])
        form.addRow('Nombre completo:', self.fullname_input)

        # Rol
        self.role_combo = QComboBox()
        self.role_combo.addItem('Cajero', 'cajero')
        self.role_combo.addItem('Administrador', 'admin')
        if self.user:
            idx = self.role_combo.findData(self.user['role'])
            if idx >= 0:
                self.role_combo.setCurrentIndex(idx)
        form.addRow('Rol:', self.role_combo)

        # Contraseña (solo al crear)
        if is_new:
            self.password_input = QLineEdit()
            self.password_input.setEchoMode(QLineEdit.Password)
            self.password_input.setPlaceholderText('Mínimo 4 caracteres')
            form.addRow('Contraseña:', self.password_input)

        layout.addLayout(form)

        # Info sobre roles
        role_info = QLabel(
            'Cajero: accede a Ventas, Historial y Caja.\n'
            'Administrador: accede a todo el sistema.'
        )
        role_info.setStyleSheet(
            'background: #fbeee5; color: #c1521f; border: 1px solid #dcd6c8; '
            'border-radius: 6px; padding: 8px 12px; font-size: 10px;'
        )
        role_info.setWordWrap(True)
        layout.addWidget(role_info)

        layout.addSpacing(4)

        # Botones
        btn_row = QHBoxLayout()
        btn_row.setSpacing(10)

        cancel_btn = QPushButton('Cancelar')
        cancel_btn.setMinimumHeight(40)
        cancel_btn.setStyleSheet('''
            QPushButton {
                background: #fafaf7; border: 1px solid #dcd6c8;
                border-radius: 7px; padding: 8px 20px;
                color: #5a5448; font-size: 12px;
            }
            QPushButton:hover { background: #ece8df; }
        ''')
        cancel_btn.clicked.connect(self.reject)

        save_btn = QPushButton('Guardar')
        save_btn.setMinimumHeight(40)
        save_btn.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        save_btn.setStyleSheet('''
            QPushButton {
                background: #3d7a3a; color: white; border: none;
                border-radius: 7px; padding: 8px 24px;
                font-size: 12px; font-weight: bold;
            }
            QPushButton:hover { background: #2f5e2c; }
        ''')
        save_btn.clicked.connect(self._validate_and_accept)

        btn_row.addWidget(cancel_btn)
        btn_row.addWidget(save_btn, 1)
        layout.addLayout(btn_row)

    def _validate_and_accept(self):
        if not self.fullname_input.text().strip():
            QMessageBox.warning(self, 'Campo requerido', 'El nombre completo es obligatorio.')
            self.fullname_input.setFocus()
            return
        if self.user is None:
            # Validar usuario
            if not self.username_input.text().strip():
                QMessageBox.warning(self, 'Campo requerido', 'El nombre de usuario es obligatorio.')
                self.username_input.setFocus()
                return
            if len(self.password_input.text()) < 4:
                QMessageBox.warning(self, 'Contraseña inválida',
                                    'La contraseña debe tener al menos 4 caracteres.')
                self.password_input.setFocus()
                return
        self.accept()


class ChangePasswordDialog(QDialog):
    """Diálogo para cambiar la contraseña de un cajero."""

    def __init__(self, parent=None, user_name: str = ''):
        super().__init__(parent)
        self.setWindowTitle('Cambiar Contraseña')
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowContextHelpButtonHint)
        self.setMinimumWidth(380)
        self.setStyleSheet('''
            QDialog { background: #fafaf7; }
            QLineEdit {
                border: 1.5px solid #dcd6c8;
                border-radius: 6px;
                padding: 8px 10px;
                font-size: 12px;
                background: white;
                min-height: 34px;
            }
            QLineEdit:focus { border-color: #c1521f; }
        ''')
        self.user_name = user_name
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.setSpacing(14)

        title = QLabel(f'Cambiar contraseña')
        title.setFont(QFont('Segoe UI', 14, QFont.Bold))
        title.setStyleSheet('color: #1c1c1e;')
        layout.addWidget(title)

        if self.user_name:
            sub = QLabel(f'Cajero: {self.user_name}')
            sub.setStyleSheet('color: #6f6a5d; font-size: 11px;')
            layout.addWidget(sub)

        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet('color: #ece8df;')
        layout.addWidget(sep)

        form = QFormLayout()
        form.setSpacing(10)

        self.new_password_input = QLineEdit()
        self.new_password_input.setEchoMode(QLineEdit.Password)
        self.new_password_input.setPlaceholderText('Mínimo 4 caracteres')
        form.addRow('Nueva contraseña:', self.new_password_input)

        self.confirm_input = QLineEdit()
        self.confirm_input.setEchoMode(QLineEdit.Password)
        self.confirm_input.setPlaceholderText('Repetir contraseña')
        self.confirm_input.returnPressed.connect(self._validate)
        form.addRow('Confirmar:', self.confirm_input)
        layout.addLayout(form)

        btn_row = QHBoxLayout()
        btn_row.setSpacing(10)

        cancel_btn = QPushButton('Cancelar')
        cancel_btn.setMinimumHeight(40)
        cancel_btn.setStyleSheet('''
            QPushButton {
                background: #fafaf7; border: 1px solid #dcd6c8;
                border-radius: 7px; padding: 8px 20px; color: #5a5448; font-size: 12px;
            }
            QPushButton:hover { background: #ece8df; }
        ''')
        cancel_btn.clicked.connect(self.reject)

        ok_btn = QPushButton('Cambiar')
        ok_btn.setMinimumHeight(40)
        ok_btn.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        ok_btn.setStyleSheet('''
            QPushButton {
                background: #c1521f; color: white; border: none;
                border-radius: 7px; padding: 8px 24px;
                font-size: 12px; font-weight: bold;
            }
            QPushButton:hover { background: #a3441a; }
        ''')
        ok_btn.clicked.connect(self._validate)

        btn_row.addWidget(cancel_btn)
        btn_row.addWidget(ok_btn, 1)
        layout.addLayout(btn_row)

    def _validate(self):
        if len(self.new_password_input.text()) < 4:
            QMessageBox.warning(self, 'Contraseña inválida',
                                'La contraseña debe tener al menos 4 caracteres.')
            self.new_password_input.setFocus()
            return
        if self.new_password_input.text() != self.confirm_input.text():
            QMessageBox.warning(self, 'Error', 'Las contraseñas no coinciden.')
            self.confirm_input.setFocus()
            return
        self.accept()
