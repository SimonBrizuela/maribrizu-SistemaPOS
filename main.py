import sys
import logging
from PyQt5.QtWidgets import QApplication, QMessageBox
from PyQt5.QtCore import Qt

from pos_system.config import APP_NAME, ORGANIZATION, APP_VERSION
from pos_system.ui.main_window import MainWindow
from pos_system.ui.login_dialog import LoginDialog
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


def _init_firebase():
    """
    Inicializa la sincronización con Firebase Firestore.
    Requiere firebase_key.json en la raíz del proyecto.
    """
    try:
        from pos_system.utils.firebase_sync import init_firebase_sync
        sync = init_firebase_sync()
        if sync:
            logger.info("Firebase: Sincronización activa.")
        else:
            logger.info("Firebase: Sync desactivado (sin firebase_key.json o firebase-admin no instalado).")
    except Exception as e:
        logger.error(f"Firebase: Error al inicializar: {e}")


def _sync_inventory_from_firebase(db):
    """
    Descarga el inventario completo desde Firestore y lo aplica a la BD local.
    Esto garantiza que el POS siempre tenga los datos actualizados al iniciar,
    incluyendo productos, precios, stock, rubros y códigos de barra cargados desde la web.
    """
    try:
        from pos_system.utils.firebase_sync import get_firebase_sync
        fb = get_firebase_sync()
        if not fb:
            return

        logger.info("Firebase: Descargando catalogo desde Firestore...")

        # El catalogo real esta en la coleccion 'catalogo'
        # Con 6000+ productos usamos paginacion para no saturar la memoria
        from pos_system.models.product import Product
        from pos_system.utils.validators import ValidationError
        product_model = Product(db)

        actualizados = 0
        creados = 0
        errores = 0
        total_fb = 0

        # Traer todos los docs de una vez con stream() — Firestore lo maneja eficientemente
        all_docs = list(fb.db.collection('catalogo').stream())
        total_fb = len(all_docs)
        logger.info(f"Firebase: {total_fb} productos encontrados en catalogo.")

        for doc in all_docs:
            p = doc.to_dict()
            if not p:
                continue
            try:
                # Mapear campos del catálogo → campos locales
                firebase_id = doc.id  # ID único del documento en Firebase
                pos_id      = p.get('pos_id')  # ID numérico único asignado por el sistema
                nombre    = str(p.get('nombre') or '').strip()
                precio    = float(p.get('precio_venta') or p.get('precio') or 0)
                stock     = int(p.get('stock') or 0)
                costo     = float(p.get('costo') or 0)
                categoria = str(p.get('categoria') or '').strip()
                rubro     = str(p.get('rubro') or '').strip()
                # cod_barra es el EAN/UPC; codigo es el código interno
                barcode   = str(p.get('cod_barra') or p.get('codigo') or '').strip()
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
                        product_model.update(local['id'], **upd)
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
                logger.debug(f"Firebase catalogo '{p.get('nombre','?')}': {e}")

        logger.info(
            f"Firebase: Inventario sincronizado — "
            f"{creados} creados, {actualizados} actualizados, {errores} errores "
            f"(de {total_fb} productos en Firestore)"
        )

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

        # Inicializar base de datos
        db = DatabaseManager()
        logger.info("Initializing database...")
        db.initialize_database()

        # Inicializar Google Sheets (no bloquea si falla)
        logger.info("Initializing Google Sheets sync...")
        _init_google_sheets()

        # Inicializar Firebase Firestore (no bloquea si falla)
        logger.info("Initializing Firebase sync...")
        _init_firebase()

        # Sincronizar inventario desde Firebase en background (no bloquea la apertura)
        import threading
        logger.info("Syncing inventory from Firebase (background)...")
        t = threading.Thread(target=_sync_inventory_from_firebase, args=(db,), daemon=True)
        t.start()

        # Crear aplicación Qt
        logger.info("Creating application...")
        app = QApplication(sys.argv)
        app.setApplicationName(APP_NAME)
        app.setOrganizationName(ORGANIZATION)
        app.setAttribute(Qt.AA_EnableHighDpiScaling, True)
        app.setAttribute(Qt.AA_UseHighDpiPixmaps, True)

        # Ícono de la aplicación
        from PyQt5.QtGui import QIcon
        import os
        logo_path = os.path.join(os.path.dirname(__file__), 'pos_system', 'assets', 'images', 'logo.png')
        if os.path.exists(logo_path):
            app.setWindowIcon(QIcon(logo_path))

        # Mostrar login
        logger.info("Showing login dialog...")
        login = LoginDialog(db)
        if login.exec_() != LoginDialog.Accepted:
            logger.info("Login cancelled — application exit")
            sys.exit(0)

        logged_user = login.logged_user
        logger.info(f"Authenticated as: {logged_user['username']} (role: {logged_user['role']})")

        # Abrir ventana principal con el usuario autenticado
        logger.info("Loading main window...")
        window = MainWindow(current_user=logged_user)
        window.show()

        logger.info("Application started successfully")
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

