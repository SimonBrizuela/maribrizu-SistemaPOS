from PyQt5.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QTableWidget,
                             QTableWidgetItem, QPushButton, QLineEdit, QLabel,
                             QComboBox, QDialog, QFormLayout, QMessageBox,
                             QFileDialog, QSpinBox, QDoubleSpinBox, QTextEdit,
                             QHBoxLayout, QFrame, QScrollArea, QInputDialog, QMenu)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont, QPixmap, QColor
from datetime import datetime
from pos_system.utils.firebase_sync import now_ar
import os

from pos_system.models.product import Product
from pos_system.utils.image_handler import ImageHandler
from pos_system.ui.components import PriceInput

class ProductsView(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        from pos_system.database.db_manager import DatabaseManager
        self.db = DatabaseManager()
        self.product_model = Product(self.db)
        self.image_handler = ImageHandler()
        self.init_ui()
    
    def get_main_window(self):
        """Obtiene la ventana principal"""
        widget = self
        while widget:
            if hasattr(widget, 'refresh_all_views'):
                return widget
            widget = widget.parent()
        return None
        
    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        
        # Título
        title = QLabel('Productos')
        title.setFont(QFont('Arial', 16, QFont.Bold))
        title.setStyleSheet('color: #2c3e50; padding: 10px;')
        layout.addWidget(title)

        # ── Estilos para botones de rubro ──
        self._btn_off = ('background:#fafaf7;color:#5a5448;border:1.5px solid #dcd6c8;'
                         'border-radius:6px;padding:4px 12px;font-size:11px;font-weight:bold;')
        self._btn_on  = ('background:#c1521f;color:white;border:1.5px solid #c1521f;'
                         'border-radius:6px;padding:4px 12px;font-size:11px;font-weight:bold;')
        self._selected_category = None
        self._category_buttons = {}

        # ── Fila SECCIÓN: etiqueta + botones de rubros ──
        section_row = QHBoxLayout()
        section_row.setSpacing(6)

        section_lbl = QLabel('SECCIÓN:')
        section_lbl.setFont(QFont('Arial', 10, QFont.Bold))
        section_lbl.setStyleSheet('color: #5a5448;')
        section_row.addWidget(section_lbl)

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

        layout.addLayout(section_row)

        # ── Combo de CATEGORÍAS (desplegable simple) ──
        subcat_row = QHBoxLayout()
        subcat_row.setSpacing(6)

        subcat_lbl = QLabel('Categoría:')
        subcat_lbl.setFont(QFont('Arial', 10, QFont.Bold))
        subcat_lbl.setStyleSheet('color: #5a5448;')
        subcat_row.addWidget(subcat_lbl)

        self._subcat_combo = QComboBox()
        self._subcat_combo.setMinimumHeight(34)
        self._subcat_combo.setFont(QFont('Arial', 10))
        self._subcat_combo.setStyleSheet('''
            QComboBox {
                border: 1.5px solid #dcd6c8;
                border-radius: 6px;
                padding: 4px 10px;
                background: white;
                color: #1c1c1e;
            }
            QComboBox:focus { border-color: #c1521f; }
            QComboBox::drop-down { border: none; width: 24px; }
            QComboBox QAbstractItemView {
                border: 1px solid #dcd6c8;
                border-radius: 4px;
                selection-background-color: #c1521f;
                selection-color: white;
                font-size: 11px;
            }
        ''')
        self._subcat_combo.currentTextChanged.connect(self._on_subcat_combo_changed)
        subcat_row.addWidget(self._subcat_combo, 1)

        self._subcat_container = QWidget()
        self._subcat_container.setLayout(subcat_row)
        self._subcat_container.setVisible(False)
        layout.addWidget(self._subcat_container)

        self._selected_subcategory = None
        self._subcat_buttons = {}

        # Barra de búsqueda y filtros
        search_layout = QHBoxLayout()
        
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText('Buscar por nombre, código de barras o descripción...')
        self.search_input.setFont(QFont('Arial', 10))
        self.search_input.textChanged.connect(self.filter_products)
        search_layout.addWidget(self.search_input, 3)
        
        # Mantener el combo por compatibilidad (oculto, usa los botones)
        self.category_filter = QComboBox()
        self.category_filter.setFont(QFont('Arial', 10))
        self.category_filter.addItem('Todas las Categorías')
        self.category_filter.setVisible(False)
        
        self.favorites_btn = QPushButton('Solo Favoritos')
        self.favorites_btn.setCheckable(True)
        self.favorites_btn.clicked.connect(self.filter_products)
        search_layout.addWidget(self.favorites_btn)
        
        layout.addLayout(search_layout)

        # Cargar botones de rubros
        self._load_rubro_buttons()
        
        # Botones de acción
        buttons_layout = QHBoxLayout()
        
        add_btn = QPushButton('Nuevo Producto')
        add_btn.setObjectName('btnSuccess')
        add_btn.setToolTip('Crear un nuevo producto')
        add_btn.clicked.connect(self.add_product)
        buttons_layout.addWidget(add_btn)

        edit_btn = QPushButton('Editar')
        edit_btn.setObjectName('btnSecondary')
        edit_btn.setToolTip('Editar el producto seleccionado')
        edit_btn.clicked.connect(self.edit_product)
        buttons_layout.addWidget(edit_btn)

        stock_btn = QPushButton('Ajustar Stock')
        stock_btn.setObjectName('btnWarning')
        stock_btn.setToolTip('Ajustar el stock del producto seleccionado manualmente')
        stock_btn.clicked.connect(self.adjust_stock)
        buttons_layout.addWidget(stock_btn)

        delete_btn = QPushButton('Eliminar')
        delete_btn.setObjectName('btnDanger')
        delete_btn.setToolTip('Eliminar el producto seleccionado')
        delete_btn.clicked.connect(self.delete_product)
        buttons_layout.addWidget(delete_btn)

        buttons_layout.addStretch()

        low_stock_btn = QPushButton('Stock Bajo')
        low_stock_btn.setObjectName('btnSecondary')
        low_stock_btn.setToolTip('Ver solo productos con stock bajo')
        low_stock_btn.clicked.connect(self.show_low_stock)
        buttons_layout.addWidget(low_stock_btn)

        print_missing_btn = QPushButton('Imprimir faltantes')
        print_missing_btn.setObjectName('btnSecondary')
        print_missing_btn.setToolTip('Genera un PDF con los productos con stock bajo')
        print_missing_btn.clicked.connect(self.print_low_stock)
        buttons_layout.addWidget(print_missing_btn)

        refresh_btn = QPushButton('Actualizar')
        refresh_btn.setObjectName('btnSecondary')
        refresh_btn.clicked.connect(self.refresh_data)
        buttons_layout.addWidget(refresh_btn)
        
        layout.addLayout(buttons_layout)
        
        # Tabla de productos
        self.products_table = QTableWidget()
        self.products_table.setColumnCount(10)
        self.products_table.setHorizontalHeaderLabels([
            'Imagen', 'ID', 'Nombre', 'Categoria', 'Precio', 'Descuento', 'Costo', 'Stock', 'Cod. Barras', 'Fav.'
        ])
        self.products_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.products_table.setSelectionMode(QTableWidget.SingleSelection)
        self.products_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.products_table.setAlternatingRowColors(True)
        # Doble-click abre edición sólo si hay exactamente una fila seleccionada —
        # evita abrir el diálogo de edición por accidente durante una selección
        # múltiple o drag (ej. seleccionar todo de golpe).
        self.products_table.doubleClicked.connect(self._on_product_double_clicked)
        from PyQt5.QtWidgets import QHeaderView as QHV4
        hh = self.products_table.horizontalHeader()
        hh.setSectionResizeMode(0, QHV4.Fixed)
        hh.setSectionResizeMode(1, QHV4.ResizeToContents)
        hh.setSectionResizeMode(2, QHV4.Stretch)
        hh.setSectionResizeMode(3, QHV4.ResizeToContents)
        hh.setSectionResizeMode(4, QHV4.ResizeToContents)
        hh.setSectionResizeMode(5, QHV4.ResizeToContents)
        hh.setSectionResizeMode(6, QHV4.ResizeToContents)
        hh.setSectionResizeMode(7, QHV4.ResizeToContents)
        hh.setSectionResizeMode(8, QHV4.ResizeToContents)
        hh.setSectionResizeMode(9, QHV4.ResizeToContents)
        self.products_table.setColumnWidth(0, 70)
        self.products_table.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        layout.addWidget(self.products_table)
        
        # Cargar datos iniciales
        self.refresh_data()
        
    def _load_rubro_buttons(self):
        """Carga los rubros desde la BD y crea botones para cada uno."""
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
        btn.setContextMenuPolicy(Qt.CustomContextMenu)
        btn.customContextMenuRequested.connect(lambda pos, b=btn: self._show_rubro_context_menu(b, pos))
        self._rubros_layout.addWidget(btn)
        self._category_buttons[name] = btn

    def _on_rubro_btn_clicked(self, clicked_btn: QPushButton):
        """Maneja la selección de un botón de rubro."""
        for btn in self._category_buttons.values():
            btn.setChecked(False)
            btn.setStyleSheet(f'QPushButton{{{self._btn_off}}} QPushButton:hover{{background:#ece8df;}}')
        clicked_btn.setChecked(True)
        clicked_btn.setStyleSheet(f'QPushButton{{{self._btn_on}}} QPushButton:hover{{background:#a3441a;}}')

        rubro = clicked_btn.property('rubro_name')
        self._selected_category = rubro if rubro else None
        self._selected_subcategory = None

        if self._selected_category:
            self._load_subcategory_buttons(self._selected_category)
            # Mostrar hint o cargar todos los productos del rubro
            subcats = self.db.execute_query(
                """SELECT sc.name FROM sub_categories sc
                   JOIN products p ON UPPER(p.category) = UPPER(sc.name) AND p.rubro = sc.rubro
                   WHERE UPPER(sc.rubro) = ? GROUP BY sc.name LIMIT 1""",
                (self._selected_category.upper(),)
            )
            if subcats:
                # Hay subcategorías → mostrar hint
                self.products_table.clearSpans()
                self.products_table.setRowCount(1)
                self.products_table.setSpan(0, 0, 1, 10)
                hint_item = QTableWidgetItem(
                    f'{self._selected_category} — Elegí una categoría arriba o buscá por nombre'
                )
                hint_item.setTextAlignment(Qt.AlignCenter)
                from PyQt5.QtGui import QColor
                hint_item.setForeground(QColor('#6f6a5d'))
                from PyQt5.QtGui import QFont
                hint_item.setFont(QFont('Segoe UI', 11))
                self.products_table.setItem(0, 0, hint_item)
            else:
                # Sin subcategorías → cargar todos del rubro
                self.filter_products()
        else:
            self._subcat_container.setVisible(False)
            self.products_table.clearSpans()
            self.products_table.setRowCount(0)

    def _load_subcategory_buttons(self, rubro: str):
        """Carga las subcategorías del rubro filtrando solo las que tienen productos reales."""
        results = self.db.execute_query(
            """SELECT sc.name, COUNT(p.id) as n
               FROM sub_categories sc
               LEFT JOIN products p ON UPPER(p.category) = UPPER(sc.name) AND p.rubro = sc.rubro
               WHERE UPPER(sc.rubro) = ?
               GROUP BY sc.name
               HAVING COUNT(p.id) > 0
               ORDER BY sc.name ASC""",
            (rubro.upper(),)
        )

        if results:
            subcats = [r['name'] for r in results if r['name']]
        else:
            # Fallback: desde products directamente
            results = self.db.execute_query(
                """SELECT DISTINCT category, COUNT(*) as n FROM products
                   WHERE UPPER(rubro) = ? AND category IS NOT NULL AND category != ''
                   GROUP BY category ORDER BY n DESC, category ASC""",
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
        self.filter_products()

    def _show_rubro_context_menu(self, btn: QPushButton, pos):
        """Menú contextual para editar o borrar un rubro."""
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

    def _rename_rubro(self, cat_id: int, old_name: str, btn: QPushButton):
        """Renombra un rubro en la BD y actualiza el botón."""
        new_name, ok = QInputDialog.getText(self, 'Renombrar Rubro', 'Nuevo nombre:', text=old_name)
        if not ok or not new_name.strip() or new_name.strip() == old_name:
            return
        new_name = new_name.strip()
        try:
            self.db.rename_category(cat_id, new_name)
            if old_name in self._category_buttons:
                del self._category_buttons[old_name]
            btn.setText(new_name)
            btn.setProperty('rubro_name', new_name)
            self._category_buttons[new_name] = btn
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
            if name in self._category_buttons:
                b = self._category_buttons.pop(name)
                self._rubros_layout.removeWidget(b)
                b.deleteLater()
            if self._selected_category == name:
                self._selected_category = None
                if '' in self._category_buttons:
                    todos_btn = self._category_buttons['']
                    todos_btn.setChecked(True)
                    todos_btn.setStyleSheet(f'QPushButton{{{self._btn_on}}} QPushButton:hover{{background:#a3441a;}}')
            self.filter_products()
            QMessageBox.information(self, 'Éxito', f'Rubro "{name}" eliminado.')
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo eliminar: {e}')

    def refresh_data(self):
        """Recarga rubros y productos si hay filtro activo."""
        self._load_rubro_buttons()
        # Si había un rubro seleccionado, re-seleccionarlo
        if self._selected_category and self._selected_category in self._category_buttons:
            btn = self._category_buttons[self._selected_category]
            btn.setChecked(True)
            btn.setStyleSheet(f'QPushButton{{{self._btn_on}}} QPushButton:hover{{background:#a3441a;}}')
        if self._selected_category or self.favorites_btn.isChecked():
            self.filter_products()

    @staticmethod
    def _build_search_clauses(search_text: str):
        """
        Construye cláusulas SQL para búsqueda multi-palabra, tolerante a acentos.
        Cada palabra debe aparecer en algún campo (name, barcode, description, category).
        Ej: "goma borrar" encuentra "GOMA DE BORRAR".
        Ej: "lapiz" encuentra "LÁPIZ COLOR".
        """
        def normalize(t):
            t = t.upper()
            for a, b in [('Á','A'),('É','E'),('Í','I'),('Ó','O'),('Ú','U'),('Ü','U'),('Ñ','N')]:
                t = t.replace(a, b)
            return t

        words = [w for w in search_text.strip().split() if w]
        if not words:
            return "", []

        clauses = []
        params = []
        for w in words:
            pat      = f'%{w.upper()}%'
            pat_norm = f'%{normalize(w)}%'
            clauses.append(
                "(UPPER(name) LIKE ? OR UPPER(barcode) LIKE ? OR UPPER(description) LIKE ? OR UPPER(category) LIKE ?"
                " OR UPPER(firebase_id) LIKE ?"
                " OR UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(name,'Á','A'),'É','E'),'Í','I'),'Ó','O'),'Ú','U'),'Ü','U'),'Ñ','N')) LIKE ?)"
            )
            params.extend([pat, pat, pat, pat, pat, pat_norm])

        return ' AND '.join(clauses), params

    def filter_products(self):
        search_text = self.search_input.text().strip()
        only_favorites = self.favorites_btn.isChecked()

        # Si no hay ningún filtro activo, no cargar nada
        if not search_text and not self._selected_category and not self._selected_subcategory and not only_favorites:
            self.products_table.clearSpans()
            self.products_table.setRowCount(0)
            return

        fav_clause = " AND is_favorite = 1" if only_favorites else ""

        if self._selected_subcategory:
            # Rubro + subcategoría → filtrar por ambos
            params = [self._selected_category.upper(), self._selected_subcategory.upper()]
            search_clause = ""
            if search_text:
                sc, sp = self._build_search_clauses(search_text)
                search_clause = f" AND ({sc})"
                params += sp
            products = self.db.execute_query(
                f"SELECT * FROM products WHERE UPPER(rubro) = ? AND UPPER(category) = ?"
                f"{search_clause}{fav_clause} ORDER BY name LIMIT 300",
                tuple(params)
            )
        elif self._selected_category:
            # Solo rubro seleccionado, sin subcategoría → cargar todo el rubro
            params = [self._selected_category.upper()]
            search_clause = ""
            if search_text:
                sc, sp = self._build_search_clauses(search_text)
                search_clause = f" AND ({sc})"
                params += sp
            products = self.db.execute_query(
                f"SELECT * FROM products WHERE UPPER(rubro) = ?"
                f"{search_clause}{fav_clause} ORDER BY name LIMIT 300",
                tuple(params)
            )
        else:
            # Solo búsqueda o favoritos
            if search_text:
                sc, params = self._build_search_clauses(search_text)
                where = f" WHERE ({sc})"
                if only_favorites:
                    where += " AND is_favorite = 1"
            elif only_favorites:
                where = " WHERE is_favorite = 1"
                params = []
            else:
                where = ""
                params = []
            # Excluir el producto sentinel "Varios" (id=0) del listado
            id_filter = " WHERE id != 0" if not where else " AND id != 0"
            products = self.db.execute_query(
                f"SELECT * FROM products{where}{id_filter} ORDER BY name LIMIT 300",
                tuple(params)
            )

        # Actualizar tabla
        self.products_table.clearSpans()
        self.products_table.setRowCount(len(products))
        
        for row, product in enumerate(products):
            # Establecer altura de fila
            self.products_table.setRowHeight(row, 70)
            
            # Imagen del producto
            image_label = QLabel()
            if product['image_path'] and os.path.exists(product['image_path']):
                pixmap = QPixmap(product['image_path'])
                if not pixmap.isNull():
                    scaled_pixmap = pixmap.scaled(60, 60, Qt.KeepAspectRatio, Qt.SmoothTransformation)
                    image_label.setPixmap(scaled_pixmap)
                    image_label.setStyleSheet('padding: 5px;')
                else:
                    image_label.setText('[ ]')
                    image_label.setStyleSheet('font-size: 14px; color: #9b958a; padding: 5px;')
            else:
                image_label.setText('[ ]')
                image_label.setStyleSheet('font-size: 14px; color: #9b958a; padding: 5px;')
            image_label.setAlignment(Qt.AlignCenter)
            self.products_table.setCellWidget(row, 0, image_label)
            
            self.products_table.setItem(row, 1, QTableWidgetItem(str(product['id'])))
            self.products_table.setItem(row, 2, QTableWidgetItem(product['name']))
            self.products_table.setItem(row, 3, QTableWidgetItem(product['category'] or ''))
            self.products_table.setItem(row, 4, QTableWidgetItem(f"${product['price']:.2f}"))

            # Descuento
            dtype = product.get('discount_type') or ''
            dval  = product.get('discount_value') or 0
            if dtype == 'percentage' and dval > 0:
                disc_text = f"-{dval:.0f}%"
                disc_item = QTableWidgetItem(disc_text)
                disc_item.setForeground(QColor('#a01616'))
                disc_item.setFont(QFont('Arial', 9, QFont.Bold))
            elif dtype == 'fixed' and dval > 0:
                disc_text = f"-${dval:.2f}"
                disc_item = QTableWidgetItem(disc_text)
                disc_item.setForeground(QColor('#a01616'))
                disc_item.setFont(QFont('Arial', 9, QFont.Bold))
            else:
                disc_item = QTableWidgetItem('')
            disc_item.setTextAlignment(Qt.AlignCenter)
            self.products_table.setItem(row, 5, disc_item)

            self.products_table.setItem(row, 6, QTableWidgetItem(f"${product['cost']:.2f}"))
            
            # Stock con color
            stock_item = QTableWidgetItem(str(product['stock']))
            if product['stock'] < 10:
                stock_item.setBackground(QColor('#fbe5e5'))
                stock_item.setForeground(QColor('#c00'))
            elif product['stock'] < 20:
                stock_item.setBackground(QColor('#ffeaa7'))
            stock_item.setTextAlignment(Qt.AlignCenter)
            self.products_table.setItem(row, 7, stock_item)
            
            self.products_table.setItem(row, 8, QTableWidgetItem(product['barcode'] or ''))
            
            favorite_item = QTableWidgetItem('Si' if product['is_favorite'] else 'No')
            favorite_item.setTextAlignment(Qt.AlignCenter)
            self.products_table.setItem(row, 9, favorite_item)
        
    def add_product(self):
        dialog = ProductDialog(self)
        if dialog.exec_() == QDialog.Accepted:
            self.refresh_data()
            main_window = self.get_main_window()
            if main_window:
                main_window.refresh_all_views()
                
    def _on_product_double_clicked(self, index):
        """Doble-click en la tabla: sólo abre edición si hay una fila seleccionada.
        Previene abrir el diálogo por accidente durante selecciones múltiples."""
        sel_rows = {ix.row() for ix in self.products_table.selectionModel().selectedRows()}
        if len(sel_rows) > 1:
            return
        # Asegurar que el click estuvo sobre una fila válida
        if index is None or not index.isValid():
            return
        self.edit_product()

    def edit_product(self):
        selected_row = self.products_table.currentRow()
        if selected_row < 0:
            QMessageBox.warning(self, 'Advertencia', 'Por favor seleccione un producto')
            return
            
        product_id = int(self.products_table.item(selected_row, 1).text())  # Columna 1 ahora es ID
        product = self.product_model.get_by_id(product_id)
        
        dialog = ProductDialog(self, product)
        if dialog.exec_() == QDialog.Accepted:
            self.refresh_data()
            main_window = self.get_main_window()
            if main_window:
                main_window.refresh_all_views()
                
    def delete_product(self):
        selected_row = self.products_table.currentRow()
        if selected_row < 0:
            QMessageBox.warning(self, 'Advertencia', 'Por favor seleccione un producto')
            return

        product_id = int(self.products_table.item(selected_row, 1).text())
        product_name = self.products_table.item(selected_row, 2).text()

        reply = QMessageBox.question(
            self, 'Confirmar Eliminación',
            f'¿Está seguro que desea eliminar el producto "{product_name}"?',
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No
        )

        if reply == QMessageBox.Yes:
            if self.product_model.delete(product_id):
                # Eliminar también de Firebase inmediatamente
                try:
                    from pos_system.utils.firebase_sync import get_firebase_sync
                    fb = get_firebase_sync()
                    if fb:
                        fb.delete_product(product_id)
                except Exception:
                    pass
                QMessageBox.information(self, 'Éxito', 'Producto eliminado correctamente')
                self.refresh_data()
                main_window = self.get_main_window()
                if main_window:
                    main_window.refresh_all_views()
            else:
                QMessageBox.critical(self, 'Error', 'No se pudo eliminar el producto')

    def adjust_stock(self):
        """Ajuste manual de stock del producto seleccionado"""
        selected_row = self.products_table.currentRow()
        if selected_row < 0:
            QMessageBox.warning(self, 'Advertencia', 'Por favor seleccione un producto')
            return

        product_id = int(self.products_table.item(selected_row, 1).text())
        product_name = self.products_table.item(selected_row, 2).text()
        product = self.product_model.get_by_id(product_id)

        dialog = StockAdjustDialog(self, product_name=product_name, current_stock=product['stock'])
        if dialog.exec_() == QDialog.Accepted:
            quantity_change = dialog.get_quantity_change()
            reason = dialog.reason_input.text().strip() or 'Ajuste manual'

            try:
                new_stock = product['stock'] + quantity_change
                if new_stock < 0:
                    QMessageBox.warning(self, 'Error',
                        f'El ajuste dejaría el stock en {new_stock}. No se permiten stocks negativos.')
                    return

                self.product_model.update_stock(product_id, quantity_change)

                # Registrar el ajuste en la tabla de ajustes
                self.db.execute_update(
                    "INSERT INTO stock_adjustments (product_id, quantity_change, reason) VALUES (?, ?, ?)",
                    (product_id, quantity_change, reason)
                )

                QMessageBox.information(self, 'Éxito',
                    f'Stock actualizado: {product["stock"]} → {new_stock} unidades')
                self.refresh_data()
                main_window = self.get_main_window()
                if main_window:
                    main_window._check_low_stock_badge()
            except Exception as e:
                QMessageBox.critical(self, 'Error', f'No se pudo ajustar el stock: {e}')

    def print_low_stock(self):
        """Genera y abre un PDF con los productos faltantes (stock bajo)."""
        import os, platform, subprocess
        threshold = 10
        try:
            products = self.product_model.get_low_stock(threshold=threshold)
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo obtener el stock: {e}')
            return

        try:
            from pos_system.utils.pdf_generator import PDFGenerator
            pdf = PDFGenerator()
            filepath = pdf.generate_low_stock_report(products, threshold=threshold)
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo generar el PDF: {e}')
            return

        try:
            if platform.system() == 'Windows':
                os.startfile(filepath)
            elif platform.system() == 'Darwin':
                subprocess.run(['open', filepath])
            else:
                subprocess.run(['xdg-open', filepath])
        except Exception as e:
            QMessageBox.warning(self, 'PDF generado',
                f'PDF guardado en:\n{filepath}\n\nNo se pudo abrir automáticamente: {e}')
            return

        if not products:
            QMessageBox.information(self, 'Sin faltantes',
                'No hay productos con stock bajo.\nSe generó un PDF vacío de todos modos.')

    def show_low_stock(self):
        """Filtra y muestra solo productos con stock bajo"""
        low_stock = self.product_model.get_low_stock(threshold=10)
        self.products_table.setRowCount(len(low_stock))
        for row, product in enumerate(low_stock):
            self.products_table.setRowHeight(row, 70)
            image_label = QLabel()
            image_label.setText('BAJO')
            image_label.setStyleSheet('font-size: 10px; color: #a01616; font-weight: bold; padding: 5px;')
            image_label.setAlignment(Qt.AlignCenter)
            self.products_table.setCellWidget(row, 0, image_label)
            self.products_table.setItem(row, 1, QTableWidgetItem(str(product['id'])))
            self.products_table.setItem(row, 2, QTableWidgetItem(product['name']))
            self.products_table.setItem(row, 3, QTableWidgetItem(product['category'] or ''))
            self.products_table.setItem(row, 4, QTableWidgetItem(f"${product['price']:.2f}"))
            self.products_table.setItem(row, 5, QTableWidgetItem(f"${product['cost']:.2f}"))
            from PyQt5.QtGui import QColor
            stock_item = QTableWidgetItem(str(product['stock']))
            stock_item.setBackground(QColor('#fbe5e5'))
            stock_item.setForeground(QColor('#c00'))
            stock_item.setFont(QFont('Arial', 10, QFont.Bold))
            stock_item.setTextAlignment(Qt.AlignCenter)
            self.products_table.setItem(row, 6, stock_item)
            self.products_table.setItem(row, 7, QTableWidgetItem(product['barcode'] or ''))

class StockAdjustDialog(QDialog):
    """Dialog for manual stock adjustment"""
    def __init__(self, parent=None, product_name: str = '', current_stock: int = 0):
        super().__init__(parent)
        self.current_stock = current_stock
        self.setWindowTitle('Ajustar Stock')
        self.setMinimumWidth(380)
        self.init_ui(product_name, current_stock)

    def init_ui(self, product_name: str, current_stock: int):
        layout = QFormLayout(self)
        layout.setSpacing(12)
        layout.setContentsMargins(20, 20, 20, 20)

        product_label = QLabel(f'<b>{product_name}</b>')
        product_label.setFont(QFont('Segoe UI', 11))
        layout.addRow('Producto:', product_label)

        stock_label = QLabel(f'<b style="font-size:14px;">{current_stock}</b> unidades actuales')
        stock_label.setFont(QFont('Segoe UI', 10))
        layout.addRow('Stock Actual:', stock_label)

        # Tipo de ajuste
        self.type_combo = QComboBox()
        self.type_combo.addItem('Agregar stock (entrada)', 'add')
        self.type_combo.addItem('Quitar stock (salida/merma)', 'remove')
        self.type_combo.setMinimumHeight(36)
        self.type_combo.currentIndexChanged.connect(self._update_preview)
        layout.addRow('Tipo de Ajuste:', self.type_combo)

        self.quantity_input = QSpinBox()
        self.quantity_input.setMinimum(1)
        self.quantity_input.setMaximum(999999)
        self.quantity_input.setValue(1)
        self.quantity_input.setMinimumHeight(36)
        self.quantity_input.valueChanged.connect(self._update_preview)
        layout.addRow('Cantidad:', self.quantity_input)

        self.reason_input = QLineEdit()
        self.reason_input.setPlaceholderText('Ej: Compra, merma, inventario físico...')
        self.reason_input.setMinimumHeight(36)
        layout.addRow('Motivo:', self.reason_input)

        self.preview_label = QLabel()
        self.preview_label.setFont(QFont('Segoe UI', 10, QFont.Bold))
        self.preview_label.setStyleSheet('color: #c1521f; padding: 4px;')
        layout.addRow('Resultado:', self.preview_label)

        btn_layout = QHBoxLayout()
        ok_btn = QPushButton('Aplicar Ajuste')
        ok_btn.setObjectName('btnSuccess')
        ok_btn.clicked.connect(self.accept)
        cancel_btn = QPushButton('Cancelar')
        cancel_btn.clicked.connect(self.reject)
        btn_layout.addWidget(ok_btn)
        btn_layout.addWidget(cancel_btn)
        layout.addRow('', btn_layout)

        self._update_preview()

    def _update_preview(self):
        qty = self.quantity_input.value()
        is_add = self.type_combo.currentData() == 'add'
        change = qty if is_add else -qty
        new_stock = self.current_stock + change
        sign = '+' if is_add else '-'
        color = '#3d7a3a' if new_stock >= 0 else '#a01616'
        self.preview_label.setText(
            f'{self.current_stock} {sign} {qty} = <b style="color:{color};">{new_stock}</b> unidades'
        )

    def get_quantity_change(self) -> int:
        qty = self.quantity_input.value()
        return qty if self.type_combo.currentData() == 'add' else -qty


class ProductDialog(QDialog):
    def __init__(self, parent=None, product=None):
        super().__init__(parent)
        self.product = product
        from pos_system.database.db_manager import DatabaseManager
        self.db = DatabaseManager()
        self.product_model = Product(self.db)
        self.image_handler = ImageHandler()
        self.image_path = None
        self.init_ui()
        
    def init_ui(self):
        self.setWindowTitle('Nuevo Producto' if not self.product else 'Editar Producto')
        self.setMinimumWidth(500)
        
        layout = QFormLayout(self)
        
        # Campos
        self.name_input = QLineEdit()
        self.name_input.setFont(QFont('Arial', 10))
        layout.addRow('Nombre:', self.name_input)
        
        self.description_input = QTextEdit()
        self.description_input.setMaximumHeight(80)
        self.description_input.setFont(QFont('Arial', 10))
        layout.addRow('Descripción:', self.description_input)
        
        self.price_input = PriceInput(placeholder='0.00')
        self.price_input.setFont(QFont('Arial', 10))
        layout.addRow('Precio ($):', self.price_input)

        self.cost_input = PriceInput(placeholder='0.00')
        self.cost_input.setFont(QFont('Arial', 10))
        layout.addRow('Costo ($):', self.cost_input)
        
        self.stock_input = QSpinBox()
        self.stock_input.setMaximum(999999)
        self.stock_input.setFont(QFont('Arial', 10))
        layout.addRow('Stock actual:', self.stock_input)

        # ── Alertas de stock ──
        alert_title = QLabel('Alertas de stock (opcional)')
        alert_title.setFont(QFont('Arial', 9, QFont.Bold))
        alert_title.setStyleSheet('color:#c1521f;')
        layout.addRow(alert_title)

        self.stock_min_input = QSpinBox()
        self.stock_min_input.setMinimum(0)
        self.stock_min_input.setMaximum(999999)
        self.stock_min_input.setFont(QFont('Arial', 10))
        self.stock_min_input.setSpecialValueText('(sin alerta)')
        self.stock_min_input.setToolTip(
            'Si el stock baja a este número o menos, el producto aparecerá como faltante.\n'
            'Dejalo en 0 para usar el umbral general.'
        )
        layout.addRow('Stock mínimo (avisar):', self.stock_min_input)

        self.stock_max_input = QSpinBox()
        self.stock_max_input.setMinimum(0)
        self.stock_max_input.setMaximum(999999)
        self.stock_max_input.setFont(QFont('Arial', 10))
        self.stock_max_input.setSpecialValueText('(sin tope)')
        self.stock_max_input.setToolTip('Stock máximo / ideal para reposición. Solo informativo.')
        layout.addRow('Stock máximo (ideal):', self.stock_max_input)

        barcode_row = QHBoxLayout()
        self.barcode_input = QLineEdit()
        self.barcode_input.setFont(QFont('Arial', 10))
        barcode_row.addWidget(self.barcode_input, 1)

        self._gen_codes_btn = QPushButton('Generar código + barra')
        self._gen_codes_btn.setObjectName('btnSecondary')
        self._gen_codes_btn.setToolTip(
            'Genera un código interno (AUTO-N) y un código de barras (POSN) únicos '
            'que no colisionen con otros productos.'
        )
        self._gen_codes_btn.clicked.connect(self._on_generate_codes)
        barcode_row.addWidget(self._gen_codes_btn)

        layout.addRow('Código de Barras:', barcode_row)

        self.category_input = QComboBox()
        self.category_input.setEditable(True)
        self.category_input.setFont(QFont('Arial', 10))
        self.category_input.setPlaceholderText('Seleccionar / Crear categoría...')
        self.category_input.lineEdit().setPlaceholderText('Seleccionar / Crear categoría...')
        # Opción vacía al inicio para que no quede nada seleccionado por defecto
        self.category_input.addItem('')
        categories = self.product_model.get_categories()
        self.category_input.addItems(categories)
        self.category_input.setCurrentIndex(0)
        layout.addRow('Categoría:', self.category_input)
        
        # ── Descuento del producto ──
        disc_sep = QFrame()
        disc_sep.setFrameShape(QFrame.HLine)
        disc_sep.setStyleSheet('color:#dcd6c8;')
        layout.addRow(disc_sep)

        disc_title = QLabel('Descuento del producto')
        disc_title.setFont(QFont('Arial', 10, QFont.Bold))
        disc_title.setStyleSheet('color:#a01616;')
        layout.addRow(disc_title)

        self.discount_type_combo = QComboBox()
        self.discount_type_combo.setFont(QFont('Arial', 10))
        self.discount_type_combo.addItem('Sin descuento', '')
        self.discount_type_combo.addItem('Porcentaje (%)', 'percentage')
        self.discount_type_combo.addItem('Monto fijo ($)', 'fixed')
        self.discount_type_combo.currentIndexChanged.connect(self._on_discount_type_changed)
        layout.addRow('Tipo de descuento:', self.discount_type_combo)

        self.discount_value_spin = QDoubleSpinBox()
        self.discount_value_spin.setFont(QFont('Arial', 10))
        self.discount_value_spin.setMinimum(0)
        self.discount_value_spin.setMaximum(100)
        self.discount_value_spin.setDecimals(2)
        self.discount_value_spin.setVisible(False)
        layout.addRow('Valor de descuento:', self.discount_value_spin)

        self.discount_preview = QLabel('')
        self.discount_preview.setStyleSheet('color:#a01616; font-weight:bold; font-size:11px;')
        self.discount_preview.setVisible(False)
        layout.addRow('', self.discount_preview)

        self.price_input.valueChanged.connect(self._update_discount_preview)
        self.discount_value_spin.valueChanged.connect(self._update_discount_preview)

        disc_sep2 = QFrame()
        disc_sep2.setFrameShape(QFrame.HLine)
        disc_sep2.setStyleSheet('color:#dcd6c8;')
        layout.addRow(disc_sep2)

        # Imagen
        image_layout = QHBoxLayout()
        self.image_label = QLabel('Sin imagen')
        self.image_label.setFixedSize(150, 150)
        self.image_label.setStyleSheet('border: 2px solid #dcd6c8; background: #f0f0f0;')
        self.image_label.setAlignment(Qt.AlignCenter)
        image_layout.addWidget(self.image_label)
        
        image_btn = QPushButton('Seleccionar Imagen')
        image_btn.clicked.connect(self.select_image)
        image_layout.addWidget(image_btn)
        
        layout.addRow('Imagen:', image_layout)
        
        # Botones
        buttons_layout = QHBoxLayout()
        
        save_btn = QPushButton('Guardar')
        save_btn.setFont(QFont('Arial', 10))
        save_btn.clicked.connect(self.save_product)
        buttons_layout.addWidget(save_btn)
        
        cancel_btn = QPushButton('Cancelar')
        cancel_btn.setObjectName('btnSecondary')
        cancel_btn.setFont(QFont('Arial', 10))
        cancel_btn.clicked.connect(self.reject)
        buttons_layout.addWidget(cancel_btn)
        
        layout.addRow('', buttons_layout)
        
        # Cargar datos si es edición
        if self.product:
            self.load_product_data()
            
    def _on_discount_type_changed(self):
        dtype = self.discount_type_combo.currentData()
        has_disc = bool(dtype)
        self.discount_value_spin.setVisible(has_disc)
        self.discount_preview.setVisible(has_disc)
        if dtype == 'percentage':
            self.discount_value_spin.setSuffix(' %')
            self.discount_value_spin.setMaximum(100)
        elif dtype == 'fixed':
            self.discount_value_spin.setSuffix(' $')
            self.discount_value_spin.setMaximum(999999)
        self._update_discount_preview()

    def _update_discount_preview(self, *args):
        dtype = self.discount_type_combo.currentData()
        dval  = self.discount_value_spin.value()
        price = self.price_input.value()
        if not dtype or dval <= 0 or price <= 0:
            self.discount_preview.setText('')
            return
        if dtype == 'percentage':
            final = price * (1 - dval / 100)
            self.discount_preview.setText(f'Precio con descuento: ${final:.2f}  (ahorra ${price - final:.2f})')
        elif dtype == 'fixed':
            final = max(0, price - dval)
            self.discount_preview.setText(f'Precio con descuento: ${final:.2f}')

    def load_product_data(self):
        self.name_input.setText(self.product['name'])
        self.description_input.setText(self.product['description'] or '')
        self.price_input.setValue(self.product['price'])
        self.cost_input.setValue(self.product['cost'])
        self.stock_input.setValue(self.product['stock'])
        smin = self.product.get('stock_min')
        self.stock_min_input.setValue(int(smin) if smin is not None else 0)
        smax = self.product.get('stock_max')
        self.stock_max_input.setValue(int(smax) if smax is not None else 0)
        self.barcode_input.setText(self.product['barcode'] or '')
        self.category_input.setCurrentText(self.product['category'] or '')

        # Cargar descuento
        dtype = self.product.get('discount_type') or ''
        dval  = self.product.get('discount_value') or 0
        idx = self.discount_type_combo.findData(dtype)
        if idx >= 0:
            self.discount_type_combo.setCurrentIndex(idx)
        self.discount_value_spin.setValue(float(dval))
        self._on_discount_type_changed()
        
        if self.product['image_path']:
            self.image_path = self.product['image_path']
            pixmap = QPixmap(self.image_path)
            if not pixmap.isNull():
                self.image_label.setPixmap(pixmap.scaled(150, 150, Qt.KeepAspectRatio))
                
    def select_image(self):
        file_path, _ = QFileDialog.getOpenFileName(
            self,
            'Seleccionar Imagen',
            '',
            'Images (*.png *.jpg *.jpeg *.bmp)'
        )
        
        if file_path:
            self.image_path = file_path
            pixmap = QPixmap(file_path)
            self.image_label.setPixmap(pixmap.scaled(150, 150, Qt.KeepAspectRatio))
            
    def _on_generate_codes(self):
        from pos_system.utils.code_generator import generate_unique_codes
        try:
            codigo, barcode = generate_unique_codes(self.db)
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudieron generar códigos: {e}')
            return
        self.barcode_input.setText(barcode)
        self._generated_codigo_interno = codigo
        QMessageBox.information(
            self, 'Códigos generados',
            f'Código interno: {codigo}\nCódigo de barras: {barcode}\n\n'
            'Se asignarán al guardar.'
        )

    def save_product(self):
        # Validar campos
        if not self.name_input.text():
            QMessageBox.warning(self, 'Error', 'El nombre es obligatorio')
            return

        # Auto-generar códigos si faltan y es un producto nuevo
        from pos_system.utils.code_generator import generate_unique_codes
        barcode_val = self.barcode_input.text().strip()
        firebase_id_val = getattr(self, '_generated_codigo_interno', None)
        if not self.product and not barcode_val:
            try:
                auto_codigo, auto_barcode = generate_unique_codes(self.db)
                barcode_val = auto_barcode
                firebase_id_val = firebase_id_val or auto_codigo
                self.barcode_input.setText(auto_barcode)
            except Exception:
                pass

        # Preparar datos
        dtype = self.discount_type_combo.currentData() or None
        dval  = self.discount_value_spin.value() if dtype else 0.0
        product_data = {
            'name': self.name_input.text(),
            'description': self.description_input.toPlainText(),
            'price': self.price_input.value(),
            'cost': self.cost_input.value(),
            'stock': self.stock_input.value(),
            'barcode': barcode_val or None,
            'category': self.category_input.currentText() or None,
            'discount_type': dtype,
            'discount_value': dval,
            'stock_min': self.stock_min_input.value() or None,
            'stock_max': self.stock_max_input.value() or None,
        }
        if not self.product and firebase_id_val:
            product_data['firebase_id'] = firebase_id_val
        
        # Guardar imagen si hay una nueva
        if self.image_path and (not self.product or self.image_path != self.product.get('image_path')):
            saved_path = self.image_handler.save_product_image(self.image_path)
            if saved_path:
                product_data['image_path'] = saved_path
        
        # Crear o actualizar
        try:
            if self.product:
                success = self.product_model.update(self.product['id'], **product_data)
            else:
                product_id = self.product_model.create(product_data)
                success = product_id is not None
                
            if success:
                QMessageBox.information(self, 'Éxito', 'Producto guardado correctamente')
                self.accept()
            else:
                QMessageBox.critical(self, 'Error', 'No se pudo guardar el producto')
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'Error al guardar: {str(e)}')
