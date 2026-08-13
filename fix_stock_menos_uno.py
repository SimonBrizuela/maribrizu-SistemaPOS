"""
Separa los servicios de verdad de los productos que quedaron congelados en -1.

El POS usaba `stock = -1` como bandera de servicio/ilimitado. El problema es que
a -1 llega solo cualquier producto común que se venda estando en cero, y desde
ese momento el sistema lo trataba como una fotocopia: dejaba de descontarlo en la
PC y en la nube. Las ventas se volvían invisibles y, al reponerlo a mano, el
stock arrancaba con más unidades de las que había en la góndola.

Este script deja las dos cosas separadas:

  · Servicios (rubro SERVICIOS)  → `stock_ilimitado: true`, y el stock queda en
    -1 para que las PCs que todavía no se actualizaron los sigan reconociendo.
  · Productos de góndola          → stock a 0, sin bandera. Vuelven a descontar
    desde la próxima venta y aparecen como agotados hasta que se repongan.

Cada cambio queda anotado en `stock_movimientos`, así que después se puede ver
qué tocó este script y cuándo.

    python fix_stock_menos_uno.py            # muestra qué va a hacer, no escribe
    python fix_stock_menos_uno.py --aplicar  # escribe

Antes de aplicar guarda un backup JSON con el estado previo de cada producto.
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--aplicar', action='store_true', help='escribir los cambios')
    args = ap.parse_args()

    db = conectar()

    print('Leyendo catálogo...')
    servicios, gondola = [], []
    for d in db.collection('catalogo').stream():
        x = d.to_dict() or {}
        if x.get('estado') == 'baja' or x.get('duplicado'):
            continue
        try:
            stock = float(x.get('stock') or 0)
        except (TypeError, ValueError):
            continue
        if stock != -1:
            continue
        destino = servicios if x.get('rubro') == 'SERVICIOS' else gondola
        destino.append((d.id, x))

    print(f'\nServicios de verdad (quedan en -1 + bandera): {len(servicios)}')
    for doc_id, x in servicios:
        print(f'  {doc_id:<14} {str(x.get("nombre"))[:56]}')

    print(f'\nProductos de góndola congelados (pasan a 0): {len(gondola)}')
    for doc_id, x in gondola[:100]:
        print(f'  {doc_id:<14} {str(x.get("nombre"))[:44]:<44} {x.get("rubro") or ""}')

    if not args.aplicar:
        print('\nNada escrito. Repetí con --aplicar para hacerlo.')
        return

    sello = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    ruta = os.path.join(RAIZ, f'backup_stock_menos_uno_{sello}.json')
    with open(ruta, 'w', encoding='utf-8') as fh:
        json.dump({
            'servicios': [{'doc_id': i, 'nombre': x.get('nombre'), 'stock': x.get('stock')}
                          for i, x in servicios],
            'gondola':   [{'doc_id': i, 'nombre': x.get('nombre'), 'stock': x.get('stock')}
                          for i, x in gondola],
        }, fh, ensure_ascii=False, indent=1)
    print(f'\nBackup del estado previo en {os.path.basename(ruta)}')

    ahora = datetime.datetime.now(datetime.timezone.utc)
    movs = db.collection('stock_movimientos')
    batch = db.batch()
    pendientes = 0

    def anotar(doc_id, x, antes, despues, detalle):
        batch.set(movs.document(), {
            'ts': ahora, 'origen': 'script', 'pc_id': 'script',
            'usuario': 'fix_stock_menos_uno', 'producto_id': x.get('pos_id'),
            'firebase_id': doc_id, 'producto_nombre': x.get('nombre') or '',
            'motivo': 'conteo', 'cantidad': despues - antes,
            'stock_antes': antes, 'stock_despues': despues,
            'referencia': 'Arreglo del stock -1', 'detalle': detalle,
        })

    for doc_id, x in servicios:
        batch.set(db.collection('catalogo').document(doc_id), {
            'stock_ilimitado': True, 'ultima_actualizacion': ahora,
        }, merge=True)
        pendientes += 1
        if pendientes >= 200:
            batch.commit(); batch = db.batch(); pendientes = 0

    for doc_id, x in gondola:
        batch.set(db.collection('catalogo').document(doc_id), {
            'stock': 0, 'stock_ilimitado': False, 'ultima_actualizacion': ahora,
        }, merge=True)
        anotar(doc_id, x, -1.0, 0.0, 'Estaba congelado en -1 y no descontaba')
        pendientes += 2
        if pendientes >= 200:
            batch.commit(); batch = db.batch(); pendientes = 0

    if pendientes:
        batch.commit()

    db.collection('config').document('catalogo_meta').set(
        {'last_updated': ahora.strftime('%Y-%m-%dT%H:%M:%S')}, merge=True)

    print(f'\nListo: {len(servicios)} servicios marcados, {len(gondola)} productos liberados.')
    print('Los productos liberados quedaron en 0: hay que contarlos y cargar lo que haya.')


if __name__ == '__main__':
    main()
