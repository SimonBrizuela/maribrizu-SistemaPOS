"""
Los pedidos de la tienda en vivo, para la caja.

Cuatro escuchas chicas en vez de una grande, para no leer la colección entera
en cada PC:

  en_curso     estado nuevo / preparando / listo / en camino
  reparto      `venta_pendiente`: lo entregó el repartidor y falta el stock
  cobrar       `cobro_pendiente`: entregado, falta cobrarlo
  entregados   entregados en los últimos días (para ver lo cobrado)

Los cuatro se juntan por id quedándose con la versión más nueva de cada pedido,
y la lista completa viaja al hilo de la pantalla con una señal de Qt. Las
escuchas de Firestore corren en hilos propios: nada de lo que llega desde ahí
toca widgets.

Una escucha de Firestore en Python puede cerrarse sola ante un error que no
sabe recuperar, sin avisar. El vigía revisa cada minuto que sigan vivas y las
vuelve a abrir; también rehace la de entregados cuando cambia el día.

Lo que entregó el repartidor se descuenta desde acá: cualquier PC abierta lo
hace, con una espera al azar para que no salgan todas juntas, y la transacción
se encarga de que el stock salga una sola vez.
"""
import logging
import random
import threading
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, Optional

from PyQt5.QtCore import QObject, QTimer, pyqtSignal

from pos_system.models import pedido_tienda as reglas
from pos_system.utils.pedidos_tienda_nube import PEDIDOS

logger = logging.getLogger(__name__)

DIAS_ENTREGADOS = 7
REVISION_MS = 60_000
ESPERA_DESCUENTO = (0.5, 4.0)


def dias_hacia_atras(hoy: datetime, dias: int = DIAS_ENTREGADOS):
    return [reglas.dia_argentina(hoy - timedelta(days=n)) for n in range(dias)]


def juntar(por_consulta: Dict[str, Dict[str, tuple]]) -> Dict[str, dict]:
    """Une lo que trajo cada escucha. Si un pedido está en dos (se movió y una
    todavía no se enteró), gana la versión con la hora de actualización más
    nueva."""
    salida = {}
    versiones = {}
    for docs in por_consulta.values():
        for pid, (version, datos) in docs.items():
            if pid not in versiones or (version is not None and (versiones[pid] is None or version > versiones[pid])):
                versiones[pid] = version
                salida[pid] = datos
    return salida


class VigiaPedidos(QObject):
    cambiaron = pyqtSignal(object)      # {pedido_id: pedido}
    estado_conexion = pyqtSignal(bool)  # False si alguna escucha se cayó

    def __init__(self, db, nube, reloj: Callable[[], datetime] = None,
                 descontar_reparto: bool = True, parent=None):
        super().__init__(parent)
        self.db = db
        self.nube = nube
        self._reloj = reloj or (lambda: datetime.now(reglas.TZ_AR))
        self._descontar_reparto = descontar_reparto
        self._lock = threading.Lock()
        self._por_consulta: Dict[str, Dict[str, tuple]] = {}
        self._escuchas = {}
        self._dias = []
        self._descontando = set()
        self._ultimo: Dict[str, dict] = {}
        self._timer: Optional[QTimer] = None
        self._activo = False
        self._recibidas = set()
        self._vueltas = 0
        self._desfase = timedelta(0)

    # ── Ciclo de vida ───────────────────────────────────────────────────────
    def iniciar(self):
        if self._activo:
            return
        self._activo = True
        self._abrir_todas()
        self._timer = QTimer(self)
        self._timer.timeout.connect(self.revisar)
        self._timer.start(REVISION_MS)

    def detener(self):
        self._activo = False
        if self._timer:
            self._timer.stop()
        for nombre in list(self._escuchas):
            self._cerrar(nombre)

    def pedidos(self) -> Dict[str, dict]:
        with self._lock:
            return dict(self._ultimo)

    def ahora(self) -> datetime:
        """La hora del servidor, estimada con lo que tardó la última lectura.
        Las marcas de cobro y factura se escriben con la hora del servidor: con
        el reloj de una PC atrasada una marca vencida seguía pareciendo vigente
        y los botones quedaban trabados."""
        return datetime.now(reglas.TZ_AR) + self._desfase

    def _anotar_hora(self, hora):
        if isinstance(hora, datetime) and hora.tzinfo is not None:
            desfase = hora - datetime.now(timezone.utc)
            # Solo si es grande: el retardo de la red no es desfase del reloj.
            self._desfase = desfase if abs(desfase) > timedelta(seconds=20) else timedelta(0)

    def completo(self) -> bool:
        """Ya llegó la primera respuesta de las cuatro escuchas. Antes de eso la
        lista está a medias: tomarla como "lo que ya se vio" hacía sonar un aviso
        por cada pedido al abrir el POS."""
        with self._lock:
            return len(self._recibidas) >= 4

    # ── Escuchas ────────────────────────────────────────────────────────────
    def _consultas(self):
        from google.cloud.firestore_v1.base_query import FieldFilter
        col = self.db.collection(PEDIDOS)
        self._dias = dias_hacia_atras(self._reloj())
        return {
            'en_curso': col.where(filter=FieldFilter('estado', 'in', list(reglas.ESTADOS_EN_CURSO))),
            'reparto': col.where(filter=FieldFilter('venta_pendiente', '==', True)),
            'cobrar': col.where(filter=FieldFilter('cobro_pendiente', '==', True)),
            'entregados': col.where(filter=FieldFilter('estado', '==', 'entregado'))
                             .where(filter=FieldFilter('entregado_dia', 'in', list(self._dias))),
        }

    def _abrir_todas(self):
        for nombre, consulta in self._consultas().items():
            self._abrir(nombre, consulta)

    def _abrir(self, nombre, consulta):
        self._cerrar(nombre)

        def al_cambiar(docs, _cambios, hora):
            try:
                self._anotar_hora(hora)
                nuevos = {}
                for d in docs:
                    datos = d.to_dict() or {}
                    nuevos[d.id] = (getattr(d, 'update_time', None), {'id': d.id, **datos})
                self._recibir(nombre, nuevos)
            except Exception as e:
                logger.warning(f'Pedidos: error leyendo la escucha {nombre}: {e}')

        try:
            self._escuchas[nombre] = consulta.on_snapshot(al_cambiar)
        except Exception as e:
            logger.warning(f'Pedidos: no se pudo abrir la escucha {nombre}: {e}')
            self.estado_conexion.emit(False)

    def _cerrar(self, nombre):
        escucha = self._escuchas.pop(nombre, None)
        if escucha is not None:
            try:
                escucha.unsubscribe()
            except Exception:
                pass

    def _recibir(self, nombre, docs):
        with self._lock:
            self._por_consulta[nombre] = docs
            recien_completo = len(self._recibidas) < 4
            self._recibidas.add(nombre)
            recien_completo = recien_completo and len(self._recibidas) >= 4
            self._ultimo = juntar(self._por_consulta)
            copia = dict(self._ultimo)
        self.cambiaron.emit(copia)
        if recien_completo:
            self.estado_conexion.emit(True)
        if nombre == 'reparto' and self._descontar_reparto:
            for pid, (_v, pedido) in docs.items():
                self._programar_descuento(pid, pedido)

    def revisar(self):
        """Cada minuto: escuchas vivas, día al día y descuentos que quedaron."""
        if not self._activo:
            return
        caidas = [n for n, e in self._escuchas.items() if _esta_caida(e)]
        faltan = [n for n in ('en_curso', 'reparto', 'cobrar', 'entregados') if n not in self._escuchas]
        dia_nuevo = dias_hacia_atras(self._reloj()) != self._dias
        if caidas or faltan or dia_nuevo:
            if caidas or faltan:
                logger.warning(f'Pedidos: reabriendo escuchas {caidas + faltan}')
            consultas = self._consultas()
            for nombre in set(caidas + faltan + (['entregados'] if dia_nuevo else [])):
                self._abrir(nombre, consultas[nombre])
        # Una escucha sin internet no se cierra: reintenta callada y no avisa.
        # Para saber si hay conexión se lee un documento chico cada dos vueltas.
        self._vueltas += 1
        sin_abrir = [n for n in ('en_curso', 'reparto', 'cobrar', 'entregados') if n not in self._escuchas]
        if caidas or sin_abrir:
            # La que no se pudo abrir ya avisó; la prueba de conexión no la tapa.
            self.estado_conexion.emit(False)
        elif self._vueltas % 2 == 1:
            threading.Thread(target=self._probar_conexion, daemon=True, name='pedidos-conexion').start()
        if self._descontar_reparto:
            with self._lock:
                pendientes = dict(self._por_consulta.get('reparto') or {})
            for pid, (_v, pedido) in pendientes.items():
                self._programar_descuento(pid, pedido, espera=(0.0, 1.0))

    def _probar_conexion(self):
        try:
            snap = self.db.collection('tienda_config').document('settings').get(timeout=10)
            self._anotar_hora(getattr(snap, 'read_time', None))
            self.estado_conexion.emit(True)
        except Exception:
            self.estado_conexion.emit(False)

    # ── Lo que entregó el repartidor ────────────────────────────────────────
    def _programar_descuento(self, pedido_id, pedido, espera=ESPERA_DESCUENTO):
        if pedido.get('venta_pendiente') is not True or pedido.get('estado') == 'cancelado':
            return
        with self._lock:
            if pedido_id in self._descontando:
                return
            self._descontando.add(pedido_id)

        def trabajo():
            try:
                threading.Event().wait(random.uniform(*espera))
                with self._lock:
                    actual = (self._por_consulta.get('reparto') or {}).get(pedido_id)
                if actual is None:
                    return          # otra PC ya lo descontó y la escucha se enteró
                r = self.nube.entregar(pedido_id, origen='reparto')
                if not r.ok:
                    logger.warning(f'Pedidos: no se descontó el stock de {pedido_id}: {r.rechazo}')
            except Exception as e:
                logger.warning(f'Pedidos: descuento de {pedido_id} falló: {e}')
            finally:
                with self._lock:
                    self._descontando.discard(pedido_id)

        threading.Thread(target=trabajo, daemon=True, name=f'descuento-{pedido_id[:6]}').start()


def _esta_caida(escucha) -> bool:
    if escucha is None:
        return True
    if getattr(escucha, '_closed', False):
        return True
    return False
