import sys
import math
import re
import logging
from PyQt5.QtWidgets import QApplication, QMessageBox
from PyQt5.QtCore import Qt

from pos_system.config import APP_NAME, ORGANIZATION, APP_VERSION, DATABASE_PATH
from pos_system.ui.main_window import MainWindow
from pos_system.database.db_manager import DatabaseManager
from pos_system.utils.logger import setup_logger

logger = setup_logger(__name__)


def _init_google_sheets():
    """
    Inicializa la sincronización con Google Sheets via webhook de Apps Script.
    """
    webhook_url = ""
    try:
        from pos_system.config import GOOGLE_SHEETS_WEBHOOK_URL
        webhook_url = GOOGLE_SHEETS_WEBHOOK_URL or ""
    except ImportError:
        pass

    if not webhook_url:
        logger.info("Google Sheets: No configurado. Sincronización desactivada.")
        return

    try:
        from pos_system.utils.google_sheets_sync import init_google_sheets
        sync = init_google_sheets(webhook_url)
        if sync.enabled:
            logger.info("Google Sheets: Sincronización via webhook activa.")
        else:
            logger.warning("Google Sheets: No se pudo activar la sincronización.")
    except Exception as e:
        logger.error(f"Google Sheets: Error al inicializar: {e}")


def _init_firebase(db=None):
    """
    Inicializa la sincronización con Firebase Firestore.
    Requiere firebase_key.json en la raíz del proyecto.
    """
    try:
        from pos_system.utils.firebase_sync import init_firebase_sync
        sync = init_firebase_sync()
        if sync:
            logger.info("Firebase: Sincronización activa.")
            # Sincronizar cajeros: sube los locales y descarga los de Firebase
            if db:
                try:
                    # Primero subir los locales (para que la PC admin los publique)
                    sync.sync_users(db)
                    # Luego descargar (para recibir cajeros de otras PCs)
                    count = sync.download_users(db)
                    logger.info(f"Firebase: {count} cajeros sincronizados al iniciar.")
                    # Listener en tiempo real para actualizaciones futuras
                    sync.start_users_listener(db)
                    # Sincronizar caja compartida al arrancar (el listener real se activa en MainWindow)
                    try:
                        sync.ensure_local_register(db)
                    except Exception as e:
                        logger.warning(f"Firebase: No se pudo sincronizar caja: {e}")
                except Exception as e:
                    logger.warning(f"Firebase: No se pudieron sincronizar cajeros: {e}")
        else:
            logger.info("Firebase: Sync desactivado (sin firebase_key.json o firebase-admin no instalado).")
    except Exception as e:
        logger.error(f"Firebase: Error al inicializar: {e}")


def _sync_inventory_from_firebase(db):
    """
    Descarga el catálogo desde Firestore y lo aplica a la BD local.
    Antes de descargar los 12.000+ productos, verifica si el catálogo cambió
    desde el último sync leyendo config/catalogo_meta (1 sola lectura Firestore).
    Si no hubo cambios → sale sin leer nada más.
    """
    try:
        from pos_system.utils.firebase_sync import get_firebase_sync
        fb = get_firebase_sync()
        if not fb:
            return

        # ── Verificar si el catálogo cambió desde el último sync (1 lectura) ──
        from pos_system.config import DATA_DIR
        sync_file = DATA_DIR / "last_catalog_sync.txt"

        local_epoch = 0.0
        if sync_file.exists():
            try:
                local_epoch = float(sync_file.read_text(encoding='utf-8').strip())
            except Exception:
                local_epoch = 0.0

        try:
            meta_doc = fb.db.collection('config').document('catalogo_meta').get()
            if meta_doc.exists:
                meta = meta_doc.to_dict() or {}
                fb_ts = meta.get('last_updated')
                if fb_ts is not None:
                    fb_epoch = fb_ts.timestamp() if hasattr(fb_ts, 'timestamp') else 0.0
                    if fb_epoch > 0 and fb_epoch <= local_epoch:
                        logger.info("Firebase: Catálogo sin cambios — sync omitido.")
                        return
        except Exception as e:
            logger.debug(f"Firebase: No se pudo leer catalogo_meta: {e}")
            # Si falla la lectura del meta, continuar con el sync completo

        logger.info("Firebase: Descargando catálogo desde Firestore...")

        from pos_system.models.product import Product
        from pos_system.utils.validators import ValidationError
        import datetime as _dt, time as _time
        product_model = Product(db)

        actualizados = 0
        creados = 0
        errores = 0

        # Delta sync: solo productos modificados desde el último sync
        try:
            if local_epoch > 0:
                last_dt = _dt.datetime.fromtimestamp(local_epoch, tz=_dt.timezone.utc)
                all_docs = list(
                    fb.db.collection('catalogo')
                      .where('ultima_actualizacion', '>=', last_dt)
                      .stream()
                )
                logger.info(f"Firebase: {len(all_docs)} productos modificados desde el último sync.")
            else:
                all_docs = list(fb.db.collection('catalogo').stream())
                logger.info(f"Firebase: {len(all_docs)} productos en catálogo (sync completo).")
        except Exception as e_query:
            logger.warning(f"Firebase: delta query falló ({e_query}), usando sync completo.")
            all_docs = list(fb.db.collection('catalogo').stream())

        total_fb = len(all_docs)
        if total_fb == 0:
            logger.info("Firebase: Sin productos modificados — nada que actualizar.")
            sync_file.write_text(str(_time.time()), encoding='utf-8')
            return

        for doc in all_docs:
            p = doc.to_dict()
            if not p:
                continue
            try:
                # Mapear campos del catálogo → campos locales
                firebase_id = doc.id  # ID único del documento en Firebase
                pos_id      = p.get('pos_id')  # ID numérico único asignado por el sistema
                nombre    = str(p.get('nombre') or '').strip()

                def _safe_float(v):
                    try:
                        f = float(v) if v is not None else 0.0
                        return 0.0 if math.isnan(f) or math.isinf(f) else f
                    except (ValueError, TypeError):
                        return 0.0

                def _safe_int(v):
                    try:
                        f = float(v) if v is not None else 0.0
                        return 0 if math.isnan(f) or math.isinf(f) else int(f)
                    except (ValueError, TypeError):
                        return 0

                precio    = _safe_float(p.get('precio_venta') or p.get('precio'))
                stock     = max(0, _safe_int(p.get('stock')))  # stock nunca negativo
                costo     = _safe_float(p.get('costo'))
                categoria = str(p.get('categoria') or '').strip()
                rubro     = str(p.get('rubro') or '').strip()
                # cod_barra es el EAN/UPC; codigo es el código interno (no usar como barcode)
                barcode   = str(p.get('cod_barra') or '').strip()
                # descartar barcodes con caracteres inválidos
                if barcode and (not re.match(r'^[A-Za-z0-9\-_]+$', barcode) or len(barcode) < 3):
                    barcode = ''
                estado    = str(p.get('estado') or 'activo').lower()
                marca     = str(p.get('marca') or '').strip()

                if not nombre or precio <= 0:
                    continue
                # Saltar productos inactivos
                if estado not in ('activo', 'active', ''):
                    continue

                nombre_completo = nombre

                # Buscar si ya existe: 1) por firebase_id, 2) por barcode, 3) por nombre
                local = None
                results = db.execute_query(
                    "SELECT * FROM products WHERE firebase_id = ?", (firebase_id,)
                )
                if results:
                    local = results[0]
                if not local and barcode and len(barcode) >= 3:
                    local = product_model.get_by_barcode(barcode)
                if not local:
                    results = db.execute_query(
                        "SELECT * FROM products WHERE LOWER(name) = LOWER(?)",
                        (nombre_completo,)
                    )
                    if results:
                        local = results[0]

                if local:
                    needs_update = (
                        abs(float(local['price']) - precio) > 0.001
                        or int(local['stock']) != stock
                        or str(local.get('barcode') or '') != str(barcode or '')
                        or str(local.get('category') or '') != categoria
                        or (costo > 0 and abs(float(local.get('cost') or 0) - costo) > 0.001)
                        or str(local.get('firebase_id') or '') != firebase_id
                    )
                    if needs_update:
                        upd = {'price': precio, 'stock': stock, 'firebase_id': firebase_id}
                        if barcode:
                            upd['barcode'] = barcode
                        if categoria:
                            upd['category'] = categoria
                        if costo > 0:
                            upd['cost'] = costo
                        if rubro:
                            upd['rubro'] = rubro
                        try:
                            product_model.update(local['id'], **upd)
                        except Exception as e_upd:
                            if 'UNIQUE' in str(e_upd) and 'barcode' in str(e_upd):
                                upd.pop('barcode', None)
                                product_model.update(local['id'], **upd)
                            else:
                                raise
                        actualizados += 1
                else:
                    product_model.create({
                        'name':        nombre_completo,
                        'price':       precio,
                        'stock':       stock,
                        'cost':        costo,
                        'category':    categoria or None,
                        'barcode':     barcode if barcode and len(barcode) >= 3 else None,
                        'description': marca or None,
                        'firebase_id': firebase_id,
                        'rubro':       rubro or None,
                    })
                    creados += 1

            except (ValidationError, Exception) as e:
                errores += 1
                logger.warning(f"Firebase catalogo '{p.get('nombre','?')}': {e}")

        logger.info(
            f"Firebase: Inventario sincronizado — "
            f"{creados} creados, {actualizados} actualizados, {errores} errores "
            f"(de {total_fb} productos en Firestore)"
        )

        # Guardar timestamp del sync exitoso para el próximo arranque
        try:
            sync_file.write_text(str(_time.time()), encoding='utf-8')
        except Exception:
            pass

    except Exception as e:
        logger.error(f"Firebase: Error descargando inventario inicial: {e}")


def exception_hook(exctype, value, tb):
    """Global exception handler for unhandled exceptions"""
    error_msg = f"{exctype.__name__}: {value}"
    logger.critical(f"Unhandled exception: {error_msg}", exc_info=(exctype, value, tb))

    critical_errors = ['DatabaseError', 'ConnectionError', 'FileNotFoundError']
    show_to_user = any(err in str(exctype.__name__) for err in critical_errors)

    if show_to_user:
        try:
            msg = QMessageBox()
            msg.setIcon(QMessageBox.Critical)
            msg.setWindowTitle("Error del Sistema")
            msg.setText(f"Ha ocurrido un error:\n\n{error_msg}")
            msg.setInformativeText("El error ha sido registrado. Por favor, contacte soporte.")
            msg.setStandardButtons(QMessageBox.Ok)
            msg.exec_()
        except Exception:
            pass

    sys.__excepthook__(exctype, value, tb)


def main():
    """Application entry point"""
    sys.excepthook = exception_hook

    try:
        logger.info("=" * 60)
        logger.info(f"Starting {APP_NAME} v{APP_VERSION}")
        logger.info("=" * 60)

        # 1. Base de datos local (rápido, sin red)
        db = DatabaseManager(str(DATABASE_PATH))
        logger.info("Initializing database...")
        db.initialize_database()

        # 2. Crear la app Qt inmediatamente (la ventana aparece lo antes posible)
        logger.info("Creating application...")
        app = QApplication(sys.argv)
        app.setApplicationName(APP_NAME)
        app.setOrganizationName(ORGANIZATION)
        app.setAttribute(Qt.AA_EnableHighDpiScaling, True)
        app.setAttribute(Qt.AA_UseHighDpiPixmaps, True)

        # Aplicar tema Graphite (paleta cálida + QSS global)
        from pos_system.ui.theme import apply_theme
        apply_theme(app)
        logger.info("Theme: Graphite aplicado.")

        from PyQt5.QtGui import QIcon
        import os
        logo_path = os.path.join(os.path.dirname(__file__), 'pos_system', 'assets', 'images', 'logo.png')
        if os.path.exists(logo_path):
            app.setWindowIcon(QIcon(logo_path))

        # 3. Auto-login desde BD local (sin red)
        logger.info("Auto-login: buscando usuario admin...")
        from pos_system.models.user import User
        _user_model = User(db)
        _user_model.ensure_default_admin()
        _admins = db.execute_query(
            "SELECT * FROM users WHERE role='admin' AND is_active=1 LIMIT 1"
        )
        if _admins:
            logged_user = _admins[0]
        else:
            logged_user = {
                'id': 0, 'username': 'admin', 'role': 'admin',
                'full_name': 'Administrador', 'is_active': 1,
            }
        logger.info(f"Auto-login: {logged_user.get('username')} (role: {logged_user.get('role')})")

        # 4. Mostrar ventana principal inmediatamente
        logger.info("Loading main window...")
        window = MainWindow(current_user=logged_user)
        window.show()
        logger.info("Application started successfully")

        # 5. Firebase + inventario en background (no bloquea la UI)
        import threading

        def _background_init():
            logger.info("Background: Initializing Google Sheets sync...")
            _init_google_sheets()
            logger.info("Background: Initializing Firebase sync...")
            _init_firebase(db)
            logger.info("Background: Syncing inventory from Firebase...")
            _sync_inventory_from_firebase(db)

        threading.Thread(target=_background_init, daemon=True).start()

        # 6. Autostart (registro local, no bloquea)
        try:
            from pos_system.utils.autostart import is_autostart_enabled, set_autostart
            if not is_autostart_enabled():
                set_autostart(True)
                logger.info("Autostart habilitado por defecto.")
        except Exception as e:
            logger.warning(f"No se pudo habilitar autostart por defecto: {e}")

        sys.exit(app.exec_())

    except Exception as e:
        logger.critical(f"Critical startup error: {e}", exc_info=True)

        try:
            msg = QMessageBox()
            msg.setIcon(QMessageBox.Critical)
            msg.setWindowTitle("Error Crítico")
            msg.setText(f"No se pudo iniciar la aplicación:\n\n{str(e)}")
            msg.setStandardButtons(QMessageBox.Ok)
            msg.exec_()
        except Exception:
            pass

        sys.exit(1)


if __name__ == "__main__":
    main()

