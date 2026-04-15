"""
Restaura el campo 'codigo' de los productos donde fue borrado por error.
El valor original del codigo es el doc_id del documento en Firestore.
"""
import sys
import os
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(__file__))

import firebase_admin
from firebase_admin import credentials, firestore

def main():
    try:
        firebase_admin.get_app()
        db = firestore.client()
    except ValueError:
        cred = credentials.Certificate('firebase_key.json')
        firebase_admin.initialize_app(cred)
        db = firestore.client()

    print("Leyendo coleccion 'catalogo'...")
    docs = list(db.collection('catalogo').stream())
    print(f"Total documentos: {len(docs)}\n")

    # Productos donde codigo es '' o None pero antes tenia valor (= el doc_id)
    fixes = []
    for doc in docs:
        d = doc.to_dict()
        codigo_actual = d.get('codigo')
        if codigo_actual == '' or codigo_actual is None:
            fixes.append((doc.id, d.get('nombre', '(sin nombre)')))

    if not fixes:
        print("No hay productos con codigo vacio.")
        return

    print(f"{len(fixes)} producto(s) con codigo vacio -> se restaura al doc_id:\n")
    for doc_id, nombre in fixes:
        print(f"  [{doc_id}] {nombre}")

    print()
    resp = input("Aplicar restauracion? (s/N): ").strip().lower()
    if resp != 's':
        print("Cancelado.")
        return

    BATCH_SIZE = 500
    count = 0
    batch = db.batch()
    for doc_id, nombre in fixes:
        batch.update(db.collection('catalogo').document(doc_id), {'codigo': doc_id})
        count += 1
        if count % BATCH_SIZE == 0:
            batch.commit()
            batch = db.batch()

    if count % BATCH_SIZE != 0:
        batch.commit()

    print(f"\nOK: {count} producto(s) restaurados.")

if __name__ == '__main__':
    main()
