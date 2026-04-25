"""
Descarga la coleccion 'catalogo' de Firebase y filtra los productos cuyo nombre empieza con 'A'.
Guarda el resultado en productos_A.csv
"""
import sys, os, csv
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

    print("Leyendo coleccion 'catalogo' de Firebase...")
    docs = list(db.collection('catalogo').stream())
    print(f"  Total documentos: {len(docs)}")

    productos_a = []
    for doc in docs:
        d = doc.to_dict()
        nombre = (d.get('nombre') or '').strip()
        if nombre and nombre[0].upper() == 'A':
            d['_id'] = doc.id
            productos_a.append(d)

    productos_a.sort(key=lambda x: (x.get('nombre') or '').upper())
    print(f"  Productos que empiezan con 'A': {len(productos_a)}")

    if not productos_a:
        print("Nada para guardar.")
        return

    keys = set()
    for p in productos_a:
        keys.update(p.keys())
    preferidos = ['_id', 'codigo_interno', 'codigo_barras', 'nombre', 'categoria',
                  'costo', 'precio_venta', 'stock', 'unidad', 'iva', 'proveedor']
    columnas = [k for k in preferidos if k in keys] + sorted(k for k in keys if k not in preferidos)

    out = 'productos_A.csv'
    with open(out, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=columnas, extrasaction='ignore')
        w.writeheader()
        for p in productos_a:
            w.writerow({k: p.get(k, '') for k in columnas})

    print(f"\nArchivo generado: {out} ({len(productos_a)} filas)")
    print("\nPrimeros 10:")
    for p in productos_a[:10]:
        print(f"  - {p.get('nombre')}  | costo={p.get('costo')}  precio={p.get('precio_venta')}  stock={p.get('stock')}")


if __name__ == '__main__':
    main()
