"""
El carrito de esta caja a la vista de las otras, y los de las otras a la vista
de esta.

`CarritoCompartido` vive al lado de la pantalla de Ventas:

  - Cada cambio del carrito se publica 1,2 s después del último (si el cajero
    escanea diez productos seguidos sale una sola escritura).
  - Mientras haya carrito, se renueva cada 45 s: así las otras cajas saben que
    esta sigue viva. Sin carrito, cada 90 s se hace una lectura chica para saber
    si hay internet.
  - Todas las operaciones con la nube pasan por UN hilo, en orden.
  - Traer = pedir. Esta caja deja una solicitud, espera que la otra la entregue
    (ESPERA_ENTREGA_SEG) y, si no contesta, la cancela: la venta sigue allá.
  - Escucha las solicitudes de SU venta y avisa a la pantalla, que decide si
    entrega (con su carrito de ese momento) o rechaza (está cobrando).
  - Si en su documento aparece una venta entregada que todavía no cargó (llegó
    después de dejar de esperar, o con la caja cerrada), avisa para adoptarla.

La nube (`NubeCarritos` o el doble de las pruebas) se conecta después con
`conectar()`, cuando Firebase está listo. Sin nube el carrito anda igual que
siempre: nada de esto se interpone en una venta.
"""
import logging
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, Optional, Tuple

from PyQt5.QtCore import QEventLoop, QObject, QTimer, pyqtSignal

from pos_system.models import carrito_vivo as reglas

logger = logging.getLogger(__name__)

DEBOUNCE_MS = 1200
REVISION_MS = 15_000
SONDEO_ENTREGA_SEG = 0.25


class _Trabajo:
    __slots__ = ('tipo', 'args', 'listo', 'salida', 'esperado')

    def __init__(self, tipo, args, esperado=False):
        self.tipo = tipo
        self.args = args
        self.listo = threading.Event()
        self.salida = None
        self.esperado = esperado


class CarritoCompartido(QObject):
    otras_cajas = pyqtSignal(object)      # lista de carritos de otras cajas
    piden_la_venta = pyqtSignal(object)   # solicitud de otra caja por la venta de esta
    venta_llego = pyqtSignal(object)      # documento con una venta entregada sin cargar
    conexion = pyqtSignal(bool)

    _llego = pyqtSignal(object, object)       # docs, hora del servidor (hilo de la escucha)
    _solicitud = pyqtSignal(object, object)   # solicitud, hora (hilo de la escucha)
    _publicado = pyqtSignal(object)           # resultado (hilo de trabajo)

    def __init__(self, pc_id: str, estado_actual: Callable[[], Tuple[Optional[str], Optional[Dict]]],
                 nombre_caja: Callable[[], str], parent=None, debounce_ms: int = DEBOUNCE_MS,
                 keepalive_ms: int = reglas.KEEPALIVE_SEG * 1000, revision_ms: int = REVISION_MS,
                 espera_entrega_seg: float = reglas.ESPERA_ENTREGA_SEG):
        """`estado_actual()` corre en el hilo de la pantalla y devuelve
        (epoch, estado) — estado None si el carrito está vacío; en ese caso el
        epoch es el de la última venta que tuvo, para vaciar su documento."""
        super().__init__(parent)
        self.pc_id = pc_id
        self._estado_actual = estado_actual
        self._nombre_caja = nombre_caja
        self.espera_entrega_seg = espera_entrega_seg
        self.nube = None
        self._en_linea: Optional[bool] = None
        self._docs: Dict[str, Dict] = {}
        self._desfase = timedelta(0)
        self._escucha = None
        self._escucha_sol = None
        self._cola = deque()
        self._cond = threading.Condition()
        self._hilo: Optional[threading.Thread] = None
        self._activo = False
        self._esperando_entrega = False
        self._solicitudes_vistas = set()
        self._llegadas_avisadas = set()

        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.setInterval(debounce_ms)
        self._debounce.timeout.connect(self._publicar_estado)
        self._keepalive = QTimer(self)
        self._keepalive.setInterval(keepalive_ms)
        self._keepalive.timeout.connect(self._renovar)
        self._revision = QTimer(self)
        self._revision.setInterval(revision_ms)
        self._revision.timeout.connect(self._revisar)
        self._vueltas_sin_carrito = 0

        self._llego.connect(self._al_llegar)
        self._solicitud.connect(self._al_llegar_solicitud)
        self._publicado.connect(self._al_publicar)

    # ── Ciclo de vida ───────────────────────────────────────────────────────
    @property
    def conectado(self) -> bool:
        return self.nube is not None

    @property
    def en_linea(self) -> Optional[bool]:
        """None = todavía no se sabe; False = la última operación falló."""
        return self._en_linea

    def conectar(self, nube):
        if self.nube is not None:
            return
        self.nube = nube
        self._activo = True
        self._hilo = threading.Thread(target=self._trabajar, daemon=True, name='carritos-vivos')
        self._hilo.start()
        # Lo que quedó publicado de una sesión anterior murió con ella (el
        # carrito vive en memoria) y se vacía. Una venta que otra caja entregó
        # mientras esta estaba cerrada NO: la regla la devuelve para adoptar.
        self._encolar(_Trabajo('publicar', (None, None, True)))
        if self._estado_actual()[1] is not None:
            self._publicar_estado()
        self._abrir_escuchas()
        self._keepalive.start()
        self._revision.start()
        self.otras_cajas.emit(self.carritos())

    def vaciar_al_cerrar(self, esperar_seg: float = 2.0):
        """Al cerrar el POS el carrito se pierde (vive en memoria): que las
        otras cajas no lo vean como una venta abierta."""
        if self.nube is None:
            return
        trabajo = _Trabajo('publicar', (None, None, True), esperado=True)
        self._encolar(trabajo)
        trabajo.listo.wait(esperar_seg)

    def detener(self):
        self._activo = False
        for t in (self._debounce, self._keepalive, self._revision):
            t.stop()
        for esc in (self._escucha, self._escucha_sol):
            if esc is not None:
                try:
                    esc.unsubscribe()
                except Exception:
                    pass
        self._escucha = self._escucha_sol = None
        with self._cond:
            self._cond.notify_all()

    # ── Lo que llama la pantalla ────────────────────────────────────────────
    def cambio(self):
        """El carrito cambió: se publica cuando el cajero deja de tocarlo."""
        if self.nube is not None:
            self._debounce.start()

    def publicar_ya(self, esperar_seg: float = 0) -> Optional[dict]:
        """Publica ahora. Con `esperar_seg` espera el resultado (sin congelar la
        pantalla) y lo devuelve; None si no llegó a tiempo o no hay nube."""
        if self.nube is None:
            return None
        self._debounce.stop()
        epoch, estado = self._estado_actual()
        if epoch is None and estado is None:
            return None
        trabajo = _Trabajo('publicar', (epoch, estado, False), esperado=esperar_seg > 0)
        self._encolar(trabajo)
        if esperar_seg <= 0:
            return None
        return trabajo.salida if _esperar(trabajo.listo, esperar_seg) else None

    def soltar(self, epoch: str):
        """Vacía el documento propio de una venta que se pasó a pendientes."""
        if self.nube is not None and epoch:
            self._encolar(_Trabajo('publicar', (epoch, None, False)))

    def traer(self, origen_pc: str, epoch_visto: str, quien: Dict) -> dict:
        """Pide la venta a la otra caja y espera la entrega.

        Devuelve {'ok': True, 'entrega': doc} o {'ok': False, 'motivo',
        'rechazo'}. Nunca deja la venta en dos cajas: si la otra no contesta,
        la solicitud se cancela (o vence sola en el servidor)."""
        if self.nube is None:
            return {'ok': False, 'motivo': 'sin_nube',
                    'rechazo': 'Esta caja no está conectada a la nube.'}
        self._debounce.stop()
        # Lo que esta caja tenía pendiente de publicar sale antes (por ejemplo,
        # vaciar el carrito que acaba de dejar en pendiente): la entrega exige
        # que el documento de esta caja no tenga otra venta.
        epoch, estado = self._estado_actual()
        if not (epoch is None and estado is None):
            self._encolar(_Trabajo('publicar', (epoch, estado, False)))
        sol_id = uuid.uuid4().hex[:16]
        trabajo = _Trabajo('traer', (origen_pc, epoch_visto, quien, sol_id), esperado=True)
        self._esperando_entrega = True
        try:
            self._encolar(trabajo)
            # El hilo de trabajo tiene sus propios plazos; esto es por las dudas.
            _esperar(trabajo.listo, self.espera_entrega_seg + 3 * 8 + 2)
        finally:
            self._esperando_entrega = False
        return trabajo.salida or {'ok': False, 'motivo': 'sin_confirmar',
                                  'rechazo': 'No se pudo confirmar con la otra caja.'}

    def entregar(self, sol: Dict, epoch: str, estado: Dict, esperar_seg: float = 10) -> dict:
        trabajo = _Trabajo('entregar', (sol.get('id'), epoch, estado), esperado=True)
        self._encolar(trabajo)
        if not _esperar(trabajo.listo, esperar_seg):
            return {'ok': False, 'motivo': 'demora'}
        return trabajo.salida or {'ok': False, 'motivo': 'error'}

    def rechazar(self, sol: Dict, motivo: str):
        if self.nube is not None and sol.get('id'):
            self._encolar(_Trabajo('rechazar', (sol['id'], motivo)))

    def carritos(self):
        return reglas.carritos_de_otras_cajas(self._docs, self.pc_id, self.ahora())

    def doc_de(self, pc_id: str) -> Optional[Dict]:
        return self._docs.get(pc_id)

    def ahora(self) -> datetime:
        """La hora del servidor, estimada con la última lectura."""
        return datetime.now(timezone.utc) + self._desfase

    # ── Hilo de trabajo ─────────────────────────────────────────────────────
    def _encolar(self, trabajo: _Trabajo):
        with self._cond:
            # Publicaciones seguidas sin nadie esperando: alcanza con la última.
            if (trabajo.tipo == 'publicar' and not trabajo.esperado and self._cola
                    and self._cola[-1].tipo == 'publicar' and not self._cola[-1].esperado
                    and not self._cola[-1].args[2] and self._cola[-1].args[1] is not None
                    and trabajo.args[1] is not None):
                self._cola[-1] = trabajo
            else:
                self._cola.append(trabajo)
            self._cond.notify()

    def _trabajar(self):
        while True:
            with self._cond:
                while self._activo and not self._cola:
                    self._cond.wait()
                if not self._activo:
                    return
                trabajo = self._cola.popleft()
            try:
                trabajo.salida = self._hacer(trabajo)
            except Exception as e:
                logger.warning(f'Carritos vivos: {trabajo.tipo} falló: {e}')
                trabajo.salida = {'ok': False, 'motivo': 'error', 'accion': 'error',
                                  'rechazo': 'No se pudo hablar con la nube.'}
            finally:
                trabajo.listo.set()
            self._publicado.emit(dict(trabajo.salida or {}, tipo=trabajo.tipo))

    def _hacer(self, trabajo):
        n = self.nube
        if trabajo.tipo == 'publicar':
            epoch, estado, forzar = trabajo.args
            return dict(n.publicar(self.pc_id, self._nombre_caja(), epoch, estado, forzar_vacio=forzar))
        if trabajo.tipo == 'traer':
            return self._pedir_y_esperar(*trabajo.args)
        if trabajo.tipo == 'entregar':
            sol_id, epoch, estado = trabajo.args
            return dict(n.entregar(self.pc_id, self._nombre_caja(), sol_id, epoch, estado))
        if trabajo.tipo == 'rechazar':
            sol_id, motivo = trabajo.args
            return dict(n.rechazar(self.pc_id, sol_id, motivo))
        if trabajo.tipo == 'probar':
            try:
                return {'ok': True, 'hora': n.probar(self.pc_id)}
            except Exception:
                return {'ok': False, 'motivo': 'error'}
        raise ValueError(trabajo.tipo)

    def _pedir_y_esperar(self, origen_pc, epoch_visto, quien, sol_id):
        n = self.nube
        r = n.pedir(origen_pc, epoch_visto, quien, sol_id)
        if not r.get('ok'):
            return dict(r)
        nombre = reglas.nombre_de_caja(self._docs.get(origen_pc), origen_pc)
        fin = time.monotonic() + self.espera_entrega_seg
        while time.monotonic() < fin and self._activo:
            try:
                sol = n.leer_solicitud(origen_pc)
            except Exception:
                sol = None
            if sol and sol.get('id') == sol_id:
                if sol.get('estado') == 'entregada':
                    return {'ok': True, 'entrega': sol.get('entrega') or {}}
                if sol.get('estado') == 'rechazada':
                    return {'ok': False, 'motivo': 'rechazada',
                            'rechazo': sol.get('motivo') or f'La {nombre} no la entregó.'}
            time.sleep(SONDEO_ENTREGA_SEG)
        # No contestó a tiempo: se cancela para que no la entregue tarde.
        c = n.cancelar(origen_pc, sol_id)
        if c.get('accion') == 'llego':
            return {'ok': True, 'entrega': (c.get('sol') or {}).get('entrega') or {}}
        if c.get('accion') == 'cancelar':
            return {'ok': False, 'motivo': 'no_responde',
                    'rechazo': f'La {nombre} no responde: la venta sigue allá.'}
        if c.get('accion') == 'error':
            return {'ok': False, 'motivo': 'sin_confirmar',
                    'rechazo': f'No se pudo confirmar con la {nombre}. Si la venta llega, '
                               f'aparece sola en esta caja.'}
        estado = (c.get('sol') or {}).get('estado') or ''
        if estado == 'rechazada':
            return {'ok': False, 'motivo': 'rechazada',
                    'rechazo': (c.get('sol') or {}).get('motivo') or f'La {nombre} no la entregó.'}
        return {'ok': False, 'motivo': 'no_responde',
                'rechazo': f'La {nombre} no responde: la venta sigue allá.'}

    # ── Resultados, en el hilo de la pantalla ───────────────────────────────
    def _al_publicar(self, r):
        tipo = r.get('tipo')
        if tipo == 'publicar':
            caida = r.get('accion') == 'error'
        elif tipo == 'probar':
            caida = not r.get('ok')
        else:
            caida = r.get('motivo') == 'error'
        self._marcar_linea(not caida)
        if tipo == 'publicar' and r.get('accion') == 'adoptar':
            self._avisar_llegada(r.get('doc') or {})
        elif tipo == 'probar' and isinstance(r.get('hora'), datetime):
            self._anotar_hora(r['hora'])

    def _marcar_linea(self, ok: bool):
        if ok != self._en_linea:
            self._en_linea = ok
            self.conexion.emit(ok)
            self.otras_cajas.emit(self.carritos())

    def _avisar_llegada(self, doc):
        """Una venta entregada a esta caja que todavía no está en el carrito."""
        if self._esperando_entrega or not reglas.tiene_venta(doc):
            return
        epoch, estado = self._estado_actual()
        if estado is not None and epoch == doc.get('epoch'):
            return
        clave = (doc.get('epoch'), doc.get('solicitud_id'))
        if clave in self._llegadas_avisadas:
            return
        self._llegadas_avisadas.add(clave)
        self.venta_llego.emit(doc)

    # ── Publicación ─────────────────────────────────────────────────────────
    def _publicar_estado(self):
        epoch, estado = self._estado_actual()
        if epoch is None and estado is None:
            return
        self._encolar(_Trabajo('publicar', (epoch, estado, False)))

    def _renovar(self):
        epoch, estado = self._estado_actual()
        if estado is not None:
            self._publicar_estado()
            self._vueltas_sin_carrito = 0
            return
        self._vueltas_sin_carrito += 1
        if self._vueltas_sin_carrito % 2 == 0:
            self._encolar(_Trabajo('probar', ()))

    # ── Escuchas ────────────────────────────────────────────────────────────
    def _abrir_escuchas(self):
        try:
            self._escucha = self.nube.escuchar(lambda docs, hora: self._llego.emit(docs, hora))
        except Exception as e:
            logger.warning(f'Carritos vivos: no se pudo abrir la escucha: {e}')
            self._escucha = None
        try:
            self._escucha_sol = self.nube.escuchar_solicitudes(
                self.pc_id, lambda sol, hora: self._solicitud.emit(sol, hora))
        except Exception as e:
            logger.warning(f'Carritos vivos: no se pudo escuchar las solicitudes: {e}')
            self._escucha_sol = None

    def _al_llegar(self, docs, hora):
        self._anotar_hora(hora)
        self._docs = dict(docs or {})
        self._marcar_linea(True)
        propio = self._docs.get(self.pc_id) or {}
        if propio.get('pendiente_de_cargar'):
            self._avisar_llegada(propio)
        self.otras_cajas.emit(self.carritos())

    def _al_llegar_solicitud(self, sol, hora):
        """Otra caja pide la venta de esta. Se contesta una sola vez por
        solicitud y nunca una vencida (la otra ya dejó de esperar)."""
        self._anotar_hora(hora)
        if not sol or sol.get('estado') != 'pedida' or not sol.get('id'):
            return
        if sol['id'] in self._solicitudes_vistas:
            return
        ahora = hora if isinstance(hora, datetime) else self.ahora()
        if reglas.solicitud_vencida(sol, ahora):
            return
        self._solicitudes_vistas.add(sol['id'])
        self.piden_la_venta.emit(sol)

    def _anotar_hora(self, hora):
        if isinstance(hora, datetime) and hora.tzinfo is not None:
            desfase = hora - datetime.now(timezone.utc)
            # El retardo de la red no es desfase del reloj: solo si es grande.
            self._desfase = desfase if abs(desfase) > timedelta(seconds=20) else timedelta(0)

    def _revisar(self):
        """Cada 15 s: saca de la lista las cajas que dejaron de dar señales y
        reabre las escuchas si se cayeron."""
        if self.nube is None:
            return
        caida = getattr(self.nube, 'escucha_caida', None)
        if caida is not None and (caida(self._escucha) or caida(self._escucha_sol)):
            logger.warning('Carritos vivos: reabriendo las escuchas')
            for esc in (self._escucha, self._escucha_sol):
                if esc is not None:
                    try:
                        esc.unsubscribe()
                    except Exception:
                        pass
            self._abrir_escuchas()
        self.otras_cajas.emit(self.carritos())


def _esperar(evento: threading.Event, segundos: float) -> bool:
    """Espera un evento sin congelar la pantalla (sigue pintando y atendiendo
    las escuchas)."""
    if evento.is_set():
        return True
    lazo = QEventLoop()
    fin = time.monotonic() + segundos
    revisar = QTimer()
    revisar.setInterval(25)

    def _tic():
        if evento.is_set() or time.monotonic() >= fin:
            lazo.quit()

    revisar.timeout.connect(_tic)
    revisar.start()
    lazo.exec_()
    revisar.stop()
    return evento.is_set()
