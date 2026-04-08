"""
Firebase Firestore Sync para Sistema POS.
Sube ventas, inventario, cierres de caja, historial diario y
productos más vendidos a Firestore en tiempo real.
También escucha cambios en tiempo real desde la web (inventario).
"""

import threading
import logging
from datetime import datetime
from typing import Optional, Callable

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
            candidates = [
                os.path.join(os.path.dirname(__file__), '..', '..', 'firebase_key.json'),
                os.path.join(os.path.dirname(__file__), '..', '..', '_internal', 'firebase_key.json'),
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
            return val
        if not val:
            return datetime.now()
        for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M:%S.%f', '%Y-%m-%dT%H:%M:%S', '%d/%m/%Y %H:%M'):
            try:
                return datetime.strptime(str(val), fmt)
            except ValueError:
                pass
        return datetime.now()

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
                doc = {
                    'sale_id':       int(sale_id),
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
                self.db.collection('ventas').document(sale_id).set(doc, merge=True)
                logger.debug(f"Firebase: Venta #{sale_id} sincronizada.")
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

                logger.info(f"Firebase: Inventario sincronizado ({len(products)} productos, {deleted} eliminados).")
            except Exception as e:
                logger.error(f"Firebase: Error sincronizando inventario: {e}")
        self._run(_do)

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
                    _date = datetime.now()
                else:
                    _date = date
                total        = sum(float(s.get('total_amount', 0) or 0) for s in sales)
                efectivo     = sum(float(s.get('total_amount', 0) or 0) for s in sales if s.get('payment_type') == 'cash')
                transferencia = total - efectivo
                n            = len(sales)
                promedio     = total / n if n > 0 else 0
                fecha_str    = _date.strftime('%d/%m/%Y')
                doc_id       = _date.strftime('%Y-%m-%d')

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
                for idx, item in enumerate(items):
                    doc_id = f"{sale_id}_{idx}"
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
                doc_id = f"{year}-{month:02d}"
                
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
                    'num_ventas': n,
                    'total': total,
                    'efectivo': efectivo,
                    'transferencia': transferencia,
                    'descuentos_total': descuentos,
                    'ticket_promedio': promedio,
                    'top_productos': top_lista,
                    'actualizado': datetime.now(),
                }, merge=True)
                logger.debug(f"Firebase: Resumen mensual {month_name} sincronizado.")
            except Exception as e:
                logger.error(f"Firebase: Error sincronizando resumen mensual: {e}")
        self._run(_do)

    # ══════════════════════════════════════════════════
    #  CIERRES DE CAJA
    # ══════════════════════════════════════════════════
    def sync_cash_closing(self, report: dict):
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

                self.db.collection('cierres_caja').document(register_id).set({
                    'register_id':           int(register_id),
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

    def download_precios_actualizados(self, progress_cb=None) -> list:
        """
        Descarga la colección 'productos_remotos' (precios y datos actualizados desde la web).
        Retorna lista de dicts con datos actualizados.
        """
        if not self.enabled:
            return []
        try:
            col = self.db.collection('productos_remotos')
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


def _month_name(dt: datetime) -> str:
    months = ['enero','febrero','marzo','abril','mayo','junio',
              'julio','agosto','septiembre','octubre','noviembre','diciembre']
    return f"{months[dt.month - 1]} {dt.year}"
