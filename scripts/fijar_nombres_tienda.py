"""
Fija el nombre de la tienda para que el catalogo general ya no lo pise.

Desde el 2026-08-24 el nombre de la tienda es propio: la ficha del panel lo
guarda en `tienda_nombre` tal cual se ve, y renombrar en el catalogo general
no lo toca. Pero los productos que nadie edito desde entonces no tienen
`tienda_nombre`, asi que siguen heredando el nombre del catalogo: un rename en
el POS todavia les cambia el nombre publico.

Este script corta ese hilo para todo lo que hoy esta publicado: a cada
producto de `tienda_productos` cuyo documento del catalogo no tenga
`tienda_nombre`, le fija como nombre propio el que la tienda muestra hoy.
Nada cambia a la vista; solo queda fijado. El POS no se entera (los campos
`tienda_*` no le importan y el nombre del catalogo no se toca).

    python scripts/fijar_nombres_tienda.py             # solo mira
    python scripts/fijar_nombres_tienda.py --aplicar

Escribe el detalle en `nombres_tienda_fijados.txt` (local, no se commitea:
el repo es publico).
"""
import argparse
import os
import sys
from datetime import datetime

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)
sys.path.insert(0, os.path.join(RAIZ, 'scripts'))
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

import firebase_admin
from firebase_admin import credentials, firestore

INFORME = os.path.join(RAIZ, 'nombres_tienda_fijados.txt')


def conectar():
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(
            credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))
    return firestore.client()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--aplicar', action='store_true',
                    help='escribir; sin esto solo muestra')
    args = ap.parse_args()

    db = conectar()

    publicados = {d.id: str((d.to_dict() or {}).get('nombre') or '').strip()
                  for d in db.collection('tienda_productos').select(['nombre']).stream()}
    print(f'{len(publicados)} productos publicados en la tienda')

    # El catalogo entero en una sola pasada: pedir los 2.300 documentos de a
    # uno seria una espera de minutos para leer un campo.
    propios = {d.id: str((d.to_dict() or {}).get('tienda_nombre') or '').strip()
               for d in db.collection('catalogo').select(['tienda_nombre']).stream()}

    plan = []          # (id, nombre a fijar)
    ya_fijados = 0
    sin_catalogo = []
    for doc_id, nombre in publicados.items():
        if doc_id not in propios:
            sin_catalogo.append(doc_id)
            continue
        if propios[doc_id]:
            ya_fijados += 1
            continue
        if nombre:
            plan.append((doc_id, nombre))

    lineas = [
        f'Nombres de la tienda fijados · {datetime.now():%d/%m/%Y %H:%M}',
        f'Publicados: {len(publicados)}',
        f'  ya tenian nombre propio: {ya_fijados}',
        f'  se les fija el que muestran hoy: {len(plan)}',
        f'  sin documento en el catalogo (raro, mirar): {len(sin_catalogo)}',
        '',
    ]
    lineas += [f'  {doc_id:<16} {nombre}' for doc_id, nombre in plan]
    if sin_catalogo:
        lineas += ['', 'SIN CATALOGO:'] + [f'  {i}' for i in sin_catalogo]
    with open(INFORME, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lineas) + '\n')
    print('\n'.join(lineas[:5]))
    print(f'\nDetalle en {INFORME}')

    if not args.aplicar:
        print('\nSin --aplicar no se escribio nada.')
        return

    # Solo se agrega `tienda_nombre` con el nombre que YA se muestra: no hay
    # nada que re-espejar ni que avisarle al POS. Por eso tampoco se toca
    # `catalogo_meta`: para las PCs no cambio nada.
    col = db.collection('catalogo')
    batch = db.batch()
    n = 0
    for doc_id, nombre in plan:
        batch.set(col.document(doc_id), {'tienda_nombre': nombre}, merge=True)
        n += 1
        if n >= 400:
            batch.commit()
            batch = db.batch()
            n = 0
    if n:
        batch.commit()

    print(f'\nListo: {len(plan)} nombres fijados. Renombrar en el catalogo '
          f'general ya no cambia ninguno de estos.')


if __name__ == '__main__':
    main()
