import sqlite3
import logging
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)


class DatabaseManager:
    """Database manager with connection pooling and transaction support"""
    
    def __init__(self, db_path: str = None):
        if db_path is None:
            from pos_system.config import DATABASE_PATH
            db_path = str(DATABASE_PATH)
        self.db_path = Path(db_path)
        self._ensure_db_exists()
        
    def _ensure_db_exists(self):
        """Ensure database file and parent directories exist"""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        
    def _setup_connection(self, conn):
        """Configura la conexión SQLite con timezone local y otras opciones."""
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
        # Registrar función para hora de Argentina (UTC-3), reemplaza CURRENT_TIMESTAMP que usa UTC
        from datetime import datetime as _dt, timezone as _tz, timedelta as _td
        _TZ_AR = _tz(_td(hours=-3))
        conn.create_function("localtime_now", 0, lambda: _dt.now(_TZ_AR).strftime("%Y-%m-%d %H:%M:%S"))
        # norm_text: normaliza texto para búsqueda insensible a tildes y mayúsculas.
        # Descompone en NFD (separa letra base + diacrítico), descarta los diacríticos
        # con encode ASCII ignore, luego pasa a minúsculas.
        # Ej: norm_text('Repuésto') → 'repuesto'
        import unicodedata as _ud
        def _norm_text(s):
            if not s:
                return ''
            s = _ud.normalize('NFD', str(s))
            return s.encode('ascii', 'ignore').decode('ascii').lower()
        conn.create_function("norm_text", 1, _norm_text)

        # levenshtein: distancia de edición entre dos strings (tolerancia a typos).
        # Usada como último fallback en búsqueda cuando AND/OR no devuelven nada.
        def _levenshtein(a, b):
            if a is None or b is None:
                return 999
            a, b = str(a), str(b)
            if a == b:
                return 0
            la, lb = len(a), len(b)
            if la == 0:
                return lb
            if lb == 0:
                return la
            # Cap para evitar costo en strings muy largos
            if abs(la - lb) > 4:
                return abs(la - lb)
            prev = list(range(lb + 1))
            for i, ca in enumerate(a, 1):
                curr = [i]
                for j, cb in enumerate(b, 1):
                    ins = curr[j - 1] + 1
                    dele = prev[j] + 1
                    sub = prev[j - 1] + (ca != cb)
                    curr.append(min(ins, dele, sub))
                prev = curr
            return prev[lb]
        conn.create_function("levenshtein", 2, _levenshtein)

    @contextmanager
    def get_connection(self):
        """Context manager for database connections"""
        conn = sqlite3.connect(str(self.db_path))
        self._setup_connection(conn)
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
        self._setup_connection(conn)
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
                    created_at TIMESTAMP DEFAULT (localtime_now()),
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
                    created_at TIMESTAMP DEFAULT (localtime_now()),
                    updated_at TIMESTAMP DEFAULT (localtime_now())
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
            # Alertas de stock personalizables por producto (item 7)
            try:
                cursor.execute("ALTER TABLE products ADD COLUMN stock_min INTEGER DEFAULT NULL")
            except Exception:
                pass
            try:
                cursor.execute("ALTER TABLE products ADD COLUMN stock_max INTEGER DEFAULT NULL")
            except Exception:
                pass
            # Producto Conjunto (rollo/pack/caja/etc con stock fraccionado)
            for col_def in [
                "ALTER TABLE products ADD COLUMN es_conjunto INTEGER DEFAULT 0",
                "ALTER TABLE products ADD COLUMN conjunto_tipo TEXT DEFAULT NULL",
                "ALTER TABLE products ADD COLUMN conjunto_unidad_medida TEXT DEFAULT NULL",
                "ALTER TABLE products ADD COLUMN conjunto_unidades REAL DEFAULT NULL",
                "ALTER TABLE products ADD COLUMN conjunto_contenido REAL DEFAULT NULL",
                "ALTER TABLE products ADD COLUMN conjunto_restante REAL DEFAULT NULL",
                "ALTER TABLE products ADD COLUMN conjunto_precio_unidad REAL DEFAULT NULL",
                "ALTER TABLE products ADD COLUMN conjunto_total REAL DEFAULT NULL",
                # Stock por color (JSON: [{"color":"Rojo","unidades":5,"restante":35.5}, ...])
                "ALTER TABLE products ADD COLUMN conjunto_colores TEXT DEFAULT NULL",
            ]:
                try:
                    cursor.execute(col_def)
                except Exception:
                    pass
            # Índice para búsqueda rápida por firebase_id
            try:
                cursor.execute("CREATE INDEX IF NOT EXISTS idx_products_firebase_id ON products(firebase_id)")
            except Exception:
                pass

            # Producto sentinel para items "Varios" (product_id=0, stock ilimitado,
            # categoría "__sistema__" — no se muestra en el catálogo)
            try:
                cursor.execute("""
                    INSERT OR IGNORE INTO products
                        (id, name, price, stock, category, is_favorite)
                    VALUES (0, 'Varios', 0, -1, '__sistema__', 0)
                """)
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
                    created_at TIMESTAMP DEFAULT (localtime_now()),
                    cash_register_id INTEGER,
                    user_id INTEGER,
                    notes TEXT,
                    turno_nombre TEXT DEFAULT ''
                )
            """)
            # Migrar turno_nombre si no existe (bases de datos existentes)
            try:
                cursor.execute("ALTER TABLE sales ADD COLUMN turno_nombre TEXT DEFAULT ''")
            except Exception:
                pass
            # Migrar transfer_amount: parte de transferencia en pagos mixtos
            # (cash_received guarda el efectivo, transfer_amount la transferencia,
            #  total_amount = cash_received + transfer_amount cuando payment_type='mixed').
            try:
                cursor.execute("ALTER TABLE sales ADD COLUMN transfer_amount REAL DEFAULT 0")
            except Exception:
                pass
            
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
                # Color del producto conjunto vendido (para historial / reportes)
                "ALTER TABLE sale_items ADD COLUMN conjunto_color TEXT DEFAULT NULL",
            ]:
                try:
                    cursor.execute(col_def)
                except Exception:
                    pass

            # Migrar perfiles_facturacion si ya existe sin columnas nuevas
            for col_def in [
                "ALTER TABLE perfiles_facturacion ADD COLUMN firebase_id TEXT DEFAULT ''",
                "ALTER TABLE perfiles_facturacion ADD COLUMN razon_social TEXT DEFAULT ''",
                "ALTER TABLE perfiles_facturacion ADD COLUMN domicilio TEXT DEFAULT ''",
                "ALTER TABLE perfiles_facturacion ADD COLUMN localidad TEXT DEFAULT ''",
                "ALTER TABLE perfiles_facturacion ADD COLUMN telefono TEXT DEFAULT ''",
                "ALTER TABLE perfiles_facturacion ADD COLUMN ing_brutos TEXT DEFAULT ''",
                "ALTER TABLE perfiles_facturacion ADD COLUMN inicio_actividades TEXT DEFAULT ''",
                "ALTER TABLE perfiles_facturacion ADD COLUMN punto_venta INTEGER DEFAULT 1",
                "ALTER TABLE perfiles_facturacion ADD COLUMN cert_path TEXT DEFAULT ''",
                "ALTER TABLE perfiles_facturacion ADD COLUMN key_path TEXT DEFAULT ''",
                "ALTER TABLE perfiles_facturacion ADD COLUMN produccion INTEGER DEFAULT 1",
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
                    created_at TIMESTAMP DEFAULT (localtime_now()),
                    updated_at TIMESTAMP DEFAULT (localtime_now())
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
                    opening_date TIMESTAMP DEFAULT (localtime_now()),
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
                    created_at TIMESTAMP DEFAULT (localtime_now()),
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
                    created_at TIMESTAMP DEFAULT (localtime_now()),
                    user_id INTEGER,
                    FOREIGN KEY (product_id) REFERENCES products(id)
                )
            """)
            
            # Tabla de configuración
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS config (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT (localtime_now())
                )
            """)

            # Tabla de rubros/categorías gestionables
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS categories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    created_at TIMESTAMP DEFAULT (localtime_now())
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
                    created_at TIMESTAMP DEFAULT (localtime_now()),
                    FOREIGN KEY (sale_id) REFERENCES sales(id)
                )
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_facturas_sale ON facturas(sale_id)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_facturas_fecha ON facturas(created_at)")
            # Marca facturas emitidas por items "Varios 2" (no afectan caja/historial/ventas)
            try:
                cursor.execute("ALTER TABLE facturas ADD COLUMN es_varios_2 INTEGER DEFAULT 0")
            except Exception:
                pass
            # Migración Nota de Crédito: vínculo a comprobante asociado.
            # Cuando este registro es una NC, estos campos referencian la factura
            # original que la NC está anulando (total o parcialmente).
            try:
                cursor.execute("ALTER TABLE facturas ADD COLUMN cbte_asoc_tipo TEXT DEFAULT ''")
            except Exception:
                pass
            try:
                cursor.execute("ALTER TABLE facturas ADD COLUMN cbte_asoc_pv INTEGER DEFAULT 0")
            except Exception:
                pass
            try:
                cursor.execute("ALTER TABLE facturas ADD COLUMN cbte_asoc_nro INTEGER DEFAULT 0")
            except Exception:
                pass
            try:
                cursor.execute("ALTER TABLE facturas ADD COLUMN motivo_nc TEXT DEFAULT ''")
            except Exception:
                pass

            # Tabla de perfiles de facturación ARCA (emisores / dueños)
            # Cada perfil es una persona/entidad con su propio CUIT y cuenta ARCA
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS perfiles_facturacion (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    firebase_id TEXT UNIQUE DEFAULT '',
                    nombre TEXT NOT NULL,
                    cuit TEXT NOT NULL DEFAULT '',
                    razon_social TEXT DEFAULT '',
                    domicilio TEXT DEFAULT '',
                    localidad TEXT DEFAULT '',
                    telefono TEXT DEFAULT '',
                    condicion_iva TEXT NOT NULL DEFAULT 'Monotributista',
                    ing_brutos TEXT DEFAULT '',
                    inicio_actividades TEXT DEFAULT '',
                    punto_venta INTEGER DEFAULT 1,
                    cert_path TEXT DEFAULT '',
                    key_path TEXT DEFAULT '',
                    produccion INTEGER DEFAULT 1,
                    activo INTEGER NOT NULL DEFAULT 1,
                    created_at TIMESTAMP DEFAULT (localtime_now()),
                    updated_at TIMESTAMP DEFAULT (localtime_now())
                )
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_perfiles_activo ON perfiles_facturacion(activo)")

            # Tabla de clientes para facturación
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS clientes_facturacion (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    firebase_id TEXT UNIQUE DEFAULT '',
                    nombre TEXT NOT NULL,
                    razon_social TEXT DEFAULT '',
                    cuit TEXT DEFAULT '',
                    domicilio TEXT DEFAULT '',
                    localidad TEXT DEFAULT '',
                    condicion_iva TEXT DEFAULT 'Consumidor Final',
                    activo INTEGER NOT NULL DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_clientes_activo ON clientes_facturacion(activo)")

            # Migración: convertir firebase_id='' a NULL en clientes/productos/observations.
            # SQLite UNIQUE permite múltiples NULL pero solo un ''. Si dejamos '' como
            # default, la 2da inserción sin firebase_id rompe.
            for _tbl in ('clientes_facturacion', 'products', 'observations'):
                try:
                    cursor.execute(
                        f"UPDATE {_tbl} SET firebase_id = NULL WHERE firebase_id = ''"
                    )
                except Exception:
                    pass

            # Tabla de observaciones (notas compartidas entre cajeros)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS observations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    firebase_id TEXT UNIQUE DEFAULT '',
                    text TEXT NOT NULL,
                    context TEXT NOT NULL DEFAULT 'general',
                    sale_id INTEGER DEFAULT NULL,
                    sale_item_id INTEGER DEFAULT NULL,
                    created_by_id INTEGER DEFAULT NULL,
                    created_by_name TEXT DEFAULT '',
                    pc_id TEXT DEFAULT '',
                    created_at TIMESTAMP DEFAULT (localtime_now()),
                    deleted INTEGER NOT NULL DEFAULT 0
                )
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_observations_context ON observations(context)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_observations_sale ON observations(sale_id)")

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

    # -- Gestión de Rubros/Categorías --

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

    # -- Gestión de Subcategorías --

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
        """Elimina una subcategoria de un rubro."""
        self.execute_update(
            "DELETE FROM sub_categories WHERE rubro_name = ? AND sub_name = ?",
            (rubro_name, sub_name)
        )
        return True

    def cleanup_duplicate_products(self) -> dict:
        """Detecta y limpia productos duplicados en la BD local.

        IMPORTANTE: solo actúa sobre rows que tienen el MISMO nombre que otro
        (case-insensitive, sin espacios extras). Productos con nombre único,
        independientemente de su stock, NUNCA se tocan.

        El sobreviviente entre duplicados se elige por prioridades:
          1. es_conjunto = 1  (un rollo/conjunto manda sobre la copia normal)
          2. firebase_id seteado (el sincronizado con la web)
          3. updated_at más reciente
          4. id más alto

        Si el sobreviviente es un row anterior marcado [DUPLICADO] (de un
        cleanup pasado equivocado), se le restaura el nombre original.

        Para los demás:
          a. Si NO tienen ventas asociadas → DELETE limpio.
          b. Si TIENEN ventas → soft-delete (stock=0, firebase_id=NULL,
             name='[DUPLICADO] {name}').

        Devuelve: {'grupos': N, 'borrados': N, 'soft_deleted': N, 'restaurados': N}
        """
        import logging
        log = logging.getLogger(__name__)
        result = {'grupos': 0, 'borrados': 0, 'soft_deleted': 0, 'restaurados': 0}
        try:
            grupos = self.execute_query(
                "SELECT TRIM(LOWER(REPLACE(name, '[DUPLICADO] ', ''))) as norm_name, "
                "       COUNT(*) as cnt "
                "FROM products "
                "WHERE name IS NOT NULL AND TRIM(name) != '' "
                "GROUP BY norm_name HAVING cnt > 1"
            ) or []
            if not grupos:
                return result
            result['grupos'] = len(grupos)

            for g in grupos:
                norm = g['norm_name']
                rows = self.execute_query(
                    "SELECT id, name, firebase_id, stock, updated_at, "
                    "       COALESCE(es_conjunto, 0) as es_conjunto, "
                    "       COALESCE(LENGTH(COALESCE(firebase_id,'')),0) as fb_len "
                    "FROM products "
                    "WHERE TRIM(LOWER(REPLACE(name, '[DUPLICADO] ', ''))) = ? "
                    # Prioridades: conjunto > sincronizado con Firebase > más reciente.
                    # NO usamos stock como criterio: hay productos sin stock
                    # legítimos (servicios, agotados, etc.) y no queremos
                    # discriminarlos.
                    "ORDER BY es_conjunto DESC, "
                    "         fb_len DESC, "
                    "         updated_at DESC, "
                    "         id DESC",
                    (norm,)
                ) or []
                if len(rows) <= 1:
                    continue
                survivor = rows[0]
                losers = rows[1:]

                # Restaurar nombre del sobreviviente si está marcado [DUPLICADO]
                if str(survivor.get('name', '')).startswith('[DUPLICADO]'):
                    try:
                        nuevo_nombre = str(survivor['name']).replace('[DUPLICADO] ', '', 1)
                        self.execute_update(
                            "UPDATE products SET name = ?, "
                            "updated_at = (SELECT localtime_now()) WHERE id = ?",
                            (nuevo_nombre, survivor['id'])
                        )
                        result['restaurados'] += 1
                        log.info(f"Cleanup: restaurado nombre #{survivor['id']} ({nuevo_nombre})")
                    except Exception as e:
                        log.warning(f"Cleanup: error restaurando #{survivor['id']}: {e}")

                for loser in losers:
                    lid = loser['id']
                    sales_ref = self.execute_query(
                        "SELECT 1 FROM sale_items WHERE product_id = ? LIMIT 1",
                        (lid,)
                    ) or []
                    if sales_ref:
                        try:
                            base_name = str(loser['name']).replace('[DUPLICADO] ', '', 1)
                            self.execute_update(
                                "UPDATE products SET stock = 0, firebase_id = NULL, "
                                "name = '[DUPLICADO] ' || ?, updated_at = (SELECT localtime_now()) "
                                "WHERE id = ?",
                                (base_name, lid)
                            )
                            result['soft_deleted'] += 1
                            log.info(f"Cleanup: soft-deleted duplicado #{lid} ({survivor['name']})")
                        except Exception as e:
                            log.warning(f"Cleanup: error soft-deleting #{lid}: {e}")
                    else:
                        try:
                            self.execute_update("DELETE FROM products WHERE id = ?", (lid,))
                            result['borrados'] += 1
                            log.info(f"Cleanup: borrado duplicado #{lid} ({survivor['name']})")
                        except Exception as e:
                            log.warning(f"Cleanup: error borrando #{lid}: {e}")

            if result['borrados'] or result['soft_deleted'] or result['restaurados']:
                log.info(
                    f"Cleanup duplicados: {result['grupos']} grupos detectados, "
                    f"{result['borrados']} borrados, {result['soft_deleted']} soft-deleted, "
                    f"{result['restaurados']} sobrevivientes restaurados."
                )
        except Exception as e:
            log.error(f"cleanup_duplicate_products falló: {e}")
        return result

    def sync_rubros_from_firebase(self, rubros: list):
        """
        Sincroniza la lista de rubros desde Firebase.
        IMPORTANTE: Solo inserta entradas que vienen del documento de rubros de Firebase
        (coleccion 'rubros'), NO categorias de productos. Agrega los nuevos, no borra los existentes.
 Los rubros de Firebase son objetos con campo 'nombre' o strings directos.
        """
        for rubro in rubros:
            if isinstance(rubro, dict):
                name = str(rubro.get('nombre') or rubro.get('name') or '').strip().upper()
            else:
                name = str(rubro).strip().upper()
            if not name or len(name) > 30:
                continue
            try:
                self.execute_update("INSERT OR IGNORE INTO categories (name) VALUES (?)", (name,))
            except Exception:
                pass
