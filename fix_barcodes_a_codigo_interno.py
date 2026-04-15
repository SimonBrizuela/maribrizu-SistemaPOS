"""
Reemplaza cod_barra por el codigo interno de cada producto en Firebase:
  - Productos con cod_barra tipo "POS123" (pos + numeros) → se reemplaza por campo 'codigo'
  - Productos sin cod_barra (vacio o ausente) → se asigna el campo 'codigo'
  - Actualiza ultima_actualizacion para que las PCs conectadas detecten el cambio.
"""
import sys
import os
import io
import re
from datetime import datetime, timezone, timedelta

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.path.insert(0, os.path.dirname(__file__))

import firebase_admin
from firebase_admin import credentials, firestore

# Patron: "pos" (case-insensitive) seguido solo de digitos
POS_BARCODE_RE = re.compile(r'^[Pp][Oo][Ss]\d+$')

TZ_AR = timezone(timedelta(hours=-3))


def es_pos_barcode(v):
    if not v:
        return False
    return bool(POS_BARCODE_RE.match(str(v).strip()))


def es_vacio(v):
    return not v or str(v).strip() == ''


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

    a_actualizar = []     # (doc_id, nombre, cod_barra_actual, codigo_interno)
    sin_codigo = []       # productos que necesitaban cambio pero no tienen 'codigo'

    for doc in docs:
        d = doc.to_dict()
        nombre = str(d.get('nombre') or '(sin nombre)').strip()
        cod_barra = str(d.get('cod_barra') or '').strip()
        codigo = str(d.get('codigo') or '').strip()

        necesita_cambio = es_pos_barcode(cod_barra) or es_vacio(cod_barra)

        if not necesita_cambio:
            continue

        if not codigo:
            sin_codigo.append((doc.id, nombre, cod_barra))
            continue

        a_actualizar.append((doc.id, nombre, cod_barra or '(vacio)', codigo))

    # Reporte
    if sin_codigo:
        print(f"ADVERTENCIA: {len(sin_codigo)} producto(s) necesitan cambio pero NO tienen campo 'codigo':")
        for doc_id, nombre, barra in sin_codigo[:20]:
            print(f"  [{doc_id}] {nombre[:50]} (cod_barra actual: '{barra}')")
        if len(sin_codigo) > 20:
            print(f"  ... y {len(sin_codigo) - 20} mas")
        print()

    if not a_actualizar:
        print("No hay productos para actualizar.")
        return

    print(f"{len(a_actualizar)} producto(s) a actualizar:\n")
    print(f"  {'NOMBRE':<50} {'BARRA ACTUAL':<20} -> {'CODIGO INTERNO'}")
    print(f"  {'-'*50} {'-'*20}    {'-'*20}")
    for doc_id, nombre, barra_actual, codigo in a_actualizar[:50]:
        print(f"  {nombre[:50]:<50} {barra_actual:<20} -> {codigo}")
    if len(a_actualizar) > 50:
        print(f"  ... y {len(a_actualizar) - 50} mas")

    print()
    resp = input("Aplicar cambios en Firebase? (s/N): ").strip().lower()
    if resp != 's':
        print("Cancelado.")
        return

    now_str = datetime.now(TZ_AR).strftime('%Y-%m-%dT%H:%M:%S')

    BATCH_SIZE = 500
    count = 0
    batch = db.batch()

    for doc_id, nombre, barra_actual, codigo in a_actualizar:
        ref = db.collection('catalogo').document(doc_id)
        batch.update(ref, {
            'cod_barra': codigo,
            'ultima_actualizacion': now_str
        })
        count += 1
        if count % BATCH_SIZE == 0:
            batch.commit()
            batch = db.batch()
            print(f"  Batch {count // BATCH_SIZE} enviado...")

    if count % BATCH_SIZE != 0:
        batch.commit()

    print(f"\nOK: {count} producto(s) actualizados en Firebase.")
    print("Las PCs conectadas detectaran los cambios en el proximo sync.")


if __name__ == '__main__':
    main()
