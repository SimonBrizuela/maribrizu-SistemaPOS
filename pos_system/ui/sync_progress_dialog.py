"""
Diálogo visual de progreso de sincronización con la nube.
Muestra en tiempo real qué datos se están subiendo o descargando.
Incluye menú para elegir Subir Datos o Descargar Datos.
"""
from PyQt5.QtWidgets import (QDialog, QVBoxLayout, QHBoxLayout, QLabel,
                              QProgressBar, QTextEdit, QPushButton, QWidget,
                              QFrame, QApplication, QSizePolicy, QMenu, QAction)
from PyQt5.QtCore import Qt, pyqtSignal, QThread, QTimer, QElapsedTimer
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

    def __init__(self, main_window, write_trigger=True):
        super().__init__()
        self.main_window = main_window
        self.write_trigger = write_trigger  # False en auto-sync para evitar loop

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
                        'name':        str(row.get('name') or ''),
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

            # Leer timestamp del último sync para hacer delta query
            from pos_system.config import DATA_DIR
            import datetime as _dt, time as _time
            _sync_file = DATA_DIR / "last_catalog_sync.txt"
            _local_epoch = 0.0
            try:
                if _sync_file.exists():
                    _local_epoch = float(_sync_file.read_text(encoding='utf-8').strip())
            except Exception:
                pass

            # Delta sync: solo docs modificados desde el último sync
            try:
                if _local_epoch > 0:
                    _last_dt = _dt.datetime.fromtimestamp(_local_epoch, tz=_dt.timezone.utc)
                    all_docs = list(
                        fb.db.collection('catalogo')
                          .where('ultima_actualizacion', '>=', _last_dt)
                          .stream()
                    )
                    self.log_message.emit(
                        f'Delta sync: {len(all_docs)} productos modificados desde el último sync.', 'info')
                else:
                    all_docs = list(fb.db.collection('catalogo').stream())
                    self.log_message.emit(
                        f'Sync completo: {len(all_docs)} productos en catálogo Firebase.', 'info')
                productos_fb = []
                for d in all_docs:
                    data = d.to_dict()
                    if data:
                        data['doc_id'] = d.id
                        productos_fb.append(data)
            except Exception as e_cat:
                self.log_message.emit(f'Error leyendo catálogo, usando sync completo: {e_cat}', 'warn')
                _local_epoch = 0.0
                all_docs = list(fb.db.collection('catalogo').stream())
                productos_fb = []
                for d in all_docs:
                    data = d.to_dict()
                    if data:
                        data['doc_id'] = d.id
                        productos_fb.append(data)

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

                # ── Timestamp de Firebase para comparar ──────────────────
                fb_ts     = str(p.get('ultima_actualizacion') or p.get('updated_at') or '').strip()
                fb_ts_num = self._parse_fecha(fb_ts) if fb_ts else 0.0

                # ── Buscar si ya existe localmente ────────────────────────
                # Prioridad: 1) firebase_id (más confiable), 2) barcode, 3) nombre
                local_id     = None
                local_ts_num = 0.0

                if firebase_id and firebase_id in local_by_firebase_id:
                    local_id, local_ts_num = local_by_firebase_id[firebase_id]
                elif pid and pid in local_by_id:
                    local_id     = int(pid)
                    local_ts_num = local_by_id[pid]
                elif barcode and barcode in local_by_barcode:
                    local_id, local_ts_num = local_by_barcode[barcode]
                elif nombre.lower() in local_by_name:
                    local_id, local_ts_num = local_by_name[nombre.lower()]

                # ── Actualizar solo si los datos realmente cambiaron ─────
                if local_id is not None:
                    local_data = local_data_by_id.get(local_id, {})
                    datos_iguales = (
                        abs(float(local_data.get('price') or 0) - precio) < 0.01
                        and int(local_data.get('stock') or 0) == stock
                        and str(local_data.get('name') or '').strip() == nombre
                        and str(local_data.get('barcode') or '') == (barcode or '')
                    )
                    if datos_iguales:
                        productos_sin_cambios += 1
                        # Actualizar firebase_id si faltaba
                        if firebase_id and not local_data.get('firebase_id'):
                            db.execute_update(
                                "UPDATE products SET firebase_id = ? WHERE id = ?",
                                (firebase_id, local_id)
                            )
                    else:
                        def _do_update(bc):
                            if fb_ts:
                                db.execute_update("""
                                    UPDATE products SET
                                        name = ?, price = ?, cost = ?, stock = ?,
                                        category = ?, barcode = ?, discount_value = ?,
                                        firebase_id = ?, rubro = ?, updated_at = ?
                                    WHERE id = ?
                                """, (nombre, precio, costo, stock, cat, bc, desc,
                                      firebase_id, rubro, fb_ts, local_id))
                            else:
                                db.execute_update("""
                                    UPDATE products SET
                                        name = ?, price = ?, cost = ?, stock = ?,
                                        category = ?, barcode = ?, discount_value = ?,
                                        firebase_id = ?, rubro = ?,
                                        updated_at = CURRENT_TIMESTAMP
                                    WHERE id = ?
                                """, (nombre, precio, costo, stock, cat, bc, desc,
                                      firebase_id, rubro, local_id))
                        try:
                            _do_update(barcode)
                        except Exception as e:
                            if 'UNIQUE' in str(e) and 'barcode' in str(e):
                                # Barcode duplicado en otro producto — actualizar sin barcode
                                _do_update(None)
                            # otros errores se ignoran silenciosamente
                        productos_actualizados += 1
                        new_ts = fb_ts or '9999-99-99'
                        local_by_firebase_id[firebase_id] = (local_id, new_ts)
                        local_by_id[str(local_id)] = new_ts
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
                f'(total Firebase: {total_fb})', 'ok')

            # ── PASO 3.5: Aplicar tombstones de productos eliminados ─────
            # La webapp escribe un doc en catalogo_deleted/{id} con deleted_at
            # al borrar un producto. Acá consultamos solo los tombstones nuevos
            # desde el último sync → O(borrados) en lugar de O(catálogo).
            productos_eliminados = 0
            productos_no_borrables = 0
            try:
                self.log_message.emit(
                    'Aplicando eliminaciones pendientes...', 'info')

                if _local_epoch > 0:
                    since_dt = _dt.datetime.fromtimestamp(
                        _local_epoch, tz=_dt.timezone.utc)
                    deleted_docs = list(
                        fb.db.collection('catalogo_deleted')
                          .where('deleted_at', '>', since_dt)
                          .stream()
                    )
                else:
                    # Primer sync: traer todos los tombstones conocidos
                    deleted_docs = list(
                        fb.db.collection('catalogo_deleted').stream()
                    )

                fb_deleted_ids = {str(d.id) for d in deleted_docs}

                if fb_deleted_ids:
                    # Borrar solo los productos locales cuyo firebase_id
                    # aparece en los tombstones → un SELECT y un DELETE.
                    ids_list = list(fb_deleted_ids)
                    CHUNK = 500  # SQLite tiene límite de vars por query
                    rows_to_delete = []
                    for i in range(0, len(ids_list), CHUNK):
                        chunk = ids_list[i:i + CHUNK]
                        placeholders = ','.join(['?'] * len(chunk))
                        rows = db.execute_query(
                            f"SELECT id, name, firebase_id FROM products "
                            f"WHERE firebase_id IN ({placeholders})",
                            tuple(chunk)
                        ) or []
                        rows_to_delete.extend(rows)

                    for r in rows_to_delete:
                        try:
                            db.execute_update(
                                "DELETE FROM products WHERE id = ?",
                                (r['id'],)
                            )
                            productos_eliminados += 1
                        except Exception as e:
                            productos_no_borrables += 1
                            logger.debug(
                                f"No se pudo borrar producto "
                                f"{r['id']} ({r.get('name')}): {e}"
                            )

                    if productos_eliminados:
                        self.log_message.emit(
                            f'{productos_eliminados} productos eliminados '
                            f'(borrados en Firebase).', 'ok')
                    if productos_no_borrables:
                        self.log_message.emit(
                            f'{productos_no_borrables} productos quedaron '
                            f'locales por tener ventas asociadas.', 'warn')
                    if not rows_to_delete:
                        self.log_message.emit(
                            f'{len(fb_deleted_ids)} tombstone(s) sin match '
                            f'local (ya estaban borrados).', 'info')
                else:
                    self.log_message.emit(
                        'No hay productos eliminados desde el último sync.',
                        'info')
            except Exception as e:
                self.log_message.emit(
                    f'Error aplicando eliminaciones: {e}', 'warn')

            # ── PASO 4: Precios remotos — solo novedades ──────────────────
            step = 3
            self.step_changed.emit('Aplicando precios y datos actualizados...')
            self.log_message.emit('Descargando precios actualizados (productos_remotos)...', 'info')
            self.progress.emit(step, self.TOTAL_STEPS)

            remotos = fb.download_precios_actualizados(
                progress_cb=lambda cur, tot, msg: self.pct_detail.emit(cur, max(tot, 1), msg),
                since_epoch=_local_epoch,
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
                    try:
                        db.execute_update(
                            f"UPDATE products SET {sql_set} WHERE id = ?",
                            tuple(vals) + (target_id,)
                        )
                    except Exception as e_upd:
                        if 'UNIQUE' in str(e_upd) and 'barcode' in str(e_upd):
                            # Reintentar sin barcode
                            vals_sin_bc = [v for v, u in zip(vals, updates[:-1]) if 'barcode' not in u]
                            updates_sin_bc = [u for u in updates if 'barcode' not in u]
                            if updates_sin_bc:
                                sql_sin_bc = ', '.join(updates_sin_bc)
                                try:
                                    db.execute_update(
                                        f"UPDATE products SET {sql_sin_bc} WHERE id = ?",
                                        tuple(vals_sin_bc) + (target_id,)
                                    )
                                except Exception:
                                    pass
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

            # Guardar timestamp del sync para delta en próximos arranques/syncs
            try:
                _sync_file.write_text(str(_time.time()), encoding='utf-8')
            except Exception:
                pass

            # ── FINALIZAR ────────────────────────────────────────────────
            step = self.TOTAL_STEPS
            self.progress.emit(step, self.TOTAL_STEPS)
            self.step_changed.emit('Descarga completada')

            resumen = (
                f'Descarga incremental exitosa — '
                f'{rubros_nuevos} rubros nuevos · '
                f'{productos_nuevos} productos nuevos · '
                f'{productos_actualizados + precios_actualizados} actualizados · '
                f'{productos_eliminados} eliminados · '
                f'{productos_sin_cambios + precios_sin_cambios} ya estaban al día'
            )
            self.log_message.emit('', 'info')
            self.log_message.emit('══════════════════════════════════════', 'ok')
            self.log_message.emit(f'{resumen}', 'ok')
            self.log_message.emit('══════════════════════════════════════', 'ok')

            # Trigger para que las demás PCs también descarguen
            if self.write_trigger:
                try:
                    from pos_system.utils.firebase_sync import _get_pc_id
                    fb.write_sync_trigger(_get_pc_id(), command='download')
                except Exception:
                    pass

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

    def __init__(self, main_window, full_history=True, write_trigger=True):
        super().__init__()
        self.main_window = main_window
        self.full_history = full_history
        self.write_trigger = write_trigger  # False en auto-sync para evitar loop

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

            from pos_system.utils.firebase_sync import _get_pc_id
            _pc_id = _get_pc_id()
            total_ventas = len(all_sales)
            batch = firedb.batch()
            count = 0
            for i, s in enumerate(all_sales):
                sale_id = str(s.get('id') or s.get('sale_id', ''))
                if not sale_id:
                    continue
                created_at = fb._parse_dt(s.get('created_at'))
                items = s.get('items') or []
                from pos_system.utils.firebase_sync import _fmt_qty
                productos_str = ', '.join(
                    f"{it.get('product_name', it.get('name','?'))} x{_fmt_qty(it.get('quantity',1))}"
                    for it in items[:3]
                )
                if len(items) > 3:
                    productos_str += f' (+{len(items)-3} más)'
                fb_sale_id = f"{_pc_id}_{sale_id}"
                ref = firedb.collection('ventas').document(fb_sale_id)
                batch.set(ref, {
                    'sale_id':       int(sale_id),
                    'pc_id':         _pc_id,
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
                    # Doc compartido por register_id → todas las PCs apuntan al mismo.
                    fb_reg_id = reg_id
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
                    fb.db.collection('cierres_caja').document(fb_reg_id).set({
                        'register_id':           int(reg_id),
                        'pc_id':                 _pc_id,
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

            # Escribir trigger para que las demás PCs suban sus datos también
            if self.write_trigger:
                try:
                    from pos_system.utils.firebase_sync import _get_pc_id
                    fb.write_sync_trigger(_get_pc_id(), command='upload')
                except Exception:
                    pass

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
        self._elapsed     = QElapsedTimer()
        self._elapsed.start()

        is_download = (mode == 'download')
        self.setWindowTitle('Descargando datos...' if is_download else 'Subiendo datos...')
        self.setModal(True)
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowCloseButtonHint)

        # Tamaño adaptable: mínimo razonable, crece con la pantalla
        screen = QApplication.primaryScreen().availableGeometry()
        w = max(540, min(700, int(screen.width() * 0.47)))
        h = max(500, min(650, int(screen.height() * 0.65)))
        self.resize(w, h)
        self.setMinimumSize(500, 450)

        self._init_ui(is_download)
        self._center_on_screen()

    def _center_on_screen(self):
        screen = QApplication.primaryScreen().availableGeometry()
        self.move(
            screen.x() + (screen.width()  - self.width())  // 2,
            screen.y() + (screen.height() - self.height()) // 2,
        )

    _SPINNER_FRAMES = ('⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏')

    def _init_ui(self, is_download: bool):
        icon_char   = '⬇' if is_download else '⬆'
        title_text  = 'Descargando datos desde Firebase' if is_download else 'Subiendo datos a Firebase'
        total_steps = DownloadWorker.TOTAL_STEPS if is_download else 5

        self.setStyleSheet('''
            QDialog { background: #f0f4f8; }
            QFrame#headerCard {
                background: #1e293b;
                border-radius: 12px;
            }
            QLabel#dlgIcon  { font-size: 28px; color: #60a5fa; }
            QLabel#dlgTitle { font-size: 15px; font-weight: bold; color: #f1f5f9; }
            QLabel#dlgStep  { font-size: 12px; color: #94a3b8; }
            QLabel#statusBadge {
                font-size: 12px; font-weight: bold;
                padding: 3px 12px; border-radius: 10px;
            }
            QLabel#elapsedLbl { font-size: 11px; color: #64748b; }
            QLabel#dlgDetail  { font-size: 11px; color: #64748b; }
            QProgressBar {
                border: none; border-radius: 6px;
                background: #cbd5e1; height: 18px; text-align: center;
                font-size: 11px; color: #1e293b;
            }
            QProgressBar::chunk {
                background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                    stop:0 #3b82f6, stop:1 #06b6d4);
                border-radius: 6px;
            }
            QProgressBar#progressDone::chunk {
                background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                    stop:0 #16a34a, stop:1 #22c55e);
                border-radius: 6px;
            }
            QProgressBar#progressError::chunk {
                background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                    stop:0 #dc2626, stop:1 #f87171);
                border-radius: 6px;
            }
            QProgressBar#detailBar::chunk {
                background: qlineargradient(x1:0,y1:0,x2:1,y2:0,
                    stop:0 #0891b2, stop:1 #22d3ee);
                border-radius: 4px;
            }
            QProgressBar#detailBar {
                height: 8px; border-radius: 4px;
            }
            QTextEdit {
                background: #0f172a; color: #e2e8f0;
                border-radius: 8px; border: 1px solid #334155;
                font-family: Consolas, monospace; font-size: 11px;
                padding: 8px;
            }
            QLabel#logHeader {
                color: #64748b; font-weight: 600; font-size: 11px;
                padding: 2px 0px;
            }
            QPushButton#closeBtn {
                background: #3b82f6; color: white; border: none;
                border-radius: 8px; font-size: 13px; font-weight: bold;
                padding: 10px 32px;
            }
            QPushButton#closeBtn:hover  { background: #2563eb; }
            QPushButton#closeBtn:disabled {
                background: #475569; color: #94a3b8;
            }
        ''')

        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 16, 18, 16)
        layout.setSpacing(10)

        # ── Tarjeta header oscura ────────────────────────────────────────
        header_card = QFrame()
        header_card.setObjectName('headerCard')
        header_layout = QVBoxLayout(header_card)
        header_layout.setContentsMargins(16, 14, 16, 14)
        header_layout.setSpacing(6)

        # Fila superior: icono + título + badge estado
        top_row = QHBoxLayout()
        top_row.setSpacing(12)

        self.icon_lbl = QLabel(icon_char)
        self.icon_lbl.setObjectName('dlgIcon')
        self.icon_lbl.setFont(QFont('Segoe UI', 28))
        self.icon_lbl.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        top_row.addWidget(self.icon_lbl)

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
        top_row.addLayout(title_col, 1)

        # Badge de estado
        self.status_badge = QLabel('  EN PROCESO  ')
        self.status_badge.setObjectName('statusBadge')
        self.status_badge.setStyleSheet(
            'QLabel { background: #1d4ed8; color: #bfdbfe;'
            ' font-size: 11px; font-weight: bold;'
            ' padding: 4px 10px; border-radius: 10px; }'
        )
        self.status_badge.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        top_row.addWidget(self.status_badge, 0, Qt.AlignTop)
        header_layout.addLayout(top_row)

        # Fila inferior del header: spinner + texto operación + cronómetro
        bottom_row = QHBoxLayout()
        bottom_row.setSpacing(6)

        self.spinner_lbl = QLabel(self._SPINNER_FRAMES[0])
        self.spinner_lbl.setFont(QFont('Consolas', 13))
        self.spinner_lbl.setStyleSheet('color: #60a5fa;')
        self.spinner_lbl.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        bottom_row.addWidget(self.spinner_lbl)

        self.running_lbl = QLabel('Operación en curso...')
        self.running_lbl.setStyleSheet('color: #60a5fa; font-size: 11px; font-weight: 600;')
        bottom_row.addWidget(self.running_lbl, 1)

        self.elapsed_lbl = QLabel('00:00')
        self.elapsed_lbl.setObjectName('elapsedLbl')
        self.elapsed_lbl.setStyleSheet('color: #64748b; font-size: 11px;')
        self.elapsed_lbl.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        bottom_row.addWidget(self.elapsed_lbl)

        header_layout.addLayout(bottom_row)
        layout.addWidget(header_card)

        # ── Barras de progreso ───────────────────────────────────────────
        prog_row = QHBoxLayout()
        prog_row.setSpacing(8)
        prog_lbl = QLabel('Pasos:')
        prog_lbl.setStyleSheet('color: #475569; font-size: 11px; font-weight: 600;')
        prog_lbl.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        prog_row.addWidget(prog_lbl)

        self.progress_bar = QProgressBar()
        self.progress_bar.setMinimum(0)
        self.progress_bar.setMaximum(total_steps)
        self.progress_bar.setValue(0)
        self.progress_bar.setFormat('Paso %v de %m')
        prog_row.addWidget(self.progress_bar, 1)
        layout.addLayout(prog_row)

        self.detail_bar = QProgressBar()
        self.detail_bar.setObjectName('detailBar')
        self.detail_bar.setMinimum(0)
        self.detail_bar.setMaximum(100)
        self.detail_bar.setValue(0)
        self.detail_bar.setFormat('')
        layout.addWidget(self.detail_bar)

        self.detail_lbl = QLabel('')
        self.detail_lbl.setObjectName('dlgDetail')
        self.detail_lbl.setAlignment(Qt.AlignRight)
        layout.addWidget(self.detail_lbl)

        # Separador
        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet('color: #cbd5e1;')
        layout.addWidget(sep)

        # ── Log en tiempo real ───────────────────────────────────────────
        log_hdr = QHBoxLayout()
        log_lbl = QLabel('REGISTRO EN TIEMPO REAL')
        log_lbl.setObjectName('logHeader')
        log_hdr.addWidget(log_lbl)
        log_hdr.addStretch()
        layout.addLayout(log_hdr)

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
        self.close_btn.setMinimumWidth(130)
        self.close_btn.clicked.connect(self.accept)
        btn_row.addWidget(self.close_btn)
        layout.addLayout(btn_row)

        # Timers: animación + cronómetro
        self._spin_idx  = 0
        self._dot_count = 0
        self._dot_timer = QTimer(self)
        self._dot_timer.timeout.connect(self._animate_dots)
        self._dot_timer.start(120)

        self._clock_timer = QTimer(self)
        self._clock_timer.timeout.connect(self._update_elapsed)
        self._clock_timer.start(1000)

    def _animate_dots(self):
        if self._finished:
            self._dot_timer.stop()
            return
        # Rotar spinner
        self._spin_idx = (self._spin_idx + 1) % len(self._SPINNER_FRAMES)
        self.spinner_lbl.setText(self._SPINNER_FRAMES[self._spin_idx])
        # Título con puntos animados
        self._dot_count = (self._dot_count + 1) % 4
        dots = '.' * self._dot_count
        base = 'Descargando datos' if self.mode == 'download' else 'Subiendo datos'
        self.setWindowTitle(f'{base}{dots}')

    def _update_elapsed(self):
        if self._finished:
            self._clock_timer.stop()
            return
        secs = int(self._elapsed.elapsed() / 1000)
        m, s = divmod(secs, 60)
        self.elapsed_lbl.setText(f'{m:02d}:{s:02d}')

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
        self._clock_timer.stop()

        # Tiempo total transcurrido
        secs = int(self._elapsed.elapsed() / 1000)
        m, s = divmod(secs, 60)
        elapsed_str = f'{m:02d}:{s:02d}'
        self.elapsed_lbl.setText(f'Duración: {elapsed_str}')
        self.elapsed_lbl.setStyleSheet('color: #475569; font-size: 11px;')

        if success:
            # Spinner → checkmark
            self.spinner_lbl.setText('✔')
            self.spinner_lbl.setStyleSheet('color: #22c55e; font-size: 14px; font-weight: bold;')

            self.running_lbl.setText('Operación finalizada correctamente')
            self.running_lbl.setStyleSheet('color: #22c55e; font-size: 11px; font-weight: 600;')

            # Badge verde
            self.status_badge.setText('  COMPLETADO  ')
            self.status_badge.setStyleSheet(
                'QLabel { background: #14532d; color: #86efac;'
                ' font-size: 11px; font-weight: bold;'
                ' padding: 4px 10px; border-radius: 10px; }'
            )

            # Barra principal verde
            self.progress_bar.setObjectName('progressDone')
            self.progress_bar.setFormat('Completado')
            self.progress_bar.style().unpolish(self.progress_bar)
            self.progress_bar.style().polish(self.progress_bar)

            # Icono header
            self.icon_lbl.setText('✅')

            titulo = 'Descarga completada' if self.mode == 'download' else 'Sincronización completada'
            self.setWindowTitle(titulo)
        else:
            # Spinner → X
            self.spinner_lbl.setText('✖')
            self.spinner_lbl.setStyleSheet('color: #f87171; font-size: 14px; font-weight: bold;')

            self.running_lbl.setText('La operación terminó con errores')
            self.running_lbl.setStyleSheet('color: #f87171; font-size: 11px; font-weight: 600;')

            # Badge rojo
            self.status_badge.setText('  ERROR  ')
            self.status_badge.setStyleSheet(
                'QLabel { background: #7f1d1d; color: #fca5a5;'
                ' font-size: 11px; font-weight: bold;'
                ' padding: 4px 10px; border-radius: 10px; }'
            )

            # Barra principal roja
            self.progress_bar.setObjectName('progressError')
            self.progress_bar.setFormat('Error')
            self.progress_bar.style().unpolish(self.progress_bar)
            self.progress_bar.style().polish(self.progress_bar)

            # Icono header
            self.icon_lbl.setText('❌')

            self.setWindowTitle('Error en la operación')
            self._on_log(f'Error: {message}', 'error')

        self.detail_bar.setValue(100 if success else self.detail_bar.value())
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
