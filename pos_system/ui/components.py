"""
Reusable UI components for POS System
"""
from PyQt5.QtWidgets import (QMessageBox, QDialog, QVBoxLayout, QHBoxLayout, 
                              QLabel, QPushButton, QProgressBar, QFrame, QApplication)
from PyQt5.QtCore import Qt, QTimer, QPropertyAnimation, QEasingCurve, pyqtSignal, QPoint
from PyQt5.QtGui import QFont, QColor


class MessageBox:
    """Professional message boxes"""
    
    @staticmethod
    def success(parent, title: str, message: str):
        """Show success message"""
        msg = QMessageBox(parent)
        msg.setIcon(QMessageBox.Information)
        msg.setWindowTitle(title)
        msg.setText(message)
        msg.setStandardButtons(QMessageBox.Ok)
        msg.setDefaultButton(QMessageBox.Ok)
        return msg.exec_()
    
    @staticmethod
    def error(parent, title: str, message: str, details: str = None):
        """Show error message"""
        msg = QMessageBox(parent)
        msg.setIcon(QMessageBox.Critical)
        msg.setWindowTitle(title)
        msg.setText(message)
        if details:
            msg.setDetailedText(details)
        msg.setStandardButtons(QMessageBox.Ok)
        return msg.exec_()
    
    @staticmethod
    def warning(parent, title: str, message: str):
        """Show warning message"""
        msg = QMessageBox(parent)
        msg.setIcon(QMessageBox.Warning)
        msg.setWindowTitle(title)
        msg.setText(message)
        msg.setStandardButtons(QMessageBox.Ok)
        return msg.exec_()
    
    @staticmethod
    def confirm(parent, title: str, message: str) -> bool:
        """Show confirmation dialog"""
        msg = QMessageBox(parent)
        msg.setIcon(QMessageBox.Question)
        msg.setWindowTitle(title)
        msg.setText(message)
        msg.setStandardButtons(QMessageBox.Yes | QMessageBox.No)
        msg.setDefaultButton(QMessageBox.No)
        return msg.exec_() == QMessageBox.Yes


class PriceInput(QFrame):
    """
    Campo de precio profesional: vacío por defecto, fácil de tipear,
    selecciona todo al hacer foco, valida números positivos.

    Uso:
        inp = PriceInput(placeholder='0.00', prefix='$ ')
        inp.value()          → float
        inp.setValue(1500)   → muestra '1500.00'
        inp.clear_value()    → vuelve a vacío
    """
    from PyQt5.QtCore import pyqtSignal as _sig
    valueChanged = __import__('PyQt5.QtCore', fromlist=['pyqtSignal']).pyqtSignal(float)

    def __init__(self, parent=None, placeholder='Ingresar monto...', prefix='$ ', font_size=11):
        from PyQt5.QtWidgets import QLineEdit, QHBoxLayout
        from PyQt5.QtGui import QDoubleValidator, QFont
        from PyQt5.QtCore import Qt
        super().__init__(parent)
        self.setObjectName('priceInputFrame')
        self._prefix = prefix

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        self._edit = QLineEdit()
        self._edit.setPlaceholderText(placeholder)
        self._edit.setFont(QFont('Segoe UI', font_size))
        self._edit.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        self._edit.setMinimumHeight(36)

        # Solo acepta números decimales positivos
        validator = QDoubleValidator(0.0, 999999999.0, 2, self._edit)
        validator.setNotation(QDoubleValidator.StandardNotation)
        self._edit.setValidator(validator)

        # Estilo limpio
        self._edit.setStyleSheet(f"""
            QLineEdit {{
                border: 1px solid #dcd6c8;
                border-radius: 6px;
                padding: 4px 10px;
                font-size: {font_size}pt;
                background: white;
                color: #1c1c1e;
            }}
            QLineEdit:focus {{
                border: 2px solid #c1521f;
                background: #fbeee5;
            }}
            QLineEdit:hover {{
                border: 1px solid #c1521f;
            }}
        """)

        # Seleccionar todo al hacer foco (más cómodo para reemplazar)
        self._edit.focusInEvent = self._on_focus_in
        self._edit.textChanged.connect(self._on_text_changed)

        layout.addWidget(self._edit)
        self.setStyleSheet('QFrame#priceInputFrame { border: none; background: transparent; }')

    def _on_focus_in(self, event):
        from PyQt5.QtWidgets import QLineEdit
        QLineEdit.focusInEvent(self._edit, event)
        self._edit.selectAll()

    def _on_text_changed(self, text):
        try:
            self.valueChanged.emit(float(text) if text else 0.0)
        except ValueError:
            pass

    def value(self) -> float:
        """Retorna el valor como float (0.0 si está vacío)."""
        text = self._edit.text().strip()
        try:
            return float(text) if text else 0.0
        except ValueError:
            return 0.0

    def setValue(self, val):
        """Establece el valor. Si val es 0 o None, deja el campo vacío."""
        if val is None or val == 0 or val == 0.0:
            self._edit.clear()
        else:
            self._edit.setText(f'{float(val):.2f}')

    def clear_value(self):
        self._edit.clear()

    def setPlaceholderText(self, text):
        self._edit.setPlaceholderText(text)

    def setFont(self, font):
        self._edit.setFont(font)

    def setMinimumHeight(self, h):
        self._edit.setMinimumHeight(h)

    def setMinimumWidth(self, w):
        self._edit.setMinimumWidth(w)

    def setEnabled(self, enabled):
        super().setEnabled(enabled)
        self._edit.setEnabled(enabled)

    def setReadOnly(self, ro):
        self._edit.setReadOnly(ro)

    def setPrefix(self, prefix):
        """Compatibilidad con QDoubleSpinBox (ignorado visualmente, prefijo va en label externo)."""
        self._prefix = prefix

    def setMaximum(self, _):
        pass  # el validator ya limita a 999999999

    def setDecimals(self, _):
        pass

    def setMinimum(self, _):
        pass


class Toast(QFrame):
    """
    Toast notification profesional con tipos, animación fade y apilado automático.

    Tipos disponibles:
        'success'  → verde  OK (ej: sync exitoso)
        'error'    → rojo   (ej: fallo de conexión)
        'info'     → azul   ℹ  (ej: sincronizando...)
        'warning'  → naranja (ej: sin conexión)
    """

    # Registro global de toasts activos para apilarlos
    _active_toasts: list = []

    # Paleta de estilos por tipo
    _STYLES = {
        'success': {
            'icon': 'OK',
            'bg':   '#3d7a3a',
            'border': '#2f5e2c',
            'icon_bg': '#3d7a3a',
        },
        'error': {
            'icon': '',
            'bg':   '#a01616',
            'border': '#7f1212',
            'icon_bg': '#a01616',
        },
        'info': {
            'icon': '',
            'bg':   '#c1521f',
            'border': '#a3441a',
            'icon_bg': '#c1521f',
        },
        'warning': {
            'icon': '!',
            'bg':   '#a3441a',
            'border': '#7a3514',
            'icon_bg': '#a3441a',
        },
    }

    def __init__(self, parent, message: str, kind: str = 'info', duration: int = 3500):
        # Usar la ventana principal como padre para posicionamiento correcto
        top = parent.window() if parent else None
        super().__init__(top, Qt.FramelessWindowHint | Qt.Tool | Qt.WindowStaysOnTopHint)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_ShowWithoutActivating)
        self.setObjectName("toastFrame")

        style = self._STYLES.get(kind, self._STYLES['info'])

        # Layout externo (para el fondo translúcido con sombra simulada)
        outer = QHBoxLayout(self)
        outer.setContentsMargins(6, 6, 6, 6)

        # Contenedor interior
        inner = QFrame()
        inner.setObjectName("toastInner")
        inner.setStyleSheet(f"""
            QFrame#toastInner {{
                background-color: {style['bg']};
                border: 1px solid {style['border']};
                border-radius: 8px;
            }}
        """)
        inner_layout = QHBoxLayout(inner)
        inner_layout.setContentsMargins(0, 0, 14, 0)
        inner_layout.setSpacing(0)

        # Icono lateral
        icon_label = QLabel(style['icon'])
        icon_label.setFixedSize(42, 42)
        icon_label.setAlignment(Qt.AlignCenter)
        icon_label.setStyleSheet(f"""
            QLabel {{
                background-color: {style['icon_bg']};
                color: white;
                font-size: 18px;
                font-weight: bold;
                border-radius: 7px 0px 0px 7px;
            }}
        """)

        # Texto
        msg_label = QLabel(message)
        msg_label.setWordWrap(True)
        msg_label.setMaximumWidth(340)
        msg_label.setStyleSheet("""
            QLabel {
                color: white;
                font-size: 13px;
                font-weight: 500;
                background: transparent;
                padding: 0px;
            }
        """)
        msg_label.setFont(QFont('Segoe UI', 10))

        inner_layout.addWidget(icon_label)
        inner_layout.addSpacing(12)
        inner_layout.addWidget(msg_label)
        inner_layout.addStretch()
        outer.addWidget(inner)

        self.adjustSize()
        self.setMinimumWidth(300)

        # Registrar y posicionar
        Toast._active_toasts.append(self)
        self._reposition_all()

        # Animación fade-in
        self.setWindowOpacity(0.0)
        self._fade_in = QPropertyAnimation(self, b"windowOpacity")
        self._fade_in.setDuration(200)
        self._fade_in.setStartValue(0.0)
        self._fade_in.setEndValue(0.96)
        self._fade_in.setEasingCurve(QEasingCurve.OutCubic)

        # Timer para iniciar fade-out
        self._hide_timer = QTimer(self)
        self._hide_timer.setSingleShot(True)
        self._hide_timer.timeout.connect(self._start_fade_out)
        self._hide_timer.start(duration)

    def showEvent(self, event):
        super().showEvent(event)
        self._fade_in.start()

    def _start_fade_out(self):
        self._fade_out = QPropertyAnimation(self, b"windowOpacity")
        self._fade_out.setDuration(350)
        self._fade_out.setStartValue(0.96)
        self._fade_out.setEndValue(0.0)
        self._fade_out.setEasingCurve(QEasingCurve.InCubic)
        self._fade_out.finished.connect(self._cleanup)
        self._fade_out.start()

    def _cleanup(self):
        if self in Toast._active_toasts:
            Toast._active_toasts.remove(self)
        Toast._reposition_all_static()
        self.close()
        self.deleteLater()

    @classmethod
    def _reposition_all_static(cls):
        """Reposiciona todos los toasts activos tras cerrar uno."""
        parent_win = None
        for t in cls._active_toasts:
            parent_win = t.parent()
            break
        if not parent_win:
            return
        cls._reposition_from(parent_win)

    def _reposition_all(self):
        parent_win = self.parent()
        if not parent_win:
            return
        Toast._reposition_from(parent_win)

    @staticmethod
    def _reposition_from(parent_win):
        """Apila los toasts desde abajo hacia arriba, esquina inferior derecha."""
        rect = parent_win.geometry()
        margin_right  = 24
        margin_bottom = 56   # justo sobre la status bar
        gap = 10

        y_offset = rect.bottom() - margin_bottom
        for toast in reversed(Toast._active_toasts):
            toast.adjustSize()
            x = rect.right() - toast.width() - margin_right
            y = y_offset - toast.height()
            toast.move(x, y)
            y_offset = y - gap

    # ──────────────────────────────────────────────
    #  API pública
    # ──────────────────────────────────────────────

    @staticmethod
    def success(parent, message: str, duration: int = 3500):
        """Notificación de éxito (verde)."""
        t = Toast(parent, message, kind='success', duration=duration)
        t.show()
        return t

    @staticmethod
    def error(parent, message: str, duration: int = 5000):
        """Notificación de error (roja), más tiempo visible."""
        t = Toast(parent, message, kind='error', duration=duration)
        t.show()
        return t

    @staticmethod
    def info(parent, message: str, duration: int = 3000):
        """Notificación informativa (azul)."""
        t = Toast(parent, message, kind='info', duration=duration)
        t.show()
        return t

    @staticmethod
    def warning(parent, message: str, duration: int = 4000):
        """Notificación de advertencia (naranja)."""
        t = Toast(parent, message, kind='warning', duration=duration)
        t.show()
        return t

    @staticmethod
    def show_message(parent, message: str, duration: int = 3000):
        """Compatibilidad con código anterior."""
        return Toast.info(parent, message, duration=duration)


class LoadingDialog(QDialog):
    """Loading dialog with progress"""
    
    def __init__(self, parent, title: str = "Cargando...", message: str = "Por favor espere..."):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.setModal(True)
        self.setFixedSize(350, 120)
        
        layout = QVBoxLayout(self)
        layout.setSpacing(12)
        
        label = QLabel(message)
        label.setAlignment(Qt.AlignCenter)
        label.setFont(QFont('Segoe UI', 11))
        
        self.progress = QProgressBar()
        self.progress.setRange(0, 0)  # Indeterminate progress
        self.progress.setTextVisible(False)
        self.progress.setFixedHeight(6)
        
        layout.addWidget(label)
        layout.addWidget(self.progress)


class Card(QFrame):
    """Card widget for consistent styling"""
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("card")
        self.setStyleSheet("""
            QFrame#card {
                background-color: white;
                border: 1px solid #dcd6c8;
                border-radius: 8px;
                padding: 16px;
            }
        """)


class StatCard(QFrame):
    """Statistics card widget"""
    
    def __init__(self, title: str, value: str, icon: str = None, parent=None):
        super().__init__(parent)
        self.setObjectName("statCard")
        
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 16, 20, 16)
        layout.setSpacing(8)
        
        title_label = QLabel(title)
        title_label.setFont(QFont('Segoe UI', 10, QFont.Bold))
        title_label.setStyleSheet("color: #5a5448;")
        
        value_label = QLabel(value)
        value_label.setFont(QFont('Segoe UI', 24, QFont.Bold))
        value_label.setStyleSheet("color: #1c1c1e;")
        
        layout.addWidget(title_label)
        layout.addWidget(value_label)
        
        self.setStyleSheet("""
            QFrame#statCard {
                background-color: white;
                border: 1px solid #dcd6c8;
                border-radius: 8px;
            }
            QFrame#statCard:hover {
                border-color: #c1521f;
                background-color: #fafaf7;
            }
        """)
    
    def update_value(self, value: str):
        """Update the displayed value"""
        layout = self.layout()
        value_label = layout.itemAt(1).widget()
        value_label.setText(value)
