"""
Restaura el campo 'costo' en Firebase catalogo usando el backup local.
Solo toca 'costo', no modifica 'precio_venta'.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

import json
import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime

def main():
    # Cargar backup
    print("Leyendo backup...")
    with open('backups/firebase_catalogo_backup.json', 'r', encoding='utf-8') as f:
        backup = json.load(f)
    print(f"  {len(backup)} registros en backup")

    # Conectar Firebase
    try:
        firebase_admin.get_app()
        db = firestore.client()
    except ValueError:
        cred = credentials.Certificate('firebase_key.json')
        firebase_admin.initialize_app(cred)
        db = firestore.client()

    # Indexar backup por doc_id
    backup_by_id = {}
    for item in backup:
        doc_id = item.get('_firebase_doc_id') or item.get('doc_id')
        if doc_id:
            backup_by_id[str(doc_id)] = item

    print(f"  {len(backup_by_id)} docs con ID en backup")

    # Restaurar solo el campo costo
    col = db.collection('catalogo')
    BATCH_SIZE = 500
    to_restore = list(backup_by_id.items())
    total = 0

    for i in range(0, len(to_restore), BATCH_SIZE):
        chunk = to_restore[i:i+BATCH_SIZE]
        batch = db.batch()
        for doc_id, item in chunk:
            costo_original = item.get('costo', 0) or 0
            ref = col.document(doc_id)
            batch.update(ref, {'costo': float(costo_original)})
        batch.commit()
        total += len(chunk)
        print(f"  Batch {i//BATCH_SIZE + 1}: {len(chunk)} costos restaurados (total: {total})")

    print(f"\nCompleto: {total} costos restaurados desde backup.")

    # Verificar
    print("\nVerificacion:")
    for item in backup[:3]:
        doc_id = item.get('_firebase_doc_id')
        doc = col.document(str(doc_id)).get()
        if doc.exists:
            d = doc.to_dict()
            print(f"  {d.get('nombre','')[:40]}: costo={d.get('costo')} (backup: {item.get('costo')})")

if __name__ == '__main__':
    main()
