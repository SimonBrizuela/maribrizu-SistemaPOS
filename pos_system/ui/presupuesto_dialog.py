"""Diálogo para generar un presupuesto a partir de los items del carrito."""
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QFormLayout, QLineEdit, QLabel,
    QSpinBox, QTextEdit, QPushButton, QMessageBox, QFrame
)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont


class PresupuestoDialog(QDialog):
    """Pide datos del cliente y validez para generar el presupuesto."""

    def __init__(self, parent=None, total: float = 0, items_count: int = 0,
                 sugerido_numero: int = 1):
        super().__init__(parent)
        self.setWindowTitle('Generar Presupuesto')
        self.setModal(True)
        self.setFixedWidth(460)

        self._total = float(total or 0)
        self._items_count = int(items_count or 0)
        self._numero = int(sugerido_numero or 1)

        # Resultados (se leen tras accept())
        self.cliente_nombre = ''
        self.cliente_telefono = ''
        self.cliente_email = ''
        self.validez_dias = 7
        self.notas = ''

        self._init_ui()

    def _init_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(20, 18, 20, 18)
        root.setSpacing(14)

        # Header
        title = QLabel('Generar Presupuesto')
        title.setFont(QFont('Segoe UI', 14, QFont.Bold))
        root.addWidget(title)

        sub = QLabel(
            f"Se asignará el número <b>P-{self._numero:05d}</b> · "
            f"{self._items_count} items · Total <b>${self._total:,.2f}</b>"
            .replace(',', '#').replace('.', ',').replace('#', '.')
        )
        sub.setStyleSheet('color:#65676b; font-size:12px;')
        sub.setTextFormat(Qt.RichText)
        root.addWidget(sub)

        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet('color:#e4e6eb;')
        root.addWidget(sep)

        # Form
        form = QFormLayout()
        form.setSpacing(10)
        form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        self.input_nombre = QLineEdit()
        self.input_nombre.setPlaceholderText('Ej: Juan Pérez (opcional)')
        self.input_nombre.setMinimumHeight(32)
        form.addRow('Cliente:', self.input_nombre)

        self.input_tel = QLineEdit()
        self.input_tel.setPlaceholderText('Ej: 351 123 4567')
        self.input_tel.setMinimumHeight(32)
        form.addRow('Teléfono:', self.input_tel)

        self.input_email = QLineEdit()
        self.input_email.setPlaceholderText('opcional')
        self.input_email.setMinimumHeight(32)
        form.addRow('Email:', self.input_email)

        self.input_validez = QSpinBox()
        self.input_validez.setRange(1, 60)
        self.input_validez.setValue(7)
        self.input_validez.setSuffix(' días')
        self.input_validez.setMinimumHeight(32)
        form.addRow('Validez:', self.input_validez)

        self.input_notas = QTextEdit()
        self.input_notas.setPlaceholderText('Observaciones para el cliente (opcional)')
        self.input_notas.setMaximumHeight(80)
        form.addRow('Notas:', self.input_notas)

        root.addLayout(form)

        # Botones
        btn_row = QHBoxLayout()
        btn_row.addStretch(1)

        cancel = QPushButton('Cancelar')
        cancel.setMinimumHeight(38)
        cancel.setMinimumWidth(110)
        cancel.setCursor(Qt.PointingHandCursor)
        cancel.setStyleSheet(
            'QPushButton { background:#f0f2f5; color:#1c1e21; border:1px solid #e4e6eb;'
            ' border-radius:6px; padding:6px 16px; font-weight:600; }'
            'QPushButton:hover { background:#e4e6eb; }'
        )
        cancel.clicked.connect(self.reject)

        ok = QPushButton('Generar PDF')
        ok.setMinimumHeight(38)
        ok.setMinimumWidth(140)
        ok.setCursor(Qt.PointingHandCursor)
        ok.setDefault(True)
        ok.setStyleSheet(
            'QPushButton { background:#7b3fa6; color:white; border:none;'
            ' border-radius:6px; padding:6px 16px; font-weight:700; }'
            'QPushButton:hover { background:#6a1b9a; }'
        )
        ok.clicked.connect(self._on_accept)

        btn_row.addWidget(cancel)
        btn_row.addWidget(ok)
        root.addLayout(btn_row)

        self.input_nombre.setFocus()

    def _on_accept(self):
        # Validación mínima: si dejó email lo verificamos por sintaxis básica
        email = self.input_email.text().strip()
        if email and '@' not in email:
            QMessageBox.warning(self, 'Email inválido',
                                'El email no tiene un formato válido.')
            self.input_email.setFocus()
            return

        self.cliente_nombre = self.input_nombre.text().strip()
        self.cliente_telefono = self.input_tel.text().strip()
        self.cliente_email = email
        self.validez_dias = self.input_validez.value()
        self.notas = self.input_notas.toPlainText().strip()
        self.accept()
