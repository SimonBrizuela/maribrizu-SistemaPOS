"""
Registro de movimientos de stock.

Cada vez que una unidad entra o sale queda una fila acá: qué producto, cuánto,
de cuánto a cuánto quedó, por qué, quién y desde qué PC. Hasta ahora el sistema
guardaba únicamente el número actual, así que cuando un stock no cerraba contra
la góndola no había forma de saber si faltó registrar una venta, si alguien lo
tipeó mal o si el descuento nunca llegó a la nube.

Cómo se escribe
    La fila se inserta en la MISMA transacción que mueve el stock, usando el
    cursor de quien lo mueve. Si la venta se cae, el movimiento tampoco queda:
    nunca hay un registro de algo que no pasó.

Cómo sube
    Nace con `fb_synced = 0`. El push la manda a Firestore y la marca en 1. Si
    la PC está sin internet la fila espera y el reintento periódico la sube
    después, así que quedarse sin conexión no pierde historial. El doc en
    Firestore es `{pc_id}_{id_local}`, con set(): re-subir es inofensivo.

Signo de `cantidad`
    Negativo = salió mercadería (venta, consumo por vinculación).
    Positivo  = entró (reposición, anulación de venta, devolución de fiado).
"""
import logging
from typing import List, Optional

logger = logging.getLogger(__name__)

# Motivo → etiqueta para mostrar. La clave es lo que se guarda.
MOTIVOS = {
    'venta':          'Venta',
    'anulacion':      'Venta anulada',
    'fiado':          'Cargado a fiado',
    'fiado_quitado':  'Quitado de un fiado',
    'vinculacion':    'Consumido por otro producto',
    'edicion_manual': 'Editado a mano',
    'reposicion':     'Reposición',
    'conteo':         'Ajuste por conteo',
    'importacion':    'Importación',
    'variante':       'Variante / conjunto',
}

_DDL = """
CREATE TABLE IF NOT EXISTS stock_movimientos (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              TEXT    NOT NULL,
    origen          TEXT    NOT NULL DEFAULT 'pos',
    pc_id           TEXT,
    usuario         TEXT,
    producto_id     INTEGER,
    firebase_id     TEXT,
    producto_nombre TEXT,
    motivo          TEXT    NOT NULL,
    cantidad        REAL    NOT NULL,
    stock_antes     REAL,
    stock_despues   REAL,
    referencia      TEXT,
    detalle         TEXT,
    fb_synced       INTEGER NOT NULL DEFAULT 0
)
"""

_INDICES = (
    "CREATE INDEX IF NOT EXISTS idx_stkmov_pendientes "
    "ON stock_movimientos(fb_synced, id)",
    "CREATE INDEX IF NOT EXISTS idx_stkmov_producto "
    "ON stock_movimientos(firebase_id, ts)",
)


def asegurar_tabla(cursor) -> None:
    """Crea la tabla y sus índices si no existen. Idempotente."""
    cursor.execute(_DDL)
    for idx in _INDICES:
        cursor.execute(idx)


def _num(valor) -> Optional[float]:
    if valor is None:
        return None
    try:
        return round(float(valor), 4)
    except (TypeError, ValueError):
        return None


def registrar(cursor, *, motivo: str, cantidad, firebase_id: str = '',
              producto_id=None, producto_nombre: str = '',
              stock_antes=None, stock_despues=None,
              referencia: str = '', detalle: str = '',
              usuario: str = '', origen: str = 'pos') -> None:
    """Anota un movimiento en la misma transacción que lo produjo.

    Nunca levanta: un fallo escribiendo el historial no puede voltear una venta
    que ya está cobrada. Si algo sale mal queda en el log y la venta sigue.
    """
    delta = _num(cantidad)
    if not delta:
        return
    try:
        from pos_system.utils.firebase_sync import _get_pc_id, now_ar
        asegurar_tabla(cursor)
        cursor.execute(
            """INSERT INTO stock_movimientos
               (ts, origen, pc_id, usuario, producto_id, firebase_id,
                producto_nombre, motivo, cantidad, stock_antes, stock_despues,
                referencia, detalle, fb_synced)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
            (now_ar().isoformat(), origen, _get_pc_id(), usuario or '',
             producto_id, str(firebase_id or ''), producto_nombre or '',
             motivo, delta, _num(stock_antes), _num(stock_despues),
             str(referencia or ''), str(detalle or ''))
        )
    except Exception as e:
        logger.warning(f"stock_ledger: no se pudo registrar el movimiento: {e}")


def registrar_suelto(db_manager, **kwargs) -> None:
    """Igual que `registrar` pero abriendo su propia conexión.

    Para los movimientos que no nacen dentro de otra transacción: una edición
    de stock a mano, un ajuste por conteo.
    """
    try:
        with db_manager.get_connection() as conn:
            registrar(conn.cursor(), **kwargs)
    except Exception as e:
        logger.warning(f"stock_ledger: movimiento suelto no registrado: {e}")


def snapshot(cursor, producto_id) -> dict:
    """Cómo está un producto justo antes de tocarlo, leído en la transacción
    en curso.

    Sin el `antes` el historial dice que algo se movió pero no desde dónde, que
    es la mitad inútil del dato. Devuelve dict vacío si el producto no está.
    """
    try:
        row = cursor.execute(
            "SELECT stock, firebase_id, name, conjunto_total, "
            "       COALESCE(stock_ilimitado, 0) "
            "FROM products WHERE id = ?", (producto_id,)
        ).fetchone()
    except Exception:
        # Base todavía sin la columna de servicio (PC recién actualizada).
        try:
            row = cursor.execute(
                "SELECT stock, firebase_id, name, conjunto_total, 0 "
                "FROM products WHERE id = ?", (producto_id,)
            ).fetchone()
        except Exception:
            return {}
    if not row:
        return {}
    try:
        return {
            'stock':          _num(row[0]),
            'firebase_id':    str(row[1] or ''),
            'nombre':         str(row[2] or ''),
            'conjunto_total': _num(row[3]),
            'ilimitado':      bool(row[4]),
        }
    except (TypeError, ValueError, IndexError):
        return {}


def pendientes(db_manager, limite: int = 400) -> List[dict]:
    """Movimientos que todavía no subieron a Firestore, del más viejo al más nuevo."""
    try:
        return db_manager.execute_query(
            "SELECT * FROM stock_movimientos "
            "WHERE COALESCE(fb_synced, 0) = 0 ORDER BY id ASC LIMIT ?",
            (int(limite),)
        ) or []
    except Exception as e:
        logger.debug(f"stock_ledger: no se pudieron leer los pendientes: {e}")
        return []


def marcar_subidos(db_manager, ids: List[int]) -> None:
    if not ids:
        return
    try:
        marcas = ','.join('?' * len(ids))
        db_manager.execute_update(
            f"UPDATE stock_movimientos SET fb_synced = 1 WHERE id IN ({marcas})",
            tuple(int(i) for i in ids)
        )
    except Exception as e:
        logger.warning(f"stock_ledger: no se pudieron marcar como subidos: {e}")


def limpiar_viejos(db_manager, meses: int = 12) -> int:
    """Borra lo anterior a `meses`. El historial es para revisar un desvío
    reciente; guardar años de movimientos solo engorda la base de la PC."""
    try:
        from datetime import timedelta
        from pos_system.utils.firebase_sync import now_ar
        corte = (now_ar() - timedelta(days=30 * int(meses))).isoformat()
        return db_manager.execute_update(
            "DELETE FROM stock_movimientos WHERE fb_synced = 1 AND ts < ?",
            (corte,)
        )
    except Exception as e:
        logger.debug(f"stock_ledger: limpieza omitida: {e}")
        return 0
