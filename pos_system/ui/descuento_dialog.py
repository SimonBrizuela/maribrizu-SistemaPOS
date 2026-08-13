"""
Descuento con nombre sobre el carrito.

Hasta ahora un descuento se hacía editando el precio a mano: quedaba el número
cambiado y nadie sabía por qué. Este diálogo le pone nombre ("Jubilados",
"Docente", "Cliente de la casa"), calcula el monto y deja constancia en el
ticket, en la factura y en los reportes.

Se puede aplicar a todo el carrito o a los renglones que se tilden. Cuando es un
monto fijo sobre varios renglones, se reparte proporcional al peso de cada uno,
así el detalle cierra con el total al centavo.
"""
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QLineEdit,
    QListWidget, QListWidgetItem, QFrame, QButtonGroup,
    QMessageBox, QWidget
)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont

# Los que más se repiten en el mostrador. Se pueden pisar escribiendo cualquier
# otro nombre: la idea es ahorrar tipeo, no encorsetar.
SUGERENCIAS = ['Jubilados', 'Docente', 'Cliente de la casa', 'Mayorista', 'Efectivo']

def _money(n):
    return f'{float(n or 0):,.2f}'.replace(',', 'X').replace('.', ',').replace('X', '.')


def redondear_centena(total, monto, tope):
    """Lleva el total a la centena, agrandando el descuento lo justo.

    Misma regla que el ±100 del catálogo web (`redondearCentena` en
    catalogo.js): centena, y si el monto es tan chico que eso daría cero, cae a
    la decena. Acá va siempre PARA ABAJO — es un descuento, no puede terminar
    cobrando más que la suma de los productos.

    El ajuste tampoco puede pasarse del `tope` (lo que suman los renglones
    elegidos): un descuento no puede superar a lo que descuenta.

    Devuelve (monto_final, ajuste).
    """
    queda = round(float(total) - float(monto), 2)
    if queda <= 0:
        return monto, 0.0

    objetivo = int(queda / 100) * 100
    if objetivo <= 0:                       # totales chicos: a la decena
        objetivo = int(queda / 10) * 10
    if objetivo <= 0 or objetivo >= queda:
        return monto, 0.0                   # ya está redondo

    ajuste = min(round(queda - objetivo, 2), max(0.0, float(tope) - float(monto)))
    if ajuste <= 0:
        return monto, 0.0
    return round(float(monto) + ajuste, 2), round(ajuste, 2)


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
        self._init_ui()
        if actual:
            self._precargar(actual)
        self._recalcular()

    # ── Armado ──────────────────────────────────────────────────────────────
    def _init_ui(self):
        from pos_system.ui.theme import COLORS as T
        self._T = T
        # Los toggles emiten señal apenas se marcan, y el primero se marca antes
        # de que existan los widgets del paso 3. Hasta que la ventana esté
        # armada, recalcular no tiene sentido y explota.
        self._armado = False
        self.setWindowTitle('Descuento')
        self.setModal(True)
        self.setMinimumWidth(560)
        self.setStyleSheet(f"QDialog {{ background:{T['bg']}; }}")

        v = QVBoxLayout(self)
        v.setContentsMargins(20, 18, 20, 18)
        v.setSpacing(12)

        titulo = QLabel('Descuento')
        titulo.setFont(QFont('Segoe UI', 15, QFont.Bold))
        titulo.setStyleSheet(f"color:{T['text']};")
        v.addWidget(titulo)

        # 1 · Nombre
        v.addWidget(self._paso('1', 'Nombre del descuento'))
        self.nombre_input = QLineEdit()
        self.nombre_input.setPlaceholderText('Jubilados, Docente, Cliente de la casa…')
        self.nombre_input.setMinimumHeight(38)
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
        self.valor_input.setMinimumHeight(44)
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
        self.redondear_btn.setMinimumHeight(38)
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

        self.lista = QListWidget()
        self.lista.setFixedHeight(150)
        self.lista.setFont(QFont('Segoe UI', 10))
        self.lista.setStyleSheet(
            f"QListWidget {{ background:{T['surface']}; border:1.5px solid {T['border']};"
            f" border-radius:8px; color:{T['text']}; outline:none; }}"
            f"QListWidget::item {{ padding:9px 8px; border-bottom:1px solid {T['border_soft']}; }}"
            f"QListWidget::item:selected {{ background:{T['accent_soft']}; color:{T['text']}; }}"
            f"QListWidget::indicator {{ width:20px; height:20px; border-radius:4px;"
            f" border:2px solid {T['border']}; background:{T['surface']}; }}"
            f"QListWidget::indicator:checked {{ background:{T['accent']};"
            f" border-color:{T['accent']}; }}"
        )
        for i, it in enumerate(self.cart):
            nombre = it.get('product_name') or '—'
            qty = it.get('quantity') or 0
            qty_txt = f'{qty:g}'
            item = QListWidgetItem(f'{qty_txt} × {nombre}          ${_money(it.get("subtotal"))}')
            item.setFlags(item.flags() | Qt.ItemIsUserCheckable)
            item.setCheckState(Qt.Unchecked)
            item.setData(Qt.UserRole, i)
            self.lista.addItem(item)
        self.lista.itemChanged.connect(lambda _i: self._recalcular())
        self.lista.setVisible(False)
        v.addWidget(self.lista)

        # Resumen
        self.resumen = QLabel()
        self.resumen.setFont(QFont('Segoe UI', 11))
        self.resumen.setTextFormat(Qt.RichText)
        self.resumen.setStyleSheet(
            f"background:{T['surface']}; border:1px solid {T['border']};"
            f" border-radius:8px; padding:12px; color:{T['text']};"
        )
        v.addWidget(self.resumen)

        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet(f"background:{T['border']}; max-height:1px;")
        v.addWidget(sep)

        botones = QHBoxLayout()
        botones.setSpacing(8)

        if self._actual:
            quitar = QPushButton('Quitar descuento')
            quitar.setMinimumHeight(40)
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
        cancelar.setMinimumHeight(40)
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
        self.aplicar_btn.setMinimumHeight(42)
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

        v.addLayout(botones)
        self._armado = True
        self.nombre_input.setFocus()

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
        b.setMinimumHeight(44)
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
            for i in range(self.lista.count()):
                it = self.lista.item(i)
                if it.data(Qt.UserRole) in filas:
                    it.setCheckState(Qt.Checked)

    # ── Cálculo ─────────────────────────────────────────────────────────────
    def _cambiar_redondeo(self, activo):
        self.redondear_btn.setText('±100   Redondeando el total' if activo
                                   else '±100   Redondear el total')
        self._recalcular()

    def _cambiar_alcance(self):
        self.lista.setVisible(self.rb_elegidos.isChecked())
        self.adjustSize()
        self._recalcular()

    def _filas_elegidas(self):
        if self.rb_todo.isChecked():
            return list(range(len(self.cart)))
        return [self.lista.item(i).data(Qt.UserRole)
                for i in range(self.lista.count())
                if self.lista.item(i).checkState() == Qt.Checked]

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
