"""
Normaliza los rubros escritos sin acento.

Los rubros publicados en la tienda son LIBRERÍA, MERCERÍA, JUGUETERÍA y
REGALERÍA, con tilde. Un montón de productos los tienen escritos sin tilde
—LIBRERIA, MERCERIA— y como la comparación del sync es exacta, quedaron fuera de
la vidriera. No es una decisión de negocio, es un typo: mismo rubro, distinta
ortografía.

El script busca los que, normalizados (sin tildes, en mayúsculas), coinciden con
un rubro que ya existe, y los reescribe con la ortografía canónica. Después de
esto el sync los publica solo.

No toca los que tienen el rubro vacío ni los que no coinciden con ninguno
(ARTEMISA, VARIOS): esos necesitan que alguien decida a dónde van.

    python fix_rubros_sin_acento.py            # muestra qué haría
    python fix_rubros_sin_acento.py --aplicar

Guarda un backup del estado previo antes de escribir.
"""
import argparse
import collections
import datetime
import json
import os
import sys
import unicodedata

RAIZ = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, RAIZ)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

import firebase_admin
from firebase_admin import credentials, firestore


def conectar():
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(
            credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))
    return firestore.client()


def sin_tildes(texto):
    return ''.join(c for c in unicodedata.normalize('NFD', str(texto or ''))
                   if unicodedata.category(c) != 'Mn').strip().upper()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--aplicar', action='store_true')
    args = ap.parse_args()

    db = conectar()

    # La ortografía buena es la de la colección `rubros`, que es la que usa el
    # panel para armar los filtros.
    canonicos = {}
    for d in db.collection('rubros').stream():
        nombre = str((d.to_dict() or {}).get('nombre') or d.id).strip()
        if nombre:
            canonicos.setdefault(sin_tildes(nombre), nombre.upper())
    print(f'Rubros del sistema: {len(canonicos)}')

    print('Leyendo catálogo...')
    arreglos = []
    huerfanos = collections.Counter()
    for d in db.collection('catalogo').stream():
        x = d.to_dict() or {}
        rubro = str(x.get('rubro') or '').strip()
        if not rubro:
            continue
        clave = sin_tildes(rubro)
        bueno = canonicos.get(clave)
        if bueno is None:
            huerfanos[rubro] += 1
            continue
        if rubro.upper() != bueno:
            arreglos.append((d.id, x.get('nombre') or '', rubro, bueno,
                             x.get('stock')))

    por_cambio = collections.Counter(f'{a[2]} → {a[3]}' for a in arreglos)
    print(f'\nCon el rubro mal escrito: {len(arreglos)}\n')
    for cambio, cant in por_cambio.most_common():
        print(f'  {cambio:<34}{cant:>6}')

    if huerfanos:
        print(f'\nRubros que no existen en el sistema (se dejan como están):')
        for r, c in huerfanos.most_common(12):
            print(f'  {r:<34}{c:>6}')

    if not args.aplicar:
        print('\n(no se escribió nada — repetí con --aplicar)')
        return

    sello = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    ruta = os.path.join(RAIZ, f'backup_rubros_{sello}.json')
    with open(ruta, 'w', encoding='utf-8') as fh:
        json.dump([{'doc_id': a[0], 'nombre': a[1], 'rubro_previo': a[2]}
                   for a in arreglos], fh, ensure_ascii=False, indent=1)
    print(f'\nBackup del estado previo en {os.path.basename(ruta)}')

    ahora = datetime.datetime.now(datetime.timezone.utc)
    batch = db.batch()
    n = 0
    for doc_id, _nombre, _previo, bueno, _stock in arreglos:
        batch.set(db.collection('catalogo').document(doc_id),
                  {'rubro': bueno, 'ultima_actualizacion': ahora}, merge=True)
        n += 1
        if n % 400 == 0:
            batch.commit()
            batch = db.batch()
            print(f'  {n} corregidos...')
    if n % 400:
        batch.commit()

    db.collection('config').document('catalogo_meta').set(
        {'last_updated': ahora.strftime('%Y-%m-%dT%H:%M:%S')}, merge=True)

    print(f'\nListo: {n} productos con el rubro corregido.')
    print('Corré `python scripts/sync_tienda.py` para que los publique.')


if __name__ == '__main__':
    main()
