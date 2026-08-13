"""
Lista los productos que quedaron "congelados" en stock -1 y por eso dejaron de
descontar.

El POS usa `stock = -1` como bandera de servicio/ilimitado. El problema es que un
producto común también llega a -1 solo: si está en 0 y se vende uno más, la resta
lo deja en -1 y a partir de ahí queda indistinguible de un servicio.

    UPDATE products SET stock = stock - ? WHERE id = ? AND stock != -1
                                                        ^^^^^^^^^^^^^ ya no baja
    if int(row.get('stock') or 0) == -1: continue   # tampoco sube a Firestore

Desde ese momento el producto se vende sin mover stock (en la PC y en la nube), y
en el buscador del carrito aparece con la píldora ∞ como si fuera un servicio.
Cuando después se repone a mano, todo lo que se vendió en el medio ya se perdió:
el sistema queda con más unidades de las que hay en el mostrador.

    python diag_stock_congelado.py
    python diag_stock_congelado.py --dias 90 --csv stock_congelado.csv

Solo lee. No escribe nada.
"""
import argparse
import collections
import csv
import datetime
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


def numero(x, clave, por_defecto=0.0):
    try:
        return float(x.get(clave) or por_defecto)
    except (TypeError, ValueError):
        return por_defecto


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dias', type=int, default=30,
                    help='ventana de ventas a revisar (por defecto 30)')
    ap.add_argument('--csv')
    args = ap.parse_args()

    db = conectar()

    print('Leyendo catálogo...')
    congelados = {}
    for d in db.collection('catalogo').stream():
        x = d.to_dict() or {}
        if x.get('estado') == 'baja' or x.get('duplicado'):
            continue
        if numero(x, 'stock') != -1:
            continue
        congelados[str(x.get('nombre') or '').strip().upper()] = {
            'doc_id': d.id,
            'nombre': x.get('nombre') or '',
            'rubro': x.get('rubro') or '',
            'precio': numero(x, 'precio_venta'),
            'desde': str(x.get('ultima_actualizacion') or '')[:19],
        }

    # Un servicio de verdad (fotocopia, anillado, plastificado) sí va en -1.
    # El resto son productos de góndola que llegaron ahí vendiendo en cero.
    servicios = {k: v for k, v in congelados.items() if v['rubro'] == 'SERVICIOS'}
    gondola = {k: v for k, v in congelados.items() if v['rubro'] != 'SERVICIOS'}

    print(f'Con stock -1: {len(congelados)} '
          f'({len(servicios)} de SERVICIOS, {len(gondola)} de góndola)\n')

    hoy = datetime.date.today()
    vendidas = collections.Counter()
    plata = collections.Counter()
    print(f'Leyendo ventas de los últimos {args.dias} días...')
    for i in range(args.dias):
        dia = (hoy - datetime.timedelta(days=i)).strftime('%d/%m/%Y')
        q = db.collection('ventas_por_dia').where(
            filter=firestore.FieldFilter('fecha', '==', dia))
        for d in q.stream():
            x = d.to_dict() or {}
            nombre = str(x.get('producto') or '').strip().upper()
            if nombre in congelados:
                vendidas[nombre] += numero(x, 'cantidad')
                plata[nombre] += numero(x, 'subtotal')

    filas = []
    for nombre, cant in vendidas.most_common():
        c = congelados[nombre]
        filas.append({
            'doc_id': c['doc_id'], 'nombre': c['nombre'], 'rubro': c['rubro'],
            'congelado_desde': c['desde'],
            'vendidas_sin_descontar': cant,
            'facturado': plata[nombre],
            'es_servicio': 'sí' if c['rubro'] == 'SERVICIOS' else 'no',
        })

    de_gondola = [f for f in filas if f['es_servicio'] == 'no']

    print(f'\nSe siguieron vendiendo: {len(filas)} productos '
          f'({len(de_gondola)} de góndola)')
    print(f'Unidades que salieron sin mover el stock: '
          f'{sum(f["vendidas_sin_descontar"] for f in filas):,.1f}\n')

    print(f'{"Producto":<48}{"Rubro":<14}{"Vendidas":>9}  Congelado desde')
    print('─' * 96)
    for f in filas[:40]:
        print(f'{f["nombre"][:48]:<48}{f["rubro"][:14]:<14}'
              f'{f["vendidas_sin_descontar"]:>9,.1f}  {f["congelado_desde"]}')

    mudos = [c for k, c in gondola.items() if k not in vendidas]
    if mudos:
        print(f'\nOtros {len(mudos)} productos de góndola están en -1 pero no se '
              f'vendieron en la ventana: igual hay que contarlos.')

    if args.csv:
        salida = [{
            'doc_id': c['doc_id'], 'nombre': c['nombre'], 'rubro': c['rubro'],
            'congelado_desde': c['desde'],
            'vendidas_sin_descontar': vendidas.get(k, 0),
            'facturado': plata.get(k, 0),
            'es_servicio': 'sí' if c['rubro'] == 'SERVICIOS' else 'no',
        } for k, c in sorted(congelados.items(),
                             key=lambda kv: -vendidas.get(kv[0], 0))]
        with open(args.csv, 'w', newline='', encoding='utf-8-sig') as fh:
            w = csv.DictWriter(fh, fieldnames=list(salida[0].keys()))
            w.writeheader()
            w.writerows(salida)
        print(f'\nListado completo en {args.csv}')


if __name__ == '__main__':
    main()
