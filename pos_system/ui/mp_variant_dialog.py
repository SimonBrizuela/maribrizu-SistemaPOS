"""
MPVariantDialog — Diálogo táctil para vender Productos Madre con variantes.

Aparece cuando el cajero escanea/elige un producto madre (mp_products) que
tiene múltiples hojas (mp_nodes con es_hoja=True). Permite:
  1. Elegir la hoja deseada (cards visuales con atributos: color con swatch,
     tamaño, gramaje, etc.).
  2. Si la hoja tiene varias presentaciones (unidad/pack/caja/rollo+sueltos…),
     elegir cuál.
  3. Cargar cantidad con keypad numérico (touch + teclado físico).
  4. Ver el total con descuento override puro aplicado en tiempo real.
  5. Confirmar y devolver `self.result_data` para que `sales_view` agregue al
     ticket.

Estilo: Graphite (`pos_system/ui/theme.py`). Pensado para pantallas táctiles
de POS — botones grandes (≥48px), feedback visual claro, atajos de teclado.
"""

import logging
from typing import Dict, List, Optional

from PyQt5.QtCore import Qt, pyqtSignal, QSize
from PyQt5.QtGui import QFont, QFontDatabase, QKeyEvent, QColor, QPainter, QPen
from PyQt5.QtWidgets import (
    QApplication, QDialog, QVBoxLayout, QHBoxLayout, QGridLayout, QLabel, QPushButton,
    QFrame, QSizePolicy, QWidget, QScrollArea, QSpacerItem,
)

from pos_system.models.mother_product import (
    descuento_efectivo, aplicar_descuento, precio_efectivo_presentacion,
    node_precio_venta,
)

logger = logging.getLogger(__name__)


# ── Paleta (mp_* — violeta + clean POS-friendly) ──────────────────────────
# Distinta del Graphite naranja del POS para reforzar visualmente que es un
# producto madre (igual que el buscador con fondo violeta).
DIALOG_BG    = '#f4f1ea'
HEADER_BG    = '#ffffff'
CARD_BG      = '#ffffff'
BORDER       = '#e5e7eb'
SOFT_BORDER  = '#f1f0eb'
TEXT_DARK    = '#111827'
TEXT_MUTED   = '#6b7280'
TEXT_DIM     = '#9ca3af'
ACCENT       = '#7c3aed'
ACCENT_HOVER = '#6d28d9'
ACCENT_SOFT  = '#ede9fe'
DANGER       = '#dc2626'
SUCCESS      = '#16a34a'
TOTAL_BG     = '#111827'   # fondo card del TOTAL — protagonista

UI_FONT_CSS = '"Inter", "Segoe UI", "SF Pro Text", "Helvetica Neue", Arial, sans-serif'

MONO_FAMILIES = ['JetBrains Mono', 'Cascadia Mono', 'Consolas', 'Menlo', 'monospace']


def _mono():
    db = QFontDatabase()
    av = set(db.families())
    for f in MONO_FAMILIES:
        if f in av:
            return f
    return 'monospace'


# ── Escalado responsive ────────────────────────────────────────────────────
# Una sola fuente de verdad para tamaños: factor calculado a partir de la
# altura de pantalla y aplicado a fuentes (puntos) y dimensiones fijas (px).
# Así el diálogo se ve coherente en netbooks 1366×768, FullHD, 1440p y 4K.
_SCALE_CACHE: Optional[float] = None


def _scale() -> float:
    global _SCALE_CACHE
    if _SCALE_CACHE is not None:
        return _SCALE_CACHE
    try:
        screen = QApplication.primaryScreen()
        geo = screen.availableGeometry()
        h = geo.height()
        w = geo.width()
        # Usamos el lado más restrictivo. En 1080p mantenemos baseline y subimos
        # un toque para mejorar lectura sobre el diseño viejo.
        if h >= 2000 or w >= 3200:
            _SCALE_CACHE = 1.45      # 4K+
        elif h >= 1400 or w >= 2400:
            _SCALE_CACHE = 1.25      # 1440p / ultrawide
        elif h >= 1000:
            _SCALE_CACHE = 1.10      # 1080p
        elif h >= 800:
            _SCALE_CACHE = 0.95      # 1366×768 / netbooks
        else:
            _SCALE_CACHE = 0.85      # pantallas muy chicas
    except Exception:
        _SCALE_CACHE = 1.10
    return _SCALE_CACHE


def _sp(pt: int) -> int:
    """Escala un tamaño de fuente (puntos)."""
    return max(8, int(round(pt * _scale())))


def _sx(px: int) -> int:
    """Escala un tamaño en píxeles (alturas, paddings, mínimos)."""
    return max(1, int(round(px * _scale())))


def _fmt_money(v) -> str:
    try:
        v = float(v or 0)
    except Exception:
        v = 0
    s = f'{v:,.2f}'.replace(',', '_').replace('.', ',').replace('_', '.')
    return f'$ {s}'


def _fmt_qty(q) -> str:
    try:
        q = float(q or 0)
    except Exception:
        return '0'
    if abs(q - round(q)) < 1e-9:
        return str(int(round(q)))
    return f'{q:.2f}'.rstrip('0').rstrip('.')


def _fuente_vinculada(node: Dict, presentacion: Dict) -> Optional[Dict]:
    """Si la presentación es 'vinculada', devuelve la presentación fuente (rollo/caja
    contenedora). None si no aplica."""
    if presentacion.get('stock_modo') != 'vinculado':
        return None
    fuente_id = presentacion.get('vinculada_a')
    pres = node.get('presentaciones') or []
    if fuente_id:
        return next((p for p in pres if (p.get('id') or '') == fuente_id), None)
    # Fallback heurístico: la primera presentación independiente con equivalencia_base
    return next((p for p in pres
                 if p.get('stock_modo') != 'vinculado' and (p.get('equivalencia_base') or 0)),
                None)


def _build_stock_text(node: Dict, presentacion: Dict) -> str:
    """
    Devuelve el texto de stock para mostrar en la card de presentación.

    - Si es presentación vinculada (ej: "Por metro" enganchada al rollo), muestra:
        "Disponibles: <sueltos>m + <rollos> rollo (<equiv>m c/u)"
      ya que su stock real proviene de los sueltos + rollos cerrados de la fuente.
    - Si es independiente, muestra su propio stock + sueltos si los hay.
    """
    fuente = _fuente_vinculada(node, presentacion)
    if fuente is not None:
        sueltos = float(fuente.get('stock_sueltos') or 0)
        rollos  = float(fuente.get('stock') or 0)
        equiv   = float(fuente.get('equivalencia_base') or 0)
        um_pres = presentacion.get('unidad_medida') or ''
        tipo_fuente = fuente.get('tipo') or 'rollo'
        partes = []
        if sueltos > 0:
            partes.append(f"{_fmt_qty(sueltos)}{um_pres} sueltos")
        if rollos > 0 and equiv > 0:
            partes.append(f"{_fmt_qty(rollos)} {tipo_fuente} (×{_fmt_qty(equiv)}{um_pres})")
        elif rollos > 0:
            partes.append(f"{_fmt_qty(rollos)} {tipo_fuente}")
        if not partes:
            return f'Sin stock disponible'
        return 'Disponibles: ' + ' + '.join(partes)

    stock = float(presentacion.get('stock') or 0)
    sueltos = float(presentacion.get('stock_sueltos') or 0)
    um = presentacion.get('unidad_medida') or ''
    txt = f"Stock: {_fmt_qty(stock)}"
    if sueltos > 0:
        txt += f" + {_fmt_qty(sueltos)}{um} sueltos"
    return txt


# ── Card de hoja (variante) ────────────────────────────────────────────────
class _VariantCard(QFrame):
    """Card grande seleccionable que representa una hoja (mp_nodes con es_hoja=True).

    Muestra: nombre + atributos visibles (swatch de color, tamaño, gramaje, etc.)
    y precio efectivo con descuento aplicado.

    Se usa QFrame + mousePressEvent (no QPushButton) porque QPushButton con un
    QVBoxLayout multi-fila adentro no renderiza los hijos correctamente —
    queda solo el focus rectangle vacío con apariencia de línea punteada.
    """
    clicked = pyqtSignal()

    def __init__(self, node: Dict, producto: Dict, descuentos: List[Dict],
                 todos_los_nodos: List[Dict], parent=None):
        super().__init__(parent)
        self.node = node
        self.producto = producto
        self._checked = False
        self.setCursor(Qt.PointingHandCursor)
        self.setMinimumHeight(_sx(115))
        # Maximum vertical: la card NO crece más allá de su sizeHint (el contenido
        # real). Combinado con addStretch al final del layout padre, evita que
        # queden cards gigantes con espacio vacío adentro.
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Maximum)

        # Calcular precio + descuento (sobre el precio del nodo, presentación nula)
        precio_base = node_precio_venta(node)
        desc = descuento_efectivo(producto, node, None, todos_los_nodos, descuentos, 1)
        precio_final, _, etiqueta_desc = aplicar_descuento(precio_base, desc, 1)

        # ── Layout ──
        v = QVBoxLayout(self)
        v.setContentsMargins(_sx(14), _sx(12), _sx(14), _sx(12))
        v.setSpacing(_sx(4))

        # Nombre del nodo
        title = QLabel(node.get('nombre') or '—')
        title.setStyleSheet(
            f'color: {TEXT_DARK}; background: transparent; '
            f'font-size: {_sx(18)}px; font-weight: 700;'
        )
        title.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        title.setWordWrap(True)
        v.addWidget(title)

        # Atributos visibles
        attrs_row = self._build_atributos_row(node.get('atributos') or {})
        if attrs_row is not None:
            v.addWidget(attrs_row)

        # Stock + precio en una línea
        hb = QHBoxLayout()
        hb.setContentsMargins(0, _sx(4), 0, 0)
        hb.setSpacing(_sx(6))

        stock_lbl = QLabel(self._stock_text(node))
        stock_lbl.setStyleSheet(f'color: {TEXT_MUTED}; background: transparent; font-size: {_sx(14)}px;')
        stock_lbl.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        hb.addWidget(stock_lbl, 1)

        precio_w = self._build_precio_widget(precio_base, precio_final, etiqueta_desc)
        hb.addWidget(precio_w, 0, Qt.AlignRight)

        wrap = QWidget()
        wrap.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        wrap.setLayout(hb)
        v.addWidget(wrap)

        self._refresh()

    def setChecked(self, value: bool):
        if self._checked != bool(value):
            self._checked = bool(value)
            self._refresh()

    def isChecked(self) -> bool:
        return self._checked

    def mousePressEvent(self, ev):
        if ev.button() == Qt.LeftButton:
            self.clicked.emit()
        super().mousePressEvent(ev)

    def _build_atributos_row(self, atributos: Dict) -> Optional[QWidget]:
        if not atributos:
            return None
        wrap = QWidget()
        wrap.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        h = QHBoxLayout(wrap)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(_sx(4))
        for k, val in atributos.items():
            chip = self._mk_attr_chip(k, val)
            if chip:
                h.addWidget(chip)
        h.addStretch(1)
        return wrap

    def _mk_attr_chip(self, key: str, val) -> Optional[QWidget]:
        # Vacíos → ignorar
        if val is None or val == '':
            return None
        chip = QFrame()
        chip.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        h = QHBoxLayout(chip)
        h.setContentsMargins(_sx(9), _sx(3), _sx(9), _sx(3))
        h.setSpacing(_sx(5))

        # Color con swatch
        if isinstance(val, dict) and 'hex' in val:
            txt = (val.get('label') or val.get('value') or '').strip()
            if not txt:
                return None
            sw = _Swatch(val.get('hex') or '#000000')
            h.addWidget(sw)
            lbl = QLabel(txt)
        elif isinstance(val, dict) and ('ancho' in val or 'alto' in val):
            txt = f"{val.get('ancho','')}×{val.get('alto','')}"
            if val.get('unidad'):
                txt += f" {val['unidad']}"
            lbl = QLabel(txt)
        elif isinstance(val, dict):
            txt = (val.get('label') or '').strip()
            if not txt:
                v = val.get('value')
                u = val.get('unidad') or ''
                txt = (f'{v}{(" " + u) if u else ""}' if v not in (None, '') else '')
            if not txt:
                return None
            lbl = QLabel(txt)
        else:
            lbl = QLabel(str(val))

        lbl.setStyleSheet(
            f'color: {TEXT_DARK}; background: transparent; border: none; '
            f'font-size: {_sx(12)}px; font-weight: 700;'
        )
        h.addWidget(lbl)

        chip.setStyleSheet(
            f'QFrame {{ background: {ACCENT_SOFT}; border-radius: {_sx(8)}px; '
            f'  border: 1px solid {SOFT_BORDER}; }}'
        )
        return chip

    def _stock_text(self, node: Dict) -> str:
        pres = node.get('presentaciones') or []
        if not pres:
            return 'unidad simple'
        partes = []
        for p in pres:
            # Las presentaciones vinculadas (ej: "Por metro" enganchada al rollo)
            # no tienen stock propio — el stock real está en la fuente. Las salteamos
            # acá para no mostrar "0 metro" engañoso.
            if p.get('stock_modo') == 'vinculado' and p.get('vinculada_a'):
                continue
            tipo = p.get('tipo') or ''
            stock = float(p.get('stock') or 0)
            sueltos = float(p.get('stock_sueltos') or 0)
            txt = f"{_fmt_qty(stock)} {tipo}"
            if sueltos > 0:
                um = p.get('unidad_medida') or ''
                txt += f" + {_fmt_qty(sueltos)}{um} sueltos"
            partes.append(txt)
        if not partes:
            return 'sin stock'
        return ' / '.join(partes[:2]) + (' …' if len(partes) > 2 else '')

    def _build_precio_widget(self, base: float, final: float, etiqueta: str) -> QWidget:
        w = QWidget()
        w.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        v = QVBoxLayout(w)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)

        if etiqueta:
            tachado = QLabel(_fmt_money(base))
            tachado.setStyleSheet(
                f'color: {TEXT_DIM}; text-decoration: line-through; background: transparent; '
                f'font-size: {_sx(11)}px;'
            )
            tachado.setAttribute(Qt.WA_TransparentForMouseEvents, True)
            v.addWidget(tachado, 0, Qt.AlignRight)

        precio = QLabel(_fmt_money(final))
        precio.setStyleSheet(
            f'color: {ACCENT}; background: transparent; '
            f'font-family: "{_mono()}", monospace; '
            f'font-size: {_sx(20)}px; font-weight: 700;'
        )
        precio.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        v.addWidget(precio, 0, Qt.AlignRight)

        if etiqueta:
            tag = QLabel(etiqueta)
            tag.setStyleSheet(
                f'color: #7c3aed; background: transparent; '
                f'font-size: {_sx(11)}px; font-weight: 700;'
            )
            tag.setAttribute(Qt.WA_TransparentForMouseEvents, True)
            v.addWidget(tag, 0, Qt.AlignRight)
        return w

    def _refresh(self):
        active = self.isChecked()
        bg = ACCENT_SOFT if active else CARD_BG
        bord = ACCENT if active else BORDER
        bw = '2px' if active else '1px'
        self.setStyleSheet(
            f'_VariantCard {{ background: {bg}; border: {bw} solid {bord}; '
            f'  border-radius: {_sx(12)}px; }}'
            f'_VariantCard:hover {{ border-color: {ACCENT}; }}'
        )


class _Swatch(QFrame):
    """Circulito de color — para visualizar atributos tipo color."""
    def __init__(self, hex_color: str, parent=None):
        super().__init__(parent)
        self.hex_color = hex_color or '#000000'
        s = _sx(16)
        self.setFixedSize(s, s)
        self.setAttribute(Qt.WA_TransparentForMouseEvents, True)

    def paintEvent(self, ev):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        p.setBrush(QColor(self.hex_color))
        p.setPen(QPen(QColor('#cfcfcf'), 1))
        p.drawEllipse(0, 0, self.width() - 1, self.height() - 1)


# ── Card de presentación ───────────────────────────────────────────────────
class _PresentacionCard(QFrame):
    """Card seleccionable para una presentación (unidad/pack/caja/rollo…).

    Usa QFrame + mousePressEvent (mismo motivo que _VariantCard).
    """
    clicked = pyqtSignal()

    def __init__(self, node: Dict, presentacion: Dict, producto: Dict,
                 descuentos: List[Dict], todos_los_nodos: List[Dict], parent=None):
        super().__init__(parent)
        self.presentacion = presentacion
        self._checked = False
        self.setCursor(Qt.PointingHandCursor)
        self.setMinimumHeight(_sx(110))
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Maximum)

        # Precio: si la presentación es vinculada (ej: "Por metro" enganchada al rollo) y
        # no tiene precio propio, se calcula auto = rollo.precio / rollo.equivalencia × 1.15.
        precio_base = precio_efectivo_presentacion(node, presentacion)
        desc = descuento_efectivo(producto, node, presentacion, todos_los_nodos, descuentos, 1)
        precio_final, _, etiqueta_desc = aplicar_descuento(precio_base, desc, 1)

        v = QVBoxLayout(self)
        v.setContentsMargins(_sx(16), _sx(12), _sx(16), _sx(12))
        v.setSpacing(_sx(5))

        title = QLabel(presentacion.get('label') or presentacion.get('tipo') or '—')
        title.setStyleSheet(
            f'color: {TEXT_DARK}; background: transparent; '
            f'font-size: {_sx(20)}px; font-weight: 700;'
        )
        title.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        title.setWordWrap(True)
        v.addWidget(title)

        # Stock: si es vinculada, mostrar la disponibilidad real derivada de la fuente
        # (sueltos + rollos × equivalencia). Si es independiente, mostrar su propio stock.
        stock_txt = _build_stock_text(node, presentacion)
        stock_lbl = QLabel(stock_txt)
        stock_lbl.setStyleSheet(f'color: {TEXT_MUTED}; background: transparent; font-size: {_sx(15)}px;')
        stock_lbl.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        stock_lbl.setWordWrap(True)
        v.addWidget(stock_lbl)

        # Precio prominente — última línea de la card. Tachado + final + etiqueta.
        px_tach = _sx(14)
        px_final = _sx(24)
        px_etiq = _sx(13)
        if etiqueta_desc:
            prec_html = (
                f'<span style="color:{TEXT_DIM};text-decoration:line-through;font-size:{px_tach}px">'
                f'{_fmt_money(precio_base)}</span> &nbsp; '
                f'<span style="color:{ACCENT};font-weight:bold;font-size:{px_final}px">'
                f'{_fmt_money(precio_final)}</span> &nbsp; '
                f'<span style="color:#7c3aed;font-weight:bold;font-size:{px_etiq}px">{etiqueta_desc}</span>'
            )
        else:
            prec_html = (
                f'<span style="color:{ACCENT};font-weight:bold;font-size:{px_final}px">'
                f'{_fmt_money(precio_final)}</span>'
            )
        prec = QLabel(prec_html)
        prec.setTextFormat(Qt.RichText)
        prec.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        v.addWidget(prec)

        self.precio_base = precio_base
        self.precio_final = precio_final
        self.etiqueta_desc = etiqueta_desc

        self._refresh()

    def setChecked(self, value: bool):
        if self._checked != bool(value):
            self._checked = bool(value)
            self._refresh()

    def isChecked(self) -> bool:
        return self._checked

    def mousePressEvent(self, ev):
        if ev.button() == Qt.LeftButton:
            self.clicked.emit()
        super().mousePressEvent(ev)

    def _refresh(self):
        active = self.isChecked()
        bg = ACCENT_SOFT if active else CARD_BG
        bord = ACCENT if active else BORDER
        bw = '2px' if active else '1px'
        self.setStyleSheet(
            f'_PresentacionCard {{ background: {bg}; border: {bw} solid {bord}; '
            f'  border-radius: {_sx(10)}px; }}'
            f'_PresentacionCard:hover {{ border-color: {ACCENT}; }}'
        )


# ── Keypad numérico táctil ────────────────────────────────────────────────
class _Keypad(QWidget):
    pressed = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        grid = QGridLayout(self)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(_sx(8))
        grid.setVerticalSpacing(_sx(8))
        for c in range(3):
            grid.setColumnStretch(c, 1)
        for r in range(4):
            grid.setRowStretch(r, 1)

        teclas = [
            ('7', 0, 0), ('8', 0, 1), ('9', 0, 2),
            ('4', 1, 0), ('5', 1, 1), ('6', 1, 2),
            ('1', 2, 0), ('2', 2, 1), ('3', 2, 2),
            ('.', 3, 0), ('0', 3, 1), ('⌫', 3, 2),
        ]
        for txt, r, c in teclas:
            b = QPushButton(txt)
            b.setMinimumSize(_sx(70), _sx(58))
            b.setCursor(Qt.PointingHandCursor)
            b.setFocusPolicy(Qt.NoFocus)
            b.setStyleSheet(
                f'QPushButton {{ background: {CARD_BG}; color: {TEXT_DARK}; '
                f'  border: 1.5px solid {BORDER}; border-radius: {_sx(10)}px; '
                f'  font-family: "{_mono()}", monospace; '
                f'  font-size: {_sx(22)}px; font-weight: 700; }}'
                f'QPushButton:hover {{ border-color: {ACCENT}; background: {ACCENT_SOFT}; }}'
                f'QPushButton:pressed {{ background: {ACCENT_HOVER}; color: white; }}'
            )
            tecla = txt
            b.clicked.connect(lambda _=False, k=tecla: self.pressed.emit(k))
            grid.addWidget(b, r, c)


def _ui_family():
    db = QFontDatabase()
    av = set(db.families())
    for f in ['Inter', 'Segoe UI', 'SF Pro Text', 'Helvetica Neue', 'Arial']:
        if f in av:
            return f
    return 'sans-serif'


# ── Diálogo principal ──────────────────────────────────────────────────────
class MPVariantDialog(QDialog):
    """
    Resultado al confirmar (self.result_data):
        {
            'product_id':      str,
            'node_id':         str,
            'node_name':       str,
            'presentation_id': str | None,
            'presentation_label': str | None,
            'qty':             float,
            'precio_unit_base':  float,
            'precio_unit_final': float,
            'descuento_etiqueta': str,
            'subtotal':        float,
            'descuento_monto': float,
            'codigo_barras':   str | None,
        }
    """
    def __init__(self, producto: Dict, hojas: List[Dict], descuentos: List[Dict],
                 parent=None):
        super().__init__(parent)
        self.producto = producto
        self.hojas = hojas or []
        self.descuentos = descuentos or []
        self.todos_los_nodos = list(self.hojas)  # alias para descuentos override
        self.result_data: Optional[Dict] = None

        self._selected_node: Optional[Dict] = None
        self._selected_pres: Optional[Dict] = None
        self._qty_str: str = '1'
        # True hasta que el usuario tipea — el primer dígito reemplaza el '1' inicial.
        # Después se concatena: 1 → '1' → tipear '0' → '10'.
        self._qty_initial: bool = True
        self._variant_btns: List[_VariantCard] = []
        self._pres_btns: List[_PresentacionCard] = []
        # Subtotal acumulativo: el cajero puede agregar varias líneas (color/variante
        # + presentación + cantidad) antes de confirmar la venta. Cada línea sigue
        # el mismo formato que el result_data legacy.
        self._lineas: List[Dict] = []

        self.setWindowTitle(f"Vender — {producto.get('nombre') or 'Producto'}")
        self.setModal(True)
        # Sizing 100% adaptativo:
        #  - El mínimo nunca excede la pantalla disponible (clamp a 90% en
        #    cualquier eje), así entra en netbooks 1024×600 igual que en 4K.
        #  - El target es el espacio disponible (~88%) sin pasarse de un
        #    tope cómodo, para que en monitores muy grandes no quede gigante.
        #  - El layout interno se reorganiza en resizeEvent (columnas de
        #    variantes adaptativas según ancho real).
        self._current_cols = 0  # se setea en _reflow_variants
        try:
            screen = QApplication.primaryScreen().availableGeometry()
            sw, sh = screen.width(), screen.height()
            hard_min_w = 900
            hard_min_h = 520
            min_w = max(hard_min_w, min(_sx(1200), int(sw * 0.92)))
            min_h = max(hard_min_h, min(_sx(620),  int(sh * 0.92)))
            self.setMinimumSize(min_w, min_h)
            # Default amplio — el carrito y el TOTAL necesitan aire para que el
            # nombre del producto no se rompa en 3 líneas y el total se lea.
            target_w = max(min_w, min(_sx(1600), int(sw * 0.94)))
            target_h = max(min_h, min(_sx(900),  int(sh * 0.92)))
            self.resize(target_w, target_h)
            self.move(screen.x() + (sw - target_w) // 2,
                      screen.y() + (sh - target_h) // 2)
        except Exception:
            self.setMinimumSize(900, 520)
            self.resize(_sx(1480), _sx(860))
        self.setStyleSheet(f'QDialog {{ background: {DIALOG_BG}; }}')

        self._build_ui()

        # Si solo hay 1 hoja, auto-seleccionarla
        if len(self.hojas) == 1:
            self._on_card_clicked(self.hojas[0])

    # ── UI ──
    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(_sx(16), _sx(14), _sx(16), _sx(14))
        root.setSpacing(_sx(12))

        # Header
        root.addWidget(self._build_header())

        # Body en 3 columnas: variantes · presentaciones · cantidad/ticket.
        # Cada columna usa todo su alto disponible y tiene scroll si hace falta,
        # así nunca se corta una card por falta de espacio.
        body = QHBoxLayout()
        body.setSpacing(_sx(14))

        # ── Columna 1: Variantes ────────────────────────────────────────
        col_variantes = QVBoxLayout()
        col_variantes.setSpacing(_sx(10))
        col_variantes.addWidget(self._lbl_section('1. Elegí la variante'))
        self._variant_scroll = self._build_variant_grid()
        col_variantes.addWidget(self._variant_scroll, 1)
        body.addLayout(col_variantes, 3)

        # ── Columna 2: Presentación ─────────────────────────────────────
        col_pres = QVBoxLayout()
        col_pres.setSpacing(_sx(10))
        self._pres_section = self._lbl_section('2. Presentación')
        col_pres.addWidget(self._pres_section)
        self._pres_scroll = QScrollArea()
        self._pres_scroll.setWidgetResizable(True)
        self._pres_scroll.setFrameShape(QFrame.NoFrame)
        self._pres_scroll.setStyleSheet('QScrollArea { background: transparent; border: none; }')
        self._pres_container = QWidget()
        self._pres_container.setStyleSheet('background: transparent;')
        pres_layout = QVBoxLayout(self._pres_container)
        pres_layout.setContentsMargins(0, 0, _sx(4), 0)
        pres_layout.setSpacing(_sx(8))
        pres_layout.setAlignment(Qt.AlignTop)
        self._pres_layout = pres_layout
        self._pres_scroll.setWidget(self._pres_container)
        col_pres.addWidget(self._pres_scroll, 1)
        body.addLayout(col_pres, 3)

        # ── Columna 3: cantidad + keypad + carrito + total + acciones ──
        # Wrapper con minWidth — sin esto la columna queda muy angosta y los
        # nombres del carrito ("1 × hilo fino 20m pack") se rompen en 3 líneas.
        col_right = QVBoxLayout()
        col_right.setSpacing(_sx(10))
        col_right.addWidget(self._build_qty_box())
        col_right.addWidget(self._build_keypad_box())
        col_right.addWidget(self._build_cart_box(), 1)
        col_right.addWidget(self._build_total_box())
        col_right.addWidget(self._build_actions())
        right_wrap = QWidget()
        right_wrap.setLayout(col_right)
        # Min más chico → en dialogos angostos las variantes/presentaciones
        # quedan con más aire y no se cortan los nombres.
        right_wrap.setMinimumWidth(_sx(320))
        body.addWidget(right_wrap, 2)

        root.addLayout(body, 1)

    def _build_header(self) -> QWidget:
        wrap = QFrame()
        wrap.setStyleSheet(f'QFrame {{ background: {HEADER_BG}; border-radius: {_sx(10)}px; }}')
        h = QHBoxLayout(wrap)
        h.setContentsMargins(_sx(18), _sx(14), _sx(18), _sx(14))
        h.setSpacing(_sx(10))

        title = QLabel(self.producto.get('nombre') or 'Producto')
        title.setStyleSheet(
            f'color: {TEXT_DARK}; background: transparent; '
            f'font-size: {_sx(22)}px; font-weight: 700;'
        )
        h.addWidget(title)

        sub_parts = []
        if self.producto.get('categoria'):
            sub_parts.append(self.producto['categoria'])
        if self.producto.get('marca'):
            sub_parts.append(self.producto['marca'])
        if sub_parts:
            sub = QLabel(' · '.join(sub_parts))
            sub.setStyleSheet(f'color: {TEXT_MUTED}; background: transparent; font-size: {_sx(14)}px;')
            h.addWidget(sub)

        h.addStretch(1)

        cont = QLabel(f'{len(self.hojas)} variante(s)')
        cont.setStyleSheet(f'color: {TEXT_DIM}; background: transparent; font-size: {_sx(13)}px;')
        h.addWidget(cont)
        return wrap

    def _lbl_section(self, txt: str) -> QLabel:
        lbl = QLabel(txt)
        lbl.setStyleSheet(
            f'color: {TEXT_MUTED}; background: transparent; '
            f'letter-spacing: 0.6px; text-transform: uppercase; '
            f'font-size: {_sx(14)}px; font-weight: 700;'
        )
        return lbl

    def _build_variant_grid(self) -> QScrollArea:
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setStyleSheet('QScrollArea { background: transparent; border: none; }')

        inner = QWidget()
        inner.setStyleSheet('background: transparent;')
        # Layout vertical: arriba el grid de cards alineadas al tope, abajo un
        # stretch para empujar las cards hacia arriba (si la columna es alta).
        outer = QVBoxLayout(inner)
        outer.setContentsMargins(0, 0, _sx(4), 0)
        outer.setSpacing(0)
        grid = QGridLayout()
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(_sx(10))
        grid.setVerticalSpacing(_sx(10))

        if not self.hojas:
            empty = QLabel('Este producto no tiene variantes vendibles cargadas.')
            empty.setAlignment(Qt.AlignCenter)
            empty.setStyleSheet(f'color: {TEXT_MUTED}; padding: {_sx(40)}px; font-size: {_sx(13)}px;')
            grid.addWidget(empty, 0, 0)
        else:
            for h in self.hojas:
                btn = _VariantCard(h, self.producto, self.descuentos,
                                   self.todos_los_nodos, parent=inner)
                btn.clicked.connect(lambda _=False, n=h, b=btn: self._on_card_clicked(n, b))
                self._variant_btns.append(btn)
                # Posición inicial — _reflow_variants() las re-acomoda al primer resize.
                grid.addWidget(btn, 0, 0)

        outer.addLayout(grid)
        outer.addStretch(1)  # las cards se alinean al tope
        scroll.setWidget(inner)
        scroll.setMinimumHeight(_sx(220))
        self._variant_grid = grid
        # Layout inicial mínimo (1 col); resizeEvent lo ajusta al ancho real.
        self._reflow_variants(force_cols=1)
        return scroll

    def _reflow_variants(self, force_cols: Optional[int] = None):
        """Acomoda las cards de variante en N columnas según el ancho disponible.

        Llamado por resizeEvent — así el grid se reorganiza automáticamente
        cuando el usuario redimensiona la ventana o cuando cambia la pantalla.
        """
        grid = getattr(self, '_variant_grid', None)
        if grid is None or not self._variant_btns:
            return

        if force_cols is not None:
            cols = max(1, force_cols)
        else:
            # Decidimos en base al ancho TOTAL del diálogo (más confiable que el
            # viewport del scroll, que puede dar valores transitorios durante el
            # primer paint). Umbrales pensados para que cada card tenga ≥320px.
            dialog_w = self.width()
            if dialog_w >= _sx(1700):
                cols = 3
            elif dialog_w >= _sx(1380):
                cols = 2
            else:
                cols = 1

        if cols == self._current_cols:
            return
        self._current_cols = cols

        # Re-extraer cards y volver a colocarlas con la nueva grilla.
        for btn in self._variant_btns:
            grid.removeWidget(btn)
        # Reset stretches
        for c in range(8):
            grid.setColumnStretch(c, 0)
        for c in range(cols):
            grid.setColumnStretch(c, 1)
        for i, btn in enumerate(self._variant_btns):
            grid.addWidget(btn, i // cols, i % cols)

    def resizeEvent(self, ev):
        super().resizeEvent(ev)
        self._reflow_variants()

    def _build_qty_box(self) -> QWidget:
        wrap = QFrame()
        wrap.setStyleSheet(f'QFrame {{ background: {CARD_BG}; border-radius: {_sx(10)}px; '
                            f'  border: 1px solid {BORDER}; }}')
        v = QVBoxLayout(wrap)
        v.setContentsMargins(_sx(16), _sx(12), _sx(16), _sx(12))
        v.setSpacing(_sx(2))

        lbl = QLabel('3. CANTIDAD')
        lbl.setStyleSheet(
            f'color: {TEXT_MUTED}; background: transparent; letter-spacing: 1px; '
            f'font-size: {_sx(13)}px; font-weight: 700;'
        )
        v.addWidget(lbl)

        self._qty_label = QLabel(self._qty_str)
        self._qty_label.setStyleSheet(
            f'color: {TEXT_DARK}; background: transparent; '
            f'font-family: "{_mono()}", monospace; '
            f'font-size: {_sx(34)}px; font-weight: 700;'
        )
        self._qty_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        v.addWidget(self._qty_label)

        self._qty_unit_label = QLabel('un')
        self._qty_unit_label.setStyleSheet(
            f'color: {TEXT_DIM}; background: transparent; font-size: {_sx(15)}px;'
        )
        self._qty_unit_label.setAlignment(Qt.AlignRight)
        v.addWidget(self._qty_unit_label)

        return wrap

    def _build_keypad_box(self) -> QWidget:
        kp = _Keypad()
        kp.pressed.connect(self._on_keypad)
        return kp

    def _build_cart_box(self) -> QWidget:
        """Carrito visible: lista de líneas que el cajero ya agregó al subtotal."""
        wrap = QFrame()
        wrap.setStyleSheet(f'QFrame {{ background: {CARD_BG}; border-radius: {_sx(10)}px; '
                            f'  border: 1px solid {BORDER}; }}')
        v = QVBoxLayout(wrap)
        v.setContentsMargins(_sx(14), _sx(10), _sx(14), _sx(10))
        v.setSpacing(_sx(4))

        head = QHBoxLayout()
        head.setContentsMargins(0, 0, 0, 0)
        head.setSpacing(_sx(6))
        title = QLabel('SUBTOTAL')
        title.setStyleSheet(
            f'color: {TEXT_MUTED}; background: transparent; letter-spacing: 1px; '
            f'font-size: {_sx(13)}px; font-weight: 700;'
        )
        head.addWidget(title, 1)
        self._cart_count = QLabel('0 items')
        self._cart_count.setStyleSheet(f'color: {TEXT_DIM}; background: transparent; font-size: {_sx(12)}px;')
        head.addWidget(self._cart_count)
        v.addLayout(head)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setStyleSheet('QScrollArea { background: transparent; border: none; }')
        scroll.setMinimumHeight(_sx(80))

        self._cart_inner = QWidget()
        self._cart_inner.setStyleSheet('background: transparent;')
        self._cart_layout = QVBoxLayout(self._cart_inner)
        self._cart_layout.setContentsMargins(0, 0, 0, 0)
        self._cart_layout.setSpacing(_sx(4))
        self._cart_layout.setAlignment(Qt.AlignTop)
        scroll.setWidget(self._cart_inner)
        v.addWidget(scroll, 1)

        # Estado vacío
        self._cart_empty_lbl = QLabel('Aún no agregaste líneas a esta venta.')
        self._cart_empty_lbl.setAlignment(Qt.AlignCenter)
        self._cart_empty_lbl.setStyleSheet(
            f'color: {TEXT_DIM}; font-size: {_sx(12)}px; font-style: italic; padding: {_sx(12)}px;'
        )
        self._cart_layout.addWidget(self._cart_empty_lbl)

        return wrap

    def _build_total_box(self) -> QWidget:
        # TOTAL protagonista — fondo negro, texto blanco gigante.
        wrap = QFrame()
        wrap.setStyleSheet(f'QFrame {{ background: {TOTAL_BG}; border-radius: {_sx(12)}px; }}')
        v = QVBoxLayout(wrap)
        v.setContentsMargins(_sx(20), _sx(16), _sx(20), _sx(18))
        v.setSpacing(_sx(2))

        # IMPORTANTE: el QSS global `* { font-size: 12px }` (styles_graphite.qss)
        # PISA cualquier QFont().setPointSize(), por eso seteamos el tamaño
        # directamente en el stylesheet del widget — eso sí gana el cascade.
        lbl = QLabel('TOTAL')
        lbl.setStyleSheet(
            f'color: #9ca3af; background: transparent; letter-spacing: 1.5px; '
            f'font-size: {_sx(16)}px; font-weight: 700;'
        )
        v.addWidget(lbl)

        self._total_label = QLabel('$ 0,00')
        self._total_label.setStyleSheet(
            f'color: #ffffff; background: transparent; '
            f'font-family: "{_mono()}", monospace; '
            f'font-size: {_sx(38)}px; font-weight: 700;'
        )
        self._total_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        self._total_label.setMinimumHeight(_sx(56))
        v.addWidget(self._total_label)

        self._total_desc_label = QLabel('')
        self._total_desc_label.setStyleSheet(
            f'color: #d1d5db; background: transparent; font-size: {_sx(13)}px;'
        )
        self._total_desc_label.setAlignment(Qt.AlignRight)
        self._total_desc_label.setWordWrap(True)
        v.addWidget(self._total_desc_label)

        return wrap

    def _build_actions(self) -> QWidget:
        wrap = QWidget()
        v = QVBoxLayout(wrap)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(_sx(6))

        # Fila 1: agregar línea actual al subtotal (no cierra el diálogo)
        self._btn_add = QPushButton('  + Agregar al subtotal')
        self._btn_add.setMinimumHeight(_sx(50))
        self._btn_add.setCursor(Qt.PointingHandCursor)
        self._btn_add.setFocusPolicy(Qt.NoFocus)
        self._btn_add.setEnabled(False)
        self._btn_add.clicked.connect(self._on_agregar_subtotal)
        v.addWidget(self._btn_add)
        # font-size se aplica vía stylesheet en _refresh_action_buttons

        # Fila 2: cancelar / confirmar venta completa
        h = QHBoxLayout()
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(_sx(8))

        self._btn_cancel = QPushButton('Cancelar')
        self._btn_cancel.setMinimumHeight(_sx(50))
        self._btn_cancel.setCursor(Qt.PointingHandCursor)
        self._btn_cancel.setFocusPolicy(Qt.NoFocus)
        self._btn_cancel.setStyleSheet(
            f'QPushButton {{ background: {CARD_BG}; color: {TEXT_DARK}; '
            f'  border: 1.5px solid {BORDER}; border-radius: {_sx(10)}px; padding: 0 {_sx(16)}px; '
            f'  font-size: {_sx(15)}px; font-weight: 700; }}'
            f'QPushButton:hover {{ background: #f0ece2; }}'
        )
        self._btn_cancel.clicked.connect(self.reject)
        h.addWidget(self._btn_cancel, 1)

        self._btn_ok = QPushButton('Confirmar venta')
        self._btn_ok.setMinimumHeight(_sx(50))
        self._btn_ok.setCursor(Qt.PointingHandCursor)
        self._btn_ok.setFocusPolicy(Qt.NoFocus)
        self._btn_ok.setEnabled(False)
        self._btn_ok.clicked.connect(self._on_confirm)
        h.addWidget(self._btn_ok, 2)

        v.addLayout(h)
        self._refresh_action_buttons()
        return wrap

    def _refresh_action_buttons(self):
        # Botón "+ Agregar al subtotal" — habilitado si hay variante (y presentación
        # cuando aplica) seleccionada y la cantidad es > 0.
        puede_agregar = bool(self._selected_node) and self._qty() > 0 and self._seleccion_pres_completa()
        self._btn_add.setEnabled(puede_agregar)
        bg_add = '#fef3c7' if puede_agregar else SOFT_BORDER
        col_add = '#92400e' if puede_agregar else TEXT_DIM
        bord_add = '#fde68a' if puede_agregar else SOFT_BORDER
        self._btn_add.setStyleSheet(
            f'QPushButton {{ background: {bg_add}; color: {col_add}; '
            f'  border: 1.5px solid {bord_add}; border-radius: {_sx(10)}px; '
            f'  padding: 0 {_sx(14)}px; text-align: center; '
            f'  font-size: {_sx(15)}px; font-weight: 700; }}'
            f'QPushButton:hover {{ background: {"#fde68a" if puede_agregar else SOFT_BORDER}; }}'
        )

        # Botón "Confirmar venta" — habilitado si hay líneas en el carrito o si se
        # puede agregar la selección actual (auto-flush al confirmar).
        puede_confirmar = bool(self._lineas) or puede_agregar
        self._btn_ok.setEnabled(puede_confirmar)
        bg = ACCENT if puede_confirmar else SOFT_BORDER
        col = '#ffffff' if puede_confirmar else TEXT_DIM
        self._btn_ok.setStyleSheet(
            f'QPushButton {{ background: {bg}; color: {col}; '
            f'  border: none; border-radius: {_sx(10)}px; padding: 0 {_sx(16)}px; '
            f'  font-size: {_sx(16)}px; font-weight: 700; }}'
            f'QPushButton:hover {{ background: {ACCENT_HOVER if puede_confirmar else SOFT_BORDER}; }}'
        )

    def _seleccion_pres_completa(self) -> bool:
        """True si la variante seleccionada no requiere presentación O ya hay una elegida."""
        if not self._selected_node:
            return False
        pres = self._selected_node.get('presentaciones') or []
        if not pres:
            return True  # unidad simple
        if len(pres) == 1:
            return True  # única, auto-seleccionada
        return self._selected_pres is not None

    # ── Lógica ──
    def _on_card_clicked(self, node: Dict, btn: Optional[_VariantCard] = None):
        # Marcar visualmente esta card como activa, des-seleccionar las otras
        for b in self._variant_btns:
            b.setChecked(b.node['id'] == node.get('id'))
        self._selected_node = node
        self._selected_pres = None
        # Re-mostrar la sección de presentaciones (queda oculta tras
        # "+ Agregar al subtotal" — sin esto no aparecía al re-clickear).
        self._pres_section.setVisible(True)
        self._pres_scroll.setVisible(True)
        # Render presentaciones
        presentaciones = node.get('presentaciones') or []
        self._pres_btns.clear()
        # Limpiar layout previo (incluyendo placeholder si existe)
        while self._pres_layout.count():
            item = self._pres_layout.takeAt(0)
            w = item.widget()
            if w:
                w.setParent(None)
                w.deleteLater()

        if not presentaciones:
            # Hoja sin presentaciones embebidas: se vende como "1 unidad simple"
            # con el precio del nodo. Mostramos una card explicativa.
            info = QLabel(f'Se vende como 1 unidad simple\nal precio del nodo')
            info.setAlignment(Qt.AlignCenter)
            info.setWordWrap(True)
            info.setStyleSheet(
                f'color: {TEXT_MUTED}; font-size: {_sx(14)}px; padding: {_sx(32)}px; '
                f'background: {CARD_BG}; border: 1.5px solid {BORDER}; '
                f'border-radius: {_sx(12)}px;'
            )
            self._pres_layout.addWidget(info)
            self._pres_layout.addStretch(1)
            self._update_total()
            self._refresh_action_buttons()
            return

        # Si solo hay 1 presentación la auto-seleccionamos, pero igual la pintamos
        # como card destacada para que el cajero VEA qué se está vendiendo.
        if len(presentaciones) == 1:
            self._selected_pres = presentaciones[0]
            card = _PresentacionCard(node, presentaciones[0], self.producto, self.descuentos,
                                     self.todos_los_nodos, parent=self._pres_container)
            card.setChecked(True)
            self._pres_btns.append(card)
            self._pres_layout.addWidget(card)
            self._pres_layout.addStretch(1)
            self._update_total()
            self._refresh_action_buttons()
            return

        for p in presentaciones:
            card = _PresentacionCard(node, p, self.producto, self.descuentos,
                                     self.todos_los_nodos, parent=self._pres_container)
            card.clicked.connect(lambda _=False, pp=p, cc=card: self._on_pres_clicked(pp, cc))
            self._pres_btns.append(card)
            self._pres_layout.addWidget(card)
        # Stretch al final absorbe espacio sobrante — sin esto las cards se
        # estiran verticalmente y quedan enormes con mucho vacío adentro.
        self._pres_layout.addStretch(1)
        self._refresh_action_buttons()
        self._update_total()

    def _on_pres_clicked(self, pres: Dict, btn: _PresentacionCard):
        for b in self._pres_btns:
            b.setChecked(b.presentacion is pres)
        self._selected_pres = pres
        self._btn_ok.setEnabled(True)
        self._refresh_action_buttons()
        # Actualizar unidad del qty box
        if pres.get('unidad_medida'):
            self._qty_unit_label.setText(pres['unidad_medida'])
        self._update_total()

    def _on_keypad(self, key: str):
        if key == '⌫':
            if len(self._qty_str) <= 1:
                self._qty_str = '0'
            else:
                self._qty_str = self._qty_str[:-1]
            self._qty_initial = False
        elif key == '.':
            if '.' not in self._qty_str:
                self._qty_str = (self._qty_str or '0') + '.'
                self._qty_initial = False
        else:
            # Dígito: reemplaza si es la primera tecla tipeada (qty='1' inicial)
            # o si el valor actual es '0' suelto. Si no, concatena.
            if self._qty_initial or self._qty_str == '0':
                self._qty_str = key
            else:
                self._qty_str += key
            self._qty_initial = False
        # Limitar largo
        if len(self._qty_str) > 8:
            self._qty_str = self._qty_str[:8]
        self._qty_label.setText(self._qty_str or '0')
        self._update_total()

    def _qty(self) -> float:
        try:
            return float(self._qty_str or '0')
        except Exception:
            return 0

    def _update_total(self):
        # Total visible = lo acumulado en el carrito + la línea actual en preparación.
        ya_acumulado = sum((l.get('subtotal') or 0) for l in self._lineas)
        actual_subtotal = 0.0
        actual_desc_monto = 0.0
        actual_etiqueta = ''
        if self._selected_node and self._qty() > 0:
            qty = self._qty()
            precio_base = (precio_efectivo_presentacion(self._selected_node, self._selected_pres)
                            if self._selected_pres
                            else node_precio_venta(self._selected_node))
            desc = descuento_efectivo(self.producto, self._selected_node, self._selected_pres,
                                      self.todos_los_nodos, self.descuentos, qty)
            precio_final, desc_monto, etiqueta = aplicar_descuento(precio_base, desc, qty)
            actual_subtotal = precio_final * qty
            actual_desc_monto = (precio_base - precio_final) * qty
            actual_etiqueta = etiqueta
        total_final = ya_acumulado + actual_subtotal
        self._total_label.setText(_fmt_money(total_final))

        # Leyenda contextual
        partes = []
        if self._lineas:
            partes.append(f"{len(self._lineas)} línea(s) en subtotal · {_fmt_money(ya_acumulado)}")
        if actual_etiqueta and actual_subtotal > 0:
            partes.append(f"línea actual {actual_etiqueta} · ahorra {_fmt_money(actual_desc_monto)}")
        self._total_desc_label.setText(' · '.join(partes) if partes else '')

    def _compute_linea_actual(self) -> Optional[Dict]:
        """Construye el diccionario de la línea con la selección y cantidad actual."""
        if not self._selected_node:
            return None
        qty = self._qty()
        if qty <= 0:
            return None
        precio_base = (precio_efectivo_presentacion(self._selected_node, self._selected_pres)
                        if self._selected_pres
                        else node_precio_venta(self._selected_node))
        desc = descuento_efectivo(self.producto, self._selected_node, self._selected_pres,
                                  self.todos_los_nodos, self.descuentos, qty)
        precio_final, _, etiqueta = aplicar_descuento(precio_base, desc, qty)
        return {
            'product_id':         self.producto.get('id'),
            'product_name':       self.producto.get('nombre'),
            'node_id':            self._selected_node.get('id'),
            'node_name':          self._selected_node.get('nombre'),
            'presentation_id':    (self._selected_pres or {}).get('id') if self._selected_pres else None,
            'presentation_label': (self._selected_pres or {}).get('label') if self._selected_pres else None,
            'qty':                qty,
            'precio_unit_base':   precio_base,
            'precio_unit_final':  precio_final,
            'descuento_etiqueta': etiqueta,
            'subtotal':           precio_final * qty,
            'descuento_monto':    (precio_base - precio_final) * qty,
            'codigo_barras':      ((self._selected_pres or {}).get('codigo_barras')
                                    if self._selected_pres else self.producto.get('codigo_barras')),
        }

    def _on_agregar_subtotal(self):
        """Agrega la línea actual al carrito interno y resetea la selección."""
        linea = self._compute_linea_actual()
        if not linea:
            return
        self._lineas.append(linea)
        self._update_cart_view()
        # Resetear selección y cantidad para la próxima
        self._selected_node = None
        self._selected_pres = None
        for b in self._variant_btns:
            b.setChecked(False)
        for b in self._pres_btns:
            b.setChecked(False)
        # Limpiar sección de presentaciones
        self._pres_section.setVisible(False)
        self._pres_scroll.setVisible(False)
        self._pres_btns.clear()
        while self._pres_layout.count():
            item = self._pres_layout.takeAt(0)
            w = item.widget()
            if w:
                w.setParent(None)
                w.deleteLater()
        # Resetear cantidad a 1
        self._qty_str = '1'
        self._qty_initial = True
        self._qty_label.setText(self._qty_str)
        self._qty_unit_label.setText('un')
        self._update_total()
        self._refresh_action_buttons()

    def _update_cart_view(self):
        """Repinta el carrito visible con las líneas acumuladas."""
        # Limpiar
        while self._cart_layout.count():
            item = self._cart_layout.takeAt(0)
            w = item.widget()
            if w:
                w.setParent(None)
        if not self._lineas:
            self._cart_empty_lbl = QLabel('Aún no agregaste líneas a esta venta.')
            self._cart_empty_lbl.setAlignment(Qt.AlignCenter)
            self._cart_empty_lbl.setStyleSheet(
                f'color: {TEXT_DIM}; font-size: {_sx(12)}px; font-style: italic; padding: {_sx(12)}px;'
            )
            self._cart_layout.addWidget(self._cart_empty_lbl)
            self._cart_count.setText('0 items')
            return

        for i, l in enumerate(self._lineas):
            self._cart_layout.addWidget(self._build_cart_row(i, l))
        self._cart_count.setText(f"{len(self._lineas)} línea(s)")

    def _build_cart_row(self, idx: int, linea: Dict) -> QWidget:
        wrap = QFrame()
        wrap.setStyleSheet(f'QFrame {{ background: #fafaf7; border: 1px solid {SOFT_BORDER}; '
                            f'  border-radius: {_sx(8)}px; }}')
        h = QHBoxLayout(wrap)
        h.setContentsMargins(_sx(10), _sx(8), _sx(8), _sx(8))
        h.setSpacing(_sx(8))

        # Texto principal
        col = QVBoxLayout()
        col.setContentsMargins(0, 0, 0, 0)
        col.setSpacing(_sx(2))
        title = QLabel(f"{_fmt_qty(linea.get('qty'))} × {linea.get('node_name') or '—'}")
        title.setStyleSheet(
            f'color: {TEXT_DARK}; background: transparent; '
            f'font-size: {_sx(15)}px; font-weight: 700;'
        )
        title.setWordWrap(True)
        col.addWidget(title)

        sub_parts = []
        if linea.get('presentation_label'):
            sub_parts.append(linea['presentation_label'])
        if linea.get('descuento_etiqueta'):
            sub_parts.append(linea['descuento_etiqueta'])
        if sub_parts:
            sub = QLabel(' · '.join(sub_parts))
            sub.setStyleSheet(f'color: {TEXT_MUTED}; background: transparent; font-size: {_sx(13)}px;')
            col.addWidget(sub)
        h.addLayout(col, 1)

        # Subtotal
        amount = QLabel(_fmt_money(linea.get('subtotal')))
        amount.setStyleSheet(
            f'color: {ACCENT}; background: transparent; '
            f'font-family: "{_mono()}", monospace; '
            f'font-size: {_sx(16)}px; font-weight: 700;'
        )
        h.addWidget(amount, 0, Qt.AlignVCenter)

        # Quitar — botón grande y obvio (no se perdía pero quedaba muy chico
        # como para apretar en touch).
        rm = QPushButton('×')
        rm.setFixedSize(_sx(38), _sx(38))
        rm.setCursor(Qt.PointingHandCursor)
        rm.setFocusPolicy(Qt.NoFocus)
        rm.setFont(QFont(_ui_family(), _sp(20), QFont.Bold))
        rm.setToolTip('Quitar línea')
        rm.setStyleSheet(
            f'QPushButton {{ background: #fff0f0; color: {DANGER}; '
            f'  border: 1.5px solid #fca5a5; border-radius: {_sx(8)}px; font-weight: bold; }}'
            f'QPushButton:hover {{ background: #fde2e2; border-color: {DANGER}; }}'
            f'QPushButton:pressed {{ background: #fbcaca; }}'
        )
        rm.clicked.connect(lambda _=False, i=idx: self._on_remove_linea(i))
        h.addWidget(rm, 0, Qt.AlignVCenter)

        return wrap

    def _on_remove_linea(self, idx: int):
        if 0 <= idx < len(self._lineas):
            self._lineas.pop(idx)
            self._update_cart_view()
            self._update_total()
            self._refresh_action_buttons()

    def _on_confirm(self):
        # Auto-flush: si hay una selección pendiente sin agregar, la sumamos antes de cerrar
        pendiente = self._compute_linea_actual()
        if pendiente:
            self._lineas.append(pendiente)
        if not self._lineas:
            return
        total_final = sum((l.get('subtotal') or 0) for l in self._lineas)
        descuento_total = sum((l.get('descuento_monto') or 0) for l in self._lineas)
        self.result_data = {
            'lineas':          self._lineas,
            'total_final':     total_final,
            'descuento_total': descuento_total,
        }
        self.accept()

    # Atajos de teclado físicos
    def keyPressEvent(self, event: QKeyEvent):
        k = event.key()
        if k in (Qt.Key_Return, Qt.Key_Enter):
            if self._btn_ok.isEnabled():
                self._on_confirm()
                return
        if k == Qt.Key_Escape:
            self.reject()
            return
        text = event.text()
        if text and text in '0123456789':
            self._on_keypad(text)
            return
        if text == '.':
            self._on_keypad('.')
            return
        if k in (Qt.Key_Backspace, Qt.Key_Delete):
            self._on_keypad('⌫')
            return
        super().keyPressEvent(event)
