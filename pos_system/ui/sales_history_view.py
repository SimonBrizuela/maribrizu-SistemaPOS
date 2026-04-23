"""
Sales History View - Full sales history with filters and detail view
"""
import logging
import os
import platform
import subprocess
from datetime import datetime, timedelta, timezone
from pos_system.utils.firebase_sync import now_ar

_TZ_AR = timezone(timedelta(hours=-3))

def _fmt_qty(q):
    """Formatea cantidades: 1.0 -> '1', 0.3 -> '0.3', 2.55 -> '2.55'."""
    q = float(q or 0)
    if q == int(q):
        return str(int(q))
    return f"{q:.2f}".rstrip('0').rstrip('.')

def _parse_ar(s):
    try:
        dt = datetime.fromisoformat(str(s))
    except (ValueError, TypeError):
        return datetime.now(_TZ_AR).replace(tzinfo=None)
    if dt.tzinfo is not None:
        return dt.astimezone(_TZ_AR).replace(tzinfo=None)
    return dt
from PyQt5.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QTableWidget,
                             QTableWidgetItem, QPushButton, QLabel, QComboBox,
                             QDialog, QFormLayout, QMessageBox, QHeaderView,
                             QDateEdit, QFrame, QSplitter, QGroupBox, QScrollArea,
                             QDialogButtonBox, QDoubleSpinBox)
from PyQt5.QtCore import Qt, QDate
from PyQt5.QtGui import QFont, QColor

# Constantes cacheadas para evitar instanciar QFont/QColor por cada celda
# durante refresh_data y _show_sale_detail (causa lag con cientos de ventas).
_FONT_BOLD_9     = QFont('Segoe UI', 9, QFont.Bold)
_FONT_NORMAL_9   = QFont('Segoe UI', 9)
_FONT_STRIKE_9   = QFont('Segoe UI', 9); _FONT_STRIKE_9.setStrikeOut(True)
_COLOR_GREEN     = QColor('#198754')
_COLOR_BLUE      = QColor('#0d6efd')
_COLOR_RED       = QColor('#dc3545')
_COLOR_GRAY      = QColor('#adb5bd')
# Máximo de ventas a cargar por refresh — protege la UI cuando el rango
# de fechas devuelve miles de filas. La paginación se hace por filtro de
# fecha (los rangos rápidos ya filtran).
_MAX_SALES_LOAD = 500

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
        # Una sola conexión: itemSelectionChanged. Antes había dos
        # (currentRowChanged + itemSelectionChanged) y ambas disparaban
        # _show_sale_detail en cada selección → get_by_id() x2 en cada click.
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

        self.edit_btn = QPushButton('Editar Venta')
        self.edit_btn.setObjectName('btnSecondary')
        self.edit_btn.setEnabled(False)
        self.edit_btn.setCursor(Qt.PointingHandCursor)
        self.edit_btn.setStyleSheet('''
            QPushButton { background:#f59e0b; color:white; border:none;
                          border-radius:6px; padding:6px 14px; font-weight:bold; }
            QPushButton:hover { background:#d97706; }
            QPushButton:disabled { background:#e5e7eb; color:#9ca3af; }
        ''')
        self.edit_btn.clicked.connect(self._edit_current_sale)
        detail_header.addWidget(self.edit_btn)

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
            payment_type=payment_type,
            limit=_MAX_SALES_LOAD,
        )

        # Bloquear señales y repaints durante el populate — antes cada setItem
        # podía disparar selectionChanged → _show_sale_detail → query SQLite.
        # Con N=300 esto causaba freezes de 1-2s al filtrar.
        tbl = self.sales_table
        tbl.blockSignals(True)
        tbl.setUpdatesEnabled(False)
        tbl.clearSelection()
        try:
            tbl.setRowCount(len(sales))
            total_sum = 0.0
            cash_sum = 0.0
            transfer_sum = 0.0

            for row, sale in enumerate(sales):
                tbl.setRowHeight(row, 36)

                id_item = QTableWidgetItem(str(sale['id']))
                id_item.setTextAlignment(Qt.AlignCenter)
                id_item.setData(Qt.UserRole, sale['id'])
                tbl.setItem(row, 0, id_item)

                try:
                    dt = _parse_ar(sale['created_at'])
                    date_str = dt.strftime('%d/%m/%Y %H:%M:%S')
                except Exception:
                    date_str = sale['created_at']
                tbl.setItem(row, 1, QTableWidgetItem(date_str))

                ptype = sale['payment_type']
                ptype_label = 'Efectivo' if ptype == 'cash' else 'Transferencia'
                ptype_item = QTableWidgetItem(ptype_label)
                ptype_item.setTextAlignment(Qt.AlignCenter)
                ptype_item.setForeground(_COLOR_GREEN if ptype == 'cash' else _COLOR_BLUE)
                tbl.setItem(row, 2, ptype_item)

                total = sale['total_amount']
                total_item = QTableWidgetItem(f'${total:.2f}')
                total_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                total_item.setFont(_FONT_BOLD_9)
                tbl.setItem(row, 3, total_item)

                received = sale.get('cash_received', 0) or 0
                change = sale.get('change_given', 0) or 0
                rec_item = QTableWidgetItem(f'${received:.2f}' if received > 0 else '-')
                rec_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                tbl.setItem(row, 4, rec_item)

                chg_item = QTableWidgetItem(f'${change:.2f}' if change > 0 else '-')
                chg_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                tbl.setItem(row, 5, chg_item)

                discount = sale.get('discount', 0) or 0
                disc_item = QTableWidgetItem(f'-${discount:.2f}' if discount > 0 else '-')
                disc_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                if discount > 0:
                    disc_item.setForeground(_COLOR_RED)
                tbl.setItem(row, 6, disc_item)

                total_sum += total
                if ptype == 'cash':
                    cash_sum += total
                else:
                    transfer_sum += total
        finally:
            tbl.setUpdatesEnabled(True)
            tbl.blockSignals(False)

        # Resumen
        count = len(sales)
        avg = total_sum / count if count > 0 else 0
        truncado = f' (limite: {_MAX_SALES_LOAD} mas recientes — acota fechas para ver mas)' if count >= _MAX_SALES_LOAD else ''
        self.summary_label.setText(
            f'<b>{count}</b> ventas{truncado}  |  '
            f'Total: <b>${total_sum:.2f}</b>  |  '
            f'Efectivo: <b>${cash_sum:.2f}</b>  |  '
            f'Virtual: <b>${transfer_sum:.2f}</b>  |  '
            f'Promedio: <b>${avg:.2f}</b>'
        )

        # Limpiar detalle
        self.detail_table.setRowCount(0)
        self.reprint_btn.setEnabled(False)
        self.edit_btn.setEnabled(False)
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
        # Evitar re-cargar si ya está mostrado (la doble-conexión vieja causaba esto;
        # ahora con una sola conexión sigue siendo barato pero ahorra un get_by_id).
        if sale_id == self._current_sale_id:
            return
        self._current_sale_id = sale_id

        sale = self.sale_model.get_by_id(sale_id)
        if not sale:
            return

        items = sale.get('items', [])
        dt = self.detail_table
        dt.blockSignals(True)
        dt.setUpdatesEnabled(False)
        try:
            dt.setRowCount(len(items))
            for r, item in enumerate(items):
                dt.setRowHeight(r, 32)
                dt.setItem(r, 0, QTableWidgetItem(item['product_name']))

                orig_price = item.get('original_price', 0) or item.get('unit_price', 0)
                orig_item = QTableWidgetItem(f"${orig_price:.2f}")
                orig_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                if orig_price != item['unit_price']:
                    orig_item.setForeground(_COLOR_GRAY)
                    orig_item.setFont(_FONT_STRIKE_9)
                dt.setItem(r, 1, orig_item)

                price_item = QTableWidgetItem(f"${item['unit_price']:.2f}")
                price_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                if orig_price != item['unit_price']:
                    price_item.setForeground(_COLOR_GREEN)
                dt.setItem(r, 2, price_item)

                qty_item = QTableWidgetItem(_fmt_qty(item['quantity']))
                qty_item.setTextAlignment(Qt.AlignCenter)
                dt.setItem(r, 3, qty_item)

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
                    disc_item.setForeground(_COLOR_RED)
                dt.setItem(r, 4, disc_item)

                sub_item = QTableWidgetItem(f"${item['subtotal']:.2f}")
                sub_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                sub_item.setFont(_FONT_BOLD_9)
                dt.setItem(r, 5, sub_item)
        finally:
            dt.setUpdatesEnabled(True)
            dt.blockSignals(False)

        self.reprint_btn.setEnabled(True)
        self.edit_btn.setEnabled(True)

    def _edit_current_sale(self):
        if not self._current_sale_id:
            return
        sale = self.sale_model.get_by_id(self._current_sale_id)
        if not sale:
            QMessageBox.warning(self, 'Venta', 'No se encontró la venta seleccionada.')
            return
        dlg = EditSaleDialog(self, sale=sale)
        if dlg.exec_() != QDialog.Accepted:
            return

        try:
            updated = self.sale_model.update(
                sale_id=self._current_sale_id,
                payment_type=dlg.new_payment_type,
                items_updates=dlg.items_updates,
            )
            if not updated:
                QMessageBox.critical(self, 'Error', 'No se pudo actualizar la venta.')
                return
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'Error al actualizar la venta:\n{e}')
            return

        # Resync a Firebase (venta + detalle + historial + mensual + cierre)
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if fb:
                fb.resync_sale_after_edit(self._current_sale_id, self.db)
        except Exception as e:
            logger.warning(f"Firebase resync tras edición: {e}")

        # Refrescar UI local
        self.refresh_data()
        # Refrescar otras vistas (cash_view, dashboard, etc.)
        try:
            w = self.parent()
            while w is not None and not hasattr(w, 'refresh_all_views'):
                w = w.parent()
            if w is not None:
                w.refresh_all_views()
        except Exception:
            pass

        QMessageBox.information(self, 'Venta actualizada',
            f"Venta #{self._current_sale_id} actualizada.\n"
            f"Nuevo total: ${updated['total_amount']:.2f}\n"
            f"Pago: {'Efectivo' if updated['payment_type'] == 'cash' else 'Transferencia'}")

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


class EditSaleDialog(QDialog):
    """Editar método de pago y precios unitarios de una venta existente."""

    def __init__(self, parent=None, sale=None):
        super().__init__(parent)
        self.sale = sale or {}
        self.items = list(self.sale.get('items') or [])
        self._spins = {}
        self._subtotal_labels = {}
        self.new_payment_type = str(self.sale.get('payment_type') or 'cash')
        self.items_updates = []

        self.setWindowTitle(f"Editar venta #{self.sale.get('id', '')}")
        self.setMinimumSize(640, 520)
        self._build_ui()
        self._recalc_total()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        header = QLabel(f"Venta #{self.sale.get('id', '')}  -  {self.sale.get('created_at', '')}")
        header.setFont(QFont('Segoe UI', 11, QFont.Bold))
        header.setStyleSheet('color: #1e293b;')
        layout.addWidget(header)

        pay_group = QGroupBox('Método de pago')
        pay_layout = QHBoxLayout(pay_group)
        pay_layout.setContentsMargins(10, 8, 10, 8)
        self.pay_combo = QComboBox()
        self.pay_combo.addItem('Efectivo', 'cash')
        self.pay_combo.addItem('Transferencia', 'transfer')
        idx = 0 if self.new_payment_type == 'cash' else 1
        self.pay_combo.setCurrentIndex(idx)
        self.pay_combo.currentIndexChanged.connect(self._on_payment_changed)
        pay_layout.addWidget(QLabel('Pago:'))
        pay_layout.addWidget(self.pay_combo)
        pay_layout.addStretch()
        layout.addWidget(pay_group)

        items_group = QGroupBox(f"Items ({len(self.items)})")
        ig_layout = QVBoxLayout(items_group)
        ig_layout.setContentsMargins(10, 8, 10, 8)

        self.table = QTableWidget()
        self.table.setColumnCount(5)
        self.table.setHorizontalHeaderLabels(['Producto', 'Cant.', 'Precio unit.', 'Desc.', 'Subtotal'])
        self.table.setRowCount(len(self.items))
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.setSelectionMode(QTableWidget.NoSelection)
        hdr = self.table.horizontalHeader()
        hdr.setSectionResizeMode(0, QHeaderView.Stretch)
        hdr.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        hdr.setSectionResizeMode(2, QHeaderView.ResizeToContents)
        hdr.setSectionResizeMode(3, QHeaderView.ResizeToContents)
        hdr.setSectionResizeMode(4, QHeaderView.ResizeToContents)

        for row, it in enumerate(self.items):
            name_item = QTableWidgetItem(str(it.get('product_name') or ''))
            name_item.setFlags(name_item.flags() & ~Qt.ItemIsEditable)
            self.table.setItem(row, 0, name_item)

            qty = float(it.get('quantity') or 0)
            qty_item = QTableWidgetItem(_fmt_qty(qty))
            qty_item.setTextAlignment(Qt.AlignCenter)
            qty_item.setFlags(qty_item.flags() & ~Qt.ItemIsEditable)
            self.table.setItem(row, 1, qty_item)

            spin = QDoubleSpinBox()
            spin.setDecimals(2)
            spin.setRange(0.0, 9_999_999.99)
            spin.setSingleStep(100.0)
            spin.setValue(float(it.get('unit_price') or 0))
            spin.setPrefix('$ ')
            spin.valueChanged.connect(self._recalc_total)
            self._spins[int(it.get('id'))] = spin
            self.table.setCellWidget(row, 2, spin)

            disc = float(it.get('discount_amount') or 0)
            disc_item = QTableWidgetItem(f"${disc:.2f}" if disc else '-')
            disc_item.setTextAlignment(Qt.AlignCenter)
            disc_item.setFlags(disc_item.flags() & ~Qt.ItemIsEditable)
            self.table.setItem(row, 3, disc_item)

            sub_lbl = QTableWidgetItem(f"${float(it.get('subtotal') or 0):.2f}")
            sub_lbl.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            sub_lbl.setFlags(sub_lbl.flags() & ~Qt.ItemIsEditable)
            self.table.setItem(row, 4, sub_lbl)
            self._subtotal_labels[int(it.get('id'))] = (row, float(it.get('discount_amount') or 0), qty)

        ig_layout.addWidget(self.table)
        layout.addWidget(items_group, stretch=1)

        total_row = QHBoxLayout()
        total_row.addStretch()
        total_row.addWidget(QLabel('Total:'))
        self.total_lbl = QLabel('$0.00')
        self.total_lbl.setFont(QFont('Segoe UI', 13, QFont.Bold))
        self.total_lbl.setStyleSheet('color: #0f172a;')
        total_row.addWidget(self.total_lbl)
        layout.addLayout(total_row)

        btns = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        btns.button(QDialogButtonBox.Save).setText('Guardar')
        btns.button(QDialogButtonBox.Cancel).setText('Cancelar')
        btns.accepted.connect(self._on_accept)
        btns.rejected.connect(self.reject)
        layout.addWidget(btns)

    def _on_payment_changed(self, _idx):
        self.new_payment_type = str(self.pay_combo.currentData() or 'cash')

    def _recalc_total(self):
        total = 0.0
        for iid, spin in self._spins.items():
            row, disc, qty = self._subtotal_labels[iid]
            sub = float(spin.value()) * qty - disc
            if sub < 0:
                sub = 0.0
            self.table.item(row, 4).setText(f"${sub:.2f}")
            total += sub
        self.total_lbl.setText(f"${total:.2f}")

    def _on_accept(self):
        updates = []
        for it in self.items:
            iid = int(it.get('id'))
            new_price = float(self._spins[iid].value())
            old_price = float(it.get('unit_price') or 0)
            if abs(new_price - old_price) > 0.005:
                updates.append({'id': iid, 'unit_price': new_price})
        self.items_updates = updates
        self.accept()
