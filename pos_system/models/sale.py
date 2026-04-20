import logging
from datetime import datetime
from pos_system.utils.firebase_sync import now_ar
from typing import List, Dict, Optional
from pos_system.database.db_manager import DatabaseManager

logger = logging.getLogger(__name__)

class Sale:
    """Modelo para ventas"""
    
    def __init__(self, db_manager: DatabaseManager):
        self.db = db_manager
    
    def create(self, sale_data: dict) -> int:
        """
        Crea una nueva venta con sus items en una sola transacción atómica.
        sale_data: dict con keys: items, payment_type, total_amount
        items: Lista de diccionarios con {product_id, product_name, quantity, unit_price}
        payment_type: 'cash' o 'transfer'
        """
        items = sale_data.get('items', [])
        payment_type = sale_data.get('payment_type')
        total_amount = sale_data.get('total_amount')

        if not items:
            raise ValueError("La venta debe tener al menos un item")
        if payment_type not in ('cash', 'transfer'):
            raise ValueError(f"Tipo de pago inválido: {payment_type}")
        if total_amount is None or total_amount <= 0:
            raise ValueError("El monto total debe ser mayor a cero")

        # Obtener caja registradora actual
        cash_register = self.db.get_current_cash_register()
        cash_register_id = cash_register['id'] if cash_register else None

        cash_received = sale_data.get('cash_received', 0) or 0
        change_given = sale_data.get('change_given', 0) or 0
        user_id = sale_data.get('user_id')
        notes = sale_data.get('notes', '')
        turno_nombre = sale_data.get('turno_nombre', '') or ''

        # Todo en una sola transacción atómica
        with self.db.get_connection() as conn:
            cursor = conn.cursor()

            # 1. Crear la venta
            cursor.execute(
                "INSERT INTO sales (total_amount, payment_type, cash_received, change_given, cash_register_id, user_id, notes, turno_nombre) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (total_amount, payment_type, cash_received, change_given, cash_register_id, user_id, notes, turno_nombre)
            )
            sale_id = cursor.lastrowid

            # 2. Insertar items y actualizar stock
            for item in items:
                subtotal       = item['quantity'] * item['unit_price']
                original_price = item.get('original_price', item['unit_price'])
                discount_type  = item.get('discount_type') or None
                discount_value = item.get('discount_value', 0) or 0
                discount_amount= item.get('discount_amount', 0) or 0
                promo_id       = item.get('promo_id') or None
                cursor.execute(
                    """INSERT INTO sale_items
                       (sale_id, product_id, product_name, quantity,
                        unit_price, original_price, discount_type,
                        discount_value, discount_amount, promo_id, subtotal)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (sale_id, item['product_id'], item['product_name'],
                     item['quantity'], item['unit_price'], original_price,
                     discount_type, discount_value, discount_amount,
                     promo_id, subtotal)
                )
                # Descontar stock — se permite vender aunque no haya stock suficiente
                cursor.execute(
                    "UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ? AND stock != -1",
                    (item['quantity'], datetime.now().isoformat(), item['product_id'])
                )
                # stock = -1 significa servicio/ilimitado, no se descuenta

            # 3. Actualizar caja registradora
            if cash_register_id:
                if payment_type == 'cash':
                    cursor.execute(
                        "UPDATE cash_register SET cash_sales = cash_sales + ?, total_sales = total_sales + ? WHERE id = ?",
                        (total_amount, total_amount, cash_register_id)
                    )
                else:
                    cursor.execute(
                        "UPDATE cash_register SET transfer_sales = transfer_sales + ?, total_sales = total_sales + ? WHERE id = ?",
                        (total_amount, total_amount, cash_register_id)
                    )

        logger.info(f"Venta creada: ID={sale_id}, total=${total_amount:.2f}, pago={payment_type}")
        
        # Sincronizar resumen mensual
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if fb:
                now = datetime.now() if hasattr(datetime, 'now') else __import__('datetime').datetime.now()
                # Get all sales for this month
                month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
                month_sales = self.get_all(
                    start_date=month_start.strftime('%Y-%m-%d 00:00:00'),
                    end_date=now.strftime('%Y-%m-%d 23:59:59')
                )
                fb.sync_monthly_summary(now.year, now.month, month_sales)
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f'Error syncing monthly summary: {e}')
        
        return sale_id
    
    def update(self, sale_id: int, payment_type: Optional[str] = None,
               items_updates: Optional[List[Dict]] = None) -> Optional[Dict]:
        """Edita una venta existente: tipo de pago y/o precios unitarios de items.

        items_updates: lista de {'id': sale_item_id, 'unit_price': nuevo_precio}
        Recalcula subtotales e total_amount, y ajusta la caja (cash_register) para
        reflejar los cambios. Todo en una transacción atómica.

        Retorna la venta actualizada (con items) o None si no existe.
        """
        sale = self.get_by_id(sale_id)
        if not sale:
            return None
        if payment_type is not None and payment_type not in ('cash', 'transfer'):
            raise ValueError(f"Tipo de pago inválido: {payment_type}")

        old_total    = float(sale.get('total_amount', 0) or 0)
        old_ptype    = sale.get('payment_type')
        register_id  = sale.get('cash_register_id')
        new_ptype    = payment_type if payment_type is not None else old_ptype

        with self.db.get_connection() as conn:
            cursor = conn.cursor()

            # 1. Actualizar items si hay cambios de precio
            if items_updates:
                for upd in items_updates:
                    item_id   = upd.get('id')
                    new_price = upd.get('unit_price')
                    if item_id is None or new_price is None:
                        continue
                    cursor.execute(
                        "SELECT quantity, discount_amount FROM sale_items WHERE id = ? AND sale_id = ?",
                        (int(item_id), sale_id)
                    )
                    row = cursor.fetchone()
                    if not row:
                        continue
                    qty        = int(row[0] if row[0] is not None else 1)
                    disc_amt   = float(row[1] or 0)
                    new_price  = float(new_price)
                    new_sub    = max(0.0, new_price * qty - disc_amt)
                    cursor.execute(
                        "UPDATE sale_items SET unit_price = ?, subtotal = ? WHERE id = ?",
                        (new_price, new_sub, int(item_id))
                    )

            # 2. Recalcular total desde items actualizados
            cursor.execute(
                "SELECT COALESCE(SUM(subtotal), 0) FROM sale_items WHERE sale_id = ?",
                (sale_id,)
            )
            new_total = float(cursor.fetchone()[0] or 0)

            # 3. Actualizar venta (total + tipo de pago)
            cursor.execute(
                "UPDATE sales SET total_amount = ?, payment_type = ? WHERE id = ?",
                (new_total, new_ptype, sale_id)
            )

            # 4. Ajustar caja registradora: revertir el aporte viejo y sumar el nuevo.
            #    Se hace aunque la caja esté cerrada — get_closing_report lee la tabla
            #    cash_register, así que queda consistente en Firebase al re-sincronizar.
            if register_id:
                # Revertir venta vieja
                if old_ptype == 'cash':
                    cursor.execute(
                        "UPDATE cash_register SET cash_sales = cash_sales - ?, total_sales = total_sales - ? WHERE id = ?",
                        (old_total, old_total, register_id)
                    )
                else:
                    cursor.execute(
                        "UPDATE cash_register SET transfer_sales = transfer_sales - ?, total_sales = total_sales - ? WHERE id = ?",
                        (old_total, old_total, register_id)
                    )
                # Sumar venta nueva
                if new_ptype == 'cash':
                    cursor.execute(
                        "UPDATE cash_register SET cash_sales = cash_sales + ?, total_sales = total_sales + ? WHERE id = ?",
                        (new_total, new_total, register_id)
                    )
                else:
                    cursor.execute(
                        "UPDATE cash_register SET transfer_sales = transfer_sales + ?, total_sales = total_sales + ? WHERE id = ?",
                        (new_total, new_total, register_id)
                    )

        logger.info(
            f"Venta #{sale_id} actualizada: total ${old_total:.2f}→${new_total:.2f}, "
            f"pago {old_ptype}→{new_ptype}"
        )
        return self.get_by_id(sale_id)

    def _update_cash_register(self, cash_register_id: int, amount: float, payment_type: str):
        """Actualiza los totales de la caja registradora (método legacy, usar transacción en create())"""
        if payment_type == 'cash':
            query = """
                UPDATE cash_register 
                SET cash_sales = cash_sales + ?,
                    total_sales = total_sales + ?
                WHERE id = ?
            """
        else:
            query = """
                UPDATE cash_register 
                SET transfer_sales = transfer_sales + ?,
                    total_sales = total_sales + ?
                WHERE id = ?
            """
        self.db.execute_update(query, (amount, amount, cash_register_id))
    
    def get_by_id(self, sale_id: int) -> Optional[Dict]:
        """Obtiene una venta por su ID con sus items"""
        sale_query = "SELECT * FROM sales WHERE id = ?"
        sale_result = self.db.execute_query(sale_query, (sale_id,))
        
        if not sale_result:
            return None
        
        sale = sale_result[0]
        
        # Obtener items de la venta
        items_query = "SELECT * FROM sale_items WHERE sale_id = ?"
        items = self.db.execute_query(items_query, (sale_id,))
        sale['items'] = items
        
        return sale
    
    def get_all(self, start_date: str = None, end_date: str = None, 
                payment_type: str = None) -> List[Dict]:
        """Obtiene todas las ventas con filtros opcionales"""
        query = "SELECT * FROM sales WHERE 1=1"
        params = []
        
        if start_date:
            query += " AND created_at >= ?"
            params.append(start_date)
        
        if end_date:
            query += " AND created_at <= ?"
            params.append(end_date)
        
        if payment_type:
            query += " AND payment_type = ?"
            params.append(payment_type)
        
        # Orden estable: desempate por id para ventas con el mismo timestamp.
        query += " ORDER BY created_at DESC, id DESC"
        return self.db.execute_query(query, tuple(params))
    
    def get_today_sales(self) -> List[Dict]:
        """Obtiene las ventas del día actual"""
        today = datetime.now().strftime("%Y-%m-%d")
        return self.get_all(start_date=f"{today} 00:00:00", end_date=f"{today} 23:59:59")
    
    def get_sales_summary(self, start_date: str = None, end_date: str = None) -> Dict:
        """Obtiene resumen de ventas"""
        if not start_date:
            start_date = datetime.now().strftime("%Y-%m-%d") + " 00:00:00"
        if not end_date:
            end_date = datetime.now().strftime("%Y-%m-%d") + " 23:59:59"
            
        query = """
            SELECT 
                COUNT(*) as total_count,
                COALESCE(SUM(total_amount), 0) as total_amount,
                COALESCE(SUM(CASE WHEN payment_type = 'cash' THEN total_amount ELSE 0 END), 0) as cash_amount,
                COALESCE(SUM(CASE WHEN payment_type = 'transfer' THEN total_amount ELSE 0 END), 0) as transfer_amount,
                COALESCE(AVG(total_amount), 0) as average_sale
            FROM sales
            WHERE created_at >= ? AND created_at <= ?
        """
        
        result = self.db.execute_query(query, (start_date, end_date))
        if result and result[0]:
            return result[0]
        else:
            return {
                'total_count': 0,
                'total_amount': 0,
                'cash_amount': 0,
                'transfer_amount': 0,
                'average_sale': 0
            }
    
    def get_top_selling_products(self, limit: int = 10, start_date: str = None, end_date: str = None) -> List[Dict]:
        """Obtiene los productos más vendidos"""
        query = """
            SELECT 
                si.product_id,
                si.product_name,
                SUM(si.quantity) as total_quantity,
                SUM(si.subtotal) as total_revenue,
                COUNT(DISTINCT si.sale_id) as times_sold
            FROM sale_items si
            JOIN sales s ON si.sale_id = s.id
            WHERE 1=1
        """
        params = []
        
        if start_date:
            query += " AND s.created_at >= ?"
            params.append(start_date)
        
        if end_date:
            query += " AND s.created_at <= ?"
            params.append(end_date)
        
        query += """
            GROUP BY si.product_id, si.product_name
            ORDER BY total_quantity DESC
            LIMIT ?
        """
        params.append(limit)
        
        return self.db.execute_query(query, tuple(params))
    
    def get_sales_by_hour(self, date: str = None) -> List[Dict]:
        """Obtiene las ventas agrupadas por hora"""
        if not date:
            date = datetime.now().strftime("%Y-%m-%d")
        
        query = """
            SELECT 
                CAST(strftime('%H', created_at) AS INTEGER) as hour,
                COUNT(*) as count,
                COALESCE(SUM(total_amount), 0) as total
            FROM sales
            WHERE date(created_at) = ?
            GROUP BY hour
            ORDER BY hour
        """
        return self.db.execute_query(query, (date,))
