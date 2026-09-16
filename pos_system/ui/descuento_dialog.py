"""
Descuento con nombre sobre el carrito.

Hasta ahora un descuento se hacía editando el precio a mano: quedaba el número
cambiado y nadie sabía por qué. Este diálogo le pone nombre ("Jubilados",
"Docente", "Cliente de la casa"), calcula el monto y deja constancia en el
ticket, en la factura y en los reportes.

Se puede aplicar a todo el carrito o a los renglones que se tilden. Cuando es un
monto fijo sobre varios renglones, se reparte proporcional al peso de cada uno,
así el detalle cierra con el total al centavo.

La ventana se acomoda a la pantalla donde está el POS: en una notebook de 768 o
con la escala de Windows al 125/150% entera no entraba, y al abrir la lista de
productos crecía para abajo y se salía. Ahora el resumen y los botones quedan
siempre a la vista, la lista cede alto primero y, si aun así no alcanza, el
cuerpo se desplaza.
"""
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QLineEdit,
    QTreeWidget, QTreeWidgetItem, QHeaderView, QAbstractItemView, QFrame,
    QButtonGroup, QMessageBox, QWidget, QScrollArea, QApplication
)
from PyQt5.QtCore import Qt, QSize, QTimer
from PyQt5.QtGui import QFont

# Los que más se repiten en el mostrador. Se pueden pisar escribiendo cualquier
# otro nombre: la idea es ahorrar tipeo, no encorsetar.
SUGERENCIAS = ['Jubilados', 'Docente', 'Cliente de la casa', 'Mayorista', 'Efectivo']

def _money(n):
    return f'{float(n or 0):,.2f}'.replace(',', 'X').replace('.', ',').replace('X', '.')


# El redondeo saca la colita del total, no regala el ticket. Sin este freno un
# total de $180 bajaba a $100: un 44% de descuento por apretar un botón que
# promete acomodar centavos.
TOPE_REDONDEO = 0.10


def redondear_centena(total, monto, tope):
    """Lleva el total a la centena de abajo, agrandando el descuento lo justo.

    Misma idea que el ±100 del catálogo web (`redondearCentena` en
    catalogo.js), con dos diferencias que hacen falta acá:

      · Va siempre PARA ABAJO. La web redondea a la centena más cercana, pero
        esto es un descuento: subir el total sería cobrar de más.
      · El ajuste no puede pasar del 10% del total. Si la centena de abajo está
        demasiado lejos se prueba con la decena, y si tampoco entra no se toca
        nada. Redondear es acomodar el vuelto, no hacer una oferta.

    Tampoco puede pasarse del `tope` (lo que suman los renglones elegidos): un
    descuento no puede superar a lo que descuenta.

    Devuelve (monto_final, ajuste).
    """
    queda = round(float(total) - float(monto), 2)
    if queda <= 0:
        return monto, 0.0

    limite = min(queda * TOPE_REDONDEO, max(0.0, float(tope) - float(monto)))
    for unidad in (100, 10):
        objetivo = int(queda / unidad) * unidad
        if objetivo <= 0 or objetivo >= queda:
            continue                        # ya termina redondo en esa unidad
        ajuste = round(queda - objetivo, 2)
        if ajuste <= limite:
            return round(float(monto) + ajuste, 2), ajuste
    return monto, 0.0


# ── Acomodo en pantalla ─────────────────────────────────────────────────────

# Aire entre la ventana y el borde de la pantalla o la barra de tareas.
MARGEN_PANTALLA = 8

# Por debajo de este alto útil (notebook de 768, o 1080 con escala al 150%) el
# diálogo se aprieta: menos aire entre pasos y botones un poco más bajos.
ALTO_COMPACTO = 800

ANCHO_PREFERIDO = 560
ANCHO_MINIMO = 480

# Antes de mostrarse, Windows todavía no informa cuánto ocupan el borde y la
# barra de título. Se supone lo de Windows 10/11 y se corrige al aparecer.
MARCO_SUPUESTO = (16, 39)

FILAS_LISTA = 5          # renglones que muestra la lista si hay lugar
FILAS_LISTA_MINIMO = 3   # hasta dónde se achica antes de desplazar el cuerpo


def geometria_en_pantalla(disponible, ancho, alto, marco_h, marco_v,
                          centro=None, esquina=None):
    """Tamaño y posición para que la ventana entre entera en la pantalla.

    `disponible` es el área útil (sin barra de tareas); `ancho` y `alto`, lo que
    pide el contenido; `marco_h`/`marco_v`, lo que suman borde y barra de
    título. La ventana se centra en `centro` o se deja donde está (`esquina`,
    arriba a la izquierda del marco) y después se corre lo justo para no
    salirse por ningún lado.

    Devuelve (x, y, ancho, alto): x/y del marco, ancho/alto del contenido.
    """
    m = MARGEN_PANTALLA
    ancho = max(1, min(int(ancho), disponible.width() - marco_h - 2 * m))
    alto = max(1, min(int(alto), disponible.height() - marco_v - 2 * m))
    total_w, total_h = ancho + marco_h, alto + marco_v

    if esquina is not None:
        x, y = esquina.x(), esquina.y()
    else:
        c = centro if centro is not None else disponible.center()
        x, y = c.x() - total_w // 2, c.y() - total_h // 2

    x = max(disponible.left() + m, min(x, disponible.right() + 1 - m - total_w))
    y = max(disponible.top() + m, min(y, disponible.bottom() + 1 - m - total_h))
    return x, y, ancho, alto


class _CuerpoDesplazable(QScrollArea):
    """Scroll que pide el alto de lo que tiene adentro.

    Un QScrollArea común pide un tamaño chico fijo y el diálogo abriría
    aplastado. Este informa el tamaño natural del contenido: la ventana se arma
    completa cuando entra y el scroll aparece solo cuando no.
    """

    def sizeHint(self):
        contenido = self.widget()
        if contenido is None:
            return super().sizeHint()
        hint = contenido.sizeHint()
        borde = 2 * self.frameWidth()
        return QSize(hint.width() + borde, hint.height() + borde)


class DescuentoDialog(QDialog):
    """Resultado en `self.resultado`:

        {'nombre': str, 'tipo': 'porcentaje'|'monto', 'valor': float,
         'filas': [i, ...] | None}     # None = todo el carrito
    """

    def __init__(self, parent=None, cart=None, actual=None):
        super().__init__(parent)
        self.cart = cart or []
        self.resultado = None
        self._actual = actual
        self._ubicado = False
        self._compacto = self._pantalla().availableGeometry().height() < ALTO_COMPACTO
        self._init_ui()
        if actual:
            self._precargar(actual)
        self._recalcular()
        self._ajustar_a_pantalla(centrar=True)

    # ── Armado ──────────────────────────────────────────────────────────────
    def _init_ui(self):
        from pos_system.ui.theme import COLORS as T
        self._T = T
        # Los toggles emiten señal apenas se marcan, y el primero se marca antes
        # de que existan los widgets del paso 3. Hasta que la ventana esté
        # armada, recalcular no tiene sentido y explota.
        self._armado = False
        c = self._compacto
        esp = 8 if c else 12
        self._alto_opcion = 38 if c else 44

        self.setWindowTitle('Descuento')
        self.setModal(True)
        self.setStyleSheet(f"QDialog {{ background:{T['bg']}; }}")

        raiz = QVBoxLayout(self)
        if c:
            raiz.setContentsMargins(18, 10, 18, 10)
        else:
            raiz.setContentsMargins(20, 18, 20, 18)
        raiz.setSpacing(esp)

        # En pantalla baja el título se va: la barra de la ventana ya dice
        # "Descuento" y ese renglón es justo lo que le falta a la lista.
        if not c:
            titulo = QLabel('Descuento')
            titulo.setFont(QFont('Segoe UI', 15, QFont.Bold))
            titulo.setStyleSheet(f"color:{T['text']};")
            raiz.addWidget(titulo)

        # Los tres pasos van en un cuerpo que se desplaza si la pantalla no da;
        # el resumen y los botones quedan fijos abajo.
        cuerpo = QWidget()
        cuerpo.setObjectName('cuerpoDescuento')
        cuerpo.setStyleSheet('QWidget#cuerpoDescuento { background: transparent; }')
        v = QVBoxLayout(cuerpo)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(esp)

        # 1 · Nombre
        v.addWidget(self._paso('1', 'Nombre del descuento'))
        self.nombre_input = QLineEdit()
        self.nombre_input.setPlaceholderText('Jubilados, Docente, Cliente de la casa…')
        self.nombre_input.setMinimumHeight(34 if c else 38)
        self.nombre_input.setFont(QFont('Segoe UI', 11))
        self.nombre_input.setStyleSheet(self._estilo_input())
        v.addWidget(self.nombre_input)

        chips = QHBoxLayout()
        chips.setSpacing(6)
        for s in SUGERENCIAS:
            b = QPushButton(s)
            b.setCursor(Qt.PointingHandCursor)
            b.setMinimumHeight(26)
            b.setFont(QFont('Segoe UI', 9))
            b.setStyleSheet(
                f"QPushButton {{ background:{T['surface']}; color:{T['text_muted']};"
                f" border:1px solid {T['border']}; border-radius:13px; padding:0 12px; }}"
                f"QPushButton:hover {{ border-color:{T['accent']}; color:{T['accent']}; }}"
            )
            b.clicked.connect(lambda _c, txt=s: self.nombre_input.setText(txt))
            chips.addWidget(b)
        chips.addStretch()
        v.addLayout(chips)

        # 2 · Cuánto
        v.addWidget(self._paso('2', 'Cuánto'))
        fila = QHBoxLayout()
        fila.setSpacing(0)

        self.grupo_tipo = QButtonGroup(self)
        self.rb_pct = self._opcion('%  Porcentaje', primero=True)
        self.rb_monto = self._opcion('$  Monto fijo', ultimo=True)
        self.rb_pct.setChecked(True)
        for b in (self.rb_pct, self.rb_monto):
            self.grupo_tipo.addButton(b)
            b.toggled.connect(self._recalcular)
            fila.addWidget(b)

        fila.addSpacing(12)
        self.valor_input = QLineEdit()
        self.valor_input.setPlaceholderText('10')
        self.valor_input.setMinimumHeight(self._alto_opcion)
        self.valor_input.setFixedWidth(130)
        self.valor_input.setFont(QFont('Segoe UI', 15, QFont.Bold))
        self.valor_input.setAlignment(Qt.AlignCenter)
        self.valor_input.setStyleSheet(self._estilo_input())
        self.valor_input.textChanged.connect(self._recalcular)
        fila.addWidget(self.valor_input)
        v.addLayout(fila)

        # Redondeo: las monedas chicas ya no existen, un vuelto de $40 no se
        # puede dar. Baja el total al múltiplo de abajo agrandando el descuento.
        redondeo = QHBoxLayout()
        redondeo.setSpacing(6)
        self.redondear_btn = QPushButton('±100   Redondear el total')
        self.redondear_btn.setCheckable(True)
        self.redondear_btn.setCursor(Qt.PointingHandCursor)
        self.redondear_btn.setMinimumHeight(34 if c else 38)
        self.redondear_btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
        self.redondear_btn.setStyleSheet(f'''
            QPushButton {{
                background: {T['surface']}; color: {T['text_muted']};
                border: 1.5px solid {T['border']}; border-radius: 8px;
                padding: 0 14px;
            }}
            QPushButton:hover {{ background: {T['surface_alt']}; color: {T['text']}; }}
            QPushButton:checked {{
                background: {T['accent']}; color: white; border-color: {T['accent']};
            }}
        ''')
        self.redondear_btn.toggled.connect(self._cambiar_redondeo)
        redondeo.addWidget(self.redondear_btn)

        self.redondeo_lbl = QLabel('deja el total en una centena redonda')
        self.redondeo_lbl.setFont(QFont('Segoe UI', 9))
        self.redondeo_lbl.setStyleSheet(f"color:{T['text_muted']};")
        redondeo.addWidget(self.redondeo_lbl)
        redondeo.addStretch()
        v.addLayout(redondeo)

        # 3 · A qué
        v.addWidget(self._paso('3', 'Sobre qué se aplica'))
        alcance = QHBoxLayout()
        alcance.setSpacing(0)
        self.rb_todo = self._opcion('Todo el carrito', primero=True)
        self.rb_elegidos = self._opcion('Solo los que elija', ultimo=True)
        self.rb_todo.setChecked(True)
        self.grupo_alcance = QButtonGroup(self)
        for b in (self.rb_todo, self.rb_elegidos):
            self.grupo_alcance.addButton(b)
            b.toggled.connect(self._cambiar_alcance)
            alcance.addWidget(b)
        v.addLayout(alcance)

        v.addWidget(self._armar_lista())
        v.addStretch()

        self._cuerpo = _CuerpoDesplazable()
        self._cuerpo.setWidget(cuerpo)
        self._cuerpo.setWidgetResizable(True)
        self._cuerpo.setFrameShape(QFrame.NoFrame)
        self._cuerpo.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self._cuerpo.setStyleSheet('QScrollArea { background: transparent; border: none; }')
        self._cuerpo.viewport().setAutoFillBackground(False)
        raiz.addWidget(self._cuerpo, 1)

        # Resumen
        self.resumen = QLabel()
        self.resumen.setFont(QFont('Segoe UI', 11))
        self.resumen.setTextFormat(Qt.RichText)
        self.resumen.setStyleSheet(
            f"background:{T['surface']}; border:1px solid {T['border']};"
            f" border-radius:8px; padding:{8 if c else 12}px; color:{T['text']};"
        )
        # Lugar fijo para el caso más largo (con redondeo): si el recuadro
        # crece mientras se tipea, la ventana salta y le come alto a la lista.
        self.resumen.setText('A<br>B<br>C<br><b style="font-size:15px">D</b>')
        self.resumen.setMinimumHeight(self.resumen.sizeHint().height())
        self.resumen.clear()
        raiz.addWidget(self.resumen)

        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet(f"background:{T['border']}; max-height:1px;")
        raiz.addWidget(sep)

        botones = QHBoxLayout()
        botones.setSpacing(8)
        alto_boton = 38 if c else 42

        if self._actual:
            quitar = QPushButton('Quitar descuento')
            quitar.setMinimumHeight(alto_boton)
            quitar.setFont(QFont('Segoe UI', 10))
            quitar.setCursor(Qt.PointingHandCursor)
            quitar.setStyleSheet(
                f"QPushButton {{ background:transparent; border:1px solid {T['danger']};"
                f" border-radius:8px; color:{T['danger']}; padding:0 14px; }}"
                f"QPushButton:hover {{ background:{T['danger']}; color:white; }}"
            )
            quitar.clicked.connect(self._quitar)
            botones.addWidget(quitar)

        cancelar = QPushButton('Cancelar')
        cancelar.setMinimumHeight(alto_boton)
        cancelar.setMinimumWidth(110)
        cancelar.setFont(QFont('Segoe UI', 10))
        cancelar.setCursor(Qt.PointingHandCursor)
        cancelar.setStyleSheet(
            f"QPushButton {{ background:transparent; border:1px solid {T['border']};"
            f" border-radius:8px; color:{T['text_muted']}; }}"
            f"QPushButton:hover {{ background:{T['surface_alt']}; color:{T['text']}; }}"
        )
        cancelar.clicked.connect(self.reject)
        botones.addWidget(cancelar)

        self.aplicar_btn = QPushButton('Aplicar descuento')
        self.aplicar_btn.setMinimumHeight(alto_boton)
        self.aplicar_btn.setFont(QFont('Segoe UI', 11, QFont.Bold))
        self.aplicar_btn.setCursor(Qt.PointingHandCursor)
        self.aplicar_btn.setStyleSheet(
            f"QPushButton {{ background:{T['accent']}; color:white; border:none;"
            f" border-radius:8px; }}"
            f"QPushButton:hover {{ background:{T['accent_hover']}; }}"
            f"QPushButton:disabled {{ background:{T['border']}; color:{T['text_muted']}; }}"
        )
        self.aplicar_btn.clicked.connect(self._aplicar)
        botones.addWidget(self.aplicar_btn, 2)

        raiz.addLayout(botones)
        self._armado = True
        self.nombre_input.setFocus()

    def _armar_lista(self):
        """Renglones del carrito con tilde, nombre y subtotal.

        Dos columnas para que el importe quede siempre a la derecha y a la
        vista: con una sola, un nombre largo empujaba el precio afuera y
        aparecía una barra horizontal. Tocar cualquier parte del renglón tilda,
        no solo el cuadradito (en la pantalla táctil es chico).
        """
        T = self._T
        self.lista = QTreeWidget()
        self.lista.setColumnCount(2)
        self.lista.setHeaderHidden(True)
        self.lista.setRootIsDecorated(False)
        self.lista.setIndentation(0)
        self.lista.setUniformRowHeights(True)
        self.lista.setSelectionMode(QAbstractItemView.NoSelection)
        self.lista.setFocusPolicy(Qt.NoFocus)
        self.lista.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.lista.setTextElideMode(Qt.ElideRight)
        self.lista.setFont(QFont('Segoe UI', 10))
        cabecera = self.lista.header()
        cabecera.setStretchLastSection(False)
        cabecera.setSectionResizeMode(0, QHeaderView.Stretch)
        cabecera.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        pad = '6px 8px' if self._compacto else '9px 8px'
        self.lista.setStyleSheet(
            f"QTreeWidget {{ background:{T['surface']}; border:1.5px solid {T['border']};"
            f" border-radius:8px; color:{T['text']}; outline:none; }}"
            f"QTreeWidget::item {{ padding:{pad}; border-bottom:1px solid {T['border_soft']};"
            f" color:{T['text']}; }}"
            f"QTreeWidget::item:hover {{ background:{T['surface_alt']}; }}"
            f"QTreeWidget::indicator {{ width:20px; height:20px; border-radius:4px;"
            f" border:2px solid {T['border']}; background:{T['surface']}; }}"
            f"QTreeWidget::indicator:checked {{ background:{T['accent']};"
            f" border-color:{T['accent']}; }}"
        )
        for i, it in enumerate(self.cart):
            nombre = it.get('product_name') or '—'
            qty = it.get('quantity') or 0
            fila = QTreeWidgetItem([f'{qty:g} × {nombre}', f'${_money(it.get("subtotal"))}'])
            fila.setFlags(fila.flags() | Qt.ItemIsUserCheckable)
            fila.setCheckState(0, Qt.Unchecked)
            fila.setData(0, Qt.UserRole, i)
            fila.setToolTip(0, nombre)
            fila.setTextAlignment(1, Qt.AlignRight | Qt.AlignVCenter)
            self.lista.addTopLevelItem(fila)
        self.lista.itemChanged.connect(lambda *_: self._recalcular())
        self.lista.itemPressed.connect(self._fila_apretada)
        self.lista.itemClicked.connect(self._fila_tocada)
        self._fila_en_curso = None
        self.lista.setVisible(False)
        return self.lista

    def _fila_apretada(self, item, _columna):
        self._fila_en_curso = (item, item.checkState(0))

    def _fila_tocada(self, item, _columna):
        """Si el toque no cayó en el cuadradito (que ya cambia solo), tilda."""
        previo = self._fila_en_curso
        self._fila_en_curso = None
        if previo is None or previo[0] is not item:
            return
        if item.checkState(0) == previo[1]:
            item.setCheckState(0, Qt.Unchecked if previo[1] == Qt.Checked else Qt.Checked)

    def _opcion(self, texto, primero=False, ultimo=False):
        """Botón de un par excluyente, tipo interruptor.

        Con QRadioButton no se veía qué estaba elegido: el estilo global del POS
        le come el puntito y quedaban dos cuadraditos vacíos iguales. Acá la
        opción activa se pinta entera con el color de acento y no hay forma de
        confundirse.
        """
        T = self._T
        b = QPushButton(texto)
        b.setCheckable(True)
        b.setCursor(Qt.PointingHandCursor)
        b.setMinimumHeight(self._alto_opcion)
        b.setFont(QFont('Segoe UI', 11, QFont.Bold))
        izq = '8px' if primero else '0'
        der = '8px' if ultimo else '0'
        b.setStyleSheet(f'''
            QPushButton {{
                background: {T['surface']};
                color: {T['text_muted']};
                border: 1.5px solid {T['border']};
                border-top-left-radius: {izq}; border-bottom-left-radius: {izq};
                border-top-right-radius: {der}; border-bottom-right-radius: {der};
                padding: 0 18px;
            }}
            QPushButton:hover {{ background: {T['surface_alt']}; color: {T['text']}; }}
            QPushButton:checked {{
                background: {T['accent']}; color: white;
                border-color: {T['accent']};
            }}
        ''')
        return b

    def _paso(self, numero, texto):
        T = self._T
        w = QWidget()
        h = QHBoxLayout(w)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(8)
        n = QLabel(numero)
        n.setFixedSize(20, 20)
        n.setAlignment(Qt.AlignCenter)
        n.setFont(QFont('Segoe UI', 9, QFont.Bold))
        n.setStyleSheet(
            f"background:{T['accent']}; color:white; border-radius:10px;"
        )
        h.addWidget(n)
        l = QLabel(texto)
        l.setFont(QFont('Segoe UI', 10, QFont.Bold))
        l.setStyleSheet(f"color:{T['text']};")
        h.addWidget(l)
        h.addStretch()
        return w

    def _estilo_input(self):
        T = self._T
        return (
            f"QLineEdit {{ background:{T['surface']}; border:1.5px solid {T['border']};"
            f" border-radius:8px; padding:0 12px; color:{T['text']}; }}"
            f"QLineEdit:focus {{ border-color:{T['accent']}; }}"
        )

    def _precargar(self, actual):
        self.nombre_input.setText(actual.get('nombre') or '')
        self.valor_input.setText(f"{float(actual.get('valor') or 0):g}")
        if (actual.get('tipo') or '') == 'monto':
            self.rb_monto.setChecked(True)
        filas = actual.get('filas')
        if filas:
            self.rb_elegidos.setChecked(True)
            self.lista.setVisible(True)
            for i in range(self.lista.topLevelItemCount()):
                it = self.lista.topLevelItem(i)
                if it.data(0, Qt.UserRole) in filas:
                    it.setCheckState(0, Qt.Checked)

    # ── Tamaño y lugar en la pantalla ───────────────────────────────────────
    def _ventana_del_pos(self):
        padre = self.parentWidget()
        return padre.window() if padre is not None else None

    def _pantalla(self):
        """La pantalla donde está el POS, no la principal: con dos monitores el
        diálogo tiene que medirse contra el que se está usando."""
        ventana = self._ventana_del_pos()
        if ventana is not None:
            pantalla = QApplication.screenAt(ventana.frameGeometry().center())
            if pantalla is not None:
                return pantalla
        return QApplication.primaryScreen()

    def _marco(self):
        if self.isVisible():
            marco_h = self.frameGeometry().width() - self.width()
            marco_v = self.frameGeometry().height() - self.height()
            if marco_v > 0:
                return marco_h, marco_v
        return MARCO_SUPUESTO

    def _pedido(self):
        """Tamaño natural de la ventana, medido de nuevo.

        El scroll corta el aviso de "cambié de tamaño" que manda su contenido,
        así que el layout de la ventana seguiría usando la medida vieja.
        """
        self._cuerpo.widget().layout().activate()
        self._cuerpo.updateGeometry()
        self.layout().invalidate()
        self.layout().activate()
        return self.sizeHint()

    def _alto_de_lista(self, filas):
        filas = max(1, min(filas, self.lista.topLevelItemCount() or 1))
        alto_fila = self.lista.sizeHintForRow(0) if self.lista.topLevelItemCount() else 36
        return filas * max(alto_fila, 24) + 2 * self.lista.frameWidth() + 2

    def _ajustar_a_pantalla(self, centrar=False):
        """Achica la ventana a lo que entra y la mete adentro de la pantalla.

        Con `centrar` se ubica sobre la ventana del POS (al abrir); si no, se
        respeta dónde la dejó el cajero y solo se corre si se sale (al abrir o
        cerrar la lista de productos).
        """
        pantalla = self._pantalla()
        if pantalla is None:
            return
        disponible = pantalla.availableGeometry()
        marco_h, marco_v = self._marco()
        alto_max = disponible.height() - marco_v - 2 * MARGEN_PANTALLA

        lista_visible = not self.lista.isHidden()
        if lista_visible:
            self.lista.setFixedHeight(self._alto_de_lista(FILAS_LISTA))
        pedido = self._pedido()

        # Lo primero que cede es la lista: mostrar tres renglones y dejar todo
        # lo demás a la vista es mejor que obligar a desplazar la ventana.
        if lista_visible and pedido.height() > alto_max:
            natural = self._alto_de_lista(FILAS_LISTA)
            minimo = self._alto_de_lista(FILAS_LISTA_MINIMO)
            self.lista.setFixedHeight(max(minimo, natural - (pedido.height() - alto_max)))
            pedido = self._pedido()

        ancho_util = disponible.width() - marco_h - 2 * MARGEN_PANTALLA
        self.setMinimumWidth(min(ANCHO_MINIMO, ancho_util))
        ventana = self._ventana_del_pos()
        if centrar:
            centro = (ventana.frameGeometry().center()
                      if ventana is not None and ventana.isVisible()
                      else disponible.center())
            x, y, ancho, alto = geometria_en_pantalla(
                disponible, max(pedido.width(), ANCHO_PREFERIDO), pedido.height(),
                marco_h, marco_v, centro=centro)
        else:
            x, y, ancho, alto = geometria_en_pantalla(
                disponible, max(pedido.width(), self.width()), pedido.height(),
                marco_h, marco_v, esquina=self.pos())
        self.resize(ancho, alto)
        self.move(x, y)

    def showEvent(self, event):
        super().showEvent(event)
        if not self._ubicado:
            # Recién ahora Windows sabe cuánto mide la barra de título.
            self._ubicado = True
            QTimer.singleShot(0, lambda: self._ajustar_a_pantalla(centrar=True))

    # ── Cálculo ─────────────────────────────────────────────────────────────
    def _cambiar_redondeo(self, activo):
        self.redondear_btn.setText('±100   Redondeando el total' if activo
                                   else '±100   Redondear el total')
        self._recalcular()

    def _cambiar_alcance(self):
        self.lista.setVisible(self.rb_elegidos.isChecked())
        self._recalcular()
        if self._armado:
            self._ajustar_a_pantalla()

    def _filas_elegidas(self):
        if self.rb_todo.isChecked():
            return list(range(len(self.cart)))
        return [self.lista.topLevelItem(i).data(0, Qt.UserRole)
                for i in range(self.lista.topLevelItemCount())
                if self.lista.topLevelItem(i).checkState(0) == Qt.Checked]

    def _valor(self):
        txt = (self.valor_input.text() or '').strip().replace(',', '.')
        try:
            return max(0.0, float(txt))
        except ValueError:
            return 0.0

    def _redondea(self):
        return bool(self.redondear_btn.isChecked())

    def calcular(self):
        """Devuelve (monto_total, base, filas). El monto nunca supera la base:
        un descuento no puede dejar el ticket en negativo."""
        filas = self._filas_elegidas()
        base = sum(float(self.cart[i].get('subtotal') or 0)
                   for i in filas if i < len(self.cart))
        valor = self._valor()
        monto = 0.0
        if valor and base > 0:
            if self.rb_pct.isChecked():
                monto = base * min(valor, 100.0) / 100.0
            else:
                monto = min(valor, base)
        monto = round(monto, 2)

        if self._redondea() and base > 0:
            total_carrito = sum(float(it.get('subtotal') or 0) for it in self.cart)
            monto, self._ajuste_redondeo = redondear_centena(
                total_carrito, monto, base)
        else:
            self._ajuste_redondeo = 0.0
        return monto, base, filas

    def _recalcular(self):
        if not getattr(self, '_armado', False):
            return
        T = self._T
        monto, base, filas = self.calcular()
        total_carrito = sum(float(it.get('subtotal') or 0) for it in self.cart)
        queda = total_carrito - monto

        if not filas:
            self.resumen.setText(
                f"<span style='color:{T['text_muted']}'>Elegí al menos un producto.</span>")
            self.aplicar_btn.setEnabled(False)
            return
        if monto <= 0:
            aviso = ('El total ya termina en una centena redonda.'
                     if self._redondea() else 'Ingresá cuánto descontar.')
            self.resumen.setText(
                f"<span style='color:{T['text_muted']}'>{aviso}</span>")
            self.aplicar_btn.setEnabled(False)
            return

        detalle = ('todo el carrito' if self.rb_todo.isChecked()
                   else f'{len(filas)} producto{"s" if len(filas) != 1 else ""}')
        pct_real = (monto / base * 100) if base else 0
        ajuste = getattr(self, '_ajuste_redondeo', 0.0)
        linea_redondeo = (
            f"<span style='color:{T['text_muted']}'>Redondeo: −${_money(ajuste)}"
            f"</span><br>" if ajuste > 0 else ''
        )
        self.resumen.setText(
            f"Sobre {detalle}: <b>${_money(base)}</b><br>"
            f"<span style='color:{T['danger']}'>Descuento: −${_money(monto)}"
            f" ({pct_real:.1f}%)</span><br>"
            f"{linea_redondeo}"
            f"<b style='font-size:15px'>Total a cobrar: ${_money(queda)}</b>"
        )
        self.aplicar_btn.setEnabled(True)

    # ── Salida ──────────────────────────────────────────────────────────────
    def _aplicar(self):
        nombre = (self.nombre_input.text() or '').strip()
        # Bajar los $40 que no se pueden pagar no necesita bautismo: si el único
        # descuento es el redondeo, se llama así solo.
        if not nombre and self._redondea() and not self._valor():
            nombre = 'Redondeo'
        if not nombre:
            QMessageBox.warning(self, 'Falta el nombre',
                                'Poné un nombre al descuento: es lo que va a figurar '
                                'en el ticket y en la factura.')
            self.nombre_input.setFocus()
            return
        monto, _base, filas = self.calcular()
        if monto <= 0 or not filas:
            return
        if getattr(self, '_ajuste_redondeo', 0.0) > 0:
            # Con redondeo el descuento sale como monto fijo ya resuelto: el
            # porcentaje solo no vuelve a dar el mismo número redondo.
            self.resultado = {
                'nombre': nombre, 'tipo': 'monto', 'valor': monto,
                'filas': None if self.rb_todo.isChecked() else filas,
                'redondeado': True,
            }
        else:
            self.resultado = {
                'nombre': nombre,
                'tipo':   'porcentaje' if self.rb_pct.isChecked() else 'monto',
                'valor':  self._valor(),
                'filas':  None if self.rb_todo.isChecked() else filas,
            }
        self.accept()

    def _quitar(self):
        self.resultado = {'quitar': True}
        self.accept()
