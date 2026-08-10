"""
Escribe en el catalogo los minimos de venta que calculo estudio_minimos.py.

    python scripts/aplicar_minimos.py --simular      # que haria
    python scripts/aplicar_minimos.py                # lo hace
    python scripts/aplicar_minimos.py --deshacer     # vuelve atras

Toca dos campos del producto, `tienda_minimo` y `tienda_paso`, que son los
mismos que edita el panel. No toca precio, costo ni stock.

Antes de escribir guarda el valor anterior de cada producto en
`minimos_anteriores.json`, y `--deshacer` lo restaura tal cual estaba. Son 620
productos: revisar uno por uno para volver atras no es una opcion.

Tres cerrojos, porque el minimo sale de un margen que puede estar mal cargado en
el POS y un costo viejo infla el numero:

  · Nunca se escribe un minimo mayor al stock. Seria dejar el producto sin
    poder comprarse.
  · Nunca se escribe un renglon minimo de mas de $15.000. En una libreria de
    barrio eso no es un minimo, es un mayorista.
  · Los productos donde el precio no cubre el costo se listan y se dejan como
    estan: eso se arregla en el POS, no acá.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from estudio_minimos import leer_catalogo, plata, regla_de  # noqa: E402
from estudio_negocio import conectar  # noqa: E402

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESPALDO = os.path.join(RAIZ, 'minimos_anteriores.json')

# Un renglon minimo mas caro que esto no es un minimo razonable para el barrio.
TOPE_RENGLON = 15000


def natural(unidad):
    return 0.5 if unidad == 'metro' else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--simular', action='store_true')
    ap.add_argument('--deshacer', action='store_true')
    ap.add_argument('--renglon', type=float, default=400,
                    help='lo que cuesta buscar y contar un renglón (default 400)')
    ap.add_argument('--solo-con-venta', action='store_true',
                    help='solo los productos que se vendieron en el período')
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

    db = conectar()

    if args.deshacer:
        return deshacer(db)

    print('Leyendo catálogo...')
    productos = leer_catalogo(db)

    # El estudio necesita las ventas solo para informar; para escribir alcanza
    # con el margen, que es lo que decide el mínimo.
    cambios = []
    saltados = {'sin_stock_para_el_minimo': [], 'renglon_muy_caro': [],
                'precio_no_cubre_costo': []}

    for p in productos:
        regla = regla_de(p, args.renglon)
        tipo = regla['tipo']

        if tipo == 'revisar':
            saltados['precio_no_cubre_costo'].append(p)
            continue
        if tipo == 'no_vender':
            saltados['sin_stock_para_el_minimo'].append(p)
            continue
        if tipo == 'suelto':
            continue    # queda como está: de a uno

        minimo = regla['minimo']
        if minimo * p['precio'] > TOPE_RENGLON:
            saltados['renglon_muy_caro'].append(p)
            continue
        if minimo > p['stock']:
            saltados['sin_stock_para_el_minimo'].append(p)
            continue

        cambios.append({
            'doc_id': p['doc_id'], 'nombre': p['nombre'], 'rubro': p['rubro'],
            'unidad': p['unidad'], 'precio': p['precio'],
            'minimo': minimo, 'renglon': minimo * p['precio'],
            'antes': p['tienda_minimo'],
        })

    # Lo que ya estaba puesto con el mismo valor no se reescribe.
    nuevos = [c for c in cambios if c['antes'] != c['minimo']]

    print(f'\n{len(productos)} productos con precio, costo y stock')
    print(f'{len(cambios)} necesitan un mínimo · {len(nuevos)} hay que escribir')
    for motivo, lista in saltados.items():
        if lista:
            print(f'{len(lista):5d} salteados: {motivo.replace("_", " ")}')

    if saltados['precio_no_cubre_costo']:
        print('\nEl precio no cubre el costo (revisar en el POS):')
        for p in saltados['precio_no_cubre_costo']:
            print(f"    {p['nombre'][:50]:<50} precio {plata(p['precio'])} · costo {plata(p['costo'])}")

    if saltados['renglon_muy_caro']:
        print(f'\nMínimo demasiado caro, se dejan sin mínimo (posible costo mal cargado):')
        for p in sorted(saltados['renglon_muy_caro'], key=lambda x: -x['precio'])[:12]:
            r = regla_de(p, args.renglon)
            print(f"    {p['nombre'][:44]:<44} {plata(p['precio']):>9} × {r['minimo']}"
                  f" = {plata(r['minimo'] * p['precio'])}")

    reparto = {}
    for c in nuevos:
        reparto[c['minimo']] = reparto.get(c['minimo'], 0) + 1
    print('\nMínimos a escribir:')
    for m, cuantos in sorted(reparto.items()):
        print(f'    mínimo {m:>5}  {cuantos:>4} productos')

    if args.simular:
        print('\n(simulación: no se escribió nada)')
        return

    if not nuevos:
        print('\nNo hay nada que escribir.')
        return

    # ── Respaldo ──────────────────────────────────────────────────────────
    with open(RESPALDO, 'w', encoding='utf-8') as f:
        json.dump([{'doc_id': c['doc_id'], 'nombre': c['nombre'],
                    'tienda_minimo': c['antes']} for c in nuevos],
                  f, ensure_ascii=False, indent=1)
    print(f'\nValores anteriores guardados en {RESPALDO}')

    # ── Escribir ──────────────────────────────────────────────────────────
    print('Escribiendo...')
    lote = db.batch()
    pendientes = escritos = 0
    for c in nuevos:
        lote.update(db.collection('catalogo').document(c['doc_id']),
                    {'tienda_minimo': c['minimo']})
        pendientes += 1
        escritos += 1
        if pendientes >= 450:
            lote.commit()
            lote = db.batch()
            pendientes = 0
            print(f'  {escritos} escritos...')
    if pendientes:
        lote.commit()

    print(f'\nListo: {escritos} productos con mínimo de venta.')
    print('Corré `python scripts/sync_tienda.py` para que lo tome la tienda.')


def deshacer(db):
    if not os.path.exists(RESPALDO):
        sys.exit(f'No hay respaldo en {RESPALDO}')

    with open(RESPALDO, encoding='utf-8') as f:
        anteriores = json.load(f)

    print(f'Restaurando {len(anteriores)} productos...')
    from google.cloud import firestore as gcf

    lote = db.batch()
    pendientes = 0
    for a in anteriores:
        ref = db.collection('catalogo').document(a['doc_id'])
        # Sin valor previo el campo se borra, que no es lo mismo que ponerlo en
        # cero: ausente significa "de a uno", como estaba antes de esto.
        valor = a.get('tienda_minimo')
        lote.update(ref, {'tienda_minimo': valor if valor else gcf.DELETE_FIELD})
        pendientes += 1
        if pendientes >= 450:
            lote.commit()
            lote = db.batch()
            pendientes = 0
    if pendientes:
        lote.commit()

    print('Listo. Corré `python scripts/sync_tienda.py` para que lo tome la tienda.')


if __name__ == '__main__':
    main()
