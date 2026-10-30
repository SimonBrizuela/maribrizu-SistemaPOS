"""
Cola local de ventas de conjuntos que todavía no se aplicaron en Firestore.

Hasta el 29-10-2026 la venta de un conjunto subía a la nube el número absoluto
que había quedado en la PC (`conjunto_unidades/restante/total` y la fila del
color vendido). Si la PC no había recibido una carga del panel o una venta de
otra caja, la pisaba. Y el `stock` plano de la nube no se tocaba, así que 730
conjuntos llegaron a tener dos números distintos.

Ahora cada línea de conjunto anota en esta tabla, en la MISMA transacción que
la venta, lo que se llevó (packs y sueltos, o lo que se devolvió). La subida
lee el documento del catálogo dentro de una transacción de Firestore, le aplica
esa diferencia con `venta_conjunto.aplicar_en_doc` y escribe todo junto
(variedad, agregados, total y stock). Igual que los vínculos de papel
(`vinculos_pendientes`).

Idempotencia: cada fila lleva una `clave` única. La transacción crea
`conjuntos_aplicados/{pc_id}_{clave}` al aplicar y, si ya existe, no vuelve a
descontar. Así un corte entre el commit de la nube y la marca local no
descuenta dos veces.
"""
import logging
import uuid
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# Como en vinculos_pendientes: tras tantos fallos la fila se aparta (-1) para
# no frenar a las que vienen atrás.
MAX_INTENTOS = 30

COLECCION_MARCAS = 'conjuntos_aplicados'

_DDL = """
CREATE TABLE IF NOT EXISTS conj_pendientes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    clave            TEXT    NOT NULL,
    ts               TEXT    NOT NULL,
    sale_id          INTEGER,
    item_idx         INTEGER,
    product_fid      TEXT,
    product_local_id INTEGER,
    color            TEXT,
    packs            REAL    NOT NULL DEFAULT 0,
    sueltos          REAL    NOT NULL DEFAULT 0,
    devolucion       REAL    NOT NULL DEFAULT 0,
    faltante_local   REAL    NOT NULL DEFAULT 0,
    motivo           TEXT,
    contexto         TEXT,
    intentos         INTEGER NOT NULL DEFAULT 0,
    fb_synced        INTEGER NOT NULL DEFAULT 0
)
"""

_INDICE = (
    "CREATE INDEX IF NOT EXISTS idx_conjpend_pendientes "
    "ON conj_pendientes(fb_synced, id)"
)


def asegurar_tabla(cursor) -> None:
    cursor.execute(_DDL)
    cursor.execute(_INDICE)


def _num(v) -> float:
    try:
        return float(v if v not in (None, '') else 0)
    except (TypeError, ValueError):
        return 0.0


def encolar(cursor, entrada: Dict) -> bool:
    """
    Anota una línea en la transacción en curso. `entrada`: product_fid,
    product_local_id, color, packs, sueltos, devolucion, faltante_local,
    sale_id, item_idx, motivo, contexto.

    Nunca levanta: la venta ya está cobrada y esto no la puede voltear.
    """
    try:
        fid = str(entrada.get('product_fid') or '').strip()
        if not fid:
            return False
        packs = _num(entrada.get('packs'))
        sueltos = _num(entrada.get('sueltos'))
        devolucion = _num(entrada.get('devolucion'))
        if packs <= 0 and sueltos <= 0 and devolucion <= 0:
            return False
        from pos_system.utils.firebase_sync import now_ar
        asegurar_tabla(cursor)
        cursor.execute(
            """INSERT INTO conj_pendientes
               (clave, ts, sale_id, item_idx, product_fid, product_local_id,
                color, packs, sueltos, devolucion, faltante_local, motivo,
                contexto, intentos, fb_synced)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)""",
            (uuid.uuid4().hex, now_ar().isoformat(), entrada.get('sale_id'),
             entrada.get('item_idx'), fid, entrada.get('product_local_id'),
             str(entrada.get('color') or '').strip(), packs, sueltos, devolucion,
             _num(entrada.get('faltante_local')), str(entrada.get('motivo') or ''),
             str(entrada.get('contexto') or ''))
        )
        return True
    except Exception as e:
        logger.warning(f"conjuntos_pendientes: no se pudo encolar: {e}")
        return False


def pendientes(db_manager, limite: int = 300) -> List[dict]:
    try:
        return db_manager.execute_query(
            "SELECT * FROM conj_pendientes "
            "WHERE COALESCE(fb_synced, 0) = 0 AND COALESCE(intentos, 0) < ? "
            "ORDER BY id ASC LIMIT ?",
            (MAX_INTENTOS, int(limite))
        ) or []
    except Exception as e:
        # La tabla no existe hasta la primera venta de un conjunto.
        logger.debug(f"conjuntos_pendientes: no se pudieron leer: {e}")
        return []


def marcar_subida(db_manager, fila_id: int) -> None:
    try:
        db_manager.execute_update(
            "UPDATE conj_pendientes SET fb_synced = 1 WHERE id = ?", (int(fila_id),))
    except Exception as e:
        logger.warning(f"conjuntos_pendientes: no se pudo marcar como subida: {e}")


def marcar_fallo(db_manager, fila_id: int) -> None:
    try:
        db_manager.execute_update(
            "UPDATE conj_pendientes SET intentos = COALESCE(intentos, 0) + 1 WHERE id = ?",
            (int(fila_id),))
        db_manager.execute_update(
            "UPDATE conj_pendientes SET fb_synced = -1 WHERE id = ? AND intentos >= ?",
            (int(fila_id), MAX_INTENTOS))
    except Exception as e:
        logger.debug(f"conjuntos_pendientes: no se pudo anotar el fallo: {e}")


def id_de_marca(pc_id: str, fila: dict) -> str:
    return f"{pc_id}_{fila.get('clave')}"


def plan_de_fila(fila: dict, doc: Optional[dict]) -> dict:
    """
    Qué escribir en el catálogo para una fila de la cola, dado el documento de
    la nube (None si no existe). Sin red: la transacción lee, llama acá y
    escribe. Devuelve lo mismo que `aplicar_en_doc` o {'saltado': motivo}.
    """
    from pos_system.models.venta_conjunto import aplicar_en_doc
    if doc is None:
        return {'saltado': 'no existe en la nube'}
    if doc.get('es_conjunto') not in (True, 1):
        return {'saltado': 'en la nube ya no es conjunto'}
    plan = aplicar_en_doc(doc, fila.get('color') or '', _num(fila.get('packs')),
                          _num(fila.get('sueltos')), _num(fila.get('devolucion')))
    # Un servicio no lleva `stock`: igual que en la PC, se mueven los packs y
    # el total pero el número plano no se toca.
    if 'campos' in plan and doc.get('stock_ilimitado') in (True, 1):
        plan['campos'].pop('stock', None)
    return plan
