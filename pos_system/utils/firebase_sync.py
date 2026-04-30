"""
Firebase Firestore Sync para Sistema POS.
Sube ventas, inventario, cierres de caja, historial diario y
productos más vendidos a Firestore en tiempo real.
También escucha cambios en tiempo real desde la web (inventario).
"""

import threading
import time as _time
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


# ── Reintento ante 429 / cuota agotada ──────────────────────────────
def _is_quota_error(e) -> bool:
    """True si el error luce como un 429 / quota / rate-limit / resource exhausted."""
    if e is None:
        return False
    s = (str(e) or '').lower()
    if '429' in s or 'quota' in s or 'rate limit' in s or 'resource exhausted' in s:
        return True
    # google.api_core.exceptions.ResourceExhausted hereda de GoogleAPICallError
    try:
        from google.api_core.exceptions import ResourceExhausted, TooManyRequests  # type: ignore
        if isinstance(e, (ResourceExhausted, TooManyRequests)):
            return True
    except Exception:
        pass
    return False


def _retry_on_429(fn, *, attempts: int = 4, base_delay: float = 1.5,
                  max_delay: float = 15.0, label: str = 'firestore'):
    """Ejecuta fn() y reintenta con backoff exponencial ante errores de cuota.

    - attempts: cantidad total de intentos (incluye el primero).
    - base_delay/max_delay: backoff exponencial — 1.5s, 3s, 6s, 12s (capeado en 15s).
    - label: descripción para los logs.

    Si fn falla por 429, se loguea WARN y se reintenta. Si el último intento
    también falla, re-lanza la excepción original. Otros errores (no-429) se
    propagan inmediatamente.
    """
    delay = base_delay
    last_e = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:
            last_e = e
            if not _is_quota_error(e) or i == attempts - 1:
                raise
            wait = min(delay, max_delay)
            try:
                logging.getLogger(__name__).warning(
                    f"Firebase: {label} 429/quota — reintentando en {wait:.1f}s "
                    f"({i + 1}/{attempts - 1})"
                )
            except Exception:
                pass
            _time.sleep(wait)
            delay *= 2
    if last_e is not None:
        raise last_e


def _fmt_qty(q):
    """Formatea cantidades: 1.0 -> '1', 0.3 -> '0.3', 2.55 -> '2.55'."""
    q = float(q or 0)
    if q == int(q):
        return str(int(q))
    return f"{q:.2f}".rstrip('0').rstrip('.')

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
import threading
_sync_instance: Optional["FirebaseSync"] = None
_sync_lock = threading.Lock()

def get_firebase_sync() -> Optional["FirebaseSync"]:
    return _sync_instance

def init_firebase_sync() -> Optional["FirebaseSync"]:
    global _sync_instance
    if _sync_instance is not None:
        return _sync_instance
    with _sync_lock:
        if _sync_instance is not None:
            return _sync_instance
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
            # Migracion automatica de cierres_caja al esquema compartido
            # (idempotente — si no hay docs viejos, sale rapido).
            try:
                _sync_instance.migrate_cierres_caja_compartido_async()
            except Exception as _e:
                logger.warning(f"Firebase: error agendando migracion cierres_caja: {_e}")
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

    def start_stock_sync_listener(self, db_manager, on_refresh: Optional[Callable] = None):
        """Listener real-time de 'catalogo' con filtro where('ultima_actualizacion','>', last_ts).

        - El snapshot inicial trae SÓLO los docs cambiados desde el último arranque
          (en vez de los 12K completos), reduciendo lecturas en ~99% si no hubo cambios.
        - Reacciona a cambios en: nombre, precio, costo, stock, codigo, cod_barra,
          categoria, rubro, marca, proveedor, stock_min, stock_max.
        - Procesa REMOVED (delete local + soft-delete si hay FK).
        - Procesa ADDED (insert nuevo en SQLite).
        - Persiste el último ts visto en DATA_DIR/last_ts_catalogo.txt.

        db_manager : DatabaseManager (SQLite)
        on_refresh : callable() — se invoca si hubo cambios reales (para refrescar UI)
        """
        if not self.enabled:
            return

        from pos_system.config import DATA_DIR
        ts_file = DATA_DIR / "last_ts_catalogo.txt"

        # Leer el último timestamp visto. Si no existe, primer arranque → filtro
        # desde hace 1 año (los productos viejos ya están en la SQLite via delta_sync).
        last_ts: Optional[datetime] = None
        if ts_file.exists():
            try:
                raw = ts_file.read_text(encoding="utf-8").strip()
                if raw:
                    last_ts = datetime.fromisoformat(raw)
                    if last_ts.tzinfo is None:
                        last_ts = last_ts.replace(tzinfo=timezone.utc)
            except Exception as e:
                logger.warning(f"Listener catalogo: no se pudo leer {ts_file.name}: {e}")
        if last_ts is None:
            last_ts = datetime.now(timezone.utc) - timedelta(days=365)
            logger.info("Listener catalogo: primer arranque, filtro desde hace 1 año")
        else:
            logger.info(f"Listener catalogo: filtro desde {last_ts.isoformat()}")

        def _doc_dt(value):
            """Convierte el campo ultima_actualizacion (varios formatos) a datetime UTC."""
            if isinstance(value, datetime):
                return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
            if isinstance(value, str) and value.strip():
                for _f in ('%Y-%m-%dT%H:%M:%S.%f%z','%Y-%m-%dT%H:%M:%S%z',
                           '%Y-%m-%dT%H:%M:%S.%f','%Y-%m-%dT%H:%M:%S',
                           '%Y-%m-%d %H:%M:%S.%f%z','%Y-%m-%d %H:%M:%S%z',
                           '%Y-%m-%d %H:%M:%S.%f','%Y-%m-%d %H:%M:%S'):
                    try:
                        dt = datetime.strptime(value.strip(), _f)
                        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
                    except ValueError:
                        continue
            return None

        def _watch(col_snapshot, changes, read_time):
            nonlocal last_ts
            try:
                from google.cloud.firestore_v1.watch import ChangeType
                changed_any = False
                max_ts_batch = last_ts
                now_local_str = now_ar().strftime('%Y-%m-%d %H:%M:%S')

                for change in changes:
                    doc_id = change.document.id
                    d = change.document.to_dict() or {}

                    # Trackear el max ts visto en el batch
                    doc_ts = _doc_dt(d.get('ultima_actualizacion'))
                    if doc_ts and (max_ts_batch is None or doc_ts > max_ts_batch):
                        max_ts_batch = doc_ts

                    # ── REMOVED: borrar del SQLite local ──
                    if change.type == ChangeType.REMOVED:
                        try:
                            db_manager.execute_update(
                                "DELETE FROM products WHERE firebase_id = ?", (doc_id,)
                            )
                            changed_any = True
                        except Exception:
                            # FK error → soft delete (preserva ventas históricas)
                            try:
                                db_manager.execute_update(
                                    "UPDATE products SET stock=0, firebase_id=NULL WHERE firebase_id = ?",
                                    (doc_id,)
                                )
                                changed_any = True
                            except Exception as e:
                                logger.warning(f"Listener catalogo: no pude borrar {doc_id}: {e}")
                        continue

                    # ── ADDED / MODIFIED ──
                    nombre = str(d.get('nombre') or d.get('name') or '').strip()
                    if not nombre:
                        continue
                    estado = str(d.get('estado') or 'activo').lower()
                    precio = float(d.get('precio_venta') or d.get('precio') or d.get('price') or 0)
                    if precio <= 0 or estado == 'sin_precio':
                        continue
                    costo   = float(d.get('costo') or d.get('cost') or 0)
                    stock   = int(d.get('stock') or 0)
                    categ   = str(d.get('categoria') or d.get('category') or '').strip() or 'Sin categoría'
                    rubro   = str(d.get('rubro') or '').strip() or None
                    barcode = str(d.get('cod_barra') or d.get('barcode') or '').strip() or None
                    desc    = float(d.get('descuento') or 0)
                    raw_smin = d.get('stock_min')
                    raw_smax = d.get('stock_max')
                    stock_min = int(raw_smin) if raw_smin not in (None, '', False) else None
                    stock_max = int(raw_smax) if raw_smax not in (None, '', False) else None

                    # Producto Conjunto
                    def _to_float(v):
                        if v in (None, '', False):
                            return None
                        try:
                            return float(v)
                        except (TypeError, ValueError):
                            return None
                    es_conjunto = 1 if d.get('es_conjunto') else 0
                    conjunto_tipo = (str(d.get('conjunto_tipo') or '').strip() or None) if es_conjunto else None
                    conjunto_unidad_medida = (str(d.get('conjunto_unidad_medida') or '').strip() or None) if es_conjunto else None
                    conjunto_unidades = _to_float(d.get('conjunto_unidades')) if es_conjunto else None
                    conjunto_contenido = _to_float(d.get('conjunto_contenido')) if es_conjunto else None
                    conjunto_restante = _to_float(d.get('conjunto_restante')) if es_conjunto else None
                    conjunto_precio_unidad = _to_float(d.get('conjunto_precio_unidad')) if es_conjunto else None
                    conjunto_total = _to_float(d.get('conjunto_total')) if es_conjunto else None
                    # Stock por color: array → JSON string para guardar en SQLite
                    conjunto_colores_raw = d.get('conjunto_colores') if es_conjunto else None
                    if isinstance(conjunto_colores_raw, list) and conjunto_colores_raw:
                        try:
                            import json as _json
                            def _norm_color(c):
                                out = {
                                    'color':    str(c.get('color', '') or ''),
                                    'unidades': float(c.get('unidades') or 0),
                                    'restante': float(c.get('restante') or 0),
                                }
                                # Precio por variedad (opcional). Si > 0, se incluye
                                # y el POS lo usa en lugar del precio_unidad global.
                                pr = c.get('precio')
                                try:
                                    pr_f = float(pr) if pr is not None else 0.0
                                except (TypeError, ValueError):
                                    pr_f = 0.0
                                if pr_f > 0:
                                    out['precio'] = pr_f
                                return out
                            conjunto_colores = _json.dumps([
                                _norm_color(c)
                                for c in conjunto_colores_raw
                                if isinstance(c, dict)
                            ], ensure_ascii=False)
                        except Exception:
                            conjunto_colores = None
                    else:
                        conjunto_colores = None

                    try:
                        rows = db_manager.execute_query(
                            "SELECT id, name, price, cost, stock, barcode, category, rubro, stock_min, stock_max, "
                            "es_conjunto, conjunto_tipo, conjunto_unidad_medida, conjunto_unidades, "
                            "conjunto_contenido, conjunto_restante, conjunto_precio_unidad, conjunto_total, "
                            "conjunto_colores "
                            "FROM products WHERE firebase_id = ?", (doc_id,)
                        ) or []
                    except Exception:
                        rows = []

                    if not rows:
                        # Producto nuevo en Firebase → insertar local
                        try:
                            if barcode:
                                db_manager.execute_update(
                                    "UPDATE products SET barcode = NULL WHERE barcode = ?", (barcode,)
                                )
                            db_manager.execute_update(
                                """INSERT OR IGNORE INTO products
                                   (name, category, price, cost, stock, barcode,
                                    discount_value, firebase_id, rubro,
                                    stock_min, stock_max,
                                    es_conjunto, conjunto_tipo, conjunto_unidad_medida,
                                    conjunto_unidades, conjunto_contenido, conjunto_restante,
                                    conjunto_precio_unidad, conjunto_total, conjunto_colores,
                                    created_at, updated_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                                           ?, ?, ?, ?, ?, ?, ?, ?, ?,
                                           CURRENT_TIMESTAMP, ?)""",
                                (nombre, categ, precio, costo, stock, barcode,
                                 desc, doc_id, rubro, stock_min, stock_max,
                                 es_conjunto, conjunto_tipo, conjunto_unidad_medida,
                                 conjunto_unidades, conjunto_contenido, conjunto_restante,
                                 conjunto_precio_unidad, conjunto_total, conjunto_colores,
                                 now_local_str)
                            )
                            changed_any = True
                        except Exception as e:
                            logger.warning(f"Listener catalogo: error INSERT {doc_id}: {e}")
                    else:
                        r = rows[0]
                        local_id = r['id']
                        # Sólo actualizar si algo realmente cambió (evita overwrites)
                        def _eq_float(a, b):
                            if a is None and b is None:
                                return True
                            if a is None or b is None:
                                return False
                            try:
                                return abs(float(a) - float(b)) < 1e-9
                            except (TypeError, ValueError):
                                return False
                        cambios = (
                            (r.get('name') or '')     != nombre or
                            float(r.get('price') or 0) != precio or
                            float(r.get('cost')  or 0) != costo  or
                            int(r.get('stock')   or 0) != stock  or
                            (r.get('barcode') or '')  != (barcode or '') or
                            (r.get('category') or '') != categ or
                            (r.get('rubro') or '')    != (rubro or '') or
                            r.get('stock_min')        != stock_min or
                            r.get('stock_max')        != stock_max or
                            int(r.get('es_conjunto') or 0) != es_conjunto or
                            (r.get('conjunto_tipo') or None)          != conjunto_tipo or
                            (r.get('conjunto_unidad_medida') or None) != conjunto_unidad_medida or
                            not _eq_float(r.get('conjunto_unidades'),      conjunto_unidades) or
                            not _eq_float(r.get('conjunto_contenido'),     conjunto_contenido) or
                            not _eq_float(r.get('conjunto_restante'),      conjunto_restante) or
                            not _eq_float(r.get('conjunto_precio_unidad'), conjunto_precio_unidad) or
                            not _eq_float(r.get('conjunto_total'),         conjunto_total) or
                            (r.get('conjunto_colores') or None) != (conjunto_colores or None)
                        )
                        if not cambios:
                            continue
                        try:
                            if barcode:
                                db_manager.execute_update(
                                    "UPDATE products SET barcode = NULL WHERE barcode = ? AND id != ?",
                                    (barcode, local_id)
                                )
                            db_manager.execute_update(
                                """UPDATE products
                                   SET name=?, category=?, price=?, cost=?, stock=?,
                                       barcode=?, discount_value=?, rubro=?,
                                       stock_min=?, stock_max=?,
                                       es_conjunto=?, conjunto_tipo=?, conjunto_unidad_medida=?,
                                       conjunto_unidades=?, conjunto_contenido=?, conjunto_restante=?,
                                       conjunto_precio_unidad=?, conjunto_total=?, conjunto_colores=?,
                                       updated_at=?
                                   WHERE id=?""",
                                (nombre, categ, precio, costo, stock,
                                 barcode, desc, rubro, stock_min, stock_max,
                                 es_conjunto, conjunto_tipo, conjunto_unidad_medida,
                                 conjunto_unidades, conjunto_contenido, conjunto_restante,
                                 conjunto_precio_unidad, conjunto_total, conjunto_colores,
                                 now_local_str, local_id)
                            )
                            changed_any = True
                        except Exception as e:
                            logger.warning(f"Listener catalogo: error UPDATE {doc_id}: {e}")

                # Persistir el max ts visto en este batch
                if max_ts_batch and (last_ts is None or max_ts_batch > last_ts):
                    last_ts = max_ts_batch
                    try:
                        ts_file.write_text(last_ts.isoformat(), encoding="utf-8")
                    except Exception as e:
                        logger.warning(f"Listener catalogo: no pude escribir {ts_file.name}: {e}")

                if changed_any and on_refresh:
                    try:
                        on_refresh()
                    except Exception as e:
                        logger.warning(f"Listener catalogo: on_refresh() falló: {e}")
            except Exception as e:
                logger.error(f"Listener catalogo: error en _watch: {e}")

        try:
            # Query con filtro: snapshot inicial sólo trae lo que cambió desde last_ts
            try:
                from google.cloud.firestore_v1.base_query import FieldFilter
                col_query = self.db.collection('catalogo').where(
                    filter=FieldFilter('ultima_actualizacion', '>', last_ts)
                )
            except ImportError:
                # SDK más viejo, fallback a sintaxis posicional
                col_query = self.db.collection('catalogo').where(
                    'ultima_actualizacion', '>', last_ts
                )
            watcher = col_query.on_snapshot(_watch)
            self._listeners.append(watcher)
            logger.info(f"Firebase: Listener real-time catalogo activado (filtro: > {last_ts.isoformat()})")
        except Exception as e:
            logger.error(f"Firebase: No se pudo iniciar listener catalogo: {e}")

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
            docs = _retry_on_429(lambda: list(col.stream()), label='download promociones')
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
                    f"{it.get('product_name', it.get('name','?'))} x{_fmt_qty(it.get('quantity',1))}"
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
                    'sale_id':          int(sale_id),
                    'pc_id':            pc_id,
                    'created_at':       created_at,
                    'payment_type':     sale.get('payment_type', ''),
                    'total_amount':     float(sale.get('total_amount', 0) or 0),
                    'cash_received':    float(sale.get('cash_received', 0) or 0),
                    'change_given':     float(sale.get('change_given', 0) or 0),
                    # Parte de transferencia en pago mixto. Para ventas
                    # comunes queda en 0; para 'mixed' contiene el monto
                    # transferido. Permite a la web mostrar el desglose.
                    'transfer_amount':  float(sale.get('transfer_amount', 0) or 0),
                    'items_count':      len(items) if items else int(sale.get('items_count', 0) or 0),
                    'productos':        productos_str,
                    'username':         cajero,
                    'cajero':           cajero,
                    'discount':         float(sale.get('discount', 0) or 0),
                    'cash_register_id': int(sale.get('cash_register_id') or 0) or None,
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
                    # ultima_actualizacion siempre como datetime para que matchee where(>last_ts)
                    raw_ts = p.get('updated_at') or p.get('ultima_actualizacion')
                    ts_dt = None
                    if isinstance(raw_ts, datetime):
                        ts_dt = raw_ts if raw_ts.tzinfo else raw_ts.replace(tzinfo=timezone.utc)
                    elif isinstance(raw_ts, str) and raw_ts.strip():
                        for _f in ('%Y-%m-%d %H:%M:%S.%f%z','%Y-%m-%d %H:%M:%S%z',
                                   '%Y-%m-%d %H:%M:%S.%f','%Y-%m-%d %H:%M:%S',
                                   '%Y-%m-%dT%H:%M:%S.%f%z','%Y-%m-%dT%H:%M:%S%z',
                                   '%Y-%m-%dT%H:%M:%S.%f','%Y-%m-%dT%H:%M:%S'):
                            try:
                                ts_dt = datetime.strptime(raw_ts.strip(), _f)
                                if ts_dt.tzinfo is None:
                                    ts_dt = ts_dt.replace(tzinfo=timezone.utc)
                                break
                            except ValueError:
                                continue
                    if ts_dt is None:
                        ts_dt = now_ar().astimezone(timezone.utc)
                    batch.set(ref, {
                        'id':                  int(pid),
                        'nombre':              p.get('name') or p.get('nombre', ''),
                        'categoria':           p.get('category') or p.get('categoria', 'Sin categoría'),
                        'precio':              float(p.get('price') or p.get('precio', 0) or 0),
                        'costo':               float(p.get('cost') or p.get('costo', 0) or 0),
                        'stock':               int(p.get('stock', 0) or 0),
                        'descuento':           float(p.get('discount') or p.get('descuento', 0) or 0),
                        'ultima_actualizacion': ts_dt,
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

    # ══════════════════════════════════════════════════
    #  OBSERVACIONES (notas compartidas entre cajeros)
    # ══════════════════════════════════════════════════
    def sync_observation(self, local_id: int, data: dict, db_manager=None):
        """Crea/actualiza una observación en Firestore.
        Si aún no tiene firebase_id en SQLite, genera uno y lo persiste.
        """
        if not self.enabled or not local_id:
            return

        def _do():
            try:
                payload = {
                    'text':              str(data.get('text') or ''),
                    'context':           str(data.get('context') or 'general'),
                    'sale_id':           data.get('sale_id'),
                    'sale_item_id':      data.get('sale_item_id'),
                    'created_by_id':     data.get('created_by_id'),
                    'created_by_name':   str(data.get('created_by_name') or ''),
                    'pc_id':             str(data.get('pc_id') or _get_pc_id()),
                    'created_at':        str(data.get('created_at') or now_ar().strftime('%Y-%m-%dT%H:%M:%S')),
                    'deleted':           bool(data.get('deleted') or False),
                    'local_id':          int(local_id),
                }
                fid = str(data.get('firebase_id') or '').strip()
                col = self.db.collection('observaciones')
                if fid:
                    col.document(fid).set(payload, merge=True)
                else:
                    ref = col.document()
                    ref.set(payload)
                    fid = ref.id
                    if db_manager is not None:
                        try:
                            db_manager.execute_update(
                                "UPDATE observations SET firebase_id = ? WHERE id = ?",
                                (fid, int(local_id))
                            )
                        except Exception as e:
                            logger.warning(f"Firebase obs: persistir firebase_id local: {e}")

                try:
                    self.db.collection('config').document('observaciones_meta').set(
                        {'last_updated': now_ar().strftime('%Y-%m-%dT%H:%M:%S')}, merge=True
                    )
                except Exception:
                    pass

                logger.info(f"Firebase: observación #{local_id} sincronizada ({fid}).")
            except Exception as e:
                logger.error(f"Firebase: Error al sincronizar observación: {e}")

        self._run(_do)

    def upsert_presupuesto(self, presupuesto: dict) -> Optional[str]:
        """Sube/actualiza un presupuesto en Firestore.

        Si el presupuesto ya tiene firebase_id, hace merge sobre ese doc.
        Sino, crea uno nuevo y devuelve el ID generado para que el llamador
        lo persista en SQLite.

        Items van como array dentro del doc (presupuestos no son grandes).
        """
        if not self.enabled or not presupuesto:
            return None

        # Normalizar items
        items_arr = []
        for it in (presupuesto.get('items') or []):
            items_arr.append({
                'product_id':   it.get('product_id'),
                'product_name': str(it.get('product_name') or ''),
                'quantity':     float(it.get('quantity') or 0),
                'unit_price':   float(it.get('unit_price') or 0),
                'subtotal':     float(it.get('subtotal') or 0),
            })

        payload = {
            'numero':            int(presupuesto.get('numero') or 0),
            'cliente_nombre':    str(presupuesto.get('cliente_nombre') or ''),
            'cliente_telefono':  str(presupuesto.get('cliente_telefono') or ''),
            'cliente_email':     str(presupuesto.get('cliente_email') or ''),
            'subtotal':          float(presupuesto.get('subtotal') or 0),
            'descuento':         float(presupuesto.get('descuento') or 0),
            'total':             float(presupuesto.get('total') or 0),
            'fecha_emision':     str(presupuesto.get('fecha_emision') or now_ar().strftime('%Y-%m-%dT%H:%M:%S')),
            'fecha_validez':     str(presupuesto.get('fecha_validez') or ''),
            'estado':            str(presupuesto.get('estado') or 'pendiente'),
            'venta_id':          presupuesto.get('venta_id'),
            'pc_id':             str(presupuesto.get('pc_id') or _get_pc_id()),
            'cajero_nombre':     str(presupuesto.get('cajero_nombre') or ''),
            'user_id':           presupuesto.get('user_id'),
            'notas':             str(presupuesto.get('notas') or ''),
            'deleted':           bool(presupuesto.get('deleted') or False),
            'local_id':          int(presupuesto.get('id') or 0),
            'items':             items_arr,
            'updated_at':        now_ar().strftime('%Y-%m-%dT%H:%M:%S'),
        }

        fid = str(presupuesto.get('firebase_id') or '').strip()
        col = self.db.collection('presupuestos')

        # Esta llamada puede ser sincrónica para que el caller obtenga el firebase_id
        # → la corremos en hilo solo si está dentro de _run; acá la hacemos directa
        # con timeout protegido por self._safe_call.
        def _do():
            try:
                nonlocal fid
                if fid:
                    col.document(fid).set(payload, merge=True)
                else:
                    ref = col.document()
                    ref.set(payload)
                    fid = ref.id
                # Bumpear meta para listeners
                try:
                    self.db.collection('config').document('presupuestos_meta').set(
                        {'last_updated': now_ar().strftime('%Y-%m-%dT%H:%M:%S')}, merge=True
                    )
                except Exception:
                    pass
                logger.info(f"Firebase: Presupuesto P-{payload['numero']:05d} sincronizado ({fid}).")
            except Exception as e:
                logger.error(f"Firebase: Error sync presupuesto: {e}")

        # Sync inline (no bloqueante para casos típicos): el llamador necesita el fid
        # para guardarlo en SQLite. Lo corremos en este hilo pero tolerante a errores.
        try:
            _do()
        except Exception:
            logger.exception("Firebase: upsert_presupuesto fallo")
            return None
        return fid or None

    def start_presupuestos_listener(self, db_manager, on_change: Optional[Callable] = None):
        """Listener en tiempo real de la colección 'presupuestos' — espeja a SQLite.
        on_change() se llama si hubo cambios que la UI deba refrescar.
        """
        if not self.enabled:
            return

        from pos_system.models.presupuesto import Presupuesto as _Pres
        pres_model = _Pres(db_manager)

        def _watch(col_snapshot, changes, read_time):
            try:
                from google.cloud.firestore_v1.watch import ChangeType
                changed = False
                for change in changes:
                    fid = change.document.id
                    if change.type == ChangeType.REMOVED:
                        try:
                            db_manager.execute_update(
                                "UPDATE presupuestos SET deleted = 1 WHERE firebase_id = ?",
                                (fid,)
                            )
                            changed = True
                        except Exception as e:
                            logger.warning(f"Firebase pres listener REMOVED: {e}")
                        continue
                    d = change.document.to_dict() or {}
                    try:
                        pres_model.upsert_from_firebase(fid, d)
                        changed = True
                    except Exception as e:
                        logger.warning(f"Firebase pres listener upsert: {e}")

                if changed and on_change:
                    try:
                        on_change()
                    except Exception as e:
                        logger.warning(f"Firebase pres listener on_change: {e}")
            except Exception as e:
                logger.error(f"Firebase: error en listener de presupuestos: {e}")

        try:
            col_ref = self.db.collection('presupuestos')
            watcher = col_ref.on_snapshot(_watch)
            self._listeners.append(watcher)
            logger.info("Firebase: Listener de presupuestos en tiempo real activado.")
        except Exception as e:
            logger.error(f"Firebase: No se pudo iniciar listener de presupuestos: {e}")

    def start_observations_listener(self, db_manager, on_change: Optional[Callable] = None):
        """Listener en tiempo real de la colección 'observaciones' — espeja a SQLite.
        on_change() se llama si hubo cambios que la UI deba refrescar.
        """
        if not self.enabled:
            return

        from pos_system.models.observation import Observation as _Obs
        obs_model = _Obs(db_manager)

        def _watch(col_snapshot, changes, read_time):
            try:
                from google.cloud.firestore_v1.watch import ChangeType
                changed = False
                for change in changes:
                    fid = change.document.id
                    if change.type == ChangeType.REMOVED:
                        try:
                            db_manager.execute_update(
                                "UPDATE observations SET deleted = 1 WHERE firebase_id = ?",
                                (fid,)
                            )
                            changed = True
                        except Exception as e:
                            logger.warning(f"Firebase obs listener REMOVED: {e}")
                        continue
                    d = change.document.to_dict() or {}
                    try:
                        obs_model.upsert_from_firebase(fid, d)
                        changed = True
                    except Exception as e:
                        logger.warning(f"Firebase obs listener upsert: {e}")

                if changed and on_change:
                    try:
                        on_change()
                    except Exception as e:
                        logger.warning(f"Firebase obs listener on_change: {e}")
            except Exception as e:
                logger.error(f"Firebase: error en listener de observaciones: {e}")

        try:
            col_ref = self.db.collection('observaciones')
            watcher = col_ref.on_snapshot(_watch)
            self._listeners.append(watcher)
            logger.info("Firebase: Listener de observaciones en tiempo real activado.")
        except Exception as e:
            logger.error(f"Firebase: No se pudo iniciar listener de observaciones: {e}")

    def sync_stock_after_sale(self, items: list, db_manager):
        """Descuenta el stock en Firebase (catalogo + inventario) de forma ATÓMICA
        usando firestore.Increment(-quantity). Esto evita race conditions cuando
        dos PCs venden el mismo producto simultáneamente: Firebase reconcilia los
        decrementos y queda como fuente de verdad. Los productos con stock=-1
        (servicio/ilimitado) NO se descuentan.
        """
        if not self.enabled or not items:
            return

        def _do():
            try:
                from firebase_admin import firestore as _fs
                now_dt  = now_ar().astimezone(timezone.utc)
                now_str = now_dt.strftime('%Y-%m-%dT%H:%M:%S')
                batch = self.db.batch()
                updated = 0

                for it in items:
                    pid = it.get('product_id')
                    qty = float(it.get('quantity') or 0)
                    if not pid or qty <= 0:
                        continue
                    try:
                        rows = db_manager.execute_query(
                            "SELECT id, firebase_id, stock, es_conjunto, "
                            "       conjunto_unidades, conjunto_restante, conjunto_total, "
                            "       conjunto_colores "
                            "FROM products WHERE id = ?",
                            (int(pid),)
                        )
                    except Exception:
                        rows = []
                    if not rows:
                        continue
                    row = rows[0]
                    firebase_id = str(row.get('firebase_id') or '').strip()

                    # Producto Conjunto: no se toca `stock`, se sincroniza el
                    # estado absoluto (unidades / restante / total) que el modelo
                    # de venta ya actualizó en SQLite. Si tiene stock por color,
                    # se sube el array completo a Firestore.
                    if int(row.get('es_conjunto') or 0) == 1:
                        payload_conj = {
                            'conjunto_unidades':    float(row.get('conjunto_unidades') or 0),
                            'conjunto_restante':    float(row.get('conjunto_restante') or 0),
                            'conjunto_total':       float(row.get('conjunto_total') or 0),
                            'ultima_actualizacion': now_dt,
                        }
                        colores_json = row.get('conjunto_colores')
                        if colores_json:
                            try:
                                import json as _json
                                payload_conj['conjunto_colores'] = _json.loads(colores_json)
                            except Exception:
                                pass
                        inv_ref = self.db.collection('inventario').document(str(pid))
                        batch.set(inv_ref, payload_conj, merge=True)
                        if firebase_id:
                            cat_ref = self.db.collection('catalogo').document(firebase_id)
                            batch.set(cat_ref, payload_conj, merge=True)
                        updated += 1
                        continue

                    # Servicio/ilimitado: no tocar el stock en Firebase
                    if int(row.get('stock') or 0) == -1:
                        continue

                    # Inventario (doc_id = id numérico local) — decremento atómico
                    inv_ref = self.db.collection('inventario').document(str(pid))
                    batch.set(inv_ref, {
                        'stock': _fs.Increment(-qty),
                        'ultima_actualizacion': now_dt,  # Timestamp para que matchee where(>last_ts)
                    }, merge=True)

                    # Catalogo (doc_id = firebase_id) — decremento atómico
                    if firebase_id:
                        cat_ref = self.db.collection('catalogo').document(firebase_id)
                        batch.set(cat_ref, {
                            'stock': _fs.Increment(-qty),
                            'ultima_actualizacion': now_dt,  # Timestamp para que matchee where(>last_ts)
                        }, merge=True)

                    updated += 1

                if updated == 0:
                    return

                batch.commit()

                # Tocar metadatos para que las otras PCs detecten el cambio en delta_sync
                try:
                    self.db.collection('config').document('inventario_meta').set(
                        {'last_updated': now_str}, merge=True
                    )
                    self.db.collection('config').document('catalogo_meta').set(
                        {'last_updated': now_str}, merge=True
                    )
                except Exception:
                    pass

                logger.info(f"Firebase: stock decrementado atómicamente para {updated} producto(s) tras venta.")
            except Exception as e:
                logger.error(f"Firebase: Error actualizando stock post-venta: {e}")

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

                # 2. Consultar metadato (1 sola lectura Firestore, con retry)
                meta_doc = _retry_on_429(
                    lambda: self.db.collection('config').document('catalogo_meta').get(),
                    label='delta_sync meta read'
                )
                if not meta_doc.exists:
                    logger.debug("Delta sync: sin doc catalogo_meta — omitiendo.")
                    if on_done:
                        on_done(0)
                    return

                meta = meta_doc.to_dict() or {}
                firebase_ts = str(meta.get('last_updated', '') or '')

                inventario_al_dia = bool(firebase_ts and firebase_ts <= last_local_ts)
                if inventario_al_dia:
                    logger.info(f"Delta sync: inventario al día ({firebase_ts}) — solo se reconciliarán borrados.")
                else:
                    logger.info(f"Delta sync: cambios detectados (Firebase: {firebase_ts}, local: {last_local_ts})")

                # 3. Descargar el catálogo. OPTIMIZACIÓN:
                #    Si tenemos last_local_ts → bajar SÓLO docs cambiados desde entonces
                #    (where(>last_local_ts)). Si no hay last_local_ts (instalación nueva),
                #    se hace stream() completo una sola vez.
                last_local_dt = None
                if last_local_ts:
                    for _f in ('%Y-%m-%dT%H:%M:%S.%f%z','%Y-%m-%dT%H:%M:%S%z',
                               '%Y-%m-%dT%H:%M:%S.%f','%Y-%m-%dT%H:%M:%S',
                               '%Y-%m-%d %H:%M:%S.%f','%Y-%m-%d %H:%M:%S'):
                        try:
                            _dt = datetime.strptime(last_local_ts, _f)
                            last_local_dt = _dt if _dt.tzinfo else _dt.replace(tzinfo=timezone.utc)
                            break
                        except ValueError:
                            continue
                    # Damos un margen de 5min hacia atrás para cubrir relojes
                    # ligeramente desincronizados o writes en transito.
                    if last_local_dt:
                        last_local_dt = last_local_dt - timedelta(minutes=5)

                if last_local_dt:
                    try:
                        from google.cloud.firestore_v1.base_query import FieldFilter
                        q = self.db.collection('catalogo').where(
                            filter=FieldFilter('ultima_actualizacion', '>', last_local_dt)
                        )
                    except ImportError:
                        q = self.db.collection('catalogo').where(
                            'ultima_actualizacion', '>', last_local_dt
                        )
                    docs = _retry_on_429(lambda: list(q.stream()),
                                         label='delta query catalogo')
                    logger.info(f"Delta sync: bajando solo cambios desde {last_local_dt.isoformat()} → {len(docs)} docs")
                    full_sync = False
                else:
                    docs = _retry_on_429(
                        lambda: list(self.db.collection('catalogo').stream()),
                        label='full stream catalogo'
                    )
                    logger.info(f"Delta sync: full sync (sin last_ts) → {len(docs)} docs")
                    full_sync = True

                if not docs and not full_sync:
                    # Sin cambios: igual reconciliamos borrados via catalogo_deleted
                    docs = []

                # 4. Mapa local: firebase_id → (local_id, updated_at, barcode, stock_min, stock_max)
                rows = local_db.execute_query(
                    "SELECT id, firebase_id, updated_at, barcode, stock_min, stock_max FROM products"
                ) or []
                local_by_firebase_id = {}
                for r in rows:
                    if r.get('firebase_id'):
                        local_by_firebase_id[str(r['firebase_id'])] = (
                            r['id'], r.get('updated_at') or '', r.get('barcode') or '',
                            r.get('stock_min'), r.get('stock_max')
                        )

                # 5. Aplicar diffs (con filtro nuevo, todos los docs son candidatos)
                docs_for_diff = docs if not inventario_al_dia else []
                for doc in docs_for_diff:
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
                    raw_smin = d.get('stock_min')
                    raw_smax = d.get('stock_max')
                    stock_min = int(raw_smin) if raw_smin not in (None, '', False) else None
                    stock_max = int(raw_smax) if raw_smax not in (None, '', False) else None

                    entry = local_by_firebase_id.get(firebase_id)

                    if entry is None:
                        # Producto nuevo — liberar barcode si lo tiene otro producto
                        try:
                            if barcode:
                                local_db.execute_update(
                                    "UPDATE products SET barcode = NULL WHERE barcode = ?",
                                    (barcode,)
                                )
                            local_db.execute_update(
                                """INSERT OR IGNORE INTO products
                                   (name, category, price, cost, stock, barcode,
                                    discount_value, firebase_id, rubro,
                                    stock_min, stock_max,
                                    created_at, updated_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)""",
                                (nombre, categ, precio, costo, stock, barcode,
                                 desc, firebase_id, rubro, stock_min, stock_max, fb_ts)
                            )
                            n_updated += 1
                        except Exception as e:
                            logger.warning(f"Delta sync: error INSERT {firebase_id}: {e}")

                    else:
                        local_id, local_ts, local_barcode, local_smin, local_smax = entry
                        alerts_changed = (stock_min != local_smin) or (stock_max != local_smax)
                        if fb_ts and (fb_ts != local_ts or (barcode or '') != local_barcode or alerts_changed):
                            # Producto modificado — liberar barcode si lo tiene otro producto
                            try:
                                if barcode:
                                    local_db.execute_update(
                                        "UPDATE products SET barcode = NULL WHERE barcode = ? AND id != ?",
                                        (barcode, local_id)
                                    )
                                local_db.execute_update(
                                    """UPDATE products
                                       SET name=?, category=?, price=?, cost=?, stock=?,
                                           barcode=?, discount_value=?, rubro=?,
                                           stock_min=?, stock_max=?, updated_at=?
                                       WHERE id=?""",
                                    (nombre, categ, precio, costo, stock,
                                     barcode, desc, rubro, stock_min, stock_max, fb_ts, local_id)
                                )
                                n_updated += 1
                            except Exception as e:
                                logger.warning(f"Delta sync: error UPDATE {firebase_id}: {e}")

                # 6. Reconciliación de borrados.
                #    - full_sync (primer arranque): comparar contra TODOS los doc.id de Firestore
                #    - delta (filtrado): leer 'catalogo_deleted' para saber qué se borró desde last_ts
                stale_fids = []
                try:
                    if full_sync:
                        firestore_ids = {doc.id for doc in docs}
                        stale_fids = [
                            (lid, fid) for fid, (lid, *_) in local_by_firebase_id.items()
                            if fid not in firestore_ids and lid != 0
                        ]
                    else:
                        # Tombstones: docs en 'catalogo_deleted' con deleted_at > last_local_dt
                        try:
                            from google.cloud.firestore_v1.base_query import FieldFilter
                            qd = self.db.collection('catalogo_deleted').where(
                                filter=FieldFilter('deleted_at', '>', last_local_dt)
                            )
                        except ImportError:
                            qd = self.db.collection('catalogo_deleted').where(
                                'deleted_at', '>', last_local_dt
                            )
                        deleted_docs = list(qd.stream())
                        for dd in deleted_docs:
                            entry = local_by_firebase_id.get(dd.id)
                            if entry:
                                stale_fids.append((entry[0], dd.id))
                        if deleted_docs:
                            logger.info(f"Delta sync: {len(deleted_docs)} tombstones detectados desde {last_local_dt.isoformat()}")
                except Exception as e:
                    logger.warning(f"Delta sync: error detectando borrados: {e}")

                deleted = 0
                softdeleted = 0
                for lid, fid in stale_fids:
                    try:
                        local_db.execute_update("DELETE FROM products WHERE id=?", (lid,))
                        deleted += 1
                    except Exception as _e:
                        # Probablemente FK: hay ventas apuntando a este producto.
                        try:
                            local_db.execute_update(
                                "UPDATE products SET stock=0, firebase_id=NULL WHERE id=?",
                                (lid,)
                            )
                            softdeleted += 1
                        except Exception as _e2:
                            logger.debug(f"Delta sync: no se pudo limpiar producto {lid}: {_e2}")
                if deleted or softdeleted:
                    logger.info(
                        f"Delta sync: {deleted} productos eliminados, "
                        f"{softdeleted} conservados (con ventas) y marcados stock=0."
                    )

                # 7. Guardar timestamp del sync exitoso
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
                # Distribución por medio de pago, considerando 'mixed' (parte
                # efectivo + parte transferencia) además de cash y transfer.
                def _split(s):
                    amt = float(s.get('total_amount', 0) or 0)
                    pt  = s.get('payment_type')
                    if pt == 'cash':
                        return amt, 0.0
                    if pt == 'mixed':
                        cash = max(0.0, float(s.get('cash_received', 0) or 0) -
                                         float(s.get('change_given', 0) or 0))
                        tra  = float(s.get('transfer_amount', 0) or 0)
                        # Si por algún motivo no suman al total, normalizar
                        if cash + tra <= 0:
                            return 0.0, amt
                        return cash, tra
                    return 0.0, amt
                efectivo = 0.0
                transferencia = 0.0
                for s in sales:
                    c, t = _split(s)
                    efectivo += c
                    transferencia += t
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
                _ptype = sale.get('payment_type')
                if _ptype == 'cash':
                    tipo_pago = 'Efectivo'
                elif _ptype == 'mixed':
                    tipo_pago = 'Mixto'
                else:
                    tipo_pago = 'Transferencia'
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
                               COALESCE(si.promo_id, '') as promo_id,
                               COALESCE(si.conjunto_color, '') as conjunto_color
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
                        'cantidad':       float(item.get('quantity', 1) or 0),
                        'precio_unitario':float(item.get('unit_price', 0) or 0),
                        'subtotal':       float(item.get('subtotal', 0) or 0),
                        'tipo_pago':      tipo_pago,
                        'cajero':         cajero,
                        'fecha_dt':       created_at,
                        'descuento_tipo':   item.get('discount_type') or '',
                        'descuento_valor':  float(item.get('discount_value', 0) or 0),
                        'descuento_monto':  float(item.get('discount_amount', 0) or 0),
                        'precio_original':  float(item.get('original_price', 0) or item.get('unit_price', 0) or 0),
                        'conjunto_color':   (item.get('conjunto_color') or item.get('color') or ''),
                    }, merge=True)
                batch.commit()
                logger.debug(f"Firebase: Detalle de venta #{sale_id} ({len(items)} items) sincronizado.")
            except Exception as e:
                logger.error(f"Firebase: Error sincronizando detalle de venta: {e}")
        self._run(_do)

    def resync_sale_after_edit(self, sale_id: int, db_manager):
        """Resincroniza a Firebase todo lo derivado de una venta que fue editada:
        venta, detalle por día, historial diario, resumen mensual y — si la
        caja asociada ya está cerrada — el cierre de caja.

        Se llama después de `Sale.update(...)` para propagar los cambios a la
        webapp y a todas las PCs.
        """
        if not self.enabled or not sale_id:
            return

        def _do():
            try:
                from pos_system.models.sale import Sale as _Sale
                from pos_system.models.cash_register import CashRegister as _CR

                sale = _Sale(db_manager).get_by_id(int(sale_id))
                if not sale:
                    logger.warning(f"resync_sale_after_edit: venta #{sale_id} no encontrada")
                    return

                # 1. Venta (colección 'ventas')
                self.sync_sale(sale)

                # 2. Detalle por día (colección 'ventas_por_dia')
                self.sync_sale_detail_by_day(sale, db_manager=db_manager)

                # 3. Historial diario del día de la venta
                dt = self._parse_dt(sale.get('created_at'))
                day_str = dt.strftime('%Y-%m-%d')
                day_sales = db_manager.execute_query(
                    "SELECT * FROM sales WHERE date(created_at) = ?", (day_str,)
                ) or []
                self.sync_daily_summary(day_sales, date=dt)

                # 4. Resumen mensual
                month_start = dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
                month_sales = _Sale(db_manager).get_all(
                    start_date=month_start.strftime('%Y-%m-%d 00:00:00'),
                    end_date=dt.strftime('%Y-%m-%d 23:59:59')
                )
                # Adjuntar items para el top de productos del resumen mensual
                for s in month_sales:
                    if 'items' not in s:
                        s['items'] = db_manager.execute_query(
                            "SELECT * FROM sale_items WHERE sale_id = ?", (s.get('id'),)
                        ) or []
                self.sync_monthly_summary(dt.year, dt.month, month_sales, db_manager=db_manager)

                # 5. Si la caja asociada está cerrada, re-sincronizar el cierre
                reg_id = sale.get('cash_register_id')
                if reg_id:
                    reg_rows = db_manager.execute_query(
                        "SELECT status, notes FROM cash_register WHERE id = ?", (int(reg_id),)
                    ) or []
                    if reg_rows and str(reg_rows[0].get('status') or '').lower() == 'closed':
                        try:
                            rep = _CR(db_manager).get_closing_report(int(reg_id))
                            if rep:
                                # Intentar preservar session_id del doc existente si aplica
                                sid = None
                                try:
                                    notes = reg_rows[0].get('notes') or ''
                                    if 'session=' in notes:
                                        sid = notes.split('session=', 1)[1].split()[0].strip()
                                except Exception:
                                    sid = None
                                self.sync_cash_closing(rep, session_id=sid)
                        except Exception as _ce:
                            logger.warning(f"resync_sale_after_edit: cierre: {_ce}")

                logger.info(f"Firebase: venta #{sale_id} resincronizada tras edición.")
            except Exception as e:
                logger.error(f"Firebase: Error en resync_sale_after_edit: {e}")

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
                # Considerar pago mixto al sumar por medio de pago
                def _split_m(s):
                    amt = float(s.get('total_amount', 0) or 0)
                    pt  = s.get('payment_type')
                    if pt == 'cash':
                        return amt, 0.0
                    if pt == 'mixed':
                        cash = max(0.0, float(s.get('cash_received', 0) or 0) -
                                         float(s.get('change_given', 0) or 0))
                        tra  = float(s.get('transfer_amount', 0) or 0)
                        if cash + tra <= 0:
                            return 0.0, amt
                        return cash, tra
                    return 0.0, amt
                efectivo = 0.0
                transferencia = 0.0
                for _s in sales:
                    _c, _t = _split_m(_s)
                    efectivo += _c
                    transferencia += _t
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
                        productos[name]['cantidad'] += float(item.get('quantity', 1) or 0)
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
                        'total_quantity': float(p.get('total_quantity') or p.get('cantidad', 0) or 0),
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
                # Doc id compartido = solo register_id. Las 5 PCs escriben al
                # mismo doc (merge=True) → una sola caja en Firebase para todas.
                fb_doc_id = str(register_id)
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
            docs = _retry_on_429(lambda: list(col.stream()), label='download rubros')
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
                    from google.cloud.firestore_v1.base_query import FieldFilter as _FF
                    _q_pr = col.where(filter=_FF('ultima_actualizacion', '>=', last_dt))
                except ImportError:
                    _q_pr = col.where('ultima_actualizacion', '>=', last_dt)
                try:
                    docs = _retry_on_429(
                        lambda: list(_q_pr.stream()),
                        label='download productos_remotos delta'
                    )
                except Exception:
                    docs = _retry_on_429(lambda: list(col.stream()),
                                         label='download productos_remotos full')
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
            docs = _retry_on_429(
                lambda: list(self.db.collection('cajeros').stream()),
                label='download cajeros'
            )
            # Lista de usernames que NO se sincronizan (datos viejos de prueba).
            # Si aparecen en Firebase, se ignoran y se borran localmente para que
            # no vuelvan a aparecer en la pantalla de cajeros.
            BLOCKED_USERNAMES = {'simon', 'simone'}

            count = 0
            for doc in docs:
                d = doc.to_dict() or {}
                username  = str(d.get('username') or '').strip().lower()
                full_name = str(d.get('full_name') or username).strip()
                role      = str(d.get('role') or 'cajero').strip()
                is_active = bool(d.get('is_active', True))
                if not username:
                    continue
                if username in BLOCKED_USERNAMES:
                    # Borrar localmente si quedó de un sync anterior
                    try:
                        db_manager.execute_update(
                            "DELETE FROM users WHERE username=?", (username,)
                        )
                    except Exception:
                        pass
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
            # Limpieza adicional por si los blocked existen sin venir de Firebase
            for blk in BLOCKED_USERNAMES:
                try:
                    db_manager.execute_update("DELETE FROM users WHERE username=?", (blk,))
                except Exception:
                    pass
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
          - 'cierres_caja/{id}': doc compartido entre todas las PCs (merge=True),
            así la webapp muestra UNA sola tarjeta "Caja Abierta".
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
                #    Doc id = solo register_id → todas las PCs escriben al
                #    mismo doc (con merge=True). Al cerrar, sync_cash_closing
                #    sobreescribe este mismo doc con fecha_cierre.
                fb_doc_id = str(register_id)
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

    def sync_close_register(self, session_id: str = None, register_id: int = None):
        """
        Marca la caja activa como cerrada en Firestore.
        Llamar cuando el admin cierra la caja.
        Incluye register_id para que otras PCs cierren solo la caja correcta.
        """
        if not self.enabled:
            return
        _sid = session_id or now_ar().strftime('%Y-%m-%d')
        _rid = None
        try:
            _rid = int(register_id) if register_id else None
        except Exception:
            _rid = None
        def _do():
            try:
                payload = {
                    'status':     'closed',
                    'session_id': _sid,
                    'updated_at': now_ar_iso(),
                }
                if _rid:
                    payload['id'] = _rid
                    payload['register_id'] = _rid
                self.db.collection('caja_activa').document('current').set(payload, merge=True)
                logger.info(f"Firebase: Caja #{_rid} marcada como cerrada.")
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
                # Existe pero localmente cerrada: NO re-abrir automáticamente.
                # El estado local es la fuente de verdad del cierre (evita que
                # datos stale en 'caja_activa/current' revivan cajas cerradas).
                logger.info(
                    f"Firebase: Caja #{remote_id} figura abierta en Firebase pero está cerrada localmente. "
                    "Se mantiene cerrada (no se reabre)."
                )
                return None
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
                        # Pasar register_id si vino en el payload; el handler decide
                        # si cierra la caja local (solo si matchea el id).
                        reg_id = data.get('register_id') or data.get('id')
                        on_close(data.get('session_id', ''), reg_id)
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

    def _escribir_cert_local(self, nombre_perfil: str, cert_b64: str, key_b64: str,
                              old_cert_path: str = '', old_key_path: str = '') -> tuple:
        """
        Decodifica los contenidos base64 del cert y key y los escribe en CERTS_DIR.
        Si old_cert_path/old_key_path apuntan a archivos distintos de los nuevos,
        los borra para no dejar certs viejos en disco.
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

            # Borrar cert/key viejos del mismo perfil si apuntaban a otro archivo
            from pathlib import Path as _Path
            for old in (old_cert_path, old_key_path):
                if not old:
                    continue
                try:
                    op = _Path(old)
                    # Solo borrar si está dentro de CERTS_DIR y es distinto del nuevo
                    if op.resolve() == cert_path.resolve() or op.resolve() == key_path.resolve():
                        continue
                    if op.is_file() and str(op.parent.resolve()) == str(CERTS_DIR.resolve()):
                        op.unlink()
                        logger.info(f"Firebase: cert viejo borrado: {op.name}")
                except Exception as _e:
                    logger.warning(f"Firebase: no se pudo borrar cert viejo {old}: {_e}")

            logger.info(f"Firebase: cert/key escritos para perfil '{nombre_perfil}'")
            return str(cert_path), str(key_path)
        except Exception as e:
            logger.error(f"Firebase: error escribiendo cert local: {e}")
            return '', ''

    def _cleanup_orphan_certs(self, db_manager) -> int:
        """
        Borra de CERTS_DIR todos los .crt/.key que no estén referenciados por
        ningún perfil activo en la DB. Útil para limpiar certs viejos después
        de una actualización de perfiles. Devuelve cantidad de archivos borrados.
        """
        try:
            from pos_system.config import CERTS_DIR
            from pathlib import Path as _Path
            rows = db_manager.execute_query(
                "SELECT cert_path, key_path FROM perfiles_facturacion WHERE activo=1"
            ) or []
            referenciados = set()
            for r in rows:
                for p in (r.get('cert_path'), r.get('key_path')):
                    if p:
                        try:
                            referenciados.add(str(_Path(p).resolve()).lower())
                        except Exception:
                            referenciados.add(str(p).lower())

            borrados = 0
            for f in CERTS_DIR.glob('*'):
                if f.suffix.lower() not in ('.crt', '.key'):
                    continue
                if str(f.resolve()).lower() in referenciados:
                    continue
                try:
                    f.unlink()
                    borrados += 1
                    logger.info(f"Firebase: cert huérfano borrado: {f.name}")
                except Exception as _e:
                    logger.warning(f"Firebase: no se pudo borrar cert huérfano {f.name}: {_e}")
            if borrados:
                logger.info(f"Firebase: {borrados} cert/key huérfanos eliminados de CERTS_DIR.")
            return borrados
        except Exception as e:
            logger.error(f"Firebase: error en cleanup_orphan_certs: {e}")
            return 0

    def force_refresh_certs_oneshot(self, db_manager) -> bool:
        """
        Migración one-shot: borra TODOS los .crt/.key de CERTS_DIR y los rearma
        desde Firestore (colección perfiles_facturacion). Actualiza cert_path/
        key_path en la SQLite local. Solo se ejecuta una vez (flag en DATA_DIR).

        Sirve para resolver el caso en que la PC quedó con certs viejos con el
        mismo nombre de archivo que los nuevos, y el listener no los sobreescribió.

        Returns: True si se ejecutó, False si se salteó (ya corrió antes o falló).
        """
        if not self.enabled:
            return False
        try:
            from pos_system.config import DATA_DIR, CERTS_DIR
            flag_file = DATA_DIR / "certs_refreshed_v1.flag"
            if flag_file.exists():
                return False

            logger.info("Firebase: ejecutando one-shot refresh de certificados...")

            # 1. Borrar todos los .crt/.key existentes en CERTS_DIR
            borrados = 0
            for f in CERTS_DIR.glob('*'):
                if f.suffix.lower() in ('.crt', '.key') and f.is_file():
                    try:
                        f.unlink()
                        borrados += 1
                    except Exception as _e:
                        logger.warning(f"Firebase oneshot: no se pudo borrar {f.name}: {_e}")
            logger.info(f"Firebase oneshot: {borrados} archivos .crt/.key borrados.")

            # 2. Query one-shot a Firestore perfiles_facturacion activos
            docs = self.db.collection('perfiles_facturacion').stream()
            procesados = 0
            for doc in docs:
                d = doc.to_dict() or {}
                if not d.get('activo', True):
                    continue
                nombre   = d.get('nombre', '')
                cert_b64 = d.get('cert_content', '')
                key_b64  = d.get('key_content', '')
                fb_id    = doc.id

                if not (cert_b64 or key_b64):
                    logger.warning(f"Firebase oneshot: perfil '{nombre}' sin cert_content en Firestore, se saltea.")
                    continue

                cert_path, key_path = self._escribir_cert_local(nombre, cert_b64, key_b64)
                if not cert_path:
                    continue

                # 3. Actualizar cert_path/key_path en SQLite
                try:
                    db_manager.execute_update(
                        "UPDATE perfiles_facturacion SET cert_path=?, key_path=? WHERE firebase_id=?",
                        (cert_path, key_path, str(fb_id))
                    )
                except Exception as _e:
                    logger.warning(f"Firebase oneshot: error actualizando DB para '{nombre}': {_e}")
                procesados += 1

            # 4. Crear flag para no volver a correr
            try:
                flag_file.write_text(
                    f"oneshot ejecutado: {now_ar().isoformat()} | procesados={procesados}",
                    encoding='utf-8'
                )
            except Exception as _e:
                logger.warning(f"Firebase oneshot: no se pudo crear flag: {_e}")

            logger.info(f"Firebase oneshot: refresh completado, {procesados} perfiles reescritos.")
            return True
        except Exception as e:
            logger.error(f"Firebase: error en force_refresh_certs_oneshot: {e}")
            return False

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

            fb_doc_id = doc_data.get('id') or doc_data.get('_docId', '')
            existing = db_manager.execute_query(
                "SELECT id, cert_path, key_path FROM perfiles_facturacion WHERE firebase_id=?",
                (str(fb_doc_id),)
            ) if fb_doc_id else []

            old_cert = existing[0].get('cert_path', '') if existing else ''
            old_key  = existing[0].get('key_path', '')  if existing else ''

            # Si vienen los archivos en base64, escribirlos localmente (y borrar los viejos del mismo perfil)
            if cert_b64 or key_b64:
                cert_path, key_path = self._escribir_cert_local(
                    nombre, cert_b64, key_b64, old_cert, old_key
                )
            else:
                cert_path = doc_data.get('cert_path', '')
                key_path  = doc_data.get('key_path', '')

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

                # Limpiar certs huérfanos en CERTS_DIR (de perfiles renombrados/desactivados)
                try:
                    self._cleanup_orphan_certs(db_manager)
                except Exception as _e:
                    logger.warning(f"Firebase: cleanup de certs falló: {_e}")

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

    def _cliente_doc_id(self, cliente: dict) -> str:
        """Genera un doc_id estable para un cliente: usa CUIT si está cargado
        (compartible entre PCs sin colision), si no usa un prefijo con la PC + id local."""
        cuit = str(cliente.get('cuit', '') or '').replace('-', '').replace(' ', '').strip()
        if cuit and cuit.isdigit() and len(cuit) >= 7:
            return f'cuit-{cuit}'
        local_id = cliente.get('id')
        if local_id is not None:
            return f'pc-{_get_pc_id()}-{local_id}'
        # ultimo recurso: timestamp + random
        return f'pc-{_get_pc_id()}-{int(now_ar().timestamp() * 1000)}'

    def sync_cliente_individual(self, cliente: dict, db_manager=None):
        """Sube un único cliente a Firestore en background. Idempotente:
        usa CUIT como doc_id cuando está disponible para que distintas PCs
        compartan el mismo registro. Persiste el firebase_id en la fila local
        para que el listener pueda hacer UPDATE en futuras ediciones."""
        if not self.enabled:
            return
        def _do():
            try:
                doc_id = self._cliente_doc_id(cliente)
                payload = {
                    'id':            cliente.get('id'),
                    'nombre':        cliente.get('nombre', ''),
                    'razon_social':  cliente.get('razon_social', ''),
                    'cuit':          cliente.get('cuit', ''),
                    'domicilio':     cliente.get('domicilio', ''),
                    'localidad':     cliente.get('localidad', ''),
                    'condicion_iva': cliente.get('condicion_iva', 'Consumidor Final'),
                    'activo':        True,
                    'updated_at':    now_ar_iso(),
                    'pc_origen':     _get_pc_id(),
                }
                self.db.collection('clientes_facturacion').document(doc_id).set(
                    payload, merge=True
                )
                # Persistir el firebase_id local para que el listener no
                # vuelva a insertarlo como duplicado.
                if db_manager is not None and cliente.get('id'):
                    try:
                        db_manager.execute_update(
                            "UPDATE clientes_facturacion SET firebase_id=? WHERE id=?",
                            (doc_id, cliente['id'])
                        )
                    except Exception as _e:
                        logger.debug(f"No se pudo persistir firebase_id local: {_e}")
                logger.info(f"Firebase: cliente '{cliente.get('nombre','')}' sincronizado ({doc_id}).")
            except Exception as e:
                logger.error(f"Firebase: error sincronizando cliente individual: {e}")
        self._run(_do)

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
                    doc_id = self._cliente_doc_id(c)
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
                        'pc_origen':    _get_pc_id(),
                    }, merge=True)
                    # Mantener referencia local del firebase_id para el listener
                    try:
                        db_manager.execute_update(
                            "UPDATE clientes_facturacion SET firebase_id=? WHERE id=?",
                            (doc_id, c['id'])
                        )
                    except Exception:
                        pass
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

    # ══════════════════════════════════════════════════
    #  REFRESH PUNTUAL DE UN PRODUCTO
    # ══════════════════════════════════════════════════
    def refresh_product_from_firestore(self, db_manager, firebase_id: str,
                                        timeout: float = 2.5) -> bool:
        """Baja un producto puntual del catálogo y refresca SQLite local.

        Pensado para garantizar el dato más fresco antes de operar con un
        producto (ej. abrir Vender Conjunto). Bloquea hasta 'timeout' segundos.
        Solo actualiza campos que cambian con ventas: stock, price, conjunto_*.

        Devuelve True si pudo aplicar el refresh, False si timeout/error.
        """
        if not self.enabled or not firebase_id:
            return False
        try:
            done = threading.Event()
            doc_holder, err_holder = {}, {}

            def _fetch():
                try:
                    doc_holder['doc'] = self.db.collection('catalogo').document(
                        str(firebase_id)
                    ).get()
                except Exception as ex:
                    err_holder['err'] = ex
                finally:
                    done.set()

            threading.Thread(target=_fetch, daemon=True).start()
            done.wait(timeout=timeout)
            if not done.is_set():
                logger.debug(f"refresh_product: timeout ({timeout}s) fb_id={firebase_id}")
                return False
            if err_holder.get('err') is not None:
                logger.debug(f"refresh_product: error fetch: {err_holder['err']}")
                return False
            doc = doc_holder.get('doc')
            if doc is None or not doc.exists:
                return False
            d = doc.to_dict() or {}

            # Convertir conjunto_colores (lista de dicts) a JSON string para SQLite
            colores_raw = d.get('conjunto_colores')
            colores_json = None
            if isinstance(colores_raw, list) and colores_raw:
                try:
                    import json as _json
                    def _norm_c(c):
                        out = {
                            'color':    str(c.get('color', '') or ''),
                            'unidades': float(c.get('unidades') or 0),
                            'restante': float(c.get('restante') or 0),
                        }
                        pr = c.get('precio')
                        try:
                            pr_f = float(pr) if pr is not None else 0.0
                        except (TypeError, ValueError):
                            pr_f = 0.0
                        if pr_f > 0:
                            out['precio'] = pr_f
                        return out
                    colores_json = _json.dumps(
                        [_norm_c(c) for c in colores_raw if isinstance(c, dict)],
                        ensure_ascii=False,
                    )
                except Exception:
                    colores_json = None

            def _to_float(v):
                try:
                    return float(v)
                except (TypeError, ValueError):
                    return None

            stock      = int(_to_float(d.get('stock')) or 0)
            price      = float(_to_float(
                d.get('precio_venta') or d.get('precio') or d.get('price')
            ) or 0)
            c_unidades = _to_float(d.get('conjunto_unidades'))
            c_restante = _to_float(d.get('conjunto_restante'))
            c_total    = _to_float(d.get('conjunto_total'))
            c_contenido= _to_float(d.get('conjunto_contenido'))
            c_pu       = _to_float(d.get('conjunto_precio_unidad'))

            try:
                db_manager.execute_update(
                    """UPDATE products SET
                          stock = ?,
                          price = ?,
                          conjunto_unidades      = COALESCE(?, conjunto_unidades),
                          conjunto_restante      = COALESCE(?, conjunto_restante),
                          conjunto_total         = COALESCE(?, conjunto_total),
                          conjunto_contenido     = COALESCE(?, conjunto_contenido),
                          conjunto_precio_unidad = COALESCE(?, conjunto_precio_unidad),
                          conjunto_colores       = ?,
                          updated_at = (SELECT localtime_now())
                       WHERE firebase_id = ?""",
                    (stock, price, c_unidades, c_restante, c_total,
                     c_contenido, c_pu, colores_json, str(firebase_id))
                )
                return True
            except Exception as ex:
                logger.warning(f"refresh_product: error UPDATE local: {ex}")
                return False
        except Exception as e:
            logger.warning(f"refresh_product: {e}")
            return False

    # ══════════════════════════════════════════════════
    #  MIGRACION cierres_caja → esquema compartido
    # ══════════════════════════════════════════════════
    def migrate_cierres_caja_compartido_async(self):
        """Lanza la migracion en background — no bloquea el startup."""
        if not self.enabled:
            return
        threading.Thread(
            target=self._migrate_cierres_caja_compartido,
            daemon=True
        ).start()

    def _migrate_cierres_caja_compartido(self):
        """Consolida docs viejos `cierres_caja/{pc_id}_{register_id}` (uno por PC)
        en docs nuevos `cierres_caja/{register_id}` (uno compartido por caja).

        Idempotente: si no hay docs viejos, sale silencioso. Si dos PCs corren
        esto al mismo tiempo, las operaciones son seguras (set merge=True +
        delete son idempotentes en Firestore).

                Solo migra cajas ABIERTAS (sin fecha_cierre). Los cierres historicos
        cerrados quedan intactos.
        """
        try:
            from google.cloud.firestore_v1.base_query import FieldFilter
            # Solo OPEN: fecha_cierre vacia. Filtramos en memoria por '_' en doc id.
            try:
                snap = list(self.db.collection('cierres_caja')
                            .where(filter=FieldFilter('fecha_cierre', '==', '')).stream())
            except Exception:
                # fallback sin filtro server-side
                snap = list(self.db.collection('cierres_caja').stream())
                snap = [d for d in snap if not (d.to_dict() or {}).get('fecha_cierre')]

            per_pc = []   # docs viejos formato {pc}_{rid}
            shared = {}   # rid -> doc compartido ya existente
            for d in snap:
                data = d.to_dict() or {}
                rid = data.get('register_id')
                if rid is None:
                    continue
                if '_' in d.id:
                    per_pc.append((d.id, data, rid))
                else:
                    shared[str(rid)] = (d.id, data)

            if not per_pc:
                return  # nada para migrar — exit rapido

            grupos = {}
            for doc_id, data, rid in per_pc:
                grupos.setdefault(str(rid), []).append((doc_id, data))

            logger.info(f"Firebase: migrando {len(grupos)} caja(s) abierta(s) "
                        f"({len(per_pc)} doc(s) viejos) a esquema compartido...")

            for rid, items in grupos.items():
                # Base = doc compartido si existe, sino el primero per-PC
                if rid in shared:
                    consolidated = dict(shared[rid][1])
                else:
                    consolidated = dict(items[0][1])

                ap_min = self._parse_dt(consolidated.get('fecha_apertura'))
                cajeros = set()
                if consolidated.get('cajero'):
                    for c in str(consolidated['cajero']).split(','):
                        c = c.strip()
                        if c:
                            cajeros.add(c)
                retiros = list(consolidated.get('retiros') or [])
                total_retiros = float(consolidated.get('total_retiros', 0) or 0)
                monto_inicial = float(consolidated.get('monto_inicial', 0) or 0)

                for doc_id, data in items:
                    ap = self._parse_dt(data.get('fecha_apertura'))
                    if ap and (not ap_min or ap < ap_min):
                        ap_min = ap
                        consolidated['fecha_apertura'] = data.get('fecha_apertura')
                    if data.get('cajero'):
                        for c in str(data['cajero']).split(','):
                            c = c.strip()
                            if c:
                                cajeros.add(c)
                    for r in (data.get('retiros') or []):
                        retiros.append(r)
                    total_retiros += float(data.get('total_retiros', 0) or 0)
                    if not monto_inicial:
                        monto_inicial = float(data.get('monto_inicial', 0) or 0)

                consolidated['cajero'] = ', '.join(sorted(cajeros)) if cajeros else ''
                consolidated['retiros'] = retiros
                consolidated['total_retiros'] = total_retiros
                consolidated['monto_inicial'] = monto_inicial
                consolidated['register_id'] = int(rid)
                consolidated['fecha_cierre'] = ''
                consolidated.pop('pc_id', None)

                # Escribir doc compartido (merge para no pisar campos)
                self.db.collection('cierres_caja').document(rid).set(consolidated, merge=True)
                # Borrar los per-PC
                for doc_id, _ in items:
                    try:
                        self.db.collection('cierres_caja').document(doc_id).delete()
                    except Exception:
                        pass
                logger.info(f"Firebase: caja #{rid} consolidada — borrados {len(items)} doc(s) viejo(s).")

            logger.info("Firebase: migracion cierres_caja completada.")
        except Exception as e:
            # No es critico — el dedupe en el webapp ya maneja el caso transitorio.
            logger.warning(f"Firebase: migracion cierres_caja falló (no crítico): {e}")


def _month_name(dt: datetime) -> str:
    months = ['enero','febrero','marzo','abril','mayo','junio',
              'julio','agosto','septiembre','octubre','noviembre','diciembre']
    return f"{months[dt.month - 1]} {dt.year}"
