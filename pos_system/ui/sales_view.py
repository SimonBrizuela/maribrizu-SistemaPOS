from PyQt5.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QTableWidget,
                             QTableWidgetItem, QPushButton, QLineEdit, QLabel,
                             QComboBox, QMessageBox, QSpinBox, QDoubleSpinBox,
                             QDialog, QFormLayout, QSplitter, QFrame, QGridLayout,
                             QSizePolicy, QListWidget, QListWidgetItem, QAbstractItemView,
                             QHeaderView, QApplication, QScrollArea, QInputDialog,
                             QTextEdit, QDialogButtonBox)
from PyQt5.QtCore import Qt, QSize, QTimer, pyqtSignal, QThread
from PyQt5.QtGui import QFont, QColor, QKeySequence, QIntValidator, QValidator
from datetime import datetime
import os
import subprocess
import platform

from pos_system.models.product import Product
from pos_system.models.sale import Sale
from pos_system.models.cash_register import CashRegister
from pos_system.models.promotion import Promotion
from pos_system.utils.pdf_generator import PDFGenerator
from pos_system.ui.conjunto_dialog import ConjuntoDialog, UNIDADES as _CONJ_UNIDADES, TIPOS as _CONJ_TIPOS


def _fmt_qty(q):
    """Formatea una cantidad eliminando ceros finales: 1.0 -> '1', 0.3 -> '0.3', 2.55 -> '2.55'."""
    q = float(q or 0)
    if q == int(q):
        return str(int(q))
    return f"{q:.2f}".rstrip('0').rstrip('.')


class CartQuantitySpinBox(QDoubleSpinBox):
    """Cantidad del carrito aceptando coma o punto como separador decimal.

    Ambos separadores se interpretan igual (formato AR y EN):
      - '2'    → 2 unidades
      - '1.5'  → 1.5 unidades
      - '1,5'  → 1.5 unidades (equivalente a '1.5')
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setKeyboardTracking(True)
        self.setFocusPolicy(Qt.WheelFocus)
        self.setDecimals(3)
        self.setSingleStep(1.0)

    def wheelEvent(self, event):
        super().wheelEvent(event)

    def _parse(self, text):
        """Parsea texto a float. Devuelve None si es intermedio/inválido."""
        t = (text or '').strip()
        if not t or t in ('.', ','):
            return None
        try:
            return float(t.replace(',', '.'))
        except ValueError:
            return None

    def validate(self, text, pos):
        t = (text or '').strip()
        if not t:
            return (QValidator.Intermediate, text, pos)
        # Sólo dígitos + un único separador ',' o '.'
        allowed = set('0123456789.,')
        if not all(ch in allowed for ch in t):
            return (QValidator.Invalid, text, pos)
        if t.count(',') > 1 or t.count('.') > 1 or (',' in t and '.' in t):
            return (QValidator.Invalid, text, pos)
        if t in ('.', ','):
            return (QValidator.Intermediate, text, pos)
        val = self._parse(t)
        if val is None:
            return (QValidator.Intermediate, text, pos)
        if val < self.minimum() - 1e-9 or val > self.maximum() + 1e-9:
            return (QValidator.Invalid, text, pos)
        return (QValidator.Acceptable, text, pos)

    def valueFromText(self, text):
        val = self._parse(text)
        return val if val is not None else 0.0

    def textFromValue(self, value):
        # Normalizado: enteros sin decimales, fracciones con punto.
        if value == int(value):
            return str(int(value))
        s = f"{value:.{self.decimals()}f}".rstrip('0').rstrip('.')
        return s


class BarcodeScanner(QLineEdit):
    """
    Campo de entrada que detecta automáticamente escaneos de código de barras.
    Un escáner envía caracteres muy rápido (< 50ms entre teclas) y termina con Enter.
    Si la entrada es lenta (tipeo manual) se muestra en el campo de búsqueda normal.
    """
    barcode_scanned = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._scan_buffer = ""
        self._last_key_time = 0
        self._scan_timer = QTimer()
        self._scan_timer.setSingleShot(True)
        self._scan_timer.timeout.connect(self._flush_buffer)
        # Umbral: escáneres reales tipean a ~5-15ms entre chars; humanos rápidos a >40ms.
        # Threshold conservador: 30ms — solo desvía al buffer entradas extremadamente rápidas.
        self._threshold_ms = 30

    def keyPressEvent(self, event):
        import time
        now = int(time.time() * 1000)
        elapsed = now - self._last_key_time
        self._last_key_time = now

        key = event.key()
        modifiers = event.modifiers()

        # Ctrl+V (pegar): pasar directo al campo normal, sin pasar por el buffer del scanner
        if modifiers == Qt.ControlModifier and key == Qt.Key_V:
            if self._scan_buffer:
                self._scan_buffer = ""
                self._scan_timer.stop()
            super().keyPressEvent(event)
            return

        # Ctrl+A, Ctrl+C, Ctrl+X, teclas de navegación, Delete, Backspace → directo al campo
        if modifiers == Qt.ControlModifier or key in (
            Qt.Key_Backspace, Qt.Key_Delete, Qt.Key_Left, Qt.Key_Right,
            Qt.Key_Home, Qt.Key_End, Qt.Key_Tab
        ):
            if self._scan_buffer:
                self._scan_buffer = ""
                self._scan_timer.stop()
            super().keyPressEvent(event)
            return

        if key == Qt.Key_Return or key == Qt.Key_Enter:
            if self._scan_buffer:
                code = self._scan_buffer.strip()
                self._scan_buffer = ""
                self._scan_timer.stop()
                if len(code) >= 3:
                    self.barcode_scanned.emit(code)
                return
            else:
                # Enter con tipeo manual — pasar al padre (búsqueda normal)
                super().keyPressEvent(event)
                return

        char = event.text()
        if not char:
            super().keyPressEvent(event)
            return

        # Los códigos de barras nunca tienen espacios → espacio es siempre tipeo manual
        if char == ' ':
            if self._scan_buffer:
                self._scan_buffer = ""
                self._scan_timer.stop()
            super().keyPressEvent(event)
            return

        if elapsed < self._threshold_ms:
            # Entrada rápida → acumular en buffer de escáner
            self._scan_buffer += char
            self._scan_timer.start(200)
        else:
            # Tipeo manual → limpiar buffer y pasar al campo
            if self._scan_buffer:
                self._scan_buffer = ""
                self._scan_timer.stop()
            super().keyPressEvent(event)

    def _flush_buffer(self):
        """Si el buffer no terminó en Enter dentro del tiempo, pasa al campo normal."""
        if self._scan_buffer:
            text = self._scan_buffer
            self._scan_buffer = ""
            # Solo pasar al campo si parece tipeo manual (texto corto o con espacios)
            self.setText(self.text() + text)


class ProductSearchDialog(QDialog):
    """Diálogo ampliado para buscar y seleccionar productos con fuente grande."""
    product_selected = pyqtSignal(dict)
    cart_total_changed = pyqtSignal(float)

    def __init__(self, parent=None, db=None, initial_text='', rubro=None, subcategory=None, cart=None):
        super().__init__(parent)
        self.db = db
        self._rubro = rubro
        self._subcategory = subcategory
        self._cart = cart or []
        title = 'Buscar Producto'
        if subcategory:
            title += f'  —  {rubro} > {subcategory}'
        elif rubro:
            title += f'  —  {rubro}'
        self.setWindowTitle(title)
        self.setWindowFlags(Qt.Window | Qt.WindowCloseButtonHint | Qt.WindowMaximizeButtonHint)
        from PyQt5.QtWidgets import QDesktopWidget
        screen = QDesktopWidget().availableGeometry()
        w = int(screen.width() * 0.90)
        h = int(screen.height() * 0.88)
        self.setMinimumSize(min(860, w), min(520, h))
        self.resize(w, h)
        self.move(screen.x() + (screen.width() - w) // 2, screen.y() + (screen.height() - h) // 2)
        self._init_ui(initial_text)

    def _init_ui(self, initial_text=''):
        self._search_timer = QTimer(self)
        self._search_timer.setSingleShot(True)
        self._search_timer.setInterval(180)
        self._search_timer.timeout.connect(self._do_search)
        self._pending_text = ''

        # Timer para auto-limpiar filtro si no hay resultados con rubro activo
        self._auto_clear_filter_timer = QTimer(self)
        self._auto_clear_filter_timer.setSingleShot(True)
        self._auto_clear_filter_timer.setInterval(2000)  # 2 segundos
        self._auto_clear_filter_timer.timeout.connect(self._auto_clear_filter)

        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        root.setSpacing(8)

        # ── Barra superior: búsqueda + filtro ──
        search_row = QHBoxLayout()
        search_row.setSpacing(8)

        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText('Buscar por nombre o código...')
        self.search_input.setFont(QFont('Segoe UI', 13))
        self.search_input.setMinimumHeight(42)
        self.search_input.setStyleSheet('''
            QLineEdit {
                border: 2px solid #c1521f;
                border-radius: 8px;
                padding: 6px 14px;
                background: white;
                font-size: 13px;
            }
        ''')
        self.search_input.textChanged.connect(self._on_search)
        self.search_input.returnPressed.connect(self._select_first)
        search_row.addWidget(self.search_input, 1)

        clear_btn = QPushButton('Limpiar')
        clear_btn.setMinimumHeight(42)
        clear_btn.setFont(QFont('Segoe UI', 10))
        clear_btn.setStyleSheet('QPushButton { background:#fafaf7; color:#1c1c1e; border:1.5px solid #dcd6c8; border-radius:8px; padding:0 12px; } QPushButton:hover { background:#dcd6c8; }')
        clear_btn.clicked.connect(lambda: self.search_input.clear())
        search_row.addWidget(clear_btn)
        root.addLayout(search_row)

        # Filtro activo
        from PyQt5.QtWidgets import QWidget as _W
        self._filter_bar = _W()
        fb = QHBoxLayout(self._filter_bar)
        fb.setContentsMargins(0, 0, 0, 0)
        filtro_txt = 'Filtrando: '
        if self._subcategory:
            filtro_txt += f'{self._rubro} > {self._subcategory}'
        elif self._rubro:
            filtro_txt += self._rubro
        self._filter_lbl = QLabel(filtro_txt)
        self._filter_lbl.setFont(QFont('Segoe UI', 10, QFont.Bold))
        self._filter_lbl.setStyleSheet('color:#c1521f; background:#fbeee5; border:1px solid #c1521f; border-radius:5px; padding:3px 8px;')
        fb.addWidget(self._filter_lbl)
        cf_btn = QPushButton('x  Todos los productos')
        cf_btn.setFont(QFont('Segoe UI', 10))
        cf_btn.setStyleSheet('QPushButton { background:#fafaf7; color:#1c1c1e; border:1.5px solid #dcd6c8; border-radius:5px; padding:3px 10px; } QPushButton:hover { background:#dcd6c8; }')
        cf_btn.clicked.connect(self._clear_filter)
        fb.addWidget(cf_btn)
        fb.addStretch()
        root.addWidget(self._filter_bar)
        self._filter_bar.setVisible(bool(self._subcategory or self._rubro))

        # Contador
        self.result_count_lbl = QLabel('')
        self.result_count_lbl.setFont(QFont('Segoe UI', 9))
        self.result_count_lbl.setStyleSheet('color:#6f6a5d;')
        root.addWidget(self.result_count_lbl)

        # ── Splitter: tabla búsqueda | panel carrito ──
        from PyQt5.QtWidgets import QSplitter
        splitter = QSplitter(Qt.Horizontal)
        splitter.setHandleWidth(6)
        splitter.setStyleSheet('QSplitter::handle { background: #dcd6c8; border-radius: 3px; }')

        # Tabla de resultados
        self.table = QTableWidget()
        self.table.setColumnCount(4)
        self.table.setHorizontalHeaderLabels(['Producto', 'Código', 'Precio', 'Stock'])
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        self.table.setFont(QFont('Segoe UI', 12))
        self.table.horizontalHeader().setFont(QFont('Segoe UI', 11, QFont.Bold))
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeToContents)
        self.table.setStyleSheet('''
            QTableWidget { border: 1.5px solid #dcd6c8; border-radius: 8px; gridline-color: #fafaf7; }
            QTableWidget::item { padding: 6px; }
            QTableWidget::item:selected { background: #c1521f; color: white; }
            QHeaderView::section { background: #fafaf7; padding: 6px; border: none; border-bottom: 2px solid #dcd6c8; font-weight: bold; }
        ''')
        self.table.verticalHeader().setDefaultSectionSize(38)
        self.table.doubleClicked.connect(self._on_double_click)
        self.table.keyPressEvent = self._table_key_press
        splitter.addWidget(self.table)

        # Panel derecho: carrito
        cart_panel = QWidget()
        cart_panel.setMinimumWidth(230)
        cart_panel.setMaximumWidth(380)
        cart_panel.setStyleSheet('QWidget { background: #fafaf7; border-radius: 10px; }')
        cp = QVBoxLayout(cart_panel)
        cp.setContentsMargins(10, 10, 10, 10)
        cp.setSpacing(6)

        cart_title = QLabel('Carrito actual')
        cart_title.setFont(QFont('Segoe UI', 11, QFont.Bold))
        cart_title.setStyleSheet('color: #1c1c1e; background: transparent; border: none;')
        cp.addWidget(cart_title)

        self.cart_list = QTableWidget()
        self.cart_list.setColumnCount(2)
        self.cart_list.setHorizontalHeaderLabels(['Producto', 'Cant. / Total'])
        self.cart_list.verticalHeader().setVisible(False)
        self.cart_list.setEditTriggers(QTableWidget.NoEditTriggers)
        self.cart_list.setSelectionMode(QTableWidget.NoSelection)
        self.cart_list.setFocusPolicy(Qt.NoFocus)
        self.cart_list.setFont(QFont('Segoe UI', 10))
        self.cart_list.horizontalHeader().setFont(QFont('Segoe UI', 10, QFont.Bold))
        self.cart_list.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.cart_list.horizontalHeader().setSectionResizeMode(1, QHeaderView.Fixed)
        self.cart_list.setColumnWidth(1, 88)
        self.cart_list.setAlternatingRowColors(True)
        self.cart_list.verticalHeader().setDefaultSectionSize(30)
        self.cart_list.setStyleSheet('''
            QTableWidget { border: 1px solid #dcd6c8; border-radius: 6px; gridline-color: #fafaf7; background: white; }
            QTableWidget::item { padding: 3px 5px; }
            QHeaderView::section { background: #fafaf7; padding: 4px; border: none; border-bottom: 1.5px solid #dcd6c8; font-size: 10px; }
        ''')
        cp.addWidget(self.cart_list, 1)

        # Total en el panel derecho
        total_frame = QFrame()
        total_frame.setStyleSheet('QFrame { background: #1c1c1e; border-radius: 8px; border: none; }')
        tl = QHBoxLayout(total_frame)
        tl.setContentsMargins(12, 10, 12, 10)
        tl.setSpacing(8)
        total_lbl = QLabel('TOTAL')
        total_lbl.setFont(QFont('Segoe UI', 10, QFont.Bold))
        total_lbl.setStyleSheet('color:#9b958a; background:transparent; border:none;')
        tl.addWidget(total_lbl)
        self.dialog_total_amount = QLabel('$0.00')
        self.dialog_total_amount.setFont(QFont('Segoe UI', 18, QFont.Bold))
        self.dialog_total_amount.setStyleSheet('color:#3d7a3a; background:transparent; border:none;')
        self.dialog_total_amount.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        self.dialog_total_amount.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        tl.addWidget(self.dialog_total_amount)
        cp.addWidget(total_frame)

        hint = QLabel('Enter o doble click para agregar')
        hint.setFont(QFont('Segoe UI', 9))
        hint.setStyleSheet('color:#9b958a; background:transparent; border:none;')
        hint.setAlignment(Qt.AlignCenter)
        cp.addWidget(hint)

        splitter.addWidget(cart_panel)

        # Proporciones: 68% búsqueda, 32% carrito
        splitter.setStretchFactor(0, 68)
        splitter.setStretchFactor(1, 32)
        root.addWidget(splitter, 1)

        # Poblar carrito inicial
        self.update_cart_display(self._cart)

        # Cargar resultados
        if initial_text:
            self.search_input.setText(initial_text)
        elif self._rubro or self._subcategory:
            self._do_search()
        else:
            self._show_hint()

        self.search_input.setFocus()
        # Diferir deselección al siguiente ciclo del event loop (setFocus selecciona después)
        QTimer.singleShot(0, lambda: (
            self.search_input.deselect(),
            self.search_input.setCursorPosition(len(self.search_input.text()))
        ))

    def update_cart_display(self, cart_items):
        """Actualiza la tabla del carrito en el panel derecho."""
        self._cart = cart_items
        self.cart_list.setRowCount(len(cart_items))
        total = 0.0
        for row, item in enumerate(cart_items):
            name = str(item.get('product_name') or item.get('name', ''))
            qty = item.get('quantity', 1)
            subtotal = float(item.get('subtotal', 0))
            total += subtotal

            name_item = QTableWidgetItem(name)
            name_item.setToolTip(name)
            self.cart_list.setItem(row, 0, name_item)

            # Columna combinada: "x2  $500"
            detail_item = QTableWidgetItem(f'x{_fmt_qty(qty)}  ${subtotal:,.0f}')
            detail_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            detail_item.setForeground(QColor('#c1521f'))
            self.cart_list.setItem(row, 1, detail_item)

        if cart_items:
            self.cart_list.scrollToBottom()

        total_str = f'${total:,.2f}'
        font_size = 18 if len(total_str) <= 10 else (15 if len(total_str) <= 13 else 12)
        self.dialog_total_amount.setFont(QFont('Segoe UI', font_size, QFont.Bold))
        self.dialog_total_amount.setText(total_str)

    def _clear_filter(self):
        """Quita el filtro de rubro/subcategoría y busca en todos los productos."""
        self._auto_clear_filter_timer.stop()
        self._rubro = None
        self._subcategory = None
        self._filter_bar.setVisible(False)
        self.setWindowTitle('Buscar Producto')
        text = self.search_input.text().strip()
        if text:
            self._pending_text = text
            self._do_search()
        else:
            self._show_hint()

    def _auto_clear_filter(self):
        """Limpia el filtro automáticamente cuando no hay resultados en el rubro actual."""
        self._clear_filter()

    def _show_hint(self):
        self.table.setRowCount(1)
        self.table.setSpan(0, 0, 1, 4)
        item = QTableWidgetItem('Escribí para buscar productos...')
        item.setTextAlignment(Qt.AlignCenter)
        item.setForeground(QColor('#9b958a'))
        item.setFont(QFont('Segoe UI', 13))
        self.table.setItem(0, 0, item)
        self.result_count_lbl.setText('')

    def _on_search(self, text):
        """Dispara el debounce — la búsqueda real ocurre 300ms después de dejar de escribir."""
        self._pending_text = text.strip()
        if not self._pending_text:
            self._search_timer.stop()
            self._show_hint()
            return
        self._search_timer.start()  # reinicia el timer en cada tecla

    def _do_search(self):
        """Ejecuta la búsqueda real después del debounce."""
        text = self._pending_text
        try:
            clauses, params = [], []

            # Filtro por rubro/subcategoría si están seleccionados
            if self._subcategory:
                clauses.append("UPPER(category) = ?")
                params.append(self._subcategory.upper())
            elif self._rubro:
                clauses.append("UPPER(rubro) = ?")
                params.append(self._rubro.upper())

            # Filtro por texto si hay algo escrito
            if text:
                words = [w for w in text.split() if w]
                for w in words:
                    pat = f'%{w.upper()}%'
                    clauses.append("(UPPER(name) LIKE ? OR UPPER(barcode) LIKE ? OR UPPER(firebase_id) LIKE ?)")
                    params.extend([pat, pat, pat])

            if not clauses:
                self._show_hint()
                return

            where = ' AND '.join(clauses)
            query = f"SELECT * FROM products WHERE {where} ORDER BY is_favorite DESC, name ASC LIMIT 100"
            results = self.db.execute_query(query, tuple(params))
        except Exception:
            results = []

        self.table.clearSpans()
        self.table.setRowCount(0)  # limpiar primero para evitar flickering
        self.table.setRowCount(len(results))
        for row, p in enumerate(results):
            name_item = QTableWidgetItem(str(p.get('name', '')))
            name_item.setData(Qt.UserRole, p)  # guardar datos en el item de nombre
            self.table.setItem(row, 0, name_item)
            self.table.setItem(row, 1, QTableWidgetItem(str(p.get('barcode', '') or '')))
            price_item = QTableWidgetItem(f"${float(p.get('price', 0)):,.2f}")
            price_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            self.table.setItem(row, 2, price_item)
            stock = p.get('stock', 0)
            stock_item = QTableWidgetItem(str(stock if stock is not None else 0))
            stock_item.setTextAlignment(Qt.AlignCenter)
            if stock is not None and stock <= 0:
                stock_item.setForeground(QColor('#a01616'))
            self.table.setItem(row, 3, stock_item)

        n = len(results)
        self.result_count_lbl.setText(f'{n} resultado{"s" if n != 1 else ""} encontrado{"s" if n != 1 else ""}')
        if n > 0:
            self.table.selectRow(0)

        # Si hay filtro activo y 0 resultados con texto escrito → auto-limpiar en 2s
        has_filter = bool(self._rubro or self._subcategory)
        has_text   = bool(self._pending_text)
        if has_filter and has_text and n == 0:
            self.result_count_lbl.setText('0 resultados en este rubro — buscando en todos...')
            self._auto_clear_filter_timer.start()
        else:
            self._auto_clear_filter_timer.stop()

    def _select_first(self):
        if self.table.rowCount() > 0 and self.table.item(0, 0):
            p = self.table.item(0, 0).data(Qt.UserRole)
            if p:
                self.product_selected.emit(p)

    def _on_double_click(self, index):
        row = index.row()
        item = self.table.item(row, 0)
        if item:
            p = item.data(Qt.UserRole)
            if p:
                self.product_selected.emit(p)

    def _on_select(self):
        row = self.table.currentRow()
        if row >= 0:
            item = self.table.item(row, 0)
            if item:
                p = item.data(Qt.UserRole)
                if p:
                    self.product_selected.emit(p)

    def _table_key_press(self, event):
        if event.key() in (Qt.Key_Return, Qt.Key_Enter):
            self._on_select()
        else:
            QTableWidget.keyPressEvent(self.table, event)


class SalesView(QWidget):
    # Señal emitida desde hilo de Firebase para refrescar UI en el hilo principal
    inventory_updated = pyqtSignal()

    def __init__(self, parent=None, current_user: dict = None):
        super().__init__(parent)
        from pos_system.database.db_manager import DatabaseManager
        self.db = DatabaseManager()
        self.product_model = Product(self.db)
        self.sale_model = Sale(self.db)
        self.cash_register_model = CashRegister(self.db)
        self.promo_model = Promotion(self.db)
        self.pdf_generator = PDFGenerator()
        self.pdf_generator.set_company_info(
            name    = 'Librería Liceo',
            address = 'Av. Alfonsina Storni 168',
            phone   = 'Tel: 351 704-6684',
            email   = '',
            website = ''
        )
        self.current_user = current_user or {}
        self.cart = []
        self._all_products = []          # cache local de productos
        # Cache de promociones de Firebase (actualizadas en tiempo real)
        self._firebase_promos = []
        # Historial de búsquedas (expira 4 min): lista de (termino, timestamp)
        self._search_history = []
        self._history_popup = None
        self.init_ui()
        self._start_firebase_listener()
        self.inventory_updated.connect(self.refresh_data)
    
    def get_main_window(self):
        """Obtiene la ventana principal"""
        widget = self
        while widget:
            if hasattr(widget, 'refresh_all_views'):
                return widget
            widget = widget.parent()
        return None

    def _start_firebase_listener(self):
        """Carga inicial desde Firebase (lectura única) y programa refresh cada 5 minutos.
        NO usa onSnapshot para evitar millones de lecturas facturables."""
        import threading as _th
        import logging as _log
        _th.Thread(target=self._firebase_full_sync, daemon=True).start()

        # Refrescar cada 2 horas en vez de escuchar en tiempo real
        self._firebase_sync_timer = QTimer(self)
        self._firebase_sync_timer.setInterval(2 * 60 * 60 * 1000)  # 2 horas
        self._firebase_sync_timer.timeout.connect(
            lambda: _th.Thread(target=self._firebase_full_sync, daemon=True).start()
        )
        self._firebase_sync_timer.start()

    def _firebase_full_sync(self):
        """Lectura única de Firebase: promos, rubros, inventario y productos remotos."""
        import logging as _log
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync, init_firebase_sync
            fb = get_firebase_sync()
            if not fb or not fb.enabled:
                fb = init_firebase_sync()
            if not fb or not fb.enabled:
                return

            # 1. Promociones
            try:
                promos = fb.download_promociones()
                self._firebase_promos = promos
                _log.getLogger(__name__).info(f"Firebase sync: {len(promos)} promos cargadas")
            except Exception as e:
                _log.getLogger(__name__).warning(f"Error sync promos: {e}")

            # 2. Rubros
            try:
                rubros = fb.download_rubros()
                if rubros:
                    QTimer.singleShot(0, lambda r=rubros: self._on_firebase_rubros_change(r))
            except Exception as e:
                _log.getLogger(__name__).warning(f"Error sync rubros: {e}")

            # 3. Solo precios actualizados (mucho menos lecturas que download_products completo)
            try:
                precios = fb.download_precios_actualizados()
                if precios:
                    QTimer.singleShot(0, lambda p=precios: self._on_firebase_inventory_change(p))
            except Exception as e:
                _log.getLogger(__name__).warning(f"Error sync precios: {e}")

        except Exception as e:
            _log.getLogger(__name__).debug(f"Firebase sync no disponible: {e}")

    def _on_firebase_rubros_change(self, rubros: list):
        """Callback cuando Firebase actualiza los rubros — sincroniza a la BD y recarga botones."""
        try:
            self.db.sync_rubros_from_firebase(rubros)
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(f"Error sincronizando rubros Firebase: {e}")
        QTimer.singleShot(0, self._load_rubro_buttons)

    def _on_firebase_inventory_change(self, products: list):
        """Callback de Firebase — se llama desde hilo de red; emite señal al hilo principal."""
        import logging
        log = logging.getLogger(__name__)
        try:
            for p in products:
                pid  = p.get('id') or p.get('product_id')
                nombre = str(p.get('nombre') or p.get('name') or '').strip()
                new_stock = p.get('stock')
                new_price = p.get('precio') or p.get('price')

                if new_stock is None and new_price is None:
                    continue  # No hay datos útiles

                local = None
                # 1. Buscar por ID numérico (más confiable)
                if pid:
                    try:
                        local = self.product_model.get_by_id(int(pid))
                    except Exception:
                        pass
                # 2. Fallback: buscar por nombre exacto
                if not local and nombre:
                    results = self.db.execute_query(
                        "SELECT * FROM products WHERE UPPER(name) = UPPER(?) LIMIT 1",
                        (nombre,)
                    )
                    local = results[0] if results else None

                if not local:
                    continue

                update_kwargs = {}
                if new_stock is not None and int(new_stock) != local.get('stock', 0):
                    update_kwargs['stock'] = int(new_stock)
                if new_price is not None and abs(float(new_price) - local.get('price', 0)) > 0.001:
                    update_kwargs['price'] = float(new_price)

                # También actualizar barcode si lo trae Firebase y el local no lo tiene
                fb_barcode = str(p.get('barcode') or p.get('codigo') or p.get('cod_barra') or '').strip()
                if fb_barcode and not local.get('barcode'):
                    update_kwargs['barcode'] = fb_barcode

                if update_kwargs:
                    self.product_model.update(local['id'], **update_kwargs)
                    log.info(f"Firebase: actualizado '{local['name']}' → {update_kwargs}")

        except Exception as e:
            import logging as _l
            _l.getLogger(__name__).warning(f"Error aplicando cambios de inventario Firebase: {e}")
        # Refrescar UI en el hilo principal
        self.inventory_updated.emit()

    def _on_firebase_promos_change(self, promociones: list):
        """Callback cuando Firebase actualiza las promociones — actualiza el cache local."""
        self._firebase_promos = promociones
        import logging
        logging.getLogger(__name__).info(f"Firebase: cache de promociones actualizado ({len(promociones)} promos).")

    def _on_remote_product_change(self, action: str, product_data: dict):
        """Callback cuando la web crea/modifica un producto en 'productos_remotos'."""
        try:
            nombre = product_data.get('nombre') or product_data.get('name', '')
            precio = float(product_data.get('precio') or product_data.get('price') or 0)
            stock = int(product_data.get('stock') or 0)
            categoria = product_data.get('categoria') or product_data.get('category') or ''
            barcode = str(product_data.get('barcode') or product_data.get('codigo') or '')
            if not nombre or precio <= 0:
                return
            if action in ('added', 'modified'):
                existing = self.product_model.get_by_barcode(barcode) if barcode else None
                if existing:
                    self.product_model.update(existing['id'], price=precio, stock=stock, category=categoria)
                else:
                    # Solo crear si no existe por nombre
                    results = self.product_model.get_all(search=nombre)
                    if not results:
                        self.product_model.create({
                            'name': nombre, 'price': precio, 'stock': stock,
                            'category': categoria, 'barcode': barcode,
                        })
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(f"Error aplicando producto remoto: {e}")
        self.inventory_updated.emit()

    def open_pdf(self, pdf_path):
        """Abre un PDF con el visor predeterminado del sistema"""
        try:
            if platform.system() == 'Windows':
                os.startfile(pdf_path)
            elif platform.system() == 'Darwin':
                subprocess.run(['open', pdf_path])
            else:
                subprocess.run(['xdg-open', pdf_path])
            return True
        except Exception as e:
            print(f"Error abriendo PDF: {e}")
            return False

    def select_payment_type(self, payment_type):
        pass

    def get_payment_type(self):
        return 'cash'

    def _update_change(self):
        pass
        
    def init_ui(self):
        from pos_system.ui.theme import COLORS as _T
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(10)

        # ────────────────────────────────────────────────────────────────
        # ── Header: search bar + botón Agregar (estilo mockup) ─────────
        # ────────────────────────────────────────────────────────────────
        top = QFrame()
        top.setStyleSheet(
            f"QFrame {{ background:{_T['surface']}; border:1px solid {_T['border']};"
            f" border-radius:8px; }}"
        )
        h_top = QHBoxLayout(top)
        h_top.setContentsMargins(12, 10, 12, 10)
        h_top.setSpacing(8)

        self.barcode_field = BarcodeScanner()
        self.barcode_field.setPlaceholderText('Código de barras o nombre…')
        self.barcode_field.setFont(QFont('Segoe UI', 11))
        self.barcode_field.setMinimumHeight(38)
        self.barcode_field.setStyleSheet(
            f"QLineEdit {{ border:1px solid {_T['border']}; background:{_T['surface_alt']};"
            f" border-radius:6px; padding:6px 12px; font-size:14px; color:{_T['text']}; }}"
            f"QLineEdit:focus {{ border-color:{_T['accent']}; background:{_T['surface']}; }}"
        )
        self.barcode_field.barcode_scanned.connect(self._on_barcode_scanned)
        self.barcode_field.textChanged.connect(self._on_search_text_changed)
        self.barcode_field.returnPressed.connect(self.search_product)
        self.barcode_field.installEventFilter(self)
        h_top.addWidget(self.barcode_field, 1)

        # Indicador inline (escáner, errores)
        self.sync_indicator = QLabel('')
        self.sync_indicator.setStyleSheet(
            f"color:{_T['success']}; background:{_T['success_bg']};"
            f" border:1px solid {_T['success']}; border-radius:4px;"
            f" padding:2px 8px; font-weight:600; font-size:11px;"
        )
        self.sync_indicator.setVisible(False)
        h_top.addWidget(self.sync_indicator)

        agregar_btn = QPushButton('Agregar')
        agregar_btn.setMinimumHeight(38); agregar_btn.setMinimumWidth(96)
        agregar_btn.setCursor(Qt.PointingHandCursor)
        agregar_btn.setFont(QFont('Segoe UI', 11, QFont.Bold))
        agregar_btn.setStyleSheet(
            f"QPushButton {{ background:{_T['accent']}; color:white;"
            f" border:none; border-radius:6px; padding:0 16px; font-weight:700; }}"
            f"QPushButton:hover {{ background:{_T['accent_hover']}; }}"
        )
        agregar_btn.clicked.connect(self.search_product)
        h_top.addWidget(agregar_btn)

        # Botón Varios (item libre)
        varios_btn = QPushButton('Varios')
        varios_btn.setMinimumHeight(38); varios_btn.setMinimumWidth(80)
        varios_btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
        varios_btn.setCursor(Qt.PointingHandCursor)
        varios_btn.setStyleSheet(
            f"QPushButton {{ background:{_T['surface_alt']}; color:{_T['text']};"
            f" border:1px solid {_T['border']}; border-radius:6px; padding:0 14px; font-weight:600; }}"
            f"QPushButton:hover {{ background:{_T['border_soft']}; }}"
        )
        varios_btn.setToolTip('Agregar producto genérico (sin código)')
        varios_btn.clicked.connect(self._add_varios_item)
        h_top.addWidget(varios_btn)

        if (self.current_user or {}).get('role') == 'admin':
            varios2_btn = QPushButton('Varios 2')
            varios2_btn.setMinimumHeight(38); varios2_btn.setMinimumWidth(80)
            varios2_btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
            varios2_btn.setCursor(Qt.PointingHandCursor)
            varios2_btn.setStyleSheet(
                f"QPushButton {{ background:{_T['surface']}; color:{_T['accent']};"
                f" border:1px dashed {_T['accent']}; border-radius:6px; padding:0 14px; font-weight:700; }}"
                f"QPushButton:hover {{ background:{_T['accent_soft']}; }}"
            )
            varios2_btn.setToolTip('Item solo para facturar a AFIP')
            varios2_btn.clicked.connect(self._add_varios_2_item)
            h_top.addWidget(varios2_btn)

        layout.addWidget(top)

        # ────────────────────────────────────────────────────────────────
        # ── Body: izquierda carrito | derecha panel ────────────────────
        # ────────────────────────────────────────────────────────────────
        body = QHBoxLayout()
        body.setSpacing(10)

        # ── Carrito (panel principal) ──
        cart_panel = QFrame()
        cart_panel.setStyleSheet(
            f"QFrame {{ background:{_T['surface']}; border:1px solid {_T['border']};"
            f" border-radius:8px; }}"
        )
        cart_v = QVBoxLayout(cart_panel)
        cart_v.setContentsMargins(0, 0, 0, 0)
        cart_v.setSpacing(0)

        # Header carrito
        cart_hdr = QFrame()
        cart_hdr.setStyleSheet(f"QFrame {{ border-bottom:1px solid {_T['border_soft']}; background:transparent; }}")
        cart_hdr_l = QHBoxLayout(cart_hdr)
        cart_hdr_l.setContentsMargins(14, 10, 14, 10)
        cart_title = QLabel('Carrito')
        cart_title.setFont(QFont('Segoe UI', 12, QFont.Bold))
        cart_title.setStyleSheet(f"color:{_T['text']}; background:transparent; border:none;")
        cart_hdr_l.addWidget(cart_title)
        cart_hdr_l.addStretch(1)
        self.items_count_lbl = QLabel('0 items')
        self.items_count_lbl.setStyleSheet(
            f"color:{_T['text_muted']}; font-size:11px;"
            f" font-family:'JetBrains Mono', Consolas, monospace; background:transparent; border:none;"
        )
        cart_hdr_l.addWidget(self.items_count_lbl)
        cart_v.addWidget(cart_hdr)

        # Tabla del carrito (4 columnas estilo mockup)
        self.cart_table = QTableWidget()
        self.cart_table.setColumnCount(4)
        self.cart_table.setHorizontalHeaderLabels(['Producto', 'Cantidad', 'Subtotal', ''])
        self.cart_table.verticalHeader().setVisible(False)
        self.cart_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.cart_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.Fixed)
        self.cart_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.Fixed)
        self.cart_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.Fixed)
        self.cart_table.setColumnWidth(1, 130)
        self.cart_table.setColumnWidth(2, 130)
        self.cart_table.setColumnWidth(3, 78)
        self.cart_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.cart_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.cart_table.setStyleSheet(
            f"QTableWidget {{ border:none; background:{_T['surface']}; }}"
            f"QHeaderView::section {{ background:{_T['surface_alt']}; color:{_T['text_muted']};"
            f" padding:8px 12px; border:none; border-bottom:1px solid {_T['border']};"
            f" font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px; }}"
        )
        self.cart_table.cellClicked.connect(self._on_cart_cell_clicked)
        cart_v.addWidget(self.cart_table, 1)

        # Hint promo cercana
        self._promo_hint_lbl = QLabel('')
        self._promo_hint_lbl.setWordWrap(True)
        self._promo_hint_lbl.setVisible(False)
        self._promo_hint_lbl.setStyleSheet(
            f"QLabel {{ background:{_T['warning_bg']}; border:1px solid {_T['warning']};"
            f" border-radius:6px; padding:6px 10px; color:{_T['warning']}; font-size:11px; }}"
        )
        cart_v.addWidget(self._promo_hint_lbl)

        # Footer carrito: TOTAL + Cobrar
        cart_ft = QFrame()
        cart_ft.setStyleSheet(
            f"QFrame {{ background:{_T['surface_alt']}; border-top:1px solid {_T['border']};"
            f" border-bottom-left-radius:8px; border-bottom-right-radius:8px; }}"
        )
        ft_l = QHBoxLayout(cart_ft)
        ft_l.setContentsMargins(16, 14, 14, 14); ft_l.setSpacing(14)
        col = QVBoxLayout(); col.setSpacing(0); col.setContentsMargins(0, 0, 0, 0)
        total_lbl = QLabel('TOTAL')
        total_lbl.setStyleSheet(
            f"color:{_T['text_muted']}; background:transparent; border:none;"
            f" font-size:10px; font-weight:700; letter-spacing:0.6px;"
        )
        col.addWidget(total_lbl)
        self.total_amount_label = QLabel('$0.00')
        self.total_amount_label.setStyleSheet(
            f"color:{_T['text']}; background:transparent; border:none;"
            f" font-size:30px; font-weight:700;"
            f" font-family:'JetBrains Mono', Consolas, monospace;"
        )
        col.addWidget(self.total_amount_label)
        ft_l.addLayout(col, 1)
        ft_l.addStretch(1)

        clear_btn = QPushButton('Limpiar')
        clear_btn.setMinimumHeight(48); clear_btn.setMinimumWidth(100)
        clear_btn.setFont(QFont('Segoe UI', 11))
        clear_btn.setCursor(Qt.PointingHandCursor)
        clear_btn.setStyleSheet(
            f"QPushButton {{ background:{_T['surface']}; color:{_T['text_muted']};"
            f" border:1px solid {_T['border']}; border-radius:6px; font-weight:600; }}"
            f"QPushButton:hover {{ background:{_T['border_soft']}; color:{_T['text']}; }}"
        )
        clear_btn.clicked.connect(self.clear_cart)
        ft_l.addWidget(clear_btn)

        cobrar_btn = QPushButton('Cobrar\nF2')
        cobrar_btn.setMinimumHeight(56); cobrar_btn.setMinimumWidth(180)
        cobrar_btn.setFont(QFont('Segoe UI', 14, QFont.Bold))
        cobrar_btn.setCursor(Qt.PointingHandCursor)
        cobrar_btn.setStyleSheet(
            f"QPushButton {{ background:{_T['accent']}; color:white;"
            f" border:none; border-radius:8px; padding:6px 24px; font-weight:700; }}"
            f"QPushButton:hover {{ background:{_T['accent_hover']}; }}"
            f"QPushButton:disabled {{ background:#c9c2b3; color:white; }}"
        )
        cobrar_btn.clicked.connect(self.complete_sale)
        ft_l.addWidget(cobrar_btn)
        cart_v.addWidget(cart_ft)

        body.addWidget(cart_panel, 1)

        # ── Panel lateral derecho ──
        side = QWidget()
        side.setFixedWidth(252)
        side_v = QVBoxLayout(side)
        side_v.setContentsMargins(0, 0, 0, 0)
        side_v.setSpacing(10)

        # ACCIONES
        side_v.addWidget(self._build_acciones_card())
        # CAJA
        side_v.addWidget(self._build_caja_card())
        # ESTADO
        side_v.addWidget(self._build_estado_card())

        side_v.addStretch(1)
        body.addWidget(side)

        layout.addLayout(body, 1)

        # ────────────────────────────────────────────────────────────────
        # ── Widgets ocultos: products_table + categorías ──
        # Se mantienen en memoria para no romper la lógica existente
        # (refresh_data, on_search_text_changed, _filter_by_category, etc).
        # No se agregan al layout visible.
        # ────────────────────────────────────────────────────────────────
        self.products_table = QTableWidget()
        self.products_table.setColumnCount(5)
        self.products_table.setHorizontalHeaderLabels(['FAV', 'Producto', 'Codigo', 'Precio', 'Stock'])
        self.products_table.setVisible(False)
        self.products_table.doubleClicked.connect(self.add_to_cart_from_table)

        self._btn_off = (
            f"background:{_T['surface']};color:{_T['text_muted']};"
            f"border:1px solid {_T['border']};border-radius:6px;padding:4px 12px;"
            f"font-size:11px;font-weight:600;"
        )
        self._btn_on = (
            f"background:{_T['text']};color:white;border:1px solid {_T['text']};"
            f"border-radius:6px;padding:4px 12px;font-size:11px;font-weight:600;"
        )
        self._fav_style_off = f'QPushButton{{{self._btn_off}}} QPushButton:hover{{background:{_T["surface_alt"]};color:{_T["text"]};}}'
        self._fav_style_on  = f'QPushButton{{{self._btn_on}}} QPushButton:hover{{background:#000;}}'
        self._selected_category = None
        self._category_buttons = {}
        self._all_products = []
        # Layouts ocultos requeridos por métodos de la clase que asumen su existencia
        self._rubros_layout = QHBoxLayout()
        self._subcats_layout = QHBoxLayout()
        # Stub _filter_lbl (se referencia en algunos paths viejos)
        self._filter_lbl = QLabel(''); self._filter_lbl.setVisible(False)
        # Stub _result_count_lbl
        self.result_count_lbl = QLabel(''); self.result_count_lbl.setVisible(False)
        # Stub favorites_btn (eliminado del layout pero referenciado por métodos viejos)
        self.favorites_btn = QPushButton('Favoritos')
        self.favorites_btn.setCheckable(True)
        self.favorites_btn.setVisible(False)

        # Atajos F1-F7
        from PyQt5.QtWidgets import QShortcut
        from PyQt5.QtGui import QKeySequence
        QShortcut(QKeySequence("F1"), self, self._open_search_dialog)
        QShortcut(QKeySequence("F2"), self, self.complete_sale)
        QShortcut(QKeySequence("F3"), self, self._open_cliente_dialog)
        QShortcut(QKeySequence("F4"), self, self._open_promos_dialog)
        QShortcut(QKeySequence("F5"), self, self._cambiar_cajero)
        QShortcut(QKeySequence("F7"), self, self._goto_caja)
        QShortcut(QKeySequence("F8"), self, self._trigger_sync)

        # Cargar datos iniciales
        self.refresh_data()
        # Aplicar filtro de favoritos por defecto
        QTimer.singleShot(50, self._apply_initial_filter)

    def _apply_initial_filter(self):
        try:
            if hasattr(self, 'show_favorites_only'):
                self.show_favorites_only = False
        except Exception:
            pass

    def _build_acciones_card(self):
        from pos_system.ui.theme import COLORS as _T
        card = QFrame()
        card.setStyleSheet(
            f"QFrame {{ background:{_T['surface']}; border:1px solid {_T['border']};"
            f" border-radius:8px; }}"
        )
        v = QVBoxLayout(card)
        v.setContentsMargins(12, 10, 12, 12); v.setSpacing(8)

        l = QLabel('ACCIONES')
        l.setStyleSheet(
            f"color:{_T['text_muted']}; font-size:10px; font-weight:700;"
            f" letter-spacing:0.5px; background:transparent; border:none;"
        )
        v.addWidget(l)

        grid = QGridLayout(); grid.setSpacing(6)
        actions = [
            ('F1', 'Buscar',      self._open_search_dialog),
            ('F3', 'Cliente',     self._open_cliente_dialog),
            ('F4', 'Promo',       self._open_promos_dialog),
            ('F5', 'Cajero',      self._cambiar_cajero),
            ('F7', 'Caja',        self._goto_caja),
            ('F8', 'Sincronizar', self._trigger_sync),
        ]
        for i, (key, lbl, fn) in enumerate(actions):
            b = self._make_action_button(key, lbl, fn)
            grid.addWidget(b, i // 2, i % 2)
        v.addLayout(grid)
        return card

    def _make_action_button(self, key, label, fn):
        from pos_system.ui.theme import COLORS as _T
        b = QPushButton(f"{key}\n{label}")
        b.setMinimumHeight(54)
        b.setCursor(Qt.PointingHandCursor)
        b.setStyleSheet(
            f"QPushButton {{ text-align:left; padding:6px 8px;"
            f" background:{_T['surface']}; color:{_T['text']};"
            f" border:1px solid {_T['border']}; border-radius:6px;"
            f" font-size:12px; font-weight:700; }}"
            f"QPushButton:hover {{ background:{_T['surface_alt']}; }}"
        )
        b.clicked.connect(fn)
        return b

    def _build_caja_card(self):
        from pos_system.ui.theme import COLORS as _T
        card = QFrame()
        card.setStyleSheet(
            f"QFrame {{ background:{_T['surface']}; border:1px solid {_T['border']};"
            f" border-radius:8px; }}"
        )
        v = QVBoxLayout(card)
        v.setContentsMargins(12, 10, 12, 12); v.setSpacing(6)
        l = QLabel('CAJA')
        l.setStyleSheet(
            f"color:{_T['text_muted']}; font-size:10px; font-weight:700;"
            f" letter-spacing:0.5px; background:transparent; border:none;"
        )
        v.addWidget(l)

        # Stats live
        self._caja_ventas_lbl   = QLabel('—')
        self._caja_tickets_lbl  = QLabel('—')
        self._caja_promedio_lbl = QLabel('—')
        for nombre, lbl in [('Ventas hoy', self._caja_ventas_lbl),
                            ('Tickets', self._caja_tickets_lbl),
                            ('Promedio', self._caja_promedio_lbl)]:
            row = QHBoxLayout()
            n = QLabel(nombre)
            n.setStyleSheet(f"color:{_T['text_muted']}; font-size:11px; background:transparent; border:none;")
            lbl.setStyleSheet(
                f"color:{_T['text']}; font-size:11px; font-weight:600; background:transparent;"
                f" border:none; font-family:'JetBrains Mono', Consolas, monospace;"
            )
            lbl.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
            row.addWidget(n); row.addStretch(1); row.addWidget(lbl)
            v.addLayout(row)

        # Refrescar al inicio y cada 30s
        self._caja_timer = QTimer(self)
        self._caja_timer.timeout.connect(self._refresh_caja_card)
        self._caja_timer.start(30_000)
        QTimer.singleShot(500, self._refresh_caja_card)
        return card

    def _build_estado_card(self):
        from pos_system.ui.theme import COLORS as _T
        card = QFrame()
        card.setStyleSheet(
            f"QFrame {{ background:{_T['surface']}; border:1px solid {_T['border']};"
            f" border-radius:8px; }}"
        )
        v = QVBoxLayout(card)
        v.setContentsMargins(12, 10, 12, 12); v.setSpacing(6)
        l = QLabel('ESTADO')
        l.setStyleSheet(
            f"color:{_T['text_muted']}; font-size:10px; font-weight:700;"
            f" letter-spacing:0.5px; background:transparent; border:none;"
        )
        v.addWidget(l)

        self._estado_sync_lbl  = self._estado_row(_T['success'], 'Sincronizado')
        self._estado_stock_lbl = self._estado_row(_T['warning'], 'Stock OK')
        v.addWidget(self._estado_sync_lbl)
        v.addWidget(self._estado_stock_lbl)
        # Refresh inmediato + cada 10s (Firebase puede tardar varios segundos en
        # inicializarse en el thread de fondo, por eso reintentamos)
        QTimer.singleShot(800,  self._refresh_estado_card)
        QTimer.singleShot(3000, self._refresh_estado_card)
        QTimer.singleShot(8000, self._refresh_estado_card)
        self._estado_timer = QTimer(self)
        self._estado_timer.timeout.connect(self._refresh_estado_card)
        self._estado_timer.start(10_000)
        return card

    def _estado_row(self, color, txt):
        from pos_system.ui.theme import COLORS as _T
        w = QWidget()
        h = QHBoxLayout(w); h.setContentsMargins(0, 0, 0, 0); h.setSpacing(6)
        d = QLabel('●')
        d.setStyleSheet(f"color:{color}; font-size:12px; background:transparent; border:none;")
        t = QLabel(txt)
        t.setStyleSheet(f"color:{_T['text_muted']}; font-size:11px; background:transparent; border:none;")
        h.addWidget(d); h.addWidget(t); h.addStretch(1)
        w._dot = d; w._txt = t
        return w

    def _refresh_caja_card(self):
        try:
            from datetime import datetime as _dt
            today = _dt.now().strftime('%Y-%m-%d')
            sales = self.sale_model.get_all(start_date=f'{today} 00:00:00',
                                            end_date=f'{today} 23:59:59') or []
            n = len(sales)
            total = sum(float(s.get('total_amount') or 0) for s in sales)
            avg = (total / n) if n else 0.0
            self._caja_ventas_lbl.setText(f'${total:,.0f}'.replace(',', '.'))
            self._caja_tickets_lbl.setText(str(n))
            self._caja_promedio_lbl.setText(f'${avg:,.0f}'.replace(',', '.') if n else '$0')
        except Exception:
            pass

    def _refresh_estado_card(self):
        from pos_system.ui.theme import COLORS as _T
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if fb and fb.enabled:
                self._estado_sync_lbl._dot.setStyleSheet(
                    f"color:{_T['success']}; font-size:12px; background:transparent; border:none;")
                self._estado_sync_lbl._txt.setText('Conectado')
                self._estado_sync_lbl._txt.setStyleSheet(
                    f"color:{_T['success']}; font-size:11px; font-weight:600;"
                    f" background:transparent; border:none;")
            else:
                self._estado_sync_lbl._dot.setStyleSheet(
                    f"color:{_T['warning']}; font-size:12px; background:transparent; border:none;")
                self._estado_sync_lbl._txt.setText('Sin conexión')
                self._estado_sync_lbl._txt.setStyleSheet(
                    f"color:{_T['warning']}; font-size:11px; font-weight:600;"
                    f" background:transparent; border:none;")
        except Exception:
            pass
        try:
            low = self.product_model.get_low_stock(threshold=3) or []
            real_low = [p for p in low if (p.get('stock') or 0) > 0]
            if real_low:
                self._estado_stock_lbl._dot.setStyleSheet(f"color:{_T['warning']}; font-size:12px; background:transparent; border:none;")
                self._estado_stock_lbl._txt.setText(f'{len(real_low)} con stock bajo')
            else:
                self._estado_stock_lbl._dot.setStyleSheet(f"color:{_T['success']}; font-size:12px; background:transparent; border:none;")
                self._estado_stock_lbl._txt.setText('Stock OK')
        except Exception:
            pass

    # ── Atajos del panel lateral ──
    def _open_promos_dialog(self):
        """Abre PromosQuickDialog: lista de promos activas. Click → carga el producto al carrito."""
        try:
            dlg = PromosQuickDialog(self, firebase_promos=self._firebase_promos)
            dlg.product_chosen.connect(self._on_promo_product_chosen)
            dlg.exec_()
        except Exception as e:
            QMessageBox.information(self, 'Promociones', f'No disponible: {e}')

    def _on_promo_product_chosen(self, product_id, qty):
        """Recibe el producto elegido del PromosQuickDialog y lo agrega N veces
        (la cantidad mínima requerida para que aplique la promo)."""
        try:
            prod = self.product_model.get_by_id(int(product_id))
            if not prod:
                return
            qty = max(1, int(qty))
            for _ in range(qty):
                self.add_to_cart(prod)
        except Exception:
            pass

    def _open_cliente_dialog(self):
        try:
            from pos_system.ui.cliente_perfil_dialog import ClientePerfilDialog
            ClientePerfilDialog(self).exec_()
        except Exception as e:
            QMessageBox.information(self, 'Cliente', f'No disponible: {e}')

    def _cambiar_cajero(self):
        try:
            mw = self.get_main_window()
            if mw and hasattr(mw, '_prompt_turno'):
                mw._prompt_turno()
        except Exception:
            pass

    def _trigger_sync(self):
        """Dispara sync con Firebase abriendo el dialog de progreso (estilo mockup)."""
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if not fb or not fb.enabled:
                QMessageBox.information(self, 'Sincronizar',
                    'Firebase no está activo. Verificá firebase_key.json.')
                return
            mw = self.get_main_window()
            if mw and hasattr(mw, 'cloud_btn'):
                # Usa el flujo nativo del MainWindow (descarga catálogo + ventas)
                mw._open_cloud_menu()
            else:
                QMessageBox.information(self, 'Sincronizar',
                    'Sincronización iniciada en background.')
        except Exception as e:
            QMessageBox.warning(self, 'Sincronizar', f'Error: {e}')

    def _goto_caja(self):
        try:
            mw = self.get_main_window()
            if mw and hasattr(mw, 'tabs') and hasattr(mw, 'cash_view') and mw.cash_view:
                idx = mw.tabs.indexOf(mw.cash_view)
                if idx >= 0:
                    mw.tabs.setCurrentIndex(idx)
        except Exception:
            pass


    def _open_search_dialog(self):
        """Abre el diálogo de búsqueda ampliada de productos."""
        initial_text = self.barcode_field.text().strip()
        if initial_text:
            self._add_to_search_history(initial_text)
        self._open_search_dialog_with_text(initial_text)

    def _open_search_dialog_with_text(self, text: str):
        """Abre Spotlight de búsqueda con texto inicial."""
        if hasattr(self, '_search_dialog') and self._search_dialog:
            try:
                self._search_dialog.search_input.setText(text or '')
                self._search_dialog.activateWindow()
                self._search_dialog.raise_()
                return
            except Exception:
                self._search_dialog = None
        dlg = SpotlightDialog(parent=self, db=self.db, initial_text=text or '')
        dlg.product_selected.connect(self._on_product_selected_from_dialog)
        self._search_dialog = dlg
        dlg.exec_()
        self._search_dialog = None

    # ── Historial de búsquedas (expira en 4 min) ──
    def eventFilter(self, obj, event):
        from PyQt5.QtCore import QEvent
        if obj is getattr(self, 'barcode_field', None):
            # Mostrar SOLO al clickear sobre el campo de búsqueda
            if event.type() == QEvent.MouseButtonPress:
                self._show_history_popup()
            elif event.type() == QEvent.FocusOut:
                # Cerrar el popup al perder foco; delay corto para permitir click en un ítem
                QTimer.singleShot(120, self._hide_history_popup)
            elif event.type() == QEvent.KeyPress:
                if event.key() == Qt.Key_Escape:
                    self._hide_history_popup()
        return super().eventFilter(obj, event)

    def _prune_search_history(self):
        import time
        cutoff = time.time() - 240  # 4 minutos
        self._search_history = [(t, ts) for (t, ts) in self._search_history if ts >= cutoff]

    def _add_to_search_history(self, text: str):
        import time
        text = (text or '').strip()
        if len(text) < 2:
            return
        self._prune_search_history()
        lower = text.lower()
        self._search_history = [(t, ts) for (t, ts) in self._search_history if t.lower() != lower]
        self._search_history.insert(0, (text, time.time()))
        self._search_history = self._search_history[:6]

    def _show_history_popup(self):
        self._prune_search_history()
        if not self._search_history or self.barcode_field.text().strip():
            return
        if self._history_popup is None:
            self._history_popup = QListWidget(self)
            self._history_popup.setFocusPolicy(Qt.NoFocus)
            self._history_popup.setFrameShape(QFrame.NoFrame)
            self._history_popup.setStyleSheet('''
                QListWidget {
                    background: white;
                    border: 1.5px solid #dcd6c8;
                    border-radius: 6px;
                    padding: 4px;
                    font-size: 12px;
                    outline: none;
                }
                QListWidget::item { padding: 6px 10px; border-radius: 4px; color: #5a5448; }
                QListWidget::item:hover { background: #fbeee5; color: #a3441a; }
                QListWidget::item:selected { background: #e0e7ff; color: #3730a3; }
            ''')
            self._history_popup.itemClicked.connect(self._on_history_item_clicked)
        self._history_popup.clear()
        for term, _ts in self._search_history:
            item = QListWidgetItem(f'Recientes:  {term}')
            item.setData(Qt.UserRole, term)
            self._history_popup.addItem(item)
        top_left = self.barcode_field.mapTo(self, self.barcode_field.rect().bottomLeft())
        w = max(220, self.barcode_field.width())
        h = min(30 * len(self._search_history) + 16, 220)
        self._history_popup.setGeometry(top_left.x(), top_left.y() + 2, w, h)
        self._history_popup.raise_()
        self._history_popup.show()

    def _hide_history_popup(self):
        if self._history_popup and self._history_popup.isVisible():
            self._history_popup.hide()

    def _on_history_item_clicked(self, item):
        term = item.data(Qt.UserRole)
        self._hide_history_popup()
        if not term:
            return
        self._add_to_search_history(term)
        self._open_search_dialog_with_text(term)

    def _on_product_selected_from_dialog(self, product: dict):
        """Agrega al carrito el producto seleccionado desde el diálogo ampliado."""
        self.add_to_cart(product)
        if hasattr(self, '_search_dialog') and self._search_dialog:
            self._search_dialog.update_cart_display(list(self.cart))
            self._search_dialog.close()

    def _products_table_key_press(self, event):
        """Enter agrega al carrito; chars imprimibles se redirigen al campo de búsqueda."""
        if event.key() in (Qt.Key_Return, Qt.Key_Enter):
            self.add_to_cart_from_table()
        elif event.text() and not event.modifiers():
            # Cualquier char imprimible (incluyendo dígitos del escáner) va al barcode_field
            self.barcode_field.setFocus()
            self.barcode_field.setText(self.barcode_field.text() + event.text())
            self.barcode_field.setCursorPosition(len(self.barcode_field.text()))
        else:
            QTableWidget.keyPressEvent(self.products_table, event)

    def _on_barcode_scanned(self, code: str):
        """Escáner automático: SOLO agrega si hay match EXACTO por barcode/firebase_id.

        Si no, abre el Spotlight con el texto. Evita agregar el primer producto
        que matchee por nombre cuando el usuario tipeó rápido un nombre exacto
        (que el BarcodeScanner detectó como escaneo).
        """
        self.barcode_field.clear()
        self._hide_suggestions()

        # Buscar por barcode o código interno (exacto)
        product = self.product_model.get_by_barcode(code)
        if not product:
            rows = self.db.execute_query(
                "SELECT * FROM products WHERE UPPER(firebase_id) = UPPER(?) LIMIT 1",
                (code,)
            )
            product = rows[0] if rows else None

        if product:
            # Match exacto por código → agregar de una
            self.add_to_cart(product)
            self.sync_indicator.setText(f'Agregado: {product["name"]}')
            self.sync_indicator.setVisible(True)
            QTimer.singleShot(2000, lambda: self.sync_indicator.setVisible(False))
        else:
            # No hay match exacto: abrir Spotlight con el texto, sin agregar
            self._add_to_search_history(code)
            self._open_search_dialog_with_text(code)

    @staticmethod
    def _normalize(text: str) -> str:
        """Normaliza texto: mayúsculas y sin acentos para búsqueda tolerante."""
        import unicodedata
        text = text.upper()
        # Reemplazar caracteres acentuados comunes del español
        replacements = {
            'Á': 'A', 'É': 'E', 'Í': 'I', 'Ó': 'O', 'Ú': 'U',
            'Ü': 'U', 'Ñ': 'N',
        }
        for accented, plain in replacements.items():
            text = text.replace(accented, plain)
        return text

    @staticmethod
    def _build_fuzzy_query(text: str, limit: int = 50):
        """
        Construye una query SQL con búsqueda por palabras individuales (fuzzy multi-word).
        Cada palabra del texto debe aparecer en algún campo (name, barcode, description, category).
        El orden de las palabras no importa: "Sobre PVC" encuentra "Sobre EM PVC".
        Búsqueda case-insensitive: "goma" encuentra "GOMA DE BORRAR".
        También busca en versión sin acentos para mayor tolerancia.
        """
        import unicodedata

        def normalize(t):
            t = t.upper()
            for a, b in [('Á','A'),('É','E'),('Í','I'),('Ó','O'),('Ú','U'),('Ü','U'),('Ñ','N')]:
                t = t.replace(a, b)
            return t

        words = [w for w in text.strip().split() if w]
        if not words:
            return None, ()
        clauses = []
        params  = []
        for w in words:
            pat       = f'%{w.upper()}%'
            pat_norm  = f'%{normalize(w)}%'
            # Busca la palabra tal cual Y también su versión sin acento
            # Esto permite que "lapiz" encuentre "LÁPIZ" y viceversa
            clauses.append(
                "(UPPER(name) LIKE ? OR UPPER(barcode) LIKE ? OR UPPER(description) LIKE ? OR UPPER(category) LIKE ?"
                " OR UPPER(firebase_id) LIKE ?"
                " OR UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(name,'Á','A'),'É','E'),'Í','I'),'Ó','O'),'Ú','U'),'Ü','U'),'Ñ','N')) LIKE ?)"
            )
            params.extend([pat, pat, pat, pat, pat, pat_norm])
        where = ' AND '.join(clauses)
        query = f"""SELECT * FROM products WHERE {where}
                    ORDER BY is_favorite DESC, name ASC LIMIT {limit}"""
        return query, tuple(params)

    def _on_search_text_changed(self, text: str):
        """Tipeo manual — debounced para no bloquear el input.

        Cada keystroke programa una búsqueda diferida con QTimer(150ms);
        si el usuario sigue escribiendo, el timer se reinicia. Esto evita
        que letras se "pierdan" cuando se tipea rápido.
        """
        text = text.strip()
        self._hide_history_popup()
        # Cancelar búsqueda pendiente y programar nueva
        if not hasattr(self, '_search_debounce_timer'):
            self._search_debounce_timer = QTimer(self)
            self._search_debounce_timer.setSingleShot(True)
            self._search_debounce_timer.timeout.connect(self._do_search_debounced)
        self._search_debounce_timer.start(150)

        # Auto-abrir diálogo ampliado tras 1s de escribir
        if not hasattr(self, '_auto_open_timer'):
            self._auto_open_timer = QTimer(self)
            self._auto_open_timer.setSingleShot(True)
            self._auto_open_timer.timeout.connect(self._auto_open_search_dialog)
        if len(text) >= 2:
            self._auto_open_timer.start(1000)
        else:
            self._auto_open_timer.stop()

    def _do_search_debounced(self):
        """Ejecuta la búsqueda real una vez que el usuario para de tipear."""
        text = self.barcode_field.text().strip()
        if len(text) < 1:
            self._hide_suggestions()
            if not self._selected_category and not self.favorites_btn.isChecked():
                self.products_table.clearSpans()
                self.products_table.setRowCount(0)
                self._all_products = []
            return
        try:
            query, params = self._build_fuzzy_query(text, limit=100)
            matches = self.db.execute_query(query, params) if query else []
        except Exception:
            matches = []
        self._all_products = matches
        self._populate_products_table(matches)

    def _auto_open_search_dialog(self):
        """Abre el diálogo de búsqueda ampliada si no está ya abierto."""
        text = self.barcode_field.text().strip()
        if len(text) < 2:
            return
        self._add_to_search_history(text)
        self._open_search_dialog_with_text(text)

    def _hide_suggestions(self):
        """Compatibilidad — ya no hay dropdown de sugerencias."""
        pass
        
    def _load_rubro_buttons(self):
        """Carga los rubros desde la BD y crea botones para cada uno."""
        # Limpiar botones anteriores
        while self._rubros_layout.count():
            item = self._rubros_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        self._category_buttons = {}

        # Botón "Todos"
        btn_todos = QPushButton('Todos')
        btn_todos.setMinimumHeight(34)
        btn_todos.setCheckable(True)
        btn_todos.setChecked(True)
        btn_todos.setProperty('rubro_name', '')
        btn_todos.setProperty('rubro_id', -1)
        btn_todos.setStyleSheet(f'QPushButton{{{self._btn_on}}} QPushButton:hover{{background:#a3441a;}}')
        btn_todos.clicked.connect(lambda checked, b=btn_todos: self._on_rubro_btn_clicked(b))
        self._rubros_layout.addWidget(btn_todos)
        self._category_buttons[''] = btn_todos

        # Cargar rubros de la BD
        categories = self.db.get_all_categories()
        for cat in categories:
            self._add_rubro_button(cat['id'], cat['name'])

    def _add_rubro_button(self, cat_id: int, name: str):
        """Crea y agrega un botón de rubro al layout."""
        btn = QPushButton(name)
        btn.setMinimumHeight(34)
        btn.setCheckable(True)
        btn.setProperty('rubro_name', name)
        btn.setProperty('rubro_id', cat_id)
        btn.setStyleSheet(f'QPushButton{{{self._btn_off}}} QPushButton:hover{{background:#ece8df;}}')
        btn.clicked.connect(lambda checked, b=btn: self._on_rubro_btn_clicked(b))
        # Clic derecho para opciones de edición/borrado
        btn.setContextMenuPolicy(Qt.CustomContextMenu)
        btn.customContextMenuRequested.connect(lambda pos, b=btn: self._show_rubro_context_menu(b, pos))
        self._rubros_layout.addWidget(btn)
        self._category_buttons[name] = btn

    def _on_rubro_btn_clicked(self, clicked_btn: QPushButton):
        """Maneja la selección de un botón de rubro."""
        # Desactivar todos los botones de rubro
        for btn in self._category_buttons.values():
            btn.setChecked(False)
            btn.setStyleSheet(f'QPushButton{{{self._btn_off}}} QPushButton:hover{{background:#ece8df;}}')

        # Activar el clickeado
        clicked_btn.setChecked(True)
        clicked_btn.setStyleSheet(f'QPushButton{{{self._btn_on}}} QPushButton:hover{{background:#a3441a;}}')

        # Desactivar favoritos si estaban activos
        self.favorites_btn.setChecked(False)
        self.favorites_btn.setStyleSheet(self._fav_style_off)

        rubro = clicked_btn.property('rubro_name')
        self._selected_category = rubro if rubro else None
        self._selected_subcategory = None

        if self._selected_category:
            # Cargar subcategorías del rubro
            self._load_subcategory_buttons(self._selected_category)

            # Contar cuántas subcategorías distintas tiene
            subcats = self.db.execute_query(
                """SELECT COUNT(DISTINCT category) as n FROM products
                   WHERE UPPER(rubro) = ? AND category IS NOT NULL AND category != ''""",
                (self._selected_category.upper(),)
            )
            n_subcats = subcats[0]['n'] if subcats else 0

            if n_subcats == 0:
                # Sin subcategorías → cargar todos los productos directamente (pocos items)
                products = self.db.execute_query(
                    "SELECT * FROM products WHERE UPPER(rubro) = ? ORDER BY name LIMIT 300",
                    (self._selected_category.upper(),)
                )
                self._all_products = products
                self._populate_products_table(products)
            else:
                # Con subcategorías → mostrar hint, el cajero elige una
                self.products_table.setRowCount(0)
                self._all_products = []
                self.products_table.setRowCount(1)
                self.products_table.setSpan(0, 0, 1, 5)
                hint_item = QTableWidgetItem(
                    f'{self._selected_category} — Elegí una categoría arriba o escribí para buscar'
                )
                hint_item.setTextAlignment(Qt.AlignCenter)
                hint_item.setForeground(QColor('#6f6a5d'))
                hint_item.setFont(QFont('Segoe UI', 11))
                self.products_table.setItem(0, 0, hint_item)
        else:
            # "Todos" seleccionado — ocultar subcategorías y limpiar tabla
            self._subcat_container.setVisible(False)
            self._selected_subcategory = None
            self.products_table.setRowCount(0)
            self._all_products = []

    # Mapa de categorías por rubro (igual que la web)
    RUBRO_CATS = {
        'LIBRERÍA':   ['LAPICERA','LAPIZ','LAPIZ COLOR','MARCADOR','RESALTADOR','GOMA DE BORRAR','CUADERNO','BLOCK','TIJERA','CINTA','PAPEL','CARPETA','BROCHE','PEGAMENTO','CORRECTOR','GEOMETRÍA','ROLLO TÉRMICO','SELLO','SOBRE','DECORACIÓN','ABROCHADORA','AGENDA','CALCULADORA','FIBRA FACIL','MOCHILA','CARTUCHERA','CANOPLA','REPUESTO','MARCADORES','LIBRITO','PINCELES','GOMA','BLOCK','SET'],
        'MERCERÍA':   ['AGUJA','HILO','BOTÓN','TELA','CINTA MERCERÍA','CIERRE','ELÁSTICO','IMPERDIBLE','TIJERA MERCERÍA','DEDAL','LANA','ALFILER','ALFILERES','AROS','ANILLO','BANDAS','ALHAJERO'],
        'JUGUETERÍA': ['JUGUETERÍA','MUÑECA','AUTO','ROMPECABEZAS','JUEGO DE MESA','PELUCHE','DIDÁCTICO','ARTE Y MANUALIDADES'],
        'IMPRESIONES': ['ROLLO TÉRMICO','PAPEL','IMPRESION','TONER','CARTUCHO'],
    }

    def _load_subcategory_buttons(self, rubro: str):
        """
        Carga las subcategorías del rubro desde la tabla sub_categories,
        filtrando solo las que tienen al menos 1 producto real.
        Fallback a productos si sub_categories está vacía.
        """
        # Intentar desde sub_categories pero validando que existan productos reales
        results = self.db.execute_query(
            """SELECT sc.name, COUNT(p.id) as n
               FROM sub_categories sc
               LEFT JOIN products p
                 ON UPPER(p.category) = UPPER(sc.name) AND p.rubro = sc.rubro
               WHERE UPPER(sc.rubro) = ?
               GROUP BY sc.name
               HAVING COUNT(p.id) > 0
               ORDER BY sc.name ASC""",
            (rubro.upper(),)
        )

        if results:
            subcats = [r['name'] for r in results if r['name']]
        else:
            # Fallback: obtener desde productos directamente
            results = self.db.execute_query(
                """SELECT DISTINCT category, COUNT(*) as n
                   FROM products
                   WHERE UPPER(rubro) = ? AND category IS NOT NULL AND category != ''
                   GROUP BY category
                   ORDER BY n DESC, category ASC""",
                (rubro.upper(),)
            )
            subcats = [r['category'] for r in results if r['category']]

        self._subcat_combo.blockSignals(True)
        self._subcat_combo.clear()
        self._subcat_combo.addItem('-- Todas las categorías --')
        for sc in subcats:
            self._subcat_combo.addItem(sc)
        self._subcat_combo.blockSignals(False)

        self._subcat_container.setVisible(bool(subcats))

    def _on_subcat_combo_changed(self, text: str):
        """Filtra productos al cambiar la categoría en el combo."""
        self._selected_subcategory = None if text.startswith('--') else text
        if self._selected_category:
            self._load_products_by_category(self._selected_category)
            # Abrir vista ampliada al seleccionar una categoría concreta
            if self._selected_subcategory:
                QTimer.singleShot(150, self._open_search_dialog)
        else:
            self.products_table.setRowCount(0)
            self._all_products = []

    def _show_rubro_context_menu(self, btn: QPushButton, pos):
        """Menú contextual para editar o borrar un rubro."""
        from PyQt5.QtWidgets import QMenu
        name = btn.property('rubro_name')
        cat_id = btn.property('rubro_id')
        if not name or cat_id == -1:
            return

        menu = QMenu(self)
        edit_action = menu.addAction('Renombrar rubro')
        del_action = menu.addAction('Eliminar rubro')

        action = menu.exec_(btn.mapToGlobal(pos))

        if action == edit_action:
            self._rename_rubro(cat_id, name, btn)
        elif action == del_action:
            self._delete_rubro(cat_id, name)

    def _add_rubro(self):
        """Diálogo para agregar un nuevo rubro."""
        name, ok = QInputDialog.getText(self, 'Nuevo Rubro', 'Nombre del rubro:')
        if not ok or not name.strip():
            return
        name = name.strip()
        try:
            cat_id = self.db.add_category(name)
            self._add_rubro_button(cat_id, name)
            QMessageBox.information(self, 'Éxito', f'Rubro "{name}" agregado correctamente.')
        except Exception as e:
            if 'UNIQUE' in str(e):
                QMessageBox.warning(self, 'Error', f'El rubro "{name}" ya existe.')
            else:
                QMessageBox.critical(self, 'Error', f'No se pudo agregar el rubro: {e}')

    def _rename_rubro(self, cat_id: int, old_name: str, btn: QPushButton):
        """Renombra un rubro en la BD y actualiza el botón."""
        new_name, ok = QInputDialog.getText(self, 'Renombrar Rubro', 'Nuevo nombre:', text=old_name)
        if not ok or not new_name.strip() or new_name.strip() == old_name:
            return
        new_name = new_name.strip()
        try:
            self.db.rename_category(cat_id, new_name)
            # Actualizar botón
            if old_name in self._category_buttons:
                del self._category_buttons[old_name]
            btn.setText(new_name)
            btn.setProperty('rubro_name', new_name)
            self._category_buttons[new_name] = btn
            # Si estaba seleccionado, actualizar filtro
            if self._selected_category == old_name:
                self._selected_category = new_name
            QMessageBox.information(self, 'Éxito', f'Rubro renombrado a "{new_name}".')
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo renombrar: {e}')

    def _delete_rubro(self, cat_id: int, name: str):
        """Elimina un rubro de la BD y actualiza la UI."""
        reply = QMessageBox.question(
            self, 'Eliminar Rubro',
            f'¿Eliminar el rubro "{name}"?\n\nLos productos de este rubro quedarán sin categoría.',
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No
        )
        if reply != QMessageBox.Yes:
            return
        try:
            self.db.delete_category(cat_id)
            # Quitar el botón del layout y del dict
            if name in self._category_buttons:
                btn = self._category_buttons.pop(name)
                self._rubros_layout.removeWidget(btn)
                btn.deleteLater()
            # Si era el seleccionado, limpiar tabla
            if self._selected_category == name:
                self._selected_category = None
                self.products_table.setRowCount(0)
                self._all_products = []
                # Activar "Todos"
                if '' in self._category_buttons:
                    todos_btn = self._category_buttons['']
                    todos_btn.setChecked(True)
                    todos_btn.setStyleSheet(f'QPushButton{{{self._btn_on}}} QPushButton:hover{{background:#a3441a;}}')
            QMessageBox.information(self, 'Éxito', f'Rubro "{name}" eliminado.')
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo eliminar: {e}')

    def refresh_data(self):
        """Recarga botones de rubros desde la BD."""
        self._load_rubro_buttons()

    def on_category_changed(self, text):
        """Compatibilidad — ya no se usa con combos."""
        pass

    def _on_favorites_toggled(self, checked: bool):
        """Mostrar/ocultar favoritos."""
        self.favorites_btn.setStyleSheet(self._fav_style_on if checked else self._fav_style_off)
        if checked:
            # Deseleccionar rubros
            for btn in self._category_buttons.values():
                btn.setChecked(False)
                btn.setStyleSheet(f'QPushButton{{{self._btn_off}}} QPushButton:hover{{background:#ece8df;}}')
            self._selected_category = None
            products = self.product_model.get_favorites()
            self._all_products = products
            self._populate_products_table(products)
        else:
            self.products_table.setRowCount(0)
            self._all_products = []
            # Reactivar "Todos"
            if '' in self._category_buttons:
                btn_todos = self._category_buttons['']
                btn_todos.setChecked(True)
                btn_todos.setStyleSheet(f'QPushButton{{{self._btn_on}}} QPushButton:hover{{background:#a3441a;}}')

    def reset_category_filter(self):
        """Limpiar todos los filtros y la tabla."""
        self._selected_category = None
        self.favorites_btn.setChecked(False)
        self.favorites_btn.setStyleSheet(self._fav_style_off)
        self.products_table.setRowCount(0)
        self._all_products = []
        # Reactivar "Todos"
        for name, btn in self._category_buttons.items():
            if name == '':
                btn.setChecked(True)
                btn.setStyleSheet(f'QPushButton{{{self._btn_on}}} QPushButton:hover{{background:#a3441a;}}')
            else:
                btn.setChecked(False)
                btn.setStyleSheet(f'QPushButton{{{self._btn_off}}} QPushButton:hover{{background:#ece8df;}}')

    def filter_products(self):
        """Alias para compatibilidad."""
        pass

    def _load_products_by_category(self, category: str):
        """
        Carga productos filtrando por subcategoría dentro de un rubro.
        Siempre requiere subcategoría seleccionada para evitar cargas masivas.
        Límite: 200 productos para mantener la velocidad.
        """
        if self._selected_subcategory:
            # Rubro + subcategoría: carga rápida y acotada
            products = self.db.execute_query(
                """SELECT * FROM products
                   WHERE UPPER(rubro) = ? AND UPPER(category) = ?
                   ORDER BY name LIMIT 200""",
                (category.upper(), self._selected_subcategory.upper())
            )
        else:
            # Sin subcategoría seleccionada: no cargar nada (el hint ya está puesto)
            return

        self._all_products = products
        self._populate_products_table(products)

    def _load_products_by_filter(self):
        """Carga productos según filtro activo."""
        if self._selected_category:
            self._load_products_by_category(self._selected_category)
        elif self.favorites_btn.isChecked():
            products = self.product_model.get_favorites()
            self._populate_products_table(products)

    def _populate_products_table(self, products: list):
        """Renderiza la lista de productos en la tabla."""
        # Limpiar primero para eliminar cualquier span previo del hint
        self.products_table.clearSpans()
        self.products_table.setRowCount(0)
        self.products_table.setRowCount(len(products))

        for row, product in enumerate(products):
            self.products_table.setRowHeight(row, 42)
            es_conjunto = int(product.get('es_conjunto') or 0) == 1
            tipo_lbl = (_CONJ_TIPOS.get((product.get('conjunto_tipo') or '').lower(), {})
                        .get('label')) if es_conjunto else None

            # Col 0: Favorito
            fav_item = QTableWidgetItem('*' if product['is_favorite'] else '')
            fav_item.setTextAlignment(Qt.AlignCenter)
            fav_item.setFont(QFont('Segoe UI', 13, QFont.Bold))
            fav_item.setForeground(QColor('#c1521f') if product['is_favorite'] else QColor('#dcd6c8'))
            fav_item.setData(Qt.UserRole, product)
            self.products_table.setItem(row, 0, fav_item)

            # Col 1: Nombre (con badge "[Rollo]" / "[Pack]" / etc para productos conjunto)
            badge_prefix = f'[{tipo_lbl}] ' if tipo_lbl else ''
            stock_val_name = product['stock']
            if es_conjunto:
                # Para conjunto, el "sin stock" se decide por conjunto_total, no por stock
                ctotal = float(product.get('conjunto_total') or 0)
                if ctotal <= 0:
                    name_item = QTableWidgetItem(f"{badge_prefix}{product['name']}  [Sin stock]")
                    name_item.setForeground(QColor('#a01616'))
                else:
                    name_item = QTableWidgetItem(f"{badge_prefix}{product['name']}")
                    name_item.setForeground(QColor('#c1521f'))  # violeta del catálogo conjunto
                name_item.setFont(QFont('Segoe UI', 10, QFont.Bold))
            elif stock_val_name == 0:
                name_item = QTableWidgetItem(f"{product['name']}  [Sin stock]")
                name_item.setFont(QFont('Segoe UI', 10))
                name_item.setForeground(QColor('#a01616'))  # rojo legible
            elif stock_val_name < 0:
                name_item = QTableWidgetItem(f"{product['name']}  [Servicio]")
                name_item.setFont(QFont('Segoe UI', 10))
                name_item.setForeground(QColor('#c1521f'))
            else:
                name_item = QTableWidgetItem(product['name'])
                name_item.setFont(QFont('Segoe UI', 10))
            if es_conjunto:
                u_short = _CONJ_UNIDADES.get(
                    (product.get('conjunto_unidad_medida') or '').lower(), {}
                ).get('short', '')
                name_item.setToolTip(
                    f'{tipo_lbl} · {product.get("conjunto_unidades") or 0:g} cerrado(s) + '
                    f'{product.get("conjunto_restante") or 0:g}{u_short} abierto = '
                    f'{product.get("conjunto_total") or 0:g}{u_short}'
                )
            self.products_table.setItem(row, 1, name_item)

            # Col 2: Codigo de barras
            barcode_item = QTableWidgetItem(str(product.get('barcode') or ''))
            barcode_item.setFont(QFont('Courier New', 9))
            barcode_item.setForeground(QColor('#6f6a5d'))
            barcode_item.setTextAlignment(Qt.AlignCenter)
            self.products_table.setItem(row, 2, barcode_item)

            # Col 3: Precio
            price_item = QTableWidgetItem(f'${product["price"]:.2f}')
            price_item.setFont(QFont('Segoe UI', 10, QFont.Bold))
            price_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            self.products_table.setItem(row, 3, price_item)

            # Col 4: Stock
            if es_conjunto:
                ctotal = float(product.get('conjunto_total') or 0)
                u_short = _CONJ_UNIDADES.get(
                    (product.get('conjunto_unidad_medida') or '').lower(), {}
                ).get('short', '')
                txt = f'{int(ctotal) if abs(ctotal - round(ctotal)) < 1e-9 else round(ctotal, 2)}{u_short}'
                stock_item = QTableWidgetItem(txt)
                stock_item.setTextAlignment(Qt.AlignCenter)
                if ctotal <= 0:
                    stock_item.setForeground(QColor('#a01616'))
                else:
                    stock_item.setForeground(QColor('#c1521f'))
                stock_item.setFont(QFont('Segoe UI', 10, QFont.Bold))
            else:
                stock_val = product['stock']
                stock_item = QTableWidgetItem(str(stock_val))
                stock_item.setTextAlignment(Qt.AlignCenter)
                if stock_val <= 0:
                    stock_item.setForeground(QColor('#a01616'))
                    stock_item.setFont(QFont('Segoe UI', 10, QFont.Bold))
                elif stock_val < 5:
                    stock_item.setForeground(QColor('#c1521f'))
                    stock_item.setFont(QFont('Segoe UI', 10, QFont.Bold))
                else:
                    stock_item.setFont(QFont('Segoe UI', 10))
            self.products_table.setItem(row, 4, stock_item)

    def search_product(self):
        """Búsqueda manual (Enter en el campo o botón Buscar)."""
        # Guard: bloquear re-entrada para que un doble-click no agregue 2x.
        if getattr(self, '_searching_now', False):
            return
        search_text = self.barcode_field.text().strip()
        if not search_text:
            return
        self._searching_now = True
        try:
            self._search_product_impl(search_text)
        finally:
            # Permitir nuevo search 250ms después (suficiente para limpiar input
            # y descartar clicks en ráfaga, no bloquea ventas legítimas seguidas)
            QTimer.singleShot(250, lambda: setattr(self, '_searching_now', False))

    def _search_product_impl(self, search_text):
        self._hide_suggestions()
        self._hide_history_popup()

        # Buscar por código de barras o código interno (exacto)
        product = self.product_model.get_by_barcode(search_text)
        if not product:
            rows = self.db.execute_query(
                "SELECT * FROM products WHERE UPPER(firebase_id) = UPPER(?) LIMIT 1",
                (search_text,)
            )
            product = rows[0] if rows else None

        if product:
            # Código exacto encontrado — agregar al carrito de una
            self.add_to_cart(product)
            self.barcode_field.clear()
            return

        # Sin match exacto → abrir diálogo ampliado instantáneo con el texto
        # (cancela el timer de auto-apertura para evitar doble ventana)
        if hasattr(self, '_auto_open_timer'):
            self._auto_open_timer.stop()
        self._add_to_search_history(search_text)
        self.barcode_field.clear()
        self._open_search_dialog_with_text(search_text)
            
    def add_to_cart_from_table(self):
        selected_row = self.products_table.currentRow()
        if selected_row >= 0:
            product = self.products_table.item(selected_row, 0).data(Qt.UserRole)
            if product:
                self.add_to_cart(product)
        
    def _resolve_price_for_product(self, product: dict, quantity: int = 1) -> dict:
        """
        Calcula el precio efectivo aplicando descuentos del producto y promos activas.
        Prioridad: Firebase promos > promos locales BD > descuento propio del producto.
        Devuelve un dict con: unit_price, original_price, discount_type, discount_value,
                              discount_amount, promo_id, promo_label
        """
        original_price = float(product['price'])
        dtype  = product.get('discount_type') or ''
        dval   = float(product.get('discount_value') or 0)

        # 1. Descuento propio del producto (% o fijo)
        unit_price, disc_amount_unit = Promotion.calculate_discounted_price(
            original_price, dtype, dval
        )
        discount_type_final  = dtype or None
        discount_value_final = dval
        discount_amount      = disc_amount_unit * quantity
        promo_id             = None
        promo_label          = ''

        # 2. Buscar promo activa en la BD local vinculada al producto
        promos = self.promo_model.get_active_for_product(product['id'])
        if promos:
            best_promo = promos[0]  # Primera promo activa
            eff, promo_disc, label = Promotion.calculate_promo_for_cart_item(
                best_promo, quantity, original_price
            )
            if promo_disc > discount_amount:
                unit_price           = eff
                discount_amount      = promo_disc
                discount_type_final  = best_promo['promo_type']
                discount_value_final = best_promo.get('discount_value', 0)
                promo_id             = best_promo['id']
                promo_label          = label

        # 3. Buscar promo activa en Firebase (definidas desde la webapp)
        product_doc_id   = str(product.get('id', ''))
        product_barcode  = str(product.get('barcode') or '')
        product_name     = str(product.get('name') or '')
        product_firebase = str(product.get('firebase_id') or '')  # doc_id en Firebase
        for fb_promo in self._firebase_promos:
            if not fb_promo.get('activo', True):
                continue
            cant_min = int(fb_promo.get('cantidad_minima') or 1)
            if quantity < cant_min:
                continue
            promo_productos = fb_promo.get('productos') or []
            # Buscar por firebase_id (más confiable), barcode, nombre o id local
            match = any(
                p in (product_firebase, product_barcode, product_doc_id, product_name)
                for p in promo_productos
            )
            if not match:
                continue
            # Convertir la promo de Firebase al formato que entiende calculate_promo_for_cart_item
            tipo = fb_promo.get('tipo', '')
            promo_local = {
                'promo_type':        tipo,
                'discount_value':    float(fb_promo.get('valor') or 0),
                'required_quantity': int(fb_promo.get('cantidad_requerida') or 1),
                'free_quantity':     max(0, int(fb_promo.get('cantidad_requerida') or 1) - int(fb_promo.get('cantidad_paga') or 1)),
                'name':              fb_promo.get('nombre', ''),
            }
            eff, fb_disc, label = Promotion.calculate_promo_for_cart_item(
                promo_local, quantity, original_price
            )
            if fb_disc > discount_amount:
                unit_price           = eff
                discount_amount      = fb_disc
                discount_type_final  = tipo
                discount_value_final = float(fb_promo.get('valor') or 0)
                promo_id             = fb_promo.get('_id', '')
                promo_label          = f'[Web] {label or fb_promo.get("nombre", "")}'

        if not promo_label and dtype and disc_amount_unit > 0:
            if dtype == 'percentage':
                promo_label = f'-{dval:.0f}%'
            elif dtype == 'fixed':
                promo_label = f'-${dval:.2f}'

        return {
            'unit_price':      round(unit_price, 4),
            'original_price':  original_price,
            'discount_type':   discount_type_final,
            'discount_value':  discount_value_final,
            'discount_amount': round(discount_amount, 2),
            'promo_id':        promo_id,
            'promo_label':     promo_label,
        }

    def add_to_cart(self, product):
        # Si el carrito tiene Varios 2, bloquear: son exclusivos (no se registran como venta).
        if any(it.get('is_varios_2') for it in self.cart):
            QMessageBox.warning(
                self, 'Carrito en modo Varios 2',
                'El carrito tiene items "Varios 2" (solo factura AFIP).\n'
                'No se pueden mezclar con productos normales.\n\n'
                'Cobrá los Varios 2 primero o limpiá el carrito.'
            )
            return

        # Producto Conjunto (rollo / pack / caja / etc.) → diálogo táctil que pregunta cuánto vender
        if int(product.get('es_conjunto') or 0) == 1:
            self._add_conjunto_to_cart(product)
            return

        stock = product['stock']
        # Stock -1 = servicio/ilimitado (sin control de stock)
        is_unlimited = (stock is None or stock == -1)

        for item in self.cart:
            if item['product_id'] == product['id']:
                item['quantity'] += 1
                pricing = self._resolve_price_for_product(product, item['quantity'])
                item.update(pricing)
                item['subtotal'] = round(item['quantity'] * item['unit_price'], 2)
                self.update_cart_display()
                return

        # Primer agregado: avisar si stock = 0 pero dejar vender
        if not is_unlimited and stock == 0:
            reply = QMessageBox.question(
                self, 'Sin Stock',
                f'"{product["name"]}" no tiene stock registrado.\n¿Querés agregarlo igual?',
                QMessageBox.Yes | QMessageBox.No, QMessageBox.No
            )
            if reply == QMessageBox.No:
                return

        pricing = self._resolve_price_for_product(product, 1)
        self.cart.append({
            'product_id':    product['id'],
            'product_name':  product['name'],
            'quantity':      1,
            'subtotal':      pricing['unit_price'],
            'max_stock':     product['stock'],
            'category':      product.get('category'),
            **pricing,
        })

        self.update_cart_display()

    def _add_conjunto_to_cart(self, product):
        """Abre el ConjuntoDialog y agrega el resultado como ítem del carrito.

        Cada venta de conjunto va como un ítem independiente (no se acumula
        con otras del mismo producto), porque cada una baja stock distinto
        del par (unidades cerradas, restante abierto).
        """
        dlg = ConjuntoDialog(product, parent=self)
        if dlg.exec_() != QDialog.Accepted or not dlg.result_data:
            return
        r = dlg.result_data

        u_short = _CONJ_UNIDADES[dlg.unidad_base]['short']
        venta_short = _CONJ_UNIDADES.get(r['unidad_venta'], {}).get('short', u_short)
        tipo_label = _CONJ_TIPOS.get(dlg.tipo, {}).get('label', 'Conjunto')

        if r['vender_por'] == 'conjunto':
            descripcion = f'{_fmt_qty(r["cantidad"])} {tipo_label.lower()}(s)'
        elif r['vender_por'] == 'unidad':
            descripcion = f'{_fmt_qty(r["cantidad"])} u'
        else:
            descripcion = f'{_fmt_qty(r["cantidad"])} {venta_short}'

        nombre_largo = f'{product["name"]}  ·  {descripcion}'
        precio_total = float(r['precio_total'])

        self.cart.append({
            'product_id':    product['id'],
            'product_name':  nombre_largo,
            # Los items conjunto siempre cuentan como 1 línea (la cantidad real
            # está en cantidad_conjunto). Esto evita romper el resto de la UI
            # que asume quantity entera.
            'quantity':         1,
            'unit_price':       precio_total,
            'original_price':   precio_total,
            'discount_type':    None,
            'discount_value':   0,
            'discount_amount':  0,
            'promo_id':         None,
            'promo_label':      '',
            'subtotal':         precio_total,
            'max_stock':        9999,
            'category':         product.get('category'),
            # Flags / payload conjunto (consumidos por el descuento de stock al cerrar venta)
            'is_conjunto':            True,
            'conjunto_tipo':          dlg.tipo,
            'conjunto_unidad_base':   dlg.unidad_base,
            'conjunto_cantidad':      r['cantidad'],
            'conjunto_unidad_venta':  r['unidad_venta'],
            'conjunto_cantidad_base': r['cantidad_base'],
            'conjunto_vender_por':    r['vender_por'],
            'conjunto_after_unidades': r['after_unidades'],
            'conjunto_after_restante': r['after_restante'],
        })
        self.update_cart_display()

    def update_cart_display(self):
        from pos_system.ui.theme import COLORS as _T
        self.cart_table.setRowCount(len(self.cart))
        total = 0

        # Actualizar contador de items
        total_items = sum(float(item['quantity']) for item in self.cart)
        items_str = _fmt_qty(total_items)
        self.items_count_lbl.setText(f'{items_str} item{"s" if total_items != 1 else ""}')

        for row, item in enumerate(self.cart):
            has_discount = item.get('discount_amount', 0) > 0
            self.cart_table.setRowHeight(row, 44)

            # Col 0: Nombre producto (con sub-línea de promo cuando aplica)
            name_text = item['product_name']
            promo_label = item.get('promo_label', '')
            if has_discount:
                orig = item.get('original_price', item['unit_price'])
                disc_total = (orig - item['unit_price']) * item['quantity']
                w = QWidget()
                wl = QVBoxLayout(w); wl.setContentsMargins(12, 4, 8, 4); wl.setSpacing(2)
                n = QLabel(name_text)
                n.setStyleSheet(
                    f"color:{_T['text']}; font-size:12px; font-weight:600;"
                    f" background:transparent; border:none;"
                )
                tag = (promo_label or 'Promo').upper()[:24]
                sub = QLabel(f"<span style='color:{_T['accent']};'>● {tag}</span>"
                             f"  <span style='color:{_T['text_muted']};'>·</span>"
                             f"  <b style='color:{_T['accent']};font-family:\"JetBrains Mono\",Consolas,monospace;'>"
                             f"-${disc_total:,.0f}</b>")
                sub.setStyleSheet(f"font-size:10px; background:transparent; border:none;")
                sub.setToolTip(promo_label or 'Descuento aplicado')
                wl.addWidget(n); wl.addWidget(sub); wl.addStretch(1)
                self.cart_table.setCellWidget(row, 0, w)
                self.cart_table.setItem(row, 0, QTableWidgetItem(''))
                self.cart_table.setRowHeight(row, 56)
            else:
                self.cart_table.removeCellWidget(row, 0)
                name_item = QTableWidgetItem(name_text)
                name_item.setFont(QFont('Segoe UI', 10))
                name_item.setForeground(QColor(_T['text']))
                name_item.setToolTip(name_text)
                self.cart_table.setItem(row, 0, name_item)

            # Col 1: Cantidad (DoubleSpinBox)
            qty_spin = CartQuantitySpinBox()
            qty_spin.setMinimum(0.0)
            max_stock = item.get('max_stock', 0)
            qty_spin.setMaximum(float(max_stock) if max_stock and max_stock > 0 else 9999.0)
            qty_spin.setValue(float(item['quantity']))
            qty_spin.setFixedHeight(32)
            qty_spin.setFont(QFont('Segoe UI', 11, QFont.Bold))
            qty_spin.setAlignment(Qt.AlignCenter)
            qty_spin.setStyleSheet(
                f"QDoubleSpinBox, QSpinBox {{"
                f" font-size:12px; padding:2px 6px;"
                f" border:1px solid {_T['border']}; border-radius:5px;"
                f" background:{_T['surface']}; color:{_T['text']};"
                f" font-family:'JetBrains Mono', Consolas, monospace;"
                f"}}"
                f"QDoubleSpinBox:focus, QSpinBox:focus {{ border-color:{_T['accent']}; }}"
                f"QDoubleSpinBox::up-button, QSpinBox::up-button {{ width:16px; }}"
                f"QDoubleSpinBox::down-button, QSpinBox::down-button {{ width:16px; }}"
            )
            qty_spin.valueChanged.connect(lambda v, r=row: self.update_quantity(r, v))
            self.cart_table.setCellWidget(row, 1, qty_spin)

            # Col 2: Subtotal (con precio tachado arriba si hay descuento)
            if has_discount:
                orig = item.get('original_price', item['unit_price'])
                orig_total = orig * item['quantity']
                self.cart_table.removeCellWidget(row, 2)
                w = QWidget()
                wl = QVBoxLayout(w); wl.setContentsMargins(8, 4, 12, 4); wl.setSpacing(0)
                wl.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
                strike = QLabel(f"<s>${orig_total:,.0f}</s>")
                strike.setStyleSheet(
                    f"color:{_T['text_dim']}; font-size:10px; background:transparent;"
                    f" border:none; font-family:'JetBrains Mono', Consolas, monospace;"
                )
                strike.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
                final = QLabel(f"${item['subtotal']:,.0f}")
                final.setStyleSheet(
                    f"color:{_T['accent']}; font-size:13px; font-weight:700; background:transparent;"
                    f" border:none; font-family:'JetBrains Mono', Consolas, monospace;"
                )
                final.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
                wl.addWidget(strike); wl.addWidget(final)
                self.cart_table.setCellWidget(row, 2, w)
                self.cart_table.setItem(row, 2, QTableWidgetItem(''))
            else:
                self.cart_table.removeCellWidget(row, 2)
                subtotal_item = QTableWidgetItem(f'${item["subtotal"]:,.0f}')
                subtotal_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                subtotal_item.setFont(QFont('Consolas', 11, QFont.Bold))
                subtotal_item.setToolTip('Clic para editar el precio')
                subtotal_item.setForeground(QColor(_T['text']))
                self.cart_table.setItem(row, 2, subtotal_item)

            # Col 3: Botón quitar (×)
            rm_container = QWidget()
            rm_layout = QHBoxLayout(rm_container)
            rm_layout.setContentsMargins(0, 0, 0, 0)
            rm_layout.setAlignment(Qt.AlignCenter)
            rm_btn = QPushButton('Quitar')
            rm_btn.setFixedSize(60, 30)
            rm_btn.setCursor(Qt.PointingHandCursor)
            rm_btn.setFont(QFont('Segoe UI', 9, QFont.Bold))
            rm_btn.setStyleSheet(
                "QPushButton {"
                "  background-color: #ffffff;"
                "  color: #a01616;"
                "  border: 1px solid #a01616;"
                "  border-radius: 5px;"
                "  padding: 0;"
                "}"
                "QPushButton:hover {"
                "  background-color: #a01616;"
                "  color: #ffffff;"
                "}"
            )
            rm_btn.clicked.connect(lambda checked, r=row: self.remove_from_cart(r))
            rm_layout.addWidget(rm_btn)
            self.cart_table.setCellWidget(row, 3, rm_container)

            total += item['subtotal']

        # Total con ahorro si aplica — ajustar fuente según longitud del monto
        total_str = f'${total:,.2f}'
        font_size = 24 if len(total_str) <= 10 else (20 if len(total_str) <= 13 else 17)
        total_discount = sum(item.get('discount_amount', 0) for item in self.cart)
        if total_discount > 0:
            self.total_amount_label.setText(
                f'<span style="font-size:12px;color:#3d7a3a;font-weight:normal;">'
                f'Ahorro: ${total_discount:,.2f}</span><br>'
                f'<b style="color:#3d7a3a;font-size:{font_size}px;">{total_str}</b>'
            )
            self.total_amount_label.setTextFormat(Qt.RichText)
        else:
            self.total_amount_label.setFont(QFont('Segoe UI', font_size, QFont.Bold))
            self.total_amount_label.setText(total_str)
            self.total_amount_label.setTextFormat(Qt.PlainText)
        self._update_change()
        self._update_promo_hints()

    def _update_promo_hints(self):
        """
        Muestra dos tipos de avisos en el cartel:
        1. Descuentos APLICADOS al carrito ('Promo activa: -20% en Cuaderno · ahorrás $560').
        2. Promos Firebase CERCANAS ('Agregá 2 más de Shampú para activar el 3x2').
        """
        if not hasattr(self, '_promo_hint_lbl'):
            return
        from pos_system.ui.theme import COLORS as _T

        hints = []
        active_lines = []
        total_savings = 0.0
        for it in self.cart:
            disc = float(it.get('discount_amount') or 0)
            if disc <= 0:
                continue
            total_savings += disc
            label = it.get('promo_label') or '−'
            name = it.get('product_name', '')[:32]
            active_lines.append(
                f'<span style="color:{_T["accent"]};font-weight:700;">●</span> '
                f'<b>{name}</b> '
                f'<span style="color:{_T["accent"]};font-family:\'JetBrains Mono\',Consolas,monospace;">'
                f'{label}</span> '
                f'<span style="color:{_T["text_muted"]};">·</span> '
                f'<span style="color:{_T["accent"]};font-family:\'JetBrains Mono\',Consolas,monospace;">'
                f'-${disc:,.0f}</span>'
            )
        if active_lines:
            header = (
                f'<span style="color:{_T["accent"]};font-weight:700;">'
                f'PROMOS APLICADAS · ahorrás ${total_savings:,.0f}</span>'
            )
            hints.append(header + '<br>' + '<br>'.join(active_lines))

        # Construir mapa producto → cantidad en carrito
        cart_qty = {}      # product_id → qty
        cart_names = {}    # product_id → nombre
        cart_barcodes = {} # product_id → barcode
        for item in self.cart:
            pid = str(item.get('product_id', ''))
            # Obtener barcode actualizado desde la BD local (puede haberse actualizado via Firebase)
            try:
                prod_local = self.product_model.get_by_id(int(pid))
                bc = str(prod_local.get('barcode') or '') if prod_local else ''
            except Exception:
                bc = str(item.get('barcode') or '')
            cart_qty[pid]      = cart_qty.get(pid, 0) + item.get('quantity', 1)
            cart_names[pid]    = item.get('product_name', '')
            cart_barcodes[pid] = bc

        for fb_promo in self._firebase_promos:
            if not fb_promo.get('activo', True):
                continue

            cant_min  = int(fb_promo.get('cantidad_minima') or 1)
            cant_req  = int(fb_promo.get('cantidad_requerida') or cant_min)
            # Para que un hint tenga sentido, la promo debe requerir más de 1 unidad
            umbral = max(cant_min, cant_req)
            if umbral <= 1:
                continue

            promo_productos = fb_promo.get('productos') or []
            tipo  = fb_promo.get('tipo', '')
            nombre_promo = fb_promo.get('nombre', '')

            for pid, qty in cart_qty.items():
                bc        = cart_barcodes.get(pid, '')
                name      = cart_names.get(pid, '')
                # Obtener firebase_id del producto local
                try:
                    prod_row = self.db.execute_query("SELECT firebase_id FROM products WHERE id=?", (int(pid),))
                    fb_id = str(prod_row[0].get('firebase_id') or '') if prod_row else ''
                except Exception:
                    fb_id = ''

                # Buscar por firebase_id (más confiable), barcode, nombre o id local
                match_promo = any(
                    p in (fb_id, bc, pid, name) for p in promo_productos
                )
                if not match_promo:
                    continue

                # ¿La promo YA está activa para este producto/cantidad?
                if qty >= umbral:
                    continue  # Ya se aplica, no necesita aviso

                faltan = umbral - qty

                # Construir texto del hint según tipo
                if tipo == 'nxm':
                    cant_paga = int(fb_promo.get('cantidad_paga') or (cant_req - 1))
                    desc_txt = f'{cant_req}x{cant_paga}'
                elif tipo == '2x1':
                    desc_txt = '2x1'
                elif tipo == 'bundle':
                    valor = fb_promo.get('valor', 0)
                    desc_txt = f'pack ${valor:.0f}'
                elif tipo == 'percentage':
                    desc_txt = f'{fb_promo.get("valor", 0):.0f}% off'
                elif tipo == 'fixed':
                    desc_txt = f'${fb_promo.get("valor", 0):.0f} de descuento'
                else:
                    desc_txt = nombre_promo

                unidad = 'unidad' if faltan == 1 else 'unidades'
                hint = f'Agregá {faltan} {unidad} más de <b>{name}</b> para activar <b>{desc_txt}</b>'
                if nombre_promo and nombre_promo != desc_txt:
                    hint += f' ({nombre_promo})'
                hints.append(hint)

        if hints:
            from pos_system.ui.theme import COLORS as _T2
            # Si hay descuentos APLICADOS pinto en accent, si solo hay hints faltantes en warning
            if active_lines:
                bg = _T2['accent_soft']; bd = _T2['accent']; fg = _T2['text']
            else:
                bg = _T2['warning_bg']; bd = _T2['warning']; fg = _T2['warning']
            self._promo_hint_lbl.setStyleSheet(
                f"QLabel {{ background:{bg}; border:1px solid {bd};"
                f" border-radius:6px; padding:8px 12px; color:{fg}; font-size:11px; }}"
            )
            self._promo_hint_lbl.setText('<br>'.join(hints))
            self._promo_hint_lbl.setTextFormat(Qt.RichText)
            self._promo_hint_lbl.setVisible(True)
        else:
            self._promo_hint_lbl.setVisible(False)
        
    def update_quantity(self, row, quantity):
        if row >= len(self.cart):
            return
        quantity = float(quantity)
        if quantity <= 0:
            # Estado transitorio mientras el usuario tipea (ej: escribió "0"
            # antes del "0,5"). Ignoramos sin reconstruir para no matar el foco.
            return
        item = self.cart[row]
        item['quantity'] = quantity
        # Siempre recalcular precio — las promos de Firebase dependen de la cantidad
        promo_changed = False
        try:
            product = self.product_model.get_by_id(item['product_id'])
            if product:
                old_unit  = item.get('unit_price')
                old_disc  = item.get('discount_amount', 0)
                old_promo = item.get('promo_id')
                old_label = item.get('promo_label', '')
                pricing = self._resolve_price_for_product(product, quantity)
                item.update(pricing)
                # Detecta cualquier cambio relevante (unit_price, monto descuento,
                # promo activa o etiqueta) — no sólo unit_price. Asegura que al
                # bajar la cantidad debajo del minimo de promo, el badge se vaya.
                promo_changed = (
                    pricing.get('unit_price')      != old_unit  or
                    pricing.get('discount_amount') != old_disc  or
                    pricing.get('promo_id')        != old_promo or
                    pricing.get('promo_label', '') != old_label
                )
        except Exception:
            pass
        item['subtotal'] = round(quantity * item['unit_price'], 2)

        # Si cambió una promo (activación/desactivación por cantidad), refrescamos
        # SÓLO las celdas afectadas (descuento, precio, subtotal) en esta fila.
        # NO rebuildeamos toda la tabla porque eso recrea el QSpinBox de cantidad
        # y mata el caret mientras el cajero está tipeando ("25" → cursor a posición 1).
        if promo_changed:
            self._refresh_cart_row_pricing(row, item)
        else:
            self._refresh_cart_totals(row)

    def _refresh_cart_row_pricing(self, row, item):
        """Actualiza in-place las celdas Producto (col 0) y Subtotal (col 2) de UNA fila.
        NO toca col 1 (spinbox cantidad) → preserva caret y foco mientras el cajero tipea.
        Útil cuando una promo se activa/desactiva por cambio de cantidad."""
        if row >= self.cart_table.rowCount() or row >= len(self.cart):
            return
        from pos_system.ui.theme import COLORS as _T

        has_discount = item.get('discount_amount', 0) > 0
        promo_label = item.get('promo_label', '')
        name_text = item['product_name']

        # ── Col 0: Producto (nombre + sub-línea promo si aplica) ──
        if has_discount:
            orig = item.get('original_price', item['unit_price'])
            disc_total = (orig - item['unit_price']) * item['quantity']
            w = QWidget()
            wl = QVBoxLayout(w); wl.setContentsMargins(12, 4, 8, 4); wl.setSpacing(2)
            n = QLabel(name_text)
            n.setStyleSheet(
                f"color:{_T['text']}; font-size:12px; font-weight:600;"
                f" background:transparent; border:none;"
            )
            tag = (promo_label or 'Promo').upper()[:24]
            sub = QLabel(
                f"<span style='color:{_T['accent']};'>● {tag}</span>"
                f"  <span style='color:{_T['text_muted']};'>·</span>"
                f"  <b style='color:{_T['accent']};font-family:\"JetBrains Mono\",Consolas,monospace;'>"
                f"-${disc_total:,.0f}</b>"
            )
            sub.setStyleSheet(f"font-size:10px; background:transparent; border:none;")
            sub.setToolTip(promo_label or 'Descuento aplicado')
            wl.addWidget(n); wl.addWidget(sub); wl.addStretch(1)
            self.cart_table.setCellWidget(row, 0, w)
            self.cart_table.setItem(row, 0, QTableWidgetItem(''))
            self.cart_table.setRowHeight(row, 56)
        else:
            self.cart_table.removeCellWidget(row, 0)
            name_item = QTableWidgetItem(name_text)
            name_item.setFont(QFont('Segoe UI', 10))
            name_item.setForeground(QColor(_T['text']))
            name_item.setToolTip(name_text)
            self.cart_table.setItem(row, 0, name_item)
            self.cart_table.setRowHeight(row, 44)

        # ── Col 2: Subtotal (con tachado del precio original si hay descuento) ──
        if has_discount:
            orig = item.get('original_price', item['unit_price'])
            orig_total = orig * item['quantity']
            self.cart_table.removeCellWidget(row, 2)
            w = QWidget()
            wl = QVBoxLayout(w); wl.setContentsMargins(8, 4, 12, 4); wl.setSpacing(0)
            wl.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
            strike = QLabel(f"<s>${orig_total:,.0f}</s>")
            strike.setStyleSheet(
                f"color:{_T['text_dim']}; font-size:10px; background:transparent;"
                f" border:none; font-family:'JetBrains Mono', Consolas, monospace;"
            )
            strike.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
            final = QLabel(f"${item['subtotal']:,.0f}")
            final.setStyleSheet(
                f"color:{_T['accent']}; font-size:13px; font-weight:700; background:transparent;"
                f" border:none; font-family:'JetBrains Mono', Consolas, monospace;"
            )
            final.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
            wl.addWidget(strike); wl.addWidget(final)
            self.cart_table.setCellWidget(row, 2, w)
            self.cart_table.setItem(row, 2, QTableWidgetItem(''))
        else:
            self.cart_table.removeCellWidget(row, 2)
            sub_item = QTableWidgetItem(f'${item["subtotal"]:,.0f}')
            sub_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            sub_item.setFont(QFont('Consolas', 11, QFont.Bold))
            sub_item.setForeground(QColor(_T['text']))
            self.cart_table.setItem(row, 2, sub_item)

        self._refresh_cart_totals(row)

    def _refresh_cart_totals(self, row=None):
        """Light update: sólo subtotal de la fila y total global.
        NO reconstruye la tabla — preserva el spinbox con foco y texto intacto
        mientras el cajero sigue tipeando."""
        if row is not None and row < len(self.cart):
            item = self.cart[row]
            # Si la fila NO tiene cellWidget en col 2 (sin descuento), actualizamos el
            # text item simple. Si tiene widget (con descuento), no lo tocamos acá —
            # _refresh_cart_row_pricing ya lo manejó.
            if self.cart_table.cellWidget(row, 2) is None:
                sub_it = self.cart_table.item(row, 2)
                if sub_it:
                    sub_it.setText(f'${item["subtotal"]:,.0f}')
        # Total y contador
        total = sum(item['subtotal'] for item in self.cart)
        total_items = sum(float(item['quantity']) for item in self.cart)
        items_str = _fmt_qty(total_items)
        self.items_count_lbl.setText(f'{items_str} item{"s" if total_items != 1 else ""}')
        total_str = f'${total:,.2f}'
        font_size = 24 if len(total_str) <= 10 else (20 if len(total_str) <= 13 else 17)
        total_discount = sum(item.get('discount_amount', 0) for item in self.cart)
        if total_discount > 0:
            self.total_amount_label.setText(
                f'<span style="font-size:12px;color:#3d7a3a;font-weight:normal;">'
                f'Ahorro: ${total_discount:,.2f}</span><br>'
                f'<b style="color:#3d7a3a;font-size:{font_size}px;">{total_str}</b>'
            )
            self.total_amount_label.setTextFormat(Qt.RichText)
        else:
            self.total_amount_label.setFont(QFont('Segoe UI', font_size, QFont.Bold))
            self.total_amount_label.setText(total_str)
            self.total_amount_label.setTextFormat(Qt.PlainText)
        try:
            self._update_change()
        except Exception:
            pass
            
    def remove_from_cart(self, row):
        if row < len(self.cart):
            del self.cart[row]
            self.update_cart_display()

    def _on_cart_cell_clicked(self, row, col):
        """Click en col 2 (Subtotal) abre dialog para editar el precio unitario."""
        if col != 2:
            return
        if row >= len(self.cart):
            return
        item = self.cart[row]
        current_price = item['unit_price']

        dialog = QDialog(self)
        dialog.setWindowTitle('Editar precio')
        dialog.setWindowFlags(dialog.windowFlags() & ~Qt.WindowContextHelpButtonHint)
        dialog.setFixedWidth(300)
        layout = QVBoxLayout(dialog)
        layout.setSpacing(12)
        layout.setContentsMargins(16, 16, 16, 16)

        lbl = QLabel(f'<b>{item["product_name"]}</b><br>'
                     f'<span style="color:#6f6a5d;font-size:11px;">Precio actual: ${current_price:,.0f}</span>')
        lbl.setWordWrap(True)
        layout.addWidget(lbl)

        price_spin = QDoubleSpinBox()
        price_spin.setMinimum(0)
        price_spin.setMaximum(99_999_999)
        price_spin.setDecimals(0)
        price_spin.setSingleStep(100)
        price_spin.setValue(current_price)
        price_spin.setPrefix('$ ')
        price_spin.setFont(QFont('Segoe UI', 13, QFont.Bold))
        price_spin.setMinimumHeight(44)
        price_spin.setStyleSheet('QDoubleSpinBox { border: 2px solid #c1521f; border-radius: 6px; padding: 4px 8px; }')
        # Si el precio actual es 0 (caso Varios 2 recién creado), dejar el campo
        # vacío para que el cajero tipee directamente sin tener que borrar el "0".
        if current_price <= 0:
            try:
                price_spin.lineEdit().clear()
            except Exception:
                pass
        else:
            price_spin.selectAll()
        layout.addWidget(price_spin)

        obs_lbl = QLabel('Observación (opcional):')
        obs_lbl.setStyleSheet('color:#5a5448;font-size:11px;margin-top:4px')
        layout.addWidget(obs_lbl)
        obs_input = QTextEdit()
        obs_input.setPlainText(item.get('observation', '') or '')
        obs_input.setPlaceholderText('Ej: detalle, aclaración, nota del producto...')
        obs_input.setMaximumHeight(64)
        obs_input.setStyleSheet('QTextEdit { border: 1px solid #dcd6c8; border-radius: 6px; padding: 4px 6px; }')
        layout.addWidget(obs_input)

        btn_row = QHBoxLayout()
        cancel_btn = QPushButton('Cancelar')
        cancel_btn.setObjectName('btnSecondary')
        cancel_btn.clicked.connect(dialog.reject)
        ok_btn = QPushButton('Aplicar')
        ok_btn.setObjectName('btnPrimary')
        ok_btn.setDefault(True)
        ok_btn.clicked.connect(dialog.accept)
        btn_row.addWidget(cancel_btn)
        btn_row.addWidget(ok_btn)
        layout.addLayout(btn_row)

        if dialog.exec_() == QDialog.Accepted:
            new_price = price_spin.value()
            new_obs = obs_input.toPlainText().strip()
            changed = False
            if new_price != current_price:
                item['unit_price'] = new_price
                item['original_price'] = item.get('original_price', current_price)
                item['discount_amount'] = 0
                item['discount_type'] = None
                item['discount_value'] = 0
                item['promo_id'] = None
                item['promo_label'] = ''
                item['subtotal'] = round(item['quantity'] * new_price, 2)
                changed = True
            if new_obs != (item.get('observation', '') or ''):
                item['observation'] = new_obs
                changed = True
            if changed:
                self.update_cart_display()

    def clear_cart(self):
        if self.cart:
            reply = QMessageBox.question(
                self, 'Confirmar',
                'Desea limpiar el carrito?',
                QMessageBox.Yes | QMessageBox.No, QMessageBox.No
            )
            if reply == QMessageBox.Yes:
                self.cart = []
                self.update_cart_display()

    def complete_sale(self):
        from PyQt5.QtWidgets import QMessageBox
        if not self.cart:
            QMessageBox.warning(self, 'Carrito vacio', 'Agregue productos al carrito antes de facturar')
            return

        # Modo Varios 2: todos los items son is_varios_2 → flujo exclusivo factura AFIP
        if all(it.get('is_varios_2') for it in self.cart):
            self._emit_factura_varios_2()
            return

        current_register = self.cash_register_model.get_current()
        if not current_register:
            QMessageBox.warning(self, 'Caja cerrada',
                                'Debe abrir la caja antes de realizar ventas.\n\nVaya a la seccion de Caja.')
            return

        total = sum(item['subtotal'] for item in self.cart)

        # Abrir dialogo de pago
        dialog = PaymentDialog(self, total=total, cart=self.cart)
        if dialog.exec_() != QDialog.Accepted:
            return

        payment_type = dialog.payment_type
        cash_received = dialog.cash_received
        change_given = dialog.change_given
        selected_profile = dialog.selected_profile
        selected_cliente = dialog.selected_cliente
        payment_subtype = dialog.payment_subtype
        nota_factura = dialog.nota_factura

        # Resolver nombre del cajero de turno
        turno_nombre = (
            self.current_user.get('turno_nombre')
            or self.current_user.get('full_name')
            or self.current_user.get('username', '')
        )

        sale_data = {
            'total_amount':    total,
            'payment_type':    payment_type,
            'payment_subtype': payment_subtype,
            'cash_received':   cash_received,
            'change_given':    change_given,
            'items':           self.cart,
            'user_id':         self.current_user.get('id'),
            'turno_nombre':    turno_nombre,
        }

        try:
            sale_id = self.sale_model.create(sale_data)
            if sale_id:
                sale = self.sale_model.get_by_id(sale_id)

                # ── Persistir observaciones de items (incluye VARIOS) ──
                # Mira tanto 'observation' (items normales editados desde el carrito)
                # como 'pending_observation' (items VARIOS creados via VariosItemDialog).
                # Antes el VARIOS creaba su obs en _add_varios_item con sale_id=None →
                # quedaba huerfana en Firestore. Ahora se crea acá con el sale_id real.
                try:
                    def _obs_text(it):
                        return (it.get('observation') or it.get('pending_observation') or '').strip()
                    items_with_obs = [it for it in self.cart if _obs_text(it)]
                    if items_with_obs:
                        from pos_system.models.observation import Observation
                        from pos_system.utils.firebase_sync import get_firebase_sync, now_ar, _get_pc_id
                        obs_model = Observation(self.db)
                        u = self.current_user or {}
                        uname = u.get('full_name') or u.get('username') or 'Cajero'
                        pc = _get_pc_id()
                        created_at = now_ar().strftime('%Y-%m-%d %H:%M:%S')
                        fb = get_firebase_sync()
                        for it in items_with_obs:
                            obs_raw = _obs_text(it)
                            prefix = 'Varios' if it.get('is_varios') else (it.get('product_name', 'Item'))
                            # Para items normales: "[Producto] obs". Para VARIOS: "[Varios] nombre: obs"
                            if it.get('is_varios'):
                                text = f"[Varios] {it.get('product_name', 'Item')}: {obs_raw}"
                            else:
                                text = f"[{prefix}] {obs_raw}"
                            obs_id = obs_model.create(
                                text=text, context='sale',
                                sale_id=sale_id, sale_item_id=None,
                                created_by_id=u.get('id'),
                                created_by_name=str(uname), pc_id=pc
                            )
                            if fb:
                                fb.sync_observation(obs_id, {
                                    'text': text, 'context': 'sale',
                                    'sale_id': sale_id,
                                    'created_by_id': u.get('id'),
                                    'created_by_name': str(uname),
                                    'pc_id': pc, 'created_at': created_at,
                                }, db_manager=self.db)
                except Exception as _e:
                    import logging as _log
                    _log.getLogger(__name__).warning(f"No se pudieron guardar observaciones de items: {_e}")

                # ── Firebase: subir venta automáticamente si hay caja abierta ──
                sale['username']     = turno_nombre
                sale['turno_nombre'] = turno_nombre
                sale['cajero']       = turno_nombre
                self._upload_sale_to_firebase(sale)

                # ── Factura ARCA si el usuario eligió un perfil en el cobro ──────
                if selected_profile:
                    from pos_system.ui.factura_dialog import FacturaDialog
                    auto_virt = (payment_type == 'transfer')
                    fac_dlg = FacturaDialog(
                        self, sale=sale, auto_virtual=auto_virt,
                        perfil=selected_profile, cliente_data=selected_cliente,
                        notas=nota_factura
                    )
                    accepted = fac_dlg.exec_() == QDialog.Accepted

                    if accepted and fac_dlg.pdf_path:
                        resp = QMessageBox.question(
                            self, 'Imprimir',
                            'Desea abrir/imprimir la factura?',
                            QMessageBox.Yes | QMessageBox.No,
                            QMessageBox.Yes
                        )
                        if resp == QMessageBox.Yes:
                            self.open_pdf(fac_dlg.pdf_path)
                else:
                    # Venta sin AFIP: ofrecer ticket de compra no fiscal
                    resp = QMessageBox.question(
                        self, 'Ticket de compra',
                        'Generar ticket de compra?',
                        QMessageBox.Yes | QMessageBox.No,
                        QMessageBox.No
                    )
                    if resp == QMessageBox.Yes:
                        try:
                            cli_name = ''
                            if selected_cliente:
                                cli_name = (selected_cliente.get('razon_social')
                                            or selected_cliente.get('nombre')
                                            or '').strip()
                            pdf_path = self.pdf_generator.generate_non_fiscal_ticket(
                                sale,
                                cajero_name=turno_nombre,
                                cliente_name=cli_name or 'Consumidor Final',
                            )
                            self.open_pdf(pdf_path)
                        except Exception as e:
                            QMessageBox.warning(
                                self, 'Ticket',
                                f'No se pudo generar el ticket: {e}'
                            )

                self.cart = []
                self.update_cart_display()
                self.reset_category_filter()

                main_window = self.get_main_window()
                if main_window:
                    main_window.refresh_all_views()
            else:
                QMessageBox.critical(self, 'Error', 'No se pudo registrar la venta')

        except Exception as e:
            QMessageBox.critical(self, 'Error', f'Error al registrar la venta: {str(e)}')


    def _upload_sale_to_firebase(self, sale: dict):
        """Sube la venta a Firebase en hilo de fondo, solo si hay una caja abierta."""
        import threading
        import logging as _log

        def _do():
            try:
                # Solo subir si hay caja abierta
                caja = self.db.get_current_cash_register()
                if not caja or caja.get('status') != 'open':
                    _log.getLogger(__name__).debug(
                        "Firebase: venta no subida — no hay caja abierta."
                    )
                    return

                from pos_system.utils.firebase_sync import get_firebase_sync
                fb = get_firebase_sync()
                if not fb or not fb.enabled:
                    return

                # Agregar cash_register_id al documento de Firebase
                sale_with_caja = dict(sale)
                sale_with_caja['cash_register_id'] = caja.get('id')

                fb.sync_sale(sale_with_caja)
                fb.sync_sale_detail_by_day(sale_with_caja, db_manager=self.db)
                # Propagar stock actualizado (ya descontado en SQLite) a Firebase
                try:
                    fb.sync_stock_after_sale(sale_with_caja.get('items') or [], self.db)
                except Exception as _se:
                    _log.getLogger(__name__).warning(f"Firebase stock post-venta: {_se}")
                _log.getLogger(__name__).info(
                    f"Firebase: Venta #{sale.get('id')} subida (caja #{caja.get('id')})."
                )
            except Exception as e:
                import logging
                logging.getLogger(__name__).warning(f"Firebase upload venta: {e}")

        threading.Thread(target=_do, daemon=True).start()

    # ── Item "Varios" (producto libre con observación opcional) ──
    def _add_varios_item(self):
        if any(it.get('is_varios_2') for it in self.cart):
            QMessageBox.warning(
                self, 'Carrito en modo Varios 2',
                'El carrito tiene items "Varios 2" (solo factura AFIP).\n'
                'No se pueden mezclar con items normales.'
            )
            return
        dlg = VariosItemDialog(self)
        if dlg.exec_() != QDialog.Accepted:
            return

        name       = dlg.product_name
        unit_price = dlg.unit_price
        qty        = dlg.qty
        obs_text   = dlg.observation

        # Agregar al carrito como item "suelto" (product_id = None).
        # El back-end maneja este item en la venta; el stock no se toca porque
        # no hay product_id en productos/inventario.
        cart_item = {
            'product_id':      0,  # sentinel "Varios" (ver db_manager.py)
            'product_name':    name,
            'quantity':        qty,
            'unit_price':      float(unit_price),
            'original_price':  float(unit_price),
            'discount_type':   None,
            'discount_value':  0,
            'discount_amount': 0,
            'promo_id':        None,
            'promo_label':     '',
            'subtotal':        round(float(unit_price) * qty, 2),
            'max_stock':       9999,
            'category':        'Varios',
            'is_varios':       True,
            'pending_observation': obs_text,
        }
        self.cart.append(cart_item)
        self.update_cart_display()
        # Nota: la observación NO se crea acá — quedaría con sale_id=None
        # (huérfana). El linker en complete_sale() la persiste con el sale_id
        # correcto leyendo it['pending_observation'].

    # ── Item "Varios 2" (SOLO factura AFIP, no afecta caja/ventas/historial) ──
    def _add_varios_2_item(self):
        # No mezclar con items normales: si hay algo que no es varios_2, avisar.
        has_normal = any(not it.get('is_varios_2') for it in self.cart)
        if has_normal:
            QMessageBox.warning(
                self, 'Varios 2 exclusivo',
                'El carrito tiene items normales.\n\n'
                '"Varios 2" emite factura AFIP directa y no registra venta,\n'
                'por eso no se puede mezclar con items que sí se venden.\n\n'
                'Cobrá primero los items actuales o limpiá el carrito.'
            )
            return

        # Mini-dialog custom: campo arranca VACÍO (no con 0,00 default).
        unit_price = self._ask_varios2_amount()
        if unit_price is None or unit_price <= 0:
            return

        cart_item = {
            'product_id':      0,
            'product_name':    'Varios 2',
            'quantity':        1,
            'unit_price':      float(unit_price),
            'original_price':  float(unit_price),
            'discount_type':   None,
            'discount_value':  0,
            'discount_amount': 0,
            'promo_id':        None,
            'promo_label':     '',
            'subtotal':        round(float(unit_price), 2),
            'max_stock':       9999,
            'category':        'Varios 2',
            'is_varios_2':     True,
        }
        self.cart.append(cart_item)
        self.update_cart_display()

    def _ask_varios2_amount(self):
        """Mini-dialog para pedir el monto de Varios 2 con campo vacío inicial."""
        from PyQt5.QtGui import QDoubleValidator
        from pos_system.ui.theme import COLORS as _C
        dlg = QDialog(self)
        dlg.setWindowTitle('Varios 2 — Solo Factura AFIP')
        dlg.setWindowFlags(dlg.windowFlags() & ~Qt.WindowContextHelpButtonHint)
        dlg.setFixedWidth(340)
        dlg.setStyleSheet(f"QDialog {{ background:{_C['bg']}; }}")
        lay = QVBoxLayout(dlg)
        lay.setContentsMargins(20, 20, 20, 16)
        lay.setSpacing(12)

        lbl = QLabel('Monto a facturar')
        lbl.setStyleSheet(
            f"color:{_C['text_muted']}; font-size:10px; font-weight:700;"
            f" letter-spacing:0.5px; background:transparent; border:none;"
        )
        lay.addWidget(lbl)

        inp = QLineEdit()
        inp.setPlaceholderText('Ej: 5000')
        inp.setMinimumHeight(46)
        inp.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        inp.setStyleSheet(
            f"QLineEdit {{ background:{_C['surface']}; border:2px solid {_C['accent']};"
            f" border-radius:8px; padding:6px 14px; color:{_C['text']};"
            f" font-size:20px; font-weight:700;"
            f" font-family:'Consolas','JetBrains Mono',monospace; }}"
        )
        v = QDoubleValidator(0.0, 99_999_999.0, 2, dlg)
        v.setNotation(QDoubleValidator.StandardNotation)
        inp.setValidator(v)
        lay.addWidget(inp)

        btn_row = QHBoxLayout(); btn_row.setSpacing(8)
        cancel = QPushButton('Cancelar')
        cancel.setMinimumHeight(36)
        cancel.setStyleSheet(
            f"QPushButton {{ background:{_C['surface']}; color:{_C['text']};"
            f" border:1px solid {_C['border']}; border-radius:6px; padding:6px 18px; font-weight:600; }}"
            f"QPushButton:hover {{ background:{_C['surface_alt']}; }}"
        )
        cancel.clicked.connect(dlg.reject)
        ok = QPushButton('Agregar')
        ok.setMinimumHeight(36)
        ok.setDefault(True)
        ok.setStyleSheet(
            f"QPushButton {{ background:{_C['accent']}; color:white;"
            f" border:none; border-radius:6px; padding:6px 22px; font-weight:700; }}"
            f"QPushButton:hover {{ background:{_C['accent_hover']}; }}"
        )
        ok.clicked.connect(dlg.accept)
        btn_row.addStretch(1); btn_row.addWidget(cancel); btn_row.addWidget(ok)
        lay.addLayout(btn_row)

        inp.setFocus()
        if dlg.exec_() != QDialog.Accepted:
            return None
        txt = inp.text().strip().replace(',', '.')
        if not txt:
            return None
        try:
            return float(txt)
        except ValueError:
            return None

    def _emit_factura_varios_2(self):
        """Flujo exclusivo para items Varios 2: factura AFIP directa,
        sin crear venta, sin tocar caja/historial/control total."""
        from PyQt5.QtWidgets import QMessageBox, QInputDialog
        from pos_system.ui.factura_dialog import FacturaDialog
        from pos_system.ui.cliente_perfil_dialog import ClientePerfilDialog

        # Cargar perfiles ARCA activos
        perfiles = self.db.execute_query(
            "SELECT * FROM perfiles_facturacion WHERE activo=1 ORDER BY nombre ASC"
        ) or []
        if not perfiles:
            QMessageBox.warning(
                self, 'Sin perfil ARCA',
                'No hay perfiles de facturación cargados.\n'
                'Creá uno en Fiscal → Perfiles ARCA.'
            )
            return

        if len(perfiles) == 1:
            perfil = perfiles[0]
        else:
            nombres = [f"{p['nombre']} — CUIT {p.get('cuit', '')}" for p in perfiles]
            choice, ok = QInputDialog.getItem(
                self, 'Perfil ARCA',
                'Seleccioná el emisor para facturar:',
                nombres, 0, False
            )
            if not ok:
                return
            perfil = perfiles[nombres.index(choice)]

        # Cliente opcional (por defecto Consumidor Final)
        cliente_data = None
        reply = QMessageBox.question(
            self, 'Cliente',
            '¿Facturar a Consumidor Final?\n(No = elegir cliente cargado)',
            QMessageBox.Yes | QMessageBox.No, QMessageBox.Yes
        )
        if reply == QMessageBox.No:
            dlg_cli = ClientePerfilDialog(self)
            if dlg_cli.exec_() == QDialog.Accepted and dlg_cli.selected_cliente:
                cliente_data = dlg_cli.selected_cliente

        total = sum(it['subtotal'] for it in self.cart)
        synthetic_sale = {
            'id':            None,
            'items':         list(self.cart),
            'total_amount':  total,
            'payment_type':  'cash',
            'payment_subtype': 'Efectivo',
            'is_varios_2':   True,
        }

        fac_dlg = FacturaDialog(
            self, sale=synthetic_sale, auto_virtual=False,
            perfil=perfil, cliente_data=cliente_data, notas=''
        )
        fac_dlg.es_varios_2 = True
        accepted = fac_dlg.exec_() == QDialog.Accepted

        if accepted and fac_dlg.pdf_path:
            resp = QMessageBox.question(
                self, 'Factura emitida',
                f'Factura Varios 2 emitida por ${total:,.2f}\n'
                '(no se registró venta ni movimiento de caja).\n\n'
                '¿Abrir el PDF?',
                QMessageBox.Yes | QMessageBox.No, QMessageBox.Yes
            )
            if resp == QMessageBox.Yes:
                self.open_pdf(fac_dlg.pdf_path)

            self.cart = []
            self.update_cart_display()
            self.reset_category_filter()


class SpotlightDialog(QDialog):
    """Búsqueda rápida estilo Spotlight: overlay flotante, input + lista + atajos.

    Reemplaza el ProductSearchDialog antiguo (fullscreen) con una experiencia
    minimalista al estilo del mockup PosNew.
    """
    product_selected = pyqtSignal(dict)

    def __init__(self, parent=None, db=None, initial_text=''):
        from PyQt5.QtWidgets import QApplication, QGraphicsDropShadowEffect
        from PyQt5.QtGui import QColor
        super().__init__(parent)
        self.db = db
        self._results = []
        self.setWindowFlags(Qt.Dialog | Qt.FramelessWindowHint)
        self.setModal(True)
        self.setAttribute(Qt.WA_TranslucentBackground, True)

        from pos_system.ui.theme import COLORS as _C

        screen = QApplication.primaryScreen().availableGeometry()
        w = min(640, int(screen.width() * 0.55))
        h = 480
        self.setFixedWidth(w + 40)
        self.resize(w + 40, h + 40)
        self.move(
            screen.x() + (screen.width()  - (w + 40)) // 2,
            screen.y() + (screen.height() - (h + 40)) // 2,
        )

        self._search_timer = QTimer(self)
        self._search_timer.setSingleShot(True)
        self._search_timer.setInterval(220)
        self._search_timer.timeout.connect(self._do_search)

        self._build_ui()

        # Sombra alrededor del frame interno
        try:
            shadow = QGraphicsDropShadowEffect(self)
            shadow.setBlurRadius(40)
            shadow.setOffset(0, 6)
            shadow.setColor(QColor(0, 0, 0, 90))
            self._shell.setGraphicsEffect(shadow)
        except Exception:
            pass

        if initial_text:
            self.search_input.setText(initial_text)
        else:
            self._do_search()

    def _build_ui(self):
        from pos_system.ui.theme import COLORS as _C
        # Layout exterior con margen para que la sombra del shell sea visible
        wrap = QVBoxLayout(self)
        wrap.setContentsMargins(20, 20, 20, 20)
        wrap.setSpacing(0)

        # Shell (frame interno con borde y radius — donde se aplica la sombra)
        self._shell = QFrame()
        self._shell.setStyleSheet(
            f"QFrame {{ background:{_C['surface']}; border:1px solid {_C['border']};"
            f" border-radius:12px; }}"
        )
        wrap.addWidget(self._shell)

        outer = QVBoxLayout(self._shell)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        # ── Bar superior: lupa + input + Esc chip ──
        bar = QFrame()
        bar.setStyleSheet(
            f"QFrame {{ border:none; border-bottom:1px solid {_C['border_soft']};"
            f" background:{_C['surface']};"
            f" border-top-left-radius:12px; border-top-right-radius:12px; }}"
        )
        bar_l = QHBoxLayout(bar); bar_l.setContentsMargins(14, 14, 14, 14); bar_l.setSpacing(10)

        icon = QLabel('⌕')
        icon.setStyleSheet(
            f"color:{_C['text_muted']}; font-size:18px; background:transparent; border:none;"
        )
        bar_l.addWidget(icon)

        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText('Código, nombre, categoría…')
        self.search_input.setStyleSheet(
            f"QLineEdit {{ border:none; background:transparent; font-size:16px;"
            f" color:{_C['text']}; padding:2px; }}"
        )
        f = QFont('Segoe UI', 13)
        self.search_input.setFont(f)
        self.search_input.textChanged.connect(self._on_text)
        self.search_input.installEventFilter(self)
        bar_l.addWidget(self.search_input, 1)

        esc = QPushButton('Esc')
        esc.setCursor(Qt.PointingHandCursor)
        esc.setStyleSheet(
            f"QPushButton {{ background:{_C['surface_alt']}; border:1px solid {_C['border']};"
            f" border-radius:4px; padding:4px 10px; color:{_C['text_muted']};"
            f" font-family:'JetBrains Mono', Consolas, monospace; font-size:10px;"
            f" font-weight:600; min-height:18px; }}"
            f"QPushButton:hover {{ background:{_C['border_soft']}; color:{_C['text']}; }}"
        )
        esc.clicked.connect(self.reject)
        bar_l.addWidget(esc)

        outer.addWidget(bar)

        # ── Lista de resultados ──
        self.list = QListWidget()
        self.list.setStyleSheet(
            f"QListWidget {{ border:none; background:{_C['surface']};"
            f" outline:none; font-size:13px; }}"
            f"QListWidget::item {{ padding:0; border-bottom:1px solid {_C['border_soft']}; }}"
            f"QListWidget::item:selected {{ background:{_C['accent_soft']}; color:{_C['text']};"
            f" border-left:3px solid {_C['accent']}; }}"
            f"QListWidget::item:hover:!selected {{ background:{_C['surface_alt']}; }}"
        )
        # Solo doubleClicked — itemActivated también dispararía con Enter del list,
        # pero ya manejamos Enter en eventFilter del input. Evita doble-add.
        self.list.itemDoubleClicked.connect(self._on_pick)
        outer.addWidget(self.list, 1)

        # ── Footer con atajos ──
        ft = QFrame()
        ft.setStyleSheet(
            f"QFrame {{ background:{_C['surface_alt']}; border:none;"
            f" border-top:1px solid {_C['border_soft']};"
            f" border-bottom-left-radius:12px; border-bottom-right-radius:12px; }}"
        )
        ft_l = QHBoxLayout(ft); ft_l.setContentsMargins(14, 8, 14, 8); ft_l.setSpacing(14)
        for keys, label in [('↑↓', 'navegar'), ('↵', 'agregar'), ('Esc', 'cerrar')]:
            chip = QLabel(keys)
            chip.setStyleSheet(
                f"background:{_C['surface']}; border:1px solid {_C['border']};"
                f" border-radius:3px; padding:2px 6px; color:{_C['text_muted']};"
                f" font-family:'JetBrains Mono', Consolas, monospace; font-size:10px;"
            )
            lbl = QLabel(label)
            lbl.setStyleSheet(f"color:{_C['text_muted']}; font-size:11px; background:transparent;")
            ft_l.addWidget(chip); ft_l.addWidget(lbl)
        ft_l.addStretch(1)
        outer.addWidget(ft)

    def _on_text(self, _):
        self._search_timer.start()

    def _do_search(self):
        text = self.search_input.text().strip()
        try:
            from pos_system.models.product import Product
            pm = Product(self.db)
            results = pm.get_all(search=text) if text else pm.get_all()
        except Exception:
            results = []
        # Excluir sentinel "Varios" (id=0)
        results = [r for r in results if r.get('id', 0) > 0][:30]
        self._results = results
        self._render()

    def _render(self):
        """Render simple usando QListWidgetItem.setText con HTML embebido.
        Evita el problema visual de cellWidget que no respeta selection-background.
        """
        from pos_system.ui.theme import COLORS as _C
        self.list.clear()
        for p in self._results:
            cat = p.get('category') or 'Sin categoría'
            stock = p.get('stock', 0)
            es_conj = int(p.get('es_conjunto') or 0) == 1
            if es_conj:
                stock_txt = f"{p.get('conjunto_total') or 0:.0f} {p.get('conjunto_unidad_medida') or ''}".strip()
            else:
                stock_txt = f"{stock} un"
            barcode = p.get('barcode') or ''
            price_txt = f"${p.get('price', 0):,.0f}"
            # Texto principal (nombre) y subtexto (codigo/categoria/stock) van como
            # un solo string con \n. Stylesheet del QListWidget pinta padding/border.
            line1 = f"{p.get('name', '—')}"
            sub = f"{barcode}  ·  {cat}  ·  stock: {stock_txt}"
            item = QListWidgetItem()
            item.setData(Qt.UserRole, p)
            item.setData(Qt.UserRole + 1, line1)
            item.setData(Qt.UserRole + 2, sub)
            item.setData(Qt.UserRole + 3, price_txt)
            item.setSizeHint(QSize(0, 56))
            self.list.addItem(item)
        # Custom paint via delegate
        if not hasattr(self, '_delegate_set'):
            from PyQt5.QtWidgets import QStyledItemDelegate, QStyle
            from PyQt5.QtGui import QPalette, QPen
            spotlight_self = self
            class _Delegate(QStyledItemDelegate):
                def paint(self, painter, option, index):
                    p_data = index.data(Qt.UserRole + 1) or ''
                    sub = index.data(Qt.UserRole + 2) or ''
                    price = index.data(Qt.UserRole + 3) or ''
                    r = option.rect
                    selected = bool(option.state & QStyle.State_Selected)
                    hover = bool(option.state & QStyle.State_MouseOver)
                    painter.save()
                    painter.fillRect(r,
                        QColor(_C['accent_soft']) if selected else
                        (QColor(_C['surface_alt']) if hover else QColor(_C['surface']))
                    )
                    if selected:
                        painter.fillRect(r.x(), r.y(), 3, r.height(), QColor(_C['accent']))
                    # Bottom border
                    painter.setPen(QPen(QColor(_C['border_soft']), 1))
                    painter.drawLine(r.x(), r.y() + r.height() - 1, r.x() + r.width(), r.y() + r.height() - 1)
                    # Texto nombre
                    f1 = QFont('Segoe UI', 10, QFont.Bold)
                    painter.setFont(f1)
                    painter.setPen(QColor(_C['text']))
                    name_rect = r.adjusted(16, 8, -120, -28)
                    painter.drawText(name_rect, Qt.AlignLeft | Qt.AlignTop, p_data)
                    # Sub
                    f2 = QFont('Consolas', 9)
                    painter.setFont(f2)
                    painter.setPen(QColor(_C['text_muted']))
                    sub_rect = r.adjusted(16, 30, -120, -8)
                    painter.drawText(sub_rect, Qt.AlignLeft | Qt.AlignTop, sub)
                    # Precio
                    f3 = QFont('Consolas', 11, QFont.Bold)
                    painter.setFont(f3)
                    painter.setPen(QColor(_C['text']))
                    price_rect = r.adjusted(0, 0, -16, 0)
                    painter.drawText(price_rect, Qt.AlignRight | Qt.AlignVCenter, price)
                    painter.restore()
            self.list.setItemDelegate(_Delegate(self.list))
            self._delegate_set = True
        if self._results:
            self.list.setCurrentRow(0)

    def _on_pick(self, item):
        # Guard: evitar doble emisión por doble-click + activated
        if getattr(self, '_picking', False):
            return
        if not item:
            return
        p = item.data(Qt.UserRole)
        if not p:
            return
        self._picking = True
        self.product_selected.emit(p)
        self.accept()

    def eventFilter(self, obj, event):
        from PyQt5.QtCore import QEvent
        if obj is self.search_input and event.type() == QEvent.KeyPress:
            key = event.key()
            if key in (Qt.Key_Down, Qt.Key_Up):
                row = self.list.currentRow()
                if key == Qt.Key_Down:
                    row = min(row + 1, self.list.count() - 1)
                else:
                    row = max(row - 1, 0)
                if row >= 0:
                    self.list.setCurrentRow(row)
                return True
            if key in (Qt.Key_Return, Qt.Key_Enter):
                self._on_pick(self.list.currentItem())
                return True
            if key == Qt.Key_Escape:
                self.reject()
                return True
        return super().eventFilter(obj, event)

    def keyPressEvent(self, event):
        if event.key() == Qt.Key_Escape:
            self.reject()
            return
        super().keyPressEvent(event)


class PromosQuickDialog(QDialog):
    """Dialog rápido de promociones activas. Click en una promo → emite product_chosen
    con el product_id para que el caller lo agregue al carrito.

    Replica el mockup PromoDialog: cards con nombre + condición + descuento.
    """
    product_chosen = pyqtSignal(int, int)  # (product_id, cantidad_a_agregar)

    def __init__(self, parent=None, firebase_promos=None):
        super().__init__(parent)
        self.fb_promos = firebase_promos or []
        self._db = getattr(parent, 'db', None)
        self._product_model = getattr(parent, 'product_model', None)
        self.setWindowTitle('Promociones')
        self.setModal(True)
        self.setMinimumWidth(560)
        self._build_ui()

    def _build_ui(self):
        from pos_system.ui.theme import COLORS as _C
        self.setStyleSheet(f"QDialog {{ background:{_C['bg']}; }}")
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        # Header
        hdr = QFrame()
        hdr.setStyleSheet(f"QFrame {{ background:{_C['surface']}; border-bottom:1px solid {_C['border_soft']}; }}")
        h_lay = QHBoxLayout(hdr); h_lay.setContentsMargins(20, 14, 14, 14); h_lay.setSpacing(12)
        title_box = QVBoxLayout(); title_box.setSpacing(2)
        t = QLabel('Aplicar promoción'); t.setStyleSheet(
            f"color:{_C['text']}; font-size:14px; font-weight:700; background:transparent; border:none;")
        s = QLabel('Promos activas hoy'); s.setStyleSheet(
            f"color:{_C['text_muted']}; font-size:11px; background:transparent; border:none;"
            f" font-family:'Consolas','JetBrains Mono',monospace;")
        title_box.addWidget(t); title_box.addWidget(s)
        h_lay.addLayout(title_box, 1)
        close = QPushButton('×'); close.setFixedSize(28, 28); close.setCursor(Qt.PointingHandCursor)
        close.setStyleSheet(
            f"QPushButton {{ background:{_C['surface_alt']}; border:1px solid {_C['border_soft']};"
            f" border-radius:14px; color:{_C['text_muted']}; font-size:16px; font-weight:700; }}"
            f"QPushButton:hover {{ background:{_C['border_soft']}; }}")
        close.clicked.connect(self.reject)
        h_lay.addWidget(close)
        outer.addWidget(hdr)

        # Body con scroll de promos
        body = QFrame(); body.setStyleSheet(f"background:{_C['bg']};")
        b_lay = QVBoxLayout(body); b_lay.setContentsMargins(20, 16, 20, 16); b_lay.setSpacing(8)

        promos = self._gather_promos()
        if not promos:
            empty = QLabel('No hay promociones activas en este momento.')
            empty.setStyleSheet(
                f"color:{_C['text_muted']}; font-size:13px; padding:30px; background:transparent;")
            empty.setAlignment(Qt.AlignCenter)
            b_lay.addWidget(empty)
        else:
            for p in promos:
                b_lay.addWidget(self._build_promo_card(p))
        b_lay.addStretch(1)
        outer.addWidget(body, 1)

        # Footer
        ft = QFrame(); ft.setStyleSheet(
            f"QFrame {{ background:{_C['surface']}; border-top:1px solid {_C['border_soft']}; }}")
        ft_l = QHBoxLayout(ft); ft_l.setContentsMargins(20, 12, 20, 12)
        ft_l.addStretch(1)
        cancel = QPushButton('Cerrar')
        cancel.setMinimumHeight(36); cancel.setCursor(Qt.PointingHandCursor)
        cancel.setStyleSheet(
            f"QPushButton {{ background:{_C['surface']}; color:{_C['text']};"
            f" border:1px solid {_C['border']}; border-radius:6px; padding:6px 18px; font-weight:600; }}"
            f"QPushButton:hover {{ background:{_C['surface_alt']}; }}")
        cancel.clicked.connect(self.reject)
        ft_l.addWidget(cancel)
        outer.addWidget(ft)

    def _gather_promos(self):
        """Combina promos de Firebase + descuentos locales en una lista uniforme.
        Cada item incluye 'qty_min' = cantidad a agregar al carrito al activar la promo.
        """
        out = []
        for fb in self.fb_promos or []:
            if not fb.get('activo', True):
                continue
            tipo = fb.get('tipo', '')
            valor = fb.get('valor', 0)
            cant_min = int(fb.get('cantidad_minima') or 1)
            cant_req = int(fb.get('cantidad_requerida') or cant_min)
            qty_min = max(cant_min, cant_req, 1)
            if tipo == 'percentage':
                desc = f"-{valor:.0f}%"
            elif tipo == 'fixed':
                desc = f"-${valor:,.0f}"
            elif tipo in ('2x1', 'nxm'):
                paga = fb.get('cantidad_paga') or (cant_req - 1)
                desc = f"{cant_req}x{paga}"
                qty_min = cant_req
            else:
                desc = '-'
            out.append({
                'name': fb.get('nombre', 'Promo'),
                'cond': self._fmt_cond_firebase(fb),
                'desc': desc,
                'product_id': self._first_product_id(fb.get('productos') or []),
                'qty_min': qty_min,
                'source': 'firebase',
            })
        # Productos con descuento local
        try:
            if self._db:
                rows = self._db.execute_query(
                    "SELECT id, name, price, discount_type, discount_value FROM products "
                    "WHERE discount_type IS NOT NULL AND discount_value > 0 AND id != 0 LIMIT 30"
                ) or []
                for r in rows:
                    dt = (r.get('discount_type') or '')
                    dv = float(r.get('discount_value') or 0)
                    if dt == 'percentage':
                        desc = f"-{dv:.0f}%"
                    elif dt == 'fixed':
                        desc = f"-${dv:,.0f}"
                    else:
                        continue
                    out.append({
                        'name': r.get('name'),
                        'cond': f"Cualquier cantidad · ${r.get('price', 0):,.0f}",
                        'desc': desc,
                        'product_id': r.get('id'),
                        'qty_min': 1,
                        'source': 'local',
                    })
        except Exception:
            pass
        return out

    def _fmt_cond_firebase(self, fb):
        prods = fb.get('productos') or []
        if not prods:
            return 'Sin productos asociados'
        # Intentar resolver el nombre del primer producto
        try:
            first_id = prods[0]
            row = self._db.execute_query(
                "SELECT name FROM products WHERE firebase_id=? OR barcode=? OR CAST(id AS TEXT)=? LIMIT 1",
                (str(first_id), str(first_id), str(first_id))
            ) if self._db else None
            if row:
                name = row[0].get('name', '')
                more = f" + {len(prods)-1} más" if len(prods) > 1 else ''
                return f"{name}{more}"
        except Exception:
            pass
        return f"{len(prods)} producto(s)"

    def _first_product_id(self, prod_refs):
        """De una lista de refs (firebase_id/barcode/id) devuelve el id local del primero."""
        if not prod_refs or not self._db:
            return None
        try:
            row = self._db.execute_query(
                "SELECT id FROM products WHERE firebase_id=? OR barcode=? OR CAST(id AS TEXT)=? LIMIT 1",
                (str(prod_refs[0]), str(prod_refs[0]), str(prod_refs[0]))
            )
            return row[0]['id'] if row else None
        except Exception:
            return None

    def _build_promo_card(self, p):
        from pos_system.ui.theme import COLORS as _C
        card = QFrame()
        card.setCursor(Qt.PointingHandCursor)
        card.setStyleSheet(
            f"QFrame {{ background:{_C['surface']}; border:1px solid {_C['border']};"
            f" border-radius:8px; }}"
            f"QFrame:hover {{ background:{_C['accent_soft']}; border-color:{_C['accent']}; }}")
        lay = QHBoxLayout(card); lay.setContentsMargins(14, 12, 16, 12); lay.setSpacing(12)
        col = QVBoxLayout(); col.setSpacing(2)
        n = QLabel(p['name'])
        n.setStyleSheet(f"color:{_C['text']}; font-size:13px; font-weight:700; background:transparent; border:none;")
        # Sub-línea: condición + indicador "agregar Nx"
        cond_text = p['cond']
        qty_min = int(p.get('qty_min') or 1)
        if qty_min > 1:
            cond_text = f"{cond_text}  ·  agregará {qty_min} unidades"
        c = QLabel(cond_text)
        c.setStyleSheet(f"color:{_C['text_muted']}; font-size:11px; background:transparent; border:none;")
        col.addWidget(n); col.addWidget(c)
        lay.addLayout(col, 1)
        d = QLabel(p['desc'])
        d.setStyleSheet(
            f"color:{_C['accent']}; font-size:16px; font-weight:700; background:transparent; border:none;"
            f" font-family:'Consolas','JetBrains Mono',monospace;")
        d.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        lay.addWidget(d)
        # Hacer clickeable: emite (product_id, qty)
        pid = p.get('product_id')
        def _click(_evt, p_id=pid, q=qty_min):
            if p_id:
                self.product_chosen.emit(int(p_id), int(q))
                self.accept()
            else:
                QMessageBox.information(self, 'Promoción',
                    'Esta promoción no tiene productos vinculados.')
        card.mousePressEvent = _click
        return card


class PaymentDialog(QDialog):
    """Dialogo de cobro: seleccion de pago, monto y teclado numerico"""

    def __init__(self, parent=None, total: float = 0.0, cart=None):
        super().__init__(parent)
        self.total = total
        self.cart = cart or []
        self.payment_type = 'cash'
        self.cash_received = 0.0
        self.change_given = 0.0
        self._raw_amount = ""
        self.selected_profile = None
        self.selected_cliente = None
        self.payment_subtype = 'Efectivo'
        self.nota_factura = ''
        self._profiles = []
        self._profile_btns = []
        self._no_factura_btn = None
        self._subtype_btns = {}
        self._subtype_row_widget = None
        self._load_profiles()
        self.setWindowTitle('Cobrar')
        self.setModal(True)
        from PyQt5.QtWidgets import QApplication
        self._avail = QApplication.primaryScreen().availableGeometry()
        self.init_ui()
        w = max(520, min(680, int(self._avail.width() * 0.58)))
        self.setFixedWidth(w)
        self.adjustSize()
        self.move(
            self._avail.center().x() - self.width() // 2,
            max(self._avail.top() + 5, self._avail.center().y() - self.height() // 2)
        )

    def init_ui(self):
        # Escala dinámica: todo el contenido se ajusta al espacio disponible
        # Reservamos ~70px para la barra de botones + ~32px para la barra de título
        avail_h = getattr(self, '_avail', QApplication.primaryScreen().availableGeometry()).height()
        content_h = avail_h - 102
        # Base de diseño: 440px de contenido (con sub-tipos ocultos)
        _sc = max(0.72, min(1.0, content_h / 440))
        def _h(base): return max(int(base * _sc), int(base * 0.72))
        _np   = _h(38)   # numpad button
        _pay  = _h(34)   # efectivo/transferencia
        _sub  = _h(30)   # sub-tipo
        _prf  = _h(30)   # perfil ARCA
        _inp  = _h(40)   # amount input
        _sp   = max(4, _h(6))  # spacing

        self.setStyleSheet('''
            QDialog { background: #fafaf7; }
            QLabel#total_label {
                font-size: 22px; font-weight: 700; color: #1c1c1e;
                font-family: 'Consolas', 'JetBrains Mono', monospace;
            }
            /* ── Pills de medio de pago ───────────────────────────────── */
            QPushButton#btn_cash, QPushButton#btn_transfer {
                background: #ffffff;
                color: #6f6a5d;
                border: 1px solid #dcd6c8;
                border-radius: 8px;
                font-size: 13px;
                font-weight: 700;
                padding: 12px;
                letter-spacing: 0.3px;
            }
            QPushButton#btn_cash:hover, QPushButton#btn_transfer:hover {
                background: #fafaf7;
                color: #1c1c1e;
                border-color: #6f6a5d;
            }
            QPushButton#btn_cash:checked, QPushButton#btn_transfer:checked {
                background: #1c1c1e;
                color: #ffffff;
                border-color: #1c1c1e;
            }
            /* ── Numpad ───────────────────────────────────────────────── */
            QPushButton#numpad_btn {
                background: #ffffff;
                border: 1px solid #dcd6c8;
                border-radius: 8px;
                font-size: 16px;
                font-weight: 700;
                color: #1c1c1e;
                min-height: 44px;
                max-height: 44px;
                font-family: 'Consolas', 'JetBrains Mono', monospace;
            }
            QPushButton#numpad_btn:hover {
                background: #fafaf7;
                border-color: #c1521f;
                color: #c1521f;
            }
            QPushButton#numpad_btn:pressed {
                background: #fbeee5;
                border-color: #c1521f;
                color: #c1521f;
            }
            /* ── Borrar (outline rojo sutil) ──────────────────────────── */
            QPushButton#btn_clear {
                background: #ffffff;
                color: #a01616;
                border: 1px solid #a01616;
                border-radius: 8px;
                font-size: 13px;
                font-weight: 700;
                min-height: 44px;
                max-height: 44px;
            }
            QPushButton#btn_clear:hover {
                background: #a01616;
                color: #ffffff;
            }
            /* ── Cobrar (THE botón principal: accent) ─────────────────── */
            QPushButton#btn_facturar {
                background: #c1521f;
                color: #ffffff;
                border: none;
                border-radius: 8px;
                font-size: 15px;
                font-weight: 700;
                min-height: 52px;
                letter-spacing: 0.5px;
            }
            QPushButton#btn_facturar:hover {
                background: #a3441a;
            }
            QPushButton#btn_facturar:disabled {
                background: #c9c2b3;
                color: #ffffff;
            }
            /* ── Input de monto ───────────────────────────────────────── */
            QLineEdit#amount_input {
                font-size: 22px;
                font-weight: 700;
                color: #1c1c1e;
                border: 1px solid #dcd6c8;
                border-radius: 8px;
                padding: 8px 14px;
                background: #ffffff;
                font-family: 'Consolas', 'JetBrains Mono', monospace;
            }
            QLineEdit#amount_input:focus { border-color: #c1521f; }
        ''')

        # Layout exterior: contenido + barra fija de botones
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        _content_w = QWidget()
        main = QVBoxLayout(_content_w)
        main.setContentsMargins(14, max(4, _h(8)), 14, 4)
        main.setSpacing(_sp)

        # ── Fila superior: total ──
        total_row = QHBoxLayout()
        total_txt = QLabel('Total a cobrar:')
        total_txt.setFont(QFont('Segoe UI', 11))
        total_txt.setStyleSheet('color: #6f6a5d;')
        total_row.addWidget(total_txt)
        total_row.addStretch()
        self.total_lbl = QLabel(f'${self.total:,.2f}')
        self.total_lbl.setObjectName('total_label')
        self.total_lbl.setFont(QFont('Segoe UI', 20, QFont.Bold))
        total_row.addWidget(self.total_lbl)
        main.addLayout(total_row)

        sep = QFrame(); sep.setFrameShape(QFrame.HLine); sep.setStyleSheet('color:#dcd6c8;')
        main.addWidget(sep)

        # ── Items del carrito ──
        if self.cart:
            items_tbl = QTableWidget()
            items_tbl.setColumnCount(3)
            items_tbl.setHorizontalHeaderLabels(['Producto', 'Cant.', 'Subtotal'])
            items_tbl.setRowCount(len(self.cart))
            items_tbl.verticalHeader().setVisible(False)
            items_tbl.setEditTriggers(QAbstractItemView.NoEditTriggers)
            items_tbl.setSelectionMode(QAbstractItemView.NoSelection)
            items_tbl.setFocusPolicy(Qt.NoFocus)
            items_tbl.setFont(QFont('Segoe UI', 9))
            items_tbl.horizontalHeader().setFont(QFont('Segoe UI', 9, QFont.Bold))
            items_tbl.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
            items_tbl.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeToContents)
            items_tbl.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
            items_tbl.verticalHeader().setDefaultSectionSize(24)
            items_tbl.setStyleSheet('''
                QTableWidget { border: 1px solid #dcd6c8; border-radius: 6px; background: white; }
                QTableWidget::item { padding: 2px 6px; }
                QHeaderView::section { background: #fafaf7; padding: 3px; border: none; border-bottom: 1px solid #dcd6c8; }
            ''')
            for row, it in enumerate(self.cart):
                name = str(it.get('product_name') or it.get('name', ''))
                qty = it.get('quantity', 1)
                sub = float(it.get('subtotal', 0))
                items_tbl.setItem(row, 0, QTableWidgetItem(name))
                q_item = QTableWidgetItem(str(qty))
                q_item.setTextAlignment(Qt.AlignCenter)
                items_tbl.setItem(row, 1, q_item)
                s_item = QTableWidgetItem(f'${sub:,.2f}')
                s_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                items_tbl.setItem(row, 2, s_item)
            max_visible = min(len(self.cart), 2)
            row_h = max(18, _h(22))
            items_tbl.verticalHeader().setDefaultSectionSize(row_h)
            items_tbl.setFixedHeight(22 + row_h * max_visible + 2)
            main.addWidget(items_tbl)

        # ── Botones forma de pago ──
        pay_row = QHBoxLayout(); pay_row.setSpacing(8)
        self.btn_cash = QPushButton('Efectivo')
        self.btn_cash.setObjectName('btn_cash'); self.btn_cash.setCheckable(True)
        self.btn_cash.setChecked(True); self.btn_cash.setMinimumHeight(_pay)
        self.btn_cash.setFont(QFont('Segoe UI', 11, QFont.Bold))
        self.btn_cash.clicked.connect(lambda: self._set_payment('cash'))
        pay_row.addWidget(self.btn_cash)

        self.btn_transfer = QPushButton('Transferencia')
        self.btn_transfer.setObjectName('btn_transfer'); self.btn_transfer.setCheckable(True)
        self.btn_transfer.setMinimumHeight(_pay)
        self.btn_transfer.setFont(QFont('Segoe UI', 11, QFont.Bold))
        self.btn_transfer.clicked.connect(lambda: self._set_payment('transfer'))
        pay_row.addWidget(self.btn_transfer)
        main.addLayout(pay_row)

        # ── Sub-tipo de pago electrónico (visible solo con Transferencia) ──
        self._subtype_row_widget = QWidget()
        subtype_row = QHBoxLayout(self._subtype_row_widget)
        subtype_row.setContentsMargins(0, 0, 0, 0)
        subtype_row.setSpacing(6)

        for label, key in [('T. Débito', 'T. DEBITO'), ('T. Crédito', 'T. CREDITO'), ('Transferencia', 'Transferencia')]:
            sb = QPushButton(label)
            sb.setCheckable(True)
            sb.setMinimumHeight(_sub)
            sb.setFont(QFont('Segoe UI', 9, QFont.Bold))
            sb.setStyleSheet('''
                QPushButton { background:#fbeee5; color:#c1521f; border:1.5px solid #dcd6c8; border-radius:6px; padding:0 12px; }
                QPushButton:hover { background:#fbeee5; }
                QPushButton:checked { background:#c1521f; color:white; border-color:#c1521f; }
            ''')
            sb.clicked.connect(lambda _, k=key, b=sb: self._set_subtype(k, b))
            subtype_row.addWidget(sb)
            self._subtype_btns[key] = sb

        subtype_row.addStretch()
        self._subtype_row_widget.setVisible(False)
        main.addWidget(self._subtype_row_widget)

        # ── Layout horizontal: izquierda (datos) | derecha (numpad) ──
        h_layout = QHBoxLayout(); h_layout.setSpacing(12)

        # ── Columna izquierda: pago + acciones ────────────────────────────
        left_col = QWidget()
        left = QVBoxLayout(left_col); left.setContentsMargins(0, 0, 0, 0); left.setSpacing(_sp)

        # Panel efectivo
        self.cash_panel = QWidget()
        cp = QVBoxLayout(self.cash_panel); cp.setContentsMargins(0, 0, 0, 0); cp.setSpacing(_sp)
        lbl_paga = QLabel('Cliente paga con:')
        lbl_paga.setFont(QFont('Segoe UI', 10, QFont.Bold))
        lbl_paga.setStyleSheet('color:#5a5448;')
        cp.addWidget(lbl_paga)
        self.amount_input = QLineEdit()
        self.amount_input.setObjectName('amount_input')
        self.amount_input.setPlaceholderText('0.00')
        self.amount_input.setAlignment(Qt.AlignRight)
        self.amount_input.setMinimumHeight(_inp)
        self.amount_input.setFont(QFont('Segoe UI', 20, QFont.Bold))
        self.amount_input.setReadOnly(True)
        cp.addWidget(self.amount_input)
        change_frame = QFrame()
        change_frame.setStyleSheet('QFrame{background:#f0fdf4;border:2px solid #3d7a3a;border-radius:8px;}')
        ci = QHBoxLayout(change_frame); ci.setContentsMargins(12, 6, 12, 6)
        lbl_vuelto = QLabel('Vuelto:')
        lbl_vuelto.setFont(QFont('Segoe UI', 10, QFont.Bold))
        lbl_vuelto.setStyleSheet('color:#3d7a3a;background:transparent;border:none;')
        ci.addWidget(lbl_vuelto); ci.addStretch()
        self.change_lbl = QLabel('$0.00')
        self.change_lbl.setFont(QFont('Segoe UI', 16, QFont.Bold))
        self.change_lbl.setStyleSheet('color:#16a34a;background:transparent;border:none;')
        ci.addWidget(self.change_lbl)
        cp.addWidget(change_frame)
        left.addWidget(self.cash_panel)

        # Panel transferencia
        self.transfer_panel = QWidget()
        tl = QVBoxLayout(self.transfer_panel); tl.setContentsMargins(0, 0, 0, 0)
        info = QLabel('El cliente realiza la\ntransferencia o pago virtual.')
        info.setFont(QFont('Segoe UI', 10))
        info.setStyleSheet('background:#fbeee5;color:#c1521f;border:1px solid #dcd6c8;border-radius:8px;padding:12px;')
        info.setAlignment(Qt.AlignCenter); info.setWordWrap(True)
        tl.addWidget(info)
        self.transfer_panel.setVisible(False)
        left.addWidget(self.transfer_panel)

        left.addStretch(1)

        # ── COBRAR ────────────────────────────────────────────────────────
        self.facturar_btn = QPushButton('COBRAR')
        self.facturar_btn.setObjectName('btn_facturar')
        self.facturar_btn.setMinimumHeight(_h(50))
        self.facturar_btn.setFont(QFont('Segoe UI', 14, QFont.Bold))
        self.facturar_btn.clicked.connect(self._confirm)
        left.addWidget(self.facturar_btn)

        # ── Ver factura (solo si hay perfiles ARCA) ───────────────────────
        if self._profiles:
            self._preview_btn = QPushButton('Ver factura')
            self._preview_btn.setMinimumHeight(_h(32))
            self._preview_btn.setFont(QFont('Segoe UI', 10))
            self._preview_btn.setToolTip('Vista previa del PDF (seleccioná un perfil ARCA primero)')
            self._preview_btn.setStyleSheet('''
                QPushButton { background:#f0f4ff; color:#c1521f; border:1.5px solid #dcd6c8; border-radius:8px; padding:0 10px; }
                QPushButton:hover { background:#dbeafe; }
            ''')
            self._preview_btn.clicked.connect(self._preview_invoice)
            left.addWidget(self._preview_btn)

        # ── Añadir nota a la factura ──────────────────────────────────────
        self._nota_btn = QPushButton('+ Añadir nota a la factura')
        self._nota_btn.setMinimumHeight(_h(26))
        self._nota_btn.setFont(QFont('Segoe UI', 9))
        self._nota_btn.setCheckable(True)
        self._nota_btn.setStyleSheet('''
            QPushButton { background:transparent; color:#6f6a5d; border:none; text-align:left; padding:0 2px; }
            QPushButton:hover { color:#343a40; }
            QPushButton:checked { color:#3d7a3a; font-weight:bold; }
        ''')
        self._nota_btn.clicked.connect(self._toggle_nota)
        left.addWidget(self._nota_btn)

        self._nota_input = QLineEdit()
        self._nota_input.setPlaceholderText('Observaciones para la factura...')
        self._nota_input.setFont(QFont('Segoe UI', 9))
        self._nota_input.setMinimumHeight(_h(30))
        self._nota_input.setVisible(False)
        left.addWidget(self._nota_input)

        h_layout.addWidget(left_col, 1)

        # Numpad (derecha)
        numpad_widget = QWidget()
        numpad = QGridLayout(numpad_widget); numpad.setSpacing(5); numpad.setContentsMargins(0,0,0,0)
        buttons = [
            ('7',0,0),('8',0,1),('9',0,2),
            ('4',1,0),('5',1,1),('6',1,2),
            ('1',2,0),('2',2,1),('3',2,2),
            ('00',3,0),('0',3,1),('.',3,2),
        ]
        for text, row, col in buttons:
            btn = QPushButton(text); btn.setObjectName('numpad_btn')
            btn.setFont(QFont('Segoe UI', 14, QFont.Bold)); btn.setFixedHeight(_np)
            btn.clicked.connect(lambda _, t=text: self._numpad_press(t))
            numpad.addWidget(btn, row, col); numpad.setColumnStretch(col, 1)
        del_btn = QPushButton('⌫ Borrar'); del_btn.setObjectName('btn_clear')
        del_btn.setFont(QFont('Segoe UI', 11, QFont.Bold)); del_btn.setFixedHeight(_np)
        del_btn.clicked.connect(self._numpad_delete)
        numpad.addWidget(del_btn, 4, 0, 1, 3)

        # ── Columna derecha: numpad + ARCA (apilados) ─────────────────────
        right_col = QWidget()
        right_layout = QVBoxLayout(right_col)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(6)
        right_layout.addWidget(numpad_widget)

        if self._profiles:
            arca_sep = QFrame()
            arca_sep.setFrameShape(QFrame.HLine)
            arca_sep.setStyleSheet('color:#dcd6c8; max-height:1px;')
            right_layout.addWidget(arca_sep)

            arca_lbl = QLabel('Facturar en ARCA:')
            arca_lbl.setFont(QFont('Segoe UI', 9, QFont.Bold))
            arca_lbl.setStyleSheet('color:#5a5448;')
            right_layout.addWidget(arca_lbl)

            profiles_w = QWidget()
            profiles_row = QHBoxLayout(profiles_w)
            profiles_row.setContentsMargins(0, 0, 0, 0)
            profiles_row.setSpacing(5)

            _colors = [('#c1521f','#a3441a'),('#6f42c1','#5a32a3'),
                       ('#d63384','#ab296a'),('#fd7e14','#dc6502'),('#20c997','#1aa179')]

            for i, p in enumerate(self._profiles):
                bg, hv = _colors[i % len(_colors)]
                pb = QPushButton(p['nombre'])
                pb.setCheckable(True)
                pb.setMinimumHeight(_prf)
                pb.setFont(QFont('Segoe UI', 9, QFont.Bold))
                pb.setStyleSheet(f'''
                    QPushButton {{ background:{bg}; color:white; border:none; border-radius:7px; padding:0 8px; }}
                    QPushButton:hover {{ background:{hv}; }}
                    QPushButton:checked {{ border:3px solid #ffd600; }}
                ''')
                pb.clicked.connect(lambda _, perf=p, b=pb: self._select_profile(perf, b))
                profiles_row.addWidget(pb)
                self._profile_btns.append(pb)

            no_btn = QPushButton('Sin factura')
            no_btn.setCheckable(True)
            no_btn.setChecked(True)
            no_btn.setMinimumHeight(_prf)
            no_btn.setFont(QFont('Segoe UI', 9))
            no_btn.setStyleSheet('''
                QPushButton { background:#fafaf7; color:#6f6a5d; border:1.5px solid #dcd6c8; border-radius:7px; padding:0 8px; }
                QPushButton:hover { background:#ece8df; }
                QPushButton:checked { border:2px solid #9b958a; background:#ece8df; color:#343a40; }
            ''')
            no_btn.clicked.connect(lambda: self._select_profile(None, no_btn))
            self._no_factura_btn = no_btn
            self._profile_btns.append(no_btn)
            profiles_row.addWidget(no_btn)
            right_layout.addWidget(profiles_w)

            self._cliente_btn = QPushButton('Sin cliente  (Consumidor Final)')
            self._cliente_btn.setMinimumHeight(max(22, _h(26)))
            self._cliente_btn.setFont(QFont('Segoe UI', 8))
            self._cliente_btn.setCursor(Qt.PointingHandCursor)
            self._cliente_btn.setStyleSheet('''
                QPushButton { background:#fafaf7; color:#6f6a5d; border:1px dashed #9b958a; border-radius:5px; text-align:left; padding:0 8px; }
                QPushButton:hover { background:#ece8df; border-style:solid; }
            ''')
            self._cliente_btn.clicked.connect(self._open_client_selector)
            right_layout.addWidget(self._cliente_btn)

        right_layout.addStretch()
        h_layout.addWidget(right_col, 1)
        main.addLayout(h_layout)

        outer.addWidget(_content_w)

    def _load_profiles(self):
        try:
            from pos_system.database.db_manager import DatabaseManager
            self._profiles = DatabaseManager().execute_query(
                "SELECT * FROM perfiles_facturacion WHERE activo=1 ORDER BY nombre ASC"
            ) or []
        except Exception:
            self._profiles = []

    def _select_profile(self, perfil, clicked_btn):
        self.selected_profile = perfil
        for b in self._profile_btns:
            b.setChecked(False)
        clicked_btn.setChecked(True)

    def _open_client_selector(self):
        if self.selected_cliente:
            from PyQt5.QtWidgets import QMenu
            menu = QMenu(self)
            menu.addAction('Cambiar cliente...', self._choose_cliente)
            menu.addAction('Quitar cliente  (Consumidor Final)', self._clear_cliente)
            menu.exec_(self._cliente_btn.mapToGlobal(
                self._cliente_btn.rect().bottomLeft()
            ))
        else:
            self._choose_cliente()

    def _choose_cliente(self):
        from pos_system.ui.cliente_perfil_dialog import ClientePerfilDialog
        dlg = ClientePerfilDialog(self)
        if dlg.exec_() == QDialog.Accepted and dlg.selected_cliente:
            self.selected_cliente = dlg.selected_cliente
            nombre = dlg.selected_cliente.get('nombre', '')
            cuit = dlg.selected_cliente.get('cuit', '')
            self._cliente_btn.setText(f'{nombre}{"  —  CUIT: " + cuit if cuit else ""}')
            self._cliente_btn.setStyleSheet('''
                QPushButton { background:#fbeee5; color:#c1521f; border:1px solid #dcd6c8; border-radius:6px; text-align:left; padding:0 10px; }
                QPushButton:hover { background:#fbeee5; }
            ''')

    def _clear_cliente(self):
        self.selected_cliente = None
        self._cliente_btn.setText('Sin cliente  (Consumidor Final)')
        self._cliente_btn.setStyleSheet('''
            QPushButton { background:#fafaf7; color:#6f6a5d; border:1px dashed #9b958a; border-radius:5px; text-align:left; padding:0 8px; }
            QPushButton:hover { background:#ece8df; border-style:solid; }
        ''')

    def _preview_invoice(self):
        if not self.selected_profile:
            QMessageBox.information(self, 'Vista previa',
                'Selecciona un perfil ARCA para ver la vista previa.')
            return
        import os, platform as _pl, subprocess as _sp
        from pos_system.utils.pdf_generator import PDFGenerator
        from pos_system.utils.firebase_sync import now_ar

        perfil = self.selected_profile
        total = self.total
        items_factura = [
            {'cantidad': it.get('quantity', 1),
             'descripcion': it.get('product_name', 'Producto'),
             'iva': 0.0,
             'precio': float(it.get('unit_price', 0)),
             'importe': float(it.get('subtotal', 0))}
            for it in self.cart
        ] or [{'cantidad': 1, 'descripcion': 'Venta general', 'iva': 0.0, 'precio': total, 'importe': total}]

        cond_iva_rec = 'Consumidor Final'
        if self.selected_cliente:
            cond_iva_rec = self.selected_cliente.get('condicion_iva', 'Consumidor Final')

        tipo = 'FAC. ELEC. A' if cond_iva_rec == 'Responsable Inscripto' else (
               'FAC. ELEC. B' if self.payment_type == 'transfer' else 'FAC. ELEC. C')

        factura = {
            'cuit': perfil.get('cuit', ''),
            'razon_social': perfil.get('razon_social') or perfil.get('nombre', ''),
            'domicilio': perfil.get('domicilio', ''),
            'localidad': perfil.get('localidad', ''),
            'telefono': '',
            'ing_brutos': perfil.get('ing_brutos', ''),
            'inicio_actividades': perfil.get('inicio_actividades', ''),
            'condicion_iva': perfil.get('condicion_iva', 'Monotributista'),
            'tipo_comprobante': tipo,
            'punto_venta': perfil.get('punto_venta', 1),
            'nro_comprobante': 1,
            'fecha': now_ar().strftime('%d/%m/%Y'),
            'turno': '00000',
            'pago': self.payment_subtype,
            'modalidad': 'LOCAL',
            'cliente': (self.selected_cliente or {}).get('razon_social') or
                       (self.selected_cliente or {}).get('nombre', 'CONSUMIDOR FINAL') if self.selected_cliente else 'CONSUMIDOR FINAL',
            'cuit_receptor': (self.selected_cliente or {}).get('cuit', ''),
            'domicilio_receptor': (self.selected_cliente or {}).get('domicilio', ''),
            'condicion_iva_receptor': cond_iva_rec,
            'items': items_factura,
            'total': total,
            'iva_contenido': 0.0,
            'otros_impuestos': 0.0,
            'cae': '',
            'vto_cae': '',
            'notas': self._nota_input.text().strip() if hasattr(self, '_nota_input') else '',
            'nombre_perfil': perfil.get('nombre', ''),
        }
        try:
            pdf_path = PDFGenerator().generate_factura_afip_a4(factura)
            if _pl.system() == 'Windows':
                os.startfile(pdf_path)
            elif _pl.system() == 'Darwin':
                _sp.Popen(['open', pdf_path])
            else:
                _sp.Popen(['xdg-open', pdf_path])
        except Exception as e:
            QMessageBox.warning(self, 'Vista previa', f'Error generando vista previa:\n{e}')

    def keyPressEvent(self, event):
        """Permite ingresar montos con el teclado numérico físico."""
        key = event.key()
        text = event.text()

        # Dígitos 0-9 (teclado principal y numpad)
        if key in (Qt.Key_0, Qt.Key_1, Qt.Key_2, Qt.Key_3, Qt.Key_4,
                   Qt.Key_5, Qt.Key_6, Qt.Key_7, Qt.Key_8, Qt.Key_9):
            if self.payment_type == 'cash':
                self._numpad_press(text)
            return

        # Doble cero con Ins del numpad (opcional, no estándar — usar solo dígitos)
        if key in (Qt.Key_Period, Qt.Key_Comma) or (text in ('.', ',')):
            if self.payment_type == 'cash':
                self._numpad_press('.')
            return

        # Borrar
        if key in (Qt.Key_Backspace, Qt.Key_Delete):
            if self.payment_type == 'cash':
                self._numpad_delete()
            return

        # Enter/Return confirma el cobro
        if key in (Qt.Key_Return, Qt.Key_Enter):
            self._confirm()
            return

        # Escape cancela
        if key == Qt.Key_Escape:
            self.reject()
            return

        super().keyPressEvent(event)

    def _set_payment(self, ptype):
        self.payment_type = ptype
        if ptype == 'cash':
            self.btn_cash.setChecked(True)
            self.btn_transfer.setChecked(False)
            self.cash_panel.setVisible(True)
            self.transfer_panel.setVisible(False)
            self.payment_subtype = 'Efectivo'
            if self._subtype_row_widget:
                self._subtype_row_widget.setVisible(False)
        else:
            self.btn_cash.setChecked(False)
            self.btn_transfer.setChecked(True)
            self.cash_panel.setVisible(False)
            self.transfer_panel.setVisible(True)
            if self._subtype_row_widget:
                self._subtype_row_widget.setVisible(True)
            # Default: T. Débito
            self._set_subtype('T. DEBITO', self._subtype_btns.get('T. DEBITO'))

    def _set_subtype(self, key, btn):
        self.payment_subtype = key
        for b in self._subtype_btns.values():
            b.setChecked(False)
        if btn:
            btn.setChecked(True)

    @staticmethod
    def _fmt_input(raw: str) -> str:
        """Formatea el string crudo con separadores de miles, conservando el punto decimal."""
        if not raw:
            return ''
        if '.' in raw:
            int_part, dec_part = raw.split('.', 1)
        else:
            int_part, dec_part = raw, None
        try:
            formatted = f'{int(int_part):,}' if int_part else '0'
        except ValueError:
            formatted = int_part
        return f'{formatted}.{dec_part}' if dec_part is not None else formatted

    def _numpad_press(self, text):
        if text == '.' and '.' in self._raw_amount:
            return
        if text == '00' and not self._raw_amount:
            return
        self._raw_amount += text
        self.amount_input.setText(self._fmt_input(self._raw_amount))
        self._update_change()

    def _numpad_delete(self):
        self._raw_amount = self._raw_amount[:-1]
        self.amount_input.setText(self._fmt_input(self._raw_amount))
        self._update_change()

    def _update_change(self):
        try:
            received = float(self._raw_amount) if self._raw_amount else 0.0
        except ValueError:
            received = 0.0
        change = received - self.total
        if change >= 0:
            self.change_lbl.setText(f'${change:,.2f}')
            self.change_lbl.setStyleSheet('color: #16a34a; font-size: 22px; font-weight: bold; background: transparent; border: none;')
            self.change_lbl.parent().setStyleSheet('QFrame { background: #f0fdf4; border: 2px solid #3d7a3a; border-radius: 10px; }')
        else:
            self.change_lbl.setText(f'Faltan ${abs(change):,.2f}')
            self.change_lbl.setStyleSheet('color: #a01616; font-size: 18px; font-weight: bold; background: transparent; border: none;')
            self.change_lbl.parent().setStyleSheet('QFrame { background: #fff5f5; border: 2px solid #a01616; border-radius: 10px; }')

    def _toggle_nota(self, checked):
        self._nota_input.setVisible(checked)
        if checked:
            self._nota_btn.setText('- Quitar nota')
            self._nota_input.setFocus()
        else:
            self._nota_btn.setText('+ Añadir nota a la factura')
            self._nota_input.clear()
        self.adjustSize()

    def _confirm(self):
        if self.payment_type == 'cash':
            try:
                received = float(self._raw_amount) if self._raw_amount else 0.0
            except ValueError:
                received = 0.0
            if received > 0 and received < self.total:
                QMessageBox.warning(self, 'Monto insuficiente',
                    f'El monto ingresado (${received:.2f}) es menor al total (${self.total:.2f})')
                return
            self.cash_received = received
            self.change_given = max(0.0, received - self.total)
        else:
            self.cash_received = 0.0
            self.change_given = 0.0
        self.nota_factura = self._nota_input.text().strip() if hasattr(self, '_nota_input') else ''
        self.accept()


class VariosItemDialog(QDialog):
    """Diálogo para agregar un item 'Varios' al carrito con observación opcional."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle('Agregar Varios')
        self.setMinimumSize(460, 320)

        self.product_name = ''
        self.unit_price   = 0.0
        self.qty          = 1
        self.observation  = ''

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(10)

        title = QLabel('Item genérico')
        title.setFont(QFont('Segoe UI', 13, QFont.Bold))
        title.setStyleSheet('color: #1c1c1e;')
        layout.addWidget(title)

        form = QFormLayout()
        form.setSpacing(8)

        self.name_input = QLineEdit()
        self.name_input.setFont(QFont('Segoe UI', 11))
        self.name_input.setPlaceholderText('Ej: Cuaderno rayado A4')
        form.addRow('Descripción:', self.name_input)

        self.price_input = QLineEdit()
        self.price_input.setPlaceholderText('Precio')
        self.price_input.setValidator(QIntValidator(0, 9_999_999, self))
        self.price_input.setFont(QFont('Segoe UI', 11))
        form.addRow('Precio unitario:', self.price_input)

        self.qty_input = CartQuantitySpinBox()
        self.qty_input.setRange(0.01, 9999)
        self.qty_input.setValue(1)
        self.qty_input.setFont(QFont('Segoe UI', 11))
        form.addRow('Cantidad:', self.qty_input)

        layout.addLayout(form)

        # Toggle observación (ícono lápiz)
        obs_row = QHBoxLayout()
        self.obs_toggle_btn = QPushButton('Agregar observación')
        self.obs_toggle_btn.setCheckable(True)
        self.obs_toggle_btn.setCursor(Qt.PointingHandCursor)
        self.obs_toggle_btn.setStyleSheet('''
            QPushButton { background: #fafaf7; color: #1c1c1e;
                          border: 1px solid #dcd6c8; padding: 6px 12px;
                          border-radius: 6px; font-size: 10pt; }
            QPushButton:checked { background: #fbeee5; border-color: #c1521f;
                                  color: #a3441a; }
            QPushButton:hover { background: #dcd6c8; }
        ''')
        self.obs_toggle_btn.clicked.connect(self._toggle_obs)
        obs_row.addWidget(self.obs_toggle_btn)
        obs_row.addStretch()
        layout.addLayout(obs_row)

        self.obs_edit = QTextEdit()
        self.obs_edit.setFont(QFont('Segoe UI', 10))
        self.obs_edit.setPlaceholderText('Ej: falta producto en stock, pedir al proveedor…')
        self.obs_edit.setFixedHeight(80)
        self.obs_edit.setVisible(False)
        layout.addWidget(self.obs_edit)

        btns = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        btns.button(QDialogButtonBox.Ok).setText('Agregar al carrito')
        btns.button(QDialogButtonBox.Cancel).setText('Cancelar')
        btns.accepted.connect(self._on_ok)
        btns.rejected.connect(self.reject)
        layout.addWidget(btns)

        self.name_input.setFocus()

    def _toggle_obs(self):
        checked = self.obs_toggle_btn.isChecked()
        self.obs_edit.setVisible(checked)
        self.obs_toggle_btn.setText('Quitar observación' if checked else 'Agregar observación')
        if checked:
            self.obs_edit.setFocus()
        self.adjustSize()

    def _on_ok(self):
        name = self.name_input.text().strip()
        if not name:
            QMessageBox.warning(self, 'Varios', 'Ingresá una descripción.')
            self.name_input.setFocus()
            return
        try:
            price = float(self.price_input.text().strip() or 0)
        except ValueError:
            price = 0.0
        if price <= 0:
            QMessageBox.warning(self, 'Varios', 'El precio debe ser mayor a cero.')
            self.price_input.setFocus()
            return
        self.product_name = name
        self.unit_price   = price
        self.qty          = float(self.qty_input.value())
        if self.obs_toggle_btn.isChecked():
            self.observation = self.obs_edit.toPlainText().strip()
        else:
            self.observation = ''
        self.accept()
