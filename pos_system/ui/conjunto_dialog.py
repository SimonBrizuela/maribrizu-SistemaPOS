"""Diálogo de venta de Producto Conjunto (rollo/pack/caja/bobina/bolsa/plancha).

Replica el mockup V4 táctil: header del producto, breakdown de stock
(cerrados / abierto / total), selector de modo (fracción / unidad / conjunto entero),
display grande de cantidad, chips de unidades compatibles, teclado numérico,
preview oscuro con stock posterior y footer Cancelar / Confirmar.
"""
from PyQt5.QtCore import Qt, pyqtSignal
from PyQt5.QtGui import QFont, QFontDatabase
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QGridLayout, QLabel, QPushButton,
    QFrame, QSizePolicy, QWidget, QButtonGroup, QSpacerItem,
)


TIPOS = {
    'rollo':   {'label': 'Rollo',   'unidad_default': 'm',  'vende_por': ['fraccion', 'conjunto']},
    'pack':    {'label': 'Pack',    'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
    'caja':    {'label': 'Caja',    'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
    'bobina':  {'label': 'Bobina',  'unidad_default': 'm',  'vende_por': ['fraccion', 'conjunto']},
    'bolsa':   {'label': 'Bolsa',   'unidad_default': 'kg', 'vende_por': ['fraccion', 'conjunto']},
    'plancha': {'label': 'Plancha', 'unidad_default': 'm2', 'vende_por': ['fraccion', 'conjunto']},
    'otro':    {'label': 'Otro',    'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
}

UNIDADES = {
    'm':   {'label': 'metros',      'short': 'm',  'base': 'longitud', 'factor': 1.0},
    'cm':  {'label': 'centímetros', 'short': 'cm', 'base': 'longitud', 'factor': 0.01},
    'u':   {'label': 'unidades',    'short': 'u',  'base': 'cuenta',   'factor': 1.0},
    'g':   {'label': 'gramos',      'short': 'g',  'base': 'masa',     'factor': 0.001},
    'kg':  {'label': 'kilogramos',  'short': 'kg', 'base': 'masa',     'factor': 1.0},
    'l':   {'label': 'litros',      'short': 'L',  'base': 'volumen',  'factor': 1.0},
    'ml':  {'label': 'mililitros',  'short': 'mL', 'base': 'volumen',  'factor': 0.001},
    'm2':  {'label': 'metro²',      'short': 'm²', 'base': 'area',     'factor': 1.0},
}

# La webapp guarda nombres largos ('metros', 'unidades', etc); los normalizo
# al short usado acá.
WEBAPP_UNIDAD = {
    'metros':    'm',
    'centimetros': 'cm',
    'cm':        'cm',
    'unidades':  'u',
    'gramos':    'g',
    'kilos':     'kg',
    'kg':        'kg',
    'litros':    'l',
    'l':         'l',
    'm2':        'm2',
}


def normalizar_unidad(unidad_raw):
    if not unidad_raw:
        return 'u'
    key = str(unidad_raw).strip().lower()
    return WEBAPP_UNIDAD.get(key, key if key in UNIDADES else 'u')


def unidades_compatibles(unidad_base):
    base = UNIDADES.get(unidad_base, {}).get('base')
    if not base:
        return [unidad_base]
    return [k for k, v in UNIDADES.items() if v['base'] == base]


def convertir(cantidad, desde, hasta):
    if desde == hasta:
        return cantidad
    f, t = UNIDADES.get(desde), UNIDADES.get(hasta)
    if not f or not t or f['base'] != t['base']:
        return None
    return (cantidad * f['factor']) / t['factor']


def total_conjunto(unidades, contenido, restante):
    return float(unidades or 0) * float(contenido or 0) + float(restante or 0)


def format_num(n):
    if n is None:
        return '—'
    try:
        n = float(n)
    except (TypeError, ValueError):
        return '—'
    if abs(n - round(n)) < 1e-9:
        return str(int(round(n)))
    return f'{n:.2f}'.rstrip('0').rstrip('.')


def aplicar_venta(unidades, contenido, restante, cantidad, vender_por,
                  unidad_base, unidad_venta=None):
    """Simula la venta. Devuelve (ok, error, after_unidades, after_restante)."""
    unidades = float(unidades or 0)
    contenido = float(contenido or 0)
    restante = float(restante or 0)
    cantidad = float(cantidad or 0)

    if cantidad <= 0:
        return False, 'La cantidad debe ser mayor a 0', unidades, restante

    if vender_por == 'conjunto':
        if unidades < cantidad:
            return False, f'Solo hay {format_num(unidades)} cerrado(s)', unidades, restante
        return True, '', unidades - cantidad, restante

    cantidad_base = cantidad
    if vender_por == 'fraccion' and unidad_venta and unidad_venta != unidad_base:
        c = convertir(cantidad, unidad_venta, unidad_base)
        if c is None:
            return False, 'Unidad incompatible', unidades, restante
        cantidad_base = c

    total = unidades * contenido + restante
    if cantidad_base > total + 1e-9:
        return False, f'No hay suficiente. Disponible: {format_num(total)} {UNIDADES[unidad_base]["short"]}', unidades, restante

    rest_to_consume = cantidad_base
    if restante > 0:
        take = min(restante, rest_to_consume)
        restante -= take
        rest_to_consume -= take

    while rest_to_consume > 1e-9:
        if unidades <= 0:
            return False, 'Stock insuficiente', unidades, restante
        unidades -= 1
        if rest_to_consume >= contenido - 1e-9:
            rest_to_consume -= contenido
        else:
            restante = contenido - rest_to_consume
            rest_to_consume = 0

    return True, '', unidades, restante


# ---------- Estilos (paleta del tema Graphite) -----------------------------
from pos_system.ui.theme import COLORS as _GC

DIALOG_BG     = _GC['surface_alt']
HEADER_BG     = _GC['surface']
BORDER        = _GC['border']
SOFT_BORDER   = _GC['border_soft']
TEXT_DARK     = _GC['text']
TEXT_MUTED    = _GC['text_muted']
TEXT_DIM      = _GC['text_dim']
PILL_BG       = _GC['surface_alt']
PREVIEW_BG    = _GC['text']
PREVIEW_DIM   = _GC['text_dim']
DANGER        = _GC['danger']
DANGER_BORDER = _GC['danger']
WARN          = _GC['warning']
ACCENT        = _GC['accent']
ACCENT_HOVER  = _GC['accent_hover']
ACCENT_SOFT   = _GC['accent_soft']

MONO_FAMILIES = ['JetBrains Mono', 'Cascadia Mono', 'Consolas', 'Menlo', 'monospace']


def _mono_family():
    db = QFontDatabase()
    available = set(db.families())
    for f in MONO_FAMILIES:
        if f in available:
            return f
    return 'monospace'


# ---------- Widgets ---------------------------------------------------------

class _PillButton(QPushButton):
    """Botón con estado activo/inactivo (fondo oscuro/claro)."""
    def __init__(self, text, parent=None):
        super().__init__(text, parent)
        self.setCheckable(True)
        self.setFlat(True)
        self.setCursor(Qt.PointingHandCursor)
        self.setMinimumHeight(40)
        self._refresh()
        self.toggled.connect(lambda _: self._refresh())

    def _refresh(self):
        active = self.isChecked()
        self.setStyleSheet(
            f'QPushButton {{'
            f'  background: {TEXT_DARK if active else "transparent"};'
            f'  color: {"#fff" if active else TEXT_DIM};'
            f'  border-radius: 7px;'
            f'  font-weight: 600;'
            f'  font-size: 13px;'
            f'  padding: 10px 14px;'
            f'  border: none;'
            f'}}'
        )


class _ChipButton(QPushButton):
    """Chip seleccionable para unidades compatibles (m / cm / mL...)."""
    def __init__(self, text, parent=None):
        super().__init__(text, parent)
        self.setCheckable(True)
        self.setFlat(True)
        self.setCursor(Qt.PointingHandCursor)
        self.setMinimumHeight(38)
        self._refresh()
        self.toggled.connect(lambda _: self._refresh())

    def _refresh(self):
        active = self.isChecked()
        self.setStyleSheet(
            f'QPushButton {{'
            f'  background: {TEXT_DARK if active else "#fff"};'
            f'  color: {"#fff" if active else TEXT_DIM};'
            f'  border: 1px solid {TEXT_DARK if active else BORDER};'
            f'  border-radius: 10px;'
            f'  padding: 8px 14px;'
            f'  font-weight: 600;'
            f'  font-size: 13px;'
            f'}}'
        )


class _Keypad(QWidget):
    """Teclado numérico 3x4 (7-8-9 / 4-5-6 / 1-2-3 / . - 0 - ⌫)."""
    pressed = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        grid = QGridLayout(self)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setSpacing(6)
        keys = [
            ('7', 0, 0), ('8', 0, 1), ('9', 0, 2),
            ('4', 1, 0), ('5', 1, 1), ('6', 1, 2),
            ('1', 2, 0), ('2', 2, 1), ('3', 2, 2),
            ('.', 3, 0), ('0', 3, 1), ('del', 3, 2),
        ]
        for label, r, c in keys:
            btn = QPushButton('⌫' if label == 'del' else label)
            btn.setMinimumHeight(52)
            btn.setCursor(Qt.PointingHandCursor)
            color = DANGER if label == 'del' else TEXT_DARK
            bg = PILL_BG if label == '.' else '#fff'
            btn.setStyleSheet(
                f'QPushButton {{'
                f'  background: {bg};'
                f'  color: {color};'
                f'  border: 1px solid {BORDER};'
                f'  border-radius: 10px;'
                f'  font-size: 20px;'
                f'  font-weight: 600;'
                f'}}'
                f'QPushButton:pressed {{ background: {PILL_BG}; }}'
            )
            btn.clicked.connect(lambda _, k=label: self.pressed.emit(k))
            grid.addWidget(btn, r, c)


class _StockCell(QFrame):
    """Una celda del breakdown (Cerrados / Abierto / Total)."""
    def __init__(self, label, value, sub, mono_family, value_color=None, with_borders=False, parent=None):
        super().__init__(parent)
        v = QVBoxLayout(self)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(2)
        v.setAlignment(Qt.AlignCenter)

        l = QLabel(label.upper())
        l.setAlignment(Qt.AlignCenter)
        l.setStyleSheet(f'color: {TEXT_MUTED}; font-size: 11px; font-weight: 600; letter-spacing: 0.5px;')

        val = QLabel(value)
        val.setAlignment(Qt.AlignCenter)
        color = value_color or TEXT_DARK
        val.setStyleSheet(f'color: {color}; font-size: 22px; font-weight: 700;')
        f = QFont(mono_family); f.setPointSize(16); f.setBold(True)
        val.setFont(f)

        s = QLabel(sub)
        s.setAlignment(Qt.AlignCenter)
        s.setStyleSheet(f'color: {TEXT_MUTED}; font-size: 11px;')

        v.addWidget(l)
        v.addWidget(val)
        v.addWidget(s)

        if with_borders:
            self.setStyleSheet(
                f'_StockCell {{ border-left: 1px solid {SOFT_BORDER};'
                f'              border-right: 1px solid {SOFT_BORDER}; }}'
            )


# ---------- Diálogo principal ----------------------------------------------

class ConjuntoDialog(QDialog):
    """Pregunta al cajero cuánto vender de un producto conjunto.

    Resultado (al confirmar): self.result_data = {
        'cantidad':         float (en unidad_venta),
        'unidad_venta':     'm' | 'cm' | 'u' | ...,
        'cantidad_base':    float (convertida a unidad_medida del producto),
        'vender_por':       'fraccion' | 'unidad' | 'conjunto',
        'after_unidades':   float (cuánto quedará cerrado),
        'after_restante':   float (cuánto quedará abierto),
        'precio_total':     float (precio sugerido para el ítem),
        'precio_unitario':  float (precio_total / cantidad),
    }
    """

    def __init__(self, product, parent=None):
        super().__init__(parent)
        self.product = product
        self.result_data = None

        self.tipo = (product.get('conjunto_tipo') or 'otro').lower()
        if self.tipo not in TIPOS:
            self.tipo = 'otro'
        meta = TIPOS[self.tipo]

        self.unidad_base = normalizar_unidad(product.get('conjunto_unidad_medida') or meta['unidad_default'])
        if self.unidad_base not in UNIDADES:
            self.unidad_base = 'u'
        self.contenido = float(product.get('conjunto_contenido') or 0)
        self.unidades  = float(product.get('conjunto_unidades') or 0)
        self.restante  = float(product.get('conjunto_restante') or 0)

        # Precio: por defecto el unitario fraccionado; si no existe usa precio normal.
        self.precio_unidad = float(
            product.get('conjunto_precio_unidad') or product.get('price') or 0
        )

        self.cantidad_str = ''
        self.vender_por = meta['vende_por'][0]
        self.unidad_venta = self.unidad_base
        self.mono = _mono_family()

        self.setWindowTitle('Vender Conjunto')
        self.setModal(True)
        self.setStyleSheet(f'QDialog {{ background: {DIALOG_BG}; }}')
        self.setMinimumWidth(720)

        self._build_ui()
        self._refresh_all()

    # ---------------------------------------------------------------- UI ----

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        root.addWidget(self._build_header())
        root.addWidget(self._build_body(), 1)
        root.addWidget(self._build_footer())

    def _build_header(self):
        meta = TIPOS[self.tipo]
        nombre = self.product.get('name', '—')
        codigo = (self.product.get('barcode') or self.product.get('firebase_id') or
                  f'#{self.product.get("id", "")}')
        sub_txt = (
            f'{codigo} · {meta["label"]} de {format_num(self.contenido)}'
            f'{UNIDADES[self.unidad_base]["short"]} · '
            f'${format_num(self.precio_unidad)}/{UNIDADES[self.unidad_base]["short"]}'
        )

        hdr = QFrame()
        hdr.setStyleSheet(
            f'QFrame {{ background: {HEADER_BG}; border-bottom: 1px solid {SOFT_BORDER}; }}'
        )
        h = QHBoxLayout(hdr)
        h.setContentsMargins(20, 16, 20, 16)

        col = QVBoxLayout()
        col.setSpacing(2)
        ttl = QLabel(nombre)
        ttl.setStyleSheet(f'color: {TEXT_DARK}; font-size: 16px; font-weight: 700;')
        sub = QLabel(sub_txt)
        sub.setStyleSheet(f'color: {TEXT_MUTED}; font-size: 12px;')
        col.addWidget(ttl)
        col.addWidget(sub)
        h.addLayout(col, 1)

        close = QPushButton('×')
        close.setCursor(Qt.PointingHandCursor)
        close.setFixedSize(36, 36)
        close.setStyleSheet(
            f'QPushButton {{ background: {PILL_BG}; color: {TEXT_DIM};'
            f'                border: none; border-radius: 18px; font-size: 22px; }}'
            f'QPushButton:hover {{ background: #ece8df; }}'
        )
        close.clicked.connect(self.reject)
        h.addWidget(close, 0, Qt.AlignTop)
        return hdr

    def _build_body(self):
        body = QFrame()
        body.setStyleSheet(f'QFrame {{ background: {DIALOG_BG}; }}')
        v = QVBoxLayout(body)
        v.setContentsMargins(20, 18, 20, 18)
        v.setSpacing(14)

        self.stock_row = self._build_stock_row()
        v.addWidget(self.stock_row)

        v.addWidget(self._build_modo_selector())

        v.addLayout(self._build_main_grid(), 1)

        return body

    def _build_stock_row(self):
        # Frame contenedor con borde
        wrap = QFrame()
        wrap.setStyleSheet(
            f'QFrame {{ background: #fff; border: 1px solid {SOFT_BORDER};'
            f'           border-radius: 12px; }}'
        )
        h = QHBoxLayout(wrap)
        h.setContentsMargins(14, 14, 14, 14)
        h.setSpacing(0)

        total = total_conjunto(self.unidades, self.contenido, self.restante)
        # Color del total según estado
        if total <= 0:
            color_total = DANGER
        elif self.unidades == 0 and self.restante > 0:
            color_total = WARN
        else:
            color_total = TEXT_DARK

        meta = TIPOS[self.tipo]
        u_short = UNIDADES[self.unidad_base]['short']

        c1 = _StockCell('Cerrados', format_num(self.unidades),
                        f'{meta["label"].lower()}(s)', self.mono)
        c2 = _StockCell('Abierto', format_num(self.restante),
                        f'{u_short} sueltos', self.mono, with_borders=True)
        c3 = _StockCell('Total', format_num(total),
                        u_short, self.mono, value_color=color_total)
        for c in (c1, c2, c3):
            c.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        h.addWidget(c1, 1)
        h.addWidget(c2, 1)
        h.addWidget(c3, 1)
        return wrap

    def _build_modo_selector(self):
        meta = TIPOS[self.tipo]
        u_short = UNIDADES[self.unidad_base]['short']

        wrap = QFrame()
        wrap.setStyleSheet(
            f'QFrame {{ background: {PILL_BG}; border-radius: 10px; }}'
        )
        h = QHBoxLayout(wrap)
        h.setContentsMargins(4, 4, 4, 4)
        h.setSpacing(6)

        self._modo_group = QButtonGroup(self)
        self._modo_group.setExclusive(True)
        self._modo_buttons = {}

        for v in meta['vende_por']:
            if v == 'fraccion':
                txt = f'Por {u_short}'
            elif v == 'unidad':
                txt = 'Por unidad'
            else:
                txt = f'{meta["label"]} entero'
            btn = _PillButton(txt)
            self._modo_group.addButton(btn)
            self._modo_buttons[v] = btn
            h.addWidget(btn, 1)

        # Activar el primero
        self._modo_buttons[self.vender_por].setChecked(True)
        for v, b in self._modo_buttons.items():
            b.toggled.connect(lambda checked, vv=v: checked and self._on_modo_changed(vv))
        return wrap

    def _build_main_grid(self):
        # Columna izquierda (display + chips + preview/error)
        # Columna derecha (keypad)
        grid = QHBoxLayout()
        grid.setSpacing(14)

        left = QVBoxLayout()
        left.setSpacing(10)

        # Display de cantidad
        disp = QFrame()
        disp.setStyleSheet(
            f'QFrame {{ background: #fff; border: 2px solid {TEXT_DARK};'
            f'           border-radius: 12px; }}'
        )
        dh = QHBoxLayout(disp)
        dh.setContentsMargins(18, 14, 18, 14)

        self.qty_label = QLabel('0')
        f = QFont(self.mono); f.setPointSize(28); f.setBold(True)
        self.qty_label.setFont(f)
        # border:none y bg transparent — defensivo contra QSS global
        self.qty_label.setStyleSheet(
            f'QLabel {{ color: #dcd6c8; background: transparent; border: none; padding: 0; }}'
        )

        self.unit_label = QLabel(UNIDADES[self.unidad_base]['short'])
        self.unit_label.setStyleSheet(
            f'QLabel {{ color: {TEXT_MUTED}; font-size: 18px; font-weight: 600;'
            f' background: transparent; border: none; padding: 0; }}'
        )
        self.unit_label.setAlignment(Qt.AlignBottom | Qt.AlignRight)

        dh.addWidget(self.qty_label, 1, Qt.AlignVCenter | Qt.AlignLeft)
        dh.addWidget(self.unit_label, 0, Qt.AlignBottom | Qt.AlignRight)
        left.addWidget(disp)

        # Chips de unidades compatibles (solo en modo fracción)
        self.chips_wrap = QFrame()
        chips_h = QHBoxLayout(self.chips_wrap)
        chips_h.setContentsMargins(0, 0, 0, 0)
        chips_h.setSpacing(6)
        self._chip_buttons = {}
        self._chip_group = QButtonGroup(self)
        self._chip_group.setExclusive(True)
        for u in unidades_compatibles(self.unidad_base):
            chip = _ChipButton(UNIDADES[u]['short'])
            self._chip_group.addButton(chip)
            self._chip_buttons[u] = chip
            chips_h.addWidget(chip)
            chip.toggled.connect(lambda checked, uu=u: checked and self._on_unidad_venta_changed(uu))
        chips_h.addStretch(1)
        if self.unidad_venta in self._chip_buttons:
            self._chip_buttons[self.unidad_venta].setChecked(True)
        left.addWidget(self.chips_wrap)

        # Preview / error (alterna)
        self.preview_box = QFrame()
        self.preview_box.setStyleSheet(
            f'QFrame {{ background: {PREVIEW_BG}; border-radius: 12px; }}'
        )
        pv = QVBoxLayout(self.preview_box)
        pv.setContentsMargins(14, 12, 14, 14)
        pv.setSpacing(4)
        self.preview_title = QLabel('DESPUÉS DE LA VENTA')
        self.preview_title.setStyleSheet(
            f'color: {PREVIEW_DIM}; font-size: 11px; font-weight: 600; letter-spacing: 0.6px;'
        )
        self.preview_main = QLabel('—')
        f2 = QFont(self.mono); f2.setPointSize(14); f2.setBold(True)
        self.preview_main.setFont(f2)
        self.preview_main.setStyleSheet('color: #fff;')
        self.preview_sub = QLabel('')
        self.preview_sub.setStyleSheet(f'color: {PREVIEW_DIM}; font-size: 12px;')
        self.preview_price = QLabel('')
        self.preview_price.setStyleSheet('color: #fff; font-size: 13px; font-weight: 600;')
        pv.addWidget(self.preview_title)
        pv.addWidget(self.preview_main)
        pv.addWidget(self.preview_sub)
        pv.addWidget(self.preview_price)
        left.addWidget(self.preview_box)

        self.error_box = QFrame()
        self.error_box.setStyleSheet(
            f'QFrame {{ background: #fff; border: 2px solid {DANGER_BORDER};'
            f'           border-radius: 12px; }}'
        )
        eh = QHBoxLayout(self.error_box)
        eh.setContentsMargins(14, 12, 14, 12)
        self.error_label = QLabel('')
        self.error_label.setStyleSheet(f'color: {DANGER}; font-size: 14px; font-weight: 600;')
        eh.addWidget(self.error_label, 1)
        left.addWidget(self.error_box)
        self.error_box.hide()

        left.addStretch(1)

        right = QVBoxLayout()
        kp = _Keypad()
        kp.pressed.connect(self._on_key)
        right.addWidget(kp)
        right.addStretch(1)

        # Wrappers
        left_w = QWidget(); left_w.setLayout(left)
        right_w = QWidget(); right_w.setLayout(right)
        right_w.setFixedWidth(260)
        grid.addWidget(left_w, 1)
        grid.addWidget(right_w, 0)
        return grid

    def _build_footer(self):
        ft = QFrame()
        ft.setStyleSheet(
            f'QFrame {{ background: {HEADER_BG}; border-top: 1px solid {SOFT_BORDER}; }}'
        )
        h = QHBoxLayout(ft)
        h.setContentsMargins(16, 14, 16, 14)
        h.setSpacing(10)

        cancel = QPushButton('Cancelar')
        cancel.setMinimumHeight(52)
        cancel.setCursor(Qt.PointingHandCursor)
        cancel.setStyleSheet(
            f'QPushButton {{ background: {PILL_BG}; color: {TEXT_DIM};'
            f'                border: none; border-radius: 10px;'
            f'                font-size: 15px; font-weight: 700; }}'
            f'QPushButton:hover {{ background: #ece8df; }}'
        )
        cancel.clicked.connect(self.reject)

        self.confirm_btn = QPushButton('Confirmar venta')
        self.confirm_btn.setMinimumHeight(52)
        self.confirm_btn.setCursor(Qt.PointingHandCursor)
        self.confirm_btn.setStyleSheet(
            f'QPushButton {{ background: {ACCENT}; color: #fff;'
            f'                border: none; border-radius: 8px;'
            f'                font-size: 15px; font-weight: 700; }}'
            f'QPushButton:hover    {{ background: {ACCENT_HOVER}; }}'
            f'QPushButton:disabled {{ background: #dcd6c8; }}'
        )
        self.confirm_btn.clicked.connect(self._on_confirm)

        h.addWidget(cancel, 1)
        h.addWidget(self.confirm_btn, 2)
        return ft

    # --------------------------------------------------------------- LÓGICA -

    def _on_key(self, k):
        v = self.cantidad_str
        if k == 'del':
            v = v[:-1]
        elif k == '.':
            if '.' not in v:
                v = '0.' if v == '' else v + '.'
        else:
            if v == '0':
                v = k
            else:
                v = v + k
        self.cantidad_str = v
        self._refresh_all()

    def _on_modo_changed(self, modo):
        self.vender_por = modo
        # Mostrar/ocultar chips según modo
        self.chips_wrap.setVisible(modo == 'fraccion')
        # Resetear cantidad porque cambió la unidad de medida
        self.cantidad_str = ''
        self._refresh_all()

    def _on_unidad_venta_changed(self, u):
        self.unidad_venta = u
        self._refresh_all()

    def _refresh_all(self):
        # Display de cantidad
        if self.cantidad_str == '':
            self.qty_label.setText('0')
            self.qty_label.setStyleSheet(
                f'QLabel {{ color: #dcd6c8; background: transparent; border: none; padding: 0; }}'
            )
        else:
            self.qty_label.setText(self.cantidad_str)
            self.qty_label.setStyleSheet(
                f'QLabel {{ color: {TEXT_DARK}; background: transparent; border: none; padding: 0; }}'
            )

        # Unidad mostrada al lado del display
        if self.vender_por == 'fraccion':
            self.unit_label.setText(UNIDADES[self.unidad_venta]['short'])
            self.chips_wrap.setVisible(True)
        elif self.vender_por == 'unidad':
            self.unit_label.setText('u')
            self.chips_wrap.setVisible(False)
        else:
            self.unit_label.setText(TIPOS[self.tipo]['label'].lower())
            self.chips_wrap.setVisible(False)

        # Simulación
        try:
            cantidad = float(self.cantidad_str) if self.cantidad_str not in ('', '.') else 0
        except ValueError:
            cantidad = 0

        if cantidad <= 0:
            self.error_box.hide()
            self.preview_box.hide()
            self.confirm_btn.setEnabled(False)
            return

        ok, err, after_u, after_r = aplicar_venta(
            self.unidades, self.contenido, self.restante,
            cantidad, self.vender_por, self.unidad_base, self.unidad_venta
        )
        if not ok:
            self.error_label.setText(f'{err}')
            self.error_box.show()
            self.preview_box.hide()
            self.confirm_btn.setEnabled(False)
            return

        # Preview OK
        self.error_box.hide()
        self.preview_box.show()
        u_short = UNIDADES[self.unidad_base]['short']
        total_after = total_conjunto(after_u, self.contenido, after_r)
        self.preview_main.setText(f'{format_num(total_after)} {u_short}')
        self.preview_sub.setText(
            f'{format_num(after_u)} cerrado · {format_num(after_r)}{u_short} abierto'
        )

        precio_total = self._calcular_precio(cantidad)
        self.preview_price.setText(f'Total: ${format_num(round(precio_total, 2))}')
        self.confirm_btn.setEnabled(True)

    def _calcular_precio(self, cantidad):
        """Precio del ítem según modo de venta."""
        if self.vender_por == 'conjunto':
            # Precio por conjunto entero = precio_unidad × contenido
            return self.precio_unidad * self.contenido * cantidad
        if self.vender_por == 'fraccion' and self.unidad_venta != self.unidad_base:
            cantidad_base = convertir(cantidad, self.unidad_venta, self.unidad_base) or 0
            return self.precio_unidad * cantidad_base
        return self.precio_unidad * cantidad

    def _on_confirm(self):
        try:
            cantidad = float(self.cantidad_str)
        except ValueError:
            return
        ok, err, after_u, after_r = aplicar_venta(
            self.unidades, self.contenido, self.restante,
            cantidad, self.vender_por, self.unidad_base, self.unidad_venta
        )
        if not ok:
            return

        # Cantidad expresada en la unidad base del producto
        if self.vender_por == 'fraccion' and self.unidad_venta != self.unidad_base:
            cantidad_base = convertir(cantidad, self.unidad_venta, self.unidad_base) or cantidad
        elif self.vender_por == 'conjunto':
            cantidad_base = cantidad * self.contenido
        else:
            cantidad_base = cantidad

        precio_total = self._calcular_precio(cantidad)

        self.result_data = {
            'cantidad':        cantidad,
            'unidad_venta':    self.unidad_venta if self.vender_por == 'fraccion' else self.unidad_base,
            'cantidad_base':   cantidad_base,
            'vender_por':      self.vender_por,
            'after_unidades':  after_u,
            'after_restante':  after_r,
            'precio_total':    round(precio_total, 2),
            'precio_unitario': round(precio_total / cantidad, 4) if cantidad else 0.0,
        }
        self.accept()
