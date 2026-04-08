import logging
from datetime import datetime
from typing import List, Dict, Optional
from pos_system.database.db_manager import DatabaseManager

logger = logging.getLogger(__name__)

# Tipos de promoción soportados
PROMO_TYPES = {
    'percentage': 'Descuento %',          # X% de descuento sobre el precio
    'fixed':      'Descuento fijo $',     # $X de descuento
    '2x1':        '2x1 (lleva 2 paga 1)',
    'nxm':        'NxM (lleva N paga M)',  # ej: lleva 3, paga 2
    'bundle':     'Pack/Combo',            # precio especial por conjunto
}


class Promotion:
    """Modelo de Promociones y Descuentos"""

    def __init__(self, db_manager: DatabaseManager):
        self.db = db_manager

    # ─────────────────────────────────────────────
    #  CRUD
    # ─────────────────────────────────────────────

    def create(self, promo_data: dict) -> int:
        """
        Crea una nueva promoción.

        promo_data keys:
            name            str   – nombre visible
            promo_type      str   – clave de PROMO_TYPES
            description     str   – descripción opcional
            discount_value  float – % o $ según tipo
            required_quantity int – cantidad que el cliente lleva
            free_quantity   int   – cantidad que no paga (para nxm/2x1)
            product_ids     list  – lista de IDs de productos vinculados
        """
        name = promo_data.get('name', '').strip()
        if not name:
            raise ValueError("El nombre de la promoción es obligatorio")

        promo_type = promo_data.get('promo_type', '')
        if promo_type not in PROMO_TYPES:
            raise ValueError(f"Tipo de promoción inválido: {promo_type}")

        discount_value = float(promo_data.get('discount_value', 0))
        required_qty   = int(promo_data.get('required_quantity', 1))
        free_qty       = int(promo_data.get('free_quantity', 0))

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """INSERT INTO promotions
                   (name, promo_type, description, discount_value,
                    required_quantity, free_quantity, is_active)
                   VALUES (?, ?, ?, ?, ?, ?, 1)""",
                (name, promo_type,
                 promo_data.get('description', ''),
                 discount_value, required_qty, free_qty)
            )
            promo_id = cursor.lastrowid

            # Vincular productos
            product_ids = promo_data.get('product_ids', [])
            for pid in product_ids:
                try:
                    cursor.execute(
                        "INSERT OR IGNORE INTO promotion_products (promotion_id, product_id) VALUES (?, ?)",
                        (promo_id, pid)
                    )
                except Exception:
                    pass

        logger.info(f"Promoción creada: {name} (ID: {promo_id})")
        return promo_id

    def update(self, promo_id: int, promo_data: dict) -> bool:
        """Actualiza una promoción existente."""
        name = promo_data.get('name', '').strip()
        if not name:
            raise ValueError("El nombre es obligatorio")

        promo_type = promo_data.get('promo_type', '')
        if promo_type not in PROMO_TYPES:
            raise ValueError(f"Tipo inválido: {promo_type}")

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """UPDATE promotions SET
                   name=?, promo_type=?, description=?, discount_value=?,
                   required_quantity=?, free_quantity=?, is_active=?,
                   updated_at=?
                   WHERE id=?""",
                (name, promo_type,
                 promo_data.get('description', ''),
                 float(promo_data.get('discount_value', 0)),
                 int(promo_data.get('required_quantity', 1)),
                 int(promo_data.get('free_quantity', 0)),
                 1 if promo_data.get('is_active', True) else 0,
                 datetime.now().isoformat(),
                 promo_id)
            )
            # Reemplazar productos vinculados
            cursor.execute("DELETE FROM promotion_products WHERE promotion_id=?", (promo_id,))
            for pid in promo_data.get('product_ids', []):
                try:
                    cursor.execute(
                        "INSERT OR IGNORE INTO promotion_products (promotion_id, product_id) VALUES (?, ?)",
                        (promo_id, pid)
                    )
                except Exception:
                    pass

        logger.info(f"Promoción actualizada: ID {promo_id}")
        return True

    def delete(self, promo_id: int) -> bool:
        """Elimina una promoción y sus vínculos."""
        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM promotion_products WHERE promotion_id=?", (promo_id,))
            cursor.execute("DELETE FROM promotions WHERE id=?", (promo_id,))
        logger.info(f"Promoción eliminada: ID {promo_id}")
        return True

    def toggle_active(self, promo_id: int) -> bool:
        """Activa / desactiva una promoción."""
        promo = self.get_by_id(promo_id)
        if not promo:
            return False
        new_status = 0 if promo['is_active'] else 1
        self.db.execute_update(
            "UPDATE promotions SET is_active=?, updated_at=? WHERE id=?",
            (new_status, datetime.now().isoformat(), promo_id)
        )
        return True

    # ─────────────────────────────────────────────
    #  Consultas
    # ─────────────────────────────────────────────

    def get_all(self, active_only: bool = False) -> List[Dict]:
        query = "SELECT * FROM promotions"
        if active_only:
            query += " WHERE is_active = 1"
        query += " ORDER BY name"
        promos = self.db.execute_query(query)
        for p in promos:
            p['product_ids'] = self._get_product_ids(p['id'])
            p['products']    = self._get_products(p['id'])
        return promos

    def get_by_id(self, promo_id: int) -> Optional[Dict]:
        result = self.db.execute_query("SELECT * FROM promotions WHERE id=?", (promo_id,))
        if not result:
            return None
        p = result[0]
        p['product_ids'] = self._get_product_ids(promo_id)
        p['products']    = self._get_products(promo_id)
        return p

    def get_active_for_product(self, product_id: int) -> List[Dict]:
        """Devuelve todas las promociones activas vinculadas a un producto."""
        query = """
            SELECT p.* FROM promotions p
            JOIN promotion_products pp ON pp.promotion_id = p.id
            WHERE pp.product_id = ? AND p.is_active = 1
            ORDER BY p.promo_type
        """
        promos = self.db.execute_query(query, (product_id,))
        for p in promos:
            p['product_ids'] = self._get_product_ids(p['id'])
            p['products']    = self._get_products(p['id'])
        return promos

    # ─────────────────────────────────────────────
    #  Lógica de cálculo de precios
    # ─────────────────────────────────────────────

    @staticmethod
    def calculate_discounted_price(original_price: float,
                                   discount_type: str,
                                   discount_value: float) -> tuple:
        """
        Calcula precio con descuento de producto.

        Returns:
            (final_price, discount_amount)
        """
        if not discount_type or discount_value <= 0:
            return original_price, 0.0

        if discount_type == 'percentage':
            pct = min(discount_value, 100.0)
            discount_amount = round(original_price * pct / 100, 2)
            final_price = round(original_price - discount_amount, 2)
        elif discount_type == 'fixed':
            discount_amount = min(discount_value, original_price)
            final_price = round(original_price - discount_amount, 2)
        else:
            return original_price, 0.0

        return max(final_price, 0.0), discount_amount

    @staticmethod
    def calculate_promo_for_cart_item(promo: dict, quantity: int,
                                      unit_price: float) -> tuple:
        """
        Aplica una promoción (2x1, nxm, porcentaje, fijo) a una línea del carrito.

        Returns:
            (effective_unit_price, discount_amount_total, promo_label)
        """
        ptype = promo.get('promo_type')
        dval  = float(promo.get('discount_value', 0))
        req   = int(promo.get('required_quantity', 1))
        free  = int(promo.get('free_quantity', 0))

        if ptype == 'percentage':
            pct = min(dval, 100.0)
            discount_per_unit = round(unit_price * pct / 100, 2)
            discount_total    = round(discount_per_unit * quantity, 2)
            eff_price         = unit_price - discount_per_unit
            label             = f"-{pct:.0f}%"

        elif ptype == 'fixed':
            discount_per_unit = min(dval, unit_price)
            discount_total    = round(discount_per_unit * quantity, 2)
            eff_price         = unit_price - discount_per_unit
            label             = f"-${dval:.2f} c/u"

        elif ptype in ('2x1', 'nxm'):
            # Para NxM: lleva `req`, paga (req - free)
            if ptype == '2x1':
                req, free = 2, 1
            pays = req - free
            if pays <= 0 or req <= 0:
                return unit_price, 0.0, ""
            # grupos completos + resto
            groups     = quantity // req
            remainder  = quantity % req
            paid_units = groups * pays + min(remainder, pays)
            total_paid = paid_units * unit_price
            discount_total = round(quantity * unit_price - total_paid, 2)
            eff_price      = total_paid / quantity if quantity else unit_price
            label          = promo.get('name', f"{req}x{pays}")

        elif ptype == 'bundle':
            # Precio especial para pack: discount_value es el precio total del pack
            # Si no hay suficientes productos, no aplica
            if quantity >= req and dval > 0:
                groups         = quantity // req
                bundle_total   = groups * dval
                rest_total     = (quantity % req) * unit_price
                total_paid     = bundle_total + rest_total
                discount_total = round(quantity * unit_price - total_paid, 2)
                eff_price      = total_paid / quantity if quantity else unit_price
                label          = f"Pack ${dval:.2f}"
            else:
                return unit_price, 0.0, ""

        else:
            return unit_price, 0.0, ""

        return round(max(eff_price, 0), 4), round(discount_total, 2), label

    # ─────────────────────────────────────────────
    #  Helpers privados
    # ─────────────────────────────────────────────

    def _get_product_ids(self, promo_id: int) -> List[int]:
        rows = self.db.execute_query(
            "SELECT product_id FROM promotion_products WHERE promotion_id=?", (promo_id,)
        )
        return [r['product_id'] for r in rows]

    def _get_products(self, promo_id: int) -> List[Dict]:
        rows = self.db.execute_query(
            """SELECT p.id, p.name, p.price FROM products p
               JOIN promotion_products pp ON pp.product_id = p.id
               WHERE pp.promotion_id = ?""",
            (promo_id,)
        )
        return list(rows)
