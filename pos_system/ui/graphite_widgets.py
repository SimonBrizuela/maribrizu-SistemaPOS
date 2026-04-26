"""
widgets.py — Componentes reutilizables del tema Graphite.

Pensado para PyQt6, compatible con PyQt5 (importa con fallback).
Todos los widgets se estilan vía dynamic properties — el lookbook está en styles.qss.
"""
try:
    from PyQt6.QtWidgets import (
        QWidget, QFrame, QLabel, QPushButton, QHBoxLayout, QVBoxLayout,
        QGridLayout, QSizePolicy, QLineEdit, QButtonGroup,
    )
    from PyQt6.QtCore import Qt, pyqtSignal
except ImportError:
    from PyQt5.QtWidgets import (
        QWidget, QFrame, QLabel, QPushButton, QHBoxLayout, QVBoxLayout,
        QGridLayout, QSizePolicy, QLineEdit, QButtonGroup,
    )
    from PyQt5.QtCore import Qt, pyqtSignal

from pos_system.ui.theme import set_variant, set_role, repolish, COLORS


# ── Card: contenedor blanco con borde y radius ─────────────────────
class Card(QFrame):
    """Contenedor estilo tarjeta. Variantes: 'card', 'card-alt', 'card-accent'."""
    def __init__(self, variant: str = "card", parent=None):
        super().__init__(parent)
        self.setProperty("role", variant)
        self.setFrameShape(QFrame.Shape.NoFrame)
        self._layout = QVBoxLayout(self)
        self._layout.setContentsMargins(12, 12, 12, 12)
        self._layout.setSpacing(8)

    def add(self, widget):
        self._layout.addWidget(widget)
        return widget

    def add_layout(self, lay):
        self._layout.addLayout(lay)
        return lay


# ── FieldLabel: etiqueta uppercase pequeña sobre un input ──────────
class FieldLabel(QLabel):
    def __init__(self, text: str, parent=None):
        super().__init__(text, parent)
        set_role(self, "flabel")


# ── Field: FieldLabel + widget en columna ──────────────────────────
class Field(QWidget):
    def __init__(self, label: str, widget: QWidget, parent=None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(5)
        lay.addWidget(FieldLabel(label))
        lay.addWidget(widget)
        self.input = widget


# ── DialogHeader: título grande + subtítulo mono + botón cerrar ────
class DialogHeader(QWidget):
    closeRequested = pyqtSignal()

    def __init__(self, title: str, subtitle: str = "", show_close: bool = True, parent=None):
        super().__init__(parent)
        self.setObjectName("dialogHeader")
        self.setStyleSheet(
            f"#dialogHeader {{ background: {COLORS['surface']};"
            f" border-bottom: 1px solid {COLORS['border_soft']}; }}"
        )
        outer = QHBoxLayout(self)
        outer.setContentsMargins(18, 14, 14, 14)
        outer.setSpacing(12)

        col = QVBoxLayout()
        col.setSpacing(2)
        title_lbl = QLabel(title)
        set_role(title_lbl, "title")
        col.addWidget(title_lbl)
        if subtitle:
            sub_lbl = QLabel(subtitle)
            set_role(sub_lbl, "muted")
            sub_lbl.setStyleSheet(
                f"font-family: 'JetBrains Mono', Consolas, monospace;"
                f" font-size: 11px; color: {COLORS['text_muted']};"
            )
            col.addWidget(sub_lbl)
        outer.addLayout(col, 1)

        if show_close:
            close = QPushButton("×")
            close.setFlat(True)
            close.setFixedSize(28, 28)
            close.setStyleSheet(
                f"QPushButton {{ background: {COLORS['surface_alt']};"
                f" border: 1px solid {COLORS['border_soft']};"
                f" border-radius: 14px; color: {COLORS['text_muted']};"
                f" font-size: 16px; font-weight: 700; }}"
                f"QPushButton:hover {{ background: {COLORS['border_soft']}; }}"
            )
            close.clicked.connect(self.closeRequested.emit)
            outer.addWidget(close)


# ── DialogFooter: barra inferior con botones a la derecha ──────────
class DialogFooter(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("dialogFooter")
        self.setStyleSheet(
            f"#dialogFooter {{ background: {COLORS['surface']};"
            f" border-top: 1px solid {COLORS['border_soft']}; }}"
        )
        self._lay = QHBoxLayout(self)
        self._lay.setContentsMargins(12, 12, 12, 12)
        self._lay.setSpacing(8)
        self._lay.addStretch(1)

    def add_left(self, widget):
        # Inserta antes del stretch
        self._lay.insertWidget(self._lay.count() - 1 - self._right_count(), widget)
        return widget

    def _right_count(self):
        # cuenta widgets a la derecha del stretch (los que ya agregó add_right)
        # se llama internamente; mantener simple: contar todos los QWidget después del stretch
        c = 0
        for i in range(self._lay.count()):
            it = self._lay.itemAt(i)
            if it.widget() is not None and i > self._stretch_index():
                c += 1
        return c

    def _stretch_index(self):
        for i in range(self._lay.count()):
            if self._lay.itemAt(i).spacerItem() is not None:
                return i
        return -1

    def add_right(self, widget):
        self._lay.addWidget(widget)
        return widget


# ── PrimaryButton / AccentButton / DangerButton ────────────────────
def PrimaryButton(text: str) -> QPushButton:
    b = QPushButton(text)
    set_variant(b, "primary")
    return b


def AccentButton(text: str, hero: bool = False) -> QPushButton:
    b = QPushButton(text)
    set_variant(b, "accent")
    if hero:
        b.setProperty("size", "hero")
        repolish(b)
    return b


def DangerButton(text: str) -> QPushButton:
    b = QPushButton(text)
    set_variant(b, "danger")
    return b


def SecondaryButton(text: str) -> QPushButton:
    return QPushButton(text)


# ── PillRow: fila de píldoras seleccionables (segmented control) ───
class PillRow(QWidget):
    """Row de botones tipo segmented control. Emite changed(index, value)."""
    changed = pyqtSignal(int, str)

    def __init__(self, options: list[str], default: int = 0, parent=None):
        super().__init__(parent)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(6)
        self._group = QButtonGroup(self)
        self._group.setExclusive(True)
        self._buttons: list[QPushButton] = []
        self._values = list(options)
        for i, opt in enumerate(options):
            b = QPushButton(opt)
            b.setCheckable(True)
            self._style_pill(b, i == default)
            b.clicked.connect(lambda _checked, idx=i: self._on_click(idx))
            self._group.addButton(b, i)
            self._buttons.append(b)
            lay.addWidget(b)
        lay.addStretch(1)
        self._current = default

    def _style_pill(self, b: QPushButton, active: bool):
        if active:
            b.setStyleSheet(
                f"QPushButton {{ background: {COLORS['text']}; color: white;"
                f" border: 1px solid {COLORS['text']}; border-radius: 6px;"
                f" padding: 7px 14px; font-size: 12px; font-weight: 600; }}"
            )
        else:
            b.setStyleSheet(
                f"QPushButton {{ background: {COLORS['surface']}; color: {COLORS['text_muted']};"
                f" border: 1px solid {COLORS['border']}; border-radius: 6px;"
                f" padding: 7px 14px; font-size: 12px; font-weight: 600; }}"
                f"QPushButton:hover {{ color: {COLORS['text']}; }}"
            )

    def _on_click(self, idx: int):
        for i, b in enumerate(self._buttons):
            self._style_pill(b, i == idx)
        self._current = idx
        self.changed.emit(idx, self._values[idx])

    def value(self) -> str:
        return self._values[self._current]

    def index(self) -> int:
        return self._current

    def set_index(self, idx: int):
        self._on_click(idx)


# ── KVRow: fila de "label: valor mono" (para resúmenes) ────────────
class KVRow(QWidget):
    def __init__(self, label: str, value: str, big: bool = False, accent: bool = False, parent=None):
        super().__init__(parent)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        l = QLabel(label)
        l.setStyleSheet(f"color: {COLORS['text_muted']}; font-size: 12px;")
        v = QLabel(value)
        color = COLORS["accent"] if accent else COLORS["text"]
        size = "fontSize: 18px;" if big else "fontSize: 12px;"
        v.setStyleSheet(
            f"color: {color}; {size} font-weight: 700;"
            f" font-family: 'JetBrains Mono', Consolas, monospace;"
        )
        v.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        lay.addWidget(l)
        lay.addStretch(1)
        lay.addWidget(v)
        self.value_label = v

    def set_value(self, text: str):
        self.value_label.setText(text)


# ── Badge: pequeño label con fondo de estado ───────────────────────
def Badge(text: str, kind: str = "ok") -> QLabel:
    """kind: 'ok' | 'warn' | 'danger'"""
    lbl = QLabel(text)
    lbl.setProperty("badge", kind)
    repolish(lbl)
    lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
    return lbl


# ── BigInput: QLineEdit grande mono (para montos) ──────────────────
def BigInput(text: str = "") -> QLineEdit:
    le = QLineEdit(text)
    set_role(le, "big")
    return le


def MonoInput(text: str = "") -> QLineEdit:
    le = QLineEdit(text)
    set_role(le, "mono")
    return le


# ── BaseDialog: shell vertical (header + body + footer) ────────────
try:
    from PyQt6.QtWidgets import QDialog
except ImportError:
    from PyQt5.QtWidgets import QDialog


class BaseDialog(QDialog):
    """Dialog con la estructura visual del tema:
        header (DialogHeader)
        body   (QVBoxLayout dentro de QFrame con fondo bg)
        footer (DialogFooter)

    Usar self.body_layout para agregar contenido al cuerpo.
    """
    def __init__(self, title: str, subtitle: str = "", show_close: bool = True, parent=None):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.setStyleSheet(
            f"QDialog {{ background: {COLORS['surface']};"
            f" border: 1px solid {COLORS['border']}; border-radius: 8px; }}"
        )
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        self.header = DialogHeader(title, subtitle, show_close)
        self.header.closeRequested.connect(self.reject)
        outer.addWidget(self.header)

        body_frame = QFrame()
        body_frame.setStyleSheet(f"background: {COLORS['bg']};")
        self.body_layout = QVBoxLayout(body_frame)
        self.body_layout.setContentsMargins(16, 16, 16, 16)
        self.body_layout.setSpacing(12)
        outer.addWidget(body_frame, 1)

        self.footer = DialogFooter()
        outer.addWidget(self.footer)
