from datetime import datetime
from typing import List, Dict, Optional
from pos_system.database.db_manager import DatabaseManager

class CashRegister:
    """Modelo para caja registradora"""
    
    def __init__(self, db_manager: DatabaseManager):
        self.db = db_manager
    
    def open_register(self, initial_amount: float = 0, notes: str = "") -> int:
        """Abre una nueva caja"""
        # Verificar si hay una caja abierta
        current = self.get_current()
        if current:
            raise Exception("Ya hay una caja abierta. Debe cerrarla primero.")
        
        query = """
            INSERT INTO cash_register (initial_amount, notes, status)
            VALUES (?, ?, 'open')
        """
        return self.db.execute_update(query, (initial_amount, notes))
    
    def get_current(self) -> Optional[Dict]:
        """Obtiene la caja actual abierta"""
        return self.db.get_current_cash_register()
    
    def close_register(self, cash_register_id: int, final_amount: float = None, notes: str = "") -> Dict:
        """Cierra una caja y genera el reporte"""
        # Obtener datos de la caja
        register = self.get_by_id(cash_register_id)
        if not register:
            raise Exception("Caja no encontrada")
        
        if register['status'] == 'closed':
            raise Exception("La caja ya está cerrada")
        
        # Si no se proporciona monto final, calcularlo
        if final_amount is None:
            final_amount = register['initial_amount'] + register['cash_sales'] - register['withdrawals']
        
        # Cerrar la caja
        query = """
            UPDATE cash_register
            SET status = 'closed',
                closing_date = ?,
                final_amount = ?,
                notes = ?
            WHERE id = ?
        """
        self.db.execute_update(query, (datetime.now().isoformat(), final_amount, notes, cash_register_id))
        
        # Obtener el reporte completo
        return self.get_closing_report(cash_register_id)
    
    def get_by_id(self, cash_register_id: int) -> Optional[Dict]:
        """Obtiene una caja por su ID"""
        query = "SELECT * FROM cash_register WHERE id = ?"
        result = self.db.execute_query(query, (cash_register_id,))
        return result[0] if result else None
    
    def add_withdrawal(self, cash_register_id: int, amount: float, reason: str = "") -> int:
        """Registra un retiro de caja"""
        # Insertar el retiro
        query = """
            INSERT INTO withdrawals (cash_register_id, amount, reason)
            VALUES (?, ?, ?)
        """
        withdrawal_id = self.db.execute_update(query, (cash_register_id, amount, reason))
        
        # Actualizar el total de retiros en la caja
        update_query = """
            UPDATE cash_register
            SET withdrawals = withdrawals + ?
            WHERE id = ?
        """
        self.db.execute_update(update_query, (amount, cash_register_id))
        
        return withdrawal_id
    
    def get_withdrawals(self, cash_register_id: int) -> List[Dict]:
        """Obtiene todos los retiros de una caja"""
        query = """
            SELECT * FROM withdrawals
            WHERE cash_register_id = ?
            ORDER BY created_at DESC
        """
        return self.db.execute_query(query, (cash_register_id,))
    
    def get_closing_report(self, cash_register_id: int) -> Dict:
        """Genera el reporte de cierre de caja"""
        register = self.get_by_id(cash_register_id)
        if not register:
            return {}
        
        # Contar ventas por tipo
        sales_count_query = """
            SELECT 
                COUNT(*) as total,
                payment_type
            FROM sales
            WHERE cash_register_id = ?
            GROUP BY payment_type
        """
        sales_counts = self.db.execute_query(sales_count_query, (cash_register_id,))
        
        num_cash_sales = 0
        num_transfer_sales = 0
        for sc in sales_counts:
            if sc['payment_type'] == 'cash':
                num_cash_sales = sc['total']
            elif sc['payment_type'] == 'transfer':
                num_transfer_sales = sc['total']
        
        # Obtener detalles de productos vendidos
        products_query = """
            SELECT 
                si.product_name,
                SUM(si.quantity) as total_quantity,
                SUM(si.subtotal) as total_amount
            FROM sale_items si
            JOIN sales s ON si.sale_id = s.id
            WHERE s.cash_register_id = ?
            GROUP BY si.product_name
            ORDER BY total_quantity DESC
        """
        products = self.db.execute_query(products_query, (cash_register_id,))
        
        # Obtener retiros
        withdrawals = self.get_withdrawals(cash_register_id)
        
        # Calcular diferencia
        expected_amount = register['initial_amount'] + register['cash_sales'] - register['withdrawals']
        
        return {
            'id': register['id'],
            'opening_date': register['opening_date'],
            'closing_date': register['closing_date'],
            'initial_amount': register['initial_amount'],
            'cash_sales': register['cash_sales'],
            'transfer_sales': register['transfer_sales'],
            'total_sales': register['total_sales'],
            'withdrawals': register['withdrawals'],
            'expected_amount': expected_amount,
            'final_amount': register.get('final_amount', expected_amount),
            'num_cash_sales': num_cash_sales,
            'num_transfer_sales': num_transfer_sales,
            'total_sales_count': num_cash_sales + num_transfer_sales,
            'products': products,
            'withdrawals_list': withdrawals,
            'notes': register.get('notes', '')
        }
    
    def get_all(self, status: str = None, limit: int = 50) -> List[Dict]:
        """Obtiene todas las cajas registradas"""
        query = "SELECT * FROM cash_register WHERE 1=1"
        params = []
        
        if status:
            query += " AND status = ?"
            params.append(status)
        
        query += " ORDER BY opening_date DESC LIMIT ?"
        params.append(limit)
        
        return self.db.execute_query(query, tuple(params))
    
    def get_cash_summary(self) -> Dict:
        """Obtiene resumen del efectivo actual"""
        current = self.get_current()
        if not current:
            return {
                'status': 'closed',
                'message': 'No hay caja abierta',
                'initial_amount': 0,
                'cash_sales': 0,
                'transfer_sales': 0,
                'withdrawals': 0,
                'cash_in_drawer': 0
            }
        
        cash_in_drawer = current['initial_amount'] + current['cash_sales'] - current['withdrawals']
        
        return {
            'status': 'open',
            'cash_register_id': current['id'],
            'opening_date': current['opening_date'],
            'initial_amount': current['initial_amount'],
            'cash_sales': current['cash_sales'],
            'transfer_sales': current['transfer_sales'],
            'total_sales': current['total_sales'],
            'withdrawals': current['withdrawals'],
            'cash_in_drawer': cash_in_drawer,
            'total_money': cash_in_drawer + current['transfer_sales']
        }
