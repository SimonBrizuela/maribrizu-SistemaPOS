from PyQt5.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QTableWidget,
                             QTableWidgetItem, QPushButton, QLineEdit, QLabel,
                             QComboBox, QMessageBox, QSpinBox, QDoubleSpinBox,
                             QDialog, QFormLayout, QSplitter, QFrame, QGridLayout,
                             QSizePolicy, QListWidget, QListWidgetItem, QAbstractItemView,
                             QHeaderView, QApplication, QScrollArea, QInputDialog)
from PyQt5.QtCore import Qt, QSize, QTimer, pyqtSignal, QThread
from PyQt5.QtGui import QFont, QColor, QKeySequence
from datetime import datetime
import os
import subprocess
import platform

from pos_system.models.product import Product
from pos_system.models.sale import Sale
from pos_system.models.cash_register import CashRegister
from pos_system.models.promotion import Promotion
from pos_system.utils.pdf_generator import PDFGenerator


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
        # Umbral: si pasan más de 100ms entre caracteres, no es un escáner
        self._threshold_ms = 100

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
        self._search_timer.setInterval(280)
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
                border: 2px solid #6366f1;
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
        clear_btn.setStyleSheet('QPushButton { background:#f1f5f9; color:#1e293b; border:1.5px solid #cbd5e1; border-radius:8px; padding:0 12px; } QPushButton:hover { background:#e2e8f0; }')
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
        self._filter_lbl.setStyleSheet('color:#6366f1; background:#eef2ff; border:1px solid #c7d2fe; border-radius:5px; padding:3px 8px;')
        fb.addWidget(self._filter_lbl)
        cf_btn = QPushButton('x  Todos los productos')
        cf_btn.setFont(QFont('Segoe UI', 10))
        cf_btn.setStyleSheet('QPushButton { background:#f1f5f9; color:#1e293b; border:1.5px solid #cbd5e1; border-radius:5px; padding:3px 10px; } QPushButton:hover { background:#e2e8f0; }')
        cf_btn.clicked.connect(self._clear_filter)
        fb.addWidget(cf_btn)
        fb.addStretch()
        root.addWidget(self._filter_bar)
        self._filter_bar.setVisible(bool(self._subcategory or self._rubro))

        # Contador
        self.result_count_lbl = QLabel('')
        self.result_count_lbl.setFont(QFont('Segoe UI', 9))
        self.result_count_lbl.setStyleSheet('color:#64748b;')
        root.addWidget(self.result_count_lbl)

        # ── Splitter: tabla búsqueda | panel carrito ──
        from PyQt5.QtWidgets import QSplitter
        splitter = QSplitter(Qt.Horizontal)
        splitter.setHandleWidth(6)
        splitter.setStyleSheet('QSplitter::handle { background: #e2e8f0; border-radius: 3px; }')

        # Tabla de resultados
        self.table = QTableWidget()
        self.table.setColumnCount(5)
        self.table.setHorizontalHeaderLabels(['Producto', 'Código', 'Categoría', 'Precio', 'Stock'])
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
        self.table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeToContents)
        self.table.setStyleSheet('''
            QTableWidget { border: 1.5px solid #e2e8f0; border-radius: 8px; gridline-color: #f1f5f9; }
            QTableWidget::item { padding: 6px; }
            QTableWidget::item:selected { background: #6366f1; color: white; }
            QHeaderView::section { background: #f8fafc; padding: 6px; border: none; border-bottom: 2px solid #e2e8f0; font-weight: bold; }
        ''')
        self.table.verticalHeader().setDefaultSectionSize(38)
        self.table.doubleClicked.connect(self._on_double_click)
        self.table.keyPressEvent = self._table_key_press
        splitter.addWidget(self.table)

        # Panel derecho: carrito
        cart_panel = QWidget()
        cart_panel.setMinimumWidth(230)
        cart_panel.setMaximumWidth(380)
        cart_panel.setStyleSheet('QWidget { background: #f8fafc; border-radius: 10px; }')
        cp = QVBoxLayout(cart_panel)
        cp.setContentsMargins(10, 10, 10, 10)
        cp.setSpacing(6)

        cart_title = QLabel('Carrito actual')
        cart_title.setFont(QFont('Segoe UI', 11, QFont.Bold))
        cart_title.setStyleSheet('color: #1e293b; background: transparent; border: none;')
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
            QTableWidget { border: 1px solid #e2e8f0; border-radius: 6px; gridline-color: #f1f5f9; background: white; }
            QTableWidget::item { padding: 3px 5px; }
            QHeaderView::section { background: #f1f5f9; padding: 4px; border: none; border-bottom: 1.5px solid #e2e8f0; font-size: 10px; }
        ''')
        cp.addWidget(self.cart_list, 1)

        # Total en el panel derecho
        total_frame = QFrame()
        total_frame.setStyleSheet('QFrame { background: #1a1a2e; border-radius: 8px; border: none; }')
        tl = QHBoxLayout(total_frame)
        tl.setContentsMargins(12, 10, 12, 10)
        tl.setSpacing(8)
        total_lbl = QLabel('TOTAL')
        total_lbl.setFont(QFont('Segoe UI', 10, QFont.Bold))
        total_lbl.setStyleSheet('color:#adb5bd; background:transparent; border:none;')
        tl.addWidget(total_lbl)
        self.dialog_total_amount = QLabel('$0.00')
        self.dialog_total_amount.setFont(QFont('Segoe UI', 18, QFont.Bold))
        self.dialog_total_amount.setStyleSheet('color:#4ade80; background:transparent; border:none;')
        self.dialog_total_amount.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        self.dialog_total_amount.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        tl.addWidget(self.dialog_total_amount)
        cp.addWidget(total_frame)

        hint = QLabel('Enter o doble click para agregar')
        hint.setFont(QFont('Segoe UI', 9))
        hint.setStyleSheet('color:#94a3b8; background:transparent; border:none;')
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
            detail_item = QTableWidgetItem(f'x{qty}  ${subtotal:,.0f}')
            detail_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            detail_item.setForeground(QColor('#6366f1'))
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
        self.table.setSpan(0, 0, 1, 5)
        item = QTableWidgetItem('Escribí para buscar productos...')
        item.setTextAlignment(Qt.AlignCenter)
        item.setForeground(QColor('#94a3b8'))
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
                    clauses.append("(UPPER(name) LIKE ? OR UPPER(barcode) LIKE ?)")
                    params.extend([pat, pat])

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
            self.table.setItem(row, 2, QTableWidgetItem(str(p.get('category', '') or '')))
            price_item = QTableWidgetItem(f"${float(p.get('price', 0)):,.2f}")
            price_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            self.table.setItem(row, 3, price_item)
            stock = p.get('stock', 0)
            stock_item = QTableWidgetItem(str(stock if stock is not None else 0))
            stock_item.setTextAlignment(Qt.AlignCenter)
            if stock is not None and stock <= 0:
                stock_item.setForeground(QColor('#dc3545'))
            self.table.setItem(row, 4, stock_item)

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
        layout = QVBoxLayout(self)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(8)

        # ── Barra superior: escáner automático + búsqueda manual ──
        search_row = QHBoxLayout()
        search_row.setSpacing(8)

        # Etiqueta escáner
        scanner_lbl = QLabel('Codigo / Busqueda:')
        scanner_lbl.setFont(QFont('Segoe UI', 10, QFont.Bold))
        scanner_lbl.setStyleSheet('color: #495057;')
        search_row.addWidget(scanner_lbl)

        # Campo inteligente: detecta escáner automático o tipeo manual
        self.barcode_field = BarcodeScanner()
        self.barcode_field.setPlaceholderText('Escanee un codigo de barras o escriba para buscar...')
        self.barcode_field.setFont(QFont('Segoe UI', 11))
        self.barcode_field.setMinimumHeight(40)
        self.barcode_field.setStyleSheet('''
            QLineEdit {
                border: 2px solid #ced4da;
                border-radius: 6px;
                padding: 6px 12px;
                background: white;
                font-size: 13px;
            }
            QLineEdit:focus { border-color: #0d6efd; }
        ''')
        # Escáner automático detectado
        self.barcode_field.barcode_scanned.connect(self._on_barcode_scanned)
        # Tipeo manual → sugerencias en tiempo real
        self.barcode_field.textChanged.connect(self._on_search_text_changed)
        self.barcode_field.returnPressed.connect(self.search_product)
        search_row.addWidget(self.barcode_field, 1)

        search_btn = QPushButton('Buscar')
        search_btn.setMinimumHeight(40)
        search_btn.setMinimumWidth(80)
        search_btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
        search_btn.clicked.connect(self.search_product)
        search_row.addWidget(search_btn)

        layout.addLayout(search_row)

        # Suggestion list eliminada — los resultados se muestran directo en la tabla de productos

        # ── Splitter principal: productos (arriba) | carrito (abajo) ──
        splitter = QSplitter(Qt.Vertical)
        splitter.setHandleWidth(6)

        # ── Panel superior: Lista de productos ──
        left_panel = QWidget()
        left_layout = QVBoxLayout(left_panel)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.setSpacing(8)

        # ── Cabecera: título + indicador ──
        filter_row = QHBoxLayout()
        filter_row.setSpacing(8)

        products_title = QLabel('Productos')
        products_title.setFont(QFont('Segoe UI', 13, QFont.Bold))
        products_title.setStyleSheet('color: #212529;')
        filter_row.addWidget(products_title)

        # Botón lupa para abrir búsqueda ampliada
        lupa_btn = QPushButton('🔍  Vista ampliada')
        lupa_btn.setMinimumHeight(34)
        lupa_btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
        lupa_btn.setToolTip('Abrir búsqueda ampliada de productos (fuente grande)')
        lupa_btn.setStyleSheet('''
            QPushButton {
                background: #6366f1; color: white;
                border: none; border-radius: 6px; padding: 4px 14px;
            }
            QPushButton:hover { background: #4f46e5; }
            QPushButton:pressed { background: #4338ca; }
        ''')
        lupa_btn.clicked.connect(self._open_search_dialog)
        filter_row.addWidget(lupa_btn)

        filter_row.addStretch()

        # Indicador de acción (escáner)
        self.sync_indicator = QLabel('')
        self.sync_indicator.setFont(QFont('Segoe UI', 9))
        self.sync_indicator.setStyleSheet(
            'color: #198754; background: #d1fae5; border: 1px solid #6ee7b7;'
            'border-radius: 4px; padding: 2px 8px; font-weight: 600;'
        )
        self.sync_indicator.setVisible(False)
        filter_row.addWidget(self.sync_indicator)

        left_layout.addLayout(filter_row)

        # ── Estilos para botones de rubro ──
        self._btn_off = ('background:#f1f3f5;color:#495057;border:1.5px solid #ced4da;'
                    'border-radius:6px;padding:4px 12px;font-size:11px;font-weight:bold;')
        self._btn_on  = ('background:#0d6efd;color:white;border:1.5px solid #0d6efd;'
                    'border-radius:6px;padding:4px 12px;font-size:11px;font-weight:bold;')
        self._fav_style_off = f'QPushButton{{{self._btn_off}}} QPushButton:hover{{background:#e9ecef;}}'
        self._fav_style_on  = f'QPushButton{{{self._btn_on}}} QPushButton:hover{{background:#0b5ed7;}}'
        self._selected_category = None
        self._category_buttons = {}

        # ── Fila SECCIÓN: etiqueta + botones de rubros ──
        section_row = QHBoxLayout()
        section_row.setSpacing(6)

        section_lbl = QLabel('SECCIÓN:')
        section_lbl.setFont(QFont('Segoe UI', 10, QFont.Bold))
        section_lbl.setStyleSheet('color: #495057;')
        section_row.addWidget(section_lbl)

        # Área scrollable para los botones de rubro
        self._rubros_scroll = QScrollArea()
        self._rubros_scroll.setFixedHeight(48)
        self._rubros_scroll.setWidgetResizable(True)
        self._rubros_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        self._rubros_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self._rubros_scroll.setStyleSheet('QScrollArea { border: none; background: transparent; }')

        self._rubros_inner = QWidget()
        self._rubros_inner.setStyleSheet('background: transparent;')
        self._rubros_layout = QHBoxLayout(self._rubros_inner)
        self._rubros_layout.setContentsMargins(0, 0, 0, 0)
        self._rubros_layout.setSpacing(6)
        self._rubros_layout.setAlignment(Qt.AlignLeft)
        self._rubros_scroll.setWidget(self._rubros_inner)
        section_row.addWidget(self._rubros_scroll, 1)

        self.favorites_btn = QPushButton('Favoritos')
        self.favorites_btn.setCheckable(True)
        self.favorites_btn.setMinimumHeight(34)
        self.favorites_btn.setStyleSheet(self._fav_style_off)
        self.favorites_btn.toggled.connect(self._on_favorites_toggled)
        section_row.addWidget(self.favorites_btn)

        reset_btn = QPushButton('Limpiar')
        reset_btn.setMinimumHeight(34)
        reset_btn.setStyleSheet(f'QPushButton{{{self._btn_off}}} QPushButton:hover{{background:#e9ecef;}}')
        reset_btn.clicked.connect(self.reset_category_filter)
        section_row.addWidget(reset_btn)

        left_layout.addLayout(section_row)

        # ── Combo de CATEGORÍAS (desplegable simple) ──
        subcat_row = QHBoxLayout()
        subcat_row.setSpacing(6)

        subcat_lbl = QLabel('Categoría:')
        subcat_lbl.setFont(QFont('Segoe UI', 10, QFont.Bold))
        subcat_lbl.setStyleSheet('color: #495057;')
        subcat_row.addWidget(subcat_lbl)

        self._subcat_combo = QComboBox()
        self._subcat_combo.setMinimumHeight(34)
        self._subcat_combo.setFont(QFont('Segoe UI', 10))
        self._subcat_combo.setStyleSheet('''
            QComboBox {
                border: 1.5px solid #ced4da;
                border-radius: 6px;
                padding: 4px 10px;
                background: white;
                color: #212529;
            }
            QComboBox:focus { border-color: #6366f1; }
            QComboBox::drop-down { border: none; width: 24px; }
            QComboBox QAbstractItemView {
                border: 1px solid #ced4da;
                border-radius: 4px;
                selection-background-color: #6366f1;
                selection-color: white;
                font-size: 11px;
            }
        ''')
        self._subcat_combo.currentTextChanged.connect(self._on_subcat_combo_changed)
        subcat_row.addWidget(self._subcat_combo, 1)

        self._subcat_container = QWidget()
        self._subcat_container.setLayout(subcat_row)
        self._subcat_container.setVisible(False)
        left_layout.addWidget(self._subcat_container)

        self._selected_subcategory = None
        self._subcat_buttons = {}

        # Mantener estos atributos por compatibilidad con código existente
        self.category_filter = QComboBox()
        self.rubro_filter = QComboBox()

        # Cargar botones de rubros desde la BD
        self._load_rubro_buttons()

        # Instrucción
        hint = QLabel('Escriba un nombre, escanee un código o elija una categoría')
        hint.setFont(QFont('Segoe UI', 9))
        hint.setStyleSheet(
            'color: #64748b; background: #f8fafc; border: 1px solid #e2e8f0;'
            'border-radius: 6px; padding: 5px 12px;'
        )
        left_layout.addWidget(hint)

        # Tabla de productos
        self.products_table = QTableWidget()
        self.products_table.setColumnCount(5)
        self.products_table.setHorizontalHeaderLabels(['FAV', 'Producto', 'Codigo', 'Precio', 'Stock'])
        self.products_table.verticalHeader().setVisible(False)
        self.products_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.products_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.products_table.doubleClicked.connect(self.add_to_cart_from_table)
        self.products_table.setAlternatingRowColors(True)
        self.products_table.horizontalHeader().setStretchLastSection(False)
        self.products_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Fixed)
        self.products_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)
        self.products_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        self.products_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeToContents)
        self.products_table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeToContents)
        self.products_table.setColumnWidth(0, 36)
        # Enter en tabla también agrega al carrito
        self.products_table.keyPressEvent = self._products_table_key_press
        left_layout.addWidget(self.products_table)

        splitter.addWidget(left_panel)

        # ── Panel inferior: Carrito (tabla a la izquierda, total+cobrar a la derecha) ──
        right_panel = QWidget()
        right_panel.setStyleSheet('background: #f8f9fa; border-top: 2px solid #e9ecef;')
        right_main = QHBoxLayout(right_panel)
        right_main.setContentsMargins(8, 8, 8, 8)
        right_main.setSpacing(10)

        # ── Izquierda: cabecera + tabla + hint promo ──
        cart_left = QVBoxLayout()
        cart_left.setSpacing(6)

        cart_header = QHBoxLayout()
        cart_title = QLabel('Carrito de Venta')
        cart_title.setFont(QFont('Segoe UI', 11, QFont.Bold))
        cart_title.setStyleSheet('color: #1e293b; background:transparent;')
        cart_header.addWidget(cart_title)
        cart_header.addStretch()
        self.items_count_lbl = QLabel('0 items')
        self.items_count_lbl.setFont(QFont('Segoe UI', 9))
        self.items_count_lbl.setStyleSheet(
            'color:#6c757d; background:#f1f5f9; border-radius:10px; padding:2px 8px;'
        )
        cart_header.addWidget(self.items_count_lbl)
        cart_left.addLayout(cart_header)

        # Tabla del carrito
        self.cart_table = QTableWidget()
        self.cart_table.setColumnCount(6)
        self.cart_table.setHorizontalHeaderLabels(['Producto', 'Descuento', 'Precio', 'Cant.', 'Subtotal', ''])
        self.cart_table.verticalHeader().setVisible(False)
        self.cart_table.setAlternatingRowColors(True)
        self.cart_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.cart_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.cart_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.Fixed)
        self.cart_table.setColumnWidth(1, 110)
        self.cart_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.Fixed)
        self.cart_table.setColumnWidth(2, 100)
        self.cart_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.Fixed)
        self.cart_table.setColumnWidth(3, 85)
        self.cart_table.horizontalHeader().setSectionResizeMode(4, QHeaderView.Fixed)
        self.cart_table.setColumnWidth(4, 90)
        self.cart_table.horizontalHeader().setSectionResizeMode(5, QHeaderView.Fixed)
        self.cart_table.setColumnWidth(5, 34)
        self.cart_table.setFocusPolicy(Qt.NoFocus)
        self.cart_table.cellClicked.connect(self._on_cart_cell_clicked)
        cart_left.addWidget(self.cart_table, 1)

        # Aviso de promoción cercana
        self._promo_hint_lbl = QLabel('')
        self._promo_hint_lbl.setWordWrap(True)
        self._promo_hint_lbl.setVisible(False)
        self._promo_hint_lbl.setFont(QFont('Segoe UI', 9))
        self._promo_hint_lbl.setStyleSheet('''
            QLabel {
                background: #fff8e1; border: 1.5px solid #ffc107;
                border-radius: 7px; padding: 5px 10px; color: #6d4c00;
            }
        ''')
        cart_left.addWidget(self._promo_hint_lbl)

        right_main.addLayout(cart_left, 1)

        # ── Derecha: Total + Cobrar ──
        cart_right = QVBoxLayout()
        cart_right.setSpacing(8)
        cart_right.setContentsMargins(0, 0, 0, 0)

        # Total frame
        total_frame = QFrame()
        total_frame.setStyleSheet('QFrame { background: #1a1a2e; border-radius: 10px; }')
        total_frame.setMinimumWidth(240)
        total_layout = QVBoxLayout(total_frame)
        total_layout.setContentsMargins(12, 14, 12, 14)
        total_layout.setSpacing(4)

        total_lbl = QLabel('TOTAL')
        total_lbl.setFont(QFont('Segoe UI', 10, QFont.Bold))
        total_lbl.setStyleSheet('color: #adb5bd; background: transparent; border: none;')
        total_lbl.setAlignment(Qt.AlignCenter)
        total_layout.addWidget(total_lbl)

        self.total_amount_label = QLabel('$0.00')
        self.total_amount_label.setFont(QFont('Segoe UI', 24, QFont.Bold))
        self.total_amount_label.setStyleSheet('color: #4ade80; background: transparent; border: none;')
        self.total_amount_label.setAlignment(Qt.AlignCenter)
        self.total_amount_label.setMinimumWidth(220)
        self.total_amount_label.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        total_layout.addWidget(self.total_amount_label)
        cart_right.addWidget(total_frame)

        cart_right.addStretch()

        # Botón Limpiar
        clear_btn = QPushButton('Limpiar')
        clear_btn.setObjectName('btnSecondary')
        clear_btn.setMinimumHeight(38)
        clear_btn.setFont(QFont('Segoe UI', 10))
        clear_btn.setCursor(Qt.PointingHandCursor)
        clear_btn.clicked.connect(self.clear_cart)
        cart_right.addWidget(clear_btn)

        # Botón COBRAR
        facturar_btn = QPushButton('COBRAR')
        facturar_btn.setMinimumHeight(56)
        facturar_btn.setFont(QFont('Segoe UI', 14, QFont.Bold))
        facturar_btn.setCursor(Qt.PointingHandCursor)
        facturar_btn.setStyleSheet('''
            QPushButton {
                background-color: #198754; color: white;
                border: none; border-radius: 10px; letter-spacing: 0.5px;
            }
            QPushButton:hover { background-color: #157347; }
            QPushButton:pressed { background-color: #146c43; }
        ''')
        facturar_btn.clicked.connect(self.complete_sale)
        cart_right.addWidget(facturar_btn)

        right_main.addLayout(cart_right)

        splitter.addWidget(right_panel)
        # Productos: 60% de la altura, Carrito: 40%
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        splitter.setSizes([600, 400])

        layout.addWidget(splitter)

        # Cargar datos iniciales
        self.refresh_data()

    # ── Lógica de búsqueda y sugerencias ──

    def _open_search_dialog(self):
        """Abre el diálogo de búsqueda ampliada de productos."""
        if hasattr(self, '_search_dialog') and self._search_dialog:
            self._search_dialog.activateWindow()
            self._search_dialog.raise_()
            return
        initial_text = self.barcode_field.text().strip()
        rubro = getattr(self, '_selected_category', None)
        subcat = getattr(self, '_selected_subcategory', None)
        dlg = ProductSearchDialog(
            parent=self, db=self.db, initial_text=initial_text,
            rubro=rubro, subcategory=subcat, cart=list(self.cart)
        )
        dlg.product_selected.connect(self._on_product_selected_from_dialog)
        self._search_dialog = dlg
        dlg.exec_()
        self._search_dialog = None

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
        """Escáner automático detectado — agrega producto directamente sin tocar nada."""
        self.barcode_field.clear()
        self._hide_suggestions()

        # Buscar primero por código exacto
        product = self.product_model.get_by_barcode(code)

        # Si no hay coincidencia exacta, intentar búsqueda parcial
        if not product:
            products = self.product_model.get_all(search=code)
            if products:
                product = products[0]

        if product:
            self.add_to_cart(product)
            # Feedback visual breve en el indicador de sync
            self.sync_indicator.setText(f'Agregado: {product["name"]}')
            self.sync_indicator.setVisible(True)
            QTimer.singleShot(2000, lambda: self.sync_indicator.setVisible(False))
        else:
            self.sync_indicator.setText(f'No encontrado: {code}')
            self.sync_indicator.setStyleSheet(
                'color: #dc3545; background: #fee2e2; border: 1px solid #fca5a5;'
                'border-radius: 4px; padding: 2px 8px; font-weight: 600;'
            )
            self.sync_indicator.setVisible(True)
            QTimer.singleShot(2500, lambda: (
                self.sync_indicator.setVisible(False),
                self.sync_indicator.setStyleSheet(
                    'color: #198754; background: #d1fae5; border: 1px solid #6ee7b7;'
                    'border-radius: 4px; padding: 2px 8px; font-weight: 600;'
                )
            ))

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
                " OR UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(name,'Á','A'),'É','E'),'Í','I'),'Ó','O'),'Ú','U'),'Ü','U'),'Ñ','N')) LIKE ?)"
            )
            params.extend([pat, pat, pat, pat, pat_norm])
        where = ' AND '.join(clauses)
        query = f"""SELECT * FROM products WHERE {where}
                    ORDER BY is_favorite DESC, name ASC LIMIT {limit}"""
        return query, tuple(params)

    def _on_search_text_changed(self, text: str):
        """Tipeo manual — buscar en BD, mostrar sugerencias Y auto-abrir diálogo ampliado."""
        text = text.strip()
        if len(text) < 1:
            self._hide_suggestions()
            # Si hay un rubro/favoritos activos, mantener esa vista; si no, limpiar
            if not self._selected_category and not self.favorites_btn.isChecked():
                self.products_table.clearSpans()
                self.products_table.setRowCount(0)
                self._all_products = []
            return

        # Búsqueda fuzzy multi-palabra: el orden no importa, sin acentos
        try:
            query, params = self._build_fuzzy_query(text, limit=100)
            matches = self.db.execute_query(query, params) if query else []
        except Exception:
            matches = []

        # ── Actualizar tabla de productos en tiempo real ──
        self._all_products = matches
        self._populate_products_table(matches)

        # Auto-abrir diálogo de búsqueda ampliada después de 600ms de escribir
        if not hasattr(self, '_auto_open_timer'):
            self._auto_open_timer = QTimer(self)
            self._auto_open_timer.setSingleShot(True)
            self._auto_open_timer.timeout.connect(self._auto_open_search_dialog)
        
        if len(text) >= 2:  # Mínimo 2 caracteres
            self._auto_open_timer.start(1000)  # 1000ms de debounce
        else:
            self._auto_open_timer.stop()

    def _auto_open_search_dialog(self):
        """Abre el diálogo de búsqueda ampliada si no está ya abierto."""
        if hasattr(self, '_search_dialog') and self._search_dialog:
            text = self.barcode_field.text().strip()
            if text:
                self._search_dialog.search_input.setText(text)
            return
        text = self.barcode_field.text().strip()
        if len(text) < 2:
            return
        rubro = getattr(self, '_selected_category', None)
        subcat = getattr(self, '_selected_subcategory', None)
        dlg = ProductSearchDialog(
            parent=self, db=self.db, initial_text=text,
            rubro=rubro, subcategory=subcat, cart=list(self.cart)
        )
        dlg.product_selected.connect(self._on_product_selected_from_dialog)
        self._search_dialog = dlg
        dlg.exec_()
        self._search_dialog = None

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
        btn_todos.setStyleSheet(f'QPushButton{{{self._btn_on}}} QPushButton:hover{{background:#0b5ed7;}}')
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
        btn.setStyleSheet(f'QPushButton{{{self._btn_off}}} QPushButton:hover{{background:#e9ecef;}}')
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
            btn.setStyleSheet(f'QPushButton{{{self._btn_off}}} QPushButton:hover{{background:#e9ecef;}}')

        # Activar el clickeado
        clicked_btn.setChecked(True)
        clicked_btn.setStyleSheet(f'QPushButton{{{self._btn_on}}} QPushButton:hover{{background:#0b5ed7;}}')

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
                hint_item.setForeground(QColor('#6c757d'))
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
                    todos_btn.setStyleSheet(f'QPushButton{{{self._btn_on}}} QPushButton:hover{{background:#0b5ed7;}}')
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
                btn.setStyleSheet(f'QPushButton{{{self._btn_off}}} QPushButton:hover{{background:#e9ecef;}}')
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
                btn_todos.setStyleSheet(f'QPushButton{{{self._btn_on}}} QPushButton:hover{{background:#0b5ed7;}}')

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
                btn.setStyleSheet(f'QPushButton{{{self._btn_on}}} QPushButton:hover{{background:#0b5ed7;}}')
            else:
                btn.setChecked(False)
                btn.setStyleSheet(f'QPushButton{{{self._btn_off}}} QPushButton:hover{{background:#e9ecef;}}')

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

            # Col 0: Favorito
            fav_item = QTableWidgetItem('*' if product['is_favorite'] else '')
            fav_item.setTextAlignment(Qt.AlignCenter)
            fav_item.setFont(QFont('Segoe UI', 13, QFont.Bold))
            fav_item.setForeground(QColor('#f59e0b') if product['is_favorite'] else QColor('#dee2e6'))
            fav_item.setData(Qt.UserRole, product)
            self.products_table.setItem(row, 0, fav_item)

            # Col 1: Nombre
            stock_val_name = product['stock']
            if stock_val_name == 0:
                name_item = QTableWidgetItem(f"{product['name']}  [Sin stock]")
                name_item.setFont(QFont('Segoe UI', 10))
                name_item.setForeground(QColor('#dc3545'))  # rojo legible
            elif stock_val_name < 0:
                name_item = QTableWidgetItem(f"{product['name']}  [Servicio]")
                name_item.setFont(QFont('Segoe UI', 10))
                name_item.setForeground(QColor('#0d6efd'))
            else:
                name_item = QTableWidgetItem(product['name'])
                name_item.setFont(QFont('Segoe UI', 10))
            self.products_table.setItem(row, 1, name_item)

            # Col 2: Codigo de barras
            barcode_item = QTableWidgetItem(str(product.get('barcode') or ''))
            barcode_item.setFont(QFont('Courier New', 9))
            barcode_item.setForeground(QColor('#6c757d'))
            barcode_item.setTextAlignment(Qt.AlignCenter)
            self.products_table.setItem(row, 2, barcode_item)

            # Col 3: Precio
            price_item = QTableWidgetItem(f'${product["price"]:.2f}')
            price_item.setFont(QFont('Segoe UI', 10, QFont.Bold))
            price_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            self.products_table.setItem(row, 3, price_item)

            # Col 4: Stock
            stock_val = product['stock']
            stock_item = QTableWidgetItem(str(stock_val))
            stock_item.setTextAlignment(Qt.AlignCenter)
            if stock_val <= 0:
                stock_item.setForeground(QColor('#dc3545'))
                stock_item.setFont(QFont('Segoe UI', 10, QFont.Bold))
            elif stock_val < 5:
                stock_item.setForeground(QColor('#f59e0b'))
                stock_item.setFont(QFont('Segoe UI', 10, QFont.Bold))
            else:
                stock_item.setFont(QFont('Segoe UI', 10))
            self.products_table.setItem(row, 4, stock_item)

    def search_product(self):
        """Búsqueda manual (Enter en el campo o botón Buscar)."""
        search_text = self.barcode_field.text().strip()
        if not search_text:
            return

        self._hide_suggestions()

        # Buscar por código de barras primero (exacto)
        product = self.product_model.get_by_barcode(search_text)

        if product:
            # Código exacto encontrado — agregar al carrito de una
            self.add_to_cart(product)
            self.barcode_field.clear()
            return

        # Búsqueda fuzzy multi-palabra — mostrar resultados en la tabla
        try:
            query, params = self._build_fuzzy_query(search_text, limit=50)
            results = self.db.execute_query(query, params) if query else []
        except Exception:
            results = []

        if not results:
            QMessageBox.warning(self, 'Sin resultados',
                                f'No se encontro ningun producto con: {search_text}')
            return

        if len(results) == 1:
            # Un solo resultado — agregar directo al carrito
            self.add_to_cart(results[0])
            self.barcode_field.clear()
        else:
            # Mostrar resultados en la tabla para que el usuario elija
            self._all_products = results
            self._populate_products_table(results)
            self.barcode_field.clear()
            
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
        
    def update_cart_display(self):
        self.cart_table.setRowCount(len(self.cart))
        total = 0

        # Actualizar contador de items
        total_items = sum(item['quantity'] for item in self.cart)
        self.items_count_lbl.setText(f'{total_items} item{"s" if total_items != 1 else ""}')

        for row, item in enumerate(self.cart):
            has_discount = item.get('discount_amount', 0) > 0
            self.cart_table.setRowHeight(row, 44)

            # Col 0: Nombre producto
            name_text = item['product_name']
            promo_label = item.get('promo_label', '')
            name_item = QTableWidgetItem(name_text)
            name_item.setFont(QFont('Segoe UI', 9, QFont.Bold if has_discount else QFont.Normal))
            if has_discount:
                name_item.setForeground(QColor('#198754'))
            name_item.setToolTip(f'{name_text}{(" | " + promo_label) if promo_label else ""}')
            self.cart_table.setItem(row, 0, name_item)

            # Col 1: Descuento — muestra cuánto se ahorra en total (unit_discount * qty)
            if has_discount:
                orig = item.get('original_price', item['unit_price'])
                disc_total = (orig - item['unit_price']) * item['quantity']
                promo_label_tip = item.get('promo_label', '')
                disc_lbl = QLabel(
                    f'<div style="text-align:center;">'
                    f'<span style="color:#198754;font-size:9px;font-weight:bold;">DESCUENTO</span><br>'
                    f'<b style="color:#dc3545;font-size:12px;">-${disc_total:,.0f}</b>'
                    f'</div>'
                )
                disc_lbl.setAlignment(Qt.AlignCenter)
                disc_lbl.setWordWrap(True)
                disc_lbl.setStyleSheet('background:transparent; padding:1px 2px;')
                disc_lbl.setToolTip(promo_label_tip)
                self.cart_table.setCellWidget(row, 1, disc_lbl)
            else:
                disc_item = QTableWidgetItem('')
                disc_item.setTextAlignment(Qt.AlignCenter)
                self.cart_table.setItem(row, 1, disc_item)

            # Col 2: Precio final (con descuento aplicado)
            price_item = QTableWidgetItem(f'${item["unit_price"]:,.0f}')
            price_item.setTextAlignment(Qt.AlignCenter)
            price_item.setFont(QFont('Segoe UI', 10, QFont.Bold if has_discount else QFont.Normal))
            if has_discount:
                price_item.setForeground(QColor('#dc3545'))
            self.cart_table.setItem(row, 2, price_item)

            # Col 3: Cantidad (SpinBox)
            qty_spin = QSpinBox()
            qty_spin.setMinimum(1)
            max_stock = item.get('max_stock', 0)
            qty_spin.setMaximum(max_stock if max_stock > 0 else 9999)
            qty_spin.setValue(item['quantity'])
            qty_spin.setFixedHeight(32)
            qty_spin.setFont(QFont('Segoe UI', 10, QFont.Bold))
            qty_spin.setStyleSheet('''
                QSpinBox {
                    font-size: 12px; padding: 2px 2px;
                    border: 1.5px solid #ced4da; border-radius: 5px; background: #fff;
                }
                QSpinBox:focus { border-color: #4361ee; }
                QSpinBox::up-button   { width: 18px; }
                QSpinBox::down-button { width: 18px; }
            ''')
            qty_spin.valueChanged.connect(lambda v, r=row: self.update_quantity(r, v))
            self.cart_table.setCellWidget(row, 3, qty_spin)

            # Col 4: Subtotal (clickeable para editar precio)
            subtotal_item = QTableWidgetItem(f'${item["subtotal"]:,.0f}')
            subtotal_item.setTextAlignment(Qt.AlignCenter)
            subtotal_item.setFont(QFont('Segoe UI', 10, QFont.Bold))
            subtotal_item.setToolTip('Clic para editar el precio')
            if has_discount:
                subtotal_item.setForeground(QColor('#dc3545'))
            else:
                subtotal_item.setForeground(QColor('#0d6efd'))
            self.cart_table.setItem(row, 4, subtotal_item)

            # Col 5: Botón quitar
            rm_container = QWidget()
            rm_layout = QHBoxLayout(rm_container)
            rm_layout.setContentsMargins(0, 0, 0, 0)
            rm_layout.setAlignment(Qt.AlignCenter)

            rm_btn = QPushButton('X')
            rm_btn.setFixedSize(28, 28)
            rm_btn.setStyleSheet('''
                QPushButton {
                    background: #dc3545; color: white;
                    border: none; border-radius: 14px;
                    font-weight: bold; font-size: 11px;
                }
                QPushButton:hover { background: #bb2d3b; }
            ''')
            rm_btn.clicked.connect(lambda checked, r=row: self.remove_from_cart(r))
            rm_layout.addWidget(rm_btn)
            self.cart_table.setCellWidget(row, 5, rm_container)

            total += item['subtotal']

        # Total con ahorro si aplica — ajustar fuente según longitud del monto
        total_str = f'${total:,.2f}'
        font_size = 24 if len(total_str) <= 10 else (20 if len(total_str) <= 13 else 17)
        total_discount = sum(item.get('discount_amount', 0) for item in self.cart)
        if total_discount > 0:
            self.total_amount_label.setText(
                f'<span style="font-size:12px;color:#6ee7b7;font-weight:normal;">'
                f'Ahorro: ${total_discount:,.2f}</span><br>'
                f'<b style="color:#4ade80;font-size:{font_size}px;">{total_str}</b>'
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
        Muestra avisos discretos cuando una promoción de Firebase está cerca de activarse.
        Por ejemplo: '🏷️ Agregá 2 más de Shampú para activar el 3x2'.
        Solo muestra hints para promos que AÚN NO están activas (cantidad_minima no alcanzada).
        """
        if not hasattr(self, '_promo_hint_lbl'):
            return

        hints = []

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
                hint = f'🏷️  Agregá {faltan} {unidad} más de <b>{name}</b> para activar <b>{desc_txt}</b>'
                if nombre_promo and nombre_promo != desc_txt:
                    hint += f' ({nombre_promo})'
                hints.append(hint)

        if hints:
            self._promo_hint_lbl.setText('<br>'.join(hints))
            self._promo_hint_lbl.setTextFormat(Qt.RichText)
            self._promo_hint_lbl.setVisible(True)
        else:
            self._promo_hint_lbl.setVisible(False)
        
    def update_quantity(self, row, quantity):
        if row < len(self.cart):
            item = self.cart[row]
            item['quantity'] = quantity
            # Siempre recalcular precio — las promos de Firebase dependen de la cantidad
            try:
                product = self.product_model.get_by_id(item['product_id'])
                if product:
                    pricing = self._resolve_price_for_product(product, quantity)
                    item.update(pricing)
            except Exception:
                pass
            item['subtotal'] = round(quantity * item['unit_price'], 2)
            self.update_cart_display()
            
    def remove_from_cart(self, row):
        if row < len(self.cart):
            del self.cart[row]
            self.update_cart_display()

    def _on_cart_cell_clicked(self, row, col):
        """Click en col 4 (Subtotal) o col 2 (Precio) abre dialog para editar el precio unitario."""
        if col not in (2, 4):
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
                     f'<span style="color:#6c757d;font-size:11px;">Precio actual: ${current_price:,.0f}</span>')
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
        price_spin.setStyleSheet('QDoubleSpinBox { border: 2px solid #0d6efd; border-radius: 6px; padding: 4px 8px; }')
        price_spin.selectAll()
        layout.addWidget(price_spin)

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
            if new_price != current_price:
                item['unit_price'] = new_price
                item['original_price'] = item.get('original_price', current_price)
                item['discount_amount'] = 0
                item['discount_type'] = None
                item['discount_value'] = 0
                item['promo_id'] = None
                item['promo_label'] = ''
                item['subtotal'] = round(item['quantity'] * new_price, 2)
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
        if not self.cart:
            QMessageBox.warning(self, 'Carrito vacio', 'Agregue productos al carrito antes de facturar')
            return

        current_register = self.cash_register_model.get_current()
        if not current_register:
            QMessageBox.warning(self, 'Caja cerrada',
                                'Debe abrir la caja antes de realizar ventas.\n\nVaya a la seccion de Caja.')
            return

        total = sum(item['subtotal'] for item in self.cart)

        # Abrir dialogo de pago
        dialog = PaymentDialog(self, total=total)
        if dialog.exec_() != QDialog.Accepted:
            return

        payment_type = dialog.payment_type
        cash_received = dialog.cash_received
        change_given = dialog.change_given

        # Resolver nombre del cajero de turno
        turno_nombre = (
            self.current_user.get('turno_nombre')
            or self.current_user.get('full_name')
            or self.current_user.get('username', '')
        )

        sale_data = {
            'total_amount':  total,
            'payment_type':  payment_type,
            'cash_received': cash_received,
            'change_given':  change_given,
            'items':         self.cart,
            'user_id':       self.current_user.get('id'),
            'turno_nombre':  turno_nombre,
        }

        from PyQt5.QtWidgets import QMessageBox
        try:
            sale_id = self.sale_model.create(sale_data)
            if sale_id:
                sale = self.sale_model.get_by_id(sale_id)
                # Generación de ticket desactivada temporalmente
                pdf_path = None
                # pdf_path = self.pdf_generator.generate_sale_ticket(sale)

                # ── Firebase: subir venta automáticamente si hay caja abierta ──
                sale['username']     = turno_nombre
                sale['turno_nombre'] = turno_nombre
                sale['cajero']       = turno_nombre
                self._upload_sale_to_firebase(sale)

                # ── Preguntar si desea factura ARCA ─────────────────────────────
                from pos_system.ui.arca_perfil_dialog import ArcoPerfilDialog
                arca_dlg = ArcoPerfilDialog(self, total=total)
                arca_dlg.exec_()

                if arca_dlg.facturar and arca_dlg.selected_profile:
                    perfil = arca_dlg.selected_profile
                    cliente_data = arca_dlg.selected_cliente
                    from pos_system.ui.factura_dialog import FacturaDialog
                    auto_virt = (payment_type == 'transfer')
                    fac_dlg = FacturaDialog(
                        self, sale=sale, auto_virtual=auto_virt,
                        perfil=perfil, cliente_data=cliente_data
                    )
                    if cliente_data:
                        # Tiene cliente específico → mostrar dialog para confirmar
                        accepted = fac_dlg.exec_() == QDialog.Accepted
                    else:
                        # Sin cliente → Consumidor Final, generar directo sin dialog
                        fac_dlg.auto_emit()
                        accepted = fac_dlg.pdf_path is not None

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
                    # Solo abrir el ticket si fue generado
                    if pdf_path:
                        self.open_pdf(pdf_path)

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
                _log.getLogger(__name__).info(
                    f"Firebase: Venta #{sale.get('id')} subida (caja #{caja.get('id')})."
                )
            except Exception as e:
                import logging
                logging.getLogger(__name__).warning(f"Firebase upload venta: {e}")

        threading.Thread(target=_do, daemon=True).start()


class PaymentDialog(QDialog):
    """Dialogo de cobro: seleccion de pago, monto y teclado numerico"""

    def __init__(self, parent=None, total: float = 0.0):
        super().__init__(parent)
        self.total = total
        self.payment_type = 'cash'
        self.cash_received = 0.0
        self.change_given = 0.0
        self._raw_amount = ""   # valor sin comas, para parsear
        self.setWindowTitle('Cobrar')
        self.setFixedWidth(520)
        self.setModal(True)
        self.init_ui()
        self.adjustSize()
        # Centrar en pantalla
        from PyQt5.QtWidgets import QApplication
        screen = QApplication.primaryScreen().geometry()
        self.move(
            screen.center().x() - self.width() // 2,
            screen.center().y() - self.height() // 2
        )

    def init_ui(self):
        self.setStyleSheet('''
            QDialog { background: #f8f9fa; }
            QLabel#total_label { font-size: 20px; font-weight: bold; color: #198754; }
            QPushButton#btn_cash {
                background: #198754; color: white; border: none; border-radius: 8px;
                font-size: 13px; font-weight: bold; padding: 10px;
            }
            QPushButton#btn_cash:hover { background: #157347; }
            QPushButton#btn_cash:checked { background: #0f5132; border: 3px solid #0d6efd; }
            QPushButton#btn_transfer {
                background: #0d6efd; color: white; border: none; border-radius: 8px;
                font-size: 13px; font-weight: bold; padding: 10px;
            }
            QPushButton#btn_transfer:hover { background: #0b5ed7; }
            QPushButton#btn_transfer:checked { background: #084298; border: 3px solid #198754; }
            QPushButton#numpad_btn {
                background: #ffffff; border: 2px solid #ced4da; border-radius: 6px;
                font-size: 16px; font-weight: bold; color: #212529;
                min-height: 44px; max-height: 44px;
            }
            QPushButton#numpad_btn:hover { background: #e9ecef; border-color: #adb5bd; }
            QPushButton#numpad_btn:pressed { background: #0d6efd; color: white; border-color: #0d6efd; }
            QPushButton#btn_clear {
                background: #dc3545; color: white; border: none; border-radius: 6px;
                font-size: 13px; font-weight: bold; min-height: 40px; max-height: 40px;
            }
            QPushButton#btn_clear:hover { background: #bb2d3b; }
            QPushButton#btn_facturar {
                background: #198754; color: white; border: none; border-radius: 8px;
                font-size: 15px; font-weight: bold; min-height: 50px;
            }
            QPushButton#btn_facturar:hover { background: #157347; }
            QLineEdit#amount_input {
                font-size: 20px; font-weight: bold; color: #212529;
                border: 2px solid #dee2e6; border-radius: 8px;
                padding: 6px 12px; background: white;
            }
            QLineEdit#amount_input:focus { border-color: #0d6efd; }
        ''')

        main = QVBoxLayout(self)
        main.setContentsMargins(14, 12, 14, 12)
        main.setSpacing(8)

        # ── Fila superior: total ──
        total_row = QHBoxLayout()
        total_txt = QLabel('Total a cobrar:')
        total_txt.setFont(QFont('Segoe UI', 11))
        total_txt.setStyleSheet('color: #6c757d;')
        total_row.addWidget(total_txt)
        total_row.addStretch()
        self.total_lbl = QLabel(f'${self.total:,.2f}')
        self.total_lbl.setObjectName('total_label')
        self.total_lbl.setFont(QFont('Segoe UI', 20, QFont.Bold))
        total_row.addWidget(self.total_lbl)
        main.addLayout(total_row)

        sep = QFrame(); sep.setFrameShape(QFrame.HLine); sep.setStyleSheet('color:#dee2e6;')
        main.addWidget(sep)

        # ── Botones forma de pago ──
        pay_row = QHBoxLayout(); pay_row.setSpacing(8)
        self.btn_cash = QPushButton('💵  Efectivo')
        self.btn_cash.setObjectName('btn_cash'); self.btn_cash.setCheckable(True)
        self.btn_cash.setChecked(True); self.btn_cash.setMinimumHeight(38)
        self.btn_cash.setFont(QFont('Segoe UI', 11, QFont.Bold))
        self.btn_cash.clicked.connect(lambda: self._set_payment('cash'))
        pay_row.addWidget(self.btn_cash)

        self.btn_transfer = QPushButton('📲  Transferencia')
        self.btn_transfer.setObjectName('btn_transfer'); self.btn_transfer.setCheckable(True)
        self.btn_transfer.setMinimumHeight(38)
        self.btn_transfer.setFont(QFont('Segoe UI', 11, QFont.Bold))
        self.btn_transfer.clicked.connect(lambda: self._set_payment('transfer'))
        pay_row.addWidget(self.btn_transfer)
        main.addLayout(pay_row)

        # ── Layout horizontal: izquierda (datos) | derecha (numpad) ──
        h_layout = QHBoxLayout(); h_layout.setSpacing(12)

        # Panel izquierdo: monto + vuelto
        self.cash_panel = QWidget()
        left = QVBoxLayout(self.cash_panel); left.setContentsMargins(0,0,0,0); left.setSpacing(8)

        lbl_paga = QLabel('Cliente paga con:')
        lbl_paga.setFont(QFont('Segoe UI', 10, QFont.Bold))
        lbl_paga.setStyleSheet('color:#495057;')
        left.addWidget(lbl_paga)

        self.amount_input = QLineEdit()
        self.amount_input.setObjectName('amount_input')
        self.amount_input.setPlaceholderText('0.00')
        self.amount_input.setAlignment(Qt.AlignRight)
        self.amount_input.setMinimumHeight(44)
        self.amount_input.setFont(QFont('Segoe UI', 20, QFont.Bold))
        self.amount_input.setReadOnly(True)  # Solo numpad/teclado vía keyPressEvent
        # No conectar textChanged — actualizamos manualmente para evitar parsear comas
        left.addWidget(self.amount_input)

        # Vuelto
        change_frame = QFrame()
        change_frame.setStyleSheet('QFrame{background:#f0fdf4;border:2px solid #86efac;border-radius:8px;}')
        ci = QHBoxLayout(change_frame); ci.setContentsMargins(12,8,12,8)
        lbl_vuelto = QLabel('Vuelto:')
        lbl_vuelto.setFont(QFont('Segoe UI', 10, QFont.Bold))
        lbl_vuelto.setStyleSheet('color:#166534;background:transparent;border:none;')
        ci.addWidget(lbl_vuelto); ci.addStretch()
        self.change_lbl = QLabel('$0.00')
        self.change_lbl.setFont(QFont('Segoe UI', 18, QFont.Bold))
        self.change_lbl.setStyleSheet('color:#16a34a;background:transparent;border:none;')
        ci.addWidget(self.change_lbl)
        left.addWidget(change_frame)
        left.addStretch()
        h_layout.addWidget(self.cash_panel, 1)

        # Panel virtual
        self.transfer_panel = QWidget()
        tl = QVBoxLayout(self.transfer_panel); tl.setContentsMargins(0,0,0,0)
        info = QLabel('El cliente realiza la\ntransferencia o pago virtual.')
        info.setFont(QFont('Segoe UI', 10))
        info.setStyleSheet('background:#e7f3ff;color:#0d6efd;border:1px solid #b6d4fe;border-radius:8px;padding:12px;')
        info.setAlignment(Qt.AlignCenter); info.setWordWrap(True)
        tl.addWidget(info); tl.addStretch()
        self.transfer_panel.setVisible(False)
        h_layout.addWidget(self.transfer_panel, 1)

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
            btn.setFont(QFont('Segoe UI', 15, QFont.Bold)); btn.setFixedHeight(44)
            btn.clicked.connect(lambda _, t=text: self._numpad_press(t))
            numpad.addWidget(btn, row, col); numpad.setColumnStretch(col, 1)
        del_btn = QPushButton('⌫ Borrar'); del_btn.setObjectName('btn_clear')
        del_btn.setFont(QFont('Segoe UI', 11, QFont.Bold)); del_btn.setFixedHeight(40)
        del_btn.clicked.connect(self._numpad_delete)
        numpad.addWidget(del_btn, 4, 0, 1, 3)
        h_layout.addWidget(numpad_widget, 1)

        main.addLayout(h_layout)

        # ── Botón Cobrar ──
        self.facturar_btn = QPushButton('✔  COBRAR')
        self.facturar_btn.setObjectName('btn_facturar')
        self.facturar_btn.setMinimumHeight(50)
        self.facturar_btn.setFont(QFont('Segoe UI', 14, QFont.Bold))
        self.facturar_btn.clicked.connect(self._confirm)
        main.addWidget(self.facturar_btn)

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
        else:
            self.btn_cash.setChecked(False)
            self.btn_transfer.setChecked(True)
            self.cash_panel.setVisible(False)
            self.transfer_panel.setVisible(True)

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
            self.change_lbl.parent().setStyleSheet('QFrame { background: #f0fdf4; border: 2px solid #86efac; border-radius: 10px; }')
        else:
            self.change_lbl.setText(f'Faltan ${abs(change):,.2f}')
            self.change_lbl.setStyleSheet('color: #dc3545; font-size: 18px; font-weight: bold; background: transparent; border: none;')
            self.change_lbl.parent().setStyleSheet('QFrame { background: #fff5f5; border: 2px solid #fca5a5; border-radius: 10px; }')

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
        self.accept()
