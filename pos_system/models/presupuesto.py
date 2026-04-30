"""Modelo de Presupuestos (cotizaciones previas a la venta).

Reglas:
- No descuenta stock al crear.
- Numeración correlativa propia, persistida en la tabla `config`
  bajo la key `next_presupuesto_number` (default = 1).
- Estados: 'pendiente' | 'vencido' | 'convertido' | 'anulado'.
- Cuando se convierte a venta, se setea estado='convertido' + venta_id.
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Optional

from pos_system.database.db_manager import DatabaseManager

logger = logging.getLogger(__name__)

_TZ_AR = timezone(timedelta(hours=-3))
_CONFIG_KEY = 'next_presupuesto_number'


class Presupuesto:
    """CRUD de presupuestos."""

    def __init__(self, db_manager: DatabaseManager):
        self.db = db_manager

    # ── Numeración correlativa ───────────────────────────────────────────────
    def _consume_next_numero(self, conn) -> int:
        """Reserva el siguiente número correlativo de forma transaccional.

        Lee `config.next_presupuesto_number`, lo devuelve, y persiste el
        siguiente. Debe llamarse dentro de una transacción ya abierta.
        """
        cur = conn.cursor()
        cur.execute("SELECT value FROM config WHERE key = ?", (_CONFIG_KEY,))
        row = cur.fetchone()
        current = int(row['value']) if row and str(row['value']).isdigit() else 1
        cur.execute(
            "INSERT INTO config (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
            "updated_at = (localtime_now())",
            (_CONFIG_KEY, str(current + 1))
        )
        return current

    def peek_next_numero(self) -> int:
        """Lee el próximo número sin consumirlo (para mostrar en UI)."""
        rows = self.db.execute_query(
            "SELECT value FROM config WHERE key = ?", (_CONFIG_KEY,)
        )
        if not rows:
            return 1
        v = rows[0].get('value')
        return int(v) if v and str(v).isdigit() else 1

    # ── Crear ────────────────────────────────────────────────────────────────
    def create(self, items: List[Dict], cliente_nombre: str = '',
               cliente_telefono: str = '', cliente_email: str = '',
               descuento: float = 0.0, validez_dias: int = 7,
               cajero_nombre: str = '', user_id: Optional[int] = None,
               pc_id: str = '', notas: str = '') -> Dict:
        """Crea un presupuesto y devuelve el dict completo (incluye numero, id).

        items: lista de dicts con keys: product_id (opcional), product_name,
               quantity, unit_price.
        """
        if not items:
            raise ValueError("El presupuesto no puede estar vacío")

        subtotal = 0.0
        items_norm = []
        for it in items:
            qty = float(it.get('quantity') or 0)
            price = float(it.get('unit_price') or 0)
            sub = qty * price
            subtotal += sub
            items_norm.append({
                'product_id': it.get('product_id'),
                'product_name': str(it.get('product_name') or '').strip(),
                'quantity': qty,
                'unit_price': price,
                'subtotal': round(sub, 2),
            })

        descuento = float(descuento or 0)
        total = round(subtotal - descuento, 2)

        fecha_validez = (datetime.now(_TZ_AR) + timedelta(days=int(validez_dias))).strftime('%Y-%m-%d')

        with self.db.get_connection() as conn:
            cur = conn.cursor()
            numero = self._consume_next_numero(conn)
            # firebase_id explícitamente NULL: la columna en versiones viejas tenía
            # UNIQUE+DEFAULT '' que rompía al insertar el 2do registro.
            cur.execute("""
                INSERT INTO presupuestos
                    (firebase_id, numero, cliente_nombre, cliente_telefono, cliente_email,
                     subtotal, descuento, total, fecha_validez, estado,
                     pc_id, cajero_nombre, user_id, notas)
                VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?)
            """, (numero, cliente_nombre.strip(), cliente_telefono.strip(),
                  cliente_email.strip(), round(subtotal, 2), descuento, total,
                  fecha_validez, pc_id, cajero_nombre, user_id, notas))
            pres_id = cur.lastrowid
            for it in items_norm:
                cur.execute("""
                    INSERT INTO presupuesto_items
                        (presupuesto_id, product_id, product_name,
                         quantity, unit_price, subtotal)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (pres_id, it['product_id'], it['product_name'],
                      it['quantity'], it['unit_price'], it['subtotal']))

        logger.info(f"Presupuesto P-{numero:05d} creado (id={pres_id}, total=${total})")
        return self.get_by_id(pres_id)

    # ── Lectura ──────────────────────────────────────────────────────────────
    def get_by_id(self, pres_id: int) -> Optional[Dict]:
        rows = self.db.execute_query(
            "SELECT * FROM presupuestos WHERE id = ?", (pres_id,)
        )
        if not rows:
            return None
        p = rows[0]
        p['items'] = self.db.execute_query(
            "SELECT * FROM presupuesto_items WHERE presupuesto_id = ? ORDER BY id",
            (pres_id,)
        )
        return p

    def get_by_numero(self, numero: int) -> Optional[Dict]:
        rows = self.db.execute_query(
            "SELECT * FROM presupuestos WHERE numero = ? AND deleted = 0",
            (int(numero),)
        )
        if not rows:
            return None
        return self.get_by_id(rows[0]['id'])

    def list_all(self, estado: Optional[str] = None,
                 search: str = '', limit: int = 500,
                 include_deleted: bool = False) -> List[Dict]:
        """Lista presupuestos. estado='pendiente'/'vencido'/'convertido'/'anulado'/None=todos."""
        where = []
        params = []
        if not include_deleted:
            where.append("deleted = 0")
        if estado:
            where.append("estado = ?")
            params.append(estado)
        if search:
            where.append("(cliente_nombre LIKE ? OR CAST(numero AS TEXT) LIKE ?)")
            like = f"%{search}%"
            params.extend([like, like])
        sql = "SELECT * FROM presupuestos"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY fecha_emision DESC, id DESC LIMIT ?"
        params.append(int(limit))
        return self.db.execute_query(sql, tuple(params))

    # ── Cambios de estado ────────────────────────────────────────────────────
    def set_estado(self, pres_id: int, estado: str,
                   venta_id: Optional[int] = None) -> bool:
        if estado not in ('pendiente', 'vencido', 'convertido', 'anulado'):
            raise ValueError(f"Estado inválido: {estado}")
        if venta_id is not None:
            self.db.execute_update(
                "UPDATE presupuestos SET estado = ?, venta_id = ?, "
                "updated_at = (localtime_now()) WHERE id = ?",
                (estado, venta_id, pres_id)
            )
        else:
            self.db.execute_update(
                "UPDATE presupuestos SET estado = ?, "
                "updated_at = (localtime_now()) WHERE id = ?",
                (estado, pres_id)
            )
        return True

    def set_pdf_path(self, pres_id: int, pdf_path: str) -> None:
        self.db.execute_update(
            "UPDATE presupuestos SET pdf_path = ? WHERE id = ?",
            (pdf_path, pres_id)
        )

    def set_firebase_id(self, pres_id: int, firebase_id: str) -> None:
        self.db.execute_update(
            "UPDATE presupuestos SET firebase_id = ? WHERE id = ?",
            (firebase_id, pres_id)
        )

    def soft_delete(self, pres_id: int) -> None:
        self.db.execute_update(
            "UPDATE presupuestos SET deleted = 1, "
            "updated_at = (localtime_now()) WHERE id = ?",
            (pres_id,)
        )

    def expire_overdue(self) -> int:
        """Marca como 'vencido' los presupuestos pendientes con
        fecha_validez < hoy. Retorna la cantidad afectada."""
        hoy = datetime.now(_TZ_AR).strftime('%Y-%m-%d')
        with self.db.get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "UPDATE presupuestos SET estado = 'vencido', "
                "updated_at = (localtime_now()) "
                "WHERE estado = 'pendiente' AND fecha_validez < ?",
                (hoy,)
            )
            return cur.rowcount

    # ── Sync entrante desde Firebase ─────────────────────────────────────────
    def upsert_from_firebase(self, firebase_id: str, data: Dict) -> Optional[int]:
        """Inserta o actualiza un presupuesto recibido de Firestore.

        Si el doc ya existe localmente (por firebase_id o por numero), se actualiza
        el estado y los totales. Si es nuevo, se crea (sin re-numerar — usa el
        numero remoto). Retorna el id local, o None si se ignoró.
        """
        if not firebase_id:
            return None
        numero = int(data.get('numero') or 0)
        if not numero:
            return None

        # ¿Ya existe localmente?
        rows = self.db.execute_query(
            "SELECT id FROM presupuestos WHERE firebase_id = ?", (firebase_id,)
        )
        if not rows:
            rows = self.db.execute_query(
                "SELECT id FROM presupuestos WHERE numero = ?", (numero,)
            )
        existing_id = rows[0]['id'] if rows else None

        items_arr = data.get('items') or []

        if existing_id:
            # Actualizar
            self.db.execute_update(
                """UPDATE presupuestos SET
                    firebase_id = ?, cliente_nombre = ?, cliente_telefono = ?,
                    cliente_email = ?, subtotal = ?, descuento = ?, total = ?,
                    fecha_validez = ?, estado = ?, venta_id = ?, notas = ?,
                    deleted = ?, updated_at = (localtime_now())
                   WHERE id = ?""",
                (firebase_id,
                 str(data.get('cliente_nombre') or ''),
                 str(data.get('cliente_telefono') or ''),
                 str(data.get('cliente_email') or ''),
                 float(data.get('subtotal') or 0),
                 float(data.get('descuento') or 0),
                 float(data.get('total') or 0),
                 str(data.get('fecha_validez') or ''),
                 str(data.get('estado') or 'pendiente'),
                 data.get('venta_id'),
                 str(data.get('notas') or ''),
                 1 if data.get('deleted') else 0,
                 existing_id)
            )
            return existing_id

        # Nuevo: insertar conservando el numero remoto
        with self.db.get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                """INSERT INTO presupuestos
                    (firebase_id, numero, cliente_nombre, cliente_telefono,
                     cliente_email, subtotal, descuento, total, fecha_validez,
                     estado, venta_id, pc_id, cajero_nombre, user_id, notas, deleted)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (firebase_id, numero,
                 str(data.get('cliente_nombre') or ''),
                 str(data.get('cliente_telefono') or ''),
                 str(data.get('cliente_email') or ''),
                 float(data.get('subtotal') or 0),
                 float(data.get('descuento') or 0),
                 float(data.get('total') or 0),
                 str(data.get('fecha_validez') or ''),
                 str(data.get('estado') or 'pendiente'),
                 data.get('venta_id'),
                 str(data.get('pc_id') or ''),
                 str(data.get('cajero_nombre') or ''),
                 data.get('user_id'),
                 str(data.get('notas') or ''),
                 1 if data.get('deleted') else 0)
            )
            new_id = cur.lastrowid
            for it in items_arr:
                cur.execute(
                    """INSERT INTO presupuesto_items
                        (presupuesto_id, product_id, product_name,
                         quantity, unit_price, subtotal)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (new_id, it.get('product_id'),
                     str(it.get('product_name') or ''),
                     float(it.get('quantity') or 0),
                     float(it.get('unit_price') or 0),
                     float(it.get('subtotal') or 0))
                )
            # Bumpear contador si el numero remoto es mayor
            cur.execute("SELECT value FROM config WHERE key = ?", (_CONFIG_KEY,))
            r = cur.fetchone()
            current_next = int(r['value']) if r and str(r['value']).isdigit() else 1
            if numero >= current_next:
                cur.execute(
                    "INSERT INTO config (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
                    "updated_at = (localtime_now())",
                    (_CONFIG_KEY, str(numero + 1))
                )
            return new_id

    # ── Stats para UI ────────────────────────────────────────────────────────
    def count_by_estado(self) -> Dict[str, int]:
        rows = self.db.execute_query(
            "SELECT estado, COUNT(*) as cnt FROM presupuestos "
            "WHERE deleted = 0 GROUP BY estado"
        )
        return {r['estado']: r['cnt'] for r in rows}
