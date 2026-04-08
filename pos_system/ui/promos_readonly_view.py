"""
Vista de solo lectura de promociones activas — para cajeros.
Muestra las promos desde Firebase. Sin botones de edición.
"""
from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QTableWidget,
    QTableWidgetItem, QHeaderView, QPushButton, QFrame
)
from PyQt5.QtGui import QFont, QColor
from PyQt5.QtCore import Qt, QTimer, pyqtSignal
import threading


class PromosReadOnlyView(QWidget):
    _promos_ready = pyqtSignal(list, str)  # señal thread-safe

    def __init__(self, parent=None):
        super().__init__(parent)
        from pos_system.database.db_manager import DatabaseManager
        self.db = DatabaseManager()
        self._loading = False
        self._promos_ready.connect(self._on_promos_loaded)
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 16, 20, 16)
        layout.setSpacing(10)

        # ── Encabezado ──
        header_row = QHBoxLayout()
        title = QLabel('🏷️  Promociones Activas')
        title.setFont(QFont('Segoe UI', 15, QFont.Bold))
        title.setStyleSheet('color: #1e293b;')
        header_row.addWidget(title)
        header_row.addStretch()

        self.refresh_btn = QPushButton('↻  Actualizar')
        self.refresh_btn.setMinimumHeight(36)
        self.refresh_btn.setMinimumWidth(110)
        self.refresh_btn.setFont(QFont('Segoe UI', 9, QFont.Bold))
        self.refresh_btn.setStyleSheet('''
            QPushButton {
                background: #0d6efd; color: white;
                border: none; border-radius: 6px; padding: 4px 14px;
            }
            QPushButton:hover { background: #0b5ed7; }
            QPushButton:disabled { background: #6c757d; }
        ''')
        self.refresh_btn.clicked.connect(self.refresh_data)
        header_row.addWidget(self.refresh_btn)
        layout.addLayout(header_row)

        self.status_lbl = QLabel('Cargando promociones...')
        self.status_lbl.setFont(QFont('Segoe UI', 9))
        self.status_lbl.setStyleSheet('color: #6c757d;')
        layout.addWidget(self.status_lbl)

        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet('color: #e2e8f0;')
        layout.addWidget(sep)

        # ── Tabla única ──
        self.table = QTableWidget()
        self.table.setColumnCount(5)
        self.table.setHorizontalHeaderLabels(['Nombre', 'Descuento', 'Tipo', 'Cant. mínima', 'Productos'])
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setAlternatingRowColors(True)
        hh = self.table.horizontalHeader()
        hh.setSectionResizeMode(0, QHeaderView.Stretch)
        hh.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(2, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(3, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(4, QHeaderView.Stretch)
        self.table.setStyleSheet('''
            QTableWidget { border: 1.5px solid #e2e8f0; border-radius: 6px; }
            QTableWidget::item { padding: 6px; }
            QHeaderView::section {
                background: #f1f5f9; font-weight: bold; font-size: 10px;
                padding: 8px; border: none; border-bottom: 1.5px solid #cbd5e1;
            }
        ''')
        layout.addWidget(self.table, 1)

        # Cargar con delay para asegurar que la ventana esté lista
        QTimer.singleShot(1500, self.refresh_data)

    def refresh_data(self):
        if self._loading:
            return
        self._loading = True
        self.refresh_btn.setEnabled(False)
        self.refresh_btn.setText('Cargando...')
        self.status_lbl.setText('Conectando con Firebase...')
        threading.Thread(target=self._fetch_promos, daemon=True).start()

    def _fetch_promos(self):
        promos = []
        error = None
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync, init_firebase_sync
            fb = get_firebase_sync()
            if not fb or not fb.enabled:
                fb = init_firebase_sync()
            if fb and fb.enabled:
                promos = fb.download_promociones()
            else:
                error = 'Firebase no disponible'
        except Exception as e:
            error = str(e)
        self._promos_ready.emit(promos, error or '')

    def _on_promos_loaded(self, promos: list, error: str):
        self._loading = False
        self.refresh_btn.setEnabled(True)
        self.refresh_btn.setText('↻  Actualizar')

        if error:
            self.status_lbl.setText(f'⚠️  {error}')
            self.status_lbl.setStyleSheet('color: #dc3545;')
            return

        # Filtrar solo activas explícitamente
        activas = [p for p in promos if p.get('activo') is True]

        n = len(activas)
        self.status_lbl.setText(f'✅  {n} promoción{"es" if n != 1 else ""} activa{"s" if n != 1 else ""} — consultá con los clientes')
        self.status_lbl.setStyleSheet('color: #198754;')

        self.table.setRowCount(0)
        if not activas:
            self.table.setRowCount(1)
            self.table.setSpan(0, 0, 1, 5)
            item = QTableWidgetItem('No hay promociones activas en este momento')
            item.setForeground(QColor('#6c757d'))
            item.setTextAlignment(Qt.AlignCenter)
            item.setFont(QFont('Segoe UI', 10))
            self.table.setItem(0, 0, item)
            return

        self.table.setRowCount(len(activas))
        for row, p in enumerate(activas):
            self.table.setRowHeight(row, 42)

            # Col 0: Nombre
            nombre = p.get('nombre') or p.get('name') or ''
            name_item = QTableWidgetItem(nombre)
            name_item.setFont(QFont('Segoe UI', 10, QFont.Bold))
            name_item.setForeground(QColor('#1e293b'))
            self.table.setItem(row, 0, name_item)

            # Col 1: Descuento (valor legible)
            tipo_raw = p.get('tipo') or p.get('type') or ''
            dval = float(p.get('valor') or p.get('descuento') or p.get('discount_value') or 0)
            cant_req = int(p.get('cantidad_requerida') or 1)
            cant_paga = int(p.get('cantidad_paga') or 1)
            if tipo_raw in ('porcentaje', 'percentage'):
                desc_txt = f'{dval:.0f}% off'
            elif tipo_raw in ('fijo', 'fixed'):
                desc_txt = f'-${dval:,.0f}'
            elif tipo_raw == '2x1':
                desc_txt = '2x1'
            elif tipo_raw == 'nxm':
                desc_txt = f'Lleva {cant_req}, paga {cant_paga}'
            elif dval > 0:
                desc_txt = f'{dval:.0f}% off'
            else:
                desc_txt = 'Especial'
            desc_item = QTableWidgetItem(desc_txt)
            desc_item.setFont(QFont('Segoe UI', 11, QFont.Bold))
            desc_item.setForeground(QColor('#dc3545'))
            desc_item.setTextAlignment(Qt.AlignCenter)
            self.table.setItem(row, 1, desc_item)

            # Col 2: Tipo
            tipo_map = {
                'porcentaje': '% Descuento', 'percentage': '% Descuento',
                'fijo': 'Monto fijo', 'fixed': 'Monto fijo',
                '2x1': '2x1', 'nxm': 'NxM', 'bundle': 'Pack',
            }
            tipo_txt = tipo_map.get(tipo_raw, tipo_raw or 'Especial')
            tipo_item = QTableWidgetItem(tipo_txt)
            tipo_item.setTextAlignment(Qt.AlignCenter)
            self.table.setItem(row, 2, tipo_item)

            # Col 3: Cantidad mínima
            cant_min = int(p.get('cantidad_minima') or p.get('min_quantity') or 1)
            cant_item = QTableWidgetItem(str(cant_min))
            cant_item.setTextAlignment(Qt.AlignCenter)
            self.table.setItem(row, 3, cant_item)

            # Col 4: Productos (resuelve códigos a nombres)
            productos = p.get('productos') or p.get('products') or []
            if isinstance(productos, str):
                productos = [productos]
            prods_txt = self._resolve_product_names(productos)
            self.table.setItem(row, 4, QTableWidgetItem(prods_txt))

    def _resolve_product_names(self, productos: list) -> str:
        if not productos:
            return 'Todos los productos'
        nombres = []
        for ref in productos[:5]:
            ref_str = str(ref).strip()
            if not ref_str:
                continue
            found = None
            try:
                rows = self.db.execute_query(
                    "SELECT name FROM products WHERE barcode = ? OR CAST(id AS TEXT) = ? OR UPPER(name) = UPPER(?) LIMIT 1",
                    (ref_str, ref_str, ref_str)
                )
                if rows:
                    found = rows[0]['name']
            except Exception:
                pass
            nombres.append(found if found else ref_str)
        result = ', '.join(nombres)
        if len(productos) > 5:
            result += f' (+{len(productos)-5} más)'
        return result
