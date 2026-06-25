"""Modelo de Ventas Pendientes / En espera (hold del carrito).

Caso de uso:
- Un cajero está vendiendo y deja el carrito a medias (el cliente fue a buscar
  plata, se olvidó de facturar, etc.). En vez de perderlo, lo guarda "en espera"
  y otro cajero puede seguir vendiendo en la misma PC.
- Más tarde se restaura tal cual al carrito ("Volver al carrito") o se descarta.

Reglas:
- El carrito completo se serializa como JSON en `items_json` (restauración fiel).
- Es 100% local: NO sincroniza a Firebase.
- La fila se borra cuando sale de la lista (restaurada o descartada).
"""
import json
import logging
from typing import List, Dict, Optional

from pos_system.database.db_manager import DatabaseManager

logger = logging.getLogger(__name__)


class PendingCart:
    """CRUD de ventas pendientes (carrito en espera)."""

    def __init__(self, db_manager: DatabaseManager):
        self.db = db_manager

    def create(self, items: List[Dict], cajero_nombre: str = '',
               user_id: Optional[int] = None, pc_id: str = '',
               nota: str = '') -> Optional[int]:
        """Guarda el carrito como pendiente. Devuelve el id nuevo o None."""
        items = items or []
        total = round(sum(float(it.get('subtotal') or 0) for it in items), 2)
        items_count = sum(float(it.get('quantity') or 0) for it in items)
        # default=str protege ante cualquier valor no serializable (Decimal, etc.)
        items_json = json.dumps(items, ensure_ascii=False, default=str)
        return self.db.execute_update(
            "INSERT INTO pending_carts "
            "(cajero_nombre, user_id, pc_id, items_json, total, items_count, nota) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (str(cajero_nombre or ''), user_id, str(pc_id or ''),
             items_json, total, items_count, str(nota or ''))
        )

    def get_all(self) -> List[Dict]:
        """Lista los pendientes (más recientes primero) con items deserializados."""
        rows = self.db.execute_query(
            "SELECT * FROM pending_carts ORDER BY created_at DESC, id DESC"
        ) or []
        out = []
        for r in rows:
            d = dict(r)
            d['items'] = self._parse_items(d.get('items_json'))
            out.append(d)
        return out

    def get_by_id(self, pending_id: int) -> Optional[Dict]:
        rows = self.db.execute_query(
            "SELECT * FROM pending_carts WHERE id = ? LIMIT 1", (int(pending_id),)
        ) or []
        if not rows:
            return None
        d = dict(rows[0])
        d['items'] = self._parse_items(d.get('items_json'))
        return d

    def count(self) -> int:
        rows = self.db.execute_query(
            "SELECT COUNT(*) AS n FROM pending_carts"
        ) or []
        return int(rows[0].get('n') or 0) if rows else 0

    def delete(self, pending_id: int) -> int:
        """Borra el pendiente. Devuelve la cantidad de filas afectadas
        (0 si no existía / no se borró nada)."""
        return self.db.execute_delete(
            "DELETE FROM pending_carts WHERE id = ?", (int(pending_id),)
        )

    @staticmethod
    def _parse_items(items_json) -> List[Dict]:
        if not items_json:
            return []
        try:
            data = json.loads(items_json)
            return data if isinstance(data, list) else []
        except Exception:
            logger.warning("pending_carts: items_json corrupto, se ignora.")
            return []
