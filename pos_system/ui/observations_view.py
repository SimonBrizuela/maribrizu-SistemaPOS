"""Observations view — notas compartidas entre cajeros, sync realtime."""
import logging
from PyQt5.QtCore import Qt, pyqtSignal
from PyQt5.QtGui import QFont, QColor
from PyQt5.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QPushButton,
                             QLabel, QTextEdit, QScrollArea, QFrame,
                             QMessageBox, QDialog, QDialogButtonBox)

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.observation import Observation
from pos_system.utils.firebase_sync import get_firebase_sync, now_ar, _get_pc_id

logger = logging.getLogger(__name__)


class NewObservationDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle('Nueva observación')
        self.setMinimumSize(520, 280)
        self.text = ''

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(10)

        lbl = QLabel('Escribí la observación (falta producto, nota al equipo, etc.):')
        lbl.setFont(QFont('Segoe UI', 10))
        layout.addWidget(lbl)

        self.text_edit = QTextEdit()
        self.text_edit.setFont(QFont('Segoe UI', 10))
        self.text_edit.setPlaceholderText('Ej: falta tijera escolar, llegó pedido del proveedor…')
        layout.addWidget(self.text_edit, stretch=1)

        btns = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        btns.button(QDialogButtonBox.Save).setText('Guardar')
        btns.button(QDialogButtonBox.Cancel).setText('Cancelar')
        btns.accepted.connect(self._on_ok)
        btns.rejected.connect(self.reject)
        layout.addWidget(btns)

    def _on_ok(self):
        t = self.text_edit.toPlainText().strip()
        if not t:
            QMessageBox.warning(self, 'Observación', 'No puede estar vacía.')
            return
        self.text = t
        self.accept()


class ObservationsView(QWidget):
    """Lista de observaciones — todos los cajeros leen y escriben."""

    refresh_requested = pyqtSignal()

    def __init__(self, parent=None, current_user=None):
        super().__init__(parent)
        self.db = DatabaseManager()
        self.model = Observation(self.db)
        self.current_user = current_user or {}
        self.refresh_requested.connect(self.refresh_data)
        self._build_ui()
        self.refresh_data()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(14)

        header = QHBoxLayout()
        title = QLabel('Observaciones')
        title.setFont(QFont('Segoe UI', 15, QFont.Bold))
        title.setStyleSheet('color: #1c1c1e;')
        header.addWidget(title)
        header.addStretch()

        self.new_btn = QPushButton('+ Nueva observación')
        self.new_btn.setCursor(Qt.PointingHandCursor)
        self.new_btn.setStyleSheet('''
            QPushButton { background: #c1521f; color: white; border: none;
                          padding: 8px 18px; border-radius: 6px;
                          font-weight: bold; font-size: 10pt; }
            QPushButton:hover { background: #a3441a; }
        ''')
        self.new_btn.clicked.connect(self._on_new)
        header.addWidget(self.new_btn)

        self.refresh_btn = QPushButton('Actualizar')
        self.refresh_btn.setCursor(Qt.PointingHandCursor)
        self.refresh_btn.setStyleSheet('''
            QPushButton { background: #fafaf7; color: #1c1c1e;
                          border: 1px solid #dcd6c8; padding: 8px 14px;
                          border-radius: 6px; font-size: 10pt; }
            QPushButton:hover { background: #dcd6c8; }
        ''')
        self.refresh_btn.clicked.connect(self.refresh_data)
        header.addWidget(self.refresh_btn)

        layout.addLayout(header)

        self.count_lbl = QLabel('0 observaciones')
        self.count_lbl.setStyleSheet('color: #6f6a5d; font-size: 9pt;')
        layout.addWidget(self.count_lbl)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        self.list_container = QWidget()
        self.list_layout = QVBoxLayout(self.list_container)
        self.list_layout.setContentsMargins(0, 0, 0, 0)
        self.list_layout.setSpacing(8)
        self.list_layout.addStretch()
        scroll.setWidget(self.list_container)
        layout.addWidget(scroll, stretch=1)

    def refresh_data(self):
        while self.list_layout.count() > 1:
            item = self.list_layout.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()

        try:
            rows = self.model.get_all(limit=500)
        except Exception as e:
            logger.error(f"Observaciones: error listando: {e}")
            rows = []

        self.count_lbl.setText(f'{len(rows)} observaci{"ón" if len(rows)==1 else "ones"}')

        for row in rows:
            card = self._make_card(row)
            self.list_layout.insertWidget(self.list_layout.count() - 1, card)

    def _make_card(self, row: dict) -> QWidget:
        card = QFrame()
        ctx = str(row.get('context') or 'general')
        border = '#c1521f' if ctx == 'sale' else '#dcd6c8'
        card.setStyleSheet(f'''
            QFrame {{ background: white; border: 1px solid {border};
                      border-radius: 8px; }}
        ''')
        lyt = QVBoxLayout(card)
        lyt.setContentsMargins(12, 10, 12, 10)
        lyt.setSpacing(4)

        meta_row = QHBoxLayout()
        author = row.get('created_by_name') or 'Anónimo'
        when = row.get('created_at') or ''
        tag = 'Venta' if ctx == 'sale' else 'General'

        meta_lbl = QLabel(f"<b>{author}</b>  ·  {when}  ·  <span style='color:#6f6a5d;'>{tag}</span>")
        meta_lbl.setStyleSheet('color: #5a5448; font-size: 9pt; border: none;')
        meta_row.addWidget(meta_lbl)
        meta_row.addStretch()

        # Botón eliminar (admin, o propio autor)
        is_admin = str(self.current_user.get('role') or '') == 'admin'
        own = row.get('created_by_id') and row.get('created_by_id') == self.current_user.get('id')
        if is_admin or own:
            del_btn = QPushButton('Eliminar')
            del_btn.setCursor(Qt.PointingHandCursor)
            del_btn.setStyleSheet('''
                QPushButton { background: transparent; color: #dc2626;
                              border: 1px solid #a01616; padding: 2px 10px;
                              border-radius: 4px; font-size: 9pt; }
                QPushButton:hover { background: #fbe5e5; }
            ''')
            del_btn.clicked.connect(lambda _=False, r=row: self._on_delete(r))
            meta_row.addWidget(del_btn)

        lyt.addLayout(meta_row)

        text_lbl = QLabel(str(row.get('text') or ''))
        text_lbl.setWordWrap(True)
        text_lbl.setStyleSheet('color: #1c1c1e; font-size: 11pt; border: none; padding-top: 2px;')
        lyt.addWidget(text_lbl)

        if ctx == 'sale' and row.get('sale_id'):
            sale_lbl = QLabel(f"Venta #{row.get('sale_id')}")
            sale_lbl.setStyleSheet('color: #a3441a; font-size: 9pt; border: none;')
            lyt.addWidget(sale_lbl)

        return card

    def _on_new(self):
        dlg = NewObservationDialog(self)
        if dlg.exec_() != QDialog.Accepted:
            return
        try:
            uid = self.current_user.get('id')
            uname = (self.current_user.get('full_name')
                     or self.current_user.get('username') or 'Cajero')
            pc = _get_pc_id()
            created_at = now_ar().strftime('%Y-%m-%d %H:%M:%S')
            obs_id = self.model.create(
                text=dlg.text, context='general',
                created_by_id=uid, created_by_name=str(uname), pc_id=pc
            )
            fb = get_firebase_sync()
            if fb:
                fb.sync_observation(obs_id, {
                    'text': dlg.text, 'context': 'general',
                    'created_by_id': uid, 'created_by_name': str(uname),
                    'pc_id': pc, 'created_at': created_at,
                }, db_manager=self.db)
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo guardar: {e}')
            return
        self.refresh_data()

    def _on_delete(self, row: dict):
        reply = QMessageBox.question(
            self, 'Eliminar observación',
            '¿Eliminar esta observación?',
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No
        )
        if reply != QMessageBox.Yes:
            return
        try:
            self.model.delete(int(row['id']))
            fb = get_firebase_sync()
            fid = row.get('firebase_id')
            if fb and fid:
                fb.sync_observation(int(row['id']), {
                    'firebase_id': fid,
                    'text': row.get('text') or '',
                    'context': row.get('context') or 'general',
                    'sale_id': row.get('sale_id'),
                    'sale_item_id': row.get('sale_item_id'),
                    'created_by_id': row.get('created_by_id'),
                    'created_by_name': row.get('created_by_name') or '',
                    'pc_id': row.get('pc_id') or _get_pc_id(),
                    'created_at': row.get('created_at') or '',
                    'deleted': True,
                }, db_manager=self.db)
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo eliminar: {e}')
            return
        self.refresh_data()
