"""
Script: Redondear precios irregulares al centena más cercano y sincronizar a Firebase.
Lee productos_precio_irregular.xlsx, actualiza SQLite local y sube a Firebase.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

import sqlite3
import openpyxl
from datetime import datetime, timezone

from pos_system.config import DATABASE_PATH

def round_to_hundred(price):
    """Redondea al centena más cercano. 2893 -> 2900, 2640 -> 2600."""
    return round(price / 100) * 100

def main():
    # 1. Leer Excel
    print("Leyendo productos_precio_irregular.xlsx...")
    wb = openpyxl.load_workbook('productos_precio_irregular.xlsx')
    ws = wb.active
    excel_rows = list(ws.iter_rows(min_row=2, values_only=True))
    print(f"  {len(excel_rows)} productos en el Excel")

    # 2. Filtrar los que tienen precio no multiplo de 100
    to_update = []
    for row in excel_rows:
        nombre, rubro, categoria, precio, barcode, stock = row
        if not nombre or not isinstance(precio, (int, float)):
            continue
        precio_float = float(precio)
        if precio_float % 100 != 0:
            nuevo_precio = round_to_hundred(precio_float)
            if nuevo_precio != precio_float:
                to_update.append((nombre, precio_float, nuevo_precio, barcode))

    print(f"  {len(to_update)} productos con precio a redondear")

    # 3. Actualizar SQLite local
    print("\nActualizando SQLite local...")
    conn = sqlite3.connect(str(DATABASE_PATH))
    cur = conn.cursor()

    updated_ids = []
    not_found = []
    skipped = []

    for nombre, precio_actual, precio_nuevo, barcode in to_update:
        # Buscar por barcode primero, luego por nombre
        row_db = None
        if barcode:
            cur.execute('SELECT id, name, price FROM products WHERE barcode=?', (str(barcode),))
            row_db = cur.fetchone()
        if not row_db:
            cur.execute('SELECT id, name, price FROM products WHERE name=?', (nombre,))
            row_db = cur.fetchone()

        if not row_db:
            not_found.append(nombre)
            continue

        db_id, db_name, db_price = row_db

        # Si el precio en la DB ya es multiplo de 100, no tocar
        if db_price % 100 == 0:
            skipped.append((nombre, db_price))
            continue

        # Calcular el redondeo basado en el precio ACTUAL en la DB
        precio_redondeado = round_to_hundred(db_price)

        cur.execute(
            'UPDATE products SET price=?, updated_at=datetime("now","localtime") WHERE id=?',
            (float(precio_redondeado), db_id)
        )
        updated_ids.append(db_id)

    conn.commit()
    print(f"  Actualizados en SQLite: {len(updated_ids)}")
    print(f"  Ya redondeados (saltados): {len(skipped)}")
    print(f"  No encontrados en DB: {len(not_found)}")
    if not_found[:5]:
        print(f"  Ejemplos no encontrados: {not_found[:5]}")

    # 4. Sincronizar a Firebase
    print("\nConectando a Firebase...")
    try:
        from pos_system.utils.firebase_sync import init_firebase_sync
        import firebase_admin
        from firebase_admin import credentials, firestore

        # Inicializar Firebase
        try:
            firebase_admin.get_app()
            db_fb = firestore.client()
        except ValueError:
            key_path = 'firebase_key.json'
            cred = credentials.Certificate(key_path)
            firebase_admin.initialize_app(cred)
            db_fb = firestore.client()

        print("  Firebase conectado. Subiendo cambios...")

        # Obtener los productos actualizados de la DB
        if not updated_ids:
            print("  No hay productos para subir a Firebase.")
            conn.close()
            return

        # Subir en batches de 500
        BATCH_SIZE = 500
        total_fb = 0

        for i in range(0, len(updated_ids), BATCH_SIZE):
            batch_ids = updated_ids[i:i+BATCH_SIZE]
            placeholders = ','.join('?' * len(batch_ids))
            cur.execute(
                f'SELECT id, name, category, price, cost, stock, discount_value FROM products WHERE id IN ({placeholders})',
                batch_ids
            )
            products_batch = cur.fetchall()

            batch = db_fb.batch()
            col = db_fb.collection('inventario')
            for prod in products_batch:
                db_id, name, category, price, cost, stock_val, discount = prod
                ref = col.document(str(db_id))
                batch.set(ref, {
                    'precio': float(price),
                    'ultima_actualizacion': datetime.now(timezone.utc)
                }, merge=True)
            batch.commit()
            total_fb += len(products_batch)
            print(f"  Batch {i//BATCH_SIZE + 1}: {len(products_batch)} productos subidos")

        print(f"\n✓ Completado: {total_fb} productos actualizados en Firebase con precios redondeados.")

    except ImportError as e:
        print(f"  ERROR: firebase-admin no instalado: {e}")
    except FileNotFoundError:
        print("  ERROR: No se encontró firebase_key.json")
    except Exception as e:
        print(f"  ERROR Firebase: {e}")
        import traceback
        traceback.print_exc()

    conn.close()

    # 5. Mostrar muestra de cambios
    print("\nMuestra de cambios realizados:")
    show = [(n, po, pn) for n, po, pn, _ in to_update[:10]]
    for n, po, pn in show:
        print(f"  {n}: ${po:.0f} -> ${pn:.0f}")

if __name__ == '__main__':
    main()
