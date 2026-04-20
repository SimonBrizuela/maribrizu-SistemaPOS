import logging
from typing import List, Dict, Optional

from pos_system.database.db_manager import DatabaseManager

logger = logging.getLogger(__name__)


class Observation:
    """Modelo para observaciones/notas compartidas entre cajeros.

    context:
        - 'general': nota suelta desde la pestaña Observaciones
        - 'sale':    nota ligada a un item de venta (tipicamente item "Varios")
    """

    def __init__(self, db_manager: DatabaseManager):
        self.db = db_manager

    def create(self, text: str, context: str = 'general',
               sale_id: Optional[int] = None,
               sale_item_id: Optional[int] = None,
               created_by_id: Optional[int] = None,
               created_by_name: str = '',
               pc_id: str = '') -> int:
        text = (text or '').strip()
        if not text:
            raise ValueError("La observación no puede estar vacía")
        if context not in ('general', 'sale'):
            raise ValueError(f"Contexto inválido: {context}")

        with self.db.get_connection() as conn:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO observations
                    (text, context, sale_id, sale_item_id,
                     created_by_id, created_by_name, pc_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (text, context, sale_id, sale_item_id,
                  created_by_id, created_by_name, pc_id))
            return cur.lastrowid

    def set_firebase_id(self, obs_id: int, firebase_id: str) -> None:
        self.db.execute_update(
            "UPDATE observations SET firebase_id = ? WHERE id = ?",
            (firebase_id, obs_id)
        )

    def get_by_id(self, obs_id: int) -> Optional[Dict]:
        rows = self.db.execute_query(
            "SELECT * FROM observations WHERE id = ?", (obs_id,)
        )
        return rows[0] if rows else None

    def get_all(self, limit: int = 500, include_deleted: bool = False) -> List[Dict]:
        where = "" if include_deleted else "WHERE deleted = 0"
        return self.db.execute_query(
            f"SELECT * FROM observations {where} "
            f"ORDER BY created_at DESC, id DESC LIMIT ?",
            (int(limit),)
        )

    def delete(self, obs_id: int) -> bool:
        self.db.execute_update(
            "UPDATE observations SET deleted = 1 WHERE id = ?", (obs_id,)
        )
        return True

    def upsert_from_firebase(self, firebase_id: str, data: Dict) -> Optional[int]:
        """Inserta o actualiza una observación recibida desde Firebase.
        Retorna el id local, o None si se ignoró."""
        if not firebase_id:
            return None
        text = (data.get('text') or '').strip()
        if not text:
            return None
        context = str(data.get('context') or 'general')
        if context not in ('general', 'sale'):
            context = 'general'
        created_at = data.get('created_at') or None

        existing = self.db.execute_query(
            "SELECT id FROM observations WHERE firebase_id = ?", (firebase_id,)
        )
        if existing:
            obs_id = existing[0]['id']
            self.db.execute_update("""
                UPDATE observations
                   SET text = ?, context = ?, sale_id = ?, sale_item_id = ?,
                       created_by_id = ?, created_by_name = ?, pc_id = ?,
                       deleted = ?
                 WHERE id = ?
            """, (
                text, context,
                data.get('sale_id'), data.get('sale_item_id'),
                data.get('created_by_id'),
                str(data.get('created_by_name') or ''),
                str(data.get('pc_id') or ''),
                1 if data.get('deleted') else 0,
                obs_id
            ))
            return obs_id

        with self.db.get_connection() as conn:
            cur = conn.cursor()
            if created_at:
                cur.execute("""
                    INSERT INTO observations
                        (firebase_id, text, context, sale_id, sale_item_id,
                         created_by_id, created_by_name, pc_id,
                         created_at, deleted)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    firebase_id, text, context,
                    data.get('sale_id'), data.get('sale_item_id'),
                    data.get('created_by_id'),
                    str(data.get('created_by_name') or ''),
                    str(data.get('pc_id') or ''),
                    str(created_at),
                    1 if data.get('deleted') else 0,
                ))
            else:
                cur.execute("""
                    INSERT INTO observations
                        (firebase_id, text, context, sale_id, sale_item_id,
                         created_by_id, created_by_name, pc_id, deleted)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    firebase_id, text, context,
                    data.get('sale_id'), data.get('sale_item_id'),
                    data.get('created_by_id'),
                    str(data.get('created_by_name') or ''),
                    str(data.get('pc_id') or ''),
                    1 if data.get('deleted') else 0,
                ))
            return cur.lastrowid
