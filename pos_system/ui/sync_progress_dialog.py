"""
Diálogo visual de progreso de sincronización con la nube.
Muestra en tiempo real qué datos se están subiendo o descargando.
Incluye menú para elegir Subir Datos o Descargar Datos.
"""
from PyQt5.QtWidgets import (QDialog, QVBoxLayout, QHBoxLayout, QLabel,
                              QProgressBar, QTextEdit, QPushButton, QWidget,
                              QFrame, QApplication, QSizePolicy, QMenu, QAction)
from PyQt5.QtCore import Qt, pyqtSignal, QThread, QTimer
from PyQt5.QtGui import QFont, QColor, QTextCursor
import logging

logger = logging.getLogger(__name__)


class DownloadWorker(QThread):
    """Hilo que descarga datos desde Firebase y los aplica a la BD local."""
    progress     = pyqtSignal(int, int)      # (actual, total_pasos)
    pct_detail   = pyqtSignal(int, int, str) # (actual_items, total_items, mensaje)
    log_message  = pyqtSignal(str, str)      # (mensaje, tipo)
    step_changed = pyqtSignal(str)           # descripción del paso
    finished     = pyqtSignal(bool, str)     # (exito, mensaje_final)

    TOTAL_STEPS = 4

    def __init__(self, main_window):
        super().__init__()
        self.main_window = main_window

    # ── Helpers de fecha ─────────────────────────────────────────────────
    @staticmethod
    def _parse_fecha(val) -> float:
        """Convierte cualquier representación de fecha a timestamp float (0 si falla)."""
        if val is None:
            return 0.0
        from datetime import datetime, timezone
        # Firestore Timestamp object
        if hasattr(val, 'timestamp'):
            try:
                return float(val.timestamp())
            except Exception:
                pass
        if isinstance(val, datetime):
            return val.timestamp()
        for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M:%S.%f',
                    '%Y-%m-%dT%H:%M:%S', '%d/%m/%Y %H:%M', '%d/%m/%Y', '%Y-%m-%d'):
            try:
                return datetime.strptime(str(val).strip(), fmt).timestamp()
            except ValueError:
                pass
        return 0.0

    def run(self):
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            from pos_system.database.db_manager import DatabaseManager

            fb = get_firebase_sync()
            if not fb or not fb.enabled:
                self.finished.emit(False, 'Firebase no está configurado.')
                return

            db = DatabaseManager()
            step = 0

            # ── PASO 1: Conectar y obtener mapa local de productos ────────
            self.step_changed.emit('Conectando con Firebase y leyendo base local...')
            self.log_message.emit('Conectando con Firebase...', 'info')
            self.progress.emit(step, self.TOTAL_STEPS)

            # Construir índice local: por firebase_id, id, barcode y nombre
            # Se incluyen price, stock, barcode, firebase_id para evitar queries individuales después
            local_rows = db.execute_query(
                "SELECT id, name, barcode, firebase_id, updated_at, price, stock FROM products"
            )
            local_by_firebase_id = {}
            local_by_id          = {}
            local_by_barcode     = {}
            local_by_name        = {}
            # Caché completo por id local para comparar sin queries adicionales
            local_data_by_id     = {}
            for row in local_rows:
                ts = self._parse_fecha(row.get('updated_at'))
                lid = row.get('id')
                if row.get('firebase_id'):
                    local_by_firebase_id[str(row['firebase_id'])] = (lid, ts)
                if lid:
                    local_by_id[str(lid)] = ts
                    local_data_by_id[lid] = {
                        'price':       float(row.get('price') or 0),
                        'stock':       int(row.get('stock') or 0),
                        'barcode':     str(row.get('barcode') or ''),
                        'firebase_id': str(row.get('firebase_id') or ''),
                        'ts':          ts,
                    }
                if row.get('barcode'):
                    local_by_barcode[str(row['barcode'])] = (lid, ts)
                if row.get('name'):
                    local_by_name[str(row['name']).lower()] = (lid, ts)

            self.log_message.emit(
                f'Base local: {len(local_rows)} productos indexados', 'info')

            # ── PASO 2: Descargar Rubros/Categorías ──────────────────────
            step = 1
            self.step_changed.emit('Sincronizando rubros y categorías...')
            self.log_message.emit('Descargando rubros desde Firebase...', 'info')
            self.progress.emit(step, self.TOTAL_STEPS)

            rubros_nuevos = 0
            rubros = fb.download_rubros(
                progress_cb=lambda cur, tot, msg: self.pct_detail.emit(cur, max(tot, 1), msg)
            )
            if rubros:
                # Obtener rubros ya existentes localmente (comparación case-insensitive)
                existing_cats = {
                    r['name'].strip().upper()
                    for r in db.execute_query("SELECT name FROM categories")
                }
                for rubro in rubros:
                    rubro_name = str(rubro).strip()
                    if not rubro_name:
                        continue
                    # Si ya existe en cualquier capitalización, no insertar
                    if rubro_name.upper() in existing_cats:
                        continue
                    # Si existe una versión con distinta capitalización, actualizar a la de Firebase
                    duplicado = db.execute_query(
                        "SELECT id FROM categories WHERE UPPER(name) = UPPER(?)",
                        (rubro_name,)
                    )
                    if duplicado:
                        # Actualizar al nombre canónico de Firebase (mayúsculas)
                        db.execute_update(
                            "UPDATE categories SET name = ? WHERE id = ?",
                            (rubro_name, duplicado[0]['id'])
                        )
                        existing_cats.add(rubro_name.upper())
                    else:
                        try:
                            db.execute_update(
                                "INSERT OR IGNORE INTO categories (name) VALUES (?)",
                                (rubro_name,)
                            )
                            rubros_nuevos += 1
                            existing_cats.add(rubro_name.upper())
                        except Exception:
                            pass
                self.log_message.emit(
                    f'{len(rubros)} rubros en Firebase — {rubros_nuevos} nuevos agregados', 'ok')
            else:
                self.log_message.emit(
                    'ℹ️ No se encontraron rubros en Firebase (colección "rubros")', 'warn')

            # ── PASO 3: Inventario — solo novedades ───────────────────────
            step = 2
            self.step_changed.emit('Descargando productos nuevos/actualizados...')
            self.log_message.emit('Comparando inventario Firebase vs local...', 'info')
            self.progress.emit(step, self.TOTAL_STEPS)

            productos_nuevos      = 0
            productos_actualizados = 0
            productos_sin_cambios  = 0

            # Descargar desde 'catalogo' (tiene precio_venta correcto) en lugar de 'inventario'
            try:
                all_docs = list(fb.db.collection('catalogo').stream())
                productos_fb = []
                for d in all_docs:
                    data = d.to_dict()
                    if data:
                        data['doc_id'] = d.id  # Guardar el ID del documento de Firebase
                        productos_fb.append(data)
                self.log_message.emit(f'{len(productos_fb)} productos encontrados en catálogo Firebase.', 'info')
            except Exception as e_cat:
                self.log_message.emit(f'Error leyendo catálogo, usando inventario: {e_cat}', 'warn')
                productos_fb = fb.download_products(
                    progress_cb=lambda cur, tot, msg: self.pct_detail.emit(cur, max(tot, 1), msg)
                )

            total_fb = len(productos_fb)
            for i, p in enumerate(productos_fb):
                # firebase_id = doc_id del documento en Firestore (identificador único)
                firebase_id = str(p.get('doc_id') or p.get('_doc_id') or '').strip()
                # pos_id = ID numérico único asignado a cada producto
                pos_id  = p.get('pos_id')
                pid     = str(p.get('id') or p.get('codigo') or '').strip()
                nombre  = str(p.get('nombre') or p.get('name') or '').strip()
                if not nombre:
                    continue

                # precio_venta es el campo correcto en 'catalogo'; fallback a precio/price
                precio  = float(p.get('precio_venta') or p.get('precio') or p.get('price') or 0)
                costo   = float(p.get('costo') or p.get('cost') or 0)
                stock   = int(p.get('stock') or 0)
                cat     = str(p.get('categoria') or p.get('category') or '').strip() or 'Sin categoría'
                rubro   = str(p.get('rubro') or '').strip() or None
                barcode = str(p.get('cod_barra') or p.get('barcode') or p.get('codigo_barra') or '').strip() or None
                desc    = float(p.get('descuento') or p.get('discount') or 0)
                estado  = str(p.get('estado') or 'activo').lower()

                # Saltar productos sin precio o inactivos
                if precio <= 0 or estado == 'sin_precio':
                    continue

                # NOTA: NO insertar cat en categories — esa tabla es solo para RUBROS.

                # ── Buscar si ya existe localmente ────────────────────────
                # Prioridad: 1) firebase_id (más confiable), 2) barcode, 3) nombre
                local_id = None

                if firebase_id and firebase_id in local_by_firebase_id:
                    local_id, _ = local_by_firebase_id[firebase_id]
                elif pid and pid in local_by_id:
                    local_id = int(pid)
                elif barcode and barcode in local_by_barcode:
                    local_id, _ = local_by_barcode[barcode]
                elif nombre.lower() in local_by_name:
                    local_id, _ = local_by_name[nombre.lower()]

                # ── Decidir si actualizar comparando valores reales (sin query extra) ──
                if local_id is not None:
                    lr = local_data_by_id.get(local_id)
                    if lr and (abs(lr['price'] - precio) < 0.01
                               and lr['stock'] == stock
                               and lr['barcode'] == str(barcode or '')
                               and lr['firebase_id'] == firebase_id):
                        productos_sin_cambios += 1
                        continue

                    db.execute_update("""
                        UPDATE products SET
                            name = ?, price = ?, cost = ?, stock = ?,
                            category = ?, barcode = ?, discount_value = ?,
                            firebase_id = ?, rubro = ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    """, (nombre, precio, costo, stock, cat, barcode, desc, firebase_id, rubro, local_id))
                    productos_actualizados += 1
                    # Actualizar índices y caché local
                    local_by_firebase_id[firebase_id] = (local_id, 9999999999.0)
                    local_by_id[str(local_id)] = 9999999999.0
                    local_data_by_id[local_id] = {
                        'price': precio, 'stock': stock,
                        'barcode': str(barcode or ''), 'firebase_id': firebase_id,
                        'ts': 9999999999.0,
                    }
                else:
                    # Producto nuevo — insertar con firebase_id
                    try:
                        db.execute_update("""
                            INSERT OR IGNORE INTO products
                                (name, price, cost, stock, category,
                                 barcode, discount_value, firebase_id, rubro,
                                 created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                        """, (nombre, precio, costo, stock, cat, barcode, desc, firebase_id or None, rubro))
                        productos_nuevos += 1
                    except Exception:
                        pass

                # Emitir progreso detallado cada 5 productos
                if (i + 1) % 5 == 0 or (i + 1) == total_fb:
                    self.pct_detail.emit(i + 1, max(total_fb, 1),
                                         f'{i+1}/{total_fb} — {productos_nuevos} nuevos, '
                                         f'{productos_actualizados} actualizados, '
                                         f'{productos_sin_cambios} sin cambios')

            self.log_message.emit(
                f'Inventario: {productos_nuevos} nuevos · '
                f'{productos_actualizados} actualizados · '
                f'{productos_sin_cambios} ya estaban al día '
                f'(total Firebase: {total_fb})', 'ok')

            # ── PASO 4: Precios remotos — solo novedades ──────────────────
            step = 3
            self.step_changed.emit('Aplicando precios y datos actualizados...')
            self.log_message.emit('Descargando precios actualizados (productos_remotos)...', 'info')
            self.progress.emit(step, self.TOTAL_STEPS)

            remotos = fb.download_precios_actualizados(
                progress_cb=lambda cur, tot, msg: self.pct_detail.emit(cur, max(tot, 1), msg)
            )
            precios_actualizados = 0
            precios_sin_cambios  = 0

            for p in remotos:
                nombre  = str(p.get('nombre') or p.get('name') or '').strip()
                barcode = str(p.get('barcode') or p.get('codigo_barra') or '').strip() or None
                precio  = p.get('precio') or p.get('price')
                costo   = p.get('costo') or p.get('cost')
                stock   = p.get('stock')
                cat     = str(p.get('categoria') or p.get('category') or '').strip() or None
                pid     = str(p.get('id') or '').strip()
                fb_ts   = self._parse_fecha(
                    p.get('ultima_actualizacion') or p.get('updated_at'))

                # Buscar id local
                target_id = None
                local_ts  = 0.0
                if pid and pid in local_by_id:
                    target_id = int(pid)
                    local_ts  = local_by_id[pid]
                elif barcode and barcode in local_by_barcode:
                    target_id, local_ts = local_by_barcode[barcode]
                elif nombre and nombre.lower() in local_by_name:
                    target_id, local_ts = local_by_name[nombre.lower()]

                necesita_update = (fb_ts == 0.0) or (fb_ts > local_ts)

                if target_id and not necesita_update:
                    precios_sin_cambios += 1
                    continue

                # Construir SET dinámico solo con campos presentes
                updates, vals = [], []
                if precio is not None:
                    updates.append("price = ?");    vals.append(float(precio))
                if costo is not None:
                    updates.append("cost = ?");     vals.append(float(costo))
                if stock is not None:
                    updates.append("stock = ?");    vals.append(int(stock))
                if cat:
                    updates.append("category = ?"); vals.append(cat)
                    # NOTA: NO insertar cat en categories — esa tabla es solo para RUBROS.
                if barcode:
                    updates.append("barcode = ?");  vals.append(barcode)
                updates.append("updated_at = CURRENT_TIMESTAMP")

                if not nombre:
                    continue

                sql_set = ', '.join(updates)

                if target_id:
                    db.execute_update(
                        f"UPDATE products SET {sql_set} WHERE id = ?",
                        tuple(vals) + (target_id,)
                    )
                    precios_actualizados += 1
                else:
                    # Crear si no existe y tiene precio
                    if precio is not None:
                        try:
                            db.execute_update("""
                                INSERT OR IGNORE INTO products
                                    (name, price, cost, stock, category, barcode,
                                     created_at, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                            """, (nombre, float(precio or 0), float(costo or 0),
                                  int(stock or 0), cat, barcode))
                            precios_actualizados += 1
                        except Exception:
                            pass

            if remotos:
                self.log_message.emit(
                    f'productos_remotos: {precios_actualizados} actualizados · '
                    f'{precios_sin_cambios} sin cambios', 'ok')
            else:
                self.log_message.emit(
                    'ℹ️ No hay datos en "productos_remotos"', 'warn')

            # ── FINALIZAR ────────────────────────────────────────────────
            step = self.TOTAL_STEPS
            self.progress.emit(step, self.TOTAL_STEPS)
            self.step_changed.emit('Descarga completada')

            resumen = (
                f'Descarga incremental exitosa — '
                f'{rubros_nuevos} rubros nuevos · '
                f'{productos_nuevos} productos nuevos · '
                f'{productos_actualizados + precios_actualizados} actualizados · '
                f'{productos_sin_cambios + precios_sin_cambios} ya estaban al día'
            )
            self.log_message.emit('', 'info')
            self.log_message.emit('══════════════════════════════════════', 'ok')
            self.log_message.emit(f'{resumen}', 'ok')
            self.log_message.emit('══════════════════════════════════════', 'ok')
            self.finished.emit(True, resumen)

        except Exception as e:
            logger.error(f"Error en descarga Firebase: {e}")
            self.log_message.emit(f'Error: Error inesperado: {e}', 'error')
            self.finished.emit(False, str(e))


class SyncWorker(QThread):
    """Hilo que ejecuta la sincronización y emite señales de progreso."""
    progress      = pyqtSignal(int, int)     # (actual, total)
    pct_detail    = pyqtSignal(int, int, str) # (actual_items, total_items, mensaje)
    log_message   = pyqtSignal(str, str)     # (mensaje, tipo: 'info'|'ok'|'error'|'warn')
    step_changed  = pyqtSignal(str)          # descripción del paso actual
    finished      = pyqtSignal(bool, str)    # (exito, mensaje_final)

    def __init__(self, main_window, full_history=True):
        super().__init__()
        self.main_window = main_window
        self.full_history = full_history

    def run(self):
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            from pos_system.models.sale import Sale
            from pos_system.models.cash_register import CashRegister
            from pos_system.database.db_manager import DatabaseManager
            from collections import defaultdict
            from datetime import datetime

            fb = get_firebase_sync()
            if not fb or not fb.enabled:
                self.finished.emit(False, 'Firebase no está configurado.')
                return

            db = DatabaseManager()
            sale_model = Sale(db)
            register_model = CashRegister(db)
            firedb = fb.db

            # ── PASO 1: Inventario ──────────────────────────────────────────
            self.step_changed.emit('Sincronizando inventario...')
            self.log_message.emit('Obteniendo productos del inventario...', 'info')
            products = self.main_window.product_model.get_all()
            fb.sync_inventory(products)
            self.log_message.emit(f'Inventario sincronizado — {len(products)} productos', 'ok')
            self.progress.emit(1, 5)

            # ── PASO 2: Ventas ──────────────────────────────────────────────
            all_sales = sale_model.get_all()

            # Cargar mapa user_id -> full_name para resolver nombres
            users_rows = db.execute_query("SELECT id, username, full_name FROM users")
            user_names = {str(u['id']): (u.get('full_name') or u.get('username', '')) for u in (users_rows or [])}

            sales_by_day = defaultdict(list)
            for s in all_sales:
                dt = fb._parse_dt(s.get('created_at'))
                day_key = dt.strftime('%Y-%m-%d')
                sales_by_day[day_key].append(s)
                # Resolver nombre real del cajero: turno_nombre > full_name > username > user_id
                turno = s.get('turno_nombre') or ''
                if turno:
                    s['username'] = turno
                    s['cajero']   = turno
                elif not s.get('username') or s.get('username') == str(s.get('user_id', '')):
                    uid = str(s.get('user_id', ''))
                    s['username'] = user_names.get(uid, uid)
                    s['cajero']   = s['username']
                else:
                    s['cajero'] = s.get('cajero') or s['username']

            self.step_changed.emit(f'Subiendo {len(all_sales)} ventas a Firebase...')
            self.log_message.emit(f'Sincronizando {len(all_sales)} ventas...', 'info')

            total_ventas = len(all_sales)
            batch = firedb.batch()
            count = 0
            for i, s in enumerate(all_sales):
                sale_id = str(s.get('id') or s.get('sale_id', ''))
                if not sale_id:
                    continue
                created_at = fb._parse_dt(s.get('created_at'))
                items = s.get('items') or []
                productos_str = ', '.join(
                    f"{it.get('product_name', it.get('name','?'))} x{it.get('quantity',1)}"
                    for it in items[:3]
                )
                if len(items) > 3:
                    productos_str += f' (+{len(items)-3} más)'
                ref = firedb.collection('ventas').document(sale_id)
                batch.set(ref, {
                    'sale_id':       int(sale_id),
                    'created_at':    created_at,
                    'payment_type':  s.get('payment_type', ''),
                    'total_amount':  float(s.get('total_amount', 0) or 0),
                    'cash_received': float(s.get('cash_received', 0) or 0),
                    'change_given':  float(s.get('change_given', 0) or 0),
                    'items_count':   len(items) if items else int(s.get('items_count', 0) or 0),
                    'productos':     productos_str,
                    'username':      s.get('username') or str(s.get('user_id', '')),
                    'cajero':        s.get('cajero') or s.get('username') or str(s.get('user_id', '')),
                    'discount':      float(s.get('discount', 0) or 0),
                })
                count += 1
                if count % 500 == 0:
                    batch.commit()
                    batch = firedb.batch()
                    self.log_message.emit(f'  → {count} ventas subidas...', 'info')

                # Detalle de items por venta
                fb.sync_sale_detail_by_day(s, db_manager=db)

                # Emitir progreso detallado cada 10 ventas
                if (i + 1) % 10 == 0 or (i + 1) == total_ventas:
                    self.pct_detail.emit(i + 1, max(total_ventas, 1),
                                         f'Venta {i+1} de {total_ventas}')
                if (i + 1) % 20 == 0 or (i + 1) == total_ventas:
                    self.log_message.emit(f'  → Ventas: {i+1}/{total_ventas}', 'info')

            batch.commit()
            self.log_message.emit(f'{count} ventas sincronizadas con sus items', 'ok')
            self.progress.emit(2, 5)

            # ── PASO 3: Historial diario ────────────────────────────────────
            self.step_changed.emit(f'Subiendo resúmenes de {len(sales_by_day)} días...')
            self.log_message.emit(f'Sincronizando historial de {len(sales_by_day)} días...', 'info')
            for day_key in sorted(sales_by_day.keys()):
                dt = datetime.strptime(day_key, '%Y-%m-%d')
                fb.sync_daily_summary(sales_by_day[day_key], date=dt)
                self.log_message.emit(
                    f'  → {dt.strftime("%d/%m/%Y")} — {len(sales_by_day[day_key])} ventas', 'info')
            self.log_message.emit('Historial diario sincronizado', 'ok')
            self.progress.emit(3, 5)

            # ── PASO 4: Cierres de caja + caja abierta actual ───────────────
            all_registers = register_model.get_all(status='closed', limit=200)
            self.step_changed.emit(f'Subiendo {len(all_registers)} cierres de caja...')
            self.log_message.emit(f'Sincronizando {len(all_registers)} cierres de caja...', 'info')
            for reg in all_registers:
                closing_report = register_model.get_closing_report(reg['id'])
                fb.sync_cash_closing(closing_report)
            self.log_message.emit(f'{len(all_registers)} cierres sincronizados', 'ok')

            # Sincronizar también la caja abierta actualmente (si existe)
            caja_abierta = register_model.get_current()
            if caja_abierta:
                try:
                    reg_id = str(caja_abierta['id'])
                    apertura = fb._parse_dt(caja_abierta.get('opening_date'))
                    # Obtener usuario que abrió la caja
                    cajero = ''
                    if caja_abierta.get('opened_by_user_id'):
                        u = db.execute_query(
                            "SELECT username FROM users WHERE id = ?",
                            (caja_abierta['opened_by_user_id'],)
                        )
                        cajero = u[0]['username'] if u else ''
                    # Fallback: usuario actual del main_window
                    if not cajero:
                        try:
                            mw = self.main_window
                            cajero = (mw.current_user or {}).get('username', '') or (mw.current_user or {}).get('name', '')
                        except Exception:
                            pass
                    # Retiros de esta caja
                    retiros_list = register_model.get_withdrawals(caja_abierta['id'])
                    retiros_fb = [{'amount': float(w.get('amount', 0)), 'reason': w.get('reason', ''), 'created_at': str(w.get('created_at', ''))} for w in retiros_list]
                    fb.db.collection('cierres_caja').document(reg_id).set({
                        'register_id':           int(reg_id),
                        'fecha_apertura':        apertura,
                        'fecha_cierre':          None,
                        'monto_inicial':         float(caja_abierta.get('initial_amount', 0)),
                        'total_ventas':          float(caja_abierta.get('total_sales', 0)),
                        'total_efectivo':        float(caja_abierta.get('cash_sales', 0)),
                        'total_transferencia':   float(caja_abierta.get('transfer_sales', 0)),
                        'total_retiros':         float(caja_abierta.get('withdrawals', 0)),
                        'total_transacciones':   0,
                        'cajero':                cajero,
                        'estado':                'abierta',
                        'retiros':               retiros_fb,
                    }, merge=True)
                    self.log_message.emit('Caja abierta sincronizada con Firebase', 'ok')
                except Exception as e_caja:
                    self.log_message.emit(f'Aviso: no se pudo sincronizar caja abierta: {e_caja}', 'warn')

            self.progress.emit(4, 5)

            # ── PASO 5: Top productos + resumen mensual ─────────────────────
            self.step_changed.emit('Actualizando rankings y resúmenes mensuales...')
            self.log_message.emit('Calculando top productos más vendidos...', 'info')
            fb.sync_top_products(db)
            self.log_message.emit('Top productos actualizado', 'ok')

            # Resumen mensual por cada mes con ventas
            meses = defaultdict(list)
            for s in all_sales:
                dt = fb._parse_dt(s.get('created_at'))
                meses[(dt.year, dt.month)].append(s)
            for (year, month), month_sales in meses.items():
                fb.sync_monthly_summary(year, month, month_sales, db_manager=db)
                self.log_message.emit(f'  → Resumen mensual {month:02d}/{year} actualizado', 'info')
            self.log_message.emit('Resúmenes mensuales sincronizados', 'ok')
            self.progress.emit(5, 5)

            self.step_changed.emit('Sincronización completada')
            self.finished.emit(True, 'Sincronización con Firebase completada correctamente.')

        except Exception as e:
            logger.error(f"Error en sync Firebase: {e}")
            self.log_message.emit(f'Error: Error: {e}', 'error')
            self.finished.emit(False, str(e))


class SyncProgressDialog(QDialog):
    """
    Diálogo genérico de progreso para subir O descargar datos.
    mode: 'upload' | 'download'
    """

    # Colores para los tipos de log
    _LOG_COLORS = {
        'ok':    '#4ade80',
        'error': '#f87171',
        'warn':  '#fbbf24',
        'info':  '#94a3b8',
    }

    def __init__(self, parent=None, mode='upload', full_history=True):
        super().__init__(parent)
        self.mode         = mode
        self.full_history = full_history
        self._finished    = False
        self.worker       = None

        is_download = (mode == 'download')
        self.setWindowTitle('Descargando datos...' if is_download else 'Subiendo datos...')
        self.setModal(True)
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowCloseButtonHint)

        # Tamaño adaptable: mínimo razonable, crece con la pantalla
        screen = QApplication.primaryScreen().availableGeometry()
        w = max(540, min(680, int(screen.width() * 0.45)))
        h = max(480, min(620, int(screen.height() * 0.62)))
        self.resize(w, h)
        self.setMinimumSize(480, 420)

        self._init_ui(is_download)
        self._center_on_screen()

    def _center_on_screen(self):
        screen = QApplication.primaryScreen().availableGeometry()
        self.move(
            screen.x() + (screen.width()  - self.width())  // 2,
            screen.y() + (screen.height() - self.height()) // 2,
        )

    def _init_ui(self, is_download: bool):
        icon_char  = 'Descarga' if is_download else 'Nube'
        title_text = 'Descargando datos desde Firebase' if is_download else 'Subiendo datos a Firebase'
        total_steps = DownloadWorker.TOTAL_STEPS if is_download else 5

        self.setStyleSheet('''
            QDialog { background: #f8f9fa; }
            QLabel#dlgTitle { font-size: 15px; font-weight: bold; color: #1e293b; }
            QLabel#dlgStep  { font-size: 12px; color: #475569; }
            QLabel#dlgDetail { font-size: 11px; color: #64748b; }
            QProgressBar {
                border: none; border-radius: 6px;
                background: #e2e8f0; height: 16px; text-align: center;
                font-size: 11px; color: #1e293b;
            }
            QProgressBar::chunk {
                background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                    stop:0 #0d6efd, stop:1 #0ea5e9);
                border-radius: 6px;
            }
            QProgressBar#detailBar::chunk {
                background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                    stop:0 #198754, stop:1 #20c997);
                border-radius: 4px;
            }
            QProgressBar#detailBar {
                height: 10px; border-radius: 4px;
            }
            QTextEdit {
                background: #1e293b; color: #e2e8f0;
                border-radius: 8px; border: none;
                font-family: Consolas, monospace; font-size: 11px;
                padding: 8px;
            }
            QPushButton#closeBtn {
                background: #0d6efd; color: white; border: none;
                border-radius: 8px; font-size: 13px; font-weight: bold;
                padding: 10px 28px;
            }
            QPushButton#closeBtn:hover { background: #0b5ed7; }
            QPushButton#closeBtn:disabled { background: #94a3b8; color: #e2e8f0; }
        ''')

        layout = QVBoxLayout(self)
        layout.setContentsMargins(22, 18, 22, 18)
        layout.setSpacing(12)

        # ── Header ──────────────────────────────────────────────────────
        header = QHBoxLayout()
        icon_lbl = QLabel(icon_char)
        icon_lbl.setFont(QFont('Segoe UI', 26))
        icon_lbl.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        header.addWidget(icon_lbl)

        title_col = QVBoxLayout()
        title_col.setSpacing(2)
        title_lbl = QLabel(title_text)
        title_lbl.setObjectName('dlgTitle')
        title_lbl.setWordWrap(True)
        title_col.addWidget(title_lbl)

        self.step_lbl = QLabel('Preparando...')
        self.step_lbl.setObjectName('dlgStep')
        self.step_lbl.setWordWrap(True)
        title_col.addWidget(self.step_lbl)
        header.addLayout(title_col, 1)
        layout.addLayout(header)

        # ── Barra de progreso de pasos ───────────────────────────────────
        self.progress_bar = QProgressBar()
        self.progress_bar.setMinimum(0)
        self.progress_bar.setMaximum(total_steps)
        self.progress_bar.setValue(0)
        self.progress_bar.setFormat('Paso %v de %m')
        layout.addWidget(self.progress_bar)

        # ── Barra de detalle (por ítem dentro del paso) ──────────────────
        self.detail_bar = QProgressBar()
        self.detail_bar.setObjectName('detailBar')
        self.detail_bar.setMinimum(0)
        self.detail_bar.setMaximum(100)
        self.detail_bar.setValue(0)
        self.detail_bar.setFormat('%p%')
        layout.addWidget(self.detail_bar)

        self.detail_lbl = QLabel('')
        self.detail_lbl.setObjectName('dlgDetail')
        self.detail_lbl.setAlignment(Qt.AlignRight)
        layout.addWidget(self.detail_lbl)

        # Separador
        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet('color: #e2e8f0;')
        layout.addWidget(sep)

        # ── Log en tiempo real ───────────────────────────────────────────
        log_lbl = QLabel('Registro en tiempo real:')
        log_lbl.setStyleSheet('color: #475569; font-weight: 600; font-size: 12px;')
        layout.addWidget(log_lbl)

        self.log_area = QTextEdit()
        self.log_area.setReadOnly(True)
        self.log_area.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        layout.addWidget(self.log_area, 1)

        # ── Botón cerrar ─────────────────────────────────────────────────
        btn_row = QHBoxLayout()
        btn_row.addStretch()
        self.close_btn = QPushButton('Cerrar')
        self.close_btn.setObjectName('closeBtn')
        self.close_btn.setEnabled(False)
        self.close_btn.setMinimumWidth(120)
        self.close_btn.clicked.connect(self.accept)
        btn_row.addWidget(self.close_btn)
        layout.addLayout(btn_row)

        # Animación en título
        self._dot_count = 0
        self._dot_timer = QTimer(self)
        self._dot_timer.timeout.connect(self._animate_dots)
        self._dot_timer.start(500)

    def _animate_dots(self):
        if self._finished:
            self._dot_timer.stop()
            return
        self._dot_count = (self._dot_count + 1) % 4
        dots = '.' * self._dot_count
        base = 'Descargando datos' if self.mode == 'download' else 'Subiendo datos'
        self.setWindowTitle(f'{base}{dots}')

    def start_sync(self, main_window):
        """Inicia el worker adecuado según el modo."""
        if self.mode == 'download':
            self.worker = DownloadWorker(main_window)
        else:
            self.worker = SyncWorker(main_window, self.full_history)

        self.worker.progress.connect(self._on_progress)
        self.worker.log_message.connect(self._on_log)
        self.worker.step_changed.connect(self._on_step)
        self.worker.finished.connect(self._on_finished)
        # Ambos workers tienen pct_detail — conectar siempre
        self.worker.pct_detail.connect(self._on_detail)
        self.worker.start()

    # ── Slots ────────────────────────────────────────────────────────────
    def _on_progress(self, current, total):
        self.progress_bar.setMaximum(max(total, 1))
        self.progress_bar.setValue(current)
        # Resetear barra de detalle al avanzar de paso
        self.detail_bar.setValue(0)
        self.detail_lbl.setText('')

    def _on_detail(self, current, total, message):
        """Actualiza la barra de detalle (progreso dentro de un paso)."""
        if total > 0:
            pct = int(current * 100 / total)
            self.detail_bar.setValue(pct)
        self.detail_lbl.setText(message)

    def _on_step(self, step_text):
        self.step_lbl.setText(step_text)

    def _on_log(self, message, tipo):
        color = self._LOG_COLORS.get(tipo, '#e2e8f0')
        self.log_area.append(f'<span style="color:{color}">{message}</span>')
        self.log_area.moveCursor(QTextCursor.End)

    def _on_finished(self, success, message):
        self._finished = True
        self._dot_timer.stop()
        self.detail_bar.setValue(100 if success else self.detail_bar.value())
        if success:
            titulo = 'Descarga completada' if self.mode == 'download' else 'Sincronización completada'
            self.setWindowTitle(titulo)
        else:
            self.setWindowTitle('Error: Error en la operación')
            self._on_log(f'Error: {message}', 'error')
        self.progress_bar.setValue(self.progress_bar.maximum())
        self.close_btn.setEnabled(True)


# ══════════════════════════════════════════════════════════════════════════════
#  MENÚ DE SINCRONIZACIÓN — Elige entre Subir o Descargar
# ══════════════════════════════════════════════════════════════════════════════

class CloudSyncMenu:
    """
    Clase utilitaria que convierte el botón de nube en un menú desplegable.
    Opciones:
      • ⬆️  Subir Datos   → sube ventas, movimientos, cierres, inventario local → Firebase
      • Descarga  Descargar Datos → descarga productos, precios, rubros desde Firebase → local
    """

    @staticmethod
    def show(parent_widget, main_window, restore_btn_cb=None):
        """
        Muestra el menú desplegable en la posición del botón dado.
        parent_widget : el QPushButton que actúa como disparador
        main_window   : la MainWindow (para pasar al worker)
        restore_btn_cb: callback para restaurar el botón al terminar
        """
        from pos_system.utils.firebase_sync import get_firebase_sync
        fb = get_firebase_sync()

        menu = QMenu(parent_widget)
        menu.setStyleSheet('''
            QMenu {
                background: #ffffff;
                border: 1px solid #dee2e6;
                border-radius: 8px;
                padding: 6px 4px;
                font-size: 13px;
            }
            QMenu::item {
                padding: 10px 20px;
                border-radius: 6px;
                color: #212529;
                margin: 2px 4px;
            }
            QMenu::item:selected {
                background: #e8f0fe;
                color: #0d6efd;
            }
            QMenu::separator {
                height: 1px;
                background: #e9ecef;
                margin: 4px 8px;
            }
        ''')

        # ── Subir Datos ──────────────────────────────────────────────────
        upload_action = QAction('⬆️   Subir Datos', menu)
        upload_action.setToolTip(
            'Sube todas las ventas, movimientos, cierres de caja, inventario y\n'
            'facturas desde este POS hacia Firebase / la nube.')

        if fb and fb.enabled:
            upload_action.triggered.connect(
                lambda: CloudSyncMenu._run_dialog(parent_widget, main_window,
                                                  mode='upload',
                                                  restore_btn_cb=restore_btn_cb))
        else:
            upload_action.setEnabled(False)
            upload_action.setText('⬆️   Subir Datos  (Firebase no configurado)')

        # ── Descargar Datos ──────────────────────────────────────────────
        download_action = QAction('Descarga   Descargar Datos', menu)
        download_action.setToolTip(
            'Descarga productos, precios actualizados, rubros y códigos de barra\n'
            'desde Firebase hacia este POS (útil al instalar en un nuevo equipo).')

        if fb and fb.enabled:
            download_action.triggered.connect(
                lambda: CloudSyncMenu._run_dialog(parent_widget, main_window,
                                                  mode='download',
                                                  restore_btn_cb=restore_btn_cb))
        else:
            download_action.setEnabled(False)
            download_action.setText('Descarga   Descargar Datos  (Firebase no configurado)')

        menu.addAction(upload_action)
        menu.addSeparator()
        menu.addAction(download_action)

        if not fb or not fb.enabled:
            menu.addSeparator()
            info_action = QAction('ℹ️   Firebase no está configurado', menu)
            info_action.setEnabled(False)
            menu.addAction(info_action)

        # Mostrar debajo del botón
        btn_pos = parent_widget.mapToGlobal(parent_widget.rect().bottomLeft())
        menu.exec_(btn_pos)

    @staticmethod
    def _run_dialog(parent_widget, main_window, mode: str, restore_btn_cb=None):
        """Abre el diálogo de progreso y ejecuta el worker."""
        parent_widget.setEnabled(False)

        dlg = SyncProgressDialog(main_window, mode=mode, full_history=True)

        def on_done():
            if restore_btn_cb:
                restore_btn_cb()
            # Refrescar todas las vistas tras descargar o subir
            try:
                main_window.refresh_all_views()
                main_window._check_low_stock_badge()
            except Exception:
                pass

        dlg.finished.connect(lambda _: on_done())
        dlg.start_sync(main_window)
        dlg.exec_()
