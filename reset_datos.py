#!/usr/bin/env python
"""
RESET DE DATOS - Sistema POS
=============================
Elimina todas las ventas, cajas y dashboard.
Conserva: inventario, catalogo, cajeros, rubros, promociones.

USO:
  python reset_datos.py

Siempre hace un backup de la base de datos antes de borrar.
"""

import os
import sys
import shutil
import sqlite3
from pathlib import Path
from datetime import datetime

# ── Rutas ────────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent

# En desarrollo la DB vive en la raiz del proyecto
# En produccion (exe) vive en %APPDATA%\SistemaPOS\
if getattr(sys, 'frozen', False):
    DATA_DIR = Path(os.environ.get('APPDATA', Path.home())) / "SistemaPOS"
else:
    DATA_DIR = SCRIPT_DIR

DB_PATH     = DATA_DIR / "pos_database.db"
BACKUP_DIR  = DATA_DIR / "backups"
FIREBASE_KEY = SCRIPT_DIR / "firebase_key.json"

# ── Tablas SQLite a limpiar ───────────────────────────────────────────────────
TABLAS_A_LIMPIAR = [
    "sale_items",       # items de cada venta (borrar antes que sales por FK)
    "sales",            # ventas
    "withdrawals",      # retiros de caja
    "cash_register",    # cajas (apertura/cierre)
    "stock_adjustments",# ajustes de stock (historial)
    "facturas",         # facturas generadas
]

# ── Colecciones Firebase a limpiar ────────────────────────────────────────────
COLECCIONES_FIREBASE = [
    "ventas",
    "ventas_por_dia",
    "cierres_caja",
    "historial_diario",
    "resumenes_mensuales",
    "top_productos",
    "productos_mas_vendidos",
    "caja_activa",
]

# ─────────────────────────────────────────────────────────────────────────────

def confirmar(pregunta: str) -> bool:
    resp = input(f"{pregunta} [s/N]: ").strip().lower()
    return resp in ("s", "si", "sí", "y", "yes")

def hacer_backup() -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = BACKUP_DIR / f"pos_database_PRERRESET_{ts}.db"
    shutil.copy2(DB_PATH, backup_path)
    return backup_path

def reset_sqlite():
    print("\n[SQLite] Conectando a", DB_PATH)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA foreign_keys = OFF")
    cur = conn.cursor()
    total = 0
    for tabla in TABLAS_A_LIMPIAR:
        try:
            cur.execute(f"SELECT COUNT(*) FROM {tabla}")
            n = cur.fetchone()[0]
            cur.execute(f"DELETE FROM {tabla}")
            conn.commit()
            print(f"  OK {tabla}: {n} filas eliminadas")
            total += n
        except sqlite3.OperationalError as e:
            print(f"  -- {tabla}: no existe o error ({e})")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.close()
    print(f"[SQLite] Total: {total} filas eliminadas")

def _borrar_coleccion(db, nombre: str):
    """Borra todos los documentos de una coleccion en batches de 500."""
    col = db.collection(nombre)
    borrados = 0
    while True:
        docs = list(col.limit(500).stream())
        if not docs:
            break
        batch = db.batch()
        for doc in docs:
            batch.delete(doc.reference)
        batch.commit()
        borrados += len(docs)
    return borrados

def reset_firebase():
    print("\n[Firebase] Inicializando...")
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore

        candidates = [
            FIREBASE_KEY,
            SCRIPT_DIR / "_internal" / "firebase_key.json",
        ]
        key_path = next((p for p in candidates if p.exists()), None)
        if not key_path:
            print("  AVISO: No se encontro firebase_key.json. Saltando reset de Firebase.")
            return

        try:
            firebase_admin.get_app()
        except ValueError:
            cred = credentials.Certificate(str(key_path))
            firebase_admin.initialize_app(cred)

        db = firestore.client()
        total = 0
        for col in COLECCIONES_FIREBASE:
            n = _borrar_coleccion(db, col)
            print(f"  OK {col}: {n} documentos eliminados")
            total += n
        print(f"[Firebase] Total: {total} documentos eliminados")

    except ImportError:
        print("  AVISO: firebase-admin no instalado. Saltando reset de Firebase.")
    except Exception as e:
        print(f"  ERROR en Firebase: {e}")

# ─────────────────────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("  RESET DE DATOS - Sistema POS")
    print("=" * 60)
    print()
    print("Esto ELIMINARA permanentemente:")
    print("  - Todas las ventas y sus items")
    print("  - Todos los cierres de caja")
    print("  - Historial diario y mensual")
    print("  - Retiros y ajustes de stock")
    print("  - Colecciones de Firebase correspondientes")
    print()
    print("Se CONSERVARA:")
    print("  - Inventario y catalogo de productos")
    print("  - Cajeros / usuarios")
    print("  - Rubros y promociones")
    print()

    if not DB_PATH.exists():
        print(f"ERROR: No se encontro la base de datos en:\n  {DB_PATH}")
        sys.exit(1)

    if not confirmar("Confirmas el RESET TOTAL de datos?"):
        print("Cancelado.")
        sys.exit(0)

    if not confirmar("Estas SEGURO? Esta accion no se puede deshacer"):
        print("Cancelado.")
        sys.exit(0)

    # Backup
    print("\n[Backup] Creando copia de seguridad...")
    try:
        backup = hacer_backup()
        print(f"  OK Backup guardado en:\n  {backup}")
    except Exception as e:
        print(f"  ERROR al crear backup: {e}")
        if not confirmar("No se pudo crear el backup. Continuar de todas formas?"):
            sys.exit(1)

    # Reset SQLite
    reset_sqlite()

    # Reset Firebase
    reset_firebase()

    print()
    print("=" * 60)
    print("  RESET COMPLETADO")
    print("=" * 60)
    print(f"  Backup en: {BACKUP_DIR}")
    print()

if __name__ == "__main__":
    main()
