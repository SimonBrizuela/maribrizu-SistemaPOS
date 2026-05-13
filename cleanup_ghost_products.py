#!/usr/bin/env python3
"""
cleanup_ghost_products.py
--------------------------
Detecta y elimina productos "fantasma" de Firebase:
productos que existen en Firestore (coleccion 'catalogo')
pero ya NO existen en la base de datos local de SQLite.

Uso:
    python cleanup_ghost_products.py [--dry-run]

    --dry-run   Solo reporta los fantasmas sin borrar nada.
"""

import sys
import os
import sqlite3
import datetime
from pathlib import Path


# ── Localizar firebase_key.json ────────────────────────────────────────────────

def find_firebase_key():
    candidates = [
        Path(__file__).parent / "firebase_key.json",
        Path(os.environ.get("APPDATA", "")) / "SistemaPOS" / "firebase_key.json",
        Path("firebase_key.json"),
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return None


# ── Localizar base de datos SQLite ─────────────────────────────────────────────

def find_db():
    candidates = [
        Path(__file__).parent / "pos_database.db",
        Path(os.environ.get("APPDATA", "")) / "SistemaPOS" / "pos_database.db",
        Path("pos_database.db"),
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return None


# ── Conectar a Firebase ────────────────────────────────────────────────────────

def init_firebase(key_path):
    import firebase_admin
    from firebase_admin import credentials, firestore
    try:
        firebase_admin.get_app()
    except ValueError:
        cred = credentials.Certificate(key_path)
        firebase_admin.initialize_app(cred)
    return firestore.client()


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    dry_run = "--dry-run" in sys.argv

    print("=" * 60)
    print("  Limpieza de productos fantasma en Firebase")
    print("=" * 60)
    if dry_run:
        print("  MODO: DRY-RUN (solo lectura, no borra nada)")
    print()

    # 1. Firebase
    key_path = find_firebase_key()
    if not key_path:
        print("ERROR: No se encontro firebase_key.json.")
        print("  Coloca el archivo en la carpeta raiz del proyecto.")
        sys.exit(1)
    print(f"Firebase key: {key_path}")
    fb_db = init_firebase(key_path)
    print("Firebase: conectado.")

    # 2. SQLite
    db_path = find_db()
    if not db_path:
        print("ERROR: No se encontro pos_database.db.")
        sys.exit(1)
    print(f"SQLite DB:    {db_path}")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    print()

    # 3. Leer todos los firebase_ids de la BD local
    cur = conn.cursor()
    cur.execute("SELECT firebase_id FROM products WHERE firebase_id IS NOT NULL AND firebase_id != ''")
    local_ids = {row["firebase_id"] for row in cur.fetchall()}
    print(f"Productos en SQLite con firebase_id: {len(local_ids)}")

    # 4. Leer todos los documentos de Firebase catalogo
    print("Leyendo coleccion 'catalogo' desde Firestore...")
    all_docs = list(fb_db.collection("catalogo").stream())
    print(f"Documentos en Firestore 'catalogo': {len(all_docs)}")
    print()

    # 5. Detectar fantasmas
    ghosts = []
    for doc in all_docs:
        if doc.id not in local_ids:
            data = doc.to_dict() or {}
            ghosts.append({
                "firebase_id": doc.id,
                "nombre": data.get("nombre") or data.get("name") or "(sin nombre)",
                "precio": data.get("precio_venta") or data.get("precio") or 0,
            })

    print(f"Productos fantasma encontrados: {len(ghosts)}")
    print()

    if not ghosts:
        print("No hay fantasmas. La coleccion esta limpia.")
        conn.close()
        return

    # 6. Mostrar lista de fantasmas
    print(f"{'#':<5} {'firebase_id':<35} {'Nombre':<40} {'Precio':>10}")
    print("-" * 95)
    for i, g in enumerate(ghosts, 1):
        print(f"{i:<5} {g['firebase_id']:<35} {g['nombre'][:39]:<40} ${g['precio']:>9,.0f}")
    print()

    if dry_run:
        print("DRY-RUN: no se realizo ninguna accion.")
        conn.close()
        return

    # 7. Confirmacion
    respuesta = input("Escribe SI (en mayusculas) para eliminar estos productos de Firebase: ").strip()
    if respuesta != "SI":
        print("Operacion cancelada.")
        conn.close()
        return

    # 8. Eliminar
    print()
    from firebase_admin import firestore as _fs
    eliminados = 0
    errores = 0
    ahora = datetime.datetime.utcnow()

    for g in ghosts:
        fid = g["firebase_id"]
        try:
            fb_db.collection("catalogo").document(fid).delete()
            fb_db.collection("catalogo_deleted").document(fid).set({
                "deleted_at": ahora,
            })
            print(f"  OK  {fid}  ({g['nombre'][:40]})")
            eliminados += 1
        except Exception as e:
            print(f"  ERROR  {fid}: {e}")
            errores += 1

    print()
    print("=" * 60)
    print(f"  Resultado: {eliminados} eliminados, {errores} errores")
    print("=" * 60)
    conn.close()


if __name__ == "__main__":
    main()
