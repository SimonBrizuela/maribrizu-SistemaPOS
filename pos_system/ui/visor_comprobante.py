"""
El comprobante de transferencia que subió el cliente, visto desde la caja.

Antes se abría en el navegador y había que achicarlo o agrandarlo a mano. Acá
se ve entero al abrir, con zoom (rueda del mouse o botones), arrastrar para
moverse, girar las fotos que vienen de costado y un botón para abrirlo en el
navegador si hace falta. Los PDF van directo al navegador, que ya los muestra
con zoom.
"""
from PyQt5.QtCore import QRectF, Qt, QUrl
from PyQt5.QtGui import QDesktopServices, QImage, QPainter, QPixmap, QTransform
from PyQt5.QtWidgets import (
    QApplication, QDialog, QGraphicsPixmapItem, QGraphicsScene, QGraphicsView, QHBoxLayout, QLabel,
    QPushButton, QVBoxLayout,
)

from pos_system.ui.theme import COLORS as _T

ZOOM_MIN, ZOOM_MAX, PASO = 0.05, 8.0, 1.25
TOPE_BYTES = 15 * 1024 * 1024


def imagen_de_bytes(datos):
    """QImage del archivo bajado, o None si no es una imagen que Qt entienda."""
    if not datos or len(datos) > TOPE_BYTES:
        return None
    imagen = QImage()
    return imagen if imagen.loadFromData(bytes(datos)) and not imagen.isNull() else None


class _Lienzo(QGraphicsView):
    def __init__(self, visor):
        super().__init__()
        self._visor = visor
        self.setRenderHints(QPainter.Antialiasing | QPainter.SmoothPixmapTransform)
        self.setDragMode(QGraphicsView.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.AnchorViewCenter)
        self.setStyleSheet(f"QGraphicsView {{ background:{_T['bg']}; border:none; }}")

    def wheelEvent(self, event):
        paso = event.angleDelta().y()
        if paso:
            self._visor.zoom_por(PASO if paso > 0 else 1 / PASO)
        event.accept()

    def mouseDoubleClickEvent(self, event):
        self._visor.alternar_ajuste()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        if self._visor.ajustado:
            self._visor.ajustar()


class VisorComprobante(QDialog):
    def __init__(self, imagen, titulo='Comprobante', url='', parent=None):
        super().__init__(parent)
        self.setWindowTitle(titulo)
        self._url = url
        self._zoom = 1.0
        self._giro = 0
        self.ajustado = True
        self.setStyleSheet(f"QDialog {{ background:{_T['surface']}; }}")

        v = QVBoxLayout(self)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)

        barra = QHBoxLayout()
        barra.setContentsMargins(14, 10, 14, 10)
        barra.setSpacing(8)
        nombre = QLabel(titulo)
        nombre.setStyleSheet(f"color:{_T['text']}; font-size:15px; font-weight:800; background:transparent;")
        barra.addWidget(nombre)
        barra.addStretch(1)
        self._menos = self._boton('−', 'Alejar (rueda del mouse)')
        self._menos.clicked.connect(lambda: self.zoom_por(1 / PASO))
        self._porcentaje = QLabel('100%')
        self._porcentaje.setMinimumWidth(48)
        self._porcentaje.setAlignment(Qt.AlignCenter)
        self._porcentaje.setStyleSheet(f"color:{_T['text_muted']}; font-size:12px; font-weight:700;"
                                       " background:transparent;")
        self._mas = self._boton('+', 'Acercar (rueda del mouse)')
        self._mas.clicked.connect(lambda: self.zoom_por(PASO))
        self._ajustar = self._boton('Ajustar', 'Ver el comprobante entero')
        self._ajustar.clicked.connect(self.ajustar)
        self._real = self._boton('100%', 'Tamaño real')
        self._real.clicked.connect(lambda: self.poner_zoom(1.0))
        self._girar = self._boton('Girar', 'Girar 90°')
        self._girar.clicked.connect(self.girar)
        for b in (self._menos, self._porcentaje, self._mas, self._ajustar, self._real, self._girar):
            barra.addWidget(b)
        if url:
            navegador = self._boton('Abrir en el navegador', '')
            navegador.clicked.connect(lambda: QDesktopServices.openUrl(QUrl(self._url)))
            barra.addWidget(navegador)
        cerrar = self._boton('Cerrar', '', principal=True)
        cerrar.clicked.connect(self.accept)
        barra.addWidget(cerrar)
        v.addLayout(barra)

        self._escena = QGraphicsScene(self)
        self._item = QGraphicsPixmapItem(QPixmap.fromImage(imagen))
        self._item.setTransformationMode(Qt.SmoothTransformation)
        self._escena.addItem(self._item)
        self._lienzo = _Lienzo(self)
        self._lienzo.setScene(self._escena)
        v.addWidget(self._lienzo, 1)

        pista = QLabel('Rueda del mouse: zoom · arrastrar: mover · doble clic: entero / tamaño real')
        pista.setAlignment(Qt.AlignCenter)
        pista.setStyleSheet(f"color:{_T['text_dim']}; font-size:11px; padding:6px; background:{_T['surface']};")
        v.addWidget(pista)

        pantalla = QApplication.primaryScreen().availableGeometry()
        self.resize(max(640, int(pantalla.width() * 0.7)), max(520, int(pantalla.height() * 0.85)))

    def _boton(self, texto, ayuda, principal=False):
        b = QPushButton(texto)
        b.setCursor(Qt.PointingHandCursor)
        if ayuda:
            b.setToolTip(ayuda)
        if principal:
            estilo = (f"QPushButton {{ background:{_T['accent']}; color:white; border:none; border-radius:7px;"
                      f" padding:6px 16px; min-height:18px; font-size:13px; font-weight:800; }}"
                      f" QPushButton:hover {{ background:{_T['accent_hover']}; }}")
        else:
            estilo = (f"QPushButton {{ background:{_T['surface']}; color:{_T['text']}; border:1px solid {_T['border']};"
                      f" border-radius:7px; padding:6px 12px; min-height:18px; font-size:13px; font-weight:700; }}"
                      f" QPushButton:hover {{ background:{_T['surface_alt']}; }}")
        b.setStyleSheet(estilo)
        return b

    # ── Zoom ────────────────────────────────────────────────────────────────
    def showEvent(self, event):
        super().showEvent(event)
        self.ajustar()

    def zoom(self):
        return self._zoom

    def poner_zoom(self, factor, ajustado=False):
        self._zoom = max(ZOOM_MIN, min(ZOOM_MAX, factor))
        self.ajustado = ajustado
        self._lienzo.setTransform(QTransform().rotate(self._giro).scale(self._zoom, self._zoom))
        self._porcentaje.setText(f'{round(self._zoom * 100)}%')
        self._menos.setEnabled(self._zoom > ZOOM_MIN)
        self._mas.setEnabled(self._zoom < ZOOM_MAX)

    def zoom_por(self, factor):
        self.poner_zoom(self._zoom * factor)

    def ajustar(self):
        """Todo el comprobante a la vista, sin agrandarlo más que su tamaño."""
        self._escena.setSceneRect(QRectF(self._item.boundingRect()))
        # El giro es de la vista: para ver cuánto ocupa se mide ya girado.
        rect = QTransform().rotate(self._giro).mapRect(self._item.boundingRect())
        vista = self._lienzo.viewport().rect()
        if rect.width() <= 0 or rect.height() <= 0 or vista.width() <= 0:
            return
        factor = min((vista.width() - 16) / rect.width(), (vista.height() - 16) / rect.height(), 1.0)
        self.poner_zoom(factor, ajustado=True)
        self._lienzo.centerOn(self._item)

    def alternar_ajuste(self):
        if self.ajustado:
            self.poner_zoom(1.0)
        else:
            self.ajustar()

    def girar(self):
        self._giro = (self._giro + 90) % 360
        self.ajustar()
