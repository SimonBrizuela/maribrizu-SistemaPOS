"""
theme.py — Tokens del tema Graphite cálido para el POS.

Uso típico:
    from theme import COLORS, FONTS, apply_theme

    app = QApplication(sys.argv)
    apply_theme(app)  # carga styles.qss + ajusta paleta y fuente

    # En widgets, para variantes:
    cobrar_btn.setProperty("variant", "accent")
    cobrar_btn.setProperty("size", "hero")
    cobrar_btn.style().unpolish(cobrar_btn)
    cobrar_btn.style().polish(cobrar_btn)

    monto_label.setProperty("role", "big")
    cuit_input.setProperty("role", "mono")
"""
from pathlib import Path

# ── Tokens de color ─────────────────────────────────────────────────
COLORS = {
    "bg":          "#f5f2ea",
    "surface":     "#ffffff",
    "surface_alt": "#fafaf7",
    "border":      "#dcd6c8",
    "border_soft": "#ece8df",
    "text":        "#1c1c1e",
    "text_muted":  "#6f6a5d",
    "text_dim":    "#9b958a",
    "accent":      "#c1521f",
    "accent_hover":"#a3441a",
    "accent_soft": "#fbeee5",
    "success":     "#3d7a3a",
    "success_bg":  "#e7f4ec",
    "warning":     "#b07020",
    "warning_bg":  "#fbeee5",
    "danger":      "#a01616",
    "danger_bg":   "#fbe5e5",
}

# ── Tipografía ──────────────────────────────────────────────────────
FONTS = {
    "ui":   '"Segoe UI", "Inter", system-ui, sans-serif',
    "mono": '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
}

SIZES = {
    "xs": 10,
    "sm": 11,
    "md": 12,
    "lg": 14,
    "xl": 18,
    "xxl": 22,
    "hero": 26,
}

RADII = {
    "sm": 6,
    "md": 8,
}


# ── Helpers ─────────────────────────────────────────────────────────
def load_qss(path: str | Path | None = None) -> str:
    """Lee el .qss del disco. Devuelve string vacío si no existe."""
    if path is None:
        path = Path(__file__).parent / "styles_graphite.qss"
    p = Path(path)
    if not p.exists():
        return ""
    return p.read_text(encoding="utf-8")


def apply_theme(app, qss_path: str | Path | None = None) -> None:
    """Aplica el tema Graphite a la app: stylesheet + paleta + fuente.

    Llamar una vez al iniciar, después de crear QApplication.
    """
    try:
        from PyQt6.QtGui import QFont, QPalette, QColor
        _IS_PYQT6 = True
    except ImportError:
        from PyQt5.QtGui import QFont, QPalette, QColor
        _IS_PYQT6 = False

    # Stylesheet
    qss = load_qss(qss_path)
    if qss:
        app.setStyleSheet(qss)

    # Fuente por defecto
    font = QFont("Segoe UI", 10)
    if _IS_PYQT6:
        font.setStyleHint(QFont.StyleHint.SansSerif)
        _R = QPalette.ColorRole
    else:
        font.setStyleHint(QFont.SansSerif)
        _R = QPalette
    app.setFont(font)

    # Paleta nativa (para diálogos del sistema, tooltips de Qt, etc.)
    pal = app.palette()
    pal.setColor(_R.Window,          QColor(COLORS["bg"]))
    pal.setColor(_R.WindowText,      QColor(COLORS["text"]))
    pal.setColor(_R.Base,            QColor(COLORS["surface"]))
    pal.setColor(_R.AlternateBase,   QColor(COLORS["surface_alt"]))
    pal.setColor(_R.Text,            QColor(COLORS["text"]))
    pal.setColor(_R.Button,          QColor(COLORS["surface"]))
    pal.setColor(_R.ButtonText,      QColor(COLORS["text"]))
    pal.setColor(_R.Highlight,       QColor(COLORS["accent_soft"]))
    pal.setColor(_R.HighlightedText, QColor(COLORS["text"]))
    pal.setColor(_R.PlaceholderText, QColor(COLORS["text_dim"]))
    app.setPalette(pal)

    # Locale español: traduce los botones standard de QMessageBox
    # (Yes/No → Sí/No, Cancel → Cancelar, OK queda igual, etc.)
    try:
        if _IS_PYQT6:
            from PyQt6.QtCore import QTranslator, QLibraryInfo, QLocale
            qm_path = QLibraryInfo.path(QLibraryInfo.LibraryPath.TranslationsPath)
        else:
            from PyQt5.QtCore import QTranslator, QLibraryInfo, QLocale
            qm_path = QLibraryInfo.location(QLibraryInfo.TranslationsPath)
        QLocale.setDefault(QLocale(QLocale.Spanish, QLocale.Argentina))
        translator = QTranslator(app)
        if translator.load("qtbase_es", qm_path):
            app.installTranslator(translator)
        # Guardar referencia para evitar GC
        app._graphite_translator = translator
    except Exception:
        pass


def repolish(widget) -> None:
    """Re-aplica QSS a un widget tras cambiar una property dinámica.

    Necesario cuando cambias setProperty('variant', ...) en runtime —
    Qt no reaplica el stylesheet automáticamente.
    """
    widget.style().unpolish(widget)
    widget.style().polish(widget)
    widget.update()


def set_variant(widget, variant: str) -> None:
    """Atajo: marca un botón como primary / accent / danger."""
    widget.setProperty("variant", variant)
    repolish(widget)


def set_role(widget, role: str) -> None:
    """Atajo: marca un label/input como title / mono / big / muted / flabel."""
    widget.setProperty("role", role)
    repolish(widget)


def set_badge(label, kind: str) -> None:
    """Convierte un QLabel en un badge: 'ok' | 'warn' | 'danger'."""
    label.setProperty("badge", kind)
    repolish(label)
