"""
Sales History View - Full sales history with filters and detail view
"""
import logging
import os
import platform
import subprocess
from datetime import datetime, timedelta
from PyQt5.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QTableWidget,
                             QTableWidgetItem, QPushButton, QLabel, QComboBox,
                             QDialog, QFormLayout, QMessageBox, QHeaderView,
                             QDateEdit, QFrame, QSplitter, QGroupBox, QScrollArea)
from PyQt5.QtCore import Qt, QDate
from PyQt5.QtGui import QFont, QColor

from pos_system.models.sale import Sale
from pos_system.database.db_manager import DatabaseManager
from pos_system.utils.pdf_generator import PDFGenerator

logger = logging.getLogger(__name__)


class SalesHistoryView(QWidget):
    """Vista de historial completo de ventas con filtros"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.db = DatabaseManager()
        self.sale_model = Sale(self.db)
        self.pdf_generator = PDFGenerator()
        self.init_ui()

    def open_pdf(self, pdf_path):
        try:
            if platform.system() == 'Windows':
                os.startfile(pdf_path)
            elif platform.system() == 'Darwin':
                subprocess.run(['open', pdf_path])
            else:
                subprocess.run(['xdg-open', pdf_path])
        except Exception as e:
            logger.error(f"Error abriendo PDF: {e}")

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(14)

        # Header
        title = QLabel('Historial de Ventas')
        title.setFont(QFont('Segoe UI', 15, QFont.Bold))
        title.setStyleSheet('color: #1e293b;')
        layout.addWidget(title)

        # Filtros — con scroll horizontal si la pantalla es chica
        filter_scroll = QScrollArea()
        filter_scroll.setWidgetResizable(True)
        filter_scroll.setMaximumHeight(60)
        filter_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        filter_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        filter_scroll.setFrameShape(QFrame.NoFrame)

        filter_frame = QFrame()
        filter_frame.setStyleSheet(
            'QFrame { background: white; border: 1px solid #dee2e6; border-radius: 8px; }'
        )
        filter_layout = QHBoxLayout(filter_frame)
        filter_layout.setContentsMargins(12, 6, 12, 6)
        filter_layout.setSpacing(10)

        # Rango de fechas
        filter_layout.addWidget(QLabel('Desde:'))
        self.from_date = QDateEdit()
        self.from_date.setCalendarPopup(True)
        self.from_date.setDate(QDate.currentDate().addDays(-30))
        self.from_date.setDisplayFormat('dd/MM/yyyy')
        self.from_date.setMinimumHeight(34)
        filter_layout.addWidget(self.from_date)

        filter_layout.addWidget(QLabel('Hasta:'))
        self.to_date = QDateEdit()
        self.to_date.setCalendarPopup(True)
        self.to_date.setDate(QDate.currentDate())
        self.to_date.setDisplayFormat('dd/MM/yyyy')
        self.to_date.setMinimumHeight(34)
        filter_layout.addWidget(self.to_date)

        # Tipo de pago
        filter_layout.addWidget(QLabel('Pago:'))
        self.payment_filter = QComboBox()
        self.payment_filter.addItem('Todos', None)
        self.payment_filter.addItem('Efectivo', 'cash')
        self.payment_filter.addItem('Transferencia', 'transfer')
        self.payment_filter.setMinimumHeight(34)
        filter_layout.addWidget(self.payment_filter)

        # Botones de rango rápido
        range_btn_style = '''
            QPushButton {
                background: #f1f3f5; color: #495057;
                border: 1.5px solid #ced4da; border-radius: 6px;
                padding: 4px 12px; font-size: 10px; font-weight: bold;
                min-height: 32px; min-width: 54px;
            }
            QPushButton:hover { background: #0d6efd; color: white; border-color: #0d6efd; }
        '''
        for label, slot in [('Hoy', self._set_today), ('7 dias', self._set_week), ('30 dias', self._set_month)]:
            btn = QPushButton(label)
            btn.setStyleSheet(range_btn_style)
            btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
            btn.clicked.connect(slot)
            filter_layout.addWidget(btn)

        search_btn = QPushButton('Buscar')
        search_btn.setStyleSheet('''
            QPushButton {
                background: #0d6efd; color: white;
                border: none; border-radius: 6px;
                padding: 4px 16px; font-weight: bold;
                min-height: 32px;
            }
            QPushButton:hover { background: #0b5ed7; }
        ''')
        search_btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
        search_btn.clicked.connect(self.refresh_data)
        filter_layout.addWidget(search_btn)

        filter_layout.addStretch()
        filter_scroll.setWidget(filter_frame)
        layout.addWidget(filter_scroll)

        # Splitter: tabla ventas + detalle
        splitter = QSplitter(Qt.Vertical)

        # Tabla principal de ventas
        self.sales_table = QTableWidget()
        self.sales_table.setColumnCount(7)
        self.sales_table.setHorizontalHeaderLabels(
            ['ID', 'Fecha y Hora', 'Tipo de Pago', 'Total', 'Recibido', 'Vuelto', 'Descuento']
        )
        self.sales_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.sales_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.sales_table.setAlternatingRowColors(True)
        self.sales_table.verticalHeader().setVisible(False)
        self.sales_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeToContents)
        self.sales_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)
        self.sales_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        self.sales_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeToContents)
        self.sales_table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeToContents)
        self.sales_table.horizontalHeader().setSectionResizeMode(5, QHeaderView.ResizeToContents)
        self.sales_table.horizontalHeader().setSectionResizeMode(6, QHeaderView.ResizeToContents)
        self.sales_table.selectionModel().currentRowChanged.connect(
            lambda current, prev: self._show_sale_detail(current.row())
        ) if self.sales_table.selectionModel() else None
        self.sales_table.itemSelectionChanged.connect(self._on_selection_changed)
        splitter.addWidget(self.sales_table)

        # Panel de detalle
        detail_widget = QWidget()
        detail_layout = QVBoxLayout(detail_widget)
        detail_layout.setContentsMargins(0, 8, 0, 0)
        detail_layout.setSpacing(6)

        detail_header = QHBoxLayout()
        detail_title = QLabel('Detalle de la Venta')
        detail_title.setFont(QFont('Segoe UI', 11, QFont.Bold))
        detail_title.setStyleSheet('color: #1e293b;')
        detail_header.addWidget(detail_title)
        detail_header.addStretch()

        self.reprint_btn = QPushButton('Reimprimir Ticket')
        self.reprint_btn.setObjectName('btnSecondary')
        self.reprint_btn.setEnabled(False)
        self.reprint_btn.setCursor(Qt.PointingHandCursor)
        self.reprint_btn.clicked.connect(self._reprint_ticket)
        detail_header.addWidget(self.reprint_btn)
        detail_layout.addLayout(detail_header)

        self.detail_table = QTableWidget()
        self.detail_table.setColumnCount(6)
        self.detail_table.setHorizontalHeaderLabels(['Producto', 'Precio Orig.', 'Precio Unit.', 'Cantidad', 'Descuento', 'Subtotal'])
        self.detail_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.detail_table.setAlternatingRowColors(True)
        self.detail_table.verticalHeader().setVisible(False)
        self.detail_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.detail_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeToContents)
        self.detail_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        self.detail_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeToContents)
        self.detail_table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeToContents)
        self.detail_table.horizontalHeader().setSectionResizeMode(5, QHeaderView.ResizeToContents)
        detail_layout.addWidget(self.detail_table)

        splitter.addWidget(detail_widget)
        splitter.setSizes([400, 200])
        layout.addWidget(splitter)

        # Resumen de totales
        self.summary_label = QLabel('')
        self.summary_label.setStyleSheet(
            'background: white; border: 1px solid #e2e8f0; border-left: 4px solid #0d6efd; '
            'border-radius: 7px; padding: 10px 16px; font-size: 12px; color: #1e293b;'
        )
        self.summary_label.setFont(QFont('Segoe UI', 10, QFont.Bold))
        layout.addWidget(self.summary_label)

        self._current_sale_id = None
        self.refresh_data()

    def _set_today(self):
        self.from_date.setDate(QDate.currentDate())
        self.to_date.setDate(QDate.currentDate())
        self.refresh_data()

    def _set_week(self):
        self.from_date.setDate(QDate.currentDate().addDays(-7))
        self.to_date.setDate(QDate.currentDate())
        self.refresh_data()

    def _set_month(self):
        self.from_date.setDate(QDate.currentDate().addDays(-30))
        self.to_date.setDate(QDate.currentDate())
        self.refresh_data()

    def refresh_data(self):
        from_date = self.from_date.date().toString('yyyy-MM-dd') + ' 00:00:00'
        to_date = self.to_date.date().toString('yyyy-MM-dd') + ' 23:59:59'
        payment_type = self.payment_filter.currentData()

        sales = self.sale_model.get_all(
            start_date=from_date,
            end_date=to_date,
            payment_type=payment_type
        )

        self.sales_table.setRowCount(len(sales))
        total_sum = 0.0
        cash_sum = 0.0
        transfer_sum = 0.0

        for row, sale in enumerate(sales):
            self.sales_table.setRowHeight(row, 36)

            id_item = QTableWidgetItem(str(sale['id']))
            id_item.setTextAlignment(Qt.AlignCenter)
            id_item.setData(Qt.UserRole, sale['id'])
            self.sales_table.setItem(row, 0, id_item)

            try:
                dt = datetime.fromisoformat(sale['created_at'])
                date_str = dt.strftime('%d/%m/%Y %H:%M:%S')
            except Exception:
                date_str = sale['created_at']
            self.sales_table.setItem(row, 1, QTableWidgetItem(date_str))

            ptype = sale['payment_type']
            ptype_label = 'Efectivo' if ptype == 'cash' else 'Transferencia'
            ptype_item = QTableWidgetItem(ptype_label)
            ptype_item.setTextAlignment(Qt.AlignCenter)
            if ptype == 'cash':
                ptype_item.setForeground(QColor('#198754'))
            else:
                ptype_item.setForeground(QColor('#0d6efd'))
            self.sales_table.setItem(row, 2, ptype_item)

            total = sale['total_amount']
            total_item = QTableWidgetItem(f'${total:.2f}')
            total_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            total_item.setFont(QFont('Segoe UI', 9, QFont.Bold))
            self.sales_table.setItem(row, 3, total_item)

            received = sale.get('cash_received', 0) or 0
            change = sale.get('change_given', 0) or 0
            rec_item = QTableWidgetItem(f'${received:.2f}' if received > 0 else '-')
            rec_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            self.sales_table.setItem(row, 4, rec_item)

            chg_item = QTableWidgetItem(f'${change:.2f}' if change > 0 else '-')
            chg_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            self.sales_table.setItem(row, 5, chg_item)

            discount = sale.get('discount', 0) or 0
            disc_item = QTableWidgetItem(f'-${discount:.2f}' if discount > 0 else '-')
            disc_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            if discount > 0:
                disc_item.setForeground(QColor('#dc3545'))
            self.sales_table.setItem(row, 6, disc_item)

            total_sum += total
            if ptype == 'cash':
                cash_sum += total
            else:
                transfer_sum += total

        # Resumen
        count = len(sales)
        avg = total_sum / count if count > 0 else 0
        self.summary_label.setText(
            f'<b>{count}</b> ventas  |  '
            f'Total: <b>${total_sum:.2f}</b>  |  '
            f'Efectivo: <b>${cash_sum:.2f}</b>  |  '
            f'Virtual: <b>${transfer_sum:.2f}</b>  |  '
            f'Promedio: <b>${avg:.2f}</b>'
        )

        # Limpiar detalle
        self.detail_table.setRowCount(0)
        self.reprint_btn.setEnabled(False)
        self._current_sale_id = None

    def _on_selection_changed(self):
        row = self.sales_table.currentRow()
        self._show_sale_detail(row)

    def _show_sale_detail(self, row):
        if row < 0:
            return
        id_item = self.sales_table.item(row, 0)
        if not id_item:
            return
        sale_id = id_item.data(Qt.UserRole)
        self._current_sale_id = sale_id

        sale = self.sale_model.get_by_id(sale_id)
        if not sale:
            return

        items = sale.get('items', [])
        self.detail_table.setRowCount(len(items))
        for r, item in enumerate(items):
            self.detail_table.setRowHeight(r, 32)
            self.detail_table.setItem(r, 0, QTableWidgetItem(item['product_name']))
            
            orig_price = item.get('original_price', 0) or item.get('unit_price', 0)
            orig_item = QTableWidgetItem(f"${orig_price:.2f}")
            orig_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            if orig_price != item['unit_price']:
                orig_item.setForeground(QColor('#adb5bd'))  # gris si hubo descuento
                font = QFont('Segoe UI', 9)
                font.setStrikeOut(True)
                orig_item.setFont(font)
            self.detail_table.setItem(r, 1, orig_item)
            
            price_item = QTableWidgetItem(f"${item['unit_price']:.2f}")
            price_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            if orig_price != item['unit_price']:
                price_item.setForeground(QColor('#198754'))  # verde si tiene descuento
            self.detail_table.setItem(r, 2, price_item)
            
            qty_item = QTableWidgetItem(str(item['quantity']))
            qty_item.setTextAlignment(Qt.AlignCenter)
            self.detail_table.setItem(r, 3, qty_item)
            
            disc_amount = item.get('discount_amount', 0) or 0
            disc_type = item.get('discount_type', '') or ''
            disc_val = item.get('discount_value', 0) or 0
            if disc_amount > 0:
                if disc_type == 'percentage':
                    disc_text = f"-${disc_amount:.2f} ({disc_val:.0f}%)"
                else:
                    disc_text = f"-${disc_amount:.2f}"
            else:
                disc_text = '-'
            disc_item = QTableWidgetItem(disc_text)
            disc_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            if disc_amount > 0:
                disc_item.setForeground(QColor('#dc3545'))
            self.detail_table.setItem(r, 4, disc_item)
            
            sub_item = QTableWidgetItem(f"${item['subtotal']:.2f}")
            sub_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            sub_item.setFont(QFont('Segoe UI', 9, QFont.Bold))
            self.detail_table.setItem(r, 5, sub_item)

        self.reprint_btn.setEnabled(True)

    def _reprint_ticket(self):
        if not self._current_sale_id:
            return
        sale = self.sale_model.get_by_id(self._current_sale_id)
        if not sale:
            return
        try:
            pdf_path = self.pdf_generator.generate_sale_ticket(sale)
            self.open_pdf(pdf_path)
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo generar el ticket: {e}')
