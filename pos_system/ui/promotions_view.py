"""
Vista de gestión de Promociones y Descuentos.
Permite crear/editar/eliminar promos: 2x1, NxM, % descuento, descuento fijo, pack/combo.
"""
from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTableWidget, QTableWidgetItem,
    QPushButton, QLabel, QDialog, QFormLayout, QLineEdit, QComboBox,
    QSpinBox, QDoubleSpinBox, QTextEdit, QMessageBox, QCheckBox,
    QListWidget, QListWidgetItem, QFrame, QScrollArea, QAbstractItemView
)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont, QColor

from pos_system.models.promotion import Promotion, PROMO_TYPES
from pos_system.models.product import Product


class PromotionsView(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        from pos_system.database.db_manager import DatabaseManager
        self.db = DatabaseManager()
        self.promo_model = Promotion(self.db)
        self.init_ui()

    def get_main_window(self):
        widget = self
        while widget:
            if hasattr(widget, 'refresh_all_views'):
                return widget
            widget = widget.parent()
        return None

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(12)

        # Título
        title = QLabel('Promociones y Descuentos')
        title.setFont(QFont('Segoe UI', 16, QFont.Bold))
        title.setStyleSheet('color: #2c3e50; padding: 6px 0;')
        layout.addWidget(title)

        sub = QLabel('Creá descuentos por %, fijos, 2x1, NxM y packs que se aplican automáticamente en ventas.')
        sub.setStyleSheet('color: #6f6a5d; font-size: 11px; padding-bottom: 4px;')
        layout.addWidget(sub)

        # Botones
        btn_layout = QHBoxLayout()

        add_btn = QPushButton('+ Nueva Promoción')
        add_btn.setObjectName('btnSuccess')
        add_btn.setMinimumHeight(36)
        add_btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
        add_btn.clicked.connect(self.add_promo)
        btn_layout.addWidget(add_btn)

        edit_btn = QPushButton('Editar')
        edit_btn.setObjectName('btnSecondary')
        edit_btn.setMinimumHeight(36)
        edit_btn.clicked.connect(self.edit_promo)
        btn_layout.addWidget(edit_btn)

        toggle_btn = QPushButton('Activar / Desactivar')
        toggle_btn.setObjectName('btnWarning')
        toggle_btn.setMinimumHeight(36)
        toggle_btn.clicked.connect(self.toggle_promo)
        btn_layout.addWidget(toggle_btn)

        delete_btn = QPushButton('Eliminar')
        delete_btn.setObjectName('btnDanger')
        delete_btn.setMinimumHeight(36)
        delete_btn.clicked.connect(self.delete_promo)
        btn_layout.addWidget(delete_btn)

        btn_layout.addStretch()

        refresh_btn = QPushButton('Actualizar')
        refresh_btn.setObjectName('btnSecondary')
        refresh_btn.setMinimumHeight(36)
        refresh_btn.clicked.connect(self.refresh_data)
        btn_layout.addWidget(refresh_btn)

        layout.addLayout(btn_layout)

        # Tabla
        self.table = QTableWidget()
        self.table.setColumnCount(7)
        self.table.setHorizontalHeaderLabels([
            'ID', 'Nombre', 'Tipo', 'Valor', 'Productos vinculados', 'Estado', 'Descripción'
        ])
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setAlternatingRowColors(True)
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.doubleClicked.connect(self.edit_promo)

        from PyQt5.QtWidgets import QHeaderView
        hh = self.table.horizontalHeader()
        hh.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(1, QHeaderView.Stretch)
        hh.setSectionResizeMode(2, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(3, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(4, QHeaderView.Stretch)
        hh.setSectionResizeMode(5, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(6, QHeaderView.Stretch)
        layout.addWidget(self.table)

        self.refresh_data()

    def refresh_data(self):
        promos = self.promo_model.get_all()
        self.table.setRowCount(len(promos))
        for row, p in enumerate(promos):
            self.table.setRowHeight(row, 40)

            self.table.setItem(row, 0, QTableWidgetItem(str(p['id'])))
            self.table.setItem(row, 1, QTableWidgetItem(p['name']))
            self.table.setItem(row, 2, QTableWidgetItem(PROMO_TYPES.get(p['promo_type'], p['promo_type'])))

            # Valor descriptivo
            val = self._format_value(p)
            val_item = QTableWidgetItem(val)
            val_item.setFont(QFont('Segoe UI', 10, QFont.Bold))
            self.table.setItem(row, 3, val_item)

            # Productos
            prod_names = ', '.join(pr['name'] for pr in p.get('products', [])) or '(todos)'
            self.table.setItem(row, 4, QTableWidgetItem(prod_names))

            # Estado
            estado = 'Activa' if p['is_active'] else 'Inactiva'
            estado_item = QTableWidgetItem(estado)
            estado_item.setTextAlignment(Qt.AlignCenter)
            if p['is_active']:
                estado_item.setForeground(QColor('#3d7a3a'))
                estado_item.setBackground(QColor('#e7f4ec'))
            else:
                estado_item.setForeground(QColor('#6f6a5d'))
                estado_item.setBackground(QColor('#ece8df'))
            self.table.setItem(row, 5, estado_item)

            self.table.setItem(row, 6, QTableWidgetItem(p.get('description') or ''))

    @staticmethod
    def _format_value(p: dict) -> str:
        ptype = p.get('promo_type', '')
        dval  = p.get('discount_value', 0)
        req   = p.get('required_quantity', 1)
        free  = p.get('free_quantity', 0)
        if ptype == 'percentage':
            return f'{dval:.0f}% desc.'
        elif ptype == 'fixed':
            return f'${dval:.2f} desc.'
        elif ptype == '2x1':
            return '2x1'
        elif ptype == 'nxm':
            return f'Lleva {req}, paga {req - free}'
        elif ptype == 'bundle':
            return f'Pack de {req} → ${dval:.2f}'
        return ''

    def _selected_promo_id(self):
        row = self.table.currentRow()
        if row < 0:
            QMessageBox.warning(self, 'Aviso', 'Seleccioná una promoción')
            return None
        return int(self.table.item(row, 0).text())

    def add_promo(self):
        dlg = PromoDialog(self)
        if dlg.exec_() == QDialog.Accepted:
            self.refresh_data()
            mw = self.get_main_window()
            if mw:
                mw.refresh_all_views()

    def edit_promo(self):
        pid = self._selected_promo_id()
        if pid is None:
            return
        promo = self.promo_model.get_by_id(pid)
        dlg = PromoDialog(self, promo=promo)
        if dlg.exec_() == QDialog.Accepted:
            self.refresh_data()
            mw = self.get_main_window()
            if mw:
                mw.refresh_all_views()

    def toggle_promo(self):
        pid = self._selected_promo_id()
        if pid is None:
            return
        self.promo_model.toggle_active(pid)
        self.refresh_data()

    def delete_promo(self):
        pid = self._selected_promo_id()
        if pid is None:
            return
        row = self.table.currentRow()
        name = self.table.item(row, 1).text()
        reply = QMessageBox.question(
            self, 'Confirmar',
            f'¿Eliminar la promoción "{name}"?\nEsta acción no se puede deshacer.',
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No
        )
        if reply == QMessageBox.Yes:
            self.promo_model.delete(pid)
            self.refresh_data()
            mw = self.get_main_window()
            if mw:
                mw.refresh_all_views()


class PromoDialog(QDialog):
    """Diálogo para crear/editar una promoción."""

    HELP = {
        'percentage': 'Se aplica X% de descuento sobre el precio original del producto.',
        'fixed':      'Se resta $X fijo del precio de cada unidad vendida.',
        '2x1':        'El cliente lleva 2 unidades pero paga solo 1. Aplica en grupos de 2.',
        'nxm':        'El cliente lleva N unidades y paga M. Configurable (ej: lleva 3, paga 2).',
        'bundle':     'Precio especial para un pack de N unidades (ej: pack de 6 → $500).',
    }

    def __init__(self, parent=None, promo=None):
        super().__init__(parent)
        self.promo = promo
        from pos_system.database.db_manager import DatabaseManager
        self.db = DatabaseManager()
        self.promo_model = Promotion(self.db)
        self.product_model = Product(self.db)
        self.setWindowTitle('Nueva Promoción' if not promo else 'Editar Promoción')
        self.setMinimumWidth(560)
        self.setModal(True)
        self.init_ui()
        if promo:
            self.load_data()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 16, 20, 16)
        layout.setSpacing(10)

        form = QFormLayout()
        form.setSpacing(10)

        # Nombre
        self.name_input = QLineEdit()
        self.name_input.setPlaceholderText('Nombre de la promoción...')
        self.name_input.setMinimumHeight(34)
        form.addRow('Nombre *:', self.name_input)

        # Tipo de promo
        self.type_combo = QComboBox()
        self.type_combo.setMinimumHeight(34)
        for key, label in PROMO_TYPES.items():
            self.type_combo.addItem(label, key)
        self.type_combo.currentIndexChanged.connect(self._on_type_changed)
        form.addRow('Tipo *:', self.type_combo)

        # Ayuda
        self.help_label = QLabel()
        self.help_label.setWordWrap(True)
        self.help_label.setStyleSheet(
            'background:#fbeee5; color:#c1521f; border:1px solid #dcd6c8; '
            'border-radius:6px; padding:8px; font-size:11px;'
        )
        form.addRow('', self.help_label)

        # Valor de descuento (%)
        self.discount_spin = QDoubleSpinBox()
        self.discount_spin.setMinimum(0)
        self.discount_spin.setMaximum(999999)
        self.discount_spin.setDecimals(2)
        self.discount_spin.setMinimumHeight(34)
        self.discount_row_label = QLabel('Descuento % *:')
        form.addRow(self.discount_row_label, self.discount_spin)

        # Cantidad requerida (para nxm/bundle/2x1)
        self.req_qty_spin = QSpinBox()
        self.req_qty_spin.setMinimum(1)
        self.req_qty_spin.setMaximum(999)
        self.req_qty_spin.setValue(2)
        self.req_qty_spin.setMinimumHeight(34)
        self.req_row_label = QLabel('Cantidad que lleva *:')
        form.addRow(self.req_row_label, self.req_qty_spin)

        # Cantidad gratis (para nxm)
        self.free_qty_spin = QSpinBox()
        self.free_qty_spin.setMinimum(0)
        self.free_qty_spin.setMaximum(999)
        self.free_qty_spin.setValue(1)
        self.free_qty_spin.setMinimumHeight(34)
        self.free_row_label = QLabel('Cantidad gratis *:')
        form.addRow(self.free_row_label, self.free_qty_spin)

        # Descripción
        self.desc_input = QTextEdit()
        self.desc_input.setMaximumHeight(60)
        self.desc_input.setPlaceholderText('Descripción opcional...')
        form.addRow('Descripción:', self.desc_input)

        layout.addLayout(form)

        # Productos vinculados
        prod_label = QLabel('Productos vinculados:')
        prod_label.setFont(QFont('Segoe UI', 10, QFont.Bold))
        layout.addWidget(prod_label)

        prod_hint = QLabel('Seleccioná los productos a los que aplica esta promo (si no seleccionás ninguno, aplica a todos).')
        prod_hint.setStyleSheet('color:#6f6a5d; font-size:10px;')
        prod_hint.setWordWrap(True)
        layout.addWidget(prod_hint)

        self.products_list = QListWidget()
        self.products_list.setSelectionMode(QAbstractItemView.MultiSelection)
        self.products_list.setMaximumHeight(160)
        self.products_list.setFont(QFont('Segoe UI', 10))

        all_products = self.product_model.get_all()
        for p in all_products:
            item = QListWidgetItem(f"{p['name']}  (${p['price']:.2f})")
            item.setData(Qt.UserRole, p['id'])
            self.products_list.addItem(item)

        layout.addWidget(self.products_list)

        # Botones
        btn_layout = QHBoxLayout()
        save_btn = QPushButton('Guardar')
        save_btn.setObjectName('btnSuccess')
        save_btn.setMinimumHeight(38)
        save_btn.setFont(QFont('Segoe UI', 11, QFont.Bold))
        save_btn.clicked.connect(self.save)
        btn_layout.addWidget(save_btn)

        cancel_btn = QPushButton('Cancelar')
        cancel_btn.setObjectName('btnSecondary')
        cancel_btn.setMinimumHeight(38)
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(cancel_btn)
        layout.addLayout(btn_layout)

        self._on_type_changed()

    def _on_type_changed(self):
        ptype = self.type_combo.currentData()
        self.help_label.setText(self.HELP.get(ptype, ''))

        show_discount = ptype in ('percentage', 'fixed', 'bundle')
        show_req      = ptype in ('nxm', 'bundle', '2x1')
        show_free     = ptype == 'nxm'

        self.discount_spin.setVisible(show_discount)
        self.discount_row_label.setVisible(show_discount)
        self.req_qty_spin.setVisible(show_req)
        self.req_row_label.setVisible(show_req)
        self.free_qty_spin.setVisible(show_free)
        self.free_row_label.setVisible(show_free)

        if ptype == 'percentage':
            self.discount_spin.setSuffix(' %')
            self.discount_spin.setMaximum(100)
            self.discount_row_label.setText('Descuento % *:')
        elif ptype == 'fixed':
            self.discount_spin.setSuffix(' $')
            self.discount_spin.setMaximum(999999)
            self.discount_row_label.setText('Descuento fijo $ *:')
        elif ptype == 'bundle':
            self.discount_spin.setSuffix(' $')
            self.discount_spin.setMaximum(999999)
            self.discount_row_label.setText('Precio del pack $:')
            self.req_row_label.setText('Unidades en el pack *:')
        elif ptype == '2x1':
            # fijo: lleva 2 paga 1
            self.req_qty_spin.setValue(2)
            self.free_qty_spin.setValue(1)
            self.req_row_label.setText('Cantidad que lleva (2x1):')
        elif ptype == 'nxm':
            self.req_row_label.setText('Cantidad que lleva N *:')
            self.free_row_label.setText('Cantidad gratis M *:')

    def load_data(self):
        p = self.promo
        self.name_input.setText(p.get('name', ''))
        self.desc_input.setPlainText(p.get('description', '') or '')

        # Tipo
        idx = self.type_combo.findData(p.get('promo_type', 'percentage'))
        if idx >= 0:
            self.type_combo.setCurrentIndex(idx)
        self._on_type_changed()

        self.discount_spin.setValue(float(p.get('discount_value', 0)))
        self.req_qty_spin.setValue(int(p.get('required_quantity', 1)))
        self.free_qty_spin.setValue(int(p.get('free_quantity', 0)))

        # Seleccionar productos
        linked_ids = set(p.get('product_ids', []))
        for i in range(self.products_list.count()):
            item = self.products_list.item(i)
            if item.data(Qt.UserRole) in linked_ids:
                item.setSelected(True)

    def save(self):
        name = self.name_input.text().strip()
        if not name:
            QMessageBox.warning(self, 'Error', 'El nombre es obligatorio')
            return

        ptype = self.type_combo.currentData()

        # Validaciones por tipo
        if ptype == 'percentage' and self.discount_spin.value() <= 0:
            QMessageBox.warning(self, 'Error', 'El porcentaje de descuento debe ser mayor a 0')
            return
        if ptype == 'fixed' and self.discount_spin.value() <= 0:
            QMessageBox.warning(self, 'Error', 'El descuento fijo debe ser mayor a 0')
            return
        if ptype == 'nxm':
            if self.free_qty_spin.value() <= 0:
                QMessageBox.warning(self, 'Error', 'La cantidad gratis debe ser al menos 1')
                return
            if self.free_qty_spin.value() >= self.req_qty_spin.value():
                QMessageBox.warning(self, 'Error', 'La cantidad gratis debe ser menor a la cantidad requerida')
                return

        # Productos seleccionados
        product_ids = []
        for item in self.products_list.selectedItems():
            product_ids.append(item.data(Qt.UserRole))

        promo_data = {
            'name':              name,
            'promo_type':        ptype,
            'description':       self.desc_input.toPlainText().strip(),
            'discount_value':    self.discount_spin.value(),
            'required_quantity': self.req_qty_spin.value(),
            'free_quantity':     self.free_qty_spin.value(),
            'product_ids':       product_ids,
            'is_active':         True,
        }

        try:
            if self.promo:
                self.promo_model.update(self.promo['id'], promo_data)
                QMessageBox.information(self, 'Éxito', 'Promoción actualizada correctamente')
            else:
                self.promo_model.create(promo_data)
                QMessageBox.information(self, 'Éxito', 'Promoción creada correctamente')
            self.accept()
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo guardar: {e}')
