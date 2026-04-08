import sqlite3
import logging
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)


class DatabaseManager:
    """Database manager with connection pooling and transaction support"""
    
    def __init__(self, db_path: str = "pos_database.db"):
        self.db_path = Path(db_path)
        self._ensure_db_exists()
        
    def _ensure_db_exists(self):
        """Ensure database file and parent directories exist"""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        
    @contextmanager
    def get_connection(self):
        """Context manager for database connections"""
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        except Exception as e:
            conn.rollback()
            logger.error(f"Database error: {e}")
            raise
        finally:
            conn.close()
    
    def connect(self):
        """Legacy method for backward compatibility"""
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn
    
    def close(self):
        """Legacy method for backward compatibility"""
        pass
            
    def initialize_database(self):
        """Crea todas las tablas necesarias usando context manager para seguridad transaccional"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            
            # Tabla de usuarios
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    full_name TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'cajero',
                    is_active BOOLEAN DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_login TIMESTAMP
                )
            """)

            # Tabla de productos
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS products (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    description TEXT,
                    price REAL NOT NULL,
                    cost REAL DEFAULT 0,
                    stock INTEGER DEFAULT 0,
                    barcode TEXT UNIQUE,
                    category TEXT,
                    image_path TEXT,
                    is_favorite BOOLEAN DEFAULT 0,
                    discount_type TEXT DEFAULT NULL,
                    discount_value REAL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            # Migrar columnas de descuento si no existen (base de datos existente)
            try:
                cursor.execute("ALTER TABLE products ADD COLUMN discount_type TEXT DEFAULT NULL")
            except Exception:
                pass
            try:
                cursor.execute("ALTER TABLE products ADD COLUMN discount_value REAL DEFAULT 0")
            except Exception:
                pass
            try:
                cursor.execute("ALTER TABLE products ADD COLUMN firebase_id TEXT DEFAULT NULL")
            except Exception:
                pass
            try:
                cursor.execute("ALTER TABLE products ADD COLUMN rubro TEXT DEFAULT NULL")
            except Exception:
                pass
            # Índice para búsqueda rápida por firebase_id
            try:
                cursor.execute("CREATE INDEX IF NOT EXISTS idx_products_firebase_id ON products(firebase_id)")
            except Exception:
                pass
            
            # Tabla de ventas
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS sales (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    total_amount REAL NOT NULL,
                    payment_type TEXT NOT NULL,
                    cash_received REAL DEFAULT 0,
                    change_given REAL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    cash_register_id INTEGER,
                    user_id INTEGER,
                    notes TEXT
                )
            """)
            
            # Tabla de items de venta (detalle)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS sale_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sale_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    product_name TEXT NOT NULL,
                    quantity INTEGER NOT NULL,
                    unit_price REAL NOT NULL,
                    original_price REAL NOT NULL,
                    discount_type TEXT DEFAULT NULL,
                    discount_value REAL DEFAULT 0,
                    discount_amount REAL DEFAULT 0,
                    promo_id INTEGER DEFAULT NULL,
                    subtotal REAL NOT NULL,
                    FOREIGN KEY (sale_id) REFERENCES sales(id),
                    FOREIGN KEY (product_id) REFERENCES products(id)
                )
            """)
            # Migrar columnas de descuento en sale_items si no existen
            for col_def in [
                "ALTER TABLE sale_items ADD COLUMN original_price REAL DEFAULT 0",
                "ALTER TABLE sale_items ADD COLUMN discount_type TEXT DEFAULT NULL",
                "ALTER TABLE sale_items ADD COLUMN discount_value REAL DEFAULT 0",
                "ALTER TABLE sale_items ADD COLUMN discount_amount REAL DEFAULT 0",
                "ALTER TABLE sale_items ADD COLUMN promo_id INTEGER DEFAULT NULL",
            ]:
                try:
                    cursor.execute(col_def)
                except Exception:
                    pass

            # Tabla de ventas con descuento total
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS promotions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    promo_type TEXT NOT NULL,
                    description TEXT,
                    discount_value REAL DEFAULT 0,
                    required_quantity INTEGER DEFAULT 1,
                    free_quantity INTEGER DEFAULT 0,
                    is_active BOOLEAN DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS promotion_products (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    promotion_id INTEGER NOT NULL,
                    product_id INTEGER NOT NULL,
                    FOREIGN KEY (promotion_id) REFERENCES promotions(id) ON DELETE CASCADE,
                    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
                    UNIQUE(promotion_id, product_id)
                )
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_promotions_active ON promotions(is_active)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_promo_products ON promotion_products(promotion_id)")
            
            # Tabla de caja registradora
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS cash_register (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    opening_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    closing_date TIMESTAMP,
                    initial_amount REAL DEFAULT 0,
                    final_amount REAL DEFAULT 0,
                    cash_sales REAL DEFAULT 0,
                    transfer_sales REAL DEFAULT 0,
                    total_sales REAL DEFAULT 0,
                    withdrawals REAL DEFAULT 0,
                    status TEXT DEFAULT 'open',
                    notes TEXT,
                    opened_by_user_id INTEGER,
                    closed_by_user_id INTEGER
                )
            """)
            
            # Tabla de retiros de caja
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS withdrawals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    cash_register_id INTEGER NOT NULL,
                    amount REAL NOT NULL,
                    reason TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    user_id INTEGER,
                    FOREIGN KEY (cash_register_id) REFERENCES cash_register(id)
                )
            """)
            
            # Tabla de ajustes de stock
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS stock_adjustments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    product_id INTEGER NOT NULL,
                    quantity_change INTEGER NOT NULL,
                    reason TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    user_id INTEGER,
                    FOREIGN KEY (product_id) REFERENCES products(id)
                )
            """)
            
            # Tabla de configuración
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS config (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Tabla de rubros/categorías gestionables
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS categories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            # Insertar categorías por defecto si la tabla está vacía
            cursor.execute("SELECT COUNT(*) as cnt FROM categories")
            if cursor.fetchone()['cnt'] == 0:
                defaults = ['Librería', 'Mercería', 'Juguetería', 'Impresiones']
                for cat in defaults:
                    try:
                        cursor.execute("INSERT INTO categories (name) VALUES (?)", (cat,))
                    except Exception:
                        pass

            # Tabla de subcategorías: vincula rubros con las categorías de productos
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS sub_categories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    rubro TEXT NOT NULL,
                    name TEXT NOT NULL,
                    UNIQUE(rubro, name)
                )
            """)
            
            # Tabla de facturas electrónicas AFIP
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS facturas (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sale_id INTEGER,
                    tipo_comprobante TEXT NOT NULL DEFAULT 'FAC. ELEC. B',
                    punto_venta INTEGER DEFAULT 1,
                    nro_comprobante INTEGER,
                    fecha TEXT,
                    cliente TEXT DEFAULT 'CONSUMIDOR FINAL',
                    cuit_cliente TEXT DEFAULT '',
                    cae TEXT DEFAULT '',
                    vto_cae TEXT DEFAULT '',
                    total REAL NOT NULL DEFAULT 0,
                    iva_contenido REAL DEFAULT 0,
                    otros_impuestos REAL DEFAULT 0,
                    pdf_path TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (sale_id) REFERENCES sales(id)
                )
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_facturas_sale ON facturas(sale_id)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_facturas_fecha ON facturas(created_at)")

            # Índices para mejorar el rendimiento
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(created_at)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_sales_register ON sales(cash_register_id)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_products_favorite ON products(is_favorite)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_withdrawals_register ON withdrawals(cash_register_id)")
            
            logger.info("Database initialized successfully")
        
    def execute_query(self, query: str, params: tuple = ()) -> List[Dict]:
        """Execute a SELECT query and return results"""
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(query, params)
                rows = cursor.fetchall()
                return [dict(row) for row in rows]
        except sqlite3.Error as e:
            logger.error(f"Query execution failed: {query[:100]}... - Error: {e}")
            raise
    
    def execute_update(self, query: str, params: tuple = ()) -> int:
        """Execute INSERT/UPDATE/DELETE and return last row ID or affected rows"""
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(query, params)
                return cursor.lastrowid
        except sqlite3.Error as e:
            logger.error(f"Update execution failed: {query[:100]}... - Error: {e}")
            raise
    
    def execute_many(self, query: str, params_list: List[tuple]) -> int:
        """Execute multiple statements efficiently"""
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.executemany(query, params_list)
                return cursor.rowcount
        except sqlite3.Error as e:
            logger.error(f"Batch execution failed: {e}")
            raise
    
    def get_current_cash_register(self) -> Optional[Dict]:
        """Obtiene la caja actual abierta"""
        query = "SELECT * FROM cash_register WHERE status = 'open' ORDER BY opening_date DESC LIMIT 1"
        result = self.execute_query(query)
        return result[0] if result else None
    
    def backup_database(self, backup_path: str = None) -> Path:
        """Create a database backup"""
        import shutil
        from pos_system.config import DATABASE_BACKUP_DIR
        
        if not backup_path:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_path = DATABASE_BACKUP_DIR / f"pos_backup_{timestamp}.db"
        else:
            backup_path = Path(backup_path)
            
        backup_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(self.db_path, backup_path)
        logger.info(f"Database backed up to: {backup_path}")
        return backup_path
    
    def optimize_database(self):
        """Run VACUUM to optimize database"""
        try:
            with self.get_connection() as conn:
                conn.execute("VACUUM")
                conn.execute("ANALYZE")
            logger.info("Database optimized successfully")
        except sqlite3.Error as e:
            logger.error(f"Database optimization failed: {e}")
            raise

    # ── Gestión de Rubros/Categorías ──

    def get_all_categories(self) -> List[Dict]:
        """Retorna todas las categorías/rubros de la tabla categories"""
        return self.execute_query("SELECT * FROM categories ORDER BY name")

    def add_category(self, name: str) -> int:
        """Agrega una nueva categoría. Lanza excepción si ya existe."""
        return self.execute_update(
            "INSERT INTO categories (name) VALUES (?)", (name.strip(),)
        )

    def delete_category(self, category_id: int) -> bool:
        """Elimina una categoría y pone en NULL la categoría de los productos que la tenían."""
        # Obtener el nombre antes de borrar
        result = self.execute_query("SELECT name FROM categories WHERE id = ?", (category_id,))
        if not result:
            return False
        name = result[0]['name']
        # Desvincular productos
        self.execute_update("UPDATE products SET category = NULL WHERE category = ?", (name,))
        # Eliminar categoría
        self.execute_update("DELETE FROM categories WHERE id = ?", (category_id,))
        return True

    def rename_category(self, category_id: int, new_name: str) -> bool:
        """Renombra una categoría y actualiza los productos que la usaban."""
        result = self.execute_query("SELECT name FROM categories WHERE id = ?", (category_id,))
        if not result:
            return False
        old_name = result[0]['name']
        new_name = new_name.strip()
        self.execute_update("UPDATE categories SET name = ? WHERE id = ?", (new_name, category_id))
        self.execute_update("UPDATE products SET category = ? WHERE category = ?", (new_name, old_name))
        # Actualizar también en sub_categories
        self.execute_update("UPDATE sub_categories SET rubro_name = ? WHERE rubro_name = ?", (new_name, old_name))
        return True

    # ── Gestión de Subcategorías ──

    def get_subcategories(self, rubro_name: str) -> List[str]:
        """Retorna las subcategorías de un rubro."""
        results = self.execute_query(
            "SELECT sub_name FROM sub_categories WHERE rubro_name = ? ORDER BY sub_name",
            (rubro_name,)
        )
        return [r['sub_name'] for r in results]

    def add_subcategory(self, rubro_name: str, sub_name: str) -> bool:
        """Agrega una subcategoría a un rubro."""
        try:
            self.execute_update(
                "INSERT OR IGNORE INTO sub_categories (rubro_name, sub_name) VALUES (?, ?)",
                (rubro_name, sub_name.strip())
            )
            return True
        except Exception:
            return False

    def remove_subcategory(self, rubro_name: str, sub_name: str) -> bool:
        """Elimina una subcategoría de un rubro."""
        self.execute_update(
            "DELETE FROM sub_categories WHERE rubro_name = ? AND sub_name = ?",
            (rubro_name, sub_name)
        )
        return True

    def sync_rubros_from_firebase(self, rubros: list):
        """
        Sincroniza la lista de rubros desde Firebase.
        IMPORTANTE: Solo inserta entradas que vienen del documento de rubros de Firebase
        (colección 'rubros'), NO categorías de productos. Agrega los nuevos, no borra los existentes.
        Los rubros de Firebase son objetos con campo 'nombre' o strings directos.
        """
        for rubro in rubros:
            # Rubros de Firebase pueden ser dicts con campo 'nombre' o strings
            if isinstance(rubro, dict):
                name = str(rubro.get('nombre') or rubro.get('name') or '').strip().upper()
            else:
                name = str(rubro).strip().upper()
            # Filtro de seguridad: los rubros son palabras cortas (max 30 chars)
            # y no contienen números ni caracteres raros
            if not name or len(name) > 30:
                continue
            # Solo insertar si no existe ya (INSERT OR IGNORE)
            try:
                self.execute_update("INSERT OR IGNORE INTO categories (name) VALUES (?)", (name,))
            except Exception:
                pass
