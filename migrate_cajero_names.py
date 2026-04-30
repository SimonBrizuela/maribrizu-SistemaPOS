"""Migración one-shot: rename de cajeros en todos los registros locales + Firestore.

Mapeo:
    'Agustin 1' -> 'Agus Gonzalez'
    'Bagatello' -> 'Meli Bagatello'

Ejecutar UNA SOLA VEZ con el POS cerrado (para que SQLite no esté bloqueado).
"""
import sqlite3
import sys

# ── Mapeo de nombres viejos a nuevos ────────────────────────────────────────
RENAMES = {
    'Agustin 1': 'Agus Gonzalez',
    'Bagatello': 'Meli Bagatello',
}

DB_PATH = r"C:\Users\brizu\3D Objects\workana\Mari\pos_database.db"


def migrate_local():
    print("\n=== LOCAL SQLite ===")
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    total = 0
    for old, new in RENAMES.items():
        # sales.turno_nombre
        cur.execute("UPDATE sales SET turno_nombre = ? WHERE turno_nombre = ?", (new, old))
        n1 = cur.rowcount
        # presupuestos.cajero_nombre
        cur.execute("UPDATE presupuestos SET cajero_nombre = ? WHERE cajero_nombre = ?", (new, old))
        n2 = cur.rowcount
        print(f"  '{old}' -> '{new}':  sales={n1}, presupuestos={n2}")
        total += n1 + n2
    con.commit()
    con.close()
    print(f"Local: {total} filas actualizadas")
    return total


def migrate_firestore():
    print("\n=== FIRESTORE ===")
    # Inicializar Firebase con las credenciales del proyecto POS
    import sys, os
    sys.path.insert(0, r"C:\Users\brizu\3D Objects\workana\Mari")
    from pos_system.utils.firebase_sync import init_firebase_sync, get_firebase_sync

    fb = get_firebase_sync()
    if not fb:
        fb = init_firebase_sync()
    if not fb or not fb.enabled:
        print("Firebase no inicializado — saltando migración remota.")
        return 0

    db = fb.db

    # Collections con campos de cajero/turno_nombre
    targets = [
        ('ventas',          ['cajero', 'turno_nombre']),
        ('ventas_por_dia',  ['cajero']),
        ('cierres_caja',    ['cajero']),
        ('presupuestos',    ['cajero_nombre']),
    ]

    total = 0
    for col_name, fields in targets:
        col_total = 0
        for field in fields:
            for old, new in RENAMES.items():
                docs = list(db.collection(col_name).where(field, '==', old).stream())
                if not docs:
                    continue
                # Batch (max 500 por batch de Firestore)
                batch = db.batch()
                for i, doc in enumerate(docs, 1):
                    batch.update(doc.reference, {field: new})
                    if i % 400 == 0:
                        batch.commit()
                        batch = db.batch()
                batch.commit()
                print(f"  {col_name}.{field} '{old}' -> '{new}': {len(docs)} docs")
                col_total += len(docs)
        total += col_total
    print(f"Firestore: {total} docs actualizados")
    return total


if __name__ == '__main__':
    print("Migración de nombres de cajeros")
    print("Mapeo:")
    for old, new in RENAMES.items():
        print(f"  '{old}' -> '{new}'")

    local_count = migrate_local()
    fb_count = migrate_firestore()
    print(f"\n=== TOTAL: {local_count + fb_count} cambios ===")
