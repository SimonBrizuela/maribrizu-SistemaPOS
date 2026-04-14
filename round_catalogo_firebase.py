"""
Redondea precio_venta y costo al centena mas cercano en la coleccion 'catalogo' de Firebase.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime, timezone

def round100(v):
    if not v or not isinstance(v, (int, float)):
        return v
    return round(float(v) / 100) * 100

def main():
    try:
        firebase_admin.get_app()
        db = firestore.client()
    except ValueError:
        cred = credentials.Certificate('firebase_key.json')
        firebase_admin.initialize_app(cred)
        db = firestore.client()

    print("Leyendo coleccion 'catalogo' de Firebase...")
    docs = list(db.collection('catalogo').stream())
    print(f"  Total documentos: {len(docs)}")

    to_update = []
    for doc in docs:
        d = doc.to_dict()
        costo = d.get('costo', 0) or 0
        precio = d.get('precio_venta', 0) or 0

        new_costo  = round100(costo)
        new_precio = round100(precio)

        if new_costo != costo or new_precio != precio:
            to_update.append((doc.id, new_costo, new_precio))

    print(f"  Documentos con precio a redondear: {len(to_update)}")

    if not to_update:
        print("Nada para actualizar.")
        return

    ts = datetime.now(timezone.utc)
    col = db.collection('catalogo')
    BATCH_SIZE = 500
    total = 0

    for i in range(0, len(to_update), BATCH_SIZE):
        chunk = to_update[i:i+BATCH_SIZE]
        batch = db.batch()
        for doc_id, new_costo, new_precio in chunk:
            ref = col.document(doc_id)
            batch.update(ref, {
                'costo':               float(new_costo),
                'precio_venta':        float(new_precio),
                'ultima_actualizacion': ts,
            })
        batch.commit()
        total += len(chunk)
        print(f"  Batch {i//BATCH_SIZE + 1}: {len(chunk)} actualizados (total: {total})")

    print(f"\nCompleto: {total} productos actualizados en 'catalogo' con precios redondeados.")

    # Verificar el producto del ejemplo
    print("\nVerificacion:")
    q = db.collection('catalogo').where('nombre', '==', 'ACCESORIO PELO ART A-17 BROCHES CBS').limit(1).stream()
    for d in q:
        data = d.to_dict()
        print(f"  ACCESORIO PELO ART A-17: costo={data.get('costo')}, precio_venta={data.get('precio_venta')}")

if __name__ == '__main__':
    main()
