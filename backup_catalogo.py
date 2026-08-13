"""
Copia de seguridad del catálogo completo desde Firestore.

Es la red antes de tocar stock en masa: guarda cada producto tal cual está, con
todos sus campos, en un JSON con fecha. Si una migración deja algo mal, con este
archivo se vuelve atrás producto por producto.

    python backup_catalogo.py
    python backup_catalogo.py --coleccion inventario
    python backup_catalogo.py --restaurar backup_catalogo_20260813_1330.json --campos stock
    python backup_catalogo.py --restaurar <archivo> --campos stock --aplicar

Sin `--aplicar`, restaurar solo muestra qué cambiaría. `--campos` limita la
vuelta atrás a esos campos (lo normal: `stock`), para no pisar precios ni fotos
que se hayan editado legítimamente después del backup.

El JSON queda en la raíz y NO se commitea: el repo es público.
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

import firebase_admin
from firebase_admin import credentials, firestore

RAIZ = os.path.dirname(os.path.abspath(__file__))


def conectar():
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(
            credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))
    return firestore.client()


def serializable(v):
    if isinstance(v, datetime.datetime):
        return {'__fecha__': v.isoformat()}
    if isinstance(v, dict):
        return {k: serializable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [serializable(x) for x in v]
    return v


def guardar(db, coleccion):
    print(f'Leyendo {coleccion}...')
    datos = {}
    for d in db.collection(coleccion).stream():
        datos[d.id] = serializable(d.to_dict() or {})

    sello = datetime.datetime.now().strftime('%Y%m%d_%H%M')
    ruta = os.path.join(RAIZ, f'backup_{coleccion}_{sello}.json')
    with open(ruta, 'w', encoding='utf-8') as fh:
        json.dump(datos, fh, ensure_ascii=False, indent=1)

    mb = os.path.getsize(ruta) / 1e6
    print(f'{len(datos)} documentos guardados en {os.path.basename(ruta)} ({mb:.1f} MB)')

    con_stock = sum(1 for x in datos.values()
                    if isinstance(x.get('stock'), (int, float)) and x['stock'] > 0)
    print(f'  con stock mayor a cero: {con_stock}')
    return ruta


def restaurar(db, archivo, campos, aplicar, coleccion):
    with open(archivo, encoding='utf-8') as fh:
        datos = json.load(fh)
    print(f'{len(datos)} documentos en el backup.\n')

    # La colección se lee de una sola vez. Pedir doc por doc son 9.600 lecturas
    # encoladas: tarda minutos y cuesta plata para el mismo resultado.
    print('Leyendo el estado actual...')
    actual_por_id = {d.id: (d.to_dict() or {})
                     for d in db.collection(coleccion).stream()}

    cambios = []
    for doc_id, guardado in datos.items():
        x = actual_por_id.get(doc_id)
        if x is None:
            continue
        dif = {c: guardado.get(c) for c in campos
               if guardado.get(c) != x.get(c) and not isinstance(guardado.get(c), dict)}
        if dif:
            cambios.append((doc_id, x.get('nombre') or '', dif,
                            {c: x.get(c) for c in dif}))

    print(f'Con diferencias en {", ".join(campos)}: {len(cambios)}\n')
    for doc_id, nombre, dif, ahora in cambios[:40]:
        detalle = ' · '.join(f'{c}: {ahora[c]} -> {v}' for c, v in dif.items())
        print(f'  {doc_id:<14} {nombre[:40]:<40} {detalle}')

    if not aplicar:
        print('\nNada escrito. Repetí con --aplicar para volver atrás de verdad.')
        return

    ahora_dt = datetime.datetime.now(datetime.timezone.utc)
    batch = db.batch()
    n = 0
    for doc_id, _nombre, dif, _prev in cambios:
        batch.set(db.collection(coleccion).document(doc_id),
                  {**dif, 'ultima_actualizacion': ahora_dt}, merge=True)
        n += 1
        if n % 200 == 0:
            batch.commit(); batch = db.batch()
    if n % 200:
        batch.commit()
    db.collection('config').document('catalogo_meta').set(
        {'last_updated': ahora_dt.strftime('%Y-%m-%dT%H:%M:%S')}, merge=True)
    print(f'\n{n} documentos vueltos al estado del backup.')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--coleccion', default='catalogo')
    ap.add_argument('--restaurar', help='archivo de backup a restaurar')
    ap.add_argument('--campos', nargs='+', default=['stock'],
                    help='qué campos volver atrás (por defecto: stock)')
    ap.add_argument('--aplicar', action='store_true')
    args = ap.parse_args()

    db = conectar()
    if args.restaurar:
        restaurar(db, args.restaurar, args.campos, args.aplicar, args.coleccion)
    else:
        guardar(db, args.coleccion)


if __name__ == '__main__':
    main()
