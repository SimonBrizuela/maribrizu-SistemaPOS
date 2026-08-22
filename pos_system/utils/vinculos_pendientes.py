"""
Cola local de descuentos por vinculación que todavía no llegaron a Firestore.

Cuando se vende una impresión, el POS descuenta el papel en SQLite adentro de
la misma transacción que la venta. Hasta ahora el descuento en la nube salía en
un hilo aparte y, si Firebase no estaba en ese momento, se perdía: la venta se
subía después por la cola offline, pero el papel quedaba sin descontar para
siempre y el próximo catálogo pisaba el número de la PC. Entre el 10 y el 12 de
agosto de 2026 así se fueron 1.264 hojas.

Acá cada descuento queda anotado en la MISMA transacción que lo produjo, con
`fb_synced = 0`. La subida lee la cola, aplica cada venta en una transacción de
Firestore (todo o nada) y recién entonces marca las filas en 1: si se corta en
el medio, se reintenta entero y no se duplica nada.

`planear` es la parte sin red: decide qué escribir a partir de lo que hay en la
nube. Está separada para poder probarla sin Firestore.
"""
import logging
from collections import OrderedDict
from typing import Dict, List, Optional, Tuple

from pos_system.models.conjunto import descontar_de_total

logger = logging.getLogger(__name__)

# Después de tantos fallos seguidos una fila deja de reintentarse: algo está
# roto de verdad (un target borrado, un dato imposible) y no vale la pena
# frenar a las que vienen atrás. Queda en la tabla con fb_synced = -1.
MAX_INTENTOS = 30

_DDL = """
CREATE TABLE IF NOT EXISTS vinc_pendientes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              TEXT    NOT NULL,
    sale_id         INTEGER,
    item_idx        INTEGER,
    target_fid      TEXT,
    target_local_id INTEGER,
    is_conjunto     INTEGER NOT NULL DEFAULT 0,
    delta           REAL    NOT NULL DEFAULT 0,
    solo_marcar     INTEGER NOT NULL DEFAULT 0,
    contexto        TEXT,
    intentos        INTEGER NOT NULL DEFAULT 0,
    fb_synced       INTEGER NOT NULL DEFAULT 0
)
"""

_INDICE = (
    "CREATE INDEX IF NOT EXISTS idx_vincpend_pendientes "
    "ON vinc_pendientes(fb_synced, id)"
)


def asegurar_tabla(cursor) -> None:
    """Crea la tabla y su índice si no existen. Idempotente."""
    cursor.execute(_DDL)
    cursor.execute(_INDICE)


def _num(v, por_defecto=0.0) -> float:
    try:
        return float(v if v not in (None, '') else por_defecto)
    except (TypeError, ValueError):
        return por_defecto


def encolar(cursor, sale_id: Optional[int], entradas: List[Dict]) -> int:
    """
    Anota los descuentos de una venta (o de un movimiento sin venta, con
    `sale_id=None`) en la transacción en curso. `entradas` son los dicts que
    arma `Sale._aplicar_vinculaciones_local`: target_fid, target_local_id,
    is_conjunto, delta, contexto, y `solo_marcar` para las líneas que ya habían
    descontado antes (un fiado que se cobra).

    Nunca levanta: la venta ya está cobrada y un fallo acá no puede voltearla.
    Devuelve cuántas filas quedaron anotadas.
    """
    if not entradas:
        return 0
    try:
        from pos_system.utils.firebase_sync import now_ar
        asegurar_tabla(cursor)
        ts = now_ar().isoformat()
        n = 0
        for e in entradas:
            if not isinstance(e, dict):
                continue
            solo_marcar = 1 if e.get('solo_marcar') else 0
            target_fid = str(e.get('target_fid') or '').strip()
            if not solo_marcar and not target_fid:
                continue
            cursor.execute(
                """INSERT INTO vinc_pendientes
                   (ts, sale_id, item_idx, target_fid, target_local_id,
                    is_conjunto, delta, solo_marcar, contexto, intentos, fb_synced)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)""",
                (ts, sale_id, e.get('item_idx'), target_fid or None,
                 e.get('target_local_id'), 1 if e.get('is_conjunto') else 0,
                 _num(e.get('delta')), solo_marcar, str(e.get('contexto') or ''))
            )
            n += 1
        return n
    except Exception as e:
        logger.warning(f"vinculos_pendientes: no se pudo encolar: {e}")
        return 0


def pendientes(db_manager, limite: int = 500) -> List[dict]:
    """Filas que todavía no subieron, de la más vieja a la más nueva."""
    try:
        return db_manager.execute_query(
            "SELECT * FROM vinc_pendientes "
            "WHERE COALESCE(fb_synced, 0) = 0 AND COALESCE(intentos, 0) < ? "
            "ORDER BY id ASC LIMIT ?",
            (MAX_INTENTOS, int(limite))
        ) or []
    except Exception as e:
        logger.debug(f"vinculos_pendientes: no se pudieron leer: {e}")
        return []


def agrupar(filas: List[dict]) -> List[Tuple[Optional[int], List[dict]]]:
    """
    Agrupa las filas por venta, en el orden en que se anotaron. Cada grupo se
    sube en una sola transacción de Firestore. Las filas sin venta (fiado con
    saldo a favor) van cada una por su lado.
    """
    grupos: "OrderedDict[object, List[dict]]" = OrderedDict()
    for f in filas:
        sid = f.get('sale_id')
        clave = ('venta', int(sid)) if sid is not None else ('suelta', int(f.get('id') or 0))
        grupos.setdefault(clave, []).append(dict(f))
    return [(clave[1] if clave[0] == 'venta' else None, fs) for clave, fs in grupos.items()]


def marcar_subidos(db_manager, ids: List[int]) -> None:
    if not ids:
        return
    try:
        marcas = ','.join('?' * len(ids))
        db_manager.execute_update(
            f"UPDATE vinc_pendientes SET fb_synced = 1 WHERE id IN ({marcas})",
            tuple(int(i) for i in ids)
        )
    except Exception as e:
        logger.warning(f"vinculos_pendientes: no se pudieron marcar como subidas: {e}")


def marcar_fallo(db_manager, ids: List[int]) -> None:
    """Un intento más que no salió. Al llegar a MAX_INTENTOS la fila se aparta."""
    if not ids:
        return
    try:
        marcas = ','.join('?' * len(ids))
        params = tuple(int(i) for i in ids)
        db_manager.execute_update(
            f"UPDATE vinc_pendientes SET intentos = COALESCE(intentos, 0) + 1 "
            f"WHERE id IN ({marcas})", params
        )
        db_manager.execute_update(
            f"UPDATE vinc_pendientes SET fb_synced = -1 "
            f"WHERE id IN ({marcas}) AND intentos >= ?", params + (MAX_INTENTOS,)
        )
    except Exception as e:
        logger.debug(f"vinculos_pendientes: no se pudo anotar el fallo: {e}")


def limpiar_viejas(db_manager, dias: int = 60) -> int:
    """Borra lo subido hace más de `dias`. La cola es de paso, no historial."""
    try:
        from datetime import timedelta
        from pos_system.utils.firebase_sync import now_ar
        corte = (now_ar() - timedelta(days=int(dias))).isoformat()
        return db_manager.execute_update(
            "DELETE FROM vinc_pendientes WHERE fb_synced = 1 AND ts < ?", (corte,)
        )
    except Exception as e:
        logger.debug(f"vinculos_pendientes: limpieza omitida: {e}")
        return 0


def sin_los_ya_marcados(grupo: List[dict], marcados) -> List[dict]:
    """
    Saca del grupo las filas de los items que ya tienen `consumibles_procesado`
    en la nube. Ese item lo descontó otra mano (el reconciliador de GitHub o el
    watcher del panel) mientras esta PC esperaba para reintentar: volver a
    restarlo sería contar el papel dos veces. `marcados` son los `item_idx`.
    """
    marcados = set(marcados or ())
    return [f for f in grupo if f.get('item_idx') not in marcados]


def planear(grupo: List[dict], estado_nube: Dict[str, Optional[dict]]) -> dict:
    """
    Qué escribir en Firestore para un grupo de filas, a partir de lo que hay en
    la nube. Sin red: la transacción lee los targets, llama acá y escribe.

    `estado_nube[target_fid]` es el doc del catálogo (o None si no existe).
    Devuelve:
      conjuntos: fid -> {total, unidades, restante, stock, delta}
      planos:    fid -> delta a restar (Increment)
      items:     item_idx -> lista de descuentos para marcar en ventas_por_dia
      saltados:  [(fid, motivo)] lo que no se pudo aplicar

    Un conjunto se descuenta del total que tiene LA NUBE y se vuelve a repartir
    en cerrados + sueltos: la PC no manda su número absoluto, que podía estar
    atrasado y pisar lo que vendieron las otras.
    """
    delta_por_target: "OrderedDict[str, float]" = OrderedDict()
    items: Dict[int, List[dict]] = {}
    saltados: List[Tuple[str, str]] = []

    for f in grupo:
        idx = f.get('item_idx')
        if f.get('solo_marcar'):
            items.setdefault(idx, [])
            continue
        fid = str(f.get('target_fid') or '').strip()
        delta = _num(f.get('delta'))
        if not fid or delta == 0:
            continue
        items.setdefault(idx, []).append({
            'contexto':  f.get('contexto') or '',
            'target_id': fid,
            'cantidad':  delta,
        })
        delta_por_target[fid] = delta_por_target.get(fid, 0.0) + delta

    conjuntos: Dict[str, dict] = {}
    planos: Dict[str, float] = {}
    for fid, delta in delta_por_target.items():
        data = estado_nube.get(fid)
        if data is None:
            saltados.append((fid, 'no existe en la nube'))
            continue
        if data.get('stock_ilimitado') in (True, 1):
            saltados.append((fid, 'servicio'))
            continue
        if data.get('es_conjunto') in (True, 1):
            colores = data.get('conjunto_colores')
            if isinstance(colores, list) and colores:
                saltados.append((fid, 'tiene variedades'))
                continue
            total, u, r = descontar_de_total(
                data.get('conjunto_total'), delta, data.get('conjunto_contenido'))
            conjuntos[fid] = {
                'total': total, 'unidades': u, 'restante': r,
                'stock': max(0, int(total)), 'delta': delta,
            }
        else:
            planos[fid] = delta

    return {'conjuntos': conjuntos, 'planos': planos, 'items': items, 'saltados': saltados}
