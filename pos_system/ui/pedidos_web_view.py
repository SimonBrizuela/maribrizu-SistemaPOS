"""
Pestaña "Pedidos web": los pedidos de la tienda online desde la caja.

A la izquierda la lista (Para hacer · A cobrar · Entregados) y a la derecha el
pedido abierto, con un botón grande para el paso que sigue. Todo lo que cambia
un pedido pasa por `NubePedidos` (una transacción que relee el pedido), así que
un botón viejo nunca pisa lo que hizo otra caja: vuelve con el motivo.

El cobro abre la pantalla de cobro de siempre, precargada con lo que pagó el
cliente. Mientras está abierta, el pedido queda marcado para esta caja y las
demás lo ven. La venta local se crea recién con el cobro anotado en la nube; si
la PC se corta justo en el medio, se termina sola (`_procesar_cobros_pendientes`).

Mientras hay un diálogo abierto no se redibuja nada: un redibujo borra los
botones y uno de ellos puede ser el que abrió el diálogo.
"""
import logging
import socket
import sys
import threading
from datetime import datetime, timedelta

from PyQt5.QtCore import QObject, Qt, QTimer, QUrl, pyqtSignal
from PyQt5.QtGui import QDesktopServices, QFont
from PyQt5.QtWidgets import (
    QApplication, QDialog, QFrame, QHBoxLayout, QLabel, QLineEdit, QMessageBox,
    QPushButton, QScrollArea, QSizePolicy, QVBoxLayout, QWidget,
)

from pos_system.database.db_manager import DatabaseManager
from pos_system.models import cobros_pedido
from pos_system.models import pedido_tienda as reglas
from pos_system.models.sale import Sale, VentaDePedidoRepetida
from pos_system.ui.theme import COLORS as _T

logger = logging.getLogger(__name__)

MONO = "font-family:'JetBrains Mono', Consolas, monospace;"

COLOR_ESTADO = {
    'nuevo': '#2f7a3d', 'preparando': '#1f5fbf', 'listo': '#6a3d9a',
    'en_camino': '#b85c00', 'entregado': '#6f6a5d', 'cancelado': '#a01616',
}
COLOR_COBRAR = _T['accent']
COLOR_WHATSAPP = '#1f7a45'

FILTROS = [('hacer', 'A hacer'), ('cobrar', 'A cobrar'), ('hechos', 'Entregados')]

# Cada cuánto se revisan los cobros que esta PC dejó a medias.
REVISION_COBROS_MS = 60_000

# Cada cuánto se renueva la marca de "lo estoy cobrando" con la pantalla de
# cobro abierta; tiene que ser bastante menos que `reglas.MINUTOS_MARCA`.
RENOVAR_MARCA_MS = 90_000


def pesos(n):
    return '$' + f'{reglas.num(n):,.0f}'.replace(',', '.')


def hace(marca, ahora=None):
    f = reglas._fecha(marca)
    if f is None:
        return ''
    ahora = ahora or datetime.now(reglas.TZ_AR)
    minutos = int((ahora - f).total_seconds() // 60)
    if minutos < 1:
        return 'recién'
    if minutos < 60:
        return f'hace {minutos} min'
    local = f.astimezone(reglas.TZ_AR)
    if local.date() == ahora.astimezone(reglas.TZ_AR).date():
        return local.strftime('%H:%M')
    if local.date() == (ahora.astimezone(reglas.TZ_AR) - timedelta(days=1)).date():
        return local.strftime('ayer %H:%M')
    return local.strftime('%d/%m %H:%M')


def whatsapp_de_escritorio():
    """¿Esta PC tiene la app de WhatsApp? La del local sí; se pregunta a Windows
    quién abre los enlaces `whatsapp:` (encuentra también la de la Microsoft
    Store). Sin la app, el chat se abre en WhatsApp Web."""
    if sys.platform != 'win32':
        return False
    try:
        import ctypes
        from ctypes import wintypes
        consulta = ctypes.windll.shlwapi.AssocQueryStringW
        consulta.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR,
                             wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        consulta.restype = ctypes.c_long
        nombre = ctypes.create_unicode_buffer(260)
        largo = wintypes.DWORD(260)
        ASSOCF_IS_PROTOCOL, ASSOCSTR_FRIENDLYAPPNAME = 0x1000, 4
        return consulta(ASSOCF_IS_PROTOCOL, ASSOCSTR_FRIENDLYAPPNAME, 'whatsapp', 'open',
                        nombre, ctypes.byref(largo)) == 0
    except Exception:
        return False


def enlace_whatsapp(numero, texto, app):
    mensaje = QUrl.toPercentEncoding(texto or '').data().decode()
    if app:
        return f'whatsapp://send?phone={numero}&text={mensaje}'
    return f'https://wa.me/{numero}?text={mensaje}'


def enlace_mapa(entrega):
    coords = (entrega or {}).get('coordenadas') or {}
    if coords.get('lat') is not None and coords.get('lng') is not None:
        return f"https://maps.google.com/?q={coords['lat']},{coords['lng']}"
    direccion = str((entrega or {}).get('direccion') or '').strip()
    if not direccion:
        return None
    return f"https://maps.google.com/?q={QUrl.toPercentEncoding(direccion).data().decode()}"


def etiqueta_pago(pago):
    tipo = (pago or {}).get('payment_type')
    if tipo == 'cash':
        return 'efectivo'
    if tipo == 'mixed':
        return 'pago mixto'
    sub = str((pago or {}).get('payment_subtype') or '').strip()
    return sub.lower() if sub else 'transferencia'


def accion_principal(pedido):
    """(clave, texto) del botón grande según cómo está el pedido."""
    p = pedido or {}
    estado = p.get('estado')
    if estado == 'nuevo':
        return 'aceptar', 'Aceptar pedido'
    if estado == 'preparando':
        return 'listo', 'Marcar listo'
    if estado == 'listo':
        return ('salio', 'Salió el reparto') if reglas.es_envio(p) else ('cobrar', 'Entregar y cobrar')
    if estado == 'en_camino':
        return 'cobrar', 'Entregado · cobrar'
    if reglas.a_cobrar(p):
        return 'cobrar', f"Cobrar {pesos(p.get('total'))}"
    return None, ''


class _Tarea(QObject):
    """Corre algo que habla con la nube fuera del hilo de la pantalla y trae
    el resultado de vuelta por señal."""
    listo = pyqtSignal(object)


class PedidosWebView(QWidget):
    titulo_cambio = pyqtSignal(str, str)     # (texto de la pestaña, tooltip)
    aviso = pyqtSignal(str, str)             # (tipo, mensaje) para un Toast

    def __init__(self, parent=None, current_user: dict = None, db=None):
        super().__init__(parent)
        self.db = db or DatabaseManager()
        self.sale_model = Sale(self.db)
        self.current_user = current_user or {}
        self._nube = None
        self._vigia = None
        self._pedidos = {}
        self._seleccion = None
        self._filtro = 'hacer'
        self._en_linea = None
        self._modal = 0
        self._redibujo_pendiente = False
        self._ocupados = set()
        self._cobrando = set()
        self._recuperando = set()
        self._nuevos_vistos = None
        self._cobrar_vistos = set()
        self._cfg_tienda = {}
        self._tareas = []
        self._firma_lista = None
        self._firma_detalle = None
        self._whatsapp_app = None
        self._build_ui()
        self._redibujar()

    # ══════════════════════════════════════════════════
    #  CONEXIÓN
    # ══════════════════════════════════════════════════
    def conectar(self, vigia, nube):
        """La ventana principal lo llama con Firebase listo."""
        self._vigia = vigia
        self._nube = nube
        vigia.cambiaron.connect(self._al_cambiar)
        vigia.estado_conexion.connect(self._al_cambiar_conexion)
        vigia.iniciar()
        self._en_fondo(self._leer_config_tienda, lambda cfg: self._cfg_tienda.update(cfg or {}))
        self._reloj_cobros = QTimer(self)
        self._reloj_cobros.timeout.connect(self._procesar_cobros_pendientes)
        self._reloj_cobros.start(REVISION_COBROS_MS)
        QTimer.singleShot(3000, self._procesar_cobros_pendientes)

    def _leer_config_tienda(self):
        snap = self._nube.db.collection('tienda_config').document('settings').get()
        datos = snap.to_dict() or {} if snap.exists else {}
        return {k: datos.get(k) for k in ('nombre', 'direccion', 'telefono') if datos.get(k)}

    def quien(self):
        try:
            from pos_system.utils.firebase_sync import _get_pc_id
            pc_id = _get_pc_id()
        except Exception:
            pc_id = socket.gethostname()
        return {'pc_id': pc_id, 'pc_nombre': socket.gethostname(), 'cajero': self._cajero()}

    def _cajero(self):
        return (self.current_user.get('turno_nombre') or self.current_user.get('full_name')
                or self.current_user.get('username', '') or 'Cajero')

    def refresh_data(self):
        self._redibujar()

    # ══════════════════════════════════════════════════
    #  ARMADO
    # ══════════════════════════════════════════════════
    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 14, 16, 14)
        root.setSpacing(12)

        head = QHBoxLayout()
        head.setSpacing(10)
        col = QVBoxLayout()
        col.setSpacing(1)
        titulo = QLabel('Pedidos web')
        # El tamaño va en el estilo: el QSS global de QLabel le gana a setFont.
        titulo.setStyleSheet(f"color:{_T['text']}; background:transparent; font-size:20px; font-weight:800;")
        col.addWidget(titulo)
        self.resumen_lbl = QLabel('Conectando con la tienda…')
        self.resumen_lbl.setStyleSheet(f"color:{_T['text_muted']}; font-size:12px; background:transparent;")
        col.addWidget(self.resumen_lbl)
        head.addLayout(col)
        head.addStretch(1)
        self.conexion_lbl = QLabel('')
        self.conexion_lbl.setVisible(False)
        self.conexion_lbl.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        head.addWidget(self.conexion_lbl, 0, Qt.AlignVCenter)
        root.addLayout(head)

        body = QHBoxLayout()
        body.setSpacing(12)

        izq = QFrame()
        izq.setObjectName('pwLista')
        izq.setMinimumWidth(300)
        izq.setMaximumWidth(380)
        izq.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Expanding)
        izq.setStyleSheet(f"QFrame#pwLista {{ background:{_T['surface']}; border:1px solid {_T['border']};"
                          f" border-radius:8px; }}")
        izq_v = QVBoxLayout(izq)
        izq_v.setContentsMargins(10, 10, 10, 10)
        izq_v.setSpacing(8)

        filtros = QHBoxLayout()
        filtros.setSpacing(0)
        self._botones_filtro = {}
        for i, (clave, texto) in enumerate(FILTROS):
            b = QPushButton(texto)
            b.setCheckable(True)
            b.setCursor(Qt.PointingHandCursor)
            b.setMinimumHeight(36)
            izq_r = '6px' if i == 0 else '0'
            der_r = '6px' if i == len(FILTROS) - 1 else '0'
            b.setStyleSheet(
                f"QPushButton {{ background:{_T['surface_alt']}; color:{_T['text_muted']};"
                f" border:1px solid {_T['border']}; font-size:12px; font-weight:700; padding:6px 2px;"
                f" min-height:20px;"
                f" border-top-left-radius:{izq_r}; border-bottom-left-radius:{izq_r};"
                f" border-top-right-radius:{der_r}; border-bottom-right-radius:{der_r}; }}"
                f"QPushButton:checked {{ background:{_T['text']}; color:white; border-color:{_T['text']}; }}"
            )
            b.clicked.connect(lambda _c, k=clave: self._elegir_filtro(k))
            filtros.addWidget(b, 1)
            self._botones_filtro[clave] = b
        izq_v.addLayout(filtros)

        self.buscar = QLineEdit()
        self.buscar.setPlaceholderText('Código, nombre o teléfono…')
        self.buscar.setMinimumHeight(36)
        self.buscar.setStyleSheet(
            f"QLineEdit {{ border:1px solid {_T['border']}; background:{_T['surface_alt']};"
            f" border-radius:6px; padding:4px 10px; font-size:13px; color:{_T['text']}; }}"
            f"QLineEdit:focus {{ border-color:{_T['accent']}; background:{_T['surface']}; }}"
        )
        self.buscar.textChanged.connect(lambda _t: self._redibujar_lista())
        izq_v.addWidget(self.buscar)

        scroll_l = QScrollArea()
        scroll_l.setWidgetResizable(True)
        scroll_l.setFrameShape(QFrame.NoFrame)
        scroll_l.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll_l.setStyleSheet('QScrollArea { background:transparent; border:none; }')
        inner = QWidget()
        inner.setStyleSheet('background:transparent;')
        self.lista_v = QVBoxLayout(inner)
        self.lista_v.setContentsMargins(0, 0, 0, 0)
        self.lista_v.setSpacing(6)
        self.lista_v.addStretch(1)
        scroll_l.setWidget(inner)
        izq_v.addWidget(scroll_l, 1)
        body.addWidget(izq, 2)

        self.detalle_scroll = QScrollArea()
        self.detalle_scroll.setWidgetResizable(True)
        self.detalle_scroll.setFrameShape(QFrame.NoFrame)
        self.detalle_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.detalle_scroll.setStyleSheet('QScrollArea { background:transparent; border:none; }')
        host = QWidget()
        host.setStyleSheet('background:transparent;')
        self.detalle_v = QVBoxLayout(host)
        self.detalle_v.setContentsMargins(0, 0, 4, 0)
        self.detalle_v.setSpacing(10)
        self.detalle_scroll.setWidget(host)
        body.addWidget(self.detalle_scroll, 5)
        root.addLayout(body, 1)

        self._reloj_lista = QTimer(self)
        self._reloj_lista.timeout.connect(self._redibujar_lista)
        self._reloj_lista.start(60_000)

    # ══════════════════════════════════════════════════
    #  DATOS QUE LLEGAN
    # ══════════════════════════════════════════════════
    def _al_cambiar(self, pedidos):
        self._avisar_novedades(pedidos)
        self._pedidos = dict(pedidos)
        self._redibujar()

    def _al_cambiar_conexion(self, en_linea):
        if en_linea == self._en_linea:
            return
        self._en_linea = en_linea
        self.conexion_lbl.setVisible(True)
        if en_linea:
            self.conexion_lbl.setText('En vivo')
            self.conexion_lbl.setStyleSheet(
                f"color:{_T['success']}; background:{_T['success_bg']}; border-radius:10px;"
                " padding:3px 10px; font-size:11px; font-weight:700;")
        else:
            self.conexion_lbl.setText('Sin conexión con la tienda')
            self.conexion_lbl.setStyleSheet(
                f"color:{_T['danger']}; background:{_T['danger_bg']}; border-radius:10px;"
                " padding:3px 10px; font-size:11px; font-weight:700;")

    def _ahora(self):
        """La hora del servidor según el vigía: las marcas de cobro y factura
        se escriben con esa hora, y con el reloj de una PC atrasada una marca
        vencida seguía trabando los botones."""
        ahora = getattr(self._vigia, 'ahora', None)
        try:
            return ahora() if callable(ahora) else datetime.now(reglas.TZ_AR)
        except Exception:
            return datetime.now(reglas.TZ_AR)

    def _avisar_novedades(self, pedidos):
        # Hasta que no contestaron las cuatro escuchas la lista está a medias:
        # tomarla como "lo ya visto" hacía sonar un aviso por pedido al abrir.
        completo = getattr(self._vigia, 'completo', None)
        if self._nuevos_vistos is None and callable(completo) and not completo():
            return
        nuevos = {pid for pid, p in pedidos.items()
                  if p.get('estado') == 'nuevo' and p.get('visto') is not True}
        cobrar = {pid for pid, p in pedidos.items() if reglas.grupo(p) == 'cobrar'}
        if self._nuevos_vistos is None:
            self._nuevos_vistos = set(nuevos)
            self._cobrar_vistos = set(cobrar)
            if nuevos:
                n = len(nuevos)
                self.aviso.emit('pedido', f"{n} pedido{'s' if n != 1 else ''} web sin ver")
            return
        for pid in sorted(nuevos - self._nuevos_vistos):
            p = pedidos[pid]
            modo = 'envío' if reglas.es_envio(p) else 'retira'
            self.aviso.emit('pedido', f"Pedido nuevo {p.get('codigo', '')} · "
                                      f"{(p.get('cliente') or {}).get('nombre', '')} · "
                                      f"{pesos(p.get('total'))} · {modo}")
        for pid in sorted(cobrar - self._cobrar_vistos):
            p = pedidos[pid]
            if p.get('entregado_por') == 'reparto':
                self.aviso.emit('cobrar', f"El repartidor entregó {p.get('codigo', '')}. Falta cobrarlo.")
            elif not (p.get('movido_por') or {}).get('pc_id') == self.quien()['pc_id']:
                self.aviso.emit('cobrar', f"{p.get('codigo', '')} ya se entregó. Falta cobrarlo.")
        self._nuevos_vistos |= nuevos
        self._cobrar_vistos = set(cobrar)

    # ══════════════════════════════════════════════════
    #  DIBUJO
    # ══════════════════════════════════════════════════
    def _redibujar(self):
        self._emitir_titulo()
        # Con la pestaña oculta no se arman widgets: cada cambio de un pedido
        # redibujaba la lista entera mientras el cajero vendía en Ventas.
        if self._modal or not self.isVisible():
            self._redibujo_pendiente = True
            return
        self._redibujo_pendiente = False
        if self._seleccion is None or self._seleccion not in self._pedidos:
            self._elegir_primero()
        # Cada cambio de un pedido llega de la nube (una caja que renueva su
        # marca, otra que marca visto): rearmar botones que no cambiaron hacía
        # que el clic que estaba en el aire se perdiera.
        if self._firma_de_lista() != self._firma_lista:
            self._redibujar_lista()
        if self._firma_de_detalle() != self._firma_detalle:
            self._redibujar_detalle()

    @staticmethod
    def _sin_renovacion(p):
        """El pedido sin la hora de renovación de la marca de cobro, que cambia
        cada 90 segundos sin cambiar nada de lo que se ve."""
        if not isinstance((p or {}).get('cobro'), dict):
            return p
        return {**p, 'cobro': {k: val for k, val in p['cobro'].items() if k != 'desde'}}

    def _firma_comun(self):
        import time
        return (self._nube is None, int(time.time() // 60))

    def _firma_de_lista(self):
        return (self._firma_comun(), self._filtro, self.buscar.text(), self._seleccion,
                [self._sin_renovacion(p) for p in self._visibles()],
                sorted(reglas.grupo(p) for p in self._pedidos.values()))

    def _firma_de_detalle(self):
        p = self._pedidos.get(self._seleccion) if self._seleccion else None
        return (self._firma_comun(), self._seleccion, self._sin_renovacion(p), bool(self._pedidos),
                self._seleccion in self._ocupados, self._seleccion in self._cobrando)

    def showEvent(self, event):
        super().showEvent(event)
        if self._redibujo_pendiente:
            QTimer.singleShot(0, self._redibujar)

    def _elegir_primero(self):
        """Con la pestaña abierta y nada elegido, se abre el primero de la lista:
        un toque menos, y el pedido nuevo ya queda a la vista."""
        visibles = self._visibles()
        self._seleccion = visibles[0].get('id') if visibles else None

    def _emitir_titulo(self):
        lista = list(self._pedidos.values())
        r = reglas.resumen_pestana(lista)
        hacer = sum(1 for p in lista if reglas.grupo(p) == 'hacer')
        partes = [f"{hacer} a hacer", f"{r['cobrar']} a cobrar"]
        if self._nube is not None:
            self.resumen_lbl.setText(' · '.join(partes))
        tooltip = (f"{r['nuevos']} nuevo(s) sin ver\n{r['cobrar']} entregado(s) sin cobrar"
                   if (r['nuevos'] or r['cobrar']) else '')
        self.titulo_cambio.emit(reglas.titulo_pestana(lista), tooltip)

    def _elegir_filtro(self, clave):
        self._filtro = clave
        if self._seleccion not in {p.get('id') for p in self._visibles()}:
            self._elegir_primero()
        self._redibujar_lista()
        self._redibujar_detalle()

    def _visibles(self):
        texto = self.buscar.text().strip().lower()
        salida = []
        for p in self._pedidos.values():
            if reglas.grupo(p) != self._filtro:
                continue
            if texto:
                campos = [p.get('codigo'), (p.get('cliente') or {}).get('nombre'),
                          (p.get('cliente') or {}).get('telefono')]
                if not any(texto in str(c or '').lower() for c in campos):
                    continue
            salida.append(p)
        clave = (lambda p: reglas._fecha(p.get('entregado_en') or p.get('creado'))
                 or datetime.min.replace(tzinfo=reglas.TZ_AR))
        return sorted(salida, key=clave, reverse=(self._filtro == 'hechos'))

    def _redibujar_lista(self):
        if self._modal:
            self._redibujo_pendiente = True
            return
        cuentas = {k: sum(1 for p in self._pedidos.values() if reglas.grupo(p) == k) for k, _ in FILTROS}
        for clave, texto in FILTROS:
            b = self._botones_filtro[clave]
            b.setChecked(clave == self._filtro)
            b.setText(f'{texto} ({cuentas[clave]})' if cuentas[clave] else texto)

        if not self.isVisible():
            self._redibujo_pendiente = True
            return
        while self.lista_v.count() > 1:
            w = self.lista_v.takeAt(0).widget()
            if w is not None:
                # Oculto ya: deleteLater lo borra en la vuelta siguiente y hasta
                # entonces quedaba dibujado encima de las filas nuevas.
                w.hide()
                w.deleteLater()

        self._firma_lista = self._firma_de_lista()
        visibles = self._visibles()
        if not visibles:
            if self._nube is None:
                texto = 'Conectando con la tienda…'
            elif self.buscar.text().strip():
                texto = 'Ningún pedido coincide con la búsqueda.'
            else:
                texto = {'hacer': 'No hay pedidos para preparar.',
                         'cobrar': 'No hay pedidos entregados sin cobrar.',
                         'hechos': 'No hay pedidos entregados esta semana.'}[self._filtro]
            vacio = QLabel(texto)
            vacio.setWordWrap(True)
            vacio.setAlignment(Qt.AlignCenter)
            vacio.setStyleSheet(f"color:{_T['text_dim']}; font-size:12px; border:1px dashed {_T['border']};"
                                " border-radius:8px; padding:26px 10px; background:transparent;")
            self.lista_v.insertWidget(0, vacio)
            return
        for i, p in enumerate(visibles):
            self.lista_v.insertWidget(i, self._fila(p))

    def _fila(self, p):
        elegido = p.get('id') == self._seleccion
        color = COLOR_COBRAR if reglas.grupo(p) == 'cobrar' else COLOR_ESTADO.get(p.get('estado'), _T['text_muted'])
        w = QFrame()
        w.setObjectName('pwFila')
        w.setCursor(Qt.PointingHandCursor)
        fondo = _T['accent_soft'] if elegido else _T['surface_alt']
        borde = _T['accent'] if elegido else _T['border']
        w.setStyleSheet(
            f"QFrame#pwFila {{ background:{fondo}; border:1px solid {borde};"
            f" border-left:4px solid {color}; border-radius:8px; }}"
            f"QFrame#pwFila:hover {{ border-color:{_T['accent']}; }}"
        )
        v = QVBoxLayout(w)
        v.setContentsMargins(10, 8, 10, 8)
        v.setSpacing(3)

        top = QHBoxLayout()
        top.setSpacing(6)
        codigo = QLabel(str(p.get('codigo') or '—'))
        codigo.setStyleSheet(f"color:{_T['text']}; font-size:14px; font-weight:800; letter-spacing:1px;"
                             f" background:transparent; border:none; {MONO}")
        top.addWidget(codigo)
        top.addWidget(self._pastilla(self._texto_estado(p), color))
        if p.get('estado') == 'nuevo' and p.get('visto') is not True:
            top.addWidget(self._pastilla('SIN VER', _T['danger']))
        top.addStretch(1)
        cuando = QLabel(hace(p.get('entregado_en') if reglas.grupo(p) != 'hacer' else p.get('creado'),
                             self._ahora()))
        cuando.setStyleSheet(f"color:{_T['text_muted']}; font-size:11px; background:transparent; border:none;")
        top.addWidget(cuando)
        v.addLayout(top)

        mid = QHBoxLayout()
        nombre = QLabel(str((p.get('cliente') or {}).get('nombre') or 'Sin nombre'))
        nombre.setStyleSheet(f"color:{_T['text']}; font-size:12px; font-weight:600; background:transparent; border:none;")
        mid.addWidget(nombre, 1)
        total = QLabel(pesos(p.get('total')))
        total.setStyleSheet(f"color:{_T['text']}; font-size:12px; font-weight:800; background:transparent;"
                            f" border:none; {MONO}")
        mid.addWidget(total)
        v.addLayout(mid)

        detalle = self._linea_corta(p)
        if detalle:
            sub = QLabel(detalle)
            sub.setWordWrap(True)
            sub.setStyleSheet(f"color:{_T['text_muted']}; font-size:11px; background:transparent; border:none;")
            v.addWidget(sub)

        w.mousePressEvent = lambda _e, pid=p.get('id'): self._seleccionar(pid)
        return w

    def _texto_estado(self, p):
        if reglas.grupo(p) == 'cobrar':
            return 'A COBRAR'
        return reglas.ETIQUETAS.get(p.get('estado'), str(p.get('estado') or '')).upper()

    def _linea_corta(self, p):
        partes = ['Envío' if reglas.es_envio(p) else 'Retira en el local']
        partes.append('efectivo' if (p.get('pago') or {}).get('modo') == 'efectivo' else 'transferencia')
        marca = p.get('cobro') or {}
        if reglas.marca_vigente(marca, self._ahora(), self.quien()['pc_id']):
            partes.append(f"cobrando en {reglas.quien_texto(marca)}")
        elif reglas.cobrado(p):
            partes.append(f"cobrado en {marca.get('pc_nombre') or 'otra caja'}")
        return ' · '.join(partes)

    def _pastilla(self, texto, color):
        l = QLabel(texto)
        l.setStyleSheet(f"color:white; background:{color}; border-radius:8px; padding:1px 7px;"
                        " font-size:10px; font-weight:800;")
        return l

    def _seleccionar(self, pedido_id):
        self._seleccion = pedido_id
        p = self._pedidos.get(pedido_id)
        if p and p.get('estado') == 'nuevo' and p.get('visto') is not True and self._nube and self.isVisible():
            self._en_fondo(lambda: self._nube.marcar_visto([pedido_id]), lambda _r: None)
        self._redibujar_lista()
        self._redibujar_detalle()

    # ── Detalle ─────────────────────────────────────────────────────────────
    def _limpiar_detalle(self):
        while self.detalle_v.count():
            item = self.detalle_v.takeAt(0)
            w = item.widget()
            if w is not None:
                w.hide()
                w.deleteLater()

    def _redibujar_detalle(self):
        if self._modal:
            self._redibujo_pendiente = True
            return
        self._limpiar_detalle()
        self._firma_detalle = self._firma_de_detalle()
        p = self._pedidos.get(self._seleccion) if self._seleccion else None
        if not p:
            vacio = QLabel('Elegí un pedido de la lista para verlo.' if self._pedidos
                           else 'Cuando entre un pedido de la tienda aparece acá.')
            vacio.setAlignment(Qt.AlignCenter)
            vacio.setWordWrap(True)
            vacio.setStyleSheet(f"color:{_T['text_dim']}; font-size:13px; border:1px dashed {_T['border']};"
                                " border-radius:8px; padding:60px 20px; background:transparent;")
            self.detalle_v.addWidget(vacio)
            self.detalle_v.addStretch(1)
            return

        self.detalle_v.addWidget(self._tarjeta_encabezado(p))
        for aviso in self._avisos_del_pedido(p):
            self.detalle_v.addWidget(aviso)
        self.detalle_v.addWidget(self._tarjeta_acciones(p))
        self.detalle_v.addWidget(self._tarjeta_cliente(p))
        self.detalle_v.addWidget(self._tarjeta_renglones(p))
        self.detalle_v.addStretch(1)

    def _tarjeta(self, nombre, color_borde=None):
        f = QFrame()
        f.setObjectName(nombre)
        izquierda = f" border-left:4px solid {color_borde};" if color_borde else ''
        f.setStyleSheet(f"QFrame#{nombre} {{ background:{_T['surface']}; border:1px solid {_T['border']};"
                        f"{izquierda} border-radius:8px; }}")
        v = QVBoxLayout(f)
        v.setContentsMargins(16, 12, 16, 12)
        v.setSpacing(6)
        return f, v

    def _texto(self, texto, tam=13, color=None, peso=400, mono=False, envolver=True):
        l = QLabel(texto)
        l.setWordWrap(envolver)
        l.setTextInteractionFlags(Qt.TextSelectableByMouse)
        l.setStyleSheet(f"color:{color or _T['text']}; font-size:{tam}px; font-weight:{peso};"
                        f" background:transparent; border:none; {MONO if mono else ''}")
        return l

    def _tarjeta_encabezado(self, p):
        color = COLOR_COBRAR if reglas.grupo(p) == 'cobrar' else COLOR_ESTADO.get(p.get('estado'), _T['text_muted'])
        f, v = self._tarjeta('pwEnc', color)
        top = QHBoxLayout()
        top.setSpacing(10)
        top.addWidget(self._texto(str(p.get('codigo') or '—'), 26, peso=800, mono=True, envolver=False))
        top.addWidget(self._pastilla(self._texto_estado(p), color), 0, Qt.AlignVCenter)
        top.addStretch(1)
        top.addWidget(self._texto(pesos(p.get('total')), 26, peso=800, mono=True, envolver=False))
        v.addLayout(top)
        linea = [f"Entró {hace(p.get('creado'))}"]
        tomado = p.get('tomado_por') or {}
        if tomado:
            linea.append(f"lo aceptó {reglas.quien_texto(tomado)}")
        v.addWidget(self._texto(' · '.join(linea), 12, _T['text_muted']))
        return f

    def _aviso(self, texto, fondo, color):
        l = QLabel(texto)
        l.setWordWrap(True)
        l.setStyleSheet(f"color:{color}; background:{fondo}; border-radius:8px; padding:9px 12px;"
                        " font-size:13px; font-weight:600;")
        return l

    def _avisos_del_pedido(self, p):
        avisos = []
        ahora = self._ahora()
        yo = self.quien()['pc_id']
        marca = p.get('cobro') or {}
        if reglas.marca_vigente(marca, ahora, yo):
            avisos.append(self._aviso(
                f"Lo está cobrando {reglas.quien_texto(marca)} desde {hace(marca.get('desde'), ahora)}.",
                _T['warning_bg'], _T['warning']))
        if p.get('estado') == 'entregado':
            quien = {'reparto': 'el repartidor', 'panel': 'el panel', 'pos': 'una caja'}.get(
                p.get('entregado_por'), '')
            texto = f"Entregado {hace(p.get('entregado_en'), ahora)}" + (f" por {quien}" if quien else '')
            if p.get('entregado_por') == 'reparto' and (p.get('pago') or {}).get('modo') == 'efectivo':
                texto += ('. El repartidor cobró el efectivo' if (p.get('pago') or {}).get('pagado')
                          else '. El repartidor no marcó que cobró')
            if p.get('venta_pendiente') is True:
                texto += '. Descontando el stock…'
            avisos.append(self._aviso(texto + '.', _T['surface_alt'], _T['text']))
        if reglas.a_cobrar(p) and not reglas.marca_vigente(marca, ahora, yo):
            avisos.append(self._aviso('Falta cobrarlo en la caja.', _T['accent_soft'], _T['accent']))
        if reglas.cobrado(p):
            venta = f" · venta #{marca.get('venta_local')}" if marca.get('venta_local') else ''
            avisos.append(self._aviso(
                f"Cobrado en {reglas.quien_texto(marca)} {hace(marca.get('en'), ahora)} · "
                f"{etiqueta_pago(marca.get('pago'))}{venta}.", _T['success_bg'], _T['success']))
        if reglas.registrado_por_el_panel(p):
            avisos.append(self._aviso('La venta la registró el panel (no pasa por la caja).',
                                      _T['surface_alt'], _T['text_muted']))
        factura = p.get('factura') or {}
        if factura.get('estado') == 'emitida':
            avisos.append(self._aviso(
                f"Facturado: {factura.get('tipo', '')} "
                f"{int(reglas.num(factura.get('punto_venta'), 1)):05d}-{int(reglas.num(factura.get('numero'))):08d}"
                f" en {reglas.quien_texto(factura)}.", _T['success_bg'], _T['success']))
        elif reglas.marca_vigente(factura, ahora, yo):
            avisos.append(self._aviso(f"Lo está facturando {reglas.quien_texto(factura)}.",
                                      _T['warning_bg'], _T['warning']))
        saltados = p.get('stock_saltados') or []
        if saltados:
            detalle = '; '.join(f"{x.get('nombre') or x.get('producto_id') or 'renglón'}: {x.get('motivo')}"
                                for x in saltados[:4])
            avisos.append(self._aviso(
                f"Sin descontar del stock ({len(saltados)}): {detalle}. Corregilo a mano en el catálogo.",
                _T['warning_bg'], _T['warning']))
        if (reglas.cobrado(p) and marca.get('total') is not None
                and abs(reglas.num(marca.get('total')) - reglas.num(p.get('total'))) > 0.009):
            avisos.append(self._aviso(f"Se cobró {pesos(marca.get('total'))} (el pedido decía {pesos(p.get('total'))}).",
                                      _T['surface_alt'], _T['text']))
        anulado = p.get('anulado') or {}
        if p.get('estado') == 'cancelado' and anulado:
            extra = (' La venta de la caja sigue registrada: si se devolvió la plata, borrala en el panel.'
                     if anulado.get('estaba_cobrado') else '')
            avisos.append(self._aviso(
                f"Entrega anulada por {reglas.quien_texto(anulado)} {hace(anulado.get('en'), ahora)}: "
                f"{anulado.get('motivo', '')}. El stock volvió.{extra}", _T['danger_bg'], _T['danger']))
        elif p.get('estado') == 'cancelado':
            avisos.append(self._aviso('Pedido cancelado.', _T['danger_bg'], _T['danger']))
        return avisos

    def _boton(self, texto, principal=False, peligro=False, color=None):
        """Alto y letra van en el estilo: el QSS global de QPushButton trae su
        propio min-height y font-size, y le gana a setMinimumHeight/setFont."""
        b = QPushButton(texto)
        b.setCursor(Qt.PointingHandCursor)
        if principal:
            fondo = color or _T['accent']
            b.setStyleSheet(f"QPushButton {{ background:{fondo}; color:white; border:none; border-radius:8px;"
                            f" padding:10px 22px; min-height:26px; font-size:15px; font-weight:800; }}"
                            f" QPushButton:hover {{ background:{_T['accent_hover']}; }}"
                            f" QPushButton:disabled {{ background:{_T['border']}; color:{_T['text_muted']}; }}")
        elif peligro:
            b.setStyleSheet(f"QPushButton {{ background:transparent; color:{_T['danger']}; border:1px solid {_T['danger']};"
                            f" border-radius:8px; padding:8px 14px; min-height:20px; font-size:13px; font-weight:600; }}"
                            f" QPushButton:hover {{ background:{_T['danger']}; color:white; }}"
                            f" QPushButton:disabled {{ color:{_T['text_dim']}; border-color:{_T['border']}; }}")
        else:
            b.setStyleSheet(f"QPushButton {{ background:{_T['surface']}; color:{_T['text']}; border:1px solid {_T['border']};"
                            f" border-radius:8px; padding:8px 14px; min-height:20px; font-size:13px; font-weight:600; }}"
                            f" QPushButton:hover {{ background:{_T['border_soft']}; }}"
                            f" QPushButton:disabled {{ color:{_T['text_dim']}; }}")
        return b

    def _tarjeta_acciones(self, p):
        f, v = self._tarjeta('pwAcc')
        pid = p.get('id')
        ocupado = pid in self._ocupados or pid in self._cobrando
        ahora = self._ahora()
        yo = self.quien()['pc_id']
        ajeno = reglas.marca_vigente(p.get('cobro') or {}, ahora, yo)

        clave, texto = accion_principal(p)
        fila = QHBoxLayout()
        fila.setSpacing(8)
        if clave:
            principal = self._boton('Guardando…' if ocupado else texto, principal=True)
            principal.setEnabled(not ocupado and not (clave == 'cobrar' and ajeno) and self._nube is not None)
            principal.clicked.connect(lambda _c, k=clave, pid=pid: self._accion(k, pid))
            fila.addWidget(principal, 1)
        v.addLayout(fila)

        otras = QHBoxLayout()
        otras.setSpacing(8)
        if p.get('estado') in ('listo', 'en_camino'):
            b = self._boton('Entregado, cobrar después')
            b.setEnabled(not ocupado and self._nube is not None)
            b.clicked.connect(lambda _c, pid=pid: self._accion('entregar', pid))
            otras.addWidget(b)
        if p.get('estado') == 'listo' and reglas.es_envio(p):
            b = self._boton('Entregar y cobrar')
            b.setEnabled(not ocupado and not ajeno and self._nube is not None)
            b.clicked.connect(lambda _c, pid=pid: self._accion('cobrar', pid))
            otras.addWidget(b)
        factura = p.get('factura') or {}
        if (reglas.cobrado(p) or reglas.registrado_por_el_panel(p)) and factura.get('estado') != 'emitida':
            b = self._boton('Facturar en ARCA')
            b.setEnabled(not ocupado and self._nube is not None)
            b.clicked.connect(lambda _c, pid=pid: self._accion('facturar', pid))
            otras.addWidget(b)
        imprimir = self._boton('Imprimir')
        imprimir.clicked.connect(lambda _c, pid=pid: self._accion('imprimir', pid))
        otras.addWidget(imprimir)
        if (p.get('pago') or {}).get('modo') == 'transferencia':
            comp = self._boton('Ver comprobante')
            comp.setEnabled(self._nube is not None)
            comp.clicked.connect(lambda _c, pid=pid: self._accion('comprobante', pid))
            otras.addWidget(comp)
        otras.addStretch(1)
        if p.get('estado') in reglas.ESTADOS_EN_CURSO:
            cancelar = self._boton('Cancelar pedido', peligro=True)
            cancelar.setEnabled(not ocupado and not ajeno and self._nube is not None)
            cancelar.clicked.connect(lambda _c, pid=pid: self._accion('cancelar', pid))
            otras.addWidget(cancelar)
        elif (p.get('estado') == 'entregado' and not reglas.registrado_por_el_panel(p)
              and self.current_user.get('role') == 'admin'):
            anular = self._boton('Anular entrega', peligro=True)
            anular.setToolTip('Lo devolvieron o se marcó entregado por error: vuelve el stock y se cancela.')
            anular.setEnabled(not ocupado and not ajeno and self._nube is not None)
            anular.clicked.connect(lambda _c, pid=pid: self._accion('anular', pid))
            otras.addWidget(anular)
        v.addLayout(otras)
        return f

    def _boton_chico(self, texto, color=None):
        color = color or _T['text']
        b = QPushButton(texto)
        b.setCursor(Qt.PointingHandCursor)
        b.setStyleSheet(f"QPushButton {{ background:{_T['surface']}; color:{color}; border:1px solid {_T['border']};"
                        f" border-radius:7px; padding:5px 12px; min-height:18px; font-size:12px; font-weight:700; }}"
                        f" QPushButton:hover {{ border-color:{color}; background:{_T['surface_alt']}; }}")
        return b

    def _seleccionable(self, label):
        label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        label.setCursor(Qt.IBeamCursor)
        return label

    def _tarjeta_cliente(self, p):
        f, v = self._tarjeta('pwCli')
        cliente = p.get('cliente') or {}
        entrega = p.get('entrega') or {}
        pago = p.get('pago') or {}

        v.addWidget(self._texto('CLIENTE', 10, _T['text_muted'], 800, envolver=False))
        v.addWidget(self._seleccionable(self._texto(str(cliente.get('nombre') or 'Sin nombre'), 16, peso=800)))

        telefono = str(cliente.get('telefono') or '').strip()
        if telefono:
            fila = QHBoxLayout()
            fila.setSpacing(8)
            fila.addWidget(self._seleccionable(self._texto(telefono, 14, peso=600, mono=True, envolver=False)))
            numero = reglas.whatsapp_de_telefono(telefono)
            if numero:
                texto = (reglas.mensaje_whatsapp(p, reglas.DIRECCION_LOCAL)
                         or f"Hola {reglas.nombre_corto(p)}, te escribimos de Librería Liceo por tu pedido "
                            f"{p.get('codigo', '')}.")
                wa = self._boton_chico('WhatsApp', COLOR_WHATSAPP)
                wa.setToolTip(f"Abre el chat con este mensaje (se puede cambiar antes de mandarlo):\n{texto}")
                wa.clicked.connect(lambda _c, n=numero, t=texto: self._abrir_whatsapp(n, t))
                fila.addWidget(wa)
            copiar = self._boton_chico('Copiar')
            copiar.setToolTip('Copia el teléfono')
            copiar.clicked.connect(lambda _c, t=telefono, b=copiar: self._copiar(t, b))
            fila.addWidget(copiar)
            fila.addStretch(1)
            v.addLayout(fila)
            if not numero:
                v.addWidget(self._texto('Ese número no sirve para WhatsApp (es fijo o está incompleto).', 12,
                                        _T['text_muted']))
        else:
            v.addWidget(self._texto('Sin teléfono', 13, _T['text_muted']))

        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet(f"background:{_T['border']}; max-height:1px; border:none;")
        v.addWidget(sep)

        if reglas.es_envio(p):
            km = f" · {str(entrega.get('distancia_km')).replace('.', ',')} km" if entrega.get('distancia_km') else ''
            fila = QHBoxLayout()
            fila.setSpacing(8)
            fila.addWidget(self._texto(f"Envío a domicilio{km}", 13, peso=700, envolver=False))
            mapa = enlace_mapa(entrega)
            if mapa:
                ver = self._boton_chico('Mapa')
                ver.setToolTip('Abre la dirección en Google Maps')
                ver.clicked.connect(lambda _c, u=mapa: QDesktopServices.openUrl(QUrl(u)))
                fila.addWidget(ver)
            fila.addStretch(1)
            v.addLayout(fila)
            v.addWidget(self._seleccionable(self._texto(str(entrega.get('direccion') or 'Sin dirección'), 14)))
            if entrega.get('referencia'):
                v.addWidget(self._seleccionable(self._texto(str(entrega.get('referencia')), 13, _T['text_muted'])))
        else:
            v.addWidget(self._texto('Retira en el local', 13, peso=700))

        if pago.get('modo') == 'efectivo':
            medio = 'Paga en efectivo' + (' · el repartidor marcó que cobró' if pago.get('pagado') else '')
        else:
            medio = 'Paga con transferencia'
        v.addWidget(self._texto(medio, 13, _T['text_muted']))
        if p.get('nota'):
            v.addWidget(self._aviso(f"Nota del cliente: {p.get('nota')}", _T['warning_bg'], _T['warning']))
        return f

    def _abrir_whatsapp(self, numero, texto):
        if self._whatsapp_app is None:
            self._whatsapp_app = whatsapp_de_escritorio()
        if QDesktopServices.openUrl(QUrl(enlace_whatsapp(numero, texto, self._whatsapp_app))):
            return
        if self._whatsapp_app:
            # La app dejó de abrir (desinstalada, rota): WhatsApp Web.
            self._whatsapp_app = False
            QDesktopServices.openUrl(QUrl(enlace_whatsapp(numero, texto, False)))

    def _copiar(self, texto, boton):
        QApplication.clipboard().setText(texto)
        boton.setText('Copiado')

        def volver():
            try:
                boton.setText('Copiar')
            except RuntimeError:
                pass        # el detalle se redibujó y el botón ya no existe
        QTimer.singleShot(1500, volver)

    def _tarjeta_renglones(self, p):
        f, v = self._tarjeta('pwRen')
        for it in p.get('items') or []:
            fila = QHBoxLayout()
            fila.setSpacing(8)
            cant = (f"{reglas.num(it.get('cantidad')):.1f} m".replace('.', ',') if it.get('unidad') == 'metro'
                    else str(int(round(reglas.num(it.get('cantidad'))))))
            c = self._texto(cant, 13, _T['text_muted'], 700, mono=True, envolver=False)
            c.setMinimumWidth(44)
            fila.addWidget(c, 0, Qt.AlignTop)
            detalle = str(it.get('nombre') or '')
            extras = []
            if it.get('variedad'):
                extras.append(str(it['variedad']))
            if it.get('es_pack'):
                extras.append(f"pack de {int(reglas.num(it.get('pack_contenido'), 1))}")
            nombre = self._texto(detalle + (f"  ·  {' · '.join(extras)}" if extras else ''), 13)
            fila.addWidget(nombre, 1)
            sub = it.get('subtotal') if it.get('subtotal') is not None else reglas.num(it.get('precio')) * reglas.num(it.get('cantidad'))
            fila.addWidget(self._texto(pesos(sub), 13, peso=700, mono=True, envolver=False), 0, Qt.AlignTop)
            v.addLayout(fila)

        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet(f"background:{_T['border']}; max-height:1px; border:none;")
        v.addWidget(sep)
        entrega = p.get('entrega') or {}

        def total(etiqueta, valor, fuerte=False):
            fila = QHBoxLayout()
            fila.addWidget(self._texto(etiqueta, 15 if fuerte else 13, None if fuerte else _T['text_muted'],
                                       800 if fuerte else 400, envolver=False))
            fila.addStretch(1)
            fila.addWidget(self._texto(valor, 15 if fuerte else 13, None, 800 if fuerte else 600,
                                       mono=True, envolver=False))
            v.addLayout(fila)

        total('Productos', pesos(p.get('subtotal')))
        if reglas.es_envio(p):
            total('Envío', 'sin cargo (cupón)' if entrega.get('envio_gratis')
                  else 'a confirmar' if entrega.get('envio_a_confirmar') else pesos(p.get('envio')))
        if reglas.num(p.get('descuento')) > 0 and not entrega.get('envio_gratis'):
            total(f"Cupón {(p.get('cupon') or {}).get('codigo', '')}", f"-{pesos(p.get('descuento'))}")
        total('Total', pesos(p.get('total')), fuerte=True)
        return f

    # ══════════════════════════════════════════════════
    #  ACCIONES
    # ══════════════════════════════════════════════════
    def _en_fondo(self, fn, al_terminar):
        tarea = _Tarea(self)
        self._tareas.append(tarea)

        def terminar(resultado):
            try:
                al_terminar(resultado)
            finally:
                if tarea in self._tareas:
                    self._tareas.remove(tarea)
                tarea.deleteLater()

        tarea.listo.connect(terminar)

        def correr():
            try:
                resultado = fn()
            except Exception as e:
                logger.exception('Pedidos web: tarea en segundo plano falló')
                from pos_system.utils.pedidos_tienda_nube import Resultado
                resultado = Resultado(ok=False, rechazo=f'no se pudo completar: {e}', motivo='error')
            tarea.listo.emit(resultado)

        threading.Thread(target=correr, daemon=True, name='pedidos-web').start()

    def _pedido(self, pid):
        return dict(self._pedidos.get(pid) or {})

    def _marcar_ocupado(self, pid, ocupado):
        if ocupado:
            self._ocupados.add(pid)
        else:
            self._ocupados.discard(pid)
        self._redibujar_detalle()

    def _mensaje(self, titulo, texto, icono=QMessageBox.Information):
        self._modal += 1
        try:
            caja = QMessageBox(icono, titulo, texto, QMessageBox.Ok, self)
            caja.exec_()
        finally:
            self._fin_modal()

    def _preguntar(self, titulo, texto, si='Sí', no='No'):
        self._modal += 1
        try:
            caja = QMessageBox(QMessageBox.Question, titulo, texto, QMessageBox.NoButton, self)
            b_si = caja.addButton(si, QMessageBox.AcceptRole)
            caja.addButton(no, QMessageBox.RejectRole)
            caja.setDefaultButton(b_si)
            caja.exec_()
            return caja.clickedButton() is b_si
        finally:
            self._fin_modal()

    def _fin_modal(self):
        self._modal = max(0, self._modal - 1)
        if not self._modal and self._redibujo_pendiente:
            QTimer.singleShot(0, self._redibujar)

    def _accion(self, clave, pid):
        p = self._pedido(pid)
        if not p or self._nube is None and clave not in ('imprimir',):
            return
        if clave == 'aceptar':
            self._mover(pid, 'nuevo', 'preparando')
        elif clave == 'listo':
            self._mover(pid, 'preparando', 'listo')
        elif clave == 'salio':
            self._mover(pid, 'listo', 'en_camino')
        elif clave == 'entregar':
            self._entregar_sin_cobrar(pid)
        elif clave == 'cobrar':
            self._cobrar(pid)
        elif clave == 'cancelar':
            self._cancelar(pid)
        elif clave == 'imprimir':
            self._imprimir(pid)
        elif clave == 'comprobante':
            self._ver_comprobante(pid)
        elif clave == 'facturar':
            self._facturar(pid)
        elif clave == 'anular':
            self._anular_entrega(pid)

    def _resultado(self, pid, r, que):
        self._marcar_ocupado(pid, False)
        if not r.ok:
            self._mensaje('Pedidos web', f"No se {que}: {r.rechazo}.")
        return r.ok

    def _mover(self, pid, desde, hacia):
        self._marcar_ocupado(pid, True)
        que = {'preparando': 'aceptó el pedido', 'listo': 'marcó listo', 'en_camino': 'marcó que salió'}[hacia]
        self._en_fondo(lambda: self._nube.mover(pid, desde, hacia),
                       lambda r: self._resultado(pid, r, que))

    def _entregar_sin_cobrar(self, pid):
        p = self._pedido(pid)
        if not self._preguntar('Marcar entregado',
                               f"¿Marcar {p.get('codigo', '')} como entregado?\n\n"
                               "Se descuenta el stock y queda en \"A cobrar\" para cobrarlo "
                               "cuando llegue la plata.", 'Marcar entregado', 'Volver'):
            return
        self._marcar_ocupado(pid, True)
        self._en_fondo(lambda: self._nube.entregar(pid, origen='pos'),
                       lambda r: self._resultado(pid, r, 'marcó entregado'))

    def _pedir_texto(self, titulo, pregunta):
        from PyQt5.QtWidgets import QInputDialog
        self._modal += 1
        try:
            texto, ok = QInputDialog.getText(self, titulo, pregunta)
            return texto.strip() if ok else None
        finally:
            self._fin_modal()

    def _pedir_monto(self, titulo, pregunta, valor):
        from PyQt5.QtWidgets import QInputDialog
        self._modal += 1
        try:
            monto, ok = QInputDialog.getDouble(self, titulo, pregunta, float(valor or 0), 0, 10_000_000, 2)
            return monto if ok else None
        finally:
            self._fin_modal()

    def _anular_entrega(self, pid):
        p = self._pedido(pid)
        extra = ('\n\nEstá cobrado: la venta de la caja NO se borra desde acá. Si se devolvió la plata, '
                 'borrala en el panel (Ventas).' if reglas.cobrado(p) else '')
        motivo = self._pedir_texto('Anular entrega',
                                   f"¿Por qué se anula la entrega de {p.get('codigo', '')}?\n"
                                   f"(el stock vuelve y el pedido queda cancelado){extra}")
        if motivo is None:
            return
        if not motivo:
            self._mensaje('Anular entrega', 'Hace falta el motivo: es lo que queda anotado.')
            return
        self._marcar_ocupado(pid, True)
        self._en_fondo(lambda: self._nube.anular_entrega(pid, motivo),
                       lambda r: self._resultado(pid, r, 'anuló la entrega'))

    def _cancelar(self, pid):
        p = self._pedido(pid)
        if not self._preguntar('Cancelar pedido',
                               f"¿Cancelar el pedido {p.get('codigo', '')} de "
                               f"{(p.get('cliente') or {}).get('nombre', '')}?\n\nAl cliente le llega el aviso.",
                               'Cancelar pedido', 'Volver'):
            return
        self._marcar_ocupado(pid, True)
        self._en_fondo(lambda: self._nube.cancelar(pid), lambda r: self._resultado(pid, r, 'canceló'))

    def _imprimir(self, pid):
        from pos_system.utils.ticket_pedido import imprimir_pedido
        p = self._pedido(pid)
        self._modal += 1
        try:
            mostrado = imprimir_pedido(p, parent=self, cfg=self._cfg_tienda)
        finally:
            self._fin_modal()
        if mostrado and self._nube is not None:
            self._en_fondo(lambda: self._nube.marcar_impreso(pid), lambda _r: None)

    def _ver_comprobante(self, pid):
        def buscar():
            snap = self._nube.db.collection('tienda_comprobantes').document(pid).get()
            return (snap.to_dict() or {}).get('url') if snap.exists else None

        def abrir(url):
            from urllib.parse import urlparse
            if isinstance(url, str) and url.startswith('https://'):
                if urlparse(url).hostname != 'firebasestorage.googleapis.com':
                    # Lo escribe el cliente: no se abre cualquier enlace.
                    self._mensaje('Comprobante', 'El enlace del comprobante no es del almacenamiento de la '
                                                 'tienda: no se abre.', QMessageBox.Warning)
                    return
                QDesktopServices.openUrl(QUrl(url))
            elif isinstance(url, str) or url is None:
                self._mensaje('Comprobante', 'El cliente todavía no subió el comprobante.')
            else:
                self._mensaje('Comprobante', 'No se pudo leer el comprobante.')

        self._en_fondo(buscar, abrir)

    # ── Cobro ───────────────────────────────────────────────────────────────
    def _caja_abierta(self):
        caja = self.db.get_current_cash_register()
        if not caja or caja.get('status') != 'open':
            self._mensaje('Caja cerrada', 'Para cobrar hay que tener la caja abierta.\n\n'
                                          'Andá a la pestaña Caja y abrila.', QMessageBox.Warning)
            return False
        return True

    def _cobrar(self, pid, forzar=False):
        if pid in self._cobrando or not self._caja_abierta():
            return
        self._cobrando.add(pid)
        self._marcar_ocupado(pid, True)
        self._en_fondo(lambda: self._nube.tomar_cobro(pid, forzar=forzar),
                       lambda r: self._cobro_tomado(pid, r))

    def _terminar_cobro(self, pid):
        self._cobrando.discard(pid)
        self._marcar_ocupado(pid, False)

    def _cobro_tomado(self, pid, r):
        try:
            self._abrir_cobro(pid, r)
        except Exception as e:
            logger.exception('Pedidos web: la pantalla de cobro falló')
            if pid in self._cobrando:
                if r.ok:
                    self._en_fondo(lambda: self._nube.soltar_cobro(pid, r.intento), lambda _r: None)
                self._terminar_cobro(pid)
            self._mensaje('No se cobró', f"La pantalla de cobro falló:\n{e}\n\nNo se registró nada.",
                          QMessageBox.Warning)

    def _abrir_cobro(self, pid, r):
        if not r.ok:
            self._terminar_cobro(pid)
            if r.motivo == 'vencida':
                if self._preguntar('Cobro sin terminar',
                                   f"{r.rechazo[0].upper()}{r.rechazo[1:]} hace más de "
                                   f"{reglas.MINUTOS_MARCA} minutos.\n\nSi esa caja se colgó o cerraron la "
                                   "pantalla, podés tomarlo desde acá. Si la otra caja todavía lo está "
                                   "cobrando, no se va a cobrar dos veces: la primera que termine gana.",
                                   'Tomarlo', 'Dejarlo'):
                    self._cobrar(pid, forzar=True)
                return
            self._mensaje('Pedidos web', f"No se puede cobrar: {r.rechazo}.")
            return

        pedido = r.pedido or self._pedido(pid)
        intento = r.intento
        entrega = pedido.get('entrega') or {}
        if reglas.es_envio(pedido) and entrega.get('envio_a_confirmar'):
            envio = self._pedir_monto('Envío a confirmar',
                                      f"El envío de {pedido.get('codigo', '')} estaba a confirmar "
                                      f"(se calculó {pesos(pedido.get('envio'))}).\n¿Cuánto se cobra de envío?",
                                      pedido.get('envio'))
            if envio is None:
                self._en_fondo(lambda: self._nube.soltar_cobro(pid, intento), lambda _r: None)
                self._terminar_cobro(pid)
                return
            pedido = reglas.con_envio(pedido, envio)
        lineas = reglas.renglones_de_cobro(pedido, pid, self._productos_locales(pedido))
        total = reglas.total_a_cobrar(pedido)

        if total <= 0:
            self._confirmar_cobro(pid, intento, pedido, lineas, total, None)
            return

        from pos_system.ui.sales_view import PaymentDialog
        # Mientras la pantalla de cobro está abierta la marca se renueva: así
        # otra caja no la ve vencida por un cobro que simplemente tarda.
        renovar = QTimer(self)
        renovar.timeout.connect(lambda: self._en_fondo(
            lambda: self._nube.renovar_cobro(pid, intento), lambda _r: None))
        renovar.start(RENOVAR_MARCA_MS)
        self._modal += 1
        try:
            dlg = PaymentDialog(self, total=total, cart=lineas)
            dlg.setWindowTitle(f"Cobrar pedido {pedido.get('codigo', '')}")
            dlg.precargar_pago(reglas.pago_sugerido(pedido))
            aceptado = dlg.exec_() == QDialog.Accepted
        finally:
            renovar.stop()
            renovar.deleteLater()
            self._fin_modal()

        if not aceptado:
            self._en_fondo(lambda: self._nube.soltar_cobro(pid, intento), lambda _r: None)
            self._terminar_cobro(pid)
            return
        self._confirmar_cobro(pid, intento, pedido, lineas, total, dlg)

    def _pago_de(self, dlg, total):
        if dlg is None:
            return {'payment_type': 'transfer', 'payment_subtype': 'Sin cargo',
                    'cash_received': 0.0, 'change_given': 0.0, 'transfer_amount': 0.0, 'total': total}
        return {
            'payment_type': dlg.payment_type,
            'payment_subtype': getattr(dlg, 'payment_subtype', ''),
            'cash_received': float(dlg.cash_received or 0),
            'change_given': float(dlg.change_given or 0),
            'transfer_amount': float(getattr(dlg, 'transfer_amount', 0.0) or 0),
            'total': total,
        }

    def _confirmar_cobro(self, pid, intento, pedido, lineas, total, dlg):
        pago = self._pago_de(dlg, total)
        caja = self.db.get_current_cash_register()
        if total > 0 and (not caja or caja.get('status') != 'open'):
            # La cerraron (otra PC, el panel) con la pantalla de cobro abierta:
            # la venta quedaría sin caja y no subiría nunca.
            self._en_fondo(lambda: self._nube.soltar_cobro(pid, intento), lambda _r: None)
            self._terminar_cobro(pid)
            self._mensaje('Caja cerrada', 'La caja se cerró mientras cobrabas: no se registró nada.\n\n'
                                          'Abrí la caja y volvé a cobrarlo.', QMessageBox.Warning)
            return
        # Antes de pedir el cobro queda anotado acá lo necesario para terminarlo
        # solo si la PC se corta en el medio (ver models/cobros_pedido.py).
        if total > 0:
            try:
                cobros_pedido.anotar(self.db, intento=intento, pedido_id=pid,
                                     codigo=str(pedido.get('codigo') or ''), pedido=pedido,
                                     pago=pago, lineas=lineas, caja_id=(caja or {}).get('id'))
            except Exception as e:
                logger.exception('Pedidos web: no se pudo anotar el cobro local')
                self._en_fondo(lambda: self._nube.soltar_cobro(pid, intento), lambda _r: None)
                self._terminar_cobro(pid)
                self._mensaje('No se cobró', f"No se pudo guardar el cobro en esta PC:\n{e}\n\n"
                                             "No se registró nada.", QMessageBox.Warning)
                return
        self._en_fondo(lambda: self._nube.cobrar(pid, intento, pago),
                       lambda r: self._cobro_anotado(pid, intento, pedido, lineas, pago, dlg, r))

    def _cobro_anotado(self, pid, intento, pedido, lineas, pago, dlg, r):
        leido = ((r.pedido or {}).get('cobro') or {}) if not r.ok else {}
        if (not r.ok and leido.get('estado') == 'hecho' and leido.get('intento') == intento
                and leido.get('pc_id') == self.quien()['pc_id']):
            # El cliente de Firestore reenvía un commit que se cortó; si la
            # transacción corrió de nuevo, encontró el cobro ya hecho por este
            # mismo intento. Es este cobro: se sigue con la venta.
            logger.warning(f'Pedidos web: el cobro {intento} de {pid} ya estaba registrado (reintento de red)')
            r = type(r)(ok=True, intento=intento, pedido=r.pedido)
        if not r.ok:
            self._terminar_cobro(pid)
            if r.motivo == 'error':
                # Sin respuesta de la nube no se sabe si el cobro entró. La fila
                # local queda: la próxima revisión relee el pedido y, si entró,
                # crea la venta; si no, la descarta.
                self._mensaje('Cobro sin confirmar',
                              "No hubo respuesta de la nube y no se sabe si el cobro quedó registrado.\n\n"
                              "Esta caja lo revisa sola en un momento: si entró, crea la venta; si no, "
                              "el pedido sigue para cobrar. No lo cobres en otra caja mientras tanto.",
                              QMessageBox.Warning)
            else:
                cobros_pedido.borrar(self.db, intento)
                self._mensaje('No se cobró', f"No se registró el cobro: {r.rechazo}.\n\n"
                                             "No se creó ninguna venta ni se tocó la caja.", QMessageBox.Warning)
            return

        sale_id = None
        if pago['total'] > 0:
            try:
                sale_id = self._crear_venta_local(pid, intento, pedido, lineas, pago)
                cobros_pedido.marcar_venta(self.db, intento, sale_id)
            except Exception as e:
                logger.exception('Pedidos web: la venta local del cobro no se pudo crear')
                detalle = f'{type(e).__name__}: {e}'
                self._en_fondo(lambda: self._nube.anotar_problema(pid, 'venta_local', detalle), lambda _r: None)
                self._terminar_cobro(pid)
                self._mensaje('Venta sin crear',
                              f"El cobro quedó anotado en el pedido, pero la venta de esta caja no se "
                              f"pudo crear:\n{e}\n\nSe vuelve a intentar sola; si sigue fallando, "
                              "avisá antes de cobrarlo de nuevo.", QMessageBox.Warning)
                return
            self._anotar_venta(pid, intento, sale_id)
            self._subir_venta(sale_id)

        self._terminar_cobro(pid)
        self._refrescar_otras_vistas()
        if dlg is not None and getattr(dlg, 'selected_profile', None) and sale_id:
            self._facturar(pid, sale_id=sale_id, perfil=dlg.selected_profile,
                           cliente=getattr(dlg, 'selected_cliente', None),
                           notas=getattr(dlg, 'nota_factura', '') or '')
        else:
            self._mensaje('Pedido cobrado', f"{pedido.get('codigo', '')} cobrado: "
                                            f"{pesos(pago['total'])} en {etiqueta_pago(pago)}.")

    def _anotar_venta(self, pid, intento, sale_id):
        """Anota la venta en el pedido; con eso el cobro queda completo y la
        fila local se borra. Si falla, la fila queda para la próxima revisión."""
        def listo(r):
            if r.ok:
                cobros_pedido.borrar(self.db, intento)
            elif r.motivo != 'error':
                fallas = cobros_pedido.posponer(self.db, intento, r.rechazo)
                logger.warning(f'Pedidos web: la venta #{sale_id} no se anotó en {pid}: {r.rechazo}')
                if fallas == 1:
                    self._en_fondo(lambda: self._nube.anotar_problema(
                        pid, 'anotar_venta', f'venta #{sale_id}: {r.rechazo}'), lambda _r: None)
        self._en_fondo(lambda: self._nube.anotar_venta(pid, intento, sale_id), listo)

    def _productos_locales(self, pedido):
        """Los productos del pedido en la base de esta PC: el id local y lo que
        hace falta para escribir el renglón como lo escribe el carrito."""
        ids = sorted({str((i or {}).get('id') or '') for i in (pedido.get('items') or [])} - {''})
        if not ids:
            return {}
        marcas = ','.join('?' * len(ids))
        filas = self.db.execute_query(
            "SELECT id, firebase_id, name, category, es_conjunto, conjunto_tipo, conjunto_unidad_medida, "
            f"conjunto_colores FROM products WHERE firebase_id IN ({marcas})", tuple(ids)) or []
        return {f['firebase_id']: dict(f) for f in filas}

    def _crear_venta_local(self, pid, intento, pedido, lineas, pago):
        try:
            return self.sale_model.create({
                'total_amount': pago['total'],
                'payment_type': pago['payment_type'],
                'payment_subtype': pago.get('payment_subtype', ''),
                'cash_received': pago.get('cash_received', 0.0),
                'change_given': pago.get('change_given', 0.0),
                'transfer_amount': pago.get('transfer_amount', 0.0),
                'items': lineas,
                'user_id': self.current_user.get('id'),
                'turno_nombre': self._cajero(),
                'notes': f"Pedido web {pedido.get('codigo', '')}",
                'pedido_tienda_id': pid,
                'pedido_tienda_codigo': str(pedido.get('codigo') or ''),
                'pedido_tienda_intento': intento,
            })
        except VentaDePedidoRepetida as ya:
            return ya.sale_id

    def _subir_venta(self, sale_id):
        def _do():
            try:
                from pos_system.utils.firebase_sync import get_firebase_sync
                fb = get_firebase_sync()
                if not fb or not fb.enabled:
                    return      # la sube la cola offline cuando vuelva la nube
                venta = self.sale_model.get_by_id(int(sale_id))
                if not venta or not venta.get('cash_register_id'):
                    return
                venta['username'] = venta['turno_nombre'] = venta['cajero'] = self._cajero()
                # El rubro de cada renglón (el envío va como servicio) y el
                # descuento del cupón, como los lleva una venta del mostrador.
                ids = sorted({int(i.get('product_id') or 0) for i in venta.get('items') or []})
                filas = self.db.execute_query(
                    f"SELECT id, category FROM products WHERE id IN ({','.join('?' * len(ids))})",
                    tuple(ids)) if ids else []
                categorias = {int(f['id']): f.get('category') for f in filas or []}
                for item in venta.get('items') or []:
                    if item.get('product_name') == 'ENVIO A DOMICILIO':
                        item['category'] = 'SERVICIOS'
                    else:
                        item['category'] = categorias.get(int(item.get('product_id') or 0)) or 'Sin categoría'
                venta['discount'] = round(sum(float(i.get('discount_amount') or 0)
                                              for i in venta.get('items') or []), 2)
                subio = fb.sync_sale(venta, esperar=True)
                subio = fb.sync_sale_detail_by_day(venta, db_manager=self.db, esperar=True) and subio
                if subio:
                    self.db.execute_update("UPDATE sales SET firebase_synced=1 WHERE id=?", (int(sale_id),))
            except Exception as e:
                logger.warning(f'Pedidos web: la venta #{sale_id} no subió: {e}')
        threading.Thread(target=_do, daemon=True, name='pedidos-web-subir').start()

    def _refrescar_otras_vistas(self):
        w = self.parent()
        while w is not None:
            if hasattr(w, 'refresh_all_views'):
                try:
                    w.refresh_all_views()
                except Exception as e:
                    logger.warning(f'Pedidos web: refresco de vistas: {e}')
                return
            w = w.parent()

    def _procesar_cobros_pendientes(self):
        """Termina los cobros que esta PC dejó a medias (models/cobros_pedido.py).

        Relee cada pedido en la nube y decide con lo que hay de verdad:
          · el cobro con ese intento está hecho → crea la venta que falta (con
            la caja abierta: sin caja la venta no sube) y la anota en el pedido;
          · no está hecho → el cobro nunca se registró: si la marca sigue siendo
            de este intento se suelta, y la fila se descarta.
        Una fila que falla espera cada vez más antes de reintentar.
        """
        if self._nube is None or self._modal:
            return
        try:
            filas = [f for f in cobros_pedido.pendientes(self.db)
                     if f['pedido_id'] not in self._cobrando and f['intento'] not in self._recuperando]
        except Exception as e:
            logger.warning(f'Pedidos web: no se pudieron leer los cobros pendientes: {e}')
            return
        for fila in filas:
            self._recuperando.add(fila['intento'])
            self._en_fondo(lambda fila=fila: self._nube.leer(fila['pedido_id']),
                           lambda pedido, fila=fila: self._resolver_cobro_pendiente(fila, pedido))

    def _resolver_cobro_pendiente(self, fila, pedido):
        intento, pid = fila['intento'], fila['pedido_id']
        try:
            if isinstance(pedido, dict) and 'ok' in pedido and pedido.get('ok') is False:
                raise RuntimeError(pedido.get('rechazo') or 'sin respuesta de la nube')
            cobro = (pedido or {}).get('cobro') or {}
            if cobro.get('estado') != 'hecho' or cobro.get('intento') != intento:
                if cobro.get('estado') == 'en_curso' and cobro.get('intento') == intento:
                    self._en_fondo(lambda: self._nube.soltar_cobro(pid, intento), lambda _r: None)
                cobros_pedido.borrar(self.db, intento)
                logger.info(f"Pedidos web: cobro {intento} de {fila.get('codigo')} no se había registrado; descartado")
                return
            if (pedido or {}).get('venta_id') and fila.get('sale_id'):
                cobros_pedido.borrar(self.db, intento)
                return
            sale_id = fila.get('sale_id')
            if not sale_id:
                caja = self.db.get_current_cash_register()
                if not caja or caja.get('status') != 'open':
                    return      # sin caja abierta no se crea: se reintenta en la próxima vuelta
                sale_id = self._crear_venta_local(pid, intento, fila.get('pedido') or pedido,
                                                  fila.get('lineas') or [], fila.get('pago') or {})
                cobros_pedido.marcar_venta(self.db, intento, sale_id)
                self._subir_venta(sale_id)
                logger.warning(f"Pedidos web: venta #{sale_id} creada para el cobro que quedó a medias "
                               f"de {fila.get('codigo')}")
                if fila.get('caja_id') and int(fila['caja_id']) != int(caja.get('id') or 0):
                    # Se cobró con otra caja abierta (un corte, un reinicio): la plata
                    # quedó en la de ahora y hay que saberlo para cerrar las dos.
                    self.aviso.emit('cobrar', f"El cobro de {fila.get('codigo')} que había quedado a medias "
                                              f"se registró en esta caja (se había cobrado con la caja "
                                              f"#{fila['caja_id']}).")
            self._anotar_venta(pid, intento, sale_id)
        except Exception as e:
            fallas = cobros_pedido.posponer(self.db, intento, e)
            logger.warning(f"Pedidos web: cobro pendiente de {fila.get('codigo')} sin resolver ({fallas}): {e}")
            if fallas == 1:
                detalle = f'{type(e).__name__}: {e}'
                self._en_fondo(lambda: self._nube.anotar_problema(pid, 'cobro_pendiente', detalle), lambda _r: None)
        finally:
            self._recuperando.discard(intento)

    # ── Factura ─────────────────────────────────────────────────────────────
    def _facturar(self, pid, sale_id=None, perfil=None, cliente=None, notas='', forzar=False):
        self._marcar_ocupado(pid, True)
        self._en_fondo(lambda: self._nube.tomar_factura(pid, forzar=forzar),
                       lambda r: self._factura_tomada(pid, r, sale_id, perfil, cliente, notas))

    def _factura_tomada(self, pid, r, sale_id, perfil, cliente, notas):
        self._marcar_ocupado(pid, False)
        if not r.ok:
            if r.motivo == 'vencida' and self._preguntar(
                    'Factura sin terminar',
                    f"{r.rechazo[0].upper()}{r.rechazo[1:]}.\n\nAntes de seguir, fijate en ARCA o en "
                    "Fiscal que no haya quedado emitida: si se emitió y no se anotó, facturar de nuevo "
                    "la duplica.", 'Facturar igual', 'Dejarlo'):
                self._facturar(pid, sale_id, perfil, cliente, notas, forzar=True)
                return
            if r.motivo != 'vencida':
                self._mensaje('Pedidos web', f"No se puede facturar: {r.rechazo}.")
            return

        pedido = r.pedido or self._pedido(pid)
        intento = r.intento
        venta = self._venta_para_factura(pid, pedido, sale_id)
        if perfil is None:
            from pos_system.ui.sales_history_view import _PreFacturaDialog
            self._modal += 1
            try:
                pre = _PreFacturaDialog(self)
                if pre.exec_() != QDialog.Accepted or not pre.selected_perfil:
                    self._en_fondo(lambda: self._nube.soltar_factura(pid, intento), lambda _r: None)
                    return
                perfil, cliente = pre.selected_perfil, pre.selected_cliente
            finally:
                self._fin_modal()

        from pos_system.ui.factura_dialog import FacturaDialog
        self._modal += 1
        try:
            fac = FacturaDialog(self, sale=venta, auto_virtual=(venta.get('payment_type') == 'transfer'),
                                perfil=perfil, cliente_data=cliente, notas=notas)
            fac.exec_()
            emitida = getattr(fac, 'factura_emitida', None)
        finally:
            self._fin_modal()

        if not emitida:
            self._en_fondo(lambda: self._nube.soltar_factura(pid, intento), lambda _r: None)
            return
        if not str(emitida.get('cae') or '').strip():
            # Un PDF sin CAE no es una factura en ARCA: el pedido queda sin facturar.
            self._en_fondo(lambda: self._nube.soltar_factura(pid, intento), lambda _r: None)
            self._mensaje('Sin CAE', 'Se generó el comprobante sin CAE: en ARCA el pedido sigue sin facturar.',
                          QMessageBox.Warning)
            return
        if not getattr(fac, 'pdf_path', None):
            self._mensaje('Factura emitida', 'ARCA dio el CAE pero el PDF no se pudo generar. '
                                             'La factura queda anotada en el pedido: no lo vuelvas a facturar; '
                                             'el PDF se puede rehacer desde Fiscal AFIP.', QMessageBox.Warning)

        def anotada(res):
            if not res.ok:
                logger.error(f'Pedidos web: factura de {pid} emitida pero no anotada: {res.rechazo}')
                datos = {k: emitida.get(k) for k in ('tipo_comprobante', 'punto_venta', 'nro_comprobante', 'cae')}
                self._en_fondo(lambda: self._nube.anotar_problema(
                    pid, 'facturar', f'emitida pero no anotada: {res.rechazo}', {'factura': datos}), lambda _r: None)
                self._mensaje('Factura emitida', 'La factura se emitió pero no quedó anotada en el pedido. '
                                                 'No lo vuelvas a facturar.', QMessageBox.Warning)

        self._en_fondo(lambda: self._nube.anotar_factura(pid, intento, emitida), anotada)

    def _venta_para_factura(self, pid, pedido, sale_id):
        cobro = (pedido or {}).get('cobro') or {}
        if sale_id is None and cobro.get('intento'):
            filas = self.db.execute_query(
                "SELECT id FROM sales WHERE pedido_tienda_id = ? AND pedido_tienda_intento = ?",
                (pid, cobro.get('intento')))
            sale_id = int(filas[0]['id']) if filas else None
        if sale_id is not None:
            venta = self.sale_model.get_by_id(int(sale_id))
            if venta:
                return dict(venta)
        # Venta TIENDA del panel o cobrada en otra caja: la factura se arma con
        # los renglones del pedido y no toca ninguna venta de esta PC. El medio
        # de pago es el del cobro si lo hubo, no el que eligió el cliente online.
        return {
            'id': None,
            'items': reglas.renglones_de_cobro(pedido, pid),
            'total_amount': reglas.total_a_cobrar(pedido),
            'payment_type': (cobro.get('pago') or {}).get('payment_type') or reglas.pago_sugerido(pedido),
            'pedido_tienda_id': pid,
            'pedido_tienda_codigo': str(pedido.get('codigo') or ''),
        }
