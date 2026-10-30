"""
Piezas de pantalla de "traer la venta de otra caja".

  OtrasCajasCard      tarjeta del costado, debajo de PENDIENTES: las ventas
                      abiertas en las otras cajas (nombre, ítems, total, cajero).
  CarritoAjenoDialog  vista previa de una de esas ventas, con "Traer a esta
                      caja". Se actualiza sola si allá siguen cargando.
  AvisoVenta          franja de una línea arriba del carrito ("La venta pasó a
                      la Compu 3", "Pidiendo la venta a la Compu 1…"). Se va
                      sola a los 4 s o con un toque; si llega otra, reemplaza
                      el texto: nunca hay dos.
  NombreCajaDialog    el admin le pone nombre a la caja.

Mismo estilo que la tarjeta PENDIENTES y su vista previa (sales_view): blanco,
borde beige, naranja lleno para la acción, beige #e5dcc8 para lo secundario.
El alto y la letra van en el stylesheet de cada widget: el QSS global del POS
le gana a setMinimumHeight/setFont.
"""
from typing import Callable, Dict, List, Optional

from PyQt5.QtCore import Qt, QTimer, pyqtSignal
from PyQt5.QtWidgets import (QAbstractItemView, QDialog, QFrame, QGridLayout,
                             QHBoxLayout, QHeaderView, QLabel, QLineEdit,
                             QPushButton, QTableWidget, QTableWidgetItem,
                             QVBoxLayout)

from pos_system.models import carrito_vivo as reglas
from pos_system.ui.theme import COLORS as _T

BEIGE = '#e5dcc8'
BEIGE_HOVER = '#d7cab2'
MONO = "'JetBrains Mono', Consolas, monospace"


def fmt_money(n) -> str:
    n = float(n or 0)
    if round(n, 2) == int(round(n, 2)):
        return f"{int(round(n)):,}"
    return f"{n:,.2f}"


def fmt_qty(q) -> str:
    q = float(q or 0)
    if q == int(q):
        return str(int(q))
    return f"{q:.2f}".rstrip('0').rstrip('.')


def texto_items(cantidad) -> str:
    c = float(cantidad or 0)
    return f"{fmt_qty(c)} ítem{'s' if c != 1 else ''}"


def hace_cuanto(segundos: Optional[float]) -> str:
    if segundos is None:
        return ''
    s = int(segundos)
    if s < 10:
        return 'recién'
    if s < 60:
        return f'hace {s} s'
    return f'hace {s // 60} min'


def _lbl(texto, css):
    w = QLabel(texto)
    w.setStyleSheet(f"{css} background:transparent; border:none;")
    return w


def _lbl_ajustado(texto, css):
    w = _lbl(texto, css)
    w.setWordWrap(True)
    return w


def boton_principal(texto, alto=48):
    b = QPushButton(texto)
    b.setCursor(Qt.PointingHandCursor)
    b.setStyleSheet(
        f"QPushButton {{ background:{_T['accent']}; color:white; border:none;"
        f" border-radius:8px; font-size:14px; font-weight:700; padding:0 20px;"
        f" min-height:{alto}px; }}"
        f"QPushButton:hover {{ background:{_T['accent_hover']}; }}"
        f"QPushButton:disabled {{ background:#c9c2b3; color:white; }}"
    )
    return b


def boton_secundario(texto, alto=48):
    b = QPushButton(texto)
    b.setCursor(Qt.PointingHandCursor)
    b.setStyleSheet(
        f"QPushButton {{ background:{BEIGE}; color:{_T['text']}; border:none;"
        f" border-radius:8px; font-size:13px; font-weight:600; padding:0 18px;"
        f" min-height:{alto}px; }}"
        f"QPushButton:hover {{ background:{BEIGE_HOVER}; }}"
    )
    return b


# ════════════════════════════════════════════════════════════════════════════
class OtrasCajasCard(QFrame):
    """Tarjeta del costado con las ventas abiertas en las otras cajas."""
    elegida = pyqtSignal(str)   # pc_id

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName('vivosCard')
        self.setStyleSheet(
            f"QFrame#vivosCard {{ background:{_T['surface']}; border:1px solid {_T['border']};"
            f" border-radius:8px; }}"
        )
        self._filas: List[QFrame] = []
        v = QVBoxLayout(self)
        v.setContentsMargins(12, 10, 12, 10)
        v.setSpacing(6)

        hl = QHBoxLayout()
        hl.setContentsMargins(0, 0, 0, 0)
        hl.setSpacing(6)
        self._titulo = _lbl('EN OTRAS CAJAS',
                            f"color:{_T['text_muted']}; font-size:10px; font-weight:700; letter-spacing:0.5px;")
        hl.addWidget(self._titulo)
        self._contador = QLabel('0')
        self._contador.setAlignment(Qt.AlignCenter)
        self._contador.setFixedHeight(16)
        self._contador.setMinimumWidth(16)
        self._contador.setStyleSheet(
            f"background:{_T['accent']}; color:white; border-radius:8px;"
            f" font-size:10px; font-weight:700; padding:0 5px;"
        )
        self._contador.setVisible(False)
        hl.addWidget(self._contador)
        hl.addStretch(1)
        v.addLayout(hl)

        self._lista = QVBoxLayout()
        self._lista.setContentsMargins(0, 2, 0, 0)
        self._lista.setSpacing(6)
        v.addLayout(self._lista)
        self.mostrar([], None, conectado=False)

    def mostrar(self, carritos: List[Dict], en_linea: Optional[bool], conectado: bool = True):
        # Llega una noticia por cada cambio de cualquier caja: si lo que se ve
        # no cambió, no se rearma (un toque sobre una fila no se pierde).
        firma = (conectado, en_linea is False, tuple(
            (c.get('pc_id'), c.get('nombre'), c.get('total'), c.get('cantidad'),
             c.get('cajero'), bool(c.get('cobrando'))) for c in carritos or []))
        if firma == getattr(self, '_firma', None):
            return
        self._firma = firma
        while self._lista.count():
            item = self._lista.takeAt(0)
            w = item.widget()
            if w is not None:
                w.deleteLater()
        self._filas = []
        n = len(carritos or [])
        self._contador.setText(str(n))
        self._contador.setVisible(n > 0)
        self._titulo.setStyleSheet(
            f"color:{_T['accent'] if n else _T['text_muted']}; font-size:10px; font-weight:700;"
            f" letter-spacing:0.5px; background:transparent; border:none;"
        )
        if not conectado or en_linea is False:
            self._lista.addWidget(_lbl_ajustado(
                'Sin conexión: no se ven las otras cajas' if conectado else 'Sin conexión con la nube',
                f"color:{_T['warning']}; font-size:11px; padding:4px 2px;"))
            return
        if n == 0:
            self._lista.addWidget(_lbl_ajustado(
                'Ninguna otra caja tiene una venta abierta',
                f"color:{_T['text_dim']}; font-size:11px; font-style:italic; padding:4px 2px;"))
            return
        for c in carritos:
            self._lista.addWidget(self._fila(c))

    def _fila(self, c: Dict) -> QFrame:
        w = QFrame()
        w.setObjectName('vivoRow')
        w.setCursor(Qt.PointingHandCursor)
        cobrando = bool(c.get('cobrando'))
        w.setStyleSheet(
            f"QFrame#vivoRow {{ background:{_T['surface_alt']}; border:1px solid {_T['border']};"
            f" border-radius:6px; }}"
            f"QFrame#vivoRow:hover {{ border-color:{_T['accent']}; background:{_T['accent_soft']}; }}"
        )
        wl = QVBoxLayout(w)
        wl.setContentsMargins(8, 7, 8, 7)
        wl.setSpacing(2)
        top = QHBoxLayout()
        top.setContentsMargins(0, 0, 0, 0)
        top.setSpacing(4)
        top.addWidget(_lbl(str(c.get('nombre') or 'Otra caja')[:16],
                           f"color:{_T['text']}; font-size:12px; font-weight:700;"))
        top.addStretch(1)
        top.addWidget(_lbl(f"${fmt_money(c.get('total'))}",
                           f"color:{_T['accent']}; font-size:12px; font-weight:700; font-family:{MONO};"))
        wl.addLayout(top)
        cajero = str(c.get('cajero') or '').strip()
        sub = texto_items(c.get('cantidad')) + (f"  ·  {cajero[:14]}" if cajero else '')
        if cobrando:
            sub = 'Cobrando ahora'
        wl.addWidget(_lbl(sub, f"color:{_T['warning'] if cobrando else _T['text_muted']}; font-size:10px;"))
        pc_id = str(c.get('pc_id') or '')
        w.mousePressEvent = lambda _e, _p=pc_id: self.elegida.emit(_p)
        self._filas.append(w)
        return w


# ════════════════════════════════════════════════════════════════════════════
class CarritoAjenoDialog(QDialog):
    """Vista previa de la venta abierta en otra caja.

    `bloqueo(doc)` devuelve por qué no se puede traer ahora ('' si se puede): lo
    calcula la pantalla de Ventas (carrito propio con productos, sin conexión,
    productos que esta caja no tiene). `action` queda en 'traer' al aceptar.
    """

    def __init__(self, parent, pc_id: str, doc: Dict, bloqueo: Callable[[Optional[Dict]], str],
                 ahora: Callable[[], object] = None):
        super().__init__(parent)
        self.action = None
        self.pc_id = pc_id
        self.doc = doc
        self._bloqueo = bloqueo
        self._ahora = ahora
        self._nombre = reglas.nombre_de_caja(doc, pc_id)

        self.setWindowTitle(f'Venta abierta en la {self._nombre}')
        self.setModal(True)
        self.setMinimumWidth(560)
        self.setStyleSheet(f"QDialog {{ background:{_T['bg']}; }}")

        v = QVBoxLayout(self)
        v.setContentsMargins(18, 16, 18, 16)
        v.setSpacing(10)

        self._cabeza = _lbl('', f"color:{_T['text']}; font-size:15px;")
        self._cabeza.setTextFormat(Qt.RichText)
        v.addWidget(self._cabeza)
        self._sub = _lbl('', f"color:{_T['text_muted']}; font-size:11px;")
        v.addWidget(self._sub)

        self._tabla = QTableWidget()
        t = self._tabla
        t.setColumnCount(4)
        t.setHorizontalHeaderLabels(['Producto', 'Cant.', 'P. Unit.', 'Subtotal'])
        t.verticalHeader().setVisible(False)
        t.setEditTriggers(QTableWidget.NoEditTriggers)
        t.setSelectionMode(QAbstractItemView.NoSelection)
        t.setFocusPolicy(Qt.NoFocus)
        hh = t.horizontalHeader()
        hh.setSectionResizeMode(0, QHeaderView.Stretch)
        for col, ancho in ((1, 60), (2, 100), (3, 110)):
            hh.setSectionResizeMode(col, QHeaderView.Fixed)
            t.setColumnWidth(col, ancho)
        t.setMinimumHeight(180)
        t.setMaximumHeight(300)
        t.setStyleSheet(
            f"QTableWidget {{ border:1px solid {_T['border']}; border-radius:6px;"
            f" background:{_T['surface']}; font-size:13px; }}"
            f"QHeaderView::section {{ background:{_T['surface_alt']}; color:{_T['text_muted']};"
            f" padding:6px 8px; border:none; border-bottom:1px solid {_T['border']};"
            f" font-size:10px; font-weight:700; text-transform:uppercase; }}"
        )
        v.addWidget(t)

        self._extras = _lbl('', f"color:{_T['text_muted']}; font-size:12px;")
        self._extras.setWordWrap(True)
        v.addWidget(self._extras)

        trow = QHBoxLayout()
        trow.setContentsMargins(2, 0, 2, 0)
        trow.addStretch(1)
        trow.addWidget(_lbl('TOTAL', f"color:{_T['text_muted']}; font-size:10px; font-weight:700;"
                                     f" letter-spacing:0.6px;"))
        self._total = _lbl('', f"color:{_T['text']}; font-size:24px; font-weight:700;"
                               f" margin-left:10px; font-family:{MONO};")
        trow.addWidget(self._total)
        v.addLayout(trow)

        self._motivo = QLabel('')
        self._motivo.setWordWrap(True)
        self._motivo.setStyleSheet(
            f"QLabel {{ background:{_T['warning_bg']}; border:1px solid {_T['warning']};"
            f" border-radius:6px; padding:8px 10px; color:{_T['warning']}; font-size:12px;"
            f" font-weight:600; }}"
        )
        v.addWidget(self._motivo)

        btns = QHBoxLayout()
        btns.setSpacing(10)
        cerrar = boton_secundario('Cerrar')
        cerrar.setMinimumWidth(130)
        cerrar.clicked.connect(self.reject)
        btns.addWidget(cerrar)
        btns.addStretch(1)
        self._traer = boton_principal('Traer a esta caja', alto=52)
        self._traer.setMinimumWidth(230)
        self._traer.setDefault(True)
        self._traer.clicked.connect(self._on_traer)
        btns.addWidget(self._traer)
        v.addLayout(btns)

        self.actualizar(doc)

    def actualizar(self, doc: Optional[Dict]):
        """Nueva versión del documento de esa caja (o None si ya no está)."""
        if doc is not None and not reglas.tiene_venta(doc):
            doc = None
        if doc is not None:
            self.doc = doc
        d = self.doc or {}
        cajero = str(d.get('cajero') or '').strip() or 'sin nombre'
        self._cabeza.setText(f"<b>{self._nombre}</b> &nbsp;·&nbsp; la empezó <b>{cajero}</b>")
        sub = texto_items(d.get('cantidad'))
        if self._ahora is not None:
            cuando = hace_cuanto(reglas.segundos_sin_noticias(d, self._ahora()))
            if cuando:
                sub += f"  ·  actualizada {cuando}"
        self._sub.setText(sub)

        items = reglas.leer_items(d.get('items_json'))
        self._tabla.setRowCount(len(items))
        for r, it in enumerate(items):
            nombre = QTableWidgetItem(str(it.get('product_name', '')))
            nombre.setToolTip(str(it.get('product_name', '')))
            self._tabla.setItem(r, 0, nombre)
            cant = QTableWidgetItem(fmt_qty(it.get('quantity', 0)))
            cant.setTextAlignment(Qt.AlignCenter)
            self._tabla.setItem(r, 1, cant)
            pu = QTableWidgetItem(f"${fmt_money(it.get('unit_price', 0))}")
            pu.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            self._tabla.setItem(r, 2, pu)
            st = QTableWidgetItem(f"${fmt_money(it.get('subtotal', 0))}")
            st.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            self._tabla.setItem(r, 3, st)

        extras = []
        desc = d.get('descuento') or {}
        if desc.get('nombre'):
            extras.append(f"Descuento {desc['nombre']}: se trae con la venta.")
        if (d.get('fiado') or {}).get('nombre'):
            extras.append(f"Fiado a nombre de {d['fiado']['nombre']}.")
        if (d.get('presupuesto') or {}).get('numero'):
            extras.append(f"Viene del presupuesto {d['presupuesto']['numero']}.")
        self._extras.setText('  '.join(extras))
        self._extras.setVisible(bool(extras))
        self._total.setText(f"${fmt_money(d.get('total'))}")

        motivo = (f'Esta venta ya no está abierta en la {self._nombre}: '
                  f'la cobraron, la vaciaron o pasó a otra caja.') if doc is None else self._bloqueo(d)
        self._motivo.setText(motivo)
        self._motivo.setVisible(bool(motivo))
        self._traer.setEnabled(not motivo)

    def _on_traer(self):
        self.action = 'traer'
        self.accept()


# ════════════════════════════════════════════════════════════════════════════
class AvisoVenta(QFrame):
    """Una línea arriba del carrito. Un toque la cierra; a los 4 s se va sola.
    Un aviso nuevo reemplaza al que está: nunca se apilan."""
    DURACION_MS = 4000

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName('avisoVenta')
        self.setCursor(Qt.PointingHandCursor)
        self.setFixedHeight(34)
        hl = QHBoxLayout(self)
        hl.setContentsMargins(12, 0, 10, 0)
        hl.setSpacing(8)
        self._texto = QLabel('')
        hl.addWidget(self._texto, 1)
        self._cerrar = QLabel('Cerrar')
        hl.addWidget(self._cerrar)
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.timeout.connect(self.ocultar)
        self._tono('aviso')
        self.setVisible(False)

    def _tono(self, tono):
        if tono == 'ok':
            fondo, borde, color = _T['success_bg'], _T['success'], _T['success']
        elif tono == 'espera':
            fondo, borde, color = _T['surface_alt'], _T['border'], _T['text']
        else:
            fondo, borde, color = _T['warning_bg'], _T['warning'], _T['warning']
        self.setStyleSheet(
            f"QFrame#avisoVenta {{ background:{fondo}; border:1px solid {borde}; border-radius:6px; }}"
        )
        self._texto.setStyleSheet(f"color:{color}; font-size:13px; font-weight:700;"
                                  f" background:transparent; border:none;")
        self._cerrar.setStyleSheet(f"color:{color}; font-size:11px; font-weight:600;"
                                   f" text-decoration:underline; background:transparent; border:none;")

    def mostrar(self, texto: str, tono: str = 'aviso', ms: int = None):
        self._tono(tono)
        self._texto.setText(texto)
        self.setVisible(True)
        self._timer.start(ms or self.DURACION_MS)

    def ocultar(self):
        self._timer.stop()
        self.setVisible(False)

    def texto(self) -> str:
        return self._texto.text()

    def mousePressEvent(self, _event):
        self.ocultar()


# ════════════════════════════════════════════════════════════════════════════
class NombreCajaDialog(QDialog):
    """Elegir el nombre de la caja: cuatro botones grandes y "otro nombre"."""

    def __init__(self, parent=None, actual: str = '', en_uso: Optional[Dict[str, str]] = None,
                 sugeridos=('Compu 1', 'Compu 2', 'Compu 3', 'Compu 4')):
        super().__init__(parent)
        self.nombre = None
        self._en_uso = en_uso or {}
        self.setWindowTitle('Nombre de esta caja')
        self.setModal(True)
        self.setMinimumWidth(460)
        self.setStyleSheet(f"QDialog {{ background:{_T['bg']}; }}")

        v = QVBoxLayout(self)
        v.setContentsMargins(20, 18, 20, 18)
        v.setSpacing(12)
        v.addWidget(_lbl('¿Cuál es esta compu?', f"color:{_T['text']}; font-size:16px; font-weight:700;"))
        ayuda = _lbl('Con este nombre la ven las otras cajas cuando traen una venta.',
                     f"color:{_T['text_muted']}; font-size:12px;")
        ayuda.setWordWrap(True)
        v.addWidget(ayuda)

        grid = QGridLayout()
        grid.setSpacing(10)
        self._botones = {}
        for i, nombre in enumerate(sugeridos):
            b = QPushButton(nombre)
            b.setCheckable(True)
            b.setCursor(Qt.PointingHandCursor)
            if nombre in self._en_uso:
                b.setText(f"{nombre}\nya la usa {self._en_uso[nombre][:18]}")
            b.clicked.connect(lambda _c, n=nombre: self._elegir(n))
            self._botones[nombre] = b
            grid.addWidget(b, i // 2, i % 2)
        v.addLayout(grid)

        self._otro = QLineEdit()
        self._otro.setPlaceholderText('Otro nombre (por ejemplo, Mercería)')
        self._otro.setMaxLength(20)
        self._otro.setStyleSheet(
            f"QLineEdit {{ border:1px solid {_T['border']}; background:{_T['surface']};"
            f" border-radius:8px; padding:8px 12px; font-size:14px; color:{_T['text']}; min-height:28px; }}"
            f"QLineEdit:focus {{ border-color:{_T['accent']}; }}"
        )
        self._otro.textEdited.connect(self._al_escribir)
        v.addWidget(self._otro)

        self._aviso = _lbl('', f"color:{_T['warning']}; font-size:12px; font-weight:600;")
        self._aviso.setWordWrap(True)
        v.addWidget(self._aviso)

        btns = QHBoxLayout()
        cancelar = boton_secundario('Cancelar')
        cancelar.clicked.connect(self.reject)
        btns.addWidget(cancelar)
        btns.addStretch(1)
        self._guardar = boton_principal('Guardar')
        self._guardar.setMinimumWidth(160)
        self._guardar.clicked.connect(self._on_guardar)
        btns.addWidget(self._guardar)
        v.addLayout(btns)

        self._elegido = ''
        if actual in self._botones:
            self._elegir(actual)
        elif actual:
            self._otro.setText(actual)
            self._al_escribir(actual)
        else:
            self._pintar()

    def _css_boton(self, activo: bool) -> str:
        if activo:
            return (f"QPushButton {{ background:{_T['accent']}; color:white; border:none;"
                    f" border-radius:8px; font-size:15px; font-weight:700; min-height:56px; }}")
        return (f"QPushButton {{ background:{BEIGE}; color:{_T['text']}; border:none;"
                f" border-radius:8px; font-size:15px; font-weight:600; min-height:56px; }}"
                f"QPushButton:hover {{ background:{BEIGE_HOVER}; }}")

    def _elegir(self, nombre):
        self._elegido = nombre
        self._otro.clear()
        self._pintar()

    def _al_escribir(self, texto):
        self._elegido = texto.strip()
        self._pintar()

    def _pintar(self):
        for nombre, b in self._botones.items():
            activo = (nombre == self._elegido)
            b.setChecked(activo)
            b.setStyleSheet(self._css_boton(activo))
        repetido = self._en_uso.get(self._elegido)
        self._aviso.setText(f'Ojo: "{self._elegido}" ya lo usa {repetido}. Dos cajas con el mismo nombre '
                            f'se confunden.' if repetido else '')
        self._aviso.setVisible(bool(repetido))
        self._guardar.setEnabled(bool(self._elegido))

    def _on_guardar(self):
        if not self._elegido:
            return
        self.nombre = self._elegido
        self.accept()
