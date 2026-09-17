"""
La franja de pedidos web, arriba de todas las pestañas del POS.

Antes el aviso era un cartel de 9 segundos en la esquina de abajo, justo encima
del botón Cobrar: tapaba lo que el cajero aprieta y, cuando se iba, no quedaba
nada a la vista. La franja va debajo del encabezado, no tapa nada y se queda
mientras haya algo que hacer:

  · pedidos nuevos sin aceptar (lo urgente: color fuerte);
  · pedidos entregados que falta cobrar (color suave).

Se arma con lo que llega en vivo de la tienda, así que en cuanto una caja acepta
o cobra un pedido, la franja se actualiza en TODAS: nadie queda con un aviso de
algo que ya resolvió otro.

Suena al llegar un pedido y, mientras siga sin aceptar, vuelve a sonar cada
`RECORDAR_CADA_S` (salvo con la pestaña Pedidos web a la vista: ahí ya se ve).
Con el POS minimizado, además titila en la barra de tareas.
"""
import time

from PyQt5.QtCore import Qt, QTimer, pyqtSignal
from PyQt5.QtWidgets import QApplication, QHBoxLayout, QLabel, QPushButton, QSizePolicy, QVBoxLayout, QWidget

from pos_system.models import pedido_tienda as reglas
from pos_system.ui.theme import COLORS as _T

RECORDAR_CADA_S = 180
REVISAR_MS = 15_000


def pesos(n):
    return '$' + f'{reglas.num(n):,.0f}'.replace(',', '.')


def _lista(codigos):
    codigos = [c for c in codigos if c]
    if len(codigos) <= 1:
        return ''.join(codigos)
    return ', '.join(codigos[:-1]) + ' y ' + codigos[-1]


def textos_de_la_franja(pendientes):
    """(título, detalle, tono, texto del botón) o None si no hay nada.

    tono: 'nuevo' (hay pedidos sin aceptar) o 'cobrar' (solo falta cobrar)."""
    nuevos = (pendientes or {}).get('nuevos') or []
    cobrar = (pendientes or {}).get('cobrar') or []
    if not nuevos and not cobrar:
        return None
    if nuevos:
        if len(nuevos) == 1:
            p = nuevos[0]
            titulo = 'Pedido web nuevo'
            detalle = (f"{p['codigo']} · {p['cliente'] or 'Sin nombre'} · {pesos(p['total'])} · "
                       f"{'envío a domicilio' if p['envio'] else 'retira en el local'}")
        else:
            titulo = f'{len(nuevos)} pedidos web sin aceptar'
            detalle = _lista([p['codigo'] for p in nuevos[:6]]) + (' y más' if len(nuevos) > 6 else '')
        if cobrar:
            detalle += f" · para cobrar: {_lista([p['codigo'] for p in cobrar[:4]])}"
        return titulo, detalle, 'nuevo', 'Ver pedido' if len(nuevos) == 1 else 'Ver pedidos'
    if len(cobrar) == 1:
        p = cobrar[0]
        quien = 'lo entregó el repartidor' if p['por_reparto'] else 'ya se entregó'
        return ('Pedido web para cobrar', f"{p['codigo']} · {p['cliente'] or 'Sin nombre'} · "
                f"{pesos(p['total'])} · {quien}", 'cobrar', 'Ver pedido')
    return (f'{len(cobrar)} pedidos web para cobrar', _lista([p['codigo'] for p in cobrar[:6]]),
            'cobrar', 'Ver pedidos')


class FranjaPedidos(QWidget):
    """`actualizar(pendientes)` con lo que calcula `reglas.pendientes_de_aviso`;
    `ver(pedido_id)` al tocar el botón."""
    ver = pyqtSignal(str)

    def __init__(self, parent=None, sonar=None, reloj=time.monotonic):
        super().__init__(parent)
        self._sonar = sonar or self._sonar_de_verdad
        self._reloj = reloj
        self._pendientes = {'nuevos': [], 'cobrar': []}
        self._en_pestana = False
        self._ultimo_sonido = None
        self.setObjectName('franjaPedidos')
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setVisible(False)

        fila = QHBoxLayout(self)
        fila.setContentsMargins(18, 8, 14, 8)
        fila.setSpacing(14)

        self._marca = QLabel('TIENDA')
        self._marca.setAlignment(Qt.AlignCenter)
        fila.addWidget(self._marca, 0, Qt.AlignVCenter)

        textos = QVBoxLayout()
        textos.setSpacing(1)
        self._titulo = QLabel('')
        self._detalle = QLabel('')
        self._detalle.setWordWrap(False)
        self._detalle.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        textos.addWidget(self._titulo)
        textos.addWidget(self._detalle)
        fila.addLayout(textos, 1)

        self._atajo = QLabel('F9')
        fila.addWidget(self._atajo, 0, Qt.AlignVCenter)
        self._boton = QPushButton('Ver pedido')
        self._boton.setCursor(Qt.PointingHandCursor)
        self._boton.clicked.connect(self._al_tocar)
        fila.addWidget(self._boton, 0, Qt.AlignVCenter)

        self._timer = QTimer(self)
        self._timer.timeout.connect(self.revisar_recordatorio)
        self._timer.start(REVISAR_MS)
        self._pintar_tono('nuevo')

    # ── Estado ──────────────────────────────────────────────────────────────
    def actualizar(self, pendientes):
        self._pendientes = {'nuevos': list((pendientes or {}).get('nuevos') or []),
                            'cobrar': list((pendientes or {}).get('cobrar') or [])}
        if not self._pendientes['nuevos']:
            # Lo aceptó alguien (acá u otra caja): el recordatorio arranca de cero
            # para el próximo pedido.
            self._ultimo_sonido = None
        self._refrescar()

    def set_en_pestana(self, en_pestana):
        self._en_pestana = bool(en_pestana)
        self._refrescar()

    def avisar_llegada(self):
        """Llegó un pedido (o hay pendientes al abrir el POS): suena ahora."""
        self._sonar()
        self._ultimo_sonido = self._reloj()

    def revisar_recordatorio(self):
        if not self._pendientes['nuevos'] or self._en_pestana:
            return
        ahora = self._reloj()
        if self._ultimo_sonido is None or ahora - self._ultimo_sonido >= RECORDAR_CADA_S:
            self._sonar()
            self._ultimo_sonido = ahora

    def pendientes(self):
        return self._pendientes

    # ── Dibujo ──────────────────────────────────────────────────────────────
    def _refrescar(self):
        textos = textos_de_la_franja(self._pendientes)
        if textos is None or self._en_pestana:
            self.setVisible(False)
            return
        titulo, detalle, tono, boton = textos
        self._titulo.setText(titulo)
        self._detalle.setText(detalle)
        self._detalle.setToolTip(detalle)
        self._boton.setText(boton)
        self._pintar_tono(tono)
        self.setVisible(True)

    def _pintar_tono(self, tono):
        if tono == 'nuevo':
            fondo, borde, texto, suave = _T['accent'], _T['accent_hover'], '#ffffff', '#fbe3d5'
            marca = f"background:#ffffff; color:{_T['accent']};"
            boton = (f"QPushButton {{ background:#ffffff; color:{_T['accent']}; border:none; border-radius:7px;"
                     f" padding:7px 18px; font-size:13px; font-weight:800; min-height:18px; }}"
                     f" QPushButton:hover {{ background:{_T['accent_soft']}; }}")
        else:
            fondo, borde, texto, suave = _T['accent_soft'], '#efd3c0', _T['text'], _T['text_muted']
            marca = f"background:{_T['accent']}; color:#ffffff;"
            boton = (f"QPushButton {{ background:{_T['accent']}; color:#ffffff; border:none; border-radius:7px;"
                     f" padding:7px 18px; font-size:13px; font-weight:800; min-height:18px; }}"
                     f" QPushButton:hover {{ background:{_T['accent_hover']}; }}")
        self.setStyleSheet(f"QWidget#franjaPedidos {{ background:{fondo}; border-bottom:1px solid {borde}; }}")
        self._marca.setStyleSheet(f"{marca} border-radius:5px; padding:3px 8px; font-size:10px;"
                                  " font-weight:800; letter-spacing:1px;")
        self._titulo.setStyleSheet(f"color:{texto}; background:transparent; font-size:14px; font-weight:800;")
        self._detalle.setStyleSheet(f"color:{suave}; background:transparent; font-size:12px; font-weight:600;")
        self._atajo.setStyleSheet(f"color:{suave}; background:transparent; border:1px solid {suave};"
                                  " border-radius:4px; padding:1px 5px; font-size:10px; font-weight:700;")
        self._boton.setStyleSheet(boton)

    def _al_tocar(self):
        lista = self._pendientes['nuevos'] or self._pendientes['cobrar']
        self.ver.emit(lista[0]['id'] if len(lista) == 1 else '')

    def _sonar_de_verdad(self):
        QApplication.beep()
        ventana = self.window()
        if ventana is not None:
            # Titila en la barra de tareas si el POS no está al frente.
            QApplication.alert(ventana, 0)
