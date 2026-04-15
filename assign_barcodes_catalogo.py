"""
Asigna cod_barra unico a productos que no tienen uno en 'catalogo'.
Formato: POS{pos_id} si tiene pos_id, sino usa el doc_id sanitizado.
Solo toca productos con cod_barra vacio o ausente.
"""
import sys
import os
import io
import re

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(__file__))

import firebase_admin
from firebase_admin import credentials, firestore

BARCODE_RE = re.compile(r'^[A-Za-z0-9\-_]{3,50}$')

def sanitize_for_barcode(s):
    """Convierte un string a barcode valido reemplazando chars invalidos por _"""
    s = re.sub(r'[^A-Za-z0-9\-_]', '_', s)
    s = re.sub(r'_+', '_', s).strip('_')
    return s[:50]

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

    # Recopilar barcodes ya usados para garantizar unicidad
    barcodes_usados = set()
    sin_barcode = []
    for doc in docs:
        d = doc.to_dict()
        barra = str(d.get('cod_barra') or '').strip()
        if BARCODE_RE.match(barra):
            barcodes_usados.add(barra)
        else:
            sin_barcode.append((doc.id, d))

    print(f"{len(sin_barcode)} producto(s) sin cod_barra valido.\n")
    if not sin_barcode:
        print("Nada que hacer.")
        return

    # Generar barcode unico para cada uno
    asignaciones = []
    for doc_id, d in sin_barcode:
        nombre = d.get('nombre', '(sin nombre)')
        pos_id = d.get('pos_id')

        # Preferir POS{pos_id}
        if pos_id and str(pos_id).isdigit():
            candidato = f"POS{pos_id}"
        else:
            candidato = sanitize_for_barcode(doc_id)
            if len(candidato) < 3:
                candidato = f"POS{candidato}"

        # Garantizar unicidad agregando sufijo si hace falta
        base = candidato
        sufijo = 1
        while candidato in barcodes_usados:
            candidato = f"{base}_{sufijo}"
            sufijo += 1

        barcodes_usados.add(candidato)
        asignaciones.append((doc_id, nombre, candidato))

    print("Asignaciones a realizar:\n")
    for doc_id, nombre, barcode in asignaciones[:30]:
        print(f"  {nombre[:50]:<50} -> {barcode}")
    if len(asignaciones) > 30:
        print(f"  ... y {len(asignaciones) - 30} mas")

    print()
    resp = input("Aplicar? (s/N): ").strip().lower()
    if resp != 's':
        print("Cancelado.")
        return

    BATCH_SIZE = 500
    count = 0
    batch = db.batch()
    for doc_id, nombre, barcode in asignaciones:
        batch.update(db.collection('catalogo').document(doc_id), {
            'cod_barra': barcode
        })
        count += 1
        if count % BATCH_SIZE == 0:
            batch.commit()
            batch = db.batch()

    if count % BATCH_SIZE != 0:
        batch.commit()

    print(f"\nOK: {count} barcodes asignados en Firebase.")

if __name__ == '__main__':
    main()
