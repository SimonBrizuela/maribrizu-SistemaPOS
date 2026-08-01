"""Pestaña Fiados — cuenta corriente de clientes.

Flujo completo:
  1. El cajero pone el carrito en Modo Fiado (pestaña Ventas) y lo carga a
     nombre de un cliente. No se descuenta stock ni entra plata.
  2. Cuando el cliente vuelve, se lo busca acá, se tildan los productos que
     paga y se cobra: ahí sí se crea la venta real (descuenta stock, entra a
     la caja) y esos productos pasan al historial en gris.
  3. También se puede registrar una entrega de dinero "a cuenta": genera saldo
     a favor que se aplica automáticamente en el próximo cobro.
"""
import logging
from datetime import datetime

from PyQt5.QtCore import Qt, pyqtSignal, QTimer
from PyQt5.QtGui import QFont
from PyQt5.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QLabel,
                             QPushButton, QLineEdit, QFrame, QScrollArea,
                             QMessageBox, QDialog, QCheckBox)

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.fiado import Fiado
from pos_system.models.sale import Sale
from pos_system.ui.theme import COLORS as _T
from pos_system.ui.fiado_dialogs import (FIADO, FIADO_HOVER, FIADO_SOFT,
                                         FIADO_BORDER, FiadoClienteDialog,
                                         fmt_money, fmt_qty,
                                         sincronizar_cliente, sincronizar_items,
                                         sincronizar_pago)

logger = logging.getLogger(__name__)


def _fecha_legible(valor) -> str:
    """'2026-08-01 14:22:31' → '01/08/2026 · 14:22'."""
    s = str(valor or '').strip()
    if not s:
        return ''
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M',
                '%Y-%m-%d'):
        try:
            dt = datetime.strptime(s[:len(fmt) + 2].strip(), fmt)
            return dt.strftime('%d/%m/%Y · %H:%M')
        except ValueError:
            continue
    return s[:16]


def revalidar_conjunto(db, item: dict) -> tuple:
    """Recalcula el estado 'después de vender' de un item conjunto contra el
    stock vivo. Devuelve (ok, error).

    Un fiado puede quedar meses sin cobrarse: el snapshot que se guardó al
    cargarlo ya no sirve para setear el stock del rollo/pack. Usa la misma
    función que el diálogo de conjunto, así el cálculo es idéntico al de una
    venta normal.
    """
    try:
        import json as _json
        from pos_system.ui.conjunto_dialog import aplicar_venta
    except Exception:
        return True, ''
    try:
        pid = item.get('product_id')
        if not pid:
            return True, ''
        rows = db.execute_query(
            "SELECT conjunto_unidades, conjunto_restante, conjunto_contenido, "
            "conjunto_colores FROM products WHERE id = ? LIMIT 1", (int(pid),)
        ) or []
        if not rows:
            return True, ''
        live = rows[0]
        contenido = float(live.get('conjunto_contenido') or 0)
        color = (item.get('conjunto_color') or '').strip()
        if color and live.get('conjunto_colores'):
            try:
                colores = _json.loads(live.get('conjunto_colores') or '[]')
                if not isinstance(colores, list):
                    colores = []
            except Exception:
                colores = []
            entry = next((c for c in colores if isinstance(c, dict)
                          and str(c.get('color', '')).strip() == color), None)
            base_u = float(entry.get('unidades') or 0) if entry else 0.0
            base_r = float(entry.get('restante') or 0) if entry else 0.0
        else:
            base_u = float(live.get('conjunto_unidades') or 0)
            base_r = float(live.get('conjunto_restante') or 0)

        ok, err, after_u, after_r = aplicar_venta(
            base_u, contenido, base_r,
            float(item.get('conjunto_cantidad') or 0),
            item.get('conjunto_vender_por', 'conjunto'),
            item.get('conjunto_unidad_base'),
            item.get('conjunto_unidad_venta'),
        )
        if not ok:
            return False, err or 'Stock insuficiente'
        item['conjunto_after_unidades'] = after_u
        item['conjunto_after_restante'] = after_r
        return True, ''
    except Exception:
        logger.exception('Fiado: no se pudo revalidar el stock de un conjunto')
        return True, ''


class MontoDialog(QDialog):
    """Pide un monto (entrega a cuenta)."""

    def __init__(self, parent=None, titulo='Pago a cuenta', maximo=None,
                 ayuda=''):
        super().__init__(parent)
        self.monto = 0.0
        self.setWindowTitle(titulo)
        self.setMinimumWidth(400)
        self.setStyleSheet(f"QDialog {{ background:{_T['bg']}; }}")
        self._maximo = maximo

        root = QVBoxLayout(self)
        root.setContentsMargins(18, 16, 18, 16)
        root.setSpacing(12)

        t = QLabel(titulo)
        t.setFont(QFont('Segoe UI', 14, QFont.Bold))
        t.setStyleSheet(f"color:{FIADO}; background:transparent;")
        root.addWidget(t)

        if ayuda:
            a = QLabel(ayuda)
            a.setWordWrap(True)
            a.setStyleSheet(f"color:{_T['text_muted']}; font-size:11px; background:transparent;")
            root.addWidget(a)

        self.input = QLineEdit()
        self.input.setPlaceholderText('0,00')
        self.input.setMinimumHeight(52)
        self.input.setAlignment(Qt.AlignRight)
        self.input.setFont(QFont('Consolas', 20, QFont.Bold))
        self.input.setStyleSheet(
            f"QLineEdit {{ border:2px solid {FIADO_BORDER}; background:white;"
            f" border-radius:8px; padding:6px 14px; color:{_T['text']}; }}"
            f"QLineEdit:focus {{ border-color:{FIADO}; }}"
        )
        self.input.returnPressed.connect(self._aceptar)
        root.addWidget(self.input)

        botones = QHBoxLayout(); botones.setSpacing(10)
        botones.addStretch(1)
        cancelar = QPushButton('Cancelar')
        cancelar.setMinimumHeight(40); cancelar.setMinimumWidth(110)
        cancelar.setCursor(Qt.PointingHandCursor)
        cancelar.setStyleSheet(
            f"QPushButton {{ background:{_T['surface']}; color:{_T['text_muted']};"
            f" border:1px solid {_T['border']}; border-radius:6px; font-weight:600; }}"
            f"QPushButton:hover {{ background:{_T['border_soft']}; color:{_T['text']}; }}"
        )
        cancelar.clicked.connect(self.reject)
        botones.addWidget(cancelar)
        ok = QPushButton('Continuar')
        ok.setMinimumHeight(40); ok.setMinimumWidth(150)
        ok.setCursor(Qt.PointingHandCursor)
        ok.setFont(QFont('Segoe UI', 11, QFont.Bold))
        ok.setStyleSheet(
            f"QPushButton {{ background:{FIADO}; color:white; border:none;"
            f" border-radius:6px; font-weight:700; }}"
            f"QPushButton:hover {{ background:{FIADO_HOVER}; }}"
        )
        ok.setDefault(True)
        ok.clicked.connect(self._aceptar)
        botones.addWidget(ok)
        root.addLayout(botones)
        self.input.setFocus()

    def _aceptar(self):
        raw = self.input.text().strip().replace('.', '').replace(',', '.')
        try:
            monto = round(float(raw or 0), 2)
        except ValueError:
            monto = 0.0
        if monto <= 0:
            QMessageBox.warning(self, 'Monto inválido', 'Ingresá un monto mayor a cero.')
            return
        if self._maximo is not None and monto > float(self._maximo) + 0.01:
            QMessageBox.warning(
                self, 'Monto muy alto',
                f'El máximo posible es ${fmt_money(self._maximo)}.'
            )
            return
        self.monto = monto
        self.accept()


class FiadosView(QWidget):
    """Lista de clientes con deuda + detalle y cobro."""

    refresh_requested = pyqtSignal()

    def __init__(self, parent=None, current_user: dict = None):
        super().__init__(parent)
        self.db = DatabaseManager()
        self.modelo = Fiado(self.db)
        self.sale_model = Sale(self.db)
        self.current_user = current_user or {}
        self._clientes = []
        self._cliente = None          # cliente seleccionado
        self._pendientes = []
        self._checked = set()         # ids de fiado_items tildados
        self._mostrar_historial = False
        self._build_ui()
        # El listener de Firebase puede disparar desde un hilo de red: la señal
        # lo trae al hilo principal antes de tocar widgets.
        self.refresh_requested.connect(self._on_refresh_signal)
        QTimer.singleShot(200, self.refresh_data)

    # ══════════════════════════════════════════════════
    #  UI
    # ══════════════════════════════════════════════════
    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 14, 16, 14)
        root.setSpacing(12)

        # ── Encabezado ──
        head = QHBoxLayout(); head.setSpacing(10)
        col = QVBoxLayout(); col.setSpacing(1)
        titulo = QLabel('Fiados')
        titulo.setFont(QFont('Segoe UI', 16, QFont.Bold))
        titulo.setStyleSheet(f"color:{FIADO}; background:transparent;")
        col.addWidget(titulo)
        self.resumen_lbl = QLabel('—')
        self.resumen_lbl.setStyleSheet(
            f"color:{_T['text_muted']}; font-size:12px; background:transparent;"
        )
        col.addWidget(self.resumen_lbl)
        head.addLayout(col)
        head.addStretch(1)

        self.nuevo_btn = QPushButton('+ Nuevo cliente')
        self.nuevo_btn.setMinimumHeight(38); self.nuevo_btn.setMinimumWidth(150)
        self.nuevo_btn.setCursor(Qt.PointingHandCursor)
        self.nuevo_btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
        self.nuevo_btn.setStyleSheet(
            f"QPushButton {{ background:{FIADO}; color:white; border:none;"
            f" border-radius:6px; padding:0 16px; font-weight:700; }}"
            f"QPushButton:hover {{ background:{FIADO_HOVER}; }}"
        )
        self.nuevo_btn.clicked.connect(self._nuevo_cliente)
        head.addWidget(self.nuevo_btn)

        self.refrescar_btn = QPushButton('Actualizar')
        self.refrescar_btn.setMinimumHeight(38)
        self.refrescar_btn.setCursor(Qt.PointingHandCursor)
        self.refrescar_btn.setStyleSheet(
            f"QPushButton {{ background:{_T['surface']}; color:{_T['text']};"
            f" border:1px solid {_T['border']}; border-radius:6px; padding:0 16px;"
            f" font-weight:600; }}"
            f"QPushButton:hover {{ background:{_T['border_soft']}; }}"
        )
        self.refrescar_btn.clicked.connect(self.refresh_data)
        head.addWidget(self.refrescar_btn)
        root.addLayout(head)

        # ── Cuerpo: lista de clientes | detalle ──
        body = QHBoxLayout(); body.setSpacing(12)

        # Panel izquierdo
        izq = QFrame()
        izq.setObjectName('fiadoLista')
        izq.setFixedWidth(320)
        izq.setStyleSheet(
            f"QFrame#fiadoLista {{ background:{_T['surface']};"
            f" border:1px solid {_T['border']}; border-radius:8px; }}"
        )
        izq_v = QVBoxLayout(izq)
        izq_v.setContentsMargins(12, 12, 12, 12)
        izq_v.setSpacing(10)

        self.buscar = QLineEdit()
        self.buscar.setPlaceholderText('Buscar cliente…')
        self.buscar.setMinimumHeight(38)
        self.buscar.setStyleSheet(
            f"QLineEdit {{ border:1px solid {_T['border']}; background:{_T['surface_alt']};"
            f" border-radius:6px; padding:6px 12px; font-size:13px; color:{_T['text']}; }}"
            f"QLineEdit:focus {{ border-color:{FIADO}; background:{_T['surface']}; }}"
        )
        self.buscar.textChanged.connect(self._render_lista)
        izq_v.addWidget(self.buscar)

        scroll_l = QScrollArea()
        scroll_l.setWidgetResizable(True)
        scroll_l.setFrameShape(QFrame.NoFrame)
        scroll_l.setStyleSheet('QScrollArea { background:transparent; border:none; }')
        inner_l = QWidget(); inner_l.setStyleSheet('background:transparent;')
        self.lista_v = QVBoxLayout(inner_l)
        self.lista_v.setContentsMargins(0, 0, 0, 0)
        self.lista_v.setSpacing(6)
        self.lista_v.addStretch(1)
        scroll_l.setWidget(inner_l)
        izq_v.addWidget(scroll_l, 1)
        body.addWidget(izq)

        # Panel derecho
        self.detalle_scroll = QScrollArea()
        self.detalle_scroll.setWidgetResizable(True)
        self.detalle_scroll.setFrameShape(QFrame.NoFrame)
        self.detalle_scroll.setStyleSheet('QScrollArea { background:transparent; border:none; }')
        self.detalle_host = QWidget()
        self.detalle_host.setStyleSheet('background:transparent;')
        self.detalle_v = QVBoxLayout(self.detalle_host)
        self.detalle_v.setContentsMargins(0, 0, 0, 0)
        self.detalle_v.setSpacing(10)
        self.detalle_scroll.setWidget(self.detalle_host)
        body.addWidget(self.detalle_scroll, 1)

        root.addLayout(body, 1)

    # ══════════════════════════════════════════════════
    #  CARGA DE DATOS
    # ══════════════════════════════════════════════════
    def _on_refresh_signal(self):
        """Refresh disparado por el listener de Firebase: conserva la selección."""
        self.refresh_data(mantener_seleccion=True)

    def refresh_data(self, mantener_seleccion: bool = True):
        try:
            self._clientes = self.modelo.get_clientes()
        except Exception as e:
            logger.error(f'Fiados: error listando clientes: {e}')
            self._clientes = []

        try:
            r = self.modelo.resumen()
            if r['clientes']:
                self.resumen_lbl.setText(
                    f"${fmt_money(r['total'])} pendientes · "
                    f"{r['clientes']} cliente{'s' if r['clientes'] != 1 else ''} con cuenta abierta"
                )
            else:
                self.resumen_lbl.setText('Nadie debe nada · todas las cuentas al día')
        except Exception:
            self.resumen_lbl.setText('')

        # Re-seleccionar el mismo cliente tras el refresh
        if mantener_seleccion and self._cliente:
            cid = int(self._cliente.get('id') or 0)
            self._cliente = next(
                (c for c in self._clientes if int(c.get('id') or 0) == cid), None
            )
        elif not mantener_seleccion:
            self._cliente = None

        self._render_lista()
        self._render_detalle()

    def _render_lista(self):
        texto = (self.buscar.text() or '').strip().lower()
        lay = self.lista_v
        while lay.count():
            item = lay.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()

        def _coincide(c):
            if not texto:
                return True
            campos = ' '.join(str(c.get(k) or '') for k in
                              ('nombre', 'dni', 'telefono')).lower()
            return texto in campos

        visibles = [c for c in self._clientes if _coincide(c)]
        # Los que deben primero: es lo que el cajero busca al abrir la pestaña.
        visibles.sort(key=lambda c: (-float(c.get('deuda') or 0),
                                     str(c.get('nombre') or '').lower()))

        if not visibles:
            vacio = QLabel('Sin clientes todavía.\nCreá uno con "+ Nuevo cliente"\n'
                           'o cargá un carrito en Modo Fiado desde Ventas.')
            vacio.setAlignment(Qt.AlignCenter)
            vacio.setWordWrap(True)
            vacio.setStyleSheet(
                f"color:{_T['text_dim']}; font-size:12px; background:transparent;"
                f" border:1px dashed {_T['border']}; border-radius:8px; padding:26px 10px;"
            )
            lay.addWidget(vacio)
        else:
            for c in visibles:
                lay.addWidget(self._fila_cliente(c))
        lay.addStretch(1)

    def _fila_cliente(self, c: dict) -> QWidget:
        seleccionado = (self._cliente
                        and int(self._cliente.get('id') or 0) == int(c.get('id') or 0))
        deuda = float(c.get('deuda') or 0)
        favor = float(c.get('saldo_favor') or 0)

        w = QFrame()
        w.setObjectName('fiadoCli')
        w.setCursor(Qt.PointingHandCursor)
        if seleccionado:
            w.setStyleSheet(
                f"QFrame#fiadoCli {{ background:{FIADO_SOFT};"
                f" border:1.5px solid {FIADO}; border-radius:8px; }}"
            )
        else:
            w.setStyleSheet(
                f"QFrame#fiadoCli {{ background:{_T['surface_alt']};"
                f" border:1px solid {_T['border']}; border-radius:8px; }}"
                f"QFrame#fiadoCli:hover {{ border-color:{FIADO}; background:{FIADO_SOFT}; }}"
            )
        v = QVBoxLayout(w)
        v.setContentsMargins(11, 9, 11, 9)
        v.setSpacing(3)

        top = QHBoxLayout(); top.setSpacing(6)
        nombre = QLabel(str(c.get('nombre') or ''))
        nombre.setStyleSheet(
            f"color:{_T['text']}; font-size:13px; font-weight:700;"
            f" background:transparent; border:none;"
        )
        top.addWidget(nombre, 1)
        if deuda > 0:
            monto = QLabel(f"${fmt_money(deuda)}")
            monto.setStyleSheet(
                f"color:{FIADO}; font-size:13px; font-weight:800;"
                f" background:transparent; border:none;"
                f" font-family:'JetBrains Mono', Consolas, monospace;"
            )
            top.addWidget(monto)
        v.addLayout(top)

        if deuda > 0:
            n = int(c.get('items_count') or 0)
            detalle = f"{n} producto{'s' if n != 1 else ''} sin pagar"
        elif favor > 0:
            detalle = f"${fmt_money(favor)} a favor"
        else:
            detalle = 'Al día'
        extra = str(c.get('telefono') or '')
        sub = QLabel(detalle + (f"  ·  {extra}" if extra else ''))
        sub.setStyleSheet(
            f"color:{_T['text_muted']}; font-size:11px;"
            f" background:transparent; border:none;"
        )
        v.addWidget(sub)

        w.mousePressEvent = lambda e, cli=c: self._seleccionar(cli)
        return w

    def _seleccionar(self, cliente: dict):
        self._cliente = cliente
        self._checked = set()
        self._mostrar_historial = False
        self._render_lista()
        self._render_detalle()

    # ══════════════════════════════════════════════════
    #  DETALLE DEL CLIENTE
    # ══════════════════════════════════════════════════
    def _limpiar_detalle(self):
        while self.detalle_v.count():
            item = self.detalle_v.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()

    def _render_detalle(self):
        self._limpiar_detalle()
        if not self._cliente:
            vacio = QLabel('Elegí un cliente de la lista para ver su cuenta.')
            vacio.setAlignment(Qt.AlignCenter)
            vacio.setStyleSheet(
                f"color:{_T['text_dim']}; font-size:13px; background:{_T['surface']};"
                f" border:1px dashed {_T['border']}; border-radius:8px; padding:60px 20px;"
            )
            self.detalle_v.addWidget(vacio)
            self.detalle_v.addStretch(1)
            return

        try:
            self._pendientes = self.modelo.get_items(self._cliente, estado='pendiente')
        except Exception as e:
            logger.error(f'Fiados: error listando items: {e}')
            self._pendientes = []
        # Las tildadas que ya no están pendientes (otra PC cobró) se descartan.
        vivos = {int(i['id']) for i in self._pendientes}
        self._checked &= vivos

        self.detalle_v.addWidget(self._card_cliente())
        self.detalle_v.addWidget(self._card_acciones())

        if self._pendientes:
            for grupo in self._agrupar_por_entrega(self._pendientes):
                self.detalle_v.addWidget(self._card_grupo(grupo))
        else:
            ok = QLabel('Este cliente no tiene productos sin pagar.')
            ok.setAlignment(Qt.AlignCenter)
            ok.setStyleSheet(
                f"color:{_T['success']}; background:{_T['success_bg']};"
                f" border:1px solid {_T['success']}; border-radius:8px;"
                f" padding:22px 14px; font-size:13px; font-weight:600;"
            )
            self.detalle_v.addWidget(ok)

        self.detalle_v.addWidget(self._card_historial())
        self.detalle_v.addStretch(1)

    def _card_cliente(self) -> QWidget:
        c = self._cliente
        deuda = float(c.get('deuda') or 0)
        favor = float(c.get('saldo_favor') or 0)

        card = QFrame()
        card.setObjectName('cliCard')
        card.setStyleSheet(
            f"QFrame#cliCard {{ background:{_T['surface']};"
            f" border:1px solid {FIADO_BORDER}; border-left:4px solid {FIADO};"
            f" border-radius:8px; }}"
        )
        h = QHBoxLayout(card)
        h.setContentsMargins(16, 14, 16, 14)
        h.setSpacing(14)

        col = QVBoxLayout(); col.setSpacing(3)
        nombre = QLabel(str(c.get('nombre') or ''))
        nombre.setFont(QFont('Segoe UI', 15, QFont.Bold))
        nombre.setStyleSheet(f"color:{_T['text']}; background:transparent; border:none;")
        col.addWidget(nombre)

        datos = ' · '.join(x for x in [
            f"DNI {c.get('dni')}" if c.get('dni') else '',
            str(c.get('telefono') or ''),
            str(c.get('direccion') or ''),
        ] if x)
        sub = QLabel(datos or 'Sin datos de contacto cargados')
        sub.setStyleSheet(
            f"color:{_T['text_muted']}; font-size:11px; background:transparent; border:none;"
        )
        col.addWidget(sub)
        if c.get('notas'):
            nota = QLabel(str(c.get('notas')))
            nota.setWordWrap(True)
            nota.setStyleSheet(
                f"color:{_T['text_dim']}; font-size:11px; font-style:italic;"
                f" background:transparent; border:none;"
            )
            col.addWidget(nota)
        h.addLayout(col, 1)

        saldo_col = QVBoxLayout(); saldo_col.setSpacing(0)
        etiqueta = QLabel('DEBE' if deuda > 0 else ('A FAVOR' if favor > 0 else 'AL DÍA'))
        etiqueta.setAlignment(Qt.AlignRight)
        etiqueta.setStyleSheet(
            f"color:{_T['text_muted']}; font-size:10px; font-weight:700;"
            f" letter-spacing:0.6px; background:transparent; border:none;"
        )
        saldo_col.addWidget(etiqueta)
        monto = QLabel(f"${fmt_money(deuda if deuda > 0 else favor)}")
        monto.setAlignment(Qt.AlignRight)
        color_monto = FIADO if deuda > 0 else (_T['success'] if favor > 0 else _T['text_dim'])
        monto.setStyleSheet(
            f"color:{color_monto}; font-size:28px; font-weight:800;"
            f" background:transparent; border:none;"
            f" font-family:'JetBrains Mono', Consolas, monospace;"
        )
        saldo_col.addWidget(monto)
        h.addLayout(saldo_col)

        botones = QVBoxLayout(); botones.setSpacing(6)
        editar = QPushButton('Editar')
        editar.setMinimumHeight(34)
        editar.setCursor(Qt.PointingHandCursor)
        editar.setStyleSheet(
            f"QPushButton {{ background:{_T['surface_alt']}; color:{_T['text']};"
            f" border:1px solid {_T['border']}; border-radius:6px; padding:0 14px;"
            f" font-size:11px; font-weight:600; }}"
            f"QPushButton:hover {{ background:{_T['border_soft']}; }}"
        )
        editar.clicked.connect(self._editar_cliente)
        botones.addWidget(editar)

        eliminar = QPushButton('Eliminar')
        eliminar.setMinimumHeight(30)
        eliminar.setCursor(Qt.PointingHandCursor)
        eliminar.setToolTip('Sacar el cliente de la lista de fiado.\n'
                            'Solo se puede si no debe nada.')
        eliminar.setStyleSheet(
            f"QPushButton {{ background:transparent; color:{_T['danger']};"
            f" border:1px solid {_T['border']}; border-radius:6px; padding:0 14px;"
            f" font-size:11px; font-weight:600; }}"
            f"QPushButton:hover {{ background:{_T['danger_bg']}; border-color:{_T['danger']}; }}"
        )
        eliminar.clicked.connect(self._eliminar_cliente)
        botones.addWidget(eliminar)

        h.addLayout(botones)
        return card

    def _card_acciones(self) -> QWidget:
        seleccionado_total = sum(
            float(i.get('subtotal') or 0) for i in self._pendientes
            if int(i['id']) in self._checked
        )
        n_sel = len(self._checked)

        card = QFrame()
        card.setObjectName('accCard')
        card.setStyleSheet(
            f"QFrame#accCard {{ background:{_T['surface_alt']};"
            f" border:1px solid {_T['border']}; border-radius:8px; }}"
        )
        h = QHBoxLayout(card)
        h.setContentsMargins(14, 10, 14, 10)
        h.setSpacing(10)

        todos = QPushButton('Tildar todo' if n_sel < len(self._pendientes) else 'Destildar todo')
        todos.setMinimumHeight(38)
        todos.setCursor(Qt.PointingHandCursor)
        todos.setEnabled(bool(self._pendientes))
        todos.setStyleSheet(
            f"QPushButton {{ background:{_T['surface']}; color:{_T['text']};"
            f" border:1px solid {_T['border']}; border-radius:6px; padding:0 14px;"
            f" font-size:12px; font-weight:600; }}"
            f"QPushButton:hover {{ background:{_T['border_soft']}; }}"
            f"QPushButton:disabled {{ color:{_T['text_dim']}; }}"
        )
        todos.clicked.connect(self._toggle_todos)
        h.addWidget(todos)

        info = QLabel(
            f"{n_sel} seleccionado{'s' if n_sel != 1 else ''} · ${fmt_money(seleccionado_total)}"
            if n_sel else 'Tildá los productos que te está pagando'
        )
        info.setStyleSheet(
            f"color:{FIADO if n_sel else _T['text_muted']}; font-size:12px;"
            f" font-weight:{'700' if n_sel else '400'};"
            f" background:transparent; border:none;"
        )
        h.addWidget(info, 1)

        a_cuenta = QPushButton('Pago a cuenta')
        a_cuenta.setMinimumHeight(42); a_cuenta.setMinimumWidth(150)
        a_cuenta.setCursor(Qt.PointingHandCursor)
        a_cuenta.setFont(QFont('Segoe UI', 10, QFont.Bold))
        a_cuenta.setToolTip('Registrar una entrega de dinero suelta.\n'
                            'Queda como saldo a favor y se aplica en el próximo cobro.')
        a_cuenta.setStyleSheet(
            f"QPushButton {{ background:{_T['surface']}; color:{FIADO};"
            f" border:1.5px solid {FIADO}; border-radius:6px; padding:0 16px;"
            f" font-weight:700; }}"
            f"QPushButton:hover {{ background:{FIADO_SOFT}; }}"
        )
        a_cuenta.clicked.connect(self._pago_a_cuenta)
        h.addWidget(a_cuenta)

        cobrar = QPushButton(
            f"Cobrar ${fmt_money(seleccionado_total)}" if n_sel else 'Cobrar'
        )
        cobrar.setMinimumHeight(42); cobrar.setMinimumWidth(190)
        cobrar.setCursor(Qt.PointingHandCursor)
        cobrar.setFont(QFont('Segoe UI', 12, QFont.Bold))
        cobrar.setEnabled(n_sel > 0)
        cobrar.setStyleSheet(
            f"QPushButton {{ background:{FIADO}; color:white; border:none;"
            f" border-radius:6px; padding:0 18px; font-weight:800; }}"
            f"QPushButton:hover {{ background:{FIADO_HOVER}; }}"
            f"QPushButton:disabled {{ background:#cfc6dc; color:white; }}"
        )
        cobrar.clicked.connect(self._cobrar_seleccionados)
        h.addWidget(cobrar)
        return card

    def _agrupar_por_entrega(self, items: list) -> list:
        """Agrupa los pendientes por entrega (lo que se llevó de una sola vez)."""
        grupos = {}
        orden = []
        for it in items:
            clave = str(it.get('entrega_id') or '') or f"__{it.get('id')}"
            if clave not in grupos:
                grupos[clave] = {'fecha': it.get('fecha'), 'items': [],
                                 'origen': it.get('origen') or 'pos'}
                orden.append(clave)
            grupos[clave]['items'].append(it)
        return [grupos[k] for k in orden]

    def _card_grupo(self, grupo: dict) -> QWidget:
        items = grupo['items']
        total = sum(float(i.get('subtotal') or 0) for i in items)
        ids = [int(i['id']) for i in items]
        todos_tildados = all(i in self._checked for i in ids)

        card = QFrame()
        card.setObjectName('grpCard')
        card.setStyleSheet(
            f"QFrame#grpCard {{ background:{_T['surface']};"
            f" border:1px solid {_T['border']}; border-radius:8px; }}"
        )
        v = QVBoxLayout(card)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)

        # Cabecera del grupo
        hdr = QFrame()
        hdr.setStyleSheet(
            f"QFrame {{ background:{_T['surface_alt']};"
            f" border-bottom:1px solid {_T['border']};"
            f" border-top-left-radius:8px; border-top-right-radius:8px; }}"
        )
        hl = QHBoxLayout(hdr)
        hl.setContentsMargins(12, 8, 12, 8)
        hl.setSpacing(8)

        chk_grupo = QCheckBox()
        chk_grupo.setChecked(todos_tildados)
        chk_grupo.setCursor(Qt.PointingHandCursor)
        chk_grupo.setStyleSheet(self._css_checkbox())
        chk_grupo.clicked.connect(lambda on, _ids=ids: self._toggle_grupo(_ids, on))
        hl.addWidget(chk_grupo)

        fecha = QLabel(f"Se llevó el {_fecha_legible(grupo.get('fecha'))}")
        fecha.setStyleSheet(
            f"color:{_T['text']}; font-size:12px; font-weight:700;"
            f" background:transparent; border:none;"
        )
        hl.addWidget(fecha)

        if str(grupo.get('origen') or '') == 'web':
            chip = QLabel('cargado desde la web')
            chip.setStyleSheet(
                f"color:{_T['text_muted']}; background:{_T['surface']};"
                f" border:1px solid {_T['border']}; border-radius:8px;"
                f" padding:1px 8px; font-size:10px;"
            )
            hl.addWidget(chip)

        hl.addStretch(1)
        tot = QLabel(f"${fmt_money(total)}")
        tot.setStyleSheet(
            f"color:{FIADO}; font-size:13px; font-weight:800;"
            f" background:transparent; border:none;"
            f" font-family:'JetBrains Mono', Consolas, monospace;"
        )
        hl.addWidget(tot)
        v.addWidget(hdr)

        for it in items:
            v.addWidget(self._fila_item(it))
        return card

    def _css_checkbox(self) -> str:
        return (
            f"QCheckBox {{ background:transparent; border:none; spacing:0; }}"
            f"QCheckBox::indicator {{ width:18px; height:18px; border-radius:4px;"
            f" border:1.5px solid {_T['border']}; background:{_T['surface']}; }}"
            f"QCheckBox::indicator:hover {{ border-color:{FIADO}; }}"
            f"QCheckBox::indicator:checked {{ background:{FIADO}; border-color:{FIADO};"
            f" image:none; }}"
        )

    def _fila_item(self, it: dict) -> QWidget:
        iid = int(it['id'])
        w = QFrame()
        w.setStyleSheet(
            f"QFrame {{ background:transparent;"
            f" border-bottom:1px solid {_T['border_soft']}; }}"
        )
        h = QHBoxLayout(w)
        h.setContentsMargins(12, 8, 12, 8)
        h.setSpacing(10)

        chk = QCheckBox()
        chk.setChecked(iid in self._checked)
        chk.setCursor(Qt.PointingHandCursor)
        chk.setStyleSheet(self._css_checkbox())
        chk.clicked.connect(lambda on, _id=iid: self._toggle_item(_id, on))
        h.addWidget(chk)

        col = QVBoxLayout(); col.setSpacing(1)
        nombre = QLabel(str(it.get('product_name') or ''))
        nombre.setStyleSheet(
            f"color:{_T['text']}; font-size:12.5px; font-weight:600;"
            f" background:transparent; border:none;"
        )
        col.addWidget(nombre)
        detalle = (f"{fmt_qty(it.get('quantity'))} × ${fmt_money(it.get('unit_price'))}")
        if it.get('nota'):
            detalle += f"  ·  {it.get('nota')}"
        sub = QLabel(detalle)
        sub.setStyleSheet(
            f"color:{_T['text_muted']}; font-size:11px;"
            f" background:transparent; border:none;"
            f" font-family:'JetBrains Mono', Consolas, monospace;"
        )
        col.addWidget(sub)
        h.addLayout(col, 1)

        monto = QLabel(f"${fmt_money(it.get('subtotal'))}")
        monto.setStyleSheet(
            f"color:{_T['text']}; font-size:13px; font-weight:700;"
            f" background:transparent; border:none;"
            f" font-family:'JetBrains Mono', Consolas, monospace;"
        )
        h.addWidget(monto)

        quitar = QPushButton('Quitar')
        quitar.setMinimumHeight(28)
        quitar.setCursor(Qt.PointingHandCursor)
        quitar.setToolTip('Sacar este producto de la deuda sin cobrarlo\n'
                          '(se anotó por error o el cliente lo devolvió)')
        quitar.setStyleSheet(
            f"QPushButton {{ background:transparent; color:{_T['danger']};"
            f" border:1px solid {_T['border']}; border-radius:5px; padding:0 10px;"
            f" font-size:10px; font-weight:600; }}"
            f"QPushButton:hover {{ background:{_T['danger_bg']}; border-color:{_T['danger']}; }}"
        )
        quitar.clicked.connect(lambda _=False, _it=it: self._anular_item(_it))
        h.addWidget(quitar)
        return w

    def _card_historial(self) -> QWidget:
        card = QFrame()
        card.setObjectName('histCard')
        card.setStyleSheet(
            f"QFrame#histCard {{ background:{_T['surface']};"
            f" border:1px solid {_T['border']}; border-radius:8px; }}"
        )
        v = QVBoxLayout(card)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)

        hdr = QWidget()
        hdr.setCursor(Qt.PointingHandCursor)
        hdr.setStyleSheet('background:transparent;')
        hl = QHBoxLayout(hdr)
        hl.setContentsMargins(14, 10, 14, 10)
        titulo = QLabel('Historial de esta cuenta')
        titulo.setStyleSheet(
            f"color:{_T['text_muted']}; font-size:11px; font-weight:700;"
            f" letter-spacing:0.5px; background:transparent; border:none;"
        )
        hl.addWidget(titulo)
        hl.addStretch(1)
        chevron = QLabel('▾' if self._mostrar_historial else '▸')
        chevron.setStyleSheet(
            f"color:{_T['text_muted']}; font-size:11px; background:transparent; border:none;"
        )
        hl.addWidget(chevron)
        hdr.mousePressEvent = lambda e: self._toggle_historial()
        v.addWidget(hdr)

        if not self._mostrar_historial:
            return card

        try:
            pagados = self.modelo.get_items(self._cliente, estado='pagado', limit=200)
            anulados = self.modelo.get_items(self._cliente, estado='anulado', limit=100)
            pagos = self.modelo.get_pagos(self._cliente)
        except Exception as e:
            logger.error(f'Fiados: error leyendo historial: {e}')
            pagados, anulados, pagos = [], [], []

        if not pagados and not anulados and not pagos:
            vacio = QLabel('Todavía no hay movimientos cobrados.')
            vacio.setStyleSheet(
                f"color:{_T['text_dim']}; font-size:11.5px; background:transparent;"
                f" border:none; padding:0 14px 14px;"
            )
            v.addWidget(vacio)
            return card

        for p in pagos:
            v.addWidget(self._fila_pago(p))
        for it in pagados:
            v.addWidget(self._fila_historial(it, 'pagado'))
        for it in anulados:
            v.addWidget(self._fila_historial(it, 'anulado'))
        return card

    def _fila_pago(self, p: dict) -> QWidget:
        etiquetas = {
            'productos':        'Cobro de productos',
            'a_cuenta':         'Entrega a cuenta',
            'credito_aplicado': 'Saldo a favor aplicado',
        }
        w = QFrame()
        w.setStyleSheet(
            f"QFrame {{ background:{_T['surface_alt']};"
            f" border-top:1px solid {_T['border_soft']}; }}"
        )
        h = QHBoxLayout(w)
        h.setContentsMargins(14, 7, 14, 7)
        h.setSpacing(10)
        txt = QLabel(
            f"{etiquetas.get(str(p.get('tipo')), 'Movimiento')}"
            f"  ·  {_fecha_legible(p.get('fecha'))}"
            + (f"  ·  {p.get('metodo_pago')}" if p.get('metodo_pago') else '')
            + (f"  ·  venta #{p.get('venta_id')}" if p.get('venta_id') else '')
        )
        txt.setStyleSheet(
            f"color:{_T['text_muted']}; font-size:11px;"
            f" background:transparent; border:none;"
        )
        h.addWidget(txt, 1)
        monto = QLabel(f"${fmt_money(p.get('monto'))}")
        monto.setStyleSheet(
            f"color:{_T['success']}; font-size:12px; font-weight:700;"
            f" background:transparent; border:none;"
            f" font-family:'JetBrains Mono', Consolas, monospace;"
        )
        h.addWidget(monto)
        return w

    def _fila_historial(self, it: dict, estado: str) -> QWidget:
        w = QFrame()
        w.setStyleSheet(
            f"QFrame {{ background:transparent;"
            f" border-top:1px solid {_T['border_soft']}; }}"
        )
        h = QHBoxLayout(w)
        h.setContentsMargins(14, 6, 14, 6)
        h.setSpacing(10)

        etiqueta = 'Pagado' if estado == 'pagado' else 'Anulado'
        cuando = _fecha_legible(it.get('pagado_at') or it.get('fecha'))
        nombre = QLabel(
            f"{it.get('product_name')}  ·  {fmt_qty(it.get('quantity'))} un."
        )
        nombre.setStyleSheet(
            f"color:{_T['text_dim']}; font-size:11.5px;"
            f" background:transparent; border:none;"
        )
        h.addWidget(nombre, 1)

        meta = QLabel(f"{etiqueta} {cuando}")
        meta.setStyleSheet(
            f"color:{_T['text_dim']}; font-size:10.5px;"
            f" background:transparent; border:none;"
        )
        h.addWidget(meta)

        monto = QLabel(f"${fmt_money(it.get('subtotal'))}")
        monto.setStyleSheet(
            f"color:{_T['text_dim']}; font-size:11.5px;"
            f" background:transparent; border:none;"
            f" font-family:'JetBrains Mono', Consolas, monospace;"
            + ('' if estado == 'pagado' else ' text-decoration:line-through;')
        )
        h.addWidget(monto)
        return w

    # ══════════════════════════════════════════════════
    #  INTERACCIÓN
    # ══════════════════════════════════════════════════
    def _toggle_historial(self):
        self._mostrar_historial = not self._mostrar_historial
        self._render_detalle()

    def _toggle_item(self, item_id: int, activo: bool):
        if activo:
            self._checked.add(int(item_id))
        else:
            self._checked.discard(int(item_id))
        self._render_detalle()

    def _toggle_grupo(self, ids: list, activo: bool):
        for i in ids:
            if activo:
                self._checked.add(int(i))
            else:
                self._checked.discard(int(i))
        self._render_detalle()

    def _toggle_todos(self):
        ids = {int(i['id']) for i in self._pendientes}
        self._checked = set() if self._checked >= ids and ids else ids
        self._render_detalle()

    def _pc_id(self) -> str:
        try:
            from pos_system.utils.firebase_sync import _get_pc_id
            return _get_pc_id()
        except Exception:
            return ''

    def _cajero(self) -> str:
        return (self.current_user.get('turno_nombre')
                or self.current_user.get('full_name')
                or self.current_user.get('username', '')
                or 'Cajero')

    def _nuevo_cliente(self):
        dlg = FiadoClienteDialog(self)
        if dlg.exec_() != QDialog.Accepted or not dlg.datos:
            return
        try:
            nuevo_id = self.modelo.crear_cliente(pc_id=self._pc_id(), **dlg.datos)
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo crear el cliente:\n{e}')
            return
        cliente = self.modelo.get_cliente(nuevo_id)
        sincronizar_cliente(self.modelo, cliente)
        self.refresh_data(mantener_seleccion=False)
        nuevo = next((c for c in self._clientes
                      if int(c.get('id') or 0) == int(nuevo_id)), None)
        if nuevo:
            self._seleccionar(nuevo)

    def _editar_cliente(self):
        if not self._cliente:
            return
        dlg = FiadoClienteDialog(self, cliente=self._cliente)
        if dlg.exec_() != QDialog.Accepted or not dlg.datos:
            return
        try:
            self.modelo.actualizar_cliente(int(self._cliente['id']), **dlg.datos)
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo guardar:\n{e}')
            return
        actualizado = self.modelo.get_cliente(int(self._cliente['id']))
        sincronizar_cliente(self.modelo, actualizado)
        self.refresh_data()

    def _eliminar_cliente(self):
        """Baja del cliente, con confirmación.

        No se permite si tiene productos sin pagar: esconderlo haría
        desaparecer plata que alguien debe.
        """
        if not self._cliente:
            return
        pendiente = float(self._cliente.get('pendiente') or 0)
        if pendiente > 0:
            n = int(self._cliente.get('items_count') or 0)
            QMessageBox.warning(
                self, 'Tiene cuenta abierta',
                f"{self._cliente.get('nombre')} tiene ${fmt_money(pendiente)} en "
                f"{n} producto{'s' if n != 1 else ''} sin pagar.\n\n"
                f"Cobralos o sacalos de la cuenta con \"Quitar\" antes de "
                f"eliminar el cliente."
            )
            return

        credito = float(self._cliente.get('credito') or 0)
        extra = (f"\n\nOjo: tiene ${fmt_money(credito)} a favor sin usar."
                 if credito > 0 else '')
        resp = QMessageBox.question(
            self, 'Eliminar cliente',
            f"¿Eliminar a {self._cliente.get('nombre')} de la lista de fiado?{extra}\n\n"
            f"Sale de la lista en el POS y en la web. El historial de lo que ya "
            f"pagó se conserva.",
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No
        )
        if resp != QMessageBox.Yes:
            return

        cliente_id = int(self._cliente['id'])
        try:
            self.modelo.eliminar_cliente(cliente_id)
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo eliminar:\n{e}')
            return

        # Propagar la baja a Firebase para que también desaparezca de la webapp.
        try:
            borrado = self.modelo.get_cliente(cliente_id)
            if borrado:
                import threading as _th
                _th.Thread(target=sincronizar_cliente,
                           args=(self.modelo, borrado), daemon=True).start()
        except Exception as e:
            logger.warning(f'Fiado: no se pudo sincronizar la baja del cliente: {e}')

        self._cliente = None
        self._checked = set()
        self.refresh_data(mantener_seleccion=False)
        # Ventas puede tener el Modo Fiado activo con esta misma ficha: hay que
        # avisarle para que no siga mostrando un cliente que ya no existe.
        self._refrescar_otras_vistas()

    def _anular_item(self, it: dict):
        resp = QMessageBox.question(
            self, 'Quitar de la deuda',
            f"¿Sacar \"{it.get('product_name')}\" (${fmt_money(it.get('subtotal'))}) "
            f"de la cuenta sin cobrarlo?\n\n"
            f"Queda registrado como anulado en el historial.",
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No
        )
        if resp != QMessageBox.Yes:
            return
        try:
            self.modelo.anular_item(int(it['id']), motivo='Anulado desde el POS')
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo anular:\n{e}')
            return
        self._checked.discard(int(it['id']))
        self._sync_items_bg([int(it['id'])])
        self.refresh_data()

    def _sync_items_bg(self, ids):
        import threading as _th
        _th.Thread(target=sincronizar_items, args=(self.modelo, ids),
                   daemon=True).start()

    # ══════════════════════════════════════════════════
    #  COBRO
    # ══════════════════════════════════════════════════
    def _caja_abierta(self) -> bool:
        caja = self.db.get_current_cash_register()
        if not caja or caja.get('status') != 'open':
            QMessageBox.warning(
                self, 'Caja cerrada',
                'Para cobrar hay que tener la caja abierta.\n\n'
                'Andá a la pestaña Caja y abrila.'
            )
            return False
        return True

    def _cart_desde_items(self, items: list) -> tuple:
        """Convierte filas de fiado_items en líneas de carrito vendibles.

        Devuelve (cart, avisos). `avisos` junta los problemas de stock de
        productos por fracción que ya no alcanzan.
        """
        cart, avisos = [], []
        for it in items:
            linea = dict(it.get('cart_item') or {})
            # La fila manda sobre el snapshot: pudo editarse desde la web.
            linea['product_name'] = str(it.get('product_name') or 'Item')
            linea['quantity']     = float(it.get('quantity') or 0)
            linea['unit_price']   = float(it.get('unit_price') or 0)
            linea['subtotal']     = float(it.get('subtotal') or 0)
            linea.setdefault('original_price', linea['unit_price'])
            linea.setdefault('discount_type', None)
            linea.setdefault('discount_value', 0)
            linea.setdefault('discount_amount', 0)
            linea.setdefault('promo_id', None)
            linea.setdefault('category', it.get('categoria') or '')

            pid = int(linea.get('product_id') or it.get('product_id') or 0)
            # Item cargado desde la web: viene con el id del catálogo (Firestore),
            # hay que traducirlo al id local para descontar el stock correcto.
            if not pid and str(it.get('product_fid') or '').strip():
                rows = self.db.execute_query(
                    "SELECT id FROM products WHERE firebase_id = ? LIMIT 1",
                    (str(it['product_fid']).strip(),)
                ) or []
                if rows:
                    pid = int(rows[0]['id'])
            linea['product_id'] = pid
            if not pid and not linea.get('is_mp'):
                # Sin producto del catálogo → se cobra como item libre (Varios).
                linea['is_varios'] = True

            if linea.get('is_conjunto'):
                ok, err = revalidar_conjunto(self.db, linea)
                if not ok:
                    avisos.append((linea['product_name'], err))
                if 'conjunto_after_unidades' not in linea:
                    # No se pudo calcular el estado post-venta (producto ausente
                    # en el catálogo local, item cargado desde la web sin
                    # snapshot). Sin ese dato el descuento pondría el rollo en
                    # cero, así que se cobra la línea pero no se toca su stock.
                    logger.warning(
                        "Fiado: '%s' no se pudo revalidar como conjunto — "
                        "se cobra sin descontar stock del rollo/pack.",
                        linea.get('product_name')
                    )
                    for k in list(linea.keys()):
                        if k.startswith('conjunto_'):
                            linea.pop(k, None)
                    linea.pop('is_conjunto', None)
                    linea['is_varios'] = True
                    linea['product_id'] = 0
                    avisos.append((linea['product_name'],
                                   'no se pudo ubicar el rollo/pack en este catálogo — '
                                   'se cobra sin descontar su stock'))
            cart.append(linea)
        return cart, avisos

    def _cobrar_seleccionados(self):
        if not self._cliente or not self._checked:
            return
        items = [i for i in self._pendientes if int(i['id']) in self._checked]
        if not items:
            return

        total = round(sum(float(i.get('subtotal') or 0) for i in items), 2)
        credito = self.modelo.get_credito(self._cliente)
        credito_usado = 0.0

        if credito > 0:
            aplicar = min(credito, total)
            resp = QMessageBox.question(
                self, 'Saldo a favor',
                f"{self._cliente.get('nombre')} tiene ${fmt_money(credito)} a favor "
                f"de entregas anteriores.\n\n"
                f"¿Descontar ${fmt_money(aplicar)} de este cobro?\n"
                f"A pagar ahora: ${fmt_money(round(total - aplicar, 2))}",
                QMessageBox.Yes | QMessageBox.No, QMessageBox.Yes
            )
            if resp == QMessageBox.Yes:
                credito_usado = round(aplicar, 2)

        resto = round(total - credito_usado, 2)

        cart, avisos = self._cart_desde_items(items)
        if avisos:
            detalle = '\n'.join(f'•  {n}: {e}' for n, e in avisos)
            seguir = QMessageBox.question(
                self, 'Stock cambiado',
                'Estos productos por fracción ya no tienen el stock que había '
                'cuando se anotaron:\n\n' + detalle +
                '\n\n¿Cobrar igual? El stock puede quedar en cero.',
                QMessageBox.Yes | QMessageBox.No, QMessageBox.No
            )
            if seguir != QMessageBox.Yes:
                return

        sale_id = None
        metodo = 'Saldo a favor'

        if resto > 0.009:
            if not self._caja_abierta():
                return
            if credito_usado > 0:
                # Línea negativa: deja el total de la venta igual a la plata que
                # entra ahora. La parte cubierta con saldo a favor ya se cobró
                # el día que el cliente dejó ese dinero.
                cart.append({
                    'product_id':      0,
                    'product_name':    'Saldo a favor aplicado',
                    'quantity':        1,
                    'unit_price':      -credito_usado,
                    'original_price':  -credito_usado,
                    'discount_type':   None,
                    'discount_value':  0,
                    'discount_amount': 0,
                    'promo_id':        None,
                    'subtotal':        -credito_usado,
                    'category':        'Fiado',
                    'is_varios':       True,
                })

            from pos_system.ui.sales_view import PaymentDialog
            dlg = PaymentDialog(self, total=resto, cart=cart)
            if dlg.exec_() != QDialog.Accepted:
                return

            metodo = {'cash': 'Efectivo', 'transfer': 'Transferencia',
                      'mixed': 'Mixto'}.get(dlg.payment_type, dlg.payment_type)
            try:
                sale_id = self.sale_model.create({
                    'total_amount':      resto,
                    'payment_type':      dlg.payment_type,
                    'payment_subtype':   dlg.payment_subtype,
                    'cash_received':     dlg.cash_received,
                    'change_given':      dlg.change_given,
                    'transfer_amount':   getattr(dlg, 'transfer_amount', 0.0) or 0.0,
                    'items':             cart,
                    'user_id':           self.current_user.get('id'),
                    'turno_nombre':      self._cajero(),
                    'es_fiado':          True,
                    'fiado_tipo':        'productos',
                    'fiado_cliente':     str(self._cliente.get('nombre') or ''),
                    'fiado_cliente_fid': str(self._cliente.get('firebase_id') or ''),
                })
            except Exception as e:
                logger.exception('Fiado: error creando la venta del cobro')
                QMessageBox.critical(self, 'Error',
                                     f'No se pudo registrar el cobro:\n{e}')
                return
            self._subir_venta(sale_id, dlg)
        else:
            # Todo cubierto con saldo a favor: no hay venta nueva (la plata ya
            # entró a la caja cuando el cliente la dejó a cuenta), pero la
            # mercadería sale ahora y el stock tiene que reflejarlo.
            try:
                self.sale_model.descontar_stock_items(cart, usuario=self._cajero())
            except Exception as e:
                logger.exception('Fiado: error descontando stock con saldo a favor')
                QMessageBox.critical(self, 'Error',
                                     f'No se pudo descontar el stock:\n{e}')
                return

        # ── Cerrar el fiado: marcar items y registrar el movimiento ──
        ids = [int(i['id']) for i in items]
        try:
            self.modelo.marcar_items_pagados(ids, sale_id)
            pago_id = self.modelo.registrar_pago(
                cliente=self._cliente,
                tipo='productos' if resto > 0.009 else 'credito_aplicado',
                monto=resto if resto > 0.009 else credito_usado,
                metodo_pago=metodo,
                venta_id=sale_id,
                item_ids=ids,
                credito_usado=credito_usado if resto > 0.009 else 0.0,
                cajero=self._cajero(),
                pc_id=self._pc_id(),
            )
        except Exception as e:
            logger.exception('Fiado: error cerrando el cobro')
            QMessageBox.critical(
                self, 'Atención',
                f'El cobro se registró pero no se pudo cerrar la cuenta:\n{e}\n\n'
                f'Revisá los productos pendientes de este cliente.'
            )
            self.refresh_data()
            return

        import threading as _th
        _th.Thread(target=sincronizar_pago, args=(self.modelo, pago_id),
                   daemon=True).start()
        self._sync_items_bg(ids)

        self._checked = set()
        self.refresh_data()
        self._refrescar_otras_vistas()
        self._aviso_cobro_ok(total, resto, credito_usado, sale_id)

    def _pago_a_cuenta(self):
        if not self._cliente:
            return
        deuda = float(self._cliente.get('deuda') or 0)
        ayuda = ('Registrá la plata que te deja el cliente sin saldar productos '
                 'puntuales. Queda como saldo a favor y se descuenta sola en el '
                 'próximo cobro.')
        if deuda > 0:
            ayuda += f"\nDeuda actual: ${fmt_money(deuda)}."
        dlg = MontoDialog(self, titulo='Pago a cuenta', ayuda=ayuda)
        if dlg.exec_() != QDialog.Accepted or dlg.monto <= 0:
            return
        monto = dlg.monto

        if not self._caja_abierta():
            return

        cart = [{
            'product_id':      0,
            'product_name':    f"Pago a cuenta · {self._cliente.get('nombre')}",
            'quantity':        1,
            'unit_price':      monto,
            'original_price':  monto,
            'discount_type':   None,
            'discount_value':  0,
            'discount_amount': 0,
            'promo_id':        None,
            'subtotal':        monto,
            'category':        'Fiado',
            'is_varios':       True,
        }]

        from pos_system.ui.sales_view import PaymentDialog
        pago_dlg = PaymentDialog(self, total=monto, cart=cart)
        if pago_dlg.exec_() != QDialog.Accepted:
            return

        metodo = {'cash': 'Efectivo', 'transfer': 'Transferencia',
                  'mixed': 'Mixto'}.get(pago_dlg.payment_type, pago_dlg.payment_type)
        try:
            sale_id = self.sale_model.create({
                'total_amount':      monto,
                'payment_type':      pago_dlg.payment_type,
                'payment_subtype':   pago_dlg.payment_subtype,
                'cash_received':     pago_dlg.cash_received,
                'change_given':      pago_dlg.change_given,
                'transfer_amount':   getattr(pago_dlg, 'transfer_amount', 0.0) or 0.0,
                'items':             cart,
                'user_id':           self.current_user.get('id'),
                'turno_nombre':      self._cajero(),
                'es_fiado':          True,
                'fiado_tipo':        'a_cuenta',
                'fiado_cliente':     str(self._cliente.get('nombre') or ''),
                'fiado_cliente_fid': str(self._cliente.get('firebase_id') or ''),
            })
        except Exception as e:
            logger.exception('Fiado: error registrando el pago a cuenta')
            QMessageBox.critical(self, 'Error', f'No se pudo registrar el pago:\n{e}')
            return

        self._subir_venta(sale_id, pago_dlg)

        try:
            pago_id = self.modelo.registrar_pago(
                cliente=self._cliente, tipo='a_cuenta', monto=monto,
                metodo_pago=metodo, venta_id=sale_id,
                cajero=self._cajero(), pc_id=self._pc_id(),
            )
            import threading as _th
            _th.Thread(target=sincronizar_pago, args=(self.modelo, pago_id),
                       daemon=True).start()
        except Exception as e:
            logger.exception('Fiado: error guardando el pago a cuenta')
            QMessageBox.critical(
                self, 'Atención',
                f'La venta se registró pero el saldo a favor no quedó guardado:\n{e}'
            )

        self.refresh_data()
        self._refrescar_otras_vistas()
        QMessageBox.information(
            self, 'Pago a cuenta registrado',
            f"Se registraron ${fmt_money(monto)} a favor de "
            f"{self._cliente.get('nombre')}.\n\n"
            f"Se descuentan automáticamente en el próximo cobro."
        )

    def _subir_venta(self, sale_id, dlg=None):
        """Sube la venta del cobro a Firebase con el mismo flujo que el POS."""
        if not sale_id:
            return
        import threading as _th

        def _do():
            try:
                sale = self.sale_model.get_by_id(int(sale_id))
                if not sale:
                    return
                caja = self.db.get_current_cash_register()
                if not caja or caja.get('status') != 'open':
                    return
                from pos_system.utils.firebase_sync import get_firebase_sync
                fb = get_firebase_sync()
                if not fb or not fb.enabled:
                    return
                sale = dict(sale)
                sale['cash_register_id'] = caja.get('id')
                sale['username'] = sale['turno_nombre'] = sale['cajero'] = self._cajero()
                fb.sync_sale(sale)
                fb.sync_sale_detail_by_day(sale, db_manager=self.db)
                try:
                    fb.sync_stock_after_sale(sale.get('items') or [], self.db)
                except Exception as e:
                    logger.warning(f'Fiado: stock post-cobro: {e}')
                self.db.execute_update(
                    "UPDATE sales SET firebase_synced=1 WHERE id=?", (int(sale_id),)
                )
            except Exception as e:
                logger.warning(f'Fiado: no se pudo subir la venta #{sale_id}: {e}')

        _th.Thread(target=_do, daemon=True).start()

    def _refrescar_otras_vistas(self):
        """Caja, historial y catálogo tienen que ver la venta del cobro.

        Se llama al final del flujo: refrescar en el medio destruiría los
        widgets sobre los que todavía estamos operando.
        """
        try:
            w = self.parent()
            while w is not None and not hasattr(w, 'refresh_all_views'):
                w = w.parent()
            if w is not None:
                w.refresh_all_views()
        except Exception as e:
            logger.warning(f'Fiado: no se pudieron refrescar las otras vistas: {e}')

    def _aviso_cobro_ok(self, total, resto, credito_usado, sale_id):
        detalle = f"Cobrado: ${fmt_money(total)}"
        if credito_usado > 0:
            detalle += (f"\n  · Saldo a favor aplicado: ${fmt_money(credito_usado)}"
                        f"\n  · Cobrado ahora: ${fmt_money(resto)}")
        if sale_id:
            detalle += f"\n\nVenta #{sale_id} — el stock ya se descontó."
        else:
            detalle += "\n\nSe cubrió con saldo a favor — el stock ya se descontó."
        QMessageBox.information(self, 'Cobro registrado', detalle)
