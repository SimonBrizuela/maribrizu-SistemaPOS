"""
Firebase Firestore Sync para Sistema POS.
Sube ventas, inventario, cierres de caja, historial diario y
productos más vendidos a Firestore en tiempo real.
También escucha cambios en tiempo real desde la web (inventario).
"""

import threading
import logging
import socket as _socket
import re as _re
import uuid as _uuid
from datetime import datetime, timezone, timedelta
from typing import Optional, Callable

# Timezone Argentina (UTC-3, sin DST)
_TZ_AR = timezone(timedelta(hours=-3))

# Cache en memoria para no releer el archivo en cada llamada
_PC_ID_CACHE: Optional[str] = None

def _get_pc_id() -> str:
    """Identificador estable y único de la PC actual.

    Se genera una vez combinando un UUID v4 aleatorio con el MAC address
    y se persiste en DATA_DIR/machine_id.txt. Cada PC tiene su propio
    archivo → IDs garantizados únicos aunque compartan hostname.
    """
    global _PC_ID_CACHE
    if _PC_ID_CACHE:
        return _PC_ID_CACHE

    try:
        from pos_system.config import DATA_DIR
        id_file = DATA_DIR / "machine_id.txt"

        if id_file.exists():
            stored = id_file.read_text(encoding='utf-8').strip()
            if stored:
                _PC_ID_CACHE = stored
                return _PC_ID_CACHE

        # Generar ID nuevo: primeros 8 chars del UUID4 + hostname truncado
        # El UUID4 garantiza unicidad; el hostname ayuda a identificar visualmente
        random_part = _uuid.uuid4().hex[:8]
        try:
            host_raw = _socket.gethostname()
            host_part = _re.sub(r'[^a-zA-Z0-9]', '', host_raw)[:8].upper()
        except Exception:
            host_part = 'PC'

        new_id = f"{host_part}-{random_part}" if host_part else random_part
        id_file.write_text(new_id, encoding='utf-8')
        _PC_ID_CACHE = new_id
        return _PC_ID_CACHE

    except Exception:
        # Fallback sin archivo: hostname saneado (mejor que 'PC' fijo)
        try:
            raw = _socket.gethostname()
            return _re.sub(r'[^a-zA-Z0-9\-]', '_', raw)[:20].strip('_') or 'PC'
        except Exception:
            return 'PC'

def now_ar() -> datetime:
    """Retorna la hora actual con timezone Argentina."""
    return datetime.now(_TZ_AR)

def now_ar_iso() -> str:
    """Retorna la hora actual en ISO format con timezone Argentina (-03:00)."""
    return datetime.now(_TZ_AR).isoformat()

logger = logging.getLogger(__name__)

# ── Singleton ──
_sync_instance: Optional["FirebaseSync"] = None

def get_firebase_sync() -> Optional["FirebaseSync"]:
    return _sync_instance

def init_firebase_sync() -> Optional["FirebaseSync"]:
    global _sync_instance
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
        import os

        # Verificar si ya está inicializado
        try:
            firebase_admin.get_app()
        except ValueError:
            # Buscar service account key en varias ubicaciones
            import sys
            exe_dir = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else os.path.join(os.path.dirname(__file__), '..', '..')
            candidates = [
                os.path.join(exe_dir, 'firebase_key.json'),
                os.path.join(exe_dir, '_internal', 'firebase_key.json'),
                os.path.join(os.path.dirname(__file__), '..', '..', 'firebase_key.json'),
                'firebase_key.json',
            ]
            key_path = None
            for c in candidates:
                if os.path.exists(c):
                    key_path = c
                    break
            if key_path:
                cred = credentials.Certificate(key_path)
                firebase_admin.initialize_app(cred)
                logger.info("Firebase: Inicializado con service account key.")
            else:
                logger.warning("Firebase: No se encontró firebase_key.json. Sync desactivado.")
                return None

        db = firestore.client()
        _sync_instance = FirebaseSync(db)
        logger.info("Firebase: Sync inicializado correctamente.")
        return _sync_instance

    except ImportError:
        logger.warning("Firebase: firebase-admin no instalado. Ejecutar: pip install firebase-admin")
        return None
    except Exception as e:
        logger.error(f"Firebase: Error inicializando: {e}")
        return None


class FirebaseSync:
    def __init__(self, db):
        self.db = db
        self.enabled = True
        self._listeners = []          # watchers activos de Firestore
        self._on_inventory_change: Optional[Callable] = None   # callback para el POS

    # ── Listener en tiempo real ──
    def start_inventory_listener(self, on_change: Callable):
        """
        Escucha cambios en la colección 'inventario' de Firestore en tiempo real.
        Llama a on_change(products: list) cada vez que hay una actualización desde la web.
        Esto permite que el POS se actualice automáticamente cuando la web modifica productos.
        """
        if not self.enabled:
            return
        self._on_inventory_change = on_change

        def _watch(col_snapshot, changes, read_time):
            try:
                products = []
                for doc in col_snapshot:
                    d = doc.to_dict()
                    if d:
                        products.append(d)
                logger.info(f"Firebase: inventario actualizado en tiempo real ({len(products)} productos).")
                if self._on_inventory_change:
                    self._on_inventory_change(products)
            except Exception as e:
                logger.error(f"Firebase: error en listener de inventario: {e}")

        try:
            col_ref = self.db.collection('inventario')
            watcher = col_ref.on_snapshot(_watch)
            self._listeners.append(watcher)
            logger.info("Firebase: Listener de inventario en tiempo real activado.")
        except Exception as e:
            logger.error(f"Firebase: No se pudo iniciar listener de inventario: {e}")

    def start_products_remote_listener(self, on_change: Callable):
        """
        Escucha la colección 'productos_remotos' donde la web puede crear/modificar
        productos. El POS aplica los cambios a la BD local automáticamente.
        on_change(action: str, product_data: dict)
        """
        if not self.enabled:
            return

        def _watch(col_snapshot, changes, read_time):
            try:
                from google.cloud.firestore_v1.watch import ChangeType
                for change in changes:
                    doc_data = change.document.to_dict() or {}
                    action = 'added' if change.type == ChangeType.ADDED else \
                             'modified' if change.type == ChangeType.MODIFIED else 'removed'
                    on_change(action, doc_data)
            except Exception as e:
                logger.error(f"Firebase: error en listener de productos remotos: {e}")

        try:
            col_ref = self.db.collection('productos_remotos')
            watcher = col_ref.on_snapshot(_watch)
            self._listeners.append(watcher)
            logger.info("Firebase: Listener de productos remotos activado.")
        except Exception as e:
            logger.error(f"Firebase: No se pudo iniciar listener de productos remotos: {e}")

    def start_rubros_listener(self, on_change):
        """
        Escucha la colección 'rubros' de Firestore en tiempo real.
        Llama a on_change(rubros: list[str]) cuando hay cambios.
        """
        if not self.enabled:
            return

        def _watch(col_snapshot, changes, read_time):
            try:
                rubros = []
                for doc in col_snapshot:
                    d = doc.to_dict() or {}
                    name = str(d.get('nombre') or d.get('name') or doc.id or '').strip()
                    if name:
                        rubros.append(name)
                rubros.sort()
                logger.info(f"Firebase: rubros actualizados ({len(rubros)}).")
                on_change(rubros)
            except Exception as e:
                logger.error(f"Firebase: error en listener de rubros: {e}")

        try:
            col_ref = self.db.collection('rubros')
            watcher = col_ref.on_snapshot(_watch)
            self._listeners.append(watcher)
            logger.info("Firebase: Listener de rubros activado.")
        except Exception as e:
            logger.error(f"Firebase: No se pudo iniciar listener de rubros: {e}")

    def start_promotions_listener(self, on_change: Callable):
        """
        Escucha la colección 'promociones' de Firestore en tiempo real.
        Llama a on_change(promociones: list) cada vez que hay un cambio desde la web.
        Esto permite que el POS aplique automáticamente las promociones definidas en la web.
        """
        if not self.enabled:
            return

        def _watch(col_snapshot, changes, read_time):
            try:
                promociones = []
                for doc in col_snapshot:
                    d = doc.to_dict()
                    if d:
                        d['_id'] = doc.id
                        promociones.append(d)
                logger.info(f"Firebase: promociones actualizadas en tiempo real ({len(promociones)} promos).")
                on_change(promociones)
            except Exception as e:
                logger.error(f"Firebase: error en listener de promociones: {e}")

        try:
            col_ref = self.db.collection('promociones')
            watcher = col_ref.on_snapshot(_watch)
            self._listeners.append(watcher)
            logger.info("Firebase: Listener de promociones en tiempo real activado.")
        except Exception as e:
            logger.error(f"Firebase: No se pudo iniciar listener de promociones: {e}")

    def download_promociones(self) -> list:
        """Descarga todas las promociones activas desde Firestore (para carga inicial)."""
        if not self.enabled:
            return []
        try:
            col = self.db.collection('promociones')
            docs = list(col.stream())
            result = []
            for d in docs:
                data = d.to_dict() or {}
                if data:
                    data['_id'] = d.id
                    result.append(data)
            logger.info(f"Firebase: Descargadas {len(result)} promociones.")
            return result
        except Exception as e:
            logger.error(f"Firebase: Error descargando promociones: {e}")
            return []

    def stop_all_listeners(self):
        """Detiene todos los listeners activos."""
        for watcher in self._listeners:
            try:
                watcher.unsubscribe()
            except Exception:
                pass
        self._listeners.clear()
        logger.info("Firebase: Todos los listeners detenidos.")

    # ── Helpers ──
    def _run(self, fn):
        """Ejecuta en hilo de fondo para no bloquear UI."""
        t = threading.Thread(target=fn, daemon=True)
        t.start()

    def _parse_dt(self, val):
        if isinstance(val, datetime):
            dt = val
        elif not val:
            return now_ar()
        else:
            s = str(val)
            dt = None
            try:
                dt = datetime.fromisoformat(s)
            except ValueError:
                pass
            if dt is None:
                for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M:%S.%f', '%Y-%m-%dT%H:%M:%S', '%d/%m/%Y %H:%M'):
                    try:
                        dt = datetime.strptime(s, fmt)
                        break
                    except ValueError:
                        pass
            if dt is None:
                return now_ar()
        # Asegurarse de que el datetime tenga timezone AR para que Firestore lo guarde como UTC correcto
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_TZ_AR)
        else:
            dt = dt.astimezone(_TZ_AR)
        return dt

    def _to_ar_str(self, val) -> str:
        """Convierte un valor de fecha a string AR para guardar en SQLite."""
        dt = self._parse_dt(val)
        # astimezone(_TZ_AR) ya garantiza hora local AR; strftime sin tzinfo para SQLite
        return dt.astimezone(_TZ_AR).strftime('%Y-%m-%d %H:%M:%S')

    # ══════════════════════════════════════════════════
    #  VENTAS
    # ══════════════════════════════════════════════════
    def sync_sale(self, sale: dict):
        """Sube/actualiza una venta en Firestore."""
        if not self.enabled:
            return
        def _do():
            try:
                sale_id = str(sale.get('id') or sale.get('sale_id', ''))
                if not sale_id:
                    return
                created_at = self._parse_dt(sale.get('created_at'))
                items = sale.get('items') or []
                # Armar resumen de productos para mostrar en la web
                productos_str = ', '.join(
                    f"{it.get('product_name', it.get('name','?'))} x{it.get('quantity',1)}"
                    for it in items[:3]
                )
                if len(items) > 3:
                    productos_str += f' (+{len(items)-3} más)'

                # cajero: preferir turno_nombre (quien atiende), fallback a username
                cajero = (
                    sale.get('turno_nombre')
                    or sale.get('cajero')
                    or sale.get('username')
                    or str(sale.get('user_id', ''))
                )
                pc_id  = _get_pc_id()
                fb_doc_id = f"{pc_id}_{sale_id}"   # único por PC → no pisan ventas de otras PCs
                doc = {
                    'sale_id':       int(sale_id),
                    'pc_id':         pc_id,
                    'created_at':    created_at,
                    'payment_type':  sale.get('payment_type', ''),
                    'total_amount':  float(sale.get('total_amount', 0) or 0),
                    'cash_received': float(sale.get('cash_received', 0) or 0),
                    'change_given':  float(sale.get('change_given', 0) or 0),
                    'items_count':   len(items) if items else int(sale.get('items_count', 0) or 0),
                    'productos':     productos_str,
                    'username':      cajero,
                    'cajero':        cajero,
                    'discount':      float(sale.get('discount', 0) or 0),
                }
                self.db.collection('ventas').document(fb_doc_id).set(doc, merge=True)
                logger.debug(f"Firebase: Venta #{sale_id} ({pc_id}) sincronizada.")
            except Exception as e:
                logger.error(f"Firebase: Error sincronizando venta: {e}")
        self._run(_do)

    # ══════════════════════════════════════════════════
    #  INVENTARIO
    # ══════════════════════════════════════════════════
    def sync_inventory(self, products: list):
        """Sube el inventario completo a Firestore, eliminando productos que ya no existen."""
        if not self.enabled:
            return
        def _do():
            try:
                col = self.db.collection('inventario')
                product_ids = set()

                # 1. Subir/actualizar todos los productos actuales en batches de 500
                batch = self.db.batch()
                count = 0
                for p in products:
                    pid = str(p.get('id', ''))
                    if not pid:
                        continue
                    product_ids.add(pid)
                    ref = col.document(pid)
                    batch.set(ref, {
                        'id':                  int(pid),
                        'nombre':              p.get('name') or p.get('nombre', ''),
                        'categoria':           p.get('category') or p.get('categoria', 'Sin categoría'),
                        'precio':              float(p.get('price') or p.get('precio', 0) or 0),
                        'costo':               float(p.get('cost') or p.get('costo', 0) or 0),
                        'stock':               int(p.get('stock', 0) or 0),
                        'descuento':           float(p.get('discount') or p.get('descuento', 0) or 0),
                        'ultima_actualizacion': str(p.get('updated_at') or p.get('ultima_actualizacion', '')),
                    })
                    count += 1
                    if count % 500 == 0:
                        batch.commit()
                        batch = self.db.batch()
                batch.commit()

                # 2. Eliminar documentos en Firebase que ya no existen en la DB local
                existing_docs = col.stream()
                delete_batch = self.db.batch()
                deleted = 0
                for doc in existing_docs:
                    if doc.id not in product_ids:
                        delete_batch.delete(doc.reference)
                        deleted += 1
                        if deleted % 500 == 0:
                            delete_batch.commit()
                            delete_batch = self.db.batch()
                if deleted % 500 != 0:
                    delete_batch.commit()

                # 3. Escribir metadato de sync para que otras PCs detecten cambios
                try:
                    self.db.collection('config').document('inventario_meta').set({
                        'last_updated': now_ar().strftime('%Y-%m-%dT%H:%M:%S'),
                        'count': len(products),
                    })
                except Exception:
                    pass

                logger.info(f"Firebase: Inventario sincronizado ({len(products)} productos, {deleted} eliminados).")
            except Exception as e:
                logger.error(f"Firebase: Error sincronizando inventario: {e}")
        self._run(_do)

    def delta_sync_products_startup(self, local_db, on_done=None):
        """
        Al arrancar el POS, detecta en segundo plano si hay productos nuevos o
        modificados en Firebase y aplica solo los cambios a la BD local.

        Estrategia optimizada:
          1. Lee config/inventario_meta (1 lectura) para saber si hay cambios.
          2. Si no hay cambios → termina sin leer más.
          3. Si hay cambios → descarga inventario completo, compara updated_at
             y hace upsert solo de los productos que difieren.

        local_db : DatabaseManager (SQLite)
        on_done  : callable(n_updated: int) — se llama al terminar (en hilo bg)
        """
        if not self.enabled:
            if on_done:
                on_done(0)
            return

        def _do():
            n_updated = 0
            try:
                from pos_system.config import DATA_DIR
                sync_file = DATA_DIR / "last_product_sync.txt"

                # 1. Timestamp del último delta sync local
                last_local_ts = ""
                if sync_file.exists():
                    last_local_ts = sync_file.read_text(encoding="utf-8").strip()

                # 2. Consultar metadato (1 sola lectura Firestore)
                meta_doc = self.db.collection('config').document('catalogo_meta').get()
                if not meta_doc.exists:
                    logger.debug("Delta sync: sin doc catalogo_meta — omitiendo.")
                    if on_done:
                        on_done(0)
                    return

                meta = meta_doc.to_dict() or {}
                firebase_ts = str(meta.get('last_updated', '') or '')

                if firebase_ts and firebase_ts <= last_local_ts:
                    logger.info(f"Delta sync: inventario al día ({firebase_ts}).")
                    if on_done:
                        on_done(0)
                    return

                logger.info(f"Delta sync: cambios detectados (Firebase: {firebase_ts}, local: {last_local_ts})")

                # 3. Descargar colección completa de catálogo
                docs = list(self.db.collection('catalogo').stream())
                if not docs:
                    if on_done:
                        on_done(0)
                    return

                # 4. Mapa local: firebase_id → (local_id, updated_at)
                rows = local_db.execute_query(
                    "SELECT id, firebase_id, updated_at FROM products"
                ) or []
                local_by_firebase_id = {}
                for r in rows:
                    if r.get('firebase_id'):
                        local_by_firebase_id[str(r['firebase_id'])] = (r['id'], r.get('updated_at') or '')

                # 5. Aplicar solo diffs
                for doc in docs:
                    d = doc.to_dict() or {}
                    firebase_id = doc.id
                    nombre = str(d.get('nombre') or d.get('name') or '').strip()
                    if not nombre:
                        continue

                    estado = str(d.get('estado') or 'activo').lower()
                    precio = float(d.get('precio_venta') or d.get('precio') or d.get('price') or 0)
                    if precio <= 0 or estado == 'sin_precio':
                        continue

                    fb_ts  = str(d.get('ultima_actualizacion', '') or '')
                    costo  = float(d.get('costo') or d.get('cost') or 0)
                    stock  = int(d.get('stock') or 0)
                    categ  = str(d.get('categoria') or d.get('category') or '').strip() or 'Sin categoría'
                    rubro  = str(d.get('rubro') or '').strip() or None
                    barcode = str(d.get('cod_barra') or d.get('barcode') or '').strip() or None
                    desc   = float(d.get('descuento') or 0)

                    entry = local_by_firebase_id.get(firebase_id)

                    if entry is None:
                        # Producto nuevo
                        try:
                            local_db.execute_update(
                                """INSERT OR IGNORE INTO products
                                   (name, category, price, cost, stock, barcode,
                                    discount_value, firebase_id, rubro,
                                    created_at, updated_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)""",
                                (nombre, categ, precio, costo, stock, barcode,
                                 desc, firebase_id, rubro, fb_ts)
                            )
                            n_updated += 1
                        except Exception as e:
                            logger.warning(f"Delta sync: error INSERT {firebase_id}: {e}")

                    else:
                        local_id, local_ts = entry
                        if fb_ts and fb_ts != local_ts:
                            # Producto modificado
                            try:
                                local_db.execute_update(
                                    """UPDATE products
                                       SET name=?, category=?, price=?, cost=?, stock=?,
                                           barcode=?, discount_value=?, rubro=?, updated_at=?
                                       WHERE id=?""",
                                    (nombre, categ, precio, costo, stock,
                                     barcode, desc, rubro, fb_ts, local_id)
                                )
                                n_updated += 1
                            except Exception as e:
                                logger.warning(f"Delta sync: error UPDATE {firebase_id}: {e}")

                # 6. Guardar timestamp del sync exitoso
                now_str = now_ar().strftime('%Y-%m-%dT%H:%M:%S')
                sync_file.write_text(now_str, encoding="utf-8")
                logger.info(f"Delta sync: {n_updated} productos actualizados.")

            except Exception as e:
                logger.error(f"Delta sync productos: error inesperado: {e}")

            if on_done:
                on_done(n_updated)

        threading.Thread(target=_do, daemon=True).start()

    def delete_product(self, product_id):
        """Elimina un producto del inventario en Firestore inmediatamente."""
        if not self.enabled:
            return
        def _do():
            try:
                pid = str(product_id)
                self.db.collection('inventario').document(pid).delete()
                logger.info(f"Firebase: Producto #{pid} eliminado de inventario.")
            except Exception as e:
                logger.error(f"Firebase: Error eliminando producto #{product_id}: {e}")
        self._run(_do)

    # ══════════════════════════════════════════════════
    #  HISTORIAL DIARIO
    # ══════════════════════════════════════════════════
    def sync_daily_summary(self, sales: list, date: datetime = None):
        """Sube el resumen del día a Firestore (upsert por fecha)."""
        if not self.enabled:
            return
        def _do():
            try:
                if date is None:
                    _date = now_ar()
                else:
                    _date = date
                total        = sum(float(s.get('total_amount', 0) or 0) for s in sales)
                efectivo     = sum(float(s.get('total_amount', 0) or 0) for s in sales if s.get('payment_type') == 'cash')
                transferencia = total - efectivo
                n            = len(sales)
                promedio     = total / n if n > 0 else 0
                fecha_str    = _date.strftime('%d/%m/%Y')
                # ID compuesto fecha+PC → cada PC mantiene su propio resumen sin pisarse
                doc_id       = f"{_date.strftime('%Y-%m-%d')}_{_get_pc_id()}"

                self.db.collection('historial_diario').document(doc_id).set({
                    'fecha':           fecha_str,
                    'mes':             _month_name(_date),
                    'num_ventas':      n,
                    'total':           total,
                    'efectivo':        efectivo,
                    'transferencia':   transferencia,
                    'ticket_promedio': promedio,
                    'fecha_dt':        _date,
                }, merge=True)
                logger.debug(f"Firebase: Historial diario {fecha_str} sincronizado.")
            except Exception as e:
                logger.error(f"Firebase: Error sincronizando historial diario: {e}")
        self._run(_do)

    # ══════════════════════════════════════════════════
    #  PRODUCTOS MÁS VENDIDOS
    # ══════════════════════════════════════════════════
    def sync_top_products(self, db_manager):
        """Consulta la DB local y sube el ranking a Firestore."""
        if not self.enabled:
            return
        def _do():
            try:
                rows = db_manager.execute_query("""
                    SELECT
                        si.product_name,
                        COALESCE(p.category, 'Sin categoría') as category,
                        SUM(si.quantity)  as total_vendido,
                        SUM(si.subtotal)  as ingresos,
                        MAX(s.created_at) as ultima_venta,
                        si.product_id
                    FROM sale_items si
                    JOIN sales s ON si.sale_id = s.id
                    LEFT JOIN products p ON si.product_id = p.id
                    GROUP BY si.product_id, si.product_name
                    ORDER BY total_vendido DESC
                """)
                batch = self.db.batch()
                col = self.db.collection('productos_mas_vendidos')
                for r in (rows or []):
                    pid = str(r.get('product_id') or r.get('product_name', 'unknown'))
                    ref = col.document(pid)
                    ultima = self._parse_dt(r.get('ultima_venta'))
                    batch.set(ref, {
                        'nombre':        r.get('product_name', '?'),
                        'categoria':     r.get('category') or 'Sin categoría',
                        'total_vendido': int(r.get('total_vendido') or 0),
                        'ingresos':      float(r.get('ingresos') or 0),
                        'ultima_venta':  ultima.strftime('%d/%m/%Y %H:%M'),
                    }, merge=True)
                batch.commit()
                logger.info(f"Firebase: Ranking de {len(rows or [])} productos sincronizado.")
            except Exception as e:
                logger.error(f"Firebase: Error sincronizando ranking: {e}")
        self._run(_do)

    # ══════════════════════════════════════════════════
    #  VENTAS POR DÍA (detalle por producto)
    # ══════════════════════════════════════════════════
    def sync_sale_detail_by_day(self, sale: dict, db_manager=None):
        """Sube el detalle de items de una venta a Firestore."""
        if not self.enabled:
            return
        def _do():
            try:
                sale_id    = sale.get('id')
                created_at = self._parse_dt(sale.get('created_at'))
                tipo_pago  = 'Efectivo' if sale.get('payment_type') == 'cash' else 'Transferencia'
                cajero     = (
                    sale.get('turno_nombre')
                    or sale.get('cajero')
                    or sale.get('username')
                    or str(sale.get('user_id', ''))
                )
                items      = sale.get('items') or []

                if not items and db_manager and sale_id:
                    items = db_manager.execute_query("""
                        SELECT si.product_name, si.quantity, si.unit_price, si.subtotal,
                               COALESCE(p.category, 'Sin categoría') as category,
                               COALESCE(si.original_price, si.unit_price) as original_price,
                               COALESCE(si.discount_type, '') as discount_type,
                               COALESCE(si.discount_value, 0) as discount_value,
                               COALESCE(si.discount_amount, 0) as discount_amount,
                               COALESCE(si.promo_id, '') as promo_id
                        FROM sale_items si
                        LEFT JOIN products p ON si.product_id = p.id
                        WHERE si.sale_id = ?
                    """, (sale_id,)) or []

                batch = self.db.batch()
                col = self.db.collection('ventas_por_dia')
                pc_id = _get_pc_id()
                for idx, item in enumerate(items):
                    doc_id = f"{pc_id}_{sale_id}_{idx}"
                    ref = col.document(doc_id)
                    batch.set(ref, {
                        'fecha':          created_at.strftime('%d/%m/%Y'),
                        'hora':           created_at.strftime('%H:%M:%S'),
                        'num_venta':      sale_id,
                        'producto':       item.get('product_name') or item.get('name', '?'),
                        'categoria':      item.get('category') or 'Sin categoría',
                        'cantidad':       int(item.get('quantity', 1)),
                        'precio_unitario':float(item.get('unit_price', 0) or 0),
                        'subtotal':       float(item.get('subtotal', 0) or 0),
                        'tipo_pago':      tipo_pago,
                        'cajero':         cajero,
                        'fecha_dt':       created_at,
                        'descuento_tipo':   item.get('discount_type') or '',
                        'descuento_valor':  float(item.get('discount_value', 0) or 0),
                        'descuento_monto':  float(item.get('discount_amount', 0) or 0),
                        'precio_original':  float(item.get('original_price', 0) or item.get('unit_price', 0) or 0),
                    }, merge=True)
                batch.commit()
                logger.debug(f"Firebase: Detalle de venta #{sale_id} ({len(items)} items) sincronizado.")
            except Exception as e:
                logger.error(f"Firebase: Error sincronizando detalle de venta: {e}")
        self._run(_do)

    # ══════════════════════════════════════════════════
    #  RESUMEN MENSUAL
    # ══════════════════════════════════════════════════
    def sync_monthly_summary(self, year: int, month: int, sales: list, db_manager=None):
        """Genera y sube el resumen mensual a Firestore."""
        if not self.enabled:
            return
        def _do():
            try:
                from datetime import datetime
                months = ['enero','febrero','marzo','abril','mayo','junio',
                          'julio','agosto','septiembre','octubre','noviembre','diciembre']
                month_name = f"{months[month-1]} {year}"
                doc_id = f"{year}-{month:02d}_{_get_pc_id()}"
                
                total = sum(float(s.get('total_amount', 0) or 0) for s in sales)
                efectivo = sum(float(s.get('total_amount', 0) or 0) for s in sales if s.get('payment_type') == 'cash')
                transferencia = total - efectivo
                descuentos = sum(float(s.get('discount', 0) or 0) for s in sales)
                n = len(sales)
                promedio = total / n if n > 0 else 0
                
                # Agrupar por producto
                productos = {}
                for s in sales:
                    for item in (s.get('items') or []):
                        name = item.get('product_name') or item.get('name', '?')
                        if name not in productos:
                            productos[name] = {'cantidad': 0, 'total': 0.0}
                        productos[name]['cantidad'] += int(item.get('quantity', 1))
                        productos[name]['total'] += float(item.get('subtotal', 0) or 0)
                top_productos = sorted(productos.items(), key=lambda x: x[1]['total'], reverse=True)[:10]
                top_lista = [{'producto': k, 'cantidad': v['cantidad'], 'total': v['total']} for k, v in top_productos]
                
                self.db.collection('resumenes_mensuales').document(doc_id).set({
                    'anio': year,
                    'mes_num': month,
                    'mes_nombre': month_name,
                    'pc_id': _get_pc_id(),
                    'num_ventas': n,
                    'total': total,
                    'efectivo': efectivo,
                    'transferencia': transferencia,
                    'descuentos_total': descuentos,
                    'ticket_promedio': promedio,
                    'top_productos': top_lista,
                    'actualizado': now_ar(),
                }, merge=True)
                logger.debug(f"Firebase: Resumen mensual {month_name} sincronizado.")
            except Exception as e:
                logger.error(f"Firebase: Error sincronizando resumen mensual: {e}")
        self._run(_do)

    # ══════════════════════════════════════════════════
    #  CIERRES DE CAJA
    # ══════════════════════════════════════════════════
    def sync_cash_closing(self, report: dict, session_id: str = None):
        """Sube un cierre de caja a Firestore con productos y retiros."""
        if not self.enabled:
            return
        def _do():
            try:
                register_id = str(report.get('register_id') or report.get('id', ''))
                if not register_id:
                    return
                apertura = self._parse_dt(report.get('opening_date') or report.get('open_time') or report.get('fecha_apertura'))
                cierre   = self._parse_dt(report.get('closing_date') or report.get('close_time') or report.get('fecha_cierre'))

                efectivo     = float(report.get('cash_sales') or report.get('total_efectivo', 0) or 0)
                transferencia= float(report.get('transfer_sales') or report.get('total_transferencia', 0) or 0)
                retiros      = float(report.get('withdrawals') or report.get('total_retiros', 0) or 0)
                inicial      = float(report.get('initial_amount') or report.get('monto_inicial', 0) or 0)
                esperado     = float(report.get('expected_amount') or (inicial + efectivo - retiros))
                final_amt    = float(report.get('final_amount') or report.get('monto_final', 0) or 0)
                num_cash     = int(report.get('num_cash_sales') or 0)
                num_transf   = int(report.get('num_transfer_sales') or 0)

                # Productos vendidos
                productos_lista = []
                for p in (report.get('products') or []):
                    productos_lista.append({
                        'product_name': p.get('product_name') or p.get('nombre', '-'),
                        'total_quantity': int(p.get('total_quantity') or p.get('cantidad', 0)),
                        'total_amount':   float(p.get('total_amount') or p.get('total', 0) or 0),
                    })

                # Retiros
                retiros_lista = []
                for w in (report.get('withdrawals_list') or []):
                    retiros_lista.append({
                        'amount':     float(w.get('amount') or w.get('monto', 0) or 0),
                        'reason':     w.get('reason') or w.get('motivo', ''),
                        'created_at': w.get('created_at', ''),
                    })

                pc_id = _get_pc_id()
                fb_doc_id = f"{pc_id}_{register_id}"
                _session_id = session_id or report.get('session_id') or now_ar().strftime('%Y-%m-%d')
                self.db.collection('cierres_caja').document(fb_doc_id).set({
                    'register_id':           int(register_id),
                    'pc_id':                 pc_id,
                    'session_id':            _session_id,
                    'fecha_apertura':        apertura,
                    'fecha_cierre':          cierre,
                    'total_ventas':          efectivo + transferencia,
                    'total_efectivo':        efectivo,
                    'total_transferencia':   transferencia,
                    'total_retiros':         retiros,
                    'total_transacciones':   num_cash + num_transf,
                    'num_ventas_efectivo':   num_cash,
                    'num_ventas_transferencia': num_transf,
                    'cajero':                report.get('username') or report.get('cajero', ''),
                    'monto_inicial':         inicial,
                    'monto_esperado':        esperado,
                    'monto_final':           final_amt,
                    'productos_vendidos':    productos_lista,
                    'retiros':               retiros_lista,
                }, merge=True)
                logger.debug(f"Firebase: Cierre #{register_id} sincronizado con {len(productos_lista)} productos.")
            except Exception as e:
                logger.error(f"Firebase: Error sincronizando cierre: {e}")
        self._run(_do)


    # ══════════════════════════════════════════════════
    #  DESCARGA DESDE FIREBASE → LOCAL
    # ══════════════════════════════════════════════════
    def download_products(self, progress_cb=None) -> list:
        """
        Descarga todos los productos/inventario desde Firebase.
        progress_cb(current, total, message) se llama en cada paso.
        Retorna lista de productos como dicts.
        """
        if not self.enabled:
            return []
        try:
            col = self.db.collection('inventario')
            docs = list(col.stream())
            total = len(docs)
            products = []
            for i, doc in enumerate(docs):
                d = doc.to_dict() or {}
                if d:
                    products.append(d)
                if progress_cb and (i % 20 == 0 or i == total - 1):
                    progress_cb(i + 1, total, f'Descargando producto {i+1}/{total}...')
            logger.info(f"Firebase: Descargados {len(products)} productos del inventario.")
            return products
        except Exception as e:
            logger.error(f"Firebase: Error descargando inventario: {e}")
            return []

    def download_rubros(self, progress_cb=None) -> list:
        """
        Descarga todos los rubros/categorías desde Firebase.
        Retorna lista de nombres de rubros.
        """
        if not self.enabled:
            return []
        try:
            col = self.db.collection('rubros')
            docs = list(col.stream())
            rubros = []
            for doc in docs:
                d = doc.to_dict() or {}
                name = str(d.get('nombre') or d.get('name') or doc.id or '').strip()
                if name:
                    rubros.append(name)
            rubros.sort()
            if progress_cb:
                progress_cb(len(rubros), len(rubros), f'{len(rubros)} rubros descargados')
            logger.info(f"Firebase: Descargados {len(rubros)} rubros.")
            return rubros
        except Exception as e:
            logger.error(f"Firebase: Error descargando rubros: {e}")
            return []

    def download_precios_actualizados(self, progress_cb=None, since_epoch=0.0) -> list:
        """
        Descarga la colección 'productos_remotos' (precios y datos actualizados desde la web).
        Si since_epoch > 0, solo descarga docs modificados desde esa fecha (delta sync).
        Retorna lista de dicts con datos actualizados.
        """
        if not self.enabled:
            return []
        try:
            col = self.db.collection('productos_remotos')
            if since_epoch > 0:
                import datetime
                last_dt = datetime.datetime.fromtimestamp(since_epoch, tz=datetime.timezone.utc)
                try:
                    docs = list(col.where('ultima_actualizacion', '>=', last_dt).stream())
                except Exception:
                    docs = list(col.stream())
            else:
                docs = list(col.stream())
            total = len(docs)
            productos = []
            for i, doc in enumerate(docs):
                d = doc.to_dict() or {}
                if d:
                    d['_doc_id'] = doc.id
                    productos.append(d)
                if progress_cb and (i % 10 == 0 or i == total - 1):
                    progress_cb(i + 1, max(total, 1),
                                f'Descargando precio actualizado {i+1}/{total}...')
            logger.info(f"Firebase: Descargados {len(productos)} productos remotos.")
            return productos
        except Exception as e:
            logger.error(f"Firebase: Error descargando productos remotos: {e}")
            return []

    def get_coleccion_count(self, coleccion: str) -> int:
        """Retorna la cantidad de documentos en una colección (para mostrar progreso real)."""
        try:
            return len(list(self.db.collection(coleccion).stream()))
        except Exception:
            return 0


    # ══════════════════════════════════════════════════
    #  SINCRONIZACIÓN DE USUARIOS/CAJEROS
    # ══════════════════════════════════════════════════

    def sync_users(self, db_manager):
        """
        Sube todos los usuarios/cajeros activos a Firestore (colección 'cajeros').
        Los usuarios inactivos se eliminan de Firebase para que no reaparezcan en otras PCs.
        NO sube password_hash por seguridad.
        """
        if not self.enabled:
            return
        def _do():
            try:
                users = db_manager.execute_query(
                    "SELECT id, username, full_name, role, is_active FROM users ORDER BY id"
                )
                col = self.db.collection('cajeros')
                for u in users:
                    doc_id = str(u['username'])
                    if u['is_active']:
                        col.document(doc_id).set({
                            'username':   u['username'],
                            'full_name':  u['full_name'],
                            'role':       u['role'],
                            'is_active':  True,
                            'updated_at': now_ar_iso(),
                        })
                    else:
                        # Eliminar de Firebase para que no reaparezca en otras PCs
                        try:
                            col.document(doc_id).delete()
                        except Exception:
                            pass
                logger.info(f"Firebase: usuarios sincronizados a 'cajeros'.")
            except Exception as e:
                logger.error(f"Firebase: Error sincronizando usuarios: {e}")
        self._run(_do)

    def delete_user_from_firebase(self, username: str):
        """Elimina un cajero de Firebase inmediatamente al ser borrado/desactivado."""
        if not self.enabled:
            return
        def _do():
            try:
                self.db.collection('cajeros').document(str(username)).delete()
                logger.info(f"Firebase: cajero '{username}' eliminado de Firestore.")
            except Exception as e:
                logger.error(f"Firebase: Error eliminando cajero '{username}': {e}")
        self._run(_do)

    def download_users(self, db_manager) -> int:
        """
        Descarga los cajeros desde Firestore y los crea/actualiza en la DB local.
        Las contraseñas de usuarios nuevos se establecen igual al username (el admin puede cambiarla).
        Retorna cantidad de usuarios sincronizados.
        """
        if not self.enabled:
            return 0
        try:
            from pos_system.models.user import User, _hash_password
            user_model = User(db_manager)
            docs = list(self.db.collection('cajeros').stream())
            count = 0
            for doc in docs:
                d = doc.to_dict() or {}
                username  = str(d.get('username') or '').strip().lower()
                full_name = str(d.get('full_name') or username).strip()
                role      = str(d.get('role') or 'cajero').strip()
                is_active = bool(d.get('is_active', True))
                if not username:
                    continue
                existing = user_model.get_by_username(username)
                if existing:
                    # Actualizar nombre, rol y estado
                    db_manager.execute_update(
                        "UPDATE users SET full_name=?, role=?, is_active=? WHERE username=?",
                        (full_name, role, 1 if is_active else 0, username)
                    )
                else:
                    # No crear usuarios inactivos que vienen de Firebase
                    if not is_active:
                        continue
                    # Crear con contraseña = username (temporal)
                    try:
                        db_manager.execute_update(
                            "INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?,?,?,?,?)",
                            (username, _hash_password(username), full_name, role, 1)
                        )
                        logger.info(f"Firebase: Usuario '{username}' creado localmente (pass=username).")
                    except Exception:
                        pass
                count += 1
            logger.info(f"Firebase: {count} cajeros sincronizados desde Firestore.")
            return count
        except Exception as e:
            logger.error(f"Firebase: Error descargando cajeros: {e}")
            return 0

    # ══════════════════════════════════════════════════
    #  CAJA COMPARTIDA
    # ══════════════════════════════════════════════════

    def sync_open_register(self, cash_register: dict):
        """
        Sube la caja abierta a Firestore:
          - 'caja_activa/current': para sincronización entre PCs
          - 'cierres_caja/{pc}_{id}': para que la webapp muestre "Caja Abierta"
        """
        if not self.enabled:
            return
        def _do():
            try:
                register_id  = cash_register.get('id')
                opening_date = self._parse_dt(cash_register.get('opening_date', now_ar_iso()))
                inicial      = float(cash_register.get('initial_amount') or 0)
                cajero       = cash_register.get('cajero') or cash_register.get('notes', '')
                pc_id        = _get_pc_id()

                # 1. Actualizar caja_activa/current (usado por otras PCs)
                self.db.collection('caja_activa').document('current').set({
                    'id':             register_id,
                    'initial_amount': inicial,
                    'opening_date':   opening_date,
                    'notes':          cash_register.get('notes', ''),
                    'status':         'open',
                    'updated_at':     now_ar_iso(),
                })

                # 2. Crear/actualizar doc en cierres_caja SIN fecha_cierre
                #    → la webapp lo detecta como "caja abierta"
                #    Al cerrar, sync_cash_closing sobreescribe este mismo doc con fecha_cierre
                fb_doc_id = f"{pc_id}_{register_id}"
                self.db.collection('cierres_caja').document(fb_doc_id).set({
                    'register_id':             int(register_id) if register_id else 0,
                    'pc_id':                   pc_id,
                    'session_id':              now_ar().strftime('%Y-%m-%d'),
                    'fecha_apertura':          opening_date,
                    'fecha_cierre':            '',          # vacío = caja abierta
                    'cajero':                  cajero,
                    'monto_inicial':           inicial,
                    'total_ventas':            0,
                    'total_efectivo':          0,
                    'total_transferencia':     0,
                    'total_retiros':           0,
                    'total_transacciones':     0,
                    'num_ventas_efectivo':     0,
                    'num_ventas_transferencia':0,
                    'monto_esperado':          inicial,
                    'monto_final':             0,
                    'productos_vendidos':      [],
                    'retiros':                 [],
                })
                logger.info(f"Firebase: Caja #{register_id} abierta → caja_activa + cierres_caja actualizados.")
            except Exception as e:
                logger.error(f"Firebase: Error subiendo apertura de caja: {e}")
        self._run(_do)

    def sync_close_register(self, session_id: str = None):
        """
        Marca la caja activa como cerrada en Firestore.
        Llamar cuando el admin cierra la caja.
        """
        if not self.enabled:
            return
        _sid = session_id or now_ar().strftime('%Y-%m-%d')
        def _do():
            try:
                self.db.collection('caja_activa').document('current').set({
                    'status':     'closed',
                    'session_id': _sid,
                    'updated_at': now_ar_iso(),
                }, merge=True)
                logger.info("Firebase: Caja marcada como cerrada.")
            except Exception as e:
                logger.error(f"Firebase: Error cerrando caja en Firebase: {e}")
        self._run(_do)

    def write_sync_trigger(self, pc_id: str = None, command: str = 'upload'):
        """
        Escribe un trigger en Firebase para que todas las PCs ejecuten command.
        command: 'upload' → cada PC sube sus datos | 'download' → cada PC descarga
        """
        if not self.enabled:
            return
        _pc = pc_id or _get_pc_id()
        def _do():
            try:
                self.db.collection('config').document('sync_trigger').set({
                    'timestamp': now_ar_iso(),
                    'pc_id':     _pc,
                    'command':   command,
                })
                logger.info(f"Firebase: sync_trigger '{command}' escrito por {_pc}")
            except Exception as e:
                logger.error(f"Firebase: Error escribiendo sync_trigger: {e}")
        self._run(_do)

    def read_sync_trigger(self) -> Optional[dict]:
        """Lee el último trigger de sync. Retorna {'timestamp': str, 'pc_id': str} o None."""
        if not self.enabled:
            return None
        try:
            doc = self.db.collection('config').document('sync_trigger').get()
            if doc.exists:
                return doc.to_dict()
        except Exception as e:
            logger.debug(f"Firebase: Error leyendo sync_trigger: {e}")
        return None

    def get_active_register(self) -> Optional[dict]:
        """
        Descarga la caja activa desde Firestore.
        Retorna el dict con id, initial_amount, opening_date, status o None.
        """
        if not self.enabled:
            return None
        try:
            doc = self.db.collection('caja_activa').document('current').get()
            if doc.exists:
                data = doc.to_dict()
                if data.get('status') == 'open':
                    return data
            return None
        except Exception as e:
            logger.error(f"Firebase: Error descargando caja activa: {e}")
            return None

    def _create_local_register_from_data(self, db_manager, data: dict) -> Optional[int]:
        """
        Crea o verifica la caja local usando datos ya disponibles (snapshot o dict de Firebase).
        Evita un read extra a Firestore. Retorna el id local, o None si falla.
        """
        try:
            remote_id = data.get('id')
            if not remote_id:
                return None

            # Normalizar fecha para SQLite (puede venir como Timestamp de Firestore o string)
            opening_date_str = self._to_ar_str(data.get('opening_date', now_ar_iso()))
            initial  = float(data.get('initial_amount') or 0)
            notes    = data.get('notes', '') or ''

            # Verificar si ya existe (en cualquier estado) para evitar INSERT OR REPLACE
            # que haría DELETE + INSERT violando FK si hay ventas referenciando el registro
            existing = db_manager.execute_query(
                "SELECT id, status FROM cash_register WHERE id = ?", (remote_id,)
            )
            if existing:
                row = existing[0]
                if row['status'] == 'open':
                    logger.info(f"Firebase: Caja #{remote_id} ya está abierta localmente.")
                    return remote_id
                # Existe pero cerrada → solo actualizar estado, sin tocar las ventas asociadas
                db_manager.execute_update(
                    "UPDATE cash_register SET status='open', initial_amount=?, opening_date=?, notes=? WHERE id=?",
                    (initial, opening_date_str, notes, remote_id)
                )
                logger.info(f"Firebase: Caja #{remote_id} actualizada a 'open' localmente.")
            else:
                # No existe → insertar nueva (sin OR REPLACE para no violar FK)
                db_manager.execute_update(
                    "INSERT INTO cash_register (id, initial_amount, opening_date, status, notes) VALUES (?, ?, ?, 'open', ?)",
                    (remote_id, initial, opening_date_str, notes)
                )
                logger.info(f"Firebase: Caja #{remote_id} creada localmente (desde snapshot).")
            return remote_id
        except Exception as e:
            logger.error(f"Firebase: Error creando caja local desde datos: {e}")
            return None

    def ensure_local_register(self, db_manager) -> Optional[int]:
        """
        Descarga la caja activa de Firebase y la crea/reutiliza en la DB local.
        Retorna el ID de la caja local, o None si no hay caja activa en Firebase.
        """
        if not self.enabled:
            return None
        try:
            remote = self.get_active_register()
            if not remote:
                return None
            return self._create_local_register_from_data(db_manager, remote)
        except Exception as e:
            logger.error(f"Firebase: Error en ensure_local_register: {e}")
            return None

    def sync_factura(self, factura: dict) -> None:
        """Sube una factura emitida desde el POS a Firestore (colección 'facturas')."""
        if not self.enabled:
            return
        try:
            import json
            # Convertir items a algo serializable
            data = {k: v for k, v in factura.items() if not callable(v)}
            # Firestore no soporta floats que sean NaN/Inf
            data['total'] = float(data.get('total', 0) or 0)
            data['iva_contenido'] = float(data.get('iva_contenido', 0) or 0)
            data['fuente'] = 'pos'
            self.db.collection('facturas').add(data)
            logger.info(f"Firebase: Factura subida — {data.get('tipo_comprobante')} ${data.get('total')}")
        except Exception as e:
            logger.warning(f"Firebase: Error subiendo factura: {e}")

    def start_register_listener(self, db_manager, on_open: Callable = None, on_close: Callable = None):
        """
        Escucha cambios en 'caja_activa/current' en tiempo real.
        Llama on_open(register_id) cuando se abre y on_close() cuando se cierra.
        """
        if not self.enabled:
            return
        def _watch(doc_snapshot, changes, read_time):
            for doc in doc_snapshot:
                data = doc.to_dict() or {}
                status = data.get('status')
                if status == 'open':
                    # DatabaseManager crea nueva conexión por operación → thread-safe
                    reg_id = self._create_local_register_from_data(db_manager, dict(data))
                    if reg_id and on_open:
                        on_open(reg_id)  # emite señal Qt (thread-safe)
                elif status == 'closed':
                    if on_close:
                        on_close(data.get('session_id', ''))
        try:
            ref = self.db.collection('caja_activa').document('current')
            watcher = ref.on_snapshot(_watch)
            self._listeners.append(watcher)
            logger.info("Firebase: Listener de caja activa iniciado.")
        except Exception as e:
            logger.error(f"Firebase: No se pudo iniciar listener de caja: {e}")

    def start_users_listener(self, db_manager, on_change: Callable = None):
        """
        Escucha cambios en 'cajeros' en tiempo real y actualiza la DB local automáticamente.
        """
        if not self.enabled:
            return
        def _watch(col_snapshot, changes, read_time):
            from PyQt5.QtCore import QTimer
            # download_users accede SQLite → debe correr en hilo principal
            def _do():
                try:
                    count = self.download_users(db_manager)
                    logger.info(f"Firebase: cajeros actualizados en tiempo real ({count}).")
                    if on_change:
                        on_change()
                except Exception as e:
                    logger.error(f"Firebase: error en listener de cajeros: {e}")
            QTimer.singleShot(0, _do)
        try:
            watcher = self.db.collection('cajeros').on_snapshot(_watch)
            self._listeners.append(watcher)
            logger.info("Firebase: Listener de cajeros activado.")
        except Exception as e:
            logger.error(f"Firebase: No se pudo iniciar listener de cajeros: {e}")

    def start_sales_listener(self, on_new_sale: Callable = None):
        """
        Escucha cambios en 'ventas' en tiempo real.
        Llama on_new_sale(sale_data: dict) cuando se registra una venta desde otra computadora.
        """
        if not self.enabled:
            return
        
        def _watch(col_snapshot, changes, read_time):
            try:
                from google.cloud.firestore_v1.watch import ChangeType
                for change in changes:
                    if change.type == ChangeType.ADDED or change.type == ChangeType.MODIFIED:
                        doc_data = change.document.to_dict() or {}

                        # Ignorar ventas históricas subidas en batch (>5 min de antigüedad)
                        created_raw = doc_data.get('created_at')
                        if created_raw is not None:
                            try:
                                if isinstance(created_raw, datetime):
                                    sale_dt = created_raw
                                    if sale_dt.tzinfo is None:
                                        sale_dt = sale_dt.replace(tzinfo=_TZ_AR)
                                else:
                                    sale_dt = self._parse_dt(created_raw).replace(tzinfo=_TZ_AR)
                                age = datetime.now(timezone.utc) - sale_dt.astimezone(timezone.utc)
                                if age.total_seconds() > 300:
                                    logger.debug(f"Firebase: Venta #{doc_data.get('sale_id')} ignorada (histórica, {int(age.total_seconds())}s)")
                                    continue
                            except Exception:
                                pass

                        logger.info(f"Firebase: Nueva venta detectada #{doc_data.get('sale_id')}")
                        if on_new_sale:
                            on_new_sale(doc_data)
            except Exception as e:
                logger.error(f"Firebase: error en listener de ventas: {e}")
        
        try:
            watcher = self.db.collection('ventas').on_snapshot(_watch)
            self._listeners.append(watcher)
            logger.info("Firebase: Listener de ventas activado.")
        except Exception as e:
            logger.error(f"Firebase: No se pudo iniciar listener de ventas: {e}")

    def start_cash_closing_listener(self, on_closing: Callable = None):
        """
        Escucha cambios en 'cierres_caja' en tiempo real.
        Llama on_closing(closing_report: dict) cuando se cierra caja desde otra computadora.
        """
        if not self.enabled:
            return
        
        def _watch(col_snapshot, changes, read_time):
            try:
                from google.cloud.firestore_v1.watch import ChangeType
                from PyQt5.QtCore import QTimer
                for change in changes:
                    if change.type == ChangeType.ADDED or change.type == ChangeType.MODIFIED:
                        doc_data = change.document.to_dict() or {}

                        # Bug 2: ignorar cierres históricos subidos como batch (>5 min de antigüedad)
                        fecha_cierre_raw = doc_data.get('fecha_cierre')
                        if fecha_cierre_raw is not None:
                            try:
                                if isinstance(fecha_cierre_raw, datetime):
                                    cierre_dt = fecha_cierre_raw
                                    if cierre_dt.tzinfo is None:
                                        cierre_dt = cierre_dt.replace(tzinfo=_TZ_AR)
                                else:
                                    cierre_dt = self._parse_dt(fecha_cierre_raw).replace(tzinfo=_TZ_AR)
                                age = datetime.now(timezone.utc) - cierre_dt.astimezone(timezone.utc)
                                if age.total_seconds() > 300:
                                    logger.debug(
                                        f"Firebase: Cierre #{doc_data.get('register_id')} ignorado "
                                        f"(histórico, {int(age.total_seconds())}s de antigüedad)"
                                    )
                                    continue
                            except Exception as _te:
                                logger.debug(f"Firebase: No se pudo verificar antigüedad del cierre: {_te}")

                        logger.info(f"Firebase: Cierre de caja detectado #{doc_data.get('register_id')}")
                        if on_closing:
                            # Bug 1: pasar al hilo principal de Qt para evitar crash por threading
                            _d = doc_data
                            QTimer.singleShot(0, lambda d=_d: on_closing(d))
            except Exception as e:
                logger.error(f"Firebase: error en listener de cierres: {e}")
        
        try:
            watcher = self.db.collection('cierres_caja').on_snapshot(_watch)
            self._listeners.append(watcher)
            logger.info("Firebase: Listener de cierres de caja activado.")
        except Exception as e:
            logger.error(f"Firebase: No se pudo iniciar listener de cierres: {e}")


    def sync_perfiles(self, db_manager):
        """Sube todos los perfiles de facturación activos a Firestore."""
        if not self.enabled:
            return
        def _do():
            try:
                rows = db_manager.execute_query(
                    "SELECT * FROM perfiles_facturacion WHERE activo=1 ORDER BY nombre ASC"
                )
                col = self.db.collection('perfiles_facturacion')
                batch = self.db.batch()
                for p in rows:
                    doc_id = str(p['id'])
                    ref = col.document(doc_id)
                    batch.set(ref, {
                        'id':                 p['id'],
                        'nombre':             p.get('nombre', ''),
                        'razon_social':       p.get('razon_social', ''),
                        'cuit':               p.get('cuit', ''),
                        'domicilio':          p.get('domicilio', ''),
                        'localidad':          p.get('localidad', ''),
                        'condicion_iva':      p.get('condicion_iva', 'Monotributista'),
                        'punto_venta':        p.get('punto_venta', 1),
                        'cert_path':          p.get('cert_path', ''),
                        'key_path':           p.get('key_path', ''),
                        'produccion':         bool(p.get('produccion', 0)),
                        'activo':             True,
                    })
                batch.commit()
                logger.info(f"Firebase: {len(rows)} perfiles de facturación sincronizados.")
            except Exception as e:
                logger.error(f"Firebase: error sincronizando perfiles: {e}")
        self._run(_do)

    def _escribir_cert_local(self, nombre_perfil: str, cert_b64: str, key_b64: str) -> tuple:
        """
        Decodifica los contenidos base64 del cert y key y los escribe en CERTS_DIR.
        Retorna (cert_path, key_path) como strings, o ('', '') si falla.
        """
        import base64
        try:
            from pos_system.config import CERTS_DIR
            # Sanitizar nombre para usarlo como nombre de archivo
            import re
            slug = re.sub(r'[^a-zA-Z0-9_-]', '_', nombre_perfil).lower()
            cert_path = CERTS_DIR / f"{slug}.crt"
            key_path  = CERTS_DIR / f"{slug}.key"

            if cert_b64:
                cert_path.write_bytes(base64.b64decode(cert_b64))
            if key_b64:
                key_path.write_bytes(base64.b64decode(key_b64))

            logger.info(f"Firebase: cert/key escritos para perfil '{nombre_perfil}'")
            return str(cert_path), str(key_path)
        except Exception as e:
            logger.error(f"Firebase: error escribiendo cert local: {e}")
            return '', ''

    def start_perfiles_listener(self, db_manager, on_change: Callable = None):
        """
        Escucha 'perfiles_facturacion' en tiempo real.
        Cuando la web sube un perfil con cert_content/key_content (base64),
        los escribe automáticamente en CERTS_DIR y guarda las rutas en la DB local.
        """
        if not self.enabled:
            return

        def _upsert(doc_data: dict):
            nombre    = doc_data.get('nombre', '')
            cert_b64  = doc_data.get('cert_content', '')
            key_b64   = doc_data.get('key_content', '')

            # Si vienen los archivos en base64, escribirlos localmente
            if cert_b64 or key_b64:
                cert_path, key_path = self._escribir_cert_local(nombre, cert_b64, key_b64)
            else:
                cert_path = doc_data.get('cert_path', '')
                key_path  = doc_data.get('key_path', '')

            fb_doc_id = doc_data.get('id') or doc_data.get('_docId', '')
            existing = db_manager.execute_query(
                "SELECT id FROM perfiles_facturacion WHERE firebase_id=?", (str(fb_doc_id),)
            ) if fb_doc_id else []

            params_update = (
                nombre,
                doc_data.get('razon_social', ''),
                doc_data.get('cuit', ''),
                doc_data.get('domicilio', ''),
                doc_data.get('localidad', ''),
                doc_data.get('condicion_iva', 'Monotributista'),
                int(doc_data.get('punto_venta', 1)),
                cert_path,
                key_path,
                1 if doc_data.get('produccion') else 0,
            )

            if existing:
                db_manager.execute_update(
                    """UPDATE perfiles_facturacion SET
                       nombre=?, razon_social=?, cuit=?, domicilio=?, localidad=?,
                       condicion_iva=?, punto_venta=?, cert_path=?, key_path=?,
                       produccion=?, activo=1
                       WHERE firebase_id=?""",
                    params_update + (str(fb_doc_id),)
                )
            else:
                db_manager.execute_update(
                    """INSERT INTO perfiles_facturacion
                       (nombre, razon_social, cuit, domicilio, localidad,
                        condicion_iva, punto_venta, cert_path, key_path, produccion, activo, firebase_id)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)""",
                    params_update + (str(fb_doc_id),)
                )

        def _watch(col_snapshot, changes, read_time):
            try:
                from google.cloud.firestore_v1.watch import ChangeType
                for change in changes:
                    doc_data = change.document.to_dict() or {}
                    doc_data['_docId'] = change.document.id

                    if change.type == ChangeType.REMOVED or not doc_data.get('activo', True):
                        fb_id = change.document.id
                        try:
                            db_manager.execute_update(
                                "UPDATE perfiles_facturacion SET activo=0 WHERE firebase_id=?",
                                (fb_id,)
                            )
                        except Exception:
                            pass
                        continue

                    _upsert(doc_data)

                logger.info("Firebase: perfiles de facturación sincronizados.")
                if on_change:
                    on_change()
            except Exception as e:
                logger.error(f"Firebase: error en listener de perfiles: {e}")

        try:
            watcher = self.db.collection('perfiles_facturacion').on_snapshot(_watch)
            self._listeners.append(watcher)
            logger.info("Firebase: Listener de perfiles de facturación activado.")
        except Exception as e:
            logger.error(f"Firebase: No se pudo iniciar listener de perfiles: {e}")


    def start_emisor_activo_listener(self, db_manager):
        """
        Escucha 'config/emisor_activo' en tiempo real.
        Cuando la web activa un emisor, guarda su firebase_id en config local.
        """
        if not self.enabled:
            return

        def _watch(doc_snapshot, changes, read_time):
            try:
                for doc in doc_snapshot:
                    data = doc.to_dict() or {}
                    firebase_id = data.get('firebase_id') or ''
                    db_manager.execute_update(
                        "INSERT OR REPLACE INTO config (key, value) VALUES ('emisor_activo_id', ?)",
                        (firebase_id,)
                    )
                    logger.info(f"Firebase: emisor activo actualizado → '{data.get('nombre', '')}' ({firebase_id})")
            except Exception as e:
                logger.error(f"Firebase: error en listener emisor_activo: {e}")

        try:
            ref = self.db.collection('config').document('emisor_activo')
            watcher = ref.on_snapshot(_watch)
            self._listeners.append(watcher)
            logger.info("Firebase: Listener de emisor activo activado.")
        except Exception as e:
            logger.error(f"Firebase: No se pudo iniciar listener emisor_activo: {e}")

    def sync_clientes(self, db_manager):
        """Sube todos los clientes de facturación activos a Firestore."""
        if not self.enabled:
            return
        def _do():
            try:
                rows = db_manager.execute_query(
                    "SELECT * FROM clientes_facturacion WHERE activo=1 ORDER BY nombre ASC"
                )
                col = self.db.collection('clientes_facturacion')
                batch = self.db.batch()
                for c in rows:
                    doc_id = str(c['id'])
                    ref = col.document(doc_id)
                    batch.set(ref, {
                        'id':           c['id'],
                        'nombre':       c.get('nombre', ''),
                        'razon_social': c.get('razon_social', ''),
                        'cuit':         c.get('cuit', ''),
                        'domicilio':    c.get('domicilio', ''),
                        'localidad':    c.get('localidad', ''),
                        'condicion_iva': c.get('condicion_iva', 'Consumidor Final'),
                        'activo':       True,
                    })
                batch.commit()
                logger.info(f"Firebase: {len(rows)} clientes de facturación sincronizados.")
            except Exception as e:
                logger.error(f"Firebase: error sincronizando clientes: {e}")
        self._run(_do)

    def start_clientes_listener(self, db_manager, on_change=None):
        """Escucha 'clientes_facturacion' en tiempo real desde la web."""
        if not self.enabled:
            return

        def _upsert(doc_data: dict):
            fb_doc_id = doc_data.get('id') or doc_data.get('_docId', '')
            existing = db_manager.execute_query(
                "SELECT id FROM clientes_facturacion WHERE firebase_id=?", (str(fb_doc_id),)
            ) if fb_doc_id else []

            params = (
                doc_data.get('nombre', ''),
                doc_data.get('razon_social', ''),
                doc_data.get('cuit', ''),
                doc_data.get('domicilio', ''),
                doc_data.get('localidad', ''),
                doc_data.get('condicion_iva', 'Consumidor Final'),
            )

            if existing:
                db_manager.execute_update(
                    """UPDATE clientes_facturacion SET
                       nombre=?, razon_social=?, cuit=?, domicilio=?, localidad=?,
                       condicion_iva=?, activo=1
                       WHERE firebase_id=?""",
                    params + (str(fb_doc_id),)
                )
            else:
                db_manager.execute_update(
                    """INSERT INTO clientes_facturacion
                       (nombre, razon_social, cuit, domicilio, localidad,
                        condicion_iva, activo, firebase_id)
                       VALUES (?, ?, ?, ?, ?, ?, 1, ?)""",
                    params + (str(fb_doc_id),)
                )

        def _watch(col_snapshot, changes, read_time):
            try:
                from google.cloud.firestore_v1.watch import ChangeType
                for change in changes:
                    doc_data = change.document.to_dict() or {}
                    doc_data['_docId'] = change.document.id

                    if change.type == ChangeType.REMOVED or not doc_data.get('activo', True):
                        fb_id = change.document.id
                        try:
                            db_manager.execute_update(
                                "UPDATE clientes_facturacion SET activo=0 WHERE firebase_id=?",
                                (fb_id,)
                            )
                        except Exception:
                            pass
                        continue

                    _upsert(doc_data)

                logger.info("Firebase: clientes de facturación sincronizados.")
                if on_change:
                    on_change()
            except Exception as e:
                logger.error(f"Firebase: error en listener de clientes: {e}")

        try:
            watcher = self.db.collection('clientes_facturacion').on_snapshot(_watch)
            self._listeners.append(watcher)
            logger.info("Firebase: Listener de clientes de facturación activado.")
        except Exception as e:
            logger.error(f"Firebase: No se pudo iniciar listener de clientes: {e}")


def _month_name(dt: datetime) -> str:
    months = ['enero','febrero','marzo','abril','mayo','junio',
              'julio','agosto','septiembre','octubre','noviembre','diciembre']
    return f"{months[dt.month - 1]} {dt.year}"
