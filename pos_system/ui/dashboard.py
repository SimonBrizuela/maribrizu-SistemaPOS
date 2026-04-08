import logging
from PyQt5.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QGridLayout,
                             QLabel, QPushButton, QFrame, QScrollArea,
                             QDateEdit, QGroupBox)
from PyQt5.QtCore import Qt, QDate
from PyQt5.QtGui import QFont
from datetime import datetime, timedelta
import matplotlib.pyplot as plt
from matplotlib.backends.backend_qt5agg import FigureCanvasQTAgg as FigureCanvas
from matplotlib.figure import Figure

from pos_system.models.sale import Sale
from pos_system.models.product import Product
from pos_system.models.cash_register import CashRegister

logger = logging.getLogger(__name__)


class DashboardView(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        from pos_system.database.db_manager import DatabaseManager
        self.db = DatabaseManager()
        self.sale_model = Sale(self.db)
        self.product_model = Product(self.db)
        self.cash_register_model = CashRegister(self.db)
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(14)

        # Header con título y filtros de fecha
        header_layout = QHBoxLayout()

        title = QLabel('Dashboard — Estadísticas')
        title.setFont(QFont('Segoe UI', 15, QFont.Bold))
        title.setStyleSheet('color: #1e293b;')
        header_layout.addWidget(title)
        header_layout.addStretch()

        # Toolbar de fechas — en su propio frame para que no se apriete
        toolbar = QFrame()
        toolbar.setStyleSheet(
            'QFrame { background: white; border: 1px solid #dee2e6; border-radius: 8px; }'
        )
        toolbar_layout = QHBoxLayout(toolbar)
        toolbar_layout.setContentsMargins(10, 6, 10, 6)
        toolbar_layout.setSpacing(8)

        range_btn_style = '''
            QPushButton {
                background: #f1f3f5; color: #495057;
                border: 1.5px solid #ced4da; border-radius: 6px;
                padding: 4px 12px; font-size: 11px; font-weight: bold;
                min-height: 30px;
            }
            QPushButton:hover { background: #0d6efd; color: white; border-color: #0d6efd; }
            QPushButton:pressed { background: #0b5ed7; color: white; }
        '''

        for label, slot in [('Hoy', self._set_today), ('7 dias', self._set_week), ('30 dias', self._set_month)]:
            btn = QPushButton(label)
            btn.setStyleSheet(range_btn_style)
            btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
            btn.clicked.connect(slot)
            toolbar_layout.addWidget(btn)

        sep = QFrame()
        sep.setFrameShape(QFrame.VLine)
        sep.setStyleSheet('color: #dee2e6;')
        toolbar_layout.addWidget(sep)

        toolbar_layout.addWidget(QLabel('Desde:'))
        self.from_date = QDateEdit()
        self.from_date.setCalendarPopup(True)
        self.from_date.setDate(QDate.currentDate())
        self.from_date.setDisplayFormat('dd/MM/yyyy')
        self.from_date.setMinimumHeight(30)
        self.from_date.setMinimumWidth(105)
        toolbar_layout.addWidget(self.from_date)

        toolbar_layout.addWidget(QLabel('Hasta:'))
        self.to_date = QDateEdit()
        self.to_date.setCalendarPopup(True)
        self.to_date.setDate(QDate.currentDate())
        self.to_date.setDisplayFormat('dd/MM/yyyy')
        self.to_date.setMinimumHeight(30)
        self.to_date.setMinimumWidth(105)
        toolbar_layout.addWidget(self.to_date)

        refresh_btn = QPushButton('Actualizar')
        refresh_btn.setStyleSheet('''
            QPushButton {
                background: #0d6efd; color: white;
                border: none; border-radius: 6px;
                padding: 4px 16px; font-size: 11px; font-weight: bold;
                min-height: 30px;
            }
            QPushButton:hover { background: #0b5ed7; }
        ''')
        refresh_btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
        refresh_btn.clicked.connect(self.refresh_data)
        toolbar_layout.addWidget(refresh_btn)
        toolbar_layout.addStretch()

        layout.addWidget(toolbar)

        # Scroll area
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)

        content_widget = QWidget()
        content_layout = QVBoxLayout(content_widget)
        content_layout.setSpacing(14)

        # Cards de estadísticas (2 filas x 4 cols)
        self.stats_container = QGridLayout()
        self.stats_container.setSpacing(10)
        content_layout.addLayout(self.stats_container)

        # Alerta de stock bajo
        self.stock_alert_frame = QFrame()
        self.stock_alert_frame.setVisible(False)
        self.stock_alert_frame.setStyleSheet(
            'QFrame { background: #fff8e1; border: 1.5px solid #ffc107; border-radius: 8px; }'
        )
        alert_layout = QHBoxLayout(self.stock_alert_frame)
        alert_layout.setContentsMargins(12, 8, 12, 8)
        alert_icon = QLabel('')
        alert_icon.setFont(QFont('Segoe UI', 14))
        alert_icon.setStyleSheet('background: transparent; border: none;')
        alert_layout.addWidget(alert_icon)
        self.stock_alert_label = QLabel()
        self.stock_alert_label.setFont(QFont('Segoe UI', 10))
        self.stock_alert_label.setWordWrap(True)
        self.stock_alert_label.setStyleSheet('color: #856404; background: transparent; border: none;')
        alert_layout.addWidget(self.stock_alert_label, 1)
        content_layout.addWidget(self.stock_alert_frame)

        # Gráficos fila 1
        charts_row1 = QHBoxLayout()
        self.sales_chart = self._create_chart()
        charts_row1.addWidget(self.sales_chart)
        self.products_chart = self._create_chart()
        charts_row1.addWidget(self.products_chart)
        content_layout.addLayout(charts_row1)

        # Gráficos fila 2
        charts_row2 = QHBoxLayout()
        self.payment_chart = self._create_chart()
        charts_row2.addWidget(self.payment_chart)
        charts_row2.addStretch()
        content_layout.addLayout(charts_row2)

        scroll.setWidget(content_widget)
        layout.addWidget(scroll)

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

    def _get_date_range(self):
        start = self.from_date.date().toString('yyyy-MM-dd') + ' 00:00:00'
        end = self.to_date.date().toString('yyyy-MM-dd') + ' 23:59:59'
        return start, end

    def create_stat_card(self, title, value, icon, color):
        card = QFrame()
        card.setFrameShape(QFrame.StyledPanel)
        card.setStyleSheet(f'''
            QFrame {{
                background-color: white;
                border: 1px solid #e9ecef;
                border-top: 3px solid {color};
                border-radius: 10px;
                margin: 2px;
            }}
        ''')
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(14, 12, 14, 12)
        card_layout.setSpacing(6)

        # Fila superior: ícono + título
        top_row = QHBoxLayout()
        top_row.setSpacing(6)

        if icon:
            icon_lbl = QLabel(icon)
            icon_lbl.setFont(QFont('Segoe UI', 16))
            icon_lbl.setStyleSheet('background: transparent; border: none;')
            top_row.addWidget(icon_lbl)

        title_label = QLabel(title)
        title_label.setFont(QFont('Segoe UI', 9, QFont.Bold))
        title_label.setStyleSheet('color: #6c757d; background: transparent; border: none; letter-spacing: 0.3px;')
        title_label.setWordWrap(True)
        top_row.addWidget(title_label, 1)
        card_layout.addLayout(top_row)

        value_label = QLabel(str(value))
        value_label.setFont(QFont('Segoe UI', 18, QFont.Bold))
        value_label.setStyleSheet(f'color: {color}; background: transparent; border: none;')
        value_label.setWordWrap(True)
        card_layout.addWidget(value_label)

        return card

    def _create_chart(self):
        from PyQt5.QtWidgets import QSizePolicy as QSP
        figure = Figure(dpi=96)
        figure.patch.set_facecolor('#ffffff')
        figure.subplots_adjust(left=0.12, right=0.96, top=0.88, bottom=0.16)
        canvas = FigureCanvas(figure)
        canvas.setMinimumHeight(240)
        canvas.setSizePolicy(QSP.Expanding, QSP.Expanding)
        canvas.setStyleSheet('border: 1px solid #e9ecef; border-radius: 8px; background: white;')
        return canvas

    def refresh_data(self):
        start_date, end_date = self._get_date_range()

        # Limpiar cards anteriores
        for i in reversed(range(self.stats_container.count())):
            w = self.stats_container.itemAt(i).widget()
            if w:
                w.setParent(None)

        # Obtener datos del rango seleccionado
        summary = self.sale_model.get_sales_summary(start_date=start_date, end_date=end_date)
        all_sales = self.sale_model.get_all(start_date=start_date, end_date=end_date)
        cash_summary = self.cash_register_model.get_cash_summary()
        low_stock = self.product_model.get_low_stock(threshold=10)
        top_products = self.sale_model.get_top_selling_products(limit=1, start_date=start_date, end_date=end_date)

        total_sales_count = len(all_sales)
        cash_count = sum(1 for s in all_sales if s['payment_type'] == 'cash')
        transfer_count = total_sales_count - cash_count

        # Método de pago preferido
        if total_sales_count == 0:
            preferred_payment, preferred_color = 'Sin datos', '#6c757d'
        elif cash_count > transfer_count:
            preferred_payment, preferred_color = 'Efectivo', '#22c55e'
        elif transfer_count > cash_count:
            preferred_payment, preferred_color = 'Virtual', '#3b82f6'
        else:
            preferred_payment, preferred_color = 'Igual', '#f59e0b'

        # Producto más vendido
        if top_products:
            top_name = top_products[0]['product_name'][:18]
            top_qty = str(top_products[0]['total_quantity'])
        else:
            top_name, top_qty = 'Sin ventas', '0'

        # Crear cards con íconos
        cards = [
            ('VENTAS TOTALES',    f'${summary["total_amount"]:.2f}',         '', '#22c55e'),
            ('Nº DE VENTAS',      str(total_sales_count),                    '', '#3b82f6'),
            ('PAGO PREFERIDO',    preferred_payment,                         '', preferred_color),
            ('TICKET PROMEDIO',   f'${summary["average_sale"]:.2f}',         '', '#f59e0b'),
            (f'EFECTIVO ({cash_count})',   f'${summary["cash_amount"]:.2f}', '', '#22c55e'),
            (f'VIRTUAL ({transfer_count})',f'${summary["transfer_amount"]:.2f}','', '#3b82f6'),
            ('MÁS VENDIDO',       f'{top_name} ({top_qty})',                 '', '#8b5cf6'),
            ('STOCK BAJO',        str(len(low_stock)),                       '', '#ef4444' if low_stock else '#22c55e'),
        ]

        positions = [(0, 0), (0, 1), (0, 2), (0, 3), (1, 0), (1, 1), (1, 2), (1, 3)]
        for (row, col), (title, value, icon, color) in zip(positions, cards):
            card = self.create_stat_card(title, value, icon, color)
            self.stats_container.addWidget(card, row, col)

        # Alerta de stock bajo
        if low_stock:
            names = ', '.join(p['name'] for p in low_stock[:5])
            more = f' y {len(low_stock) - 5} mas...' if len(low_stock) > 5 else ''
            self.stock_alert_label.setText(
                f'<b>Atencion:</b> {len(low_stock)} producto(s) con stock bajo: {names}{more}'
            )
            self.stock_alert_frame.setVisible(True)
        else:
            self.stock_alert_frame.setVisible(False)

        # Actualizar gráficos
        self._update_sales_by_hour_chart(start_date, end_date)
        self._update_top_products_chart(start_date, end_date)
        self._update_payment_comparison_chart(all_sales)

    def _update_sales_by_hour_chart(self, start_date=None, end_date=None):
        # Para el gráfico de horas, si el rango es >1 día usamos la fecha de inicio
        date_str = self.from_date.date().toString('yyyy-MM-dd')
        if self.from_date.date() != self.to_date.date():
            # Rango multi-día: mostrar ventas por día en vez de por hora
            self._update_sales_by_day_chart(start_date, end_date)
            return

        sales_by_hour = self.sale_model.get_sales_by_hour(date=date_str)
        self.sales_chart.figure.clear()
        ax = self.sales_chart.figure.add_subplot(111)

        if sales_by_hour:
            hours = [item['hour'] for item in sales_by_hour]
            amounts = [item['total'] for item in sales_by_hour]
            bars = ax.bar(hours, amounts, color='#3b82f6', alpha=0.8, width=0.6)
            ax.set_xlabel('Hora del Día', fontsize=9)
            ax.set_ylabel('Ventas ($)', fontsize=9)
            ax.set_title('Ventas por Hora (Hoy)', fontsize=11, fontweight='bold')
            ax.grid(True, alpha=0.2, axis='y')
            for bar in bars:
                h = bar.get_height()
                if h > 0:
                    ax.text(bar.get_x() + bar.get_width() / 2, h,
                            f'${h:.0f}', ha='center', va='bottom', fontsize=8)
        else:
            ax.text(0.5, 0.5, 'Sin datos para hoy',
                    ha='center', va='center', transform=ax.transAxes, fontsize=11)
            ax.set_title('Ventas por Hora', fontsize=11, fontweight='bold')

        self.sales_chart.draw()

    def _update_sales_by_day_chart(self, start_date, end_date):
        """Muestra ventas agrupadas por día para rangos multi-día"""
        query = """
            SELECT date(created_at) as day, COUNT(*) as count,
                   COALESCE(SUM(total_amount), 0) as total
            FROM sales
            WHERE created_at >= ? AND created_at <= ?
            GROUP BY day ORDER BY day
        """
        rows = self.db.execute_query(query, (start_date, end_date))
        self.sales_chart.figure.clear()
        ax = self.sales_chart.figure.add_subplot(111)

        if rows:
            days = [r['day'][5:] for r in rows]  # MM-DD
            totals = [r['total'] for r in rows]
            ax.plot(days, totals, color='#3b82f6', marker='o', linewidth=2, markersize=5)
            ax.fill_between(range(len(days)), totals, alpha=0.15, color='#3b82f6')
            ax.set_xticks(range(len(days)))
            ax.set_xticklabels(days, rotation=45, fontsize=7)
            ax.set_ylabel('Ventas ($)', fontsize=9)
            ax.set_title('Ventas por Día', fontsize=11, fontweight='bold')
            ax.grid(True, alpha=0.2)
        else:
            ax.text(0.5, 0.5, 'Sin datos en el rango',
                    ha='center', va='center', transform=ax.transAxes, fontsize=11)
            ax.set_title('Ventas por Día', fontsize=11, fontweight='bold')

        self.sales_chart.draw()

    def _update_top_products_chart(self, start_date=None, end_date=None):
        top_products = self.sale_model.get_top_selling_products(
            limit=5, start_date=start_date, end_date=end_date
        )
        self.products_chart.figure.clear()
        ax = self.products_chart.figure.add_subplot(111)

        if top_products:
            products = [
                (p['product_name'][:14] + '…' if len(p['product_name']) > 14 else p['product_name'])
                for p in top_products
            ]
            quantities = [p['total_quantity'] for p in top_products]
            colors = ['#8b5cf6', '#6d28d9', '#a78bfa', '#7c3aed', '#ddd6fe']
            bars = ax.barh(products, quantities, color=colors[:len(products)], alpha=0.85)
            ax.set_xlabel('Cantidad Vendida', fontsize=9)
            ax.set_title('Top 5 Productos', fontsize=11, fontweight='bold')
            ax.grid(True, alpha=0.2, axis='x')
            for bar in bars:
                w = bar.get_width()
                ax.text(w + 0.1, bar.get_y() + bar.get_height() / 2,
                        f'{int(w)}', ha='left', va='center', fontsize=9)
        else:
            ax.text(0.5, 0.5, 'Sin datos disponibles',
                    ha='center', va='center', transform=ax.transAxes, fontsize=11)
            ax.set_title('Top 5 Productos', fontsize=11, fontweight='bold')

        self.products_chart.draw()

    def _update_payment_comparison_chart(self, all_sales):
        self.payment_chart.figure.clear()
        ax = self.payment_chart.figure.add_subplot(111)

        if all_sales:
            cash_count = sum(1 for s in all_sales if s['payment_type'] == 'cash')
            transfer_count = len(all_sales) - cash_count
            cash_amount = sum(s['total_amount'] for s in all_sales if s['payment_type'] == 'cash')
            transfer_amount = sum(s['total_amount'] for s in all_sales if s['payment_type'] == 'transfer')

            x_pos = [0, 1]
            width = 0.35
            bars1 = ax.bar([p - width / 2 for p in x_pos], [cash_count, cash_amount],
                           width, label='Efectivo', color='#22c55e', alpha=0.85)
            bars2 = ax.bar([p + width / 2 for p in x_pos], [transfer_count, transfer_amount],
                           width, label='Virtual', color='#3b82f6', alpha=0.85)

            ax.set_ylabel('Valor', fontsize=9)
            ax.set_title('Efectivo vs Virtual', fontsize=11, fontweight='bold')
            ax.set_xticks(x_pos)
            ax.set_xticklabels(['Cantidad', 'Monto ($)'])
            ax.legend(loc='upper right', fontsize=9)
            ax.grid(True, alpha=0.2, axis='y')

            for bars in [bars1, bars2]:
                for bar in bars:
                    h = bar.get_height()
                    label = f'{int(h)}' if h < 100 else f'${h:.0f}'
                    ax.text(bar.get_x() + bar.get_width() / 2, h,
                            label, ha='center', va='bottom', fontsize=8)
        else:
            ax.text(0.5, 0.5, 'Sin datos disponibles',
                    ha='center', va='center', transform=ax.transAxes, fontsize=11)
            ax.set_title('Efectivo vs Virtual', fontsize=11, fontweight='bold')

        self.payment_chart.draw()
