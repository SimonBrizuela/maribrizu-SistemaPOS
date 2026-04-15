"""
Solo lectura — lista documentos en 'catalogo' que tienen NaN en campos numericos.
No modifica nada.
"""
import sys, os, math
sys.path.insert(0, os.path.dirname(__file__))

import firebase_admin
from firebase_admin import credentials, firestore

CAMPOS = ['stock', 'precio_venta', 'precio', 'costo', 'descuento', 'discount']

def es_nan(v):
    return isinstance(v, float) and math.isnan(v)

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

    encontrados = []
    for doc in docs:
        d = doc.to_dict()
        campos_nan = [c for c in CAMPOS if es_nan(d.get(c))]
        if campos_nan:
            encontrados.append({
                'doc_id': doc.id,
                'nombre': d.get('nombre') or d.get('name') or '(sin nombre)',
                'campos_nan': campos_nan,
                'valores': {c: d.get(c) for c in campos_nan},
            })

    if not encontrados:
        print("No se encontraron documentos con NaN.")
        return

    print(f"{len(encontrados)} documento(s) con NaN:\n")
    for r in encontrados:
        print(f"  doc_id : {r['doc_id']}")
        print(f"  nombre : {r['nombre']}")
        print(f"  campos : {', '.join(r['campos_nan'])}")
        print()

if __name__ == '__main__':
    main()
