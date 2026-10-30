"""
El carrito abierto de cada caja, a la vista de las demás (carritos vivos).

El cajero arranca una venta en la Compu 1, el cliente pide algo de mercería y
el cajero sigue en la Compu 3. Desde la 3 ve el carrito de la 1 y lo pide: la 1
se lo ENTREGA (nadie se lo saca) y queda vacía; la 3 sigue con todo lo cargado
y a nombre del cajero que la empezó. Puede ir y volver las veces que haga falta.

Cada caja publica su carrito en `carritos_vivos/{pc_id}`. Acá viven las reglas,
sin Firestore ni Qt, para que las pruebas las ejerciten igual con el emulador,
con el doble en memoria o solas:

  epoch            id de la venta en curso. Nace cuando el carrito pasa de vacío
                   a tener algo y VIAJA con la venta.
  solicitud        `carritos_vivos_solicitudes/{caja de origen}`: la escribe la
                   caja que quiere la venta; la contesta la de origen.
  entrega          transacción de la caja de origen: confirma que la venta sigue
                   en su carrito, la sube tal como está en ese momento al
                   documento de la caja que la pidió (`pendiente_de_cargar`), se
                   vacía con `entregada_epoch` y marca la solicitud entregada.

Solo la propia caja escribe su documento, salvo en la entrega, que escribe el
de la caja que la pidió (vacío, porque para pedir hay que tener el carrito
vacío). La venta siempre está en un solo documento.

El documento:
  pc_id, pc_nombre, epoch, items_json (el carrito tal cual, en texto: los tipos
  vuelven exactos), renglones, cantidad, total, cajero, cobrando, descuento,
  presupuesto, fiado, traida_de, entregada_epoch, entregada_a,
  pendiente_de_cargar, solicitud_id, actualizado (hora del servidor; se renueva
  cada KEEPALIVE_SEG mientras haya carrito).
"""
import copy
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, List, Optional, Tuple

COLECCION = 'carritos_vivos'
SOLICITUDES = 'carritos_vivos_solicitudes'

# Mientras el carrito tiene algo, la caja renueva su documento cada 45 s. Si
# pasan dos minutos sin noticias la caja está apagada o sin internet: su venta
# no se muestra ni se puede traer (podría estar cobrándose allá sin conexión).
KEEPALIVE_SEG = 45
VIGENCIA_SEG = 120

# La caja que pide espera la entrega ESPERA_ENTREGA_SEG; la de origen solo
# puede cumplir una solicitud hasta VALIDEZ_SOLICITUD_SEG después de hecha (hora
# del servidor). Una solicitud sin respuesta vence sola y no se cumple tarde.
ESPERA_ENTREGA_SEG = 5
VALIDEZ_SOLICITUD_SEG = 8


def nuevo_epoch() -> str:
    return uuid.uuid4().hex[:16]


# ── Nombre de la caja ────────────────────────────────────────────────────────
def nombre_de_caja(datos: Optional[Dict], pc_id: str = '') -> str:
    """Lo que se le muestra al cajero: el nombre que le puso el admin, o el
    nombre de Windows. Nunca el id con el código al azar."""
    d = datos or {}
    for clave in ('nombre_caja', 'pc_nombre'):
        v = str(d.get(clave) or '').strip()
        if v:
            return v
    host = str(d.get('hostname') or '').strip()
    if host:
        return host
    pc = str(pc_id or d.get('pc_id') or '').strip()
    # El id es "HOSTNAME-a1b2c3d4": la parte de antes del guion es el nombre de
    # Windows recortado. Mejor eso que el código.
    if '-' in pc:
        return pc.rsplit('-', 1)[0] or 'Otra caja'
    return pc or 'Otra caja'


# ── Carrito ⇄ texto ──────────────────────────────────────────────────────────
def _a_json(valor) -> str:
    return json.dumps(valor, ensure_ascii=False, default=str)


def serializar_items(items: List[Dict],
                     referencia: Callable[[int], Optional[Dict]] = None) -> str:
    """El carrito en texto, con la referencia global de cada producto.

    El `product_id` de un renglón es el id de la base local de ESA caja: en otra
    PC el mismo número puede ser otro producto. Por eso cada renglón lleva
    `_ref` = {firebase_id, barcode}, con los que la caja que lo trae encuentra
    su propio id. `referencia(product_id)` los lee de la base local.
    """
    salida = []
    for it in items or []:
        linea = copy.deepcopy(it)
        pid = linea.get('product_id')
        if referencia is not None and isinstance(pid, int) and pid > 0:
            ref = referencia(pid) or {}
            linea['_ref'] = {
                'firebase_id': str(ref.get('firebase_id') or ''),
                'barcode': str(ref.get('barcode') or ''),
            }
        salida.append(linea)
    return _a_json(salida)


def leer_items(items_json) -> List[Dict]:
    if not items_json:
        return []
    try:
        datos = json.loads(items_json)
    except (TypeError, ValueError):
        return []
    return [d for d in datos if isinstance(d, dict)] if isinstance(datos, list) else []


def adaptar_items(items: List[Dict], buscar_local: Callable[[Dict], Optional[int]],
                  convertir: bool = False) -> Tuple[List[Dict], List[str]]:
    """Pasa los renglones que llegaron de otra caja a los ids de esta base.

    `buscar_local(ref)` devuelve el id local para {firebase_id, barcode} o None.
    Lo que no está en esta base vuelve en la segunda lista (nombres): la venta
    no puede descontar stock de un producto que la caja no conoce. Con
    `convertir`, esos renglones pasan como Varios (`como_varios`); sin él
    conservan el id de la otra caja y solo sirven para mostrar.
    Los renglones sin producto de catálogo (Varios con id 0, productos madre con
    id None) pasan tal cual.
    """
    salida, faltan = [], []
    for it in items or []:
        linea = copy.deepcopy(it)
        ref = linea.pop('_ref', None)
        pid = linea.get('product_id')
        if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0:
            local = buscar_local(ref or {}) if ref else None
            if local is None:
                faltan.append(str(linea.get('product_name') or 'Producto'))
                if convertir:
                    linea = como_varios(linea)
            else:
                linea['product_id'] = int(local)
        salida.append(linea)
    return salida, faltan


def como_varios(linea: Dict) -> Dict:
    """Último recurso para un renglón cuyo producto esta caja no tiene: se cobra
    como Varios (sin tocar stock) en vez de descontarle a otro producto."""
    nueva = dict(linea)
    for clave in [k for k in nueva if k.startswith('conjunto_')]:
        nueva.pop(clave)
    nueva.update({'product_id': 0, 'is_varios': True, 'is_conjunto': False,
                  'category': 'Varios', 'max_stock': 9999})
    return nueva


def resumen(items: List[Dict], descuento_monto: float = 0.0) -> Dict:
    bruto = sum(float(it.get('subtotal') or 0) for it in items or [])
    return {
        'renglones': len(items or []),
        'cantidad': round(sum(float(it.get('quantity') or 0) for it in items or []), 4),
        'total': round(bruto - float(descuento_monto or 0), 2),
    }


def armar_estado(pc_id: str, pc_nombre: str, epoch: str, items_json: str,
                 items: List[Dict], cajero: str, descuento: Optional[Dict] = None,
                 descuento_monto: float = 0.0, presupuesto: Optional[Dict] = None,
                 fiado: Optional[Dict] = None, cobrando: bool = False,
                 traida_de: Optional[Dict] = None) -> Dict:
    """Lo que la caja publica de su carrito (sin `actualizado`, que lo pone la
    nube con su hora)."""
    return {
        'pc_id': pc_id,
        'pc_nombre': pc_nombre,
        'epoch': epoch,
        'items_json': items_json,
        **resumen(items, descuento_monto),
        'cajero': cajero or '',
        'cobrando': bool(cobrando),
        'descuento': descuento or None,
        'presupuesto': presupuesto or None,
        'fiado': fiado or None,
        'traida_de': traida_de or None,
        'entregada_epoch': '',
        'entregada_a': None,
        'pendiente_de_cargar': False,
        'solicitud_id': '',
    }


def estado_vacio(pc_id: str, pc_nombre: str) -> Dict:
    return {
        'pc_id': pc_id, 'pc_nombre': pc_nombre, 'epoch': '', 'items_json': '[]',
        'renglones': 0, 'cantidad': 0, 'total': 0.0, 'cajero': '',
        'cobrando': False, 'descuento': None, 'presupuesto': None, 'fiado': None,
        'traida_de': None,
    }


def tiene_venta(doc: Optional[Dict]) -> bool:
    return bool(doc) and bool(doc.get('epoch')) and int(doc.get('renglones') or 0) > 0


# ── Tiempo ───────────────────────────────────────────────────────────────────
def _como_fecha(v) -> Optional[datetime]:
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, str) and v:
        try:
            f = datetime.fromisoformat(v)
            return f if f.tzinfo else f.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def segundos_sin_noticias(doc: Optional[Dict], ahora: datetime) -> Optional[float]:
    f = _como_fecha((doc or {}).get('actualizado'))
    if f is None or ahora is None:
        return None
    return max(0.0, (ahora - f).total_seconds())


def vigente(doc: Optional[Dict], ahora: datetime) -> bool:
    s = segundos_sin_noticias(doc, ahora)
    return s is not None and s <= VIGENCIA_SEG


# ── Decisiones: publicar ─────────────────────────────────────────────────────
def decidir_publicacion(doc: Optional[Dict], epoch: Optional[str], estado: Optional[Dict],
                        forzar_vacio: bool = False) -> Dict:
    """Qué hace la caja con su propio documento.

    `epoch`   la venta que la caja cree tener (o la última que tuvo, si el
              carrito acaba de quedar vacío).
    `estado`  el carrito a publicar, o None si quedó vacío.

    Devuelve {'accion': 'escribir' | 'vaciar' | 'nada' | 'adoptar', ...}.
      'adoptar'  en el documento hay una venta que otra caja le entregó y esta
                 todavía no cargó: no se pisa; la caja la toma (al carrito o a
                 pendientes) y recién después publica lo suyo.
      'nada'     también cuando la venta que se quiere publicar ya se entregó:
                 una publicación que quedó en la fila no la revive.
    """
    doc = doc or {}
    if doc.get('pendiente_de_cargar') and tiene_venta(doc) and doc.get('epoch') != epoch:
        return {'accion': 'adoptar', 'doc': doc}
    if epoch and doc.get('entregada_epoch') == epoch and doc.get('epoch') != epoch:
        return {'accion': 'nada', 'motivo': 'entregada'}
    if estado is not None:
        return {'accion': 'escribir'}
    if not tiene_venta(doc) and not doc.get('cobrando'):
        return {'accion': 'nada'}
    # Solo se vacía la venta propia: un documento con otro epoch lo escribió
    # una entrega más nueva que este pedido de vaciar.
    if forzar_vacio or not doc.get('epoch') or doc.get('epoch') == epoch:
        return {'accion': 'vaciar'}
    return {'accion': 'nada'}


# ── Decisiones: pedir y entregar ─────────────────────────────────────────────
#
# Nadie le saca la venta a otra caja. La que la quiere deja una SOLICITUD
# (`carritos_vivos_solicitudes/{caja de origen}`); la de origen, que la escucha,
# entrega ella misma en una transacción con su carrito local más nuevo (lo
# último que escaneó incluido). Si la origen no contesta en VALIDEZ_SOLICITUD_SEG
# (sin internet, apagada) la solicitud vence y ya no se puede cumplir: la venta
# sigue allá. Así nunca está en dos cajas.

def solicitud_vencida(sol: Optional[Dict], ahora: Optional[datetime]) -> bool:
    f = _como_fecha((sol or {}).get('pedida_en'))
    if f is None or ahora is None:
        return True
    return (ahora - f).total_seconds() > VALIDEZ_SOLICITUD_SEG


def solicitud_activa(sol: Optional[Dict], ahora: Optional[datetime]) -> bool:
    return bool(sol) and sol.get('estado') == 'pedida' and not solicitud_vencida(sol, ahora)


def decidir_pedido(origen: Optional[Dict], sol: Optional[Dict], epoch_visto: str,
                   destino_pc: str, ahora: Optional[datetime]) -> Dict:
    """¿Se puede pedir la venta de otra caja? Lo decide la transacción de la
    caja que la quiere, con el documento de origen recién leído."""
    if not origen or not tiene_venta(origen):
        return {'rechazo': 'Esa venta ya no está abierta: la cobraron, la vaciaron o pasó a otra caja.',
                'motivo': 'no_esta'}
    if str(origen.get('pc_id') or '') == destino_pc:
        return {'rechazo': 'Esa venta ya está en esta caja.', 'motivo': 'propia'}
    if epoch_visto and origen.get('epoch') != epoch_visto:
        return {'rechazo': 'Esa venta cambió de caja mientras la mirabas. Fijate en la lista de nuevo.',
                'motivo': 'cambio'}
    nombre = nombre_de_caja(origen)
    if origen.get('cobrando'):
        return {'rechazo': f'La están cobrando en la {nombre}.', 'motivo': 'cobrando'}
    if ahora is not None and not vigente(origen, ahora):
        return {'rechazo': f'La {nombre} no da señales hace rato (apagada o sin internet). '
                           f'Terminá la venta allá.', 'motivo': 'sin_senal'}
    if solicitud_activa(sol, ahora) and (sol.get('de') or {}).get('pc_id') != destino_pc:
        otra = (sol.get('de') or {}).get('pc_nombre') or 'otra caja'
        return {'rechazo': f'La {otra} la está pidiendo en este momento.', 'motivo': 'pedida_por_otra'}
    return {'ok': True}


def solicitud_nueva(sol_id: str, epoch: str, quien: Dict) -> Dict:
    """La solicitud (sin `pedida_en`, que lo pone la nube con su hora)."""
    return {
        'id': sol_id, 'epoch': epoch, 'estado': 'pedida', 'motivo': '',
        'de': {'pc_id': quien.get('pc_id') or '', 'pc_nombre': quien.get('pc_nombre') or '',
               'cajero': quien.get('cajero') or ''},
        'entrega': None,
    }


def decidir_entrega(sol: Optional[Dict], sol_id: str, epoch: Optional[str],
                    doc_destino: Optional[Dict], ahora: Optional[datetime]) -> Dict:
    """La caja de origen, dentro de su transacción: ¿entrega?

    `epoch` es la venta que tiene en el carrito en este momento.
    """
    if not sol or sol.get('id') != sol_id:
        return {'rechazo': 'La solicitud ya no está.', 'motivo': 'otra_solicitud'}
    if sol.get('estado') != 'pedida':
        return {'rechazo': 'La solicitud ya se cerró.', 'motivo': sol.get('estado') or 'cerrada'}
    if solicitud_vencida(sol, ahora):
        return {'rechazo': 'La solicitud venció.', 'motivo': 'vencida'}
    if not epoch or sol.get('epoch') != epoch:
        return {'rechazo': 'Esa venta ya no está abierta en esta caja.', 'motivo': 'no_esta'}
    if tiene_venta(doc_destino):
        return {'rechazo': 'La otra caja ya tiene una venta abierta.', 'motivo': 'destino_ocupado'}
    return {'ok': True}


def doc_entregado(estado: Dict, sol: Dict) -> Dict:
    """El documento de la caja que pidió: la venta tal cual la tenía la origen
    al entregarla, con el mismo epoch y el mismo cajero, marcada para que esa
    caja la cargue (aunque haya dejado de esperar)."""
    de = sol.get('de') or {}
    nuevo = {k: estado.get(k) for k in (
        'epoch', 'items_json', 'renglones', 'cantidad', 'total', 'cajero',
        'descuento', 'presupuesto', 'fiado')}
    nuevo.update({
        'pc_id': de.get('pc_id') or '', 'pc_nombre': de.get('pc_nombre') or '',
        'cobrando': False,
        'traida_de': {'pc_id': estado.get('pc_id') or '', 'pc_nombre': nombre_de_caja(estado)},
        'entregada_epoch': '', 'entregada_a': None,
        'pendiente_de_cargar': True, 'solicitud_id': sol.get('id') or '',
    })
    return nuevo


def doc_origen_entregado(estado: Dict, sol: Dict) -> Dict:
    """Lo que queda en la caja que entregó: vacía, con la marca de a quién."""
    de = sol.get('de') or {}
    return {
        **estado_vacio(estado.get('pc_id') or '', estado.get('pc_nombre') or ''),
        'entregada_epoch': estado.get('epoch') or '',
        'entregada_a': {'pc_id': de.get('pc_id') or '', 'pc_nombre': de.get('pc_nombre') or '',
                        'cajero': de.get('cajero') or ''},
    }


def decidir_cancelacion(sol: Optional[Dict], sol_id: str) -> Dict:
    """La caja que pidió se cansó de esperar. Si la solicitud sigue pedida, la
    cancela (la origen ya no la puede cumplir); si justo la entregaron, la
    venta llegó y se carga igual."""
    if not sol or sol.get('id') != sol_id:
        return {'accion': 'nada'}
    if sol.get('estado') == 'entregada':
        return {'accion': 'llego'}
    if sol.get('estado') == 'pedida':
        return {'accion': 'cancelar'}
    return {'accion': 'nada', 'estado': sol.get('estado')}


# ── Lista para la pantalla ───────────────────────────────────────────────────
def carritos_de_otras_cajas(docs: Dict[str, Dict], mi_pc: str,
                            ahora: Optional[datetime]) -> List[Dict]:
    """Las ventas abiertas en las otras cajas que se pueden mostrar: con algo
    cargado y con noticias de los últimos VIGENCIA_SEG. Ordenadas por nombre."""
    salida = []
    for pc_id, doc in (docs or {}).items():
        if pc_id == mi_pc or not tiene_venta(doc):
            continue
        if ahora is not None and not vigente(doc, ahora):
            continue
        salida.append({**doc, 'pc_id': pc_id, 'nombre': nombre_de_caja(doc, pc_id)})
    return sorted(salida, key=lambda d: (_clave_nombre(d['nombre']), d['pc_id']))


def _clave_nombre(nombre: str):
    """"Compu 2" antes que "Compu 10"."""
    partes = nombre.rsplit(' ', 1)
    if len(partes) == 2 and partes[1].isdigit():
        return (partes[0].lower(), int(partes[1]))
    return (nombre.lower(), 0)


def ahora_utc() -> datetime:
    return datetime.now(timezone.utc)


def mas(fecha: datetime, segundos: float) -> datetime:
    return fecha + timedelta(seconds=segundos)
