"""Diálogo de venta de Producto Conjunto (rollo/pack/caja/bobina/bolsa/plancha).

Soporta dos modos:

  - Modo legacy (sin colores): el producto sólo tiene `conjunto_unidades` /
    `conjunto_restante` planos. La UI se comporta como antes (1 sola línea).

  - Modo multi-color: el producto trae `conjunto_colores` (lista de
    {color, unidades, restante}). El cajero elige color, carga cantidad, le
    da "Agregar al subtotal" y puede repetir con otros colores. Al confirmar,
    el dialog devuelve una lista de líneas (una por color/agregado), que el
    flujo de venta consume y descuenta del stock por color.

Teclado físico habilitado (0-9, ., backspace, enter para Agregar/Confirmar,
Esc para Cancelar). Funciona en simultáneo con el pad táctil.
"""
import json as _json
import logging

from PyQt5.QtCore import Qt, pyqtSignal
from PyQt5.QtGui import QFont, QFontDatabase, QKeyEvent, QGuiApplication
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QGridLayout, QLabel, QPushButton,
    QFrame, QSizePolicy, QWidget, QButtonGroup, QSpacerItem, QScrollArea,
    QMessageBox,
)

logger = logging.getLogger(__name__)


# Margen extra que se aplica al precio por unidad fraccionada (ej. precio por
# metro en rollos) cuando hay que derivarlo automáticamente del precio del
# conjunto entero. 1.15 = 15 % de ganancia sobre el proporcional al rollo.
# Si el producto trae `conjunto_precio_unidad` cargado a mano, ese valor manda.
FRACCION_MARGIN = 1.15

TIPOS = {
    'rollo':     {'label': 'Rollo',     'unidad_default': 'm',  'vende_por': ['fraccion', 'conjunto']},
    'pack':      {'label': 'Pack',      'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
    'caja':      {'label': 'Caja',      'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
    'bobina':    {'label': 'Bobina',    'unidad_default': 'm',  'vende_por': ['fraccion', 'conjunto']},
    'bolsa':     {'label': 'Bolsa',     'unidad_default': 'kg', 'vende_por': ['fraccion', 'conjunto']},
    'plancha':   {'label': 'Plancha',   'unidad_default': 'm2', 'vende_por': ['fraccion', 'conjunto']},
    'cartulina': {'label': 'Cartulina', 'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
    'papel':     {'label': 'Papel',     'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
    'carton':    {'label': 'Cartón',    'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
    'goma_eva':  {'label': 'Goma Eva',  'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
    'cinta':     {'label': 'Cinta',     'unidad_default': 'm',  'vende_por': ['fraccion', 'conjunto']},
    'tela':      {'label': 'Tela',      'unidad_default': 'm',  'vende_por': ['fraccion', 'conjunto']},
    'otro':      {'label': 'Otro',      'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
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


def parse_colores(raw):
    """Parsea `conjunto_colores` a una lista normalizada o [] si vacío.
    Acepta JSON string (SQLite) o lista (directo de Firestore)."""
    if not raw:
        return []
    if isinstance(raw, str):
        try:
            data = _json.loads(raw)
        except Exception:
            return []
    elif isinstance(raw, list):
        data = raw
    else:
        return []
    out = []
    for c in data:
        if not isinstance(c, dict):
            continue
        nombre = str(c.get('color', '') or '').strip()
        if not nombre:
            continue
        out.append({
            'color':    nombre,
            'unidades': float(c.get('unidades') or 0),
            'restante': float(c.get('restante') or 0),
        })
    return out


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
    # Convertir a unidad_base si el cajero está tipeando en otra unidad
    # compatible (ej. 50 cm cuando la base es m). Aplica tanto a 'fraccion'
    # como a 'unidad' (modo "Por unidad" con chip cm seleccionado).
    if unidad_venta and unidad_venta != unidad_base:
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

DIALOG_BG     = '#f4f1ea'   # más contrastado contra las cards blancas
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
UI_FAMILIES   = ['Inter', 'Segoe UI', 'SF Pro Text', 'Helvetica Neue', 'Arial', 'sans-serif']

UI_FONT_CSS = '"Inter", "Segoe UI", "SF Pro Text", "Helvetica Neue", Arial, sans-serif'


def _mono_family():
    db = QFontDatabase()
    available = set(db.families())
    for f in MONO_FAMILIES:
        if f in available:
            return f
    return 'monospace'


def _ui_family():
    db = QFontDatabase()
    available = set(db.families())
    for f in UI_FAMILIES:
        if f in available:
            return f
    return 'sans-serif'


# ---------- Widgets ---------------------------------------------------------

class _PillButton(QPushButton):
    """Botón con estado activo/inactivo (fondo accent/transparente)."""
    def __init__(self, text, parent=None):
        super().__init__(text, parent)
        self.setCheckable(True)
        self.setFlat(True)
        self.setCursor(Qt.PointingHandCursor)
        self.setMinimumHeight(36)
        self._refresh()
        self.toggled.connect(lambda _: self._refresh())

    def _refresh(self):
        active = self.isChecked()
        self.setStyleSheet(
            f'QPushButton {{'
            f'  background: {ACCENT if active else "transparent"};'
            f'  color: {"#fff" if active else TEXT_DIM};'
            f'  border-radius: 8px;'
            f'  font-weight: 700;'
            f'  font-size: 13px;'
            f'  font-family: {UI_FONT_CSS};'
            f'  padding: 6px 14px;'
            f'  border: none;'
            f'}}'
            f'QPushButton:hover {{ background: {ACCENT_HOVER if active else PILL_BG}; }}'
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
            f'  font-family: {UI_FONT_CSS};'
            f'}}'
        )


class _ColorChip(QPushButton):
    """Chip compacto para selector de color: nombre y stock en una sola línea.

    Layout horizontal: "Negro · 4 m" en una sola línea para ahorrar espacio.
    Dos QLabel separados (transparentes al mouse) para que el QPushButton
    padre reciba el click correctamente y evitar problemas de clipping.
    """
    def __init__(self, color_name, stock_text, parent=None):
        super().__init__(parent)
        self.color_name = color_name
        self._stock_text = stock_text
        self.setCheckable(True)
        self.setCursor(Qt.PointingHandCursor)
        self.setMinimumHeight(34)
        self.setMaximumHeight(40)
        self.setMinimumWidth(120)
        self.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Fixed)

        h = QHBoxLayout(self)
        h.setContentsMargins(10, 4, 10, 4)
        h.setSpacing(6)
        h.setAlignment(Qt.AlignVCenter | Qt.AlignLeft)

        self._lbl_name = QLabel(color_name)
        self._lbl_name.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        fn = QFont(); fn.setPointSize(10); fn.setBold(True)
        self._lbl_name.setFont(fn)

        self._lbl_sep = QLabel('·')
        self._lbl_sep.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        fs = QFont(); fs.setPointSize(10); fs.setBold(True)
        self._lbl_sep.setFont(fs)

        self._lbl_stock = QLabel(stock_text)
        self._lbl_stock.setAlignment(Qt.AlignVCenter | Qt.AlignLeft)
        self._lbl_stock.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        fst = QFont(); fst.setPointSize(9); fst.setBold(False)
        self._lbl_stock.setFont(fst)

        h.addWidget(self._lbl_name, 0, Qt.AlignVCenter)
        h.addWidget(self._lbl_sep,  0, Qt.AlignVCenter)
        h.addWidget(self._lbl_stock, 1, Qt.AlignVCenter)

        self._refresh()
        self.toggled.connect(lambda _: self._refresh())

    def set_stock_text(self, txt):
        self._stock_text = txt
        self._lbl_stock.setText(txt)

    def _refresh(self):
        active = self.isChecked()
        bg   = TEXT_DARK if active else '#fff'
        fg   = '#fff'    if active else TEXT_DARK
        sub  = '#d6d2c8' if active else TEXT_MUTED
        bord = TEXT_DARK if active else BORDER
        self.setStyleSheet(
            f'QPushButton {{ background: {bg}; border: 1.5px solid {bord};'
            f'                border-radius: 8px; padding: 0; text-align: left; }}'
            f'QPushButton:hover {{ border-color: {TEXT_DARK}; }}'
        )
        self._lbl_name.setStyleSheet(
            f'color: {fg}; background: transparent; border: none;'
            f' font-family: {UI_FONT_CSS};'
        )
        self._lbl_sep.setStyleSheet(
            f'color: {sub}; background: transparent; border: none;'
        )
        self._lbl_stock.setStyleSheet(
            f'color: {sub}; background: transparent; border: none;'
            f' font-family: {UI_FONT_CSS};'
        )


class _Keypad(QWidget):
    """Teclado numérico 3x4 (7-8-9 / 4-5-6 / 1-2-3 / . - 0 - ⌫).

    Spacing generoso, teclas casi cuadradas, hover/pressed bien marcado para
    feedback táctil. Cada tecla se expande para llenar el contenedor.
    """
    pressed = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        grid = QGridLayout(self)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(12)
        grid.setVerticalSpacing(12)
        # Cada columna y fila se reparten parejo
        for c in range(3):
            grid.setColumnStretch(c, 1)
        for r in range(4):
            grid.setRowStretch(r, 1)
        keys = [
            ('7', 0, 0), ('8', 0, 1), ('9', 0, 2),
            ('4', 1, 0), ('5', 1, 1), ('6', 1, 2),
            ('1', 2, 0), ('2', 2, 1), ('3', 2, 2),
            ('.', 3, 0), ('0', 3, 1), ('del', 3, 2),
        ]
        mono = _mono_family()
        for label, r, c in keys:
            btn = QPushButton('⌫' if label == 'del' else label)
            btn.setMinimumSize(88, 76)
            btn.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
            btn.setCursor(Qt.PointingHandCursor)
            btn.setFocusPolicy(Qt.NoFocus)
            color = DANGER if label == 'del' else TEXT_DARK
            bg = PILL_BG if label == '.' else '#fff'
            hover_bg = '#f0eee8' if label != 'del' else '#fce8e8'
            press_bg = ACCENT_SOFT if label not in ('del', '.') else hover_bg
            press_color = ACCENT if label not in ('del', '.') else color
            btn.setStyleSheet(
                f'QPushButton {{'
                f'  background: {bg};'
                f'  color: {color};'
                f'  border: 1.5px solid {BORDER};'
                f'  border-radius: 12px;'
                f'  font-size: 26px;'
                f'  font-weight: 700;'
                f'  font-family: "{mono}", monospace;'
                f'}}'
                f'QPushButton:hover   {{ background: {hover_bg}; border-color: {TEXT_MUTED}; }}'
                f'QPushButton:pressed {{ background: {press_bg}; color: {press_color};'
                f'                       border-color: {ACCENT}; }}'
            )
            btn.clicked.connect(lambda _, k=label: self.pressed.emit(k))
            grid.addWidget(btn, r, c)


class _StockCell(QFrame):
    """Una celda del breakdown (Cerrados / Abierto / Total)."""
    def __init__(self, label, value, sub, mono_family, value_color=None, with_borders=False, parent=None):
        super().__init__(parent)
        v = QVBoxLayout(self)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)
        v.setAlignment(Qt.AlignCenter)

        l = QLabel(label.upper())
        l.setAlignment(Qt.AlignCenter)
        l.setStyleSheet(
            f'color: {TEXT_MUTED}; font-size: 9px; font-weight: 700;'
            f' letter-spacing: 1px; font-family: {UI_FONT_CSS};'
        )

        val = QLabel(value)
        val.setAlignment(Qt.AlignCenter)
        color = value_color or TEXT_DARK
        val.setStyleSheet(f'color: {color}; background: transparent;')
        f = QFont(mono_family); f.setPointSize(15); f.setBold(True)
        val.setFont(f)

        s = QLabel(sub)
        s.setAlignment(Qt.AlignCenter)
        s.setStyleSheet(f'color: {TEXT_MUTED}; font-size: 10px; font-family: {UI_FONT_CSS};')

        v.addWidget(l)
        v.addWidget(val)
        v.addWidget(s)

        self._val = val
        self._sub = s
        self._default_color = color
        self._mono = mono_family

        if with_borders:
            self.setStyleSheet(
                f'_StockCell {{ border-left: 1px solid {SOFT_BORDER};'
                f'              border-right: 1px solid {SOFT_BORDER}; }}'
            )

    def set_value(self, txt, color=None):
        self._val.setText(txt)
        c = color or self._default_color
        self._val.setStyleSheet(f'color: {c}; background: transparent;')

    def set_sub(self, txt):
        self._sub.setText(txt)


# ---------- Diálogo principal ----------------------------------------------

class ConjuntoDialog(QDialog):
    """Pregunta al cajero cuánto vender de un producto conjunto.

    Resultado (al confirmar): self.result_data = {
        'lineas': [
            {
                'color':            'Rojo' o '' (legacy single-color),
                'cantidad':         float (en unidad_venta),
                'unidad_venta':     'm' | 'cm' | 'u' | ...,
                'cantidad_base':    float (convertida a unidad_medida),
                'vender_por':       'fraccion' | 'unidad' | 'conjunto',
                'after_unidades':   float (cuánto queda cerrado en ESE color),
                'after_restante':   float (cuánto queda abierto en ESE color),
                'precio_total':     float,
                'precio_unitario':  float,
            },
            ...
        ],
        'total': float (suma de precio_total),
        # Copia de la primera línea (compat callers viejos):
        'cantidad', 'unidad_venta', 'cantidad_base', 'vender_por',
        'after_unidades', 'after_restante', 'precio_total', 'precio_unitario',
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

        # Modo: por color (multi) vs legacy (1 sólo color implícito)
        self.colores_iniciales = parse_colores(product.get('conjunto_colores'))
        self.has_colores = bool(self.colores_iniciales)
        if not self.has_colores:
            self.colores_iniciales = [{
                'color':    '',
                'unidades': float(product.get('conjunto_unidades') or 0),
                'restante': float(product.get('conjunto_restante') or 0),
            }]

        # Estado runtime: copia mutable por color, indexada por nombre
        self._color_state = {
            c['color']: {'unidades': c['unidades'], 'restante': c['restante']}
            for c in self.colores_iniciales
        }
        self.current_color = self.colores_iniciales[0]['color']

        # Líneas committed (subtotal interno)
        self.lineas = []

        # Precio por unidad fraccionada (ej. precio por metro de un rollo).
        # Lógica:
        #   1) Si el producto trae conjunto_precio_unidad cargado manualmente,
        #      ese valor manda (override del cajero/dueño).
        #   2) Si no, lo derivamos del precio del conjunto entero (`price`)
        #      dividido por el contenido, aplicando FRACCION_MARGIN (15%) extra.
        #      Solo cuando el producto vende por fracción (rollo, bobina, tela,
        #      etc.) y tiene contenido > 0. Para tipos que venden por unidad
        #      (pack, caja, etc.) el price ya es el precio individual.
        precio_explicito = float(product.get('conjunto_precio_unidad') or 0)
        precio_conjunto  = float(product.get('price') or 0)
        if precio_explicito > 0:
            self.precio_unidad = precio_explicito
        elif (
            self.contenido > 0
            and 'fraccion' in meta.get('vende_por', [])
        ):
            # precio_por_metro = precio_rollo / metros_rollo * (1 + margen)
            self.precio_unidad = round(
                precio_conjunto / self.contenido * FRACCION_MARGIN, 2
            )
        else:
            # Producto que se vende por unidad o sin contenido cargado:
            # el price ya es el unitario.
            self.precio_unidad = precio_conjunto

        self.cantidad_str = ''
        self.vender_por = meta['vende_por'][0]
        self.unidad_venta = self.unidad_base
        self.mono = _mono_family()

        # Caches widgets opcionales (existen sólo si has_colores)
        self._color_chips = {}
        self._lineas_container = None
        self._agregar_btn = None

        self.setWindowTitle('Vender Conjunto')
        self.setModal(True)
        self.setStyleSheet(f'QDialog {{ background: {DIALOG_BG}; }}')
        # Tamaño preferido — adaptado al tamaño de pantalla disponible.
        # Si la pantalla es chica, el diálogo no se pasa de 90% del alto/ancho.
        screen = QGuiApplication.primaryScreen()
        avail = screen.availableGeometry() if screen else None
        max_w = int(avail.width() * 0.92) if avail else 1200
        max_h = int(avail.height() * 0.90) if avail else 800

        if self.has_colores:
            pref_w, pref_h = 680, 560
            min_w, min_h = 560, 440
        else:
            pref_w, pref_h = 520, 460
            min_w, min_h = 440, 380

        # Ajustá el preferred al máximo disponible (no superar pantalla)
        pref_w = min(pref_w, max_w)
        pref_h = min(pref_h, max_h)
        # El mínimo nunca puede superar lo que entra en pantalla
        min_w = min(min_w, max_w)
        min_h = min(min_h, max_h)

        self.setMinimumWidth(min_w)
        self.setMinimumHeight(min_h)
        self.resize(pref_w, pref_h)

        # Fuente UI base del dialog (mejor render en Windows que la default)
        ui_font = QFont(_ui_family(), 10)
        ui_font.setHintingPreference(QFont.PreferFullHinting)
        ui_font.setStyleStrategy(QFont.PreferAntialias)
        self.setFont(ui_font)
        self.ui_family = _ui_family()

        self._build_ui()
        self._refresh_all()

        # Foco para teclado físico
        self.setFocusPolicy(Qt.StrongFocus)
        self.setFocus()

    # --------------------------------------------------------- properties --

    @property
    def unidades(self):
        s = self._color_state.get(self.current_color, {})
        return float(s.get('unidades', 0))

    @property
    def restante(self):
        s = self._color_state.get(self.current_color, {})
        return float(s.get('restante', 0))

    # ---------------------------------------------------------------- UI ----

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        root.addWidget(self._build_header())

        # Body scrolleable: si la pantalla es chica, el contenido se puede
        # scrollear en lugar de quedar cortado.
        body_scroll = QScrollArea()
        body_scroll.setWidgetResizable(True)
        body_scroll.setFrameShape(QFrame.NoFrame)
        body_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        body_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        body_scroll.setStyleSheet(f'QScrollArea {{ background: {DIALOG_BG}; border: none; }}')
        body_scroll.setWidget(self._build_body())
        root.addWidget(body_scroll, 1)

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
        h.setContentsMargins(18, 10, 14, 10)

        col = QVBoxLayout()
        col.setSpacing(1)
        ttl = QLabel(nombre)
        ttl.setStyleSheet(
            f'color: {TEXT_DARK}; font-size: 15px; font-weight: 700;'
            f' letter-spacing: -0.2px; font-family: {UI_FONT_CSS};'
        )
        sub = QLabel(sub_txt)
        sub.setStyleSheet(f'color: {TEXT_MUTED}; font-size: 11px; font-family: {UI_FONT_CSS};')
        col.addWidget(ttl)
        col.addWidget(sub)
        h.addLayout(col, 1)

        close = QPushButton('×')
        close.setCursor(Qt.PointingHandCursor)
        close.setFixedSize(28, 28)
        close.setFocusPolicy(Qt.NoFocus)
        close.setStyleSheet(
            f'QPushButton {{ background: {PILL_BG}; color: {TEXT_DIM};'
            f'                border: none; border-radius: 14px; font-size: 18px;'
            f'                font-family: {UI_FONT_CSS}; }}'
            f'QPushButton:hover {{ background: #ece8df; }}'
        )
        close.clicked.connect(self.reject)
        h.addWidget(close, 0, Qt.AlignTop)
        return hdr

    def _build_body(self):
        body = QFrame()
        body.setStyleSheet(f'QFrame {{ background: {DIALOG_BG}; }}')
        v = QVBoxLayout(body)
        v.setContentsMargins(14, 10, 14, 10)
        v.setSpacing(8)

        if self.has_colores:
            v.addWidget(self._build_color_selector())

        self.stock_row = self._build_stock_row()
        v.addWidget(self.stock_row)

        v.addWidget(self._build_modo_selector())

        v.addLayout(self._build_main_grid(), 1)

        if self.has_colores:
            self._lineas_box_wrap = self._build_lineas_box()
            v.addWidget(self._lineas_box_wrap)

        return body

    def _build_color_selector(self):
        wrap = QFrame()
        wrap.setStyleSheet(
            f'QFrame {{ background: #fff; border: 1px solid {BORDER};'
            f'           border-radius: 14px; }}'
        )
        outer = QVBoxLayout(wrap)
        outer.setContentsMargins(14, 10, 14, 10)
        outer.setSpacing(8)

        # Header: label COLOR + buscador a la derecha
        head = QHBoxLayout()
        head.setContentsMargins(0, 0, 0, 0)
        head.setSpacing(8)
        lbl = QLabel('COLOR')
        lbl.setStyleSheet(
            f'color: {TEXT_MUTED}; font-size: 11px; font-weight: 700;'
            f' letter-spacing: 1px; font-family: {UI_FONT_CSS};'
        )
        head.addWidget(lbl)
        head.addStretch(1)
        # Buscador: filtra los chips por nombre. Útil cuando hay muchos colores.
        from PyQt5.QtWidgets import QLineEdit as _QLE
        self._color_search = _QLE()
        self._color_search.setPlaceholderText('Buscar color...')
        self._color_search.setMinimumWidth(160)
        self._color_search.setMaximumWidth(220)
        self._color_search.setStyleSheet(
            f'QLineEdit {{ background: #fafaf7; border: 1px solid {BORDER};'
            f'              border-radius: 8px; padding: 4px 10px;'
            f'              font-size: 11px; font-family: {UI_FONT_CSS}; }}'
            f'QLineEdit:focus {{ border-color: {ACCENT}; background: #fff; }}'
        )
        self._color_search.textChanged.connect(self._on_color_search)
        head.addWidget(self._color_search)
        outer.addLayout(head)

        # Scroll horizontal para muchos colores
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setMinimumHeight(48)
        scroll.setMaximumHeight(58)

        chips_w = QWidget()
        h = QHBoxLayout(chips_w)
        h.setContentsMargins(0, 2, 0, 2)
        h.setSpacing(8)

        self._color_group = QButtonGroup(self)
        self._color_group.setExclusive(True)

        for c in self.colores_iniciales:
            chip = _ColorChip(c['color'], self._stock_text_for(c['color']))
            chip.setFocusPolicy(Qt.NoFocus)
            self._color_group.addButton(chip)
            self._color_chips[c['color']] = chip
            h.addWidget(chip)
            chip.toggled.connect(
                lambda checked, name=c['color']: checked and self._on_color_changed(name)
            )
        h.addStretch(1)

        # Activar el primero (sin disparar signals — _refresh_all corre al final
        # de __init__ cuando ya están todos los widgets)
        first_color = self.colores_iniciales[0]['color']
        chip0 = self._color_chips[first_color]
        chip0.blockSignals(True)
        chip0.setChecked(True)
        chip0.blockSignals(False)

        # Estado inicial: NINGÚN chip visible. El cajero busca el color, lo
        # selecciona, y recién ahí queda visible el chip elegido.
        self._color_user_selected = False
        for chip in self._color_chips.values():
            chip.setVisible(False)

        scroll.setWidget(chips_w)
        outer.addWidget(scroll)
        return wrap

    def _build_stock_row(self):
        wrap = QFrame()
        wrap.setStyleSheet(
            f'QFrame {{ background: #fff; border: 1px solid {BORDER};'
            f'           border-radius: 12px; }}'
        )
        h = QHBoxLayout(wrap)
        h.setContentsMargins(16, 10, 16, 10)
        h.setSpacing(8)

        meta = TIPOS[self.tipo]
        u_short = UNIDADES[self.unidad_base]['short']

        # Inicializa con valores del color actual; _refresh_all luego los redibuja.
        self._cell_cerrados = _StockCell('Cerrados', format_num(self.unidades),
                                         f'{meta["label"].lower()}(s)', self.mono)
        self._cell_abierto = _StockCell('Abierto', format_num(self.restante),
                                        f'{u_short} sueltos', self.mono, with_borders=True)
        self._cell_total = _StockCell('Total', format_num(self._total_color()),
                                      u_short, self.mono)
        for c in (self._cell_cerrados, self._cell_abierto, self._cell_total):
            c.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        h.addWidget(self._cell_cerrados, 1)
        h.addWidget(self._cell_abierto, 1)
        h.addWidget(self._cell_total, 1)
        return wrap

    def _build_modo_selector(self):
        meta = TIPOS[self.tipo]
        u_short = UNIDADES[self.unidad_base]['short']

        wrap = QFrame()
        wrap.setStyleSheet(
            f'QFrame {{ background: {PILL_BG}; border-radius: 12px;'
            f'           border: 1px solid {SOFT_BORDER}; }}'
        )
        h = QHBoxLayout(wrap)
        h.setContentsMargins(8, 8, 8, 8)
        h.setSpacing(8)

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
            btn.setFocusPolicy(Qt.NoFocus)
            self._modo_group.addButton(btn)
            self._modo_buttons[v] = btn
            h.addWidget(btn, 1)

        self._modo_buttons[self.vender_por].setChecked(True)
        for v, b in self._modo_buttons.items():
            b.toggled.connect(lambda checked, vv=v: checked and self._on_modo_changed(vv))
        return wrap

    def _build_main_grid(self):
        grid = QHBoxLayout()
        grid.setSpacing(12)

        left = QVBoxLayout()
        left.setSpacing(10)

        # Display de cantidad — caja simple: caption arriba, número + unidad abajo
        self.disp_frame = QFrame()
        self.disp_frame.setObjectName('qtyDisplay')
        self.disp_frame.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Fixed)
        self.disp_frame.setFixedHeight(78)
        self.disp_frame.setStyleSheet(
            f'QFrame#qtyDisplay {{ background: #fff; border: 2px dashed {BORDER};'
            f'                     border-radius: 12px; }}'
        )
        dh = QVBoxLayout(self.disp_frame)
        dh.setContentsMargins(16, 8, 16, 8)
        dh.setSpacing(2)

        self._disp_caption = QLabel('CANTIDAD')
        cap_font = QFont(); cap_font.setPointSize(8); cap_font.setBold(True)
        self._disp_caption.setFont(cap_font)
        self._disp_caption.setStyleSheet(
            f'color: {TEXT_MUTED}; background: transparent; border: none;'
            f' letter-spacing: 1px;'
        )

        # Fila inferior: número (izquierda, expansible) + unidad (derecha)
        val_row = QHBoxLayout()
        val_row.setContentsMargins(0, 0, 0, 0)
        val_row.setSpacing(8)

        self.qty_label = QLabel('0')
        self.qty_label.setObjectName('qtyValue')
        qf = QFont(self.mono); qf.setPointSize(20); qf.setBold(True)
        self.qty_label.setFont(qf)
        self.qty_label.setStyleSheet(
            f'color: #b8b1a1; background: transparent; border: none;'
        )
        self.qty_label.setAlignment(Qt.AlignVCenter | Qt.AlignLeft)

        self.unit_label = QLabel(UNIDADES[self.unidad_base]['short'])
        self.unit_label.setObjectName('qtyUnit')
        u_font = QFont(); u_font.setPointSize(11); u_font.setBold(True)
        self.unit_label.setFont(u_font)
        self.unit_label.setStyleSheet(
            f'color: {TEXT_MUTED}; background: transparent; border: none;'
        )
        self.unit_label.setAlignment(Qt.AlignVCenter | Qt.AlignRight)

        val_row.addWidget(self.qty_label, 1)
        val_row.addWidget(self.unit_label, 0)

        dh.addWidget(self._disp_caption, 0, Qt.AlignLeft)
        dh.addLayout(val_row, 1)
        left.addWidget(self.disp_frame)

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
            chip.setFocusPolicy(Qt.NoFocus)
            self._chip_group.addButton(chip)
            self._chip_buttons[u] = chip
            chips_h.addWidget(chip)
            chip.toggled.connect(lambda checked, uu=u: checked and self._on_unidad_venta_changed(uu))
        chips_h.addStretch(1)
        if self.unidad_venta in self._chip_buttons:
            chip_v = self._chip_buttons[self.unidad_venta]
            chip_v.blockSignals(True)
            chip_v.setChecked(True)
            chip_v.blockSignals(False)
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
            f'color: {PREVIEW_DIM}; font-size: 11px; font-weight: 700;'
            f' letter-spacing: 0.8px; font-family: {UI_FONT_CSS};'
        )
        self.preview_main = QLabel('—')
        f2 = QFont(self.mono); f2.setPointSize(14); f2.setBold(True)
        self.preview_main.setFont(f2)
        self.preview_main.setStyleSheet('color: #fff;')
        self.preview_sub = QLabel('')
        self.preview_sub.setStyleSheet(
            f'color: {PREVIEW_DIM}; font-size: 12px; font-family: {UI_FONT_CSS};'
        )
        self.preview_price = QLabel('')
        self.preview_price.setStyleSheet(
            f'color: #fff; font-size: 13px; font-weight: 600; font-family: {UI_FONT_CSS};'
        )
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
        self.error_label.setStyleSheet(
            f'color: {DANGER}; font-size: 14px; font-weight: 600; font-family: {UI_FONT_CSS};'
        )
        eh.addWidget(self.error_label, 1)
        left.addWidget(self.error_box)
        self.error_box.hide()

        # "+ Agregar al subtotal" — sólo en modo multi-color
        if self.has_colores:
            self._agregar_btn = QPushButton('+  Agregar al subtotal')
            self._agregar_btn.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Fixed)
            self._agregar_btn.setFixedHeight(36)
            self._agregar_btn.setCursor(Qt.PointingHandCursor)
            self._agregar_btn.setFocusPolicy(Qt.NoFocus)
            self._agregar_btn.setStyleSheet(
                f'QPushButton {{ background: #fff; color: {ACCENT};'
                f'                border: 1.5px solid {ACCENT};'
                f'                border-radius: 10px;'
                f'                font-size: 14px; font-weight: 700;'
                f'                font-family: {UI_FONT_CSS};'
                f'                padding: 0 16px; }}'
                f'QPushButton:hover    {{ background: {ACCENT_SOFT}; }}'
                f'QPushButton:pressed  {{ background: {ACCENT}; color: #fff; }}'
                f'QPushButton:disabled {{ color: {TEXT_DIM}; border-color: {BORDER}; background: #faf8f3; }}'
            )
            self._agregar_btn.clicked.connect(self._on_agregar)
            btn_wrap = QVBoxLayout()
            btn_wrap.setContentsMargins(0, 8, 0, 0)
            btn_wrap.addWidget(self._agregar_btn)
            left.addLayout(btn_wrap)

        left.addStretch(1)

        # Teclado numérico removido — los números se ingresan con el teclado físico
        # (manejado en keyPressEvent). Esto deja la columna izquierda ocupando todo
        # el ancho y achica el diálogo para que entre en pantallas chicas.

        left_w = QWidget(); left_w.setLayout(left)
        grid.addWidget(left_w, 1)
        return grid

    # ──────────────────────────────────────────────────────────────────────
    #  CALCULADORA RÁPIDA m/cm
    # ──────────────────────────────────────────────────────────────────────
    def _build_calculadora(self):
        """Pequeño widget para convertir entre m y cm y calcular costo on-the-fly.

        Solo se construye si la unidad base del producto es de longitud (m / cm).
        No afecta la venta real — es solo una ayuda al cajero.
        """
        # Solo cuando la unidad base es de longitud
        base_info = UNIDADES.get(self.unidad_base, {})
        if base_info.get('base') != 'longitud':
            return None

        wrap = QFrame()
        wrap.setStyleSheet(
            f'QFrame {{ background: {PILL_BG}; border: 1px solid {SOFT_BORDER};'
            f'         border-radius: 10px; }}'
        )
        v = QVBoxLayout(wrap)
        v.setContentsMargins(10, 8, 10, 8)
        v.setSpacing(4)

        title = QLabel('CALCULADORA')
        title.setStyleSheet(
            f'color: {TEXT_MUTED}; font-size: 9px; font-weight: 700;'
            f' letter-spacing: 1px; background: transparent; border: none;'
            f' font-family: {UI_FONT_CSS};'
        )
        v.addWidget(title)

        # Línea de referencia: precio por m y por cm (siempre visibles)
        ref_lbl = QLabel('—')
        ref_lbl.setStyleSheet(
            f'color: {TEXT_DARK}; font-size: 11px; font-weight: 600;'
            f' background: transparent; border: none; font-family: {UI_FONT_CSS};'
        )
        self._calc_ref_lbl = ref_lbl
        v.addWidget(ref_lbl)

        # Fila interactiva: input + toggle m/cm + resultado
        row = QHBoxLayout()
        row.setContentsMargins(0, 2, 0, 0)
        row.setSpacing(6)

        from PyQt5.QtWidgets import QLineEdit
        self._calc_input = QLineEdit()
        self._calc_input.setPlaceholderText('Ej: 50')
        self._calc_input.setMinimumWidth(70)
        self._calc_input.setMaximumWidth(110)
        self._calc_input.setFont(QFont(UI_FONT_CSS.split(',')[0].strip().strip('"\''), 11))
        self._calc_input.setStyleSheet(
            f'QLineEdit {{ background: #fff; border: 1.5px solid {BORDER};'
            f'            border-radius: 6px; padding: 4px 8px; }}'
        )
        self._calc_input.textChanged.connect(self._refresh_calculadora)
        row.addWidget(self._calc_input)

        # Toggle m / cm
        self._calc_unidad = 'm'
        self._calc_btn_m = QPushButton('m')
        self._calc_btn_cm = QPushButton('cm')
        for btn, u in [(self._calc_btn_m, 'm'), (self._calc_btn_cm, 'cm')]:
            btn.setCheckable(True)
            btn.setFocusPolicy(Qt.NoFocus)
            btn.setCursor(Qt.PointingHandCursor)
            btn.setMinimumWidth(34)
            btn.setMaximumWidth(46)
            btn.setMinimumHeight(28)
            btn.setStyleSheet(
                f'QPushButton {{ background: #fff; color: {TEXT_DARK};'
                f'              border: 1.5px solid {BORDER}; border-radius: 6px;'
                f'              font-size: 11px; font-weight: 700; padding: 0 6px; }}'
                f'QPushButton:checked {{ background: {TEXT_DARK}; color: #fff; border-color: {TEXT_DARK}; }}'
                f'QPushButton:hover {{ border-color: {TEXT_DARK}; }}'
            )
            btn.clicked.connect(lambda _, uu=u: self._set_calc_unidad(uu))
            row.addWidget(btn)
        self._calc_btn_m.setChecked(True)

        # Igual + resultado
        eq = QLabel('=')
        eq.setStyleSheet(f'color: {TEXT_MUTED}; font-weight: 700; padding: 0 4px;')
        row.addWidget(eq)

        self._calc_result_lbl = QLabel('$0,00')
        self._calc_result_lbl.setStyleSheet(
            f'color: {ACCENT}; font-size: 13px; font-weight: 800;'
            f' background: transparent; border: none;'
        )
        row.addWidget(self._calc_result_lbl, 1)

        v.addLayout(row)
        # Render inicial
        self._refresh_calculadora()
        return wrap

    def _set_calc_unidad(self, u: str):
        if u not in ('m', 'cm'):
            return
        self._calc_unidad = u
        if hasattr(self, '_calc_btn_m'):
            self._calc_btn_m.setChecked(u == 'm')
            self._calc_btn_cm.setChecked(u == 'cm')
        self._refresh_calculadora()

    def _refresh_calculadora(self, *_args):
        """Actualiza la línea de referencia y el resultado del input."""
        if not hasattr(self, '_calc_ref_lbl'):
            return
        precio_por_m = float(self.precio_unidad or 0)
        # `precio_unidad` está en la unidad base. Si la base es 'cm', convertir a m.
        if self.unidad_base == 'cm':
            precio_por_m = precio_por_m * 100  # 100 cm = 1 m
        precio_por_cm = precio_por_m / 100.0
        self._calc_ref_lbl.setText(
            f'1 m = ${format_num(round(precio_por_m, 2))}  ·  '
            f'1 cm = ${format_num(round(precio_por_cm, 2))}'
        )
        # Cálculo del input
        raw = self._calc_input.text().strip().replace(',', '.')
        try:
            cantidad = float(raw) if raw else 0.0
        except ValueError:
            cantidad = 0.0
        if cantidad <= 0:
            self._calc_result_lbl.setText('$0,00')
            return
        if self._calc_unidad == 'm':
            costo = cantidad * precio_por_m
        else:  # cm
            costo = cantidad * precio_por_cm
        self._calc_result_lbl.setText(f'${format_num(round(costo, 2))}')

    def _build_lineas_box(self):
        """Lista de líneas commited (1 por agregado de color)."""
        wrap = QFrame()
        wrap.setStyleSheet(
            f'QFrame {{ background: #fff; border: 1px solid {BORDER};'
            f'           border-radius: 12px; }}'
        )
        outer = QVBoxLayout(wrap)
        outer.setContentsMargins(10, 8, 10, 8)
        outer.setSpacing(4)

        head = QHBoxLayout()
        head.setSpacing(8)
        title = QLabel('SUBTOTAL DE LA VENTA')
        title.setStyleSheet(f'color: {TEXT_MUTED}; font-size: 11px; font-weight: 700; letter-spacing: 0.5px;')
        self._lineas_count_lbl = QLabel('0 ítems')
        self._lineas_count_lbl.setStyleSheet(
            f'color: {TEXT_DIM}; font-size: 11px; font-family: {UI_FONT_CSS};'
        )
        self._limpiar_btn = QPushButton('Limpiar')
        self._limpiar_btn.setCursor(Qt.PointingHandCursor)
        self._limpiar_btn.setFocusPolicy(Qt.NoFocus)
        self._limpiar_btn.setStyleSheet(
            f'QPushButton {{ background: transparent; color: {DANGER};'
            f'                border: 1px solid {SOFT_BORDER}; border-radius: 6px;'
            f'                padding: 3px 10px; font-size: 11px; font-weight: 700;'
            f'                font-family: {UI_FONT_CSS}; }}'
            f'QPushButton:hover    {{ background: #fee; border-color: {DANGER}; }}'
            f'QPushButton:disabled {{ color: {TEXT_DIM}; border-color: {BORDER}; }}'
        )
        self._limpiar_btn.clicked.connect(self._on_limpiar_subtotal)
        head.addWidget(title)
        head.addStretch(1)
        head.addWidget(self._lineas_count_lbl)
        head.addWidget(self._limpiar_btn)
        outer.addLayout(head)

        # Sin QScrollArea interna — los ítems se apilan y crecen con el contenido.
        # Si llegasen a ser muchos, el QScrollArea del body se encarga.
        self._lineas_container = QWidget()
        self._lineas_layout = QVBoxLayout(self._lineas_container)
        self._lineas_layout.setContentsMargins(0, 0, 0, 0)
        self._lineas_layout.setSpacing(4)

        self._lineas_empty = QLabel('Cargá una cantidad y dale "Agregar" para sumarla al subtotal.')
        self._lineas_empty.setAlignment(Qt.AlignCenter)
        self._lineas_empty.setStyleSheet(
            f'color: {TEXT_DIM}; font-size: 12px; padding: 6px; font-family: {UI_FONT_CSS};'
        )
        self._lineas_layout.addWidget(self._lineas_empty)

        outer.addWidget(self._lineas_container)
        return wrap

    def _build_footer(self):
        ft = QFrame()
        ft.setStyleSheet(
            f'QFrame {{ background: {HEADER_BG}; border-top: 1px solid {SOFT_BORDER}; }}'
        )
        h = QHBoxLayout(ft)
        h.setContentsMargins(16, 10, 16, 10)
        h.setSpacing(10)

        cancel = QPushButton('Cancelar')
        cancel.setMinimumHeight(40)
        cancel.setCursor(Qt.PointingHandCursor)
        cancel.setFocusPolicy(Qt.NoFocus)
        cancel.setStyleSheet(
            f'QPushButton {{ background: {PILL_BG}; color: {TEXT_DIM};'
            f'                border: none; border-radius: 10px;'
            f'                font-size: 15px; font-weight: 700;'
            f'                font-family: {UI_FONT_CSS}; }}'
            f'QPushButton:hover {{ background: #ece8df; }}'
        )
        cancel.clicked.connect(self.reject)

        self.confirm_btn = QPushButton('Confirmar venta')
        self.confirm_btn.setMinimumHeight(40)
        self.confirm_btn.setCursor(Qt.PointingHandCursor)
        self.confirm_btn.setFocusPolicy(Qt.NoFocus)
        self.confirm_btn.setStyleSheet(
            f'QPushButton {{ background: {ACCENT}; color: #fff;'
            f'                border: none; border-radius: 8px;'
            f'                font-size: 15px; font-weight: 700;'
            f'                font-family: {UI_FONT_CSS}; }}'
            f'QPushButton:hover    {{ background: {ACCENT_HOVER}; }}'
            f'QPushButton:disabled {{ background: #dcd6c8; }}'
        )
        self.confirm_btn.clicked.connect(self._on_confirm)

        h.addWidget(cancel, 1)
        h.addWidget(self.confirm_btn, 2)
        return ft

    # --------------------------------------------------------------- LÓGICA -

    def _stock_text_for(self, color_name):
        """Texto de stock disponible para mostrar en el chip de color."""
        s = self._color_state.get(color_name, {'unidades': 0, 'restante': 0})
        total = total_conjunto(s['unidades'], self.contenido, s['restante'])
        u_short = UNIDADES[self.unidad_base]['short']
        return f'{format_num(total)} {u_short}'

    def _total_color(self):
        return total_conjunto(self.unidades, self.contenido, self.restante)

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
        self.chips_wrap.setVisible(modo == 'fraccion')
        # Resetear cantidad porque cambió la unidad de medida
        self.cantidad_str = ''
        self._refresh_all()

    def _on_unidad_venta_changed(self, u):
        self.unidad_venta = u
        self._refresh_all()

    def _on_color_changed(self, color_name):
        self.current_color = color_name
        # Marcar que ya hubo una selección manual del cajero — desde acá en
        # adelante el chip del color activo queda visible aunque el buscador
        # esté vacío.
        self._color_user_selected = True
        # Resetear cantidad: el stock disponible es otro
        self.cantidad_str = ''
        self._refresh_all()
        # Limpiar buscador y volver a mostrar solo el chip del color seleccionado
        try:
            if hasattr(self, '_color_search') and self._color_search is not None:
                self._color_search.blockSignals(True)
                self._color_search.clear()
                self._color_search.blockSignals(False)
            self._on_color_search('')
        except Exception:
            pass

    def _on_color_search(self, txt: str):
        """Filtra los chips de color en vivo según el texto del buscador.

        Estado inicial (sin selección previa) y buscador vacío → no muestra
        ningún chip. Si ya hubo una selección, con buscador vacío queda
        visible el chip seleccionado para que el cajero sepa cuál tiene
        activo.
        """
        import unicodedata as _ud
        def _norm(s):
            s = _ud.normalize('NFD', str(s or ''))
            return s.encode('ascii', 'ignore').decode('ascii').lower().strip()
        q = _norm(txt)
        if not q:
            # Sin búsqueda
            already_selected = bool(getattr(self, '_color_user_selected', False))
            for color, chip in self._color_chips.items():
                chip.setVisible(already_selected and color == self.current_color)
            return
        # Con búsqueda: mostrar matches
        any_match = False
        for color, chip in self._color_chips.items():
            visible = q in _norm(color)
            chip.setVisible(visible)
            if visible:
                any_match = True
        # Sin matches → mantener todos ocultos (no forzar el seleccionado)
        if not any_match:
            for chip in self._color_chips.values():
                chip.setVisible(False)

    # --- multi-linea (subtotal) -------------------------------------------

    def _refresh_lineas_view(self):
        if self._lineas_container is None:
            return
        # Limpiar widgets actuales (excepto el stretch al final)
        lay = self._lineas_layout
        # Sacar todo
        while lay.count():
            it = lay.takeAt(0)
            w = it.widget()
            if w is not None:
                w.setParent(None)

        if not self.lineas:
            self._lineas_empty = QLabel('Cargá una cantidad y dale "Agregar" para sumarla al subtotal.')
            self._lineas_empty.setAlignment(Qt.AlignCenter)
            self._lineas_empty.setStyleSheet(
            f'color: {TEXT_DIM}; font-size: 12px; padding: 8px; font-family: {UI_FONT_CSS};'
        )
            lay.addWidget(self._lineas_empty)
        else:
            for idx, ln in enumerate(self.lineas):
                lay.addWidget(self._build_linea_row(idx, ln))
        lay.addStretch(1)

        # Contador
        n = len(self.lineas)
        self._lineas_count_lbl.setText(f'{n} ítem{"s" if n != 1 else ""}')
        if hasattr(self, '_limpiar_btn'):
            self._limpiar_btn.setEnabled(n > 0)
        # Ocultar el wrap del subtotal cuando no hay líneas
        if self.has_colores and hasattr(self, '_lineas_box_wrap'):
            self._lineas_box_wrap.setVisible(n > 0)

    def _build_linea_row(self, idx, ln):
        row = QFrame()
        row.setMinimumHeight(28)
        row.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Fixed)
        row.setStyleSheet(
            f'QFrame {{ background: {DIALOG_BG}; border: 1px solid {SOFT_BORDER};'
            f'           border-radius: 6px; }}'
        )
        h = QHBoxLayout(row)
        h.setContentsMargins(8, 4, 6, 4)
        h.setSpacing(6)

        meta = TIPOS[self.tipo]
        u_short = UNIDADES[self.unidad_base]['short']
        venta_short = UNIDADES.get(ln['unidad_venta'], {}).get('short', u_short)

        if ln['vender_por'] == 'conjunto':
            qty_txt = f'{format_num(ln["cantidad"])} {meta["label"].lower()}(s)'
        elif ln['vender_por'] == 'unidad':
            qty_txt = f'{format_num(ln["cantidad"])} u'
        else:
            qty_txt = f'{format_num(ln["cantidad"])} {venta_short}'

        prefix = f'{ln["color"]}  ·  ' if ln['color'] else ''
        lbl = QLabel(f'{prefix}{qty_txt}')
        lbl.setStyleSheet(f'color: {TEXT_DARK}; font-size: 12px; font-weight: 600; background: transparent; border: none;')

        price = QLabel(f'${format_num(round(ln["precio_total"], 2))}')
        price.setStyleSheet(f'color: {TEXT_DARK}; font-size: 12px; font-weight: 700; background: transparent; border: none;')

        rm = QPushButton('×')
        rm.setFixedSize(20, 20)
        rm.setCursor(Qt.PointingHandCursor)
        rm.setFocusPolicy(Qt.NoFocus)
        rm.setStyleSheet(
            f'QPushButton {{ background: transparent; color: {DANGER};'
            f'                border: 1px solid {SOFT_BORDER}; border-radius: 10px;'
            f'                font-size: 13px; font-weight: 700; }}'
            f'QPushButton:hover {{ background: #fee; border-color: {DANGER}; }}'
        )
        rm.clicked.connect(lambda _, i=idx: self._on_remove_linea(i))

        h.addWidget(lbl, 1)
        h.addWidget(price, 0)
        h.addWidget(rm, 0)
        return row

    def _recalc_color_state(self):
        """Recompila _color_state desde colores_iniciales + lineas."""
        self._color_state = {
            c['color']: {'unidades': c['unidades'], 'restante': c['restante']}
            for c in self.colores_iniciales
        }
        for ln in self.lineas:
            color = ln['color']
            s = self._color_state.get(color)
            if s is None:
                continue
            ok, _err, after_u, after_r = aplicar_venta(
                s['unidades'], self.contenido, s['restante'],
                ln['cantidad'], ln['vender_por'],
                self.unidad_base, ln['unidad_venta']
            )
            if ok:
                s['unidades'] = after_u
                s['restante'] = after_r

    def _on_agregar(self):
        """Commitea la cantidad actual como una línea más del subtotal."""
        try:
            cantidad = float(self.cantidad_str) if self.cantidad_str not in ('', '.') else 0
        except ValueError:
            cantidad = 0
        if cantidad <= 0:
            return

        ok, err, after_u, after_r = aplicar_venta(
            self.unidades, self.contenido, self.restante,
            cantidad, self.vender_por, self.unidad_base, self.unidad_venta
        )
        if not ok:
            self.error_label.setText(err)
            self.error_box.show()
            self.preview_box.hide()
            return

        if self.vender_por == 'conjunto':
            cantidad_base = cantidad * self.contenido
        elif self.unidad_venta and self.unidad_venta != self.unidad_base:
            # 'fraccion' o 'unidad' con chip de unidad distinta a la base:
            # convertir antes de calcular (ej. 50 cm → 0.5 m).
            cantidad_base = convertir(cantidad, self.unidad_venta, self.unidad_base) or cantidad
        else:
            cantidad_base = cantidad

        precio_total = self._calcular_precio(cantidad)

        self.lineas.append({
            'color':           self.current_color,
            'cantidad':        cantidad,
            'unidad_venta':    self.unidad_venta if self.vender_por != 'conjunto' else self.unidad_base,
            'cantidad_base':   cantidad_base,
            'vender_por':      self.vender_por,
            'after_unidades':  after_u,
            'after_restante':  after_r,
            'precio_total':    round(precio_total, 2),
            'precio_unitario': round(precio_total / cantidad, 4) if cantidad else 0.0,
        })

        # Aplicar consumo al estado del color
        s = self._color_state.get(self.current_color)
        if s is not None:
            s['unidades'] = after_u
            s['restante'] = after_r

        self.cantidad_str = ''
        self._refresh_all()

    def _on_remove_linea(self, idx):
        if idx < 0 or idx >= len(self.lineas):
            return
        del self.lineas[idx]
        # Recompila el estado de stock por color desde cero
        self._recalc_color_state()
        self._refresh_all()

    def _on_limpiar_subtotal(self):
        if not self.lineas:
            return
        resp = QMessageBox.question(
            self, 'Limpiar subtotal',
            f'¿Borrar las {len(self.lineas)} líneas cargadas?',
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No
        )
        if resp != QMessageBox.Yes:
            return
        self.lineas = []
        self._recalc_color_state()
        self._refresh_all()

    def _calcular_precio(self, cantidad):
        """Precio del ítem según modo de venta y unidad seleccionada.

        Si el cajero está tipeando en una unidad distinta a la base
        (ej. cm cuando la base es m), convertimos antes de multiplicar
        por el precio_unidad. Aplica tanto a 'fraccion' como a 'unidad'.
        """
        cantidad = float(cantidad or 0)
        if self.vender_por == 'conjunto':
            # Por conjunto entero = precio_unidad × contenido × cant_conjuntos
            return self.precio_unidad * self.contenido * cantidad
        if self.unidad_venta and self.unidad_venta != self.unidad_base:
            cantidad_base = convertir(cantidad, self.unidad_venta, self.unidad_base) or 0
            return self.precio_unidad * cantidad_base
        return self.precio_unidad * cantidad

    def _on_confirm(self):
        """Confirma la venta. En modo single (sin colores) toma la cantidad
        actual; en multi-color usa las líneas ya agregadas al subtotal."""
        # Si hay líneas committed (multi-color), confirmar todas
        if self.has_colores and self.lineas:
            total = round(sum(float(l.get('precio_total') or 0) for l in self.lineas), 2)
            first = self.lineas[0]
            self.result_data = {
                'lineas': list(self.lineas),
                'total':  total,
                # Compat con callers que esperaban un único item:
                'cantidad':        first['cantidad'],
                'unidad_venta':    first['unidad_venta'],
                'cantidad_base':   first['cantidad_base'],
                'vender_por':      first['vender_por'],
                'after_unidades':  first['after_unidades'],
                'after_restante':  first['after_restante'],
                'precio_total':    first['precio_total'],
                'precio_unitario': first['precio_unitario'],
            }
            self.accept()
            return

        # Modo single (legacy o multi-color sin agregar pendiente al subtotal)
        try:
            cantidad = float(self.cantidad_str)
        except ValueError:
            return
        if cantidad <= 0:
            return
        ok, err, after_u, after_r = aplicar_venta(
            self.unidades, self.contenido, self.restante,
            cantidad, self.vender_por, self.unidad_base, self.unidad_venta
        )
        if not ok:
            QMessageBox.warning(self, 'Error', err)
            return

        # Cantidad expresada en la unidad base del producto
        if self.vender_por == 'conjunto':
            cantidad_base = cantidad * self.contenido
        elif self.unidad_venta and self.unidad_venta != self.unidad_base:
            cantidad_base = convertir(cantidad, self.unidad_venta, self.unidad_base) or cantidad
        else:
            cantidad_base = cantidad

        precio_total = self._calcular_precio(cantidad)

        self.result_data = {
            'cantidad':        cantidad,
            'unidad_venta':    self.unidad_venta if self.vender_por != 'conjunto' else self.unidad_base,
            'cantidad_base':   cantidad_base,
            'vender_por':      self.vender_por,
            'after_unidades':  after_u,
            'after_restante':  after_r,
            'precio_total':    round(precio_total, 2),
            'precio_unitario': round(precio_total / cantidad, 4) if cantidad else 0.0,
            # Para multi-color sin lineas: pasarlo igual como una sola línea
            'lineas': [{
                'color':           self.current_color,
                'cantidad':        cantidad,
                'unidad_venta':    self.unidad_venta if self.vender_por != 'conjunto' else self.unidad_base,
                'cantidad_base':   cantidad_base,
                'vender_por':      self.vender_por,
                'after_unidades':  after_u,
                'after_restante':  after_r,
                'precio_total':    round(precio_total, 2),
                'precio_unitario': round(precio_total / cantidad, 4) if cantidad else 0.0,
            }] if self.has_colores else None,
            'total': round(precio_total, 2),
        }
        # Limpiar el campo 'lineas' si no aplica
        if self.result_data.get('lineas') is None:
            self.result_data.pop('lineas', None)
            self.result_data.pop('total', None)
        self.accept()

    # --- refresh y confirmación -------------------------------------------

    def _refresh_all(self):
        # Display de cantidad — sólo cambio el color y el borde según haya valor
        if self.cantidad_str == '':
            self.qty_label.setText('0')
            self.qty_label.setStyleSheet(
                f'color: #b8b1a1; background: transparent; border: none;'
            )
            self.disp_frame.setStyleSheet(
                f'QFrame#qtyDisplay {{ background: #fff; border: 2px dashed {BORDER};'
                f'                     border-radius: 12px; }}'
            )
        else:
            self.qty_label.setText(self.cantidad_str)
            self.qty_label.setStyleSheet(
                f'color: {TEXT_DARK}; background: transparent; border: none;'
            )
            self.disp_frame.setStyleSheet(
                f'QFrame#qtyDisplay {{ background: #fff; border: 2.5px solid {ACCENT};'
                f'                     border-radius: 12px; }}'
            )

        # Unidad mostrada al lado del display + chips m/cm
        # Las chips aparecen siempre que haya >1 unidad compatible (ej. m/cm),
        # también en modo "Por unidad" — así el cajero puede tipear en cm o
        # en m y el sistema convierte automáticamente.
        chips_disponibles = len(unidades_compatibles(self.unidad_base)) > 1
        if self.vender_por == 'fraccion':
            self.unit_label.setText(UNIDADES[self.unidad_venta]['short'])
            self.chips_wrap.setVisible(True)
        elif self.vender_por == 'unidad':
            chips_disponibles = len(unidades_compatibles(self.unidad_base)) > 1
            if chips_disponibles:
                # Producto con unidades compatibles (longitud, masa, etc.):
                # mostrar la unidad seleccionada y permitir cambiar en vivo.
                self.unit_label.setText(UNIDADES[self.unidad_venta]['short'])
                self.chips_wrap.setVisible(True)
            else:
                self.unit_label.setText('u')
                self.chips_wrap.setVisible(False)
        else:
            self.unit_label.setText(TIPOS[self.tipo]['label'].lower())
            self.chips_wrap.setVisible(False)

        # Refrescar celdas de stock con el color actual.
        # Si el cajero seleccionó una unidad distinta a la base (cm vs m),
        # mostrar Abierto y Total convertidos a esa unidad.
        meta = TIPOS[self.tipo]
        u_view = self.unidad_venta if (
            self.unidad_venta and self.unidad_venta in UNIDADES
        ) else self.unidad_base
        u_short = UNIDADES[u_view]['short']
        if u_view != self.unidad_base:
            restante_view = convertir(self.restante, self.unidad_base, u_view) or self.restante
            total_view    = convertir(self._total_color(), self.unidad_base, u_view) or self._total_color()
        else:
            restante_view = self.restante
            total_view    = self._total_color()
        self._cell_cerrados.set_value(format_num(self.unidades))
        self._cell_cerrados.set_sub(f'{meta["label"].lower()}(s)')
        self._cell_abierto.set_value(format_num(restante_view))
        self._cell_abierto.set_sub(f'{u_short} sueltos')
        self._cell_total.set_value(format_num(total_view))
        self._cell_total.set_sub(u_short)

        # Stock por color en los chips (si hay)
        for name, chip in self._color_chips.items():
            chip.set_stock_text(self._stock_text_for(name))

        # Refrescar lista de líneas
        self._refresh_lineas_view()

        # Simulación de la cantidad pendiente (no committeada)
        try:
            cantidad = float(self.cantidad_str) if self.cantidad_str not in ('', '.') else 0
        except ValueError:
            cantidad = 0

        precio_pendiente = 0.0
        puede_agregar_pendiente = False
        if cantidad <= 0:
            self.error_box.hide()
            self.preview_box.hide()
        else:
            ok, err, after_u, after_r = aplicar_venta(
                self.unidades, self.contenido, self.restante,
                cantidad, self.vender_por, self.unidad_base, self.unidad_venta
            )
            if not ok:
                self.error_label.setText(f'{err}')
                self.error_box.show()
                self.preview_box.hide()
            else:
                self.error_box.hide()
                self.preview_box.show()
                total_after = total_conjunto(after_u, self.contenido, after_r)
                # Convertir el preview a la unidad que el cajero seleccionó
                # con los chips. Si está en cm y el stock se guarda en m,
                # multiplicamos × 100 para que el preview matchee la cantidad.
                u_view = self.unidad_venta if (
                    self.unidad_venta and self.unidad_venta in UNIDADES
                ) else self.unidad_base
                u_view_short = UNIDADES[u_view]['short']
                if u_view != self.unidad_base:
                    total_after_view = convertir(total_after, self.unidad_base, u_view) or total_after
                    after_r_view     = convertir(after_r,     self.unidad_base, u_view) or after_r
                else:
                    total_after_view = total_after
                    after_r_view     = after_r
                self.preview_main.setText(f'{format_num(total_after_view)} {u_view_short}')
                self.preview_sub.setText(
                    f'{format_num(after_u)} cerrado · '
                    f'{format_num(after_r_view)}{u_view_short} abierto'
                )
                precio_pendiente = self._calcular_precio(cantidad)
                self.preview_price.setText(
                    f'Esta línea: ${format_num(round(precio_pendiente, 2))}'
                )
                puede_agregar_pendiente = True

        # Habilitar/deshabilitar botones segun haya algo agregable
        if hasattr(self, '_agregar_btn') and self._agregar_btn is not None:
            self._agregar_btn.setEnabled(bool(puede_agregar_pendiente))
        if hasattr(self, 'confirm_btn') and self.confirm_btn is not None:
            if self.has_colores:
                # Multi-color: confirmar requiere lineas o pendiente
                self.confirm_btn.setEnabled(bool(self.lineas) or bool(puede_agregar_pendiente))
                # Mostrar total acumulado en el botón
                total_actual = round(
                    sum(float(l.get('precio_total') or 0) for l in self.lineas) +
                    (precio_pendiente if puede_agregar_pendiente else 0),
                    2
                )
                if total_actual > 0:
                    self.confirm_btn.setText(f'Confirmar venta · ${format_num(total_actual)}')
                else:
                    self.confirm_btn.setText('Confirmar venta')
            else:
                self.confirm_btn.setEnabled(bool(puede_agregar_pendiente))

    # --- cierre con confirmación si hay subtotal pendiente ----------------

    def reject(self):
        if self._tiene_subtotal_pendiente():
            resp = QMessageBox.question(
                self, 'Subtotal cargado',
                f'Tenés {len(self.lineas)} ítem(s) cargados en el subtotal.\n'
                '¿Seguro que querés cancelar y descartarlos?',
                QMessageBox.Yes | QMessageBox.No, QMessageBox.No
            )
            if resp != QMessageBox.Yes:
                return
        super().reject()

    def closeEvent(self, e):
        if self._tiene_subtotal_pendiente():
            resp = QMessageBox.question(
                self, 'Subtotal cargado',
                f'Tenés {len(self.lineas)} ítem(s) cargados en el subtotal.\n'
                '¿Seguro que querés cerrar y descartarlos?',
                QMessageBox.Yes | QMessageBox.No, QMessageBox.No
            )
            if resp != QMessageBox.Yes:
                e.ignore()
                return
        super().closeEvent(e)

    def _tiene_subtotal_pendiente(self):
        return self.has_colores and bool(self.lineas) and self.result_data is None

    def keyPressEvent(self, e: QKeyEvent):
        # Si el cajero está tipeando en el buscador de colores, no robar las
        # teclas para el numpad (dejar que el QLineEdit las consuma).
        try:
            if hasattr(self, '_color_search') and self._color_search is not None and self._color_search.hasFocus():
                super().keyPressEvent(e)
                return
        except Exception:
            pass
        key = e.key()
        text = e.text()
        if key == Qt.Key_Escape:
            self.reject()
            return
        if key in (Qt.Key_Return, Qt.Key_Enter):
            if self.has_colores:
                if self.cantidad_str and self._agregar_btn and self._agregar_btn.isEnabled():
                    self._on_agregar()
                elif self.lineas:
                    self._on_confirm()
            else:
                if self.confirm_btn.isEnabled():
                    self._on_confirm()
            return
        if key in (Qt.Key_Backspace, Qt.Key_Delete):
            self._on_key('del')
            return
        if key == Qt.Key_Plus:
            if self.has_colores and self._agregar_btn and self._agregar_btn.isEnabled():
                self._on_agregar()
            return
        if text in ('.', ','):
            self._on_key('.')
            return
        if text and text.isdigit():
            self._on_key(text)
            return
        super().keyPressEvent(e)
