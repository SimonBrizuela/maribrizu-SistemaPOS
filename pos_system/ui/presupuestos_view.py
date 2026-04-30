"""Vista de Presupuestos — lista, filtra, anula, reimprime, convierte a venta."""
import logging
import os
import subprocess
import platform

from PyQt5.QtCore import Qt, pyqtSignal
from PyQt5.QtGui import QFont, QColor
from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLabel, QLineEdit,
    QTableWidget, QTableWidgetItem, QHeaderView, QSplitter, QFrame,
    QAbstractItemView, QMessageBox
)

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.presupuesto import Presupuesto
from pos_system.utils.pdf_generator import PDFGenerator

logger = logging.getLogger(__name__)


def _money(v):
    try:
        return f"$ {float(v):,.2f}".replace(',', '#').replace('.', ',').replace('#', '.')
    except Exception:
        return f"$ {v}"


def _fmt_qty(q):
    q = float(q or 0)
    return str(int(q)) if q == int(q) else f"{q:.2f}".rstrip('0').rstrip('.')


_ESTADO_LABEL = {
    'pendiente': 'Pendiente',
    'vencido': 'Vencido',
    'convertido': 'Convertido',
    'anulado': 'Anulado',
}
_ESTADO_COLOR = {
    'pendiente':   ('#fff8ee', '#c1521f'),  # bg, fg
    'vencido':     ('#f0f0f0', '#65676b'),
    'convertido':  ('#e8f6ec', '#2e7d32'),
    'anulado':     ('#fff0f0', '#c0392b'),
}


class PresupuestosView(QWidget):
    """Lista de presupuestos con filtros, búsqueda y acciones."""

    convert_to_sale_requested = pyqtSignal(list)  # emite items[] al convertir
    refresh_requested = pyqtSignal()              # disparada por listeners externos

    def __init__(self, parent=None, current_user: dict = None):
        super().__init__(parent)
        self.current_user = current_user or {}
        self.db = DatabaseManager()
        self.model = Presupuesto(self.db)
        self._estado_filter = None  # None=todos
        self._search_text = ''
        self._current_pres = None  # presupuesto seleccionado
        self._init_ui()
        self.refresh_requested.connect(self.refresh_data)
        self.refresh_data()

    # ── UI ───────────────────────────────────────────────────────────────────
    def _init_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 16, 16, 16)
        root.setSpacing(12)

        # Header: título + búsqueda + refresh
        header = QHBoxLayout()
        title = QLabel('Presupuestos')
        title.setFont(QFont('Segoe UI', 14, QFont.Bold))
        header.addWidget(title)
        header.addStretch(1)

        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText('Buscar por cliente o número…')
        self.search_input.setMinimumWidth(260)
        self.search_input.setMinimumHeight(32)
        self.search_input.textChanged.connect(self._on_search_changed)
        header.addWidget(self.search_input)

        refresh_btn = QPushButton('↻ Actualizar')
        refresh_btn.setMinimumHeight(32)
        refresh_btn.setCursor(Qt.PointingHandCursor)
        refresh_btn.clicked.connect(self.refresh_data)
        header.addWidget(refresh_btn)

        root.addLayout(header)

        # Filtros por estado (chips)
        chips = QHBoxLayout()
        chips.setSpacing(8)
        self._chip_buttons = {}
        for key, label in [
            (None, 'Todos'),
            ('pendiente', 'Pendientes'),
            ('vencido', 'Vencidos'),
            ('convertido', 'Convertidos'),
            ('anulado', 'Anulados'),
        ]:
            btn = QPushButton(label)
            btn.setCheckable(True)
            btn.setCursor(Qt.PointingHandCursor)
            btn.setMinimumHeight(30)
            btn.setMinimumWidth(110)
            btn.clicked.connect(lambda _, k=key: self._set_estado_filter(k))
            chips.addWidget(btn)
            self._chip_buttons[key] = btn
        chips.addStretch(1)
        # contador grande con el total
        self.lbl_count = QLabel('— resultados')
        self.lbl_count.setStyleSheet('color:#65676b; font-size:12px;')
        chips.addWidget(self.lbl_count)
        root.addLayout(chips)
        # Selección inicial
        self._chip_buttons[None].setChecked(True)
        self._update_chip_styles()

        # Splitter: tabla a la izq, detalle a la derecha
        splitter = QSplitter(Qt.Horizontal)
        splitter.setHandleWidth(8)

        # ── Tabla ──
        self.table = QTableWidget()
        self.table.setColumnCount(7)
        self.table.setHorizontalHeaderLabels(
            ['Número', 'Fecha', 'Cliente', 'Items', 'Total', 'Validez', 'Estado']
        )
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        self.table.setAlternatingRowColors(True)
        self.table.setStyleSheet(
            'QTableWidget { font-size: 12px; }'
            'QHeaderView::section { background:#f5f5f5; padding:6px; font-weight:600; border:none;'
            ' border-bottom:1px solid #e4e6eb; }'
            'QTableWidget::item { padding: 6px; }'
            'QTableWidget::item:selected { background:#7b3fa6; color:white; }'
        )
        h = self.table.horizontalHeader()
        h.setSectionResizeMode(2, QHeaderView.Stretch)  # cliente
        for c in (0, 1, 3, 4, 5, 6):
            h.setSectionResizeMode(c, QHeaderView.ResizeToContents)
        self.table.setMinimumWidth(540)
        self.table.itemSelectionChanged.connect(self._on_row_selected)
        self.table.doubleClicked.connect(self._on_row_double_clicked)

        splitter.addWidget(self.table)

        # ── Detalle ──
        self.detail_panel = self._build_detail_panel()
        splitter.addWidget(self.detail_panel)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        splitter.setSizes([700, 460])

        root.addWidget(splitter, 1)

    def _build_detail_panel(self):
        panel = QFrame()
        panel.setStyleSheet(
            'QFrame { background:#fafafa; border:1px solid #e4e6eb; border-radius:8px; }'
        )
        v = QVBoxLayout(panel)
        v.setContentsMargins(14, 14, 14, 14)
        v.setSpacing(8)

        self.lbl_pres_title = QLabel('Seleccioná un presupuesto')
        self.lbl_pres_title.setFont(QFont('Segoe UI', 13, QFont.Bold))
        self.lbl_pres_title.setStyleSheet('color:#7b3fa6;')
        v.addWidget(self.lbl_pres_title)

        self.lbl_pres_meta = QLabel('')
        self.lbl_pres_meta.setStyleSheet('color:#65676b; font-size:11px;')
        self.lbl_pres_meta.setWordWrap(True)
        v.addWidget(self.lbl_pres_meta)

        self.lbl_pres_cliente = QLabel('')
        self.lbl_pres_cliente.setStyleSheet('font-size:12px; color:#1c1e21;')
        self.lbl_pres_cliente.setWordWrap(True)
        v.addWidget(self.lbl_pres_cliente)

        # tabla items
        self.detail_table = QTableWidget()
        self.detail_table.setColumnCount(4)
        self.detail_table.setHorizontalHeaderLabels(['Producto', 'Cant.', 'P. Unit.', 'Subtotal'])
        self.detail_table.verticalHeader().setVisible(False)
        self.detail_table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.detail_table.setSelectionMode(QAbstractItemView.NoSelection)
        self.detail_table.setStyleSheet(
            'QTableWidget { font-size: 11px; background:white; border:1px solid #e4e6eb; }'
            'QHeaderView::section { background:#f5f5f5; padding:4px; font-weight:600; border:none;'
            ' border-bottom:1px solid #e4e6eb; }'
        )
        h = self.detail_table.horizontalHeader()
        h.setSectionResizeMode(0, QHeaderView.Stretch)
        for c in (1, 2, 3):
            h.setSectionResizeMode(c, QHeaderView.ResizeToContents)
        v.addWidget(self.detail_table, 1)

        # Totales
        self.lbl_pres_total = QLabel('')
        self.lbl_pres_total.setAlignment(Qt.AlignRight)
        self.lbl_pres_total.setStyleSheet(
            'font-size:14px; font-weight:700; color:#1c1e21; padding:4px 0;'
        )
        v.addWidget(self.lbl_pres_total)

        # Botones de acción
        btns = QHBoxLayout()
        btns.setSpacing(6)

        self.btn_open_pdf = QPushButton('Abrir PDF')
        self.btn_open_pdf.setMinimumHeight(34)
        self.btn_open_pdf.setCursor(Qt.PointingHandCursor)
        self.btn_open_pdf.clicked.connect(self._open_pdf)

        self.btn_reprint = QPushButton('Regenerar PDF')
        self.btn_reprint.setMinimumHeight(34)
        self.btn_reprint.setCursor(Qt.PointingHandCursor)
        self.btn_reprint.clicked.connect(self._regenerate_pdf)

        self.btn_anular = QPushButton('Anular')
        self.btn_anular.setMinimumHeight(34)
        self.btn_anular.setCursor(Qt.PointingHandCursor)
        self.btn_anular.setStyleSheet(
            'QPushButton { background:#fff0f0; color:#c0392b; border:1px solid #f5c6cb;'
            ' border-radius:6px; padding:4px 12px; font-weight:600; }'
            'QPushButton:hover { background:#ffd9d9; }'
        )
        self.btn_anular.clicked.connect(self._anular)

        self.btn_delete = QPushButton('Eliminar')
        self.btn_delete.setMinimumHeight(34)
        self.btn_delete.setCursor(Qt.PointingHandCursor)
        self.btn_delete.setToolTip('Quita el presupuesto del listado (soft-delete)')
        self.btn_delete.setStyleSheet(
            'QPushButton { background:white; color:#c0392b; border:1px solid #c0392b;'
            ' border-radius:6px; padding:4px 12px; font-weight:600; }'
            'QPushButton:hover { background:#c0392b; color:white; }'
        )
        self.btn_delete.clicked.connect(self._delete)

        self.btn_convert = QPushButton('Convertir a venta')
        self.btn_convert.setMinimumHeight(34)
        self.btn_convert.setCursor(Qt.PointingHandCursor)
        self.btn_convert.setStyleSheet(
            'QPushButton { background:#7b3fa6; color:white; border:none;'
            ' border-radius:6px; padding:4px 14px; font-weight:700; }'
            'QPushButton:hover { background:#6a1b9a; }'
            'QPushButton:disabled { background:#c9b6d6; color:white; }'
        )
        self.btn_convert.clicked.connect(self._convert_to_sale)

        btns.addWidget(self.btn_open_pdf)
        btns.addWidget(self.btn_reprint)
        btns.addWidget(self.btn_anular)
        btns.addWidget(self.btn_delete)
        btns.addStretch(1)
        btns.addWidget(self.btn_convert)
        v.addLayout(btns)

        self._set_actions_enabled(False)
        return panel

    # ── Filtros / search ─────────────────────────────────────────────────────
    def _set_estado_filter(self, key):
        self._estado_filter = key
        for k, btn in self._chip_buttons.items():
            btn.setChecked(k == key)
        self._update_chip_styles()
        self.refresh_data()

    def _update_chip_styles(self):
        for k, btn in self._chip_buttons.items():
            if btn.isChecked():
                btn.setStyleSheet(
                    'QPushButton { background:#7b3fa6; color:white; border:none;'
                    ' border-radius:18px; padding:6px 16px; font-weight:700; font-size:12px; }'
                )
            else:
                btn.setStyleSheet(
                    'QPushButton { background:#f0f2f5; color:#1c1e21; border:1px solid #e4e6eb;'
                    ' border-radius:18px; padding:6px 16px; font-weight:600; font-size:12px; }'
                    'QPushButton:hover { background:#e4e6eb; }'
                )

    def _on_search_changed(self, text):
        self._search_text = (text or '').strip()
        self.refresh_data()

    # ── Refresh ──────────────────────────────────────────────────────────────
    def refresh_data(self):
        # Marcar vencidos antes de listar
        try:
            n = self.model.expire_overdue()
            if n > 0:
                logger.info(f"Presupuestos: {n} marcados como vencidos")
        except Exception:
            logger.exception("Error marcando presupuestos vencidos")

        rows = self.model.list_all(
            estado=self._estado_filter,
            search=self._search_text,
            limit=500,
        )
        self.lbl_count.setText(f"{len(rows)} resultados")
        self._populate_table(rows)

    def _populate_table(self, rows):
        self.table.setRowCount(len(rows))
        for i, r in enumerate(rows):
            numero = int(r.get('numero') or 0)
            cliente = r.get('cliente_nombre') or 'Consumidor Final'
            fecha = str(r.get('fecha_emision') or '')[:16].replace('T', ' ')
            validez = str(r.get('fecha_validez') or '')[:10]
            total = r.get('total') or 0
            estado = r.get('estado') or 'pendiente'

            self._set_cell(i, 0, f'P-{numero:05d}', bold=True)
            self._set_cell(i, 1, fecha)
            self._set_cell(i, 2, cliente)

            # Items count: requiere subquery; lo vamos a inferir por id si está disponible
            items_count = self._count_items(r['id'])
            self._set_cell(i, 3, str(items_count), align=Qt.AlignCenter)

            self._set_cell(i, 4, _money(total), align=Qt.AlignRight, bold=True)
            self._set_cell(i, 5, validez, align=Qt.AlignCenter)

            estado_item = QTableWidgetItem(_ESTADO_LABEL.get(estado, estado))
            bg, fg = _ESTADO_COLOR.get(estado, ('#f0f0f0', '#65676b'))
            estado_item.setBackground(QColor(bg))
            estado_item.setForeground(QColor(fg))
            f = estado_item.font()
            f.setBold(True)
            estado_item.setFont(f)
            estado_item.setTextAlignment(Qt.AlignCenter)
            estado_item.setData(Qt.UserRole, r['id'])  # guardamos id para selección
            self.table.setItem(i, 6, estado_item)

    def _count_items(self, pres_id):
        rows = self.db.execute_query(
            "SELECT COUNT(*) as c FROM presupuesto_items WHERE presupuesto_id = ?",
            (pres_id,)
        )
        return rows[0]['c'] if rows else 0

    def _set_cell(self, row, col, text, align=None, bold=False):
        item = QTableWidgetItem(str(text))
        if align is not None:
            item.setTextAlignment(align | Qt.AlignVCenter)
        if bold:
            f = item.font()
            f.setBold(True)
            item.setFont(f)
        self.table.setItem(row, col, item)

    # ── Selección + detalle ─────────────────────────────────────────────────
    def _on_row_selected(self):
        sel = self.table.selectionModel().selectedRows()
        if not sel:
            self._current_pres = None
            self._set_actions_enabled(False)
            self.lbl_pres_title.setText('Seleccioná un presupuesto')
            self.lbl_pres_meta.setText('')
            self.lbl_pres_cliente.setText('')
            self.detail_table.setRowCount(0)
            self.lbl_pres_total.setText('')
            return
        row = sel[0].row()
        # id viene en col 6 (estado), Qt.UserRole
        item = self.table.item(row, 6)
        pres_id = item.data(Qt.UserRole) if item else None
        if not pres_id:
            return
        pres = self.model.get_by_id(int(pres_id))
        if not pres:
            return
        self._current_pres = pres
        self._render_detail(pres)
        self._set_actions_enabled(True, pres)

    def _on_row_double_clicked(self, _):
        self._open_pdf()

    def _render_detail(self, pres):
        numero = int(pres.get('numero') or 0)
        estado = pres.get('estado') or 'pendiente'
        bg, fg = _ESTADO_COLOR.get(estado, ('#f0f0f0', '#65676b'))
        self.lbl_pres_title.setText(f"P-{numero:05d}  ·  {_ESTADO_LABEL.get(estado, estado)}")
        self.lbl_pres_title.setStyleSheet(f"color:{fg}; background:{bg}; padding:6px 10px; border-radius:6px;")

        fecha_em = str(pres.get('fecha_emision') or '')[:16].replace('T', ' ')
        validez = str(pres.get('fecha_validez') or '')[:10]
        cajero = pres.get('cajero_nombre') or '—'
        meta = (
            f"<b>Emitido:</b> {fecha_em} &nbsp;·&nbsp; "
            f"<b>Válido hasta:</b> {validez} &nbsp;·&nbsp; "
            f"<b>Cajero:</b> {cajero}"
        )
        if pres.get('venta_id'):
            meta += f" &nbsp;·&nbsp; <b>Venta:</b> #{pres['venta_id']}"
        self.lbl_pres_meta.setText(meta)
        self.lbl_pres_meta.setTextFormat(Qt.RichText)

        cli = pres.get('cliente_nombre') or 'Consumidor Final'
        extras = []
        if pres.get('cliente_telefono'):
            extras.append(f"📞 {pres['cliente_telefono']}")
        if pres.get('cliente_email'):
            extras.append(f"✉ {pres['cliente_email']}")
        cli_html = f"<b>{cli}</b>"
        if extras:
            cli_html += '<br/>' + ' · '.join(extras)
        self.lbl_pres_cliente.setText(cli_html)
        self.lbl_pres_cliente.setTextFormat(Qt.RichText)

        # Items
        items = pres.get('items') or []
        self.detail_table.setRowCount(len(items))
        for i, it in enumerate(items):
            self.detail_table.setItem(i, 0, QTableWidgetItem(str(it.get('product_name') or '—')))
            qi = QTableWidgetItem(_fmt_qty(it.get('quantity')))
            qi.setTextAlignment(Qt.AlignCenter | Qt.AlignVCenter)
            self.detail_table.setItem(i, 1, qi)
            up = QTableWidgetItem(_money(it.get('unit_price') or 0))
            up.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            self.detail_table.setItem(i, 2, up)
            sub = QTableWidgetItem(_money(it.get('subtotal') or 0))
            sub.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            self.detail_table.setItem(i, 3, sub)

        total_v = pres.get('total') or 0
        descuento = pres.get('descuento') or 0
        if descuento and float(descuento) > 0:
            self.lbl_pres_total.setText(
                f"Descuento: -{_money(descuento)} &nbsp;&nbsp; "
                f"<span style='font-size:16px; color:#7b3fa6'>TOTAL: {_money(total_v)}</span>"
            )
        else:
            self.lbl_pres_total.setText(
                f"<span style='font-size:16px; color:#7b3fa6'>TOTAL: {_money(total_v)}</span>"
            )
        self.lbl_pres_total.setTextFormat(Qt.RichText)

    def _set_actions_enabled(self, enabled, pres=None):
        self.btn_open_pdf.setEnabled(enabled and bool(pres) and bool(pres.get('pdf_path')))
        self.btn_reprint.setEnabled(enabled)
        # Solo se puede anular pendientes/vencidos
        anulable = bool(pres) and pres.get('estado') in ('pendiente', 'vencido')
        self.btn_anular.setEnabled(enabled and anulable)
        # Solo se puede convertir pendientes/vencidos
        convertible = bool(pres) and pres.get('estado') in ('pendiente', 'vencido')
        self.btn_convert.setEnabled(enabled and convertible)
        self.btn_delete.setEnabled(enabled and bool(pres))

    # ── Acciones ────────────────────────────────────────────────────────────
    def _open_pdf(self):
        if not self._current_pres:
            return
        path = self._current_pres.get('pdf_path') or ''
        if not path or not os.path.exists(path):
            # No existe, regeneramos
            self._regenerate_pdf()
            return
        self._open_file(path)

    def _regenerate_pdf(self):
        if not self._current_pres:
            return
        try:
            pdf_gen = PDFGenerator()
            pdf_path = pdf_gen.generate_presupuesto_a4(self._current_pres)
            self.model.set_pdf_path(self._current_pres['id'], pdf_path)
            self._current_pres['pdf_path'] = pdf_path
            self._open_file(pdf_path)
        except Exception as e:
            logger.exception('Error regenerando PDF')
            QMessageBox.critical(self, 'Error', f'No se pudo regenerar el PDF:\n{e}')

    def _open_file(self, path):
        try:
            if platform.system() == 'Windows':
                os.startfile(path)
            elif platform.system() == 'Darwin':
                subprocess.run(['open', path])
            else:
                subprocess.run(['xdg-open', path])
        except Exception as e:
            logger.exception('Error abriendo PDF')
            QMessageBox.warning(self, 'PDF', f'No se pudo abrir el archivo:\n{e}')

    def _anular(self):
        if not self._current_pres:
            return
        numero = int(self._current_pres.get('numero') or 0)
        reply = QMessageBox.question(
            self, 'Anular presupuesto',
            f'¿Anular el presupuesto P-{numero:05d}?\n\nEsta acción no se puede deshacer.',
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No
        )
        if reply != QMessageBox.Yes:
            return
        try:
            self.model.set_estado(self._current_pres['id'], 'anulado')
            # sync a Firebase si está disponible (no bloqueante)
            self._try_sync_firebase()
            self.refresh_data()
        except Exception as e:
            logger.exception('Error anulando')
            QMessageBox.critical(self, 'Error', f'No se pudo anular:\n{e}')

    def _convert_to_sale(self):
        if not self._current_pres:
            return
        numero = int(self._current_pres.get('numero') or 0)
        reply = QMessageBox.question(
            self, 'Convertir a venta',
            f'Cargar los items del presupuesto P-{numero:05d} al carrito de Ventas?\n\n'
            f'Después de cobrar, este presupuesto quedará marcado como CONVERTIDO.',
            QMessageBox.Yes | QMessageBox.No, QMessageBox.Yes
        )
        if reply != QMessageBox.Yes:
            return

        items = self._current_pres.get('items') or []
        # Buscar la SalesView en la ventana principal
        try:
            mw = self.window()
            sales_view = getattr(mw, 'sales_view', None)
            if not sales_view:
                QMessageBox.warning(self, 'No disponible',
                                    'No se encontró la pestaña Ventas.')
                return

            # Cargar al carrito
            sales_view.cart = []
            for it in items:
                sales_view.cart.append({
                    'product_id':   it.get('product_id'),
                    'product_name': it.get('product_name', ''),
                    'quantity':     float(it.get('quantity') or 0),
                    'unit_price':   float(it.get('unit_price') or 0),
                    'original_price': float(it.get('unit_price') or 0),
                    'subtotal':     float(it.get('subtotal') or 0),
                    'discount_type': None,
                    'discount_value': 0,
                    'discount_amount': 0,
                })
            sales_view.update_cart_display()

            # Marcar el presupuesto como pendiente de convertir → guardamos
            # un atributo en sales_view para que al completar la venta lo cierre.
            sales_view._pending_presupuesto_id = self._current_pres['id']

            # Cambiar a la pestaña Ventas
            tabs = getattr(mw, 'tabs', None)
            if tabs:
                for i in range(tabs.count()):
                    if tabs.widget(i) is sales_view:
                        tabs.setCurrentIndex(i)
                        break

            QMessageBox.information(
                self, 'Carrito cargado',
                f'Se cargaron {len(items)} items al carrito.\n'
                f'Cobrá normalmente para concretar la conversión.'
            )
        except Exception as e:
            logger.exception('Error convirtiendo')
            QMessageBox.critical(self, 'Error', f'No se pudo convertir:\n{e}')

    def _delete(self):
        if not self._current_pres:
            return
        numero = int(self._current_pres.get('numero') or 0)
        reply = QMessageBox.question(
            self, 'Eliminar presupuesto',
            f'¿Eliminar el presupuesto P-{numero:05d} del listado?\n\n'
            f'Se quita de la web y del POS. La numeración no se reutiliza.',
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No
        )
        if reply != QMessageBox.Yes:
            return
        try:
            self.model.soft_delete(self._current_pres['id'])
            # Sync a Firebase: marcar deleted=true
            try:
                from pos_system.utils.firebase_sync import get_firebase_sync
                fb = get_firebase_sync()
                if fb and hasattr(fb, 'upsert_presupuesto'):
                    pres = self.model.get_by_id(self._current_pres['id'])
                    if pres:
                        fb.upsert_presupuesto(pres)
            except Exception:
                logger.exception('Sync delete presupuesto a Firebase falló')
            self._current_pres = None
            self.refresh_data()
        except Exception as e:
            logger.exception('Error eliminando presupuesto')
            QMessageBox.critical(self, 'Error', f'No se pudo eliminar:\n{e}')

    def _try_sync_firebase(self):
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if fb and hasattr(fb, 'upsert_presupuesto') and self._current_pres:
                # Re-leer del DB para que el payload tenga la última versión
                pres = self.model.get_by_id(self._current_pres['id'])
                if pres:
                    fb.upsert_presupuesto(pres)
        except Exception:
            logger.exception('Error sync presupuesto a Firebase')
