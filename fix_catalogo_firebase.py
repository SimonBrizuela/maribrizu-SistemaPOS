"""
Fix productos con datos inválidos en la colección 'catalogo' de Firestore:
  - stock negativo → 0
  - cod_barra con caracteres inválidos → '' (vacío)
  - cod_barra con menos de 3 caracteres → '' (vacío)
No modifica nombre, precio, ni ningún otro campo.
"""
import sys
import os
import re
import math
import io

# Forzar stdout UTF-8 para evitar crashes con nombres con tildes/símbolos
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

sys.path.insert(0, os.path.dirname(__file__))

import firebase_admin
from firebase_admin import credentials, firestore

BARCODE_RE = re.compile(r'^[A-Za-z0-9\-_]+$')

def es_nan(v):
    return isinstance(v, float) and math.isnan(v)

def barcode_invalido(v):
    if not v:
        return False
    s = str(v).strip()
    if len(s) < 3:
        return True
    if not BARCODE_RE.match(s):
        return True
    return False

def main():
    try:
        firebase_admin.get_app()
        db = firestore.client()
    except ValueError:
        cred = credentials.Certificate('firebase_key.json')
        firebase_admin.initialize_app(cred)
        db = firestore.client()

    print("Leyendo colección 'catalogo'...")
    docs = list(db.collection('catalogo').stream())
    print(f"Total documentos: {len(docs)}\n")

    fixes = []

    for doc in docs:
        d = doc.to_dict()
        update = {}

        # Stock negativo
        stock = d.get('stock')
        if stock is not None:
            if es_nan(stock):
                update['stock'] = 0
            else:
                try:
                    s = int(float(stock))
                    if s < 0:
                        update['stock'] = 0
                except (ValueError, TypeError):
                    update['stock'] = 0

        # cod_barra inválido
        barra = d.get('cod_barra')
        if barra is not None and barcode_invalido(str(barra).strip()):
            update['cod_barra'] = ''

        # Nota: el campo 'codigo' es el codigo interno del producto, NO se toca

        if update:
            fixes.append((doc.id, d.get('nombre', '(sin nombre)'), update))

    if not fixes:
        print("No se encontraron productos con datos inválidos.")
        return

    print(f"{len(fixes)} producto(s) a corregir:\n")
    for doc_id, nombre, update in fixes:
        print(f"  [{doc_id}] {nombre}")
        for k, v in update.items():
            print(f"    {k}: -> {v!r}")
    print()

    resp = input("¿Aplicar correcciones? (s/N): ").strip().lower()
    if resp != 's':
        print("Cancelado.")
        return

    # Aplicar en batches de 500
    BATCH_SIZE = 500
    count = 0
    batch = db.batch()
    for i, (doc_id, nombre, update) in enumerate(fixes):
        batch.update(db.collection('catalogo').document(doc_id), update)
        count += 1
        if count % BATCH_SIZE == 0:
            batch.commit()
            batch = db.batch()

    if count % BATCH_SIZE != 0:
        batch.commit()

    print(f"\nOK: {count} producto(s) corregidos en Firebase.")

if __name__ == '__main__':
    main()
