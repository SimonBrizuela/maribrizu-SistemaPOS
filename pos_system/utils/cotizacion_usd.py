"""
A cuanto esta el dolar, para los productos que se compran en dolares.

Un producto marcado en dolares guarda el precio en dolares y se cobra en pesos
con la cotizacion del momento (ver `precio_usd.py`). Este modulo es el que
consigue esa cotizacion y se asegura de que NUNCA falte.

Una sola consulta entre todas las cajas
---------------------------------------
En el local hay cinco PCs. Que cada una le pregunte a la API por su cuenta es
cinco veces el mismo pedido, cinco valores que pueden diferir por minutos, y
cinco precios distintos para el mismo producto segun en que caja se cobre.

Por eso la cotizacion vive en UN documento compartido, `config/cotizacion_usd`:

    · Cada PC lo escucha con un listener de Firestore. Cuando una lo actualiza,
      las demas se enteran en el acto, sin preguntar nada y sin costo.
    · Salir a la API es tarea de una sola. Cada PC mira cada tanto la edad del
      documento; si ya lo refresco otra hace poco, no hace nada. Si esta
      vencido, espera unos segundos al azar (para no arrancar las cinco juntas),
      vuelve a mirar por si alguna se adelanto, y recien ahi consulta y sube el
      valor para todas.

Las cuatro fuentes, en orden
----------------------------
    1. `config/cotizacion_usd` en Firestore — lo que consiguio la primera PC.
    2. dolarapi.com, y si no contesta, bluelytics.com.ar — solo cuando ese
       documento esta vencido.
    3. La tabla `config` del SQLite local. Sobrevive a quedarse sin internet y
       sin nube: se vende con el dolar de la ultima vez que hubo señal.
    4. Si no hay ninguna, `precio_usd` no convierte nada y el POS cobra el
       ultimo precio en pesos que quedo guardado en el producto.

Nunca se bloquea la caja esperando la red: la consulta HTTP pasa siempre por un
hilo aparte con timeout corto, y el que pregunta se lleva lo que hay en
memoria. Si lo que hay esta vencido, el que pregunta decide si espera
(`refrescar_ahora`, que es lo que hace la pantalla de ventas mostrando
"Calculando precio en pesos...") o si sigue con lo viejo.

Modo a mano: si `config/cotizacion_usd` viene con `manual: true`, ese valor
manda y no se le pregunta a nadie mas. Sirve cuando el proveedor cobra a un
dolar propio, o cuando la API dice cualquier cosa.
"""
import json
import logging
import random
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from pos_system.utils.precio_usd import cotizacion_valida

logger = logging.getLogger(__name__)

# De donde sale cada dolar. El dueño elige el tipo desde el panel y viaja en
# `config/cotizacion_usd.tipo`; el POS lo respeta.
#
# Dos proveedores y no uno: si dolarapi se cae o cambia el formato —y en algun
# momento va a pasar— el local se queda sin poder actualizar los precios de lo
# importado y nadie se entera hasta que el dolar se movio un 10%. El segundo se
# consulta solo cuando el primero no contesta.
#
# Cada entrada dice de donde sacar el precio de VENTA: es a lo que se compra el
# dolar en la calle, o sea lo que cuesta reponer la mercaderia.
FUENTES = {
    'blue': [
        ('https://dolarapi.com/v1/dolares/blue',   ('venta',)),
        ('https://api.bluelytics.com.ar/v2/latest', ('blue', 'value_sell')),
    ],
    'oficial': [
        ('https://dolarapi.com/v1/dolares/oficial', ('venta',)),
        ('https://api.bluelytics.com.ar/v2/latest', ('oficial', 'value_sell')),
    ],
    'tarjeta': [
        ('https://dolarapi.com/v1/dolares/tarjeta', ('venta',)),
    ],
}
TIPO_DEFAULT = 'blue'


# El documento donde vive la cotizacion compartida por todas las PCs.
COLECCION = 'config'
DOCUMENTO = 'cotizacion_usd'

# Cada cuanto se le pregunta a la API. NO es cada cuanto se actualiza cada PC:
# el valor viaja por el listener en el acto. Es cada cuanto, entre TODAS las
# cajas juntas, se sale a internet. El dolar blue se mueve un puñado de veces
# al dia; media hora es de sobra. Se puede cambiar desde el panel poniendo
# `refresco_minutos` en el documento.
REFRESCO_MINUTOS = 30

# Cada cuanto cada PC se pregunta "¿hace falta que salga yo?". Barato: mira la
# edad de lo que ya tiene en memoria (el listener lo mantiene al dia), no
# consulta nada.
INTERVALO_CHEQUEO = 300           # 5 minutos

# Antes de salir a la API, cada PC espera un rato al azar dentro de esta
# ventana. Con cinco cajas prendidas a la misma hora, evita que las cinco vean
# el documento vencido en el mismo segundo y consulten todas.
VENTANA_DESFASAJE = 25            # segundos

# Hasta cuando un valor se considera del momento para cobrar sin pensarlo.
# Mas ancho que REFRESCO_MINUTOS a proposito: entre refresco y refresco la
# cotizacion sigue siendo buena, no hay que frenar la caja por eso.
FRESCA_SEGUNDOS = 75 * 60         # 75 minutos

# Cuanto se espera a la API. Corto a proposito: es una caja, no un navegador.
TIMEOUT_HTTP = 4

# Claves de la tabla `config` del SQLite.
_K_VALOR  = 'cotizacion_usd_valor'
_K_TS     = 'cotizacion_usd_ts'
_K_FUENTE = 'cotizacion_usd_fuente'
_K_TIPO   = 'cotizacion_usd_tipo'
_K_MANUAL = 'cotizacion_usd_manual'


def _ahora():
    return time.time()


def _iso(ts):
    """Texto ISO con zona, como lo escriben el panel y el resto del POS."""
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone().isoformat()
    except (OverflowError, OSError, ValueError):
        return ''


def _ts_de_iso(texto):
    """Un ISO como los que escribe el panel, en segundos. 0 si no se entiende.

    Acepta tambien un Timestamp de Firestore (lo que deja `serverTimestamp()`
    cuando escribe la webapp), que llega como datetime.
    """
    if not texto:
        return 0.0
    if isinstance(texto, datetime):
        dt = texto if texto.tzinfo else texto.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    if isinstance(texto, (int, float)):
        # Segundos o milisegundos desde 1970: se distinguen por el orden.
        n = float(texto)
        return n / 1000.0 if n > 1e11 else n
    s = str(texto).strip().replace('Z', '+00:00')
    for corte in (None, 19):
        try:
            dt = datetime.fromisoformat(s if corte is None else s[:corte])
        except ValueError:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    return 0.0


class CotizacionUSD:
    """El ultimo dolar conocido, con de donde salio y de cuando es."""

    def __init__(self):
        self._lock = threading.RLock()
        self._valor = 0.0
        self._ts = 0.0                 # de cuando es el valor (epoch)
        self._fuente = ''              # 'dolarapi' | 'otra PC' | 'local' | 'a mano'
        self._tipo = TIPO_DEFAULT
        self._manual = False
        self._refresco_minutos = REFRESCO_MINUTOS
        self._db = None                # DatabaseManager, para la copia local
        self._hilo = None
        self._parar = threading.Event()
        self._refrescando = threading.Event()
        self._listener = None
        self._avisos = []              # funciones a llamar cuando cambia

    # ── Lo que se lee desde afuera ────────────────────────────────────────

    def valor(self):
        """El dolar que hay ahora mismo. 0 si nunca se pudo conseguir uno."""
        with self._lock:
            return self._valor if cotizacion_valida(self._valor) else 0.0

    def estado(self):
        """Todo junto, para mostrarlo en pantalla sin pedir cuatro cosas."""
        with self._lock:
            return {
                'valor': self._valor if cotizacion_valida(self._valor) else 0.0,
                'ts': self._ts,
                'edad': (_ahora() - self._ts) if self._ts else None,
                'fuente': self._fuente,
                'tipo': self._tipo,
                'manual': self._manual,
                'fresca': self.esta_fresca(),
            }

    def edad_segundos(self):
        with self._lock:
            return (_ahora() - self._ts) if self._ts else None

    def esta_fresca(self, max_segundos=FRESCA_SEGUNDOS):
        """True si el valor es de hace poco y se puede cobrar sin pensar.

        Una cotizacion cargada a mano no vence: es una decision del dueño, no
        una lectura que se pone vieja.
        """
        with self._lock:
            if not cotizacion_valida(self._valor):
                return False
            if self._manual:
                return True
            return self._ts > 0 and (_ahora() - self._ts) <= max_segundos

    def al_cambiar(self, funcion):
        """Registra a quien quiera enterarse cuando cambia la cotizacion.

        Se llama desde el hilo que trajo el valor (el listener de Firestore o
        el de refresco), asi que el que la use desde la interfaz tiene que
        volver al hilo de Qt por su cuenta — con una señal, por ejemplo.
        """
        with self._lock:
            if funcion not in self._avisos:
                self._avisos.append(funcion)

    def _avisar(self):
        with self._lock:
            avisos = list(self._avisos)
            valor = self._valor
        for fn in avisos:
            try:
                fn(valor)
            except Exception as e:
                logger.debug(f"cotizacion: aviso de cambio fallo: {e}")

    # ── Arranque y apagado ────────────────────────────────────────────────

    def iniciar(self, db_manager=None, intervalo=INTERVALO_CHEQUEO):
        """Levanta lo guardado, escucha el documento compartido y se encarga
        de refrescarlo cuando le toque.

        Se llama una vez al abrir el POS. Es idempotente: llamarlo de nuevo no
        levanta un segundo hilo.
        """
        if db_manager is not None:
            self._db = db_manager
            self._cargar_de_local()
        self._escuchar_la_nube()
        with self._lock:
            if self._hilo is not None and self._hilo.is_alive():
                return
            self._parar.clear()
            self._hilo = threading.Thread(
                target=self._bucle, args=(intervalo,),
                name='cotizacion-usd', daemon=True,
            )
            self._hilo.start()

    def detener(self):
        self._parar.set()
        with self._lock:
            listener = self._listener
            self._listener = None
        if listener is not None:
            try:
                listener.unsubscribe()
            except Exception:
                pass

    def _bucle(self, intervalo):
        """Cada tanto, mira si le toca salir a buscar el valor.

        Casi siempre no le toca: otra PC ya lo hizo y el listener trajo el
        valor. Cuando le toca, `_refrescar_si_hace_falta` se encarga del
        desfasaje para no salir todas juntas.
        """
        primera = True
        while not self._parar.is_set():
            try:
                self._refrescar_si_hace_falta(primera=primera)
            except Exception as e:                    # nunca matar el hilo
                logger.debug(f"cotizacion: refresco de fondo fallo: {e}")
            primera = False
            self._parar.wait(max(30, intervalo))

    # ── El documento compartido ───────────────────────────────────────────

    def _escuchar_la_nube(self):
        """Listener sobre `config/cotizacion_usd`.

        Es lo que hace que el valor que consigue una PC llegue a las otras
        cuatro al instante y sin que ninguna consulte nada.
        """
        with self._lock:
            if self._listener is not None:
                return
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if not fb or not getattr(fb, 'enabled', False) or fb.db is None:
                return
            ref = fb.db.collection(COLECCION).document(DOCUMENTO)

            def _cambio(docs, cambios, hora):
                try:
                    for snap in docs:
                        datos = self._leer_documento(snap.to_dict() if snap.exists else None)
                        if datos:
                            self._tomar_de_la_nube(datos)
                except Exception as e:
                    logger.debug(f"cotizacion: listener fallo: {e}")

            with self._lock:
                self._listener = ref.on_snapshot(_cambio)
            logger.info("cotizacion: escuchando config/cotizacion_usd")
        except Exception as e:
            logger.debug(f"cotizacion: no se pudo escuchar la nube: {e}")

    @staticmethod
    def _leer_documento(d):
        """El documento compartido como lo entiende el POS. None si no sirve."""
        if not isinstance(d, dict):
            return None
        valor = d.get('valor')
        if not cotizacion_valida(valor):
            return None
        try:
            minutos = float(d.get('refresco_minutos') or REFRESCO_MINUTOS)
        except (TypeError, ValueError):
            minutos = REFRESCO_MINUTOS
        return {
            'valor': float(valor),
            'tipo': str(d.get('tipo') or TIPO_DEFAULT).strip().lower(),
            'manual': d.get('manual') is True,
            'fuente': str(d.get('fuente') or '').strip(),
            'ts': _ts_de_iso(d.get('actualizado')),
            'refresco_minutos': min(max(minutos, 1), 24 * 60),
        }

    def _tomar_de_la_nube(self, datos):
        """Se queda con lo que trajo otra PC, si es mas nuevo que lo propio."""
        with self._lock:
            propio_ts = self._ts
        ts = datos['ts'] or _ahora()
        if not datos['manual'] and ts <= propio_ts:
            return                       # lo que tengo es igual o mas nuevo
        fuente = 'a mano' if datos['manual'] else (
            'otra PC' if datos.get('fuente') == 'dolarapi' else (datos.get('fuente') or 'nube'))
        self._guardar(datos['valor'], fuente, datos['tipo'],
                      manual=datos['manual'], ts=ts,
                      refresco_minutos=datos['refresco_minutos'])

    def _leer_de_la_nube(self):
        """Una lectura suelta del documento, para cuando no hay listener."""
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if not fb or not getattr(fb, 'enabled', False) or fb.db is None:
                return None
            snap = fb.db.collection(COLECCION).document(DOCUMENTO).get()
            if not snap.exists:
                return None
            return self._leer_documento(snap.to_dict())
        except Exception as e:
            logger.debug(f"cotizacion: no se pudo leer de la nube: {e}")
            return None

    def _subir_a_la_nube(self, valor, tipo):
        """Deja el valor para las demas PCs y para el panel."""
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if not fb or not getattr(fb, 'enabled', False) or fb.db is None:
                return False
            fb.db.collection(COLECCION).document(DOCUMENTO).set({
                'valor': float(valor),
                'tipo': tipo,
                'fuente': 'dolarapi',
                'manual': False,
                'actualizado': _iso(_ahora()),
            }, merge=True)
            return True
        except Exception as e:
            logger.debug(f"cotizacion: no se pudo subir a la nube: {e}")
            return False

    # ── Conseguir el valor ────────────────────────────────────────────────

    def _vencida_para_la_api(self):
        """True si nadie refresco el valor dentro de la ventana acordada."""
        with self._lock:
            if self._manual:
                return False             # a mano no se refresca solo
            if not cotizacion_valida(self._valor) or not self._ts:
                return True
            return (_ahora() - self._ts) > self._refresco_minutos * 60

    def _refrescar_si_hace_falta(self, primera=False):
        """Sale a la API solo si al valor compartido se le paso la hora.

        El desfasaje al azar y la segunda mirada al documento son lo que evita
        que cinco cajas prendidas juntas consulten las cinco.
        """
        if not self._vencida_para_la_api():
            return False

        # Al arrancar el POS, el listener puede no haber traido nada todavia:
        # se lee el documento de una antes de decidir salir.
        if primera:
            datos = self._leer_de_la_nube()
            if datos:
                self._tomar_de_la_nube(datos)
                if not self._vencida_para_la_api():
                    return False

        espera = random.uniform(0, VENTANA_DESFASAJE)
        if self._parar.wait(espera):
            return False

        # Segunda mirada: en esos segundos otra caja pudo haberlo hecho.
        datos = self._leer_de_la_nube()
        if datos:
            self._tomar_de_la_nube(datos)
            if not self._vencida_para_la_api():
                logger.debug("cotizacion: ya la refresco otra PC, no consulto")
                return False

        return self.refrescar()

    def refrescar(self, timeout=TIMEOUT_HTTP):
        """Busca el valor en la API y lo deja para todas. True si lo consiguio.

        En modo a mano no consulta: el valor lo decide el dueño.
        """
        if self._refrescando.is_set():
            return False                # ya hay uno en curso; no apilar
        self._refrescando.set()
        try:
            with self._lock:
                manual, tipo = self._manual, self._tipo
            if manual:
                datos = self._leer_de_la_nube()
                if datos:
                    self._tomar_de_la_nube(datos)
                    return True
                return False

            datos = self._pedir_a_la_api(tipo, timeout)
            if datos:
                self._guardar(datos['valor'], 'dolarapi', tipo, manual=False)
                self._subir_a_la_nube(datos['valor'], tipo)
                return True

            # Sin internet en esta PC: capaz otra si tiene.
            de_la_nube = self._leer_de_la_nube()
            if de_la_nube:
                self._tomar_de_la_nube(de_la_nube)
                return True
            return False
        finally:
            self._refrescando.clear()

    def refrescar_ahora(self, timeout=TIMEOUT_HTTP):
        """Para llamar desde la pantalla cuando hace falta el valor YA.

        Primero mira el documento compartido (una lectura, sin internet de por
        medio) y solo sale a la API si ahi tampoco hay nada al dia. Devuelve el
        valor que quedo: el nuevo, o el de antes si no se pudo conseguir otro.
        """
        try:
            datos = self._leer_de_la_nube()
            if datos:
                self._tomar_de_la_nube(datos)
            if self._vencida_para_la_api():
                self.refrescar(timeout=timeout)
        except Exception as e:
            logger.warning(f"cotizacion: no se pudo refrescar: {e}")
        return self.valor()

    def refrescar_en_segundo_plano(self, cuando_termine=None, timeout=TIMEOUT_HTTP):
        """Dispara un refresco sin frenar a nadie.

        `cuando_termine(valor)` se llama desde el hilo de fondo: el que lo use
        desde la interfaz tiene que volver al hilo de Qt por su cuenta (la
        pantalla de ventas lo hace con una señal).
        """
        def _correr():
            valor = self.refrescar_ahora(timeout=timeout)
            if cuando_termine:
                try:
                    cuando_termine(valor)
                except Exception as e:
                    logger.debug(f"cotizacion: aviso posterior fallo: {e}")

        threading.Thread(target=_correr, name='cotizacion-usd-ya',
                         daemon=True).start()

    def _pedir_a_la_api(self, tipo, timeout):
        """El dolar de internet. None si ninguna fuente contesta algo usable.

        Prueba las fuentes del tipo en orden y se queda con la primera que
        conteste un numero creible. La segunda existe para el dia que la
        primera deje de andar.
        """
        for url, camino in (FUENTES.get(tipo) or FUENTES[TIPO_DEFAULT]):
            valor = self._pedir_a(url, camino, timeout)
            if valor is not None:
                return {'valor': valor, 'tipo': tipo, 'url': url}
        return None

    @staticmethod
    def _pedir_a(url, camino, timeout):
        """Un numero de una API, o None. Nunca levanta una excepcion."""
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'SistemaPOS/1.0',
                'Accept': 'application/json',
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if getattr(resp, 'status', 200) != 200:
                    return None
                crudo = resp.read(20000)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            logger.debug(f"cotizacion: {url} no contesto: {e}")
            return None

        try:
            d = json.loads(crudo.decode('utf-8', errors='replace'))
        except (ValueError, UnicodeDecodeError) as e:
            logger.warning(f"cotizacion: respuesta ilegible de {url}: {e}")
            return None

        for paso in camino:
            if not isinstance(d, dict):
                return None
            d = d.get(paso)
        if not cotizacion_valida(d):
            logger.warning(f"cotizacion: {url} devolvio un valor raro: {d!r}")
            return None
        return float(d)

    def fijar_a_mano(self, valor, tipo=None):
        """Carga un valor a dedo y lo deja fijo hasta que se apague el modo.

        Lo usa la pantalla del POS cuando no hay internet y hay que vender
        igual. Devuelve True si el valor servia.
        """
        if not cotizacion_valida(valor):
            return False
        tipo = (tipo or 'manual').strip().lower()
        self._guardar(float(valor), 'a mano', tipo, manual=True)
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if fb and getattr(fb, 'enabled', False) and fb.db is not None:
                fb.db.collection(COLECCION).document(DOCUMENTO).set({
                    'valor': float(valor),
                    'tipo': tipo,
                    'fuente': 'a mano',
                    'manual': True,
                    'actualizado': _iso(_ahora()),
                }, merge=True)
        except Exception as e:
            logger.debug(f"cotizacion: no se pudo subir el valor a mano: {e}")
        return True

    # ── La copia local ────────────────────────────────────────────────────

    def _guardar(self, valor, fuente, tipo, manual=False, ts=None,
                 refresco_minutos=None):
        with self._lock:
            cambio = (float(valor) != self._valor)
            self._valor = float(valor)
            self._ts = float(ts) if ts else _ahora()
            self._fuente = fuente
            self._tipo = tipo or TIPO_DEFAULT
            self._manual = bool(manual)
            if refresco_minutos:
                self._refresco_minutos = refresco_minutos
        self._escribir_local()
        if cambio:
            self._avisar()

    def _escribir_local(self):
        if self._db is None:
            return
        try:
            with self._lock:
                filas = [
                    (_K_VALOR,  str(self._valor)),
                    (_K_TS,     str(self._ts)),
                    (_K_FUENTE, str(self._fuente)),
                    (_K_TIPO,   str(self._tipo)),
                    (_K_MANUAL, '1' if self._manual else '0'),
                ]
            for clave, valor in filas:
                self._db.execute_update(
                    "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
                    (clave, valor),
                )
        except Exception as e:
            logger.debug(f"cotizacion: no se pudo guardar en local: {e}")

    def _cargar_de_local(self):
        """El ultimo valor conocido, para poder vender apenas abre el POS."""
        if self._db is None:
            return
        try:
            filas = self._db.execute_query(
                "SELECT key, value FROM config WHERE key IN (?, ?, ?, ?, ?)",
                (_K_VALOR, _K_TS, _K_FUENTE, _K_TIPO, _K_MANUAL),
            ) or []
        except Exception as e:
            logger.debug(f"cotizacion: no se pudo leer de local: {e}")
            return

        datos = {f['key']: f['value'] for f in filas}
        try:
            valor = float(datos.get(_K_VALOR) or 0)
        except (TypeError, ValueError):
            valor = 0
        if not cotizacion_valida(valor):
            return
        try:
            ts = float(datos.get(_K_TS) or 0)
        except (TypeError, ValueError):
            ts = 0
        with self._lock:
            self._valor = valor
            self._ts = ts
            self._fuente = datos.get(_K_FUENTE) or 'local'
            self._tipo = datos.get(_K_TIPO) or TIPO_DEFAULT
            self._manual = str(datos.get(_K_MANUAL) or '0') == '1'


# ── El de siempre ─────────────────────────────────────────────────────────
_instancia = None
_instancia_lock = threading.Lock()


def get_cotizacion():
    """La cotizacion compartida por todo el POS."""
    global _instancia
    with _instancia_lock:
        if _instancia is None:
            _instancia = CotizacionUSD()
        return _instancia


def valor_actual():
    """Atajo: el dolar de ahora, 0 si no hay ninguno."""
    return get_cotizacion().valor()


def _resetear_para_pruebas():
    """Solo para las pruebas: vuelve a empezar de cero."""
    global _instancia
    with _instancia_lock:
        if _instancia is not None:
            _instancia.detener()
        _instancia = None
