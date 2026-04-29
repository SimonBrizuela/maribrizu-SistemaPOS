"""Edición rápida de stock por color de un producto conjunto.

Se abre desde el menú contextual del producto en la grilla del POS. Permite
ajustar `unidades` (cerradas) y `restante` (sobrante del abierto) de cada color
existente, agregar colores nuevos o quitar colores. Al guardar:

  - Persiste el array actualizado en `products.conjunto_colores` (JSON)
  - Recomputa los agregados (`conjunto_unidades`/`restante`/`total`) como SUMA
  - Sincroniza a Firebase (catalogo + inventario) para todas las PCs
"""
import json as _json
import logging

from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont, QDoubleValidator, QIntValidator
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QGridLayout, QLabel, QPushButton,
    QFrame, QLineEdit, QScrollArea, QWidget, QMessageBox, QSizePolicy,
    QDoubleSpinBox, QSpinBox,
)

from pos_system.ui.theme import COLORS as _GC
from pos_system.ui.conjunto_dialog import (
    parse_colores, TIPOS, UNIDADES, normalizar_unidad, format_num,
)

logger = logging.getLogger(__name__)


class EditarColoresDialog(QDialog):
    """Diálogo modal de ajuste rápido de stock por color.

    El llamador sólo pasa el `product` (dict con campos del POS). Al aceptar,
    el dialog guarda en SQLite + Firebase y emite `accept()`.
    """

    def __init__(self, product, db_manager, parent=None):
        super().__init__(parent)
        self.product = product
        self.db = db_manager

        self.contenido = float(product.get('conjunto_contenido') or 0)
        self.unidad_base = normalizar_unidad(product.get('conjunto_unidad_medida') or 'u')
        if self.unidad_base not in UNIDADES:
            self.unidad_base = 'u'
        self.tipo = (product.get('conjunto_tipo') or 'otro').lower()
        if self.tipo not in TIPOS:
            self.tipo = 'otro'
        # stock_min se aplica a CADA color como umbral de alerta
        self.stock_min = product.get('stock_min')
        try:
            self.stock_min = float(self.stock_min) if self.stock_min not in (None, '') else None
        except (TypeError, ValueError):
            self.stock_min = None

        self._row_widgets = []  # [(nombre_input, unidades_input, restante_input, remove_btn, row_frame), ...]

        self._build_ui()

        # Cargar colores existentes (o vacío)
        colores = parse_colores(product.get('conjunto_colores'))
        if colores:
            for c in colores:
                self._add_row(c['color'], c['unidades'], c['restante'],
                              precio=float(c.get('precio') or 0))
        else:
            # Si no había colores cargados, ofrecer una fila inicial vacía
            self._add_row('', 0, 0)

        self._refresh_total()

    # ------------------------------------------------------------------- UI -

    def _build_ui(self):
        self.setWindowTitle('Ajustar stock por color')
        self.setModal(True)
        self.setStyleSheet(f'QDialog {{ background: {_GC["surface_alt"]}; }}')
        self.setMinimumWidth(560)
        self.setMinimumHeight(420)

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # Header
        hdr = QFrame()
        hdr.setStyleSheet(f'QFrame {{ background: {_GC["surface"]}; border-bottom: 1px solid {_GC["border_soft"]}; }}')
        hl = QVBoxLayout(hdr)
        hl.setContentsMargins(20, 14, 20, 12)
        hl.setSpacing(2)
        title = QLabel('Ajustar stock por color')
        title.setStyleSheet(f'color: {_GC["text"]}; font-size: 16px; font-weight: 700;')
        sub_txt = self.product.get('name', '—')
        meta = TIPOS[self.tipo]
        u_short = UNIDADES[self.unidad_base]['short']
        sub_extra = f'  ·  {meta["label"]} de {format_num(self.contenido)}{u_short}'
        if self.stock_min is not None:
            sub_extra += f'  ·  Stock mínimo por color: {format_num(self.stock_min)}{u_short}'
        sub = QLabel(sub_txt + sub_extra)
        sub.setStyleSheet(f'color: {_GC["text_muted"]}; font-size: 12px;')
        hl.addWidget(title)
        hl.addWidget(sub)
        root.addWidget(hdr)

        # Body con scroll
        body = QFrame()
        body.setStyleSheet(f'QFrame {{ background: {_GC["surface_alt"]}; }}')
        bl = QVBoxLayout(body)
        bl.setContentsMargins(20, 14, 20, 14)
        bl.setSpacing(10)

        # Encabezado de columnas
        col_hdr = QFrame()
        col_hdr.setStyleSheet('background: transparent;')
        ch = QGridLayout(col_hdr)
        ch.setContentsMargins(8, 0, 8, 0)
        ch.setHorizontalSpacing(8)
        ch.setVerticalSpacing(0)
        lbl_style = f'color: {_GC["text_muted"]}; font-size: 10px; font-weight: 700; letter-spacing: 0.5px;'
        for col, txt in enumerate(['COLOR', f'{TIPOS[self.tipo]["label"].upper()}S CERRADOS',
                                   f'RESTANTE ({UNIDADES[self.unidad_base]["short"]})', '']):
            lbl = QLabel(txt)
            lbl.setStyleSheet(lbl_style)
            ch.addWidget(lbl, 0, col)
        ch.setColumnStretch(0, 3)
        ch.setColumnStretch(1, 2)
        ch.setColumnStretch(2, 2)
        ch.setColumnStretch(3, 0)
        bl.addWidget(col_hdr)

        # Scroll de filas
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setMinimumHeight(180)

        self._rows_container = QWidget()
        self._rows_layout = QVBoxLayout(self._rows_container)
        self._rows_layout.setContentsMargins(0, 0, 0, 0)
        self._rows_layout.setSpacing(6)
        self._rows_layout.addStretch(1)

        scroll.setWidget(self._rows_container)
        bl.addWidget(scroll, 1)

        # Botón agregar color
        add_btn = QPushButton('+  Agregar color')
        add_btn.setMinimumHeight(38)
        add_btn.setCursor(Qt.PointingHandCursor)
        add_btn.setStyleSheet(
            f'QPushButton {{ background: #fff; color: {_GC["text"]};'
            f'                border: 1.5px dashed {_GC["text"]};'
            f'                border-radius: 8px; font-size: 13px; font-weight: 700; }}'
            f'QPushButton:hover {{ background: {_GC["accent_soft"]}; }}'
        )
        add_btn.clicked.connect(lambda: (self._add_row('', 0, 0), self._refresh_total()))
        bl.addWidget(add_btn)

        # Total
        self._total_lbl = QLabel('')
        self._total_lbl.setStyleSheet(
            f'background: #fff; border: 1px solid {_GC["border_soft"]};'
            f'border-radius: 8px; padding: 10px 12px; color: {_GC["text"]}; font-size: 13px;'
        )
        bl.addWidget(self._total_lbl)

        root.addWidget(body, 1)

        # Footer
        ft = QFrame()
        ft.setStyleSheet(f'QFrame {{ background: {_GC["surface"]}; border-top: 1px solid {_GC["border_soft"]}; }}')
        fh = QHBoxLayout(ft)
        fh.setContentsMargins(16, 12, 16, 12)
        fh.setSpacing(10)

        cancel = QPushButton('Cancelar')
        cancel.setMinimumHeight(44)
        cancel.setCursor(Qt.PointingHandCursor)
        cancel.setStyleSheet(
            f'QPushButton {{ background: {_GC["surface_alt"]}; color: {_GC["text_dim"]};'
            f'                border: none; border-radius: 8px;'
            f'                font-size: 14px; font-weight: 700; }}'
            f'QPushButton:hover {{ background: #ece8df; }}'
        )
        cancel.clicked.connect(self.reject)

        save = QPushButton('Guardar cambios')
        save.setMinimumHeight(44)
        save.setCursor(Qt.PointingHandCursor)
        save.setStyleSheet(
            f'QPushButton {{ background: {_GC["accent"]}; color: #fff;'
            f'                border: none; border-radius: 8px;'
            f'                font-size: 14px; font-weight: 700; }}'
            f'QPushButton:hover {{ background: {_GC["accent_hover"]}; }}'
        )
        save.clicked.connect(self._on_save)

        fh.addWidget(cancel, 1)
        fh.addWidget(save, 2)
        root.addWidget(ft)

    def _add_row(self, color_name, unidades, restante, precio=0):
        row = QFrame()
        # Preservar el precio por variedad cargado desde el catálogo. Esta
        # ventana no lo edita (se setea desde la webapp), pero hay que
        # mantenerlo en el round-trip para no perderlo al guardar.
        row._precio_variedad = float(precio or 0)
        row.setStyleSheet(
            f'QFrame {{ background: #fff; border: 1px solid {_GC["border_soft"]};'
            f'           border-radius: 8px; }}'
        )
        g = QGridLayout(row)
        g.setContentsMargins(8, 6, 8, 6)
        g.setHorizontalSpacing(8)

        nombre = QLineEdit(color_name)
        nombre.setPlaceholderText('Ej: Rojo')
        nombre.setMinimumHeight(34)

        u = QSpinBox()
        u.setMinimum(0); u.setMaximum(999999)
        u.setValue(int(unidades or 0))
        u.setMinimumHeight(34)

        r = QDoubleSpinBox()
        r.setDecimals(2); r.setMinimum(0); r.setMaximum(999999)
        r.setValue(float(restante or 0))
        r.setMinimumHeight(34)

        rm = QPushButton('×')
        rm.setFixedSize(32, 32)
        rm.setCursor(Qt.PointingHandCursor)
        rm.setStyleSheet(
            f'QPushButton {{ background: transparent; color: {_GC["danger"]};'
            f'                border: 1px solid {_GC["border_soft"]}; border-radius: 16px;'
            f'                font-size: 18px; font-weight: 700; }}'
            f'QPushButton:hover {{ background: #fee; border-color: {_GC["danger"]}; }}'
        )

        for w in (nombre, u, r):
            w.setStyleSheet(
                f'QLineEdit, QSpinBox, QDoubleSpinBox {{ background: #fff;'
                f'  border: 1px solid {_GC["border_soft"]}; border-radius: 6px;'
                f'  padding: 4px 8px; font-size: 13px; color: {_GC["text"]}; }}'
                f'QLineEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus {{ border-color: {_GC["text"]}; }}'
            )

        g.addWidget(nombre, 0, 0)
        g.addWidget(u, 0, 1)
        g.addWidget(r, 0, 2)
        g.addWidget(rm, 0, 3)
        g.setColumnStretch(0, 3)
        g.setColumnStretch(1, 2)
        g.setColumnStretch(2, 2)
        g.setColumnStretch(3, 0)

        # Insertar antes del stretch
        self._rows_layout.insertWidget(self._rows_layout.count() - 1, row)
        self._row_widgets.append((nombre, u, r, rm, row))

        # Wiring
        u.valueChanged.connect(self._refresh_total)
        r.valueChanged.connect(self._refresh_total)
        nombre.textChanged.connect(self._refresh_total)
        rm.clicked.connect(lambda: self._remove_row(row))

    def _remove_row(self, row):
        for i, (n, u, r, rm, rw) in enumerate(self._row_widgets):
            if rw is row:
                self._row_widgets.pop(i)
                rw.setParent(None)
                rw.deleteLater()
                self._refresh_total()
                return

    # ------------------------------------------------------------ refresh --

    def _read_rows(self):
        """Lee las filas y devuelve lista normalizada (saltea vacías sin nombre)."""
        out = []
        for nombre, u, r, _rm, _row in self._row_widgets:
            name = (nombre.text() or '').strip()
            if not name:
                continue
            item = {
                'color':    name,
                'unidades': float(u.value()),
                'restante': float(r.value()),
            }
            pr = float(getattr(_row, '_precio_variedad', 0) or 0)
            if pr > 0:
                item['precio'] = pr
            out.append(item)
        return out

    def _refresh_total(self):
        colores = self._read_rows()
        u_short = UNIDADES[self.unidad_base]['short']
        if not colores:
            self._total_lbl.setText('Total disponible: <b>0</b> ' + u_short)
            return
        sum_u = sum(c['unidades'] for c in colores)
        sum_r = sum(c['restante'] for c in colores)
        sum_total = sum(c['unidades'] * self.contenido + c['restante'] for c in colores)
        bajos = []
        if self.stock_min is not None:
            for c in colores:
                t = c['unidades'] * self.contenido + c['restante']
                if t <= self.stock_min:
                    bajos.append((c['color'], t))
        bajos_html = ''
        if bajos:
            chips = '  '.join(
                f'<span style="color:#a01616;font-weight:700">⚠ {nm} ({format_num(t)}{u_short})</span>'
                for nm, t in bajos
            )
            bajos_html = f'<br><span style="font-size:11px;color:{_GC["text_muted"]}">Bajo stock_min:</span> {chips}'
        self._total_lbl.setText(
            f'Total: <b>{format_num(sum_total)}</b> {u_short}  '
            f'<span style="color:{_GC["text_muted"]};font-size:11px">'
            f'  ({format_num(sum_u)} cerrados + {format_num(sum_r)}{u_short} sueltos · {len(colores)} color{"es" if len(colores)!=1 else ""})'
            f'</span>{bajos_html}'
        )

    # --------------------------------------------------------------- save --

    def _on_save(self):
        colores = self._read_rows()

        # Validar duplicados (case-insensitive)
        seen = set()
        for c in colores:
            k = c['color'].lower()
            if k in seen:
                QMessageBox.warning(
                    self, 'Color duplicado',
                    f'No podés cargar dos colores con el mismo nombre: "{c["color"]}".'
                )
                return
            seen.add(k)

        # Calcular agregados (suma de todos los colores)
        sum_u = sum(c['unidades'] for c in colores)
        sum_r = sum(c['restante'] for c in colores)
        sum_total = sum(c['unidades'] * self.contenido + c['restante'] for c in colores)

        try:
            from pos_system.utils.firebase_sync import now_ar
            now_iso = now_ar().strftime('%Y-%m-%d %H:%M:%S')
        except Exception:
            from datetime import datetime
            now_iso = datetime.now().isoformat()

        # Si no quedan colores, dejamos conjunto_colores en NULL y los planos
        # (el producto vuelve a modo legacy, sin perder los unidades/restante
        # que ya tenía el producto si el usuario los borró desde acá).
        colores_json = _json.dumps(colores, ensure_ascii=False) if colores else None

        try:
            self.db.execute_update(
                """UPDATE products
                   SET conjunto_unidades = ?,
                       conjunto_restante = ?,
                       conjunto_total    = ?,
                       conjunto_colores  = ?,
                       updated_at        = ?
                   WHERE id = ?""",
                (sum_u, sum_r, sum_total, colores_json, now_iso, self.product['id'])
            )
        except Exception as e:
            logger.error(f'Error guardando ajuste de colores: {e}')
            QMessageBox.critical(self, 'Error', f'No se pudo guardar:\n{e}')
            return

        # Sync a Firebase (catalogo + inventario), no bloqueante
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if fb and fb.enabled:
                self._sync_a_firebase(fb, sum_u, sum_r, sum_total, colores)
        except Exception as e:
            logger.warning(f'No se pudo sincronizar a Firebase: {e}')

        self.accept()

    def _sync_a_firebase(self, fb, sum_u, sum_r, sum_total, colores):
        """Sube los nuevos valores a `catalogo` + `inventario`."""
        from datetime import timezone
        from pos_system.utils.firebase_sync import now_ar
        import threading

        firebase_id = (self.product.get('firebase_id') or '').strip()
        pid = self.product.get('id')
        now_dt = now_ar().astimezone(timezone.utc)

        payload = {
            'conjunto_unidades':    float(sum_u),
            'conjunto_restante':    float(sum_r),
            'conjunto_total':       float(sum_total),
            'conjunto_colores':     colores or None,
            'ultima_actualizacion': now_dt,
        }

        def _do():
            try:
                batch = fb.db.batch()
                if firebase_id:
                    batch.set(fb.db.collection('catalogo').document(firebase_id), payload, merge=True)
                if pid is not None:
                    batch.set(fb.db.collection('inventario').document(str(pid)), payload, merge=True)
                batch.commit()
                logger.info(f'Firebase: stock por color de producto #{pid} sincronizado.')
            except Exception as e:
                logger.error(f'Firebase: error sync stock por color: {e}')

        threading.Thread(target=_do, daemon=True).start()
