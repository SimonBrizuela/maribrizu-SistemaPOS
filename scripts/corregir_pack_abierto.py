"""
Corrige el pack fantasma de los productos conjunto.

El personal carga el stock contando los packs que ve en el estante, incluido el
abierto, y aparte los sueltos: "3 packs y 36 sueltas" son 2 cerrados mas uno
abierto con 36. El resumen del editor lo lee asi (resta un pack cuando hay
sueltos), pero el guardado, la grilla, el POS y la tienda contaban los 3 como
cerrados: cada papel con sueltos tenia un pack entero de mas y la gondola se
vaciaba con el sistema mostrando 250 hojas.

Desde el 2026-08-22 el panel guarda packs cerrados y marca el producto con
`conjunto_packs_cerrados: true`. Este script migra los que ya estaban cargados:
a cada conjunto (o variedad) con packs y sueltos a la vez le resta el pack
abierto, recalcula el total y deja el movimiento en el historial. Los que no
tienen sueltos solo reciben la marca.

    python scripts/corregir_pack_abierto.py --papeles            # solo mira
    python scripts/corregir_pack_abierto.py --papeles --aplicar
    python scripts/corregir_pack_abierto.py --todos
    python scripts/corregir_pack_abierto.py --codigo 250430 250432

`--papeles` son los productos que reciben vinculaciones (el papel de las
impresiones). Antes de aplicar sobre todo el catalogo: python backup_catalogo.py
"""
import argparse
import math
import os
import sys
from datetime import datetime, timezone

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

import firebase_admin
from firebase_admin import credentials, firestore

from pos_system.models.conjunto import (
    contenido_de, packs_a_guardar, packs_a_mostrar, total_conjunto, total_variedad,
)

MARCA = 'conjunto_packs_cerrados'
DETALLE = 'Pack abierto: el sistema pasa a contar como el resumen del editor'


def conectar():
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(
            credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))
    return firestore.client()


def _num(v, por_defecto=0.0):
    try:
        return float(v) if v not in (None, '') else por_defecto
    except (TypeError, ValueError):
        return por_defecto


def es_conjunto(p):
    return p.get('es_conjunto') in (True, 1)


def destinos_de_vinculos(db):
    """Los productos que reciben vinculaciones: el papel de las impresiones."""
    ids = set()
    for d in db.collection('catalogo').where('vinculado_a', '>', '').stream():
        x = d.to_dict() or {}
        v = x.get('vinculaciones')
        if isinstance(v, list) and v:
            for e in v:
                if isinstance(e, dict) and e.get('doc_id'):
                    ids.add(str(e['doc_id']).strip())
        elif x.get('vinculado_a'):
            ids.add(str(x['vinculado_a']).strip())
    return ids


def plan_para(p):
    """
    Que le pasa a un producto: devuelve dict con los campos a escribir y el
    antes/despues del total, o None si no es conjunto. `cambia` dice si el
    numero se mueve o solo se marca.
    """
    if not es_conjunto(p):
        return None
    contenido = _num(p.get('conjunto_contenido'))
    colores = p.get('conjunto_colores')
    total_antes = _num(p.get('conjunto_total'))
    campos = {MARCA: True}
    variedades_tocadas = 0

    if isinstance(colores, list) and colores:
        nuevos = []
        for c in colores:
            if not isinstance(c, dict):
                nuevos.append(c)
                continue
            nc = dict(c)
            u, r = _num(c.get('unidades')), _num(c.get('restante'))
            if u >= 1 and r > 0 and contenido_de(c, contenido) > 0:
                nc['unidades'] = packs_a_guardar(u, r)
                variedades_tocadas += 1
            nuevos.append(nc)
        total = total_conjunto(nuevos, contenido)
        campos.update({
            'conjunto_colores':   nuevos,
            'conjunto_unidades':  sum(_num(c.get('unidades')) for c in nuevos if isinstance(c, dict)),
            'conjunto_restante':  sum(_num(c.get('restante')) for c in nuevos if isinstance(c, dict)),
            'conjunto_total':     total,
        })
    else:
        u, r = _num(p.get('conjunto_unidades')), _num(p.get('conjunto_restante'))
        if u >= 1 and r > 0 and contenido > 0:
            u = packs_a_guardar(u, r)
            variedades_tocadas = 1
        total = total_variedad({'unidades': u, 'restante': r}, contenido) if contenido > 0 else total_antes
        campos.update({
            'conjunto_unidades': u,
            'conjunto_restante': r,
            'conjunto_total':    total,
        })

    cambia = variedades_tocadas > 0 and abs(total - total_antes) > 1e-9
    if cambia:
        campos['stock'] = max(0, int(math.floor(total)))
    else:
        # Sin cambio numerico no se toca ni el total guardado: solo la marca.
        for k in ('conjunto_unidades', 'conjunto_restante', 'conjunto_total', 'conjunto_colores'):
            campos.pop(k, None)
    return {
        'campos': campos, 'total_antes': total_antes, 'total_despues': total,
        'cambia': cambia, 'variedades': variedades_tocadas,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--papeles', action='store_true', help='solo los destinos de vinculaciones')
    g.add_argument('--todos', action='store_true', help='todos los conjuntos del catalogo')
    g.add_argument('--codigo', nargs='+', help='uno o mas doc_id del catalogo')
    ap.add_argument('--aplicar', action='store_true', help='escribir; sin esto solo muestra')
    args = ap.parse_args()

    db = conectar()
    if args.codigo:
        docs = [db.collection('catalogo').document(c).get() for c in args.codigo]
    elif args.papeles:
        ids = sorted(destinos_de_vinculos(db))
        docs = [db.collection('catalogo').document(c).get() for c in ids]
    else:
        docs = list(db.collection('catalogo').where('es_conjunto', '==', True).stream())

    planes = []
    ya_marcados = 0
    for d in docs:
        if not d.exists:
            print(f'  [no existe] {d.id}')
            continue
        p = d.to_dict() or {}
        if p.get(MARCA) is True:
            ya_marcados += 1
            continue
        plan = plan_para(p)
        if plan is None:
            continue
        planes.append((d.id, p, plan))

    cambian = [x for x in planes if x[2]['cambia']]
    print(f'\nConjuntos revisados: {len(planes)}  (ya migrados antes: {ya_marcados})')
    print(f'Con pack fantasma (cambia el numero): {len(cambian)}')
    print(f'Solo reciben la marca: {len(planes) - len(cambian)}\n')
    if cambian:
        print(f"{'Producto':<52} {'ve':>4} {'total antes':>12} {'total desp.':>12} {'dif':>8}  var.")
        for did, p, plan in sorted(cambian, key=lambda t: -(t[2]['total_antes'] - t[2]['total_despues'])):
            u, r = _num(p.get('conjunto_unidades')), _num(p.get('conjunto_restante'))
            ve = packs_a_mostrar(plan['campos'].get('conjunto_unidades', u), r) if not p.get('conjunto_colores') else '-'
            print(f"{(p.get('nombre') or did)[:52]:<52} {ve!s:>4} {plan['total_antes']:>12.1f} {plan['total_despues']:>12.1f} "
                  f"{plan['total_despues'] - plan['total_antes']:>+8.1f}  {plan['variedades']}")
    if not args.aplicar:
        print('\nSin --aplicar no se escribio nada.')
        return

    ahora = datetime.now(timezone.utc)
    col_cat = db.collection('catalogo')
    col_mov = db.collection('stock_movimientos')
    col_inv = db.collection('inventario')
    batch = db.batch()
    n = 0

    def _commit():
        nonlocal batch, n
        if n:
            batch.commit()
            batch = db.batch()
            n = 0

    for did, p, plan in planes:
        campos = dict(plan['campos'])
        campos['ultima_actualizacion'] = ahora
        batch.set(col_cat.document(did), campos, merge=True)
        n += 1
        if plan['cambia']:
            batch.set(col_mov.document(), {
                'ts':              ahora,
                'origen':          'script',
                'pc_id':           'script',
                'usuario':         'corregir_pack_abierto',
                'producto_id':     None,
                'firebase_id':     did,
                'producto_nombre': p.get('nombre') or '',
                'motivo':          'edicion_manual',
                'cantidad':        round(plan['total_despues'] - plan['total_antes'], 4),
                'stock_antes':     round(plan['total_antes'], 4),
                'stock_despues':   round(plan['total_despues'], 4),
                'referencia':      '',
                'detalle':         DETALLE,
            })
            n += 1
            if p.get('id') is not None:
                batch.set(col_inv.document(str(p['id'])), {
                    'stock': campos['stock'], 'ultima_actualizacion': ahora,
                }, merge=True)
                n += 1
        if n >= 450:
            _commit()
    _commit()

    # Semaforo del catalogo: texto ISO con zona, la forma que el POS sabe leer.
    db.collection('config').document('catalogo_meta').set(
        {'last_updated': ahora.strftime('%Y-%m-%dT%H:%M:%S%z')}, merge=True)
    print(f'\nListo: {len(planes)} productos marcados, {len(cambian)} con el total corregido. '
          f'Las PCs lo bajan en el proximo sync; la tienda en su proxima corrida.')


if __name__ == '__main__':
    main()
