import logging
from datetime import datetime
from typing import List, Dict, Optional
from pos_system.database.db_manager import DatabaseManager
from pos_system.utils.validators import (
    validate_product_name, validate_price, validate_stock, 
    validate_barcode, validate_category, sanitize_string, ValidationError
)

logger = logging.getLogger(__name__)


class Product:
    """Product model with validation and business logic"""
    
    def __init__(self, db_manager: DatabaseManager):
        self.db = db_manager
    
    def create(self, product_data: dict) -> int:
        """
        Create a new product with validation
        
        Args:
            product_data: Dictionary with product information
            
        Returns:
            Product ID
            
        Raises:
            ValidationError: If validation fails
        """
        name = sanitize_string(product_data.get('name', ''))
        is_valid, error = validate_product_name(name)
        if not is_valid:
            raise ValidationError(error)
        
        price = product_data.get('price', 0)
        is_valid, error = validate_price(price)
        if not is_valid:
            raise ValidationError(error)
        
        cost = product_data.get('cost', 0)
        is_valid, error = validate_price(cost, allow_zero=True)
        if not is_valid:
            raise ValidationError(error)
        
        stock = product_data.get('stock', 0)
        is_valid, error = validate_stock(stock)
        if not is_valid:
            raise ValidationError(error)
        
        barcode = sanitize_string(product_data.get('barcode', ''))
        is_valid, error = validate_barcode(barcode)
        if not is_valid:
            raise ValidationError(error)
        
        if barcode and self.get_by_barcode(barcode):
            raise ValidationError(f"Ya existe un producto con el código de barras '{barcode}'")
        
        category = sanitize_string(product_data.get('category', ''))
        is_valid, error = validate_category(category)
        if not is_valid:
            raise ValidationError(error)
        
        query = """
            INSERT INTO products (name, description, price, cost, stock, barcode, category, image_path, firebase_id, rubro, stock_min, stock_max)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """

        try:
            product_id = self.db.execute_update(query, (
                name,
                sanitize_string(product_data.get('description', ''), 500),
                price,
                cost,
                stock,
                barcode if barcode else None,
                category if category else None,
                product_data.get('image_path'),
                product_data.get('firebase_id') or None,
                product_data.get('rubro') or None,
                product_data.get('stock_min') or None,
                product_data.get('stock_max') or None,
            ))
            logger.info(f"Product created: {name} (ID: {product_id})")
            return product_id
        except Exception as e:
            logger.error(f"Failed to create product: {e}")
            raise
    
    def get_all(self, search: str = None, category: str = None, favorites_only: bool = False) -> List[Dict]:
        """Obtiene todos los productos con filtros opcionales"""
        # Excluir el producto sentinel "Varios" (id=0) del catálogo
        query = "SELECT * FROM products WHERE id != 0"
        params = []
        
        if search:
            query += " AND (name LIKE ? OR barcode LIKE ? OR description LIKE ? OR firebase_id LIKE ?)"
            search_term = f"%{search}%"
            params.extend([search_term, search_term, search_term, search_term])
        
        if category:
            query += " AND category = ?"
            params.append(category)
        
        if favorites_only:
            query += " AND is_favorite = 1"
        
        query += " ORDER BY name"
        return self.db.execute_query(query, tuple(params))
    
    def get_by_id(self, product_id: int) -> Optional[Dict]:
        """Obtiene un producto por su ID"""
        query = "SELECT * FROM products WHERE id = ?"
        result = self.db.execute_query(query, (product_id,))
        return result[0] if result else None
    
    def get_by_barcode(self, barcode: str) -> Optional[Dict]:
        """Obtiene un producto por su código de barras"""
        query = "SELECT * FROM products WHERE barcode = ?"
        result = self.db.execute_query(query, (barcode,))
        return result[0] if result else None
    
    def update(self, product_id: int, **kwargs) -> bool:
        """
        Update product with validation
        
        Args:
            product_id: Product ID to update
            **kwargs: Fields to update
            
        Returns:
            True if successful
            
        Raises:
            ValidationError: If validation fails
        """
        if 'name' in kwargs:
            name = sanitize_string(kwargs['name'])
            is_valid, error = validate_product_name(name)
            if not is_valid:
                raise ValidationError(error)
            kwargs['name'] = name
        
        if 'price' in kwargs:
            is_valid, error = validate_price(kwargs['price'])
            if not is_valid:
                raise ValidationError(error)
        
        if 'cost' in kwargs:
            is_valid, error = validate_price(kwargs['cost'], allow_zero=True)
            if not is_valid:
                raise ValidationError(error)
        
        if 'stock' in kwargs:
            is_valid, error = validate_stock(kwargs['stock'])
            if not is_valid:
                raise ValidationError(error)
        
        if 'barcode' in kwargs:
            barcode = sanitize_string(kwargs['barcode'])
            is_valid, error = validate_barcode(barcode)
            if not is_valid:
                raise ValidationError(error)
            
            if barcode:
                existing = self.get_by_barcode(barcode)
                if existing and existing['id'] != product_id:
                    raise ValidationError(f"El código de barras '{barcode}' ya está en uso")
            
            kwargs['barcode'] = barcode if barcode else None
        
        if 'category' in kwargs:
            category = sanitize_string(kwargs['category'])
            is_valid, error = validate_category(category)
            if not is_valid:
                raise ValidationError(error)
            kwargs['category'] = category if category else None
        
        if 'description' in kwargs:
            kwargs['description'] = sanitize_string(kwargs['description'], 500)
        
        allowed_fields = ['name', 'description', 'price', 'cost', 'stock', 'barcode', 'category', 'image_path', 'is_favorite', 'discount_type', 'discount_value', 'firebase_id', 'rubro', 'stock_min', 'stock_max']
        updates = []
        params = []
        
        for key, value in kwargs.items():
            if key in allowed_fields:
                updates.append(f"{key} = ?")
                params.append(value)
        
        if not updates:
            return False
        
        updates.append("updated_at = ?")
        params.append(datetime.now().isoformat())
        params.append(product_id)
        
        query = f"UPDATE products SET {', '.join(updates)} WHERE id = ?"
        
        try:
            self.db.execute_update(query, tuple(params))
            logger.info(f"Product updated: ID {product_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to update product {product_id}: {e}")
            raise
    
    def delete(self, product_id: int) -> bool:
        """Elimina un producto"""
        query = "DELETE FROM products WHERE id = ?"
        self.db.execute_update(query, (product_id,))
        return True
    
    def toggle_favorite(self, product_id: int) -> bool:
        """Marca o desmarca un producto como favorito"""
        product = self.get_by_id(product_id)
        if not product:
            return False
        
        new_status = 0 if product['is_favorite'] else 1
        return self.update(product_id, is_favorite=new_status)
    
    def get_favorites(self, search: str = None, category: str = None) -> List[Dict]:
        """Obtiene todos los productos favoritos"""
        return self.get_all(search=search, category=category, favorites_only=True)
    
    def update_stock(self, product_id: int, quantity_change: int) -> bool:
        """Actualiza el stock de un producto (puede ser positivo o negativo)"""
        query = "UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?"
        self.db.execute_update(query, (quantity_change, datetime.now().isoformat(), product_id))
        return True
    
    def get_categories(self) -> List[str]:
        """Obtiene todas las categorías únicas"""
        query = ("SELECT DISTINCT category FROM products "
                 "WHERE id != 0 AND category IS NOT NULL AND category != '' "
                 "  AND category != '__sistema__' ORDER BY category")
        results = self.db.execute_query(query)
        return [r['category'] for r in results]

    def get_low_stock(self, threshold: int = 5) -> List[Dict]:
        """Obtiene productos con stock bajo (excluye sentinel y servicios).

        - Productos clásicos: `stock <= COALESCE(stock_min, threshold)`.
        - Productos conjunto: el `stock` clásico no aplica, se compara el
          `conjunto_total` (o, si tiene colores, el TOTAL de cualquier color
          individual) contra el umbral. Esto captura "Rojo casi vacío"
          aunque otros colores estén cargados.
        """
        # 1) Productos clásicos (no conjunto)
        clasicos = self.db.execute_query(
            "SELECT * FROM products "
            "WHERE id != 0 AND stock >= 0 "
            "  AND COALESCE(es_conjunto, 0) = 0 "
            "  AND stock <= COALESCE(stock_min, ?) "
            "ORDER BY stock ASC, name ASC",
            (threshold,)
        ) or []

        # 2) Productos conjunto: filtrado en Python (tiene JSON y agregado)
        conjuntos = self.db.execute_query(
            "SELECT * FROM products "
            "WHERE id != 0 AND COALESCE(es_conjunto, 0) = 1 "
            "ORDER BY name ASC"
        ) or []

        bajos_conj = []
        for p in conjuntos:
            umbral = p.get('stock_min')
            try:
                umbral = float(umbral) if umbral not in (None, '') else float(threshold)
            except (TypeError, ValueError):
                umbral = float(threshold)

            colores_raw = p.get('conjunto_colores')
            color_bajo = False
            color_lista = []
            if colores_raw:
                try:
                    import json as _json
                    color_lista = _json.loads(colores_raw) if isinstance(colores_raw, str) else colores_raw
                except Exception:
                    color_lista = []
            contenido = float(p.get('conjunto_contenido') or 0)
            if isinstance(color_lista, list) and color_lista:
                # Marcar bajo si CUALQUIER color cae por debajo del umbral
                bajos_color_lista = []
                for c in color_lista:
                    if not isinstance(c, dict):
                        continue
                    t_color = float(c.get('unidades') or 0) * contenido + float(c.get('restante') or 0)
                    if t_color <= umbral:
                        color_bajo = True
                        bajos_color_lista.append({
                            'color': c.get('color', ''),
                            'total': t_color,
                        })
                if color_bajo:
                    p = dict(p)
                    p['_colores_bajos'] = bajos_color_lista
                    bajos_conj.append(p)
            else:
                # Sin colores: comparar agregado conjunto_total
                t_agg = float(p.get('conjunto_total') or 0)
                if t_agg <= umbral:
                    bajos_conj.append(p)

        return list(clasicos) + bajos_conj
