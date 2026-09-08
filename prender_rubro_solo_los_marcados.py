"""
Prende un rubro en la tienda dejando afuera lo que no estaba publicado a mano.

    python prender_rubro_solo_los_marcados.py --rubros ACCESORIOS,LENCERIA
    python prender_rubro_solo_los_marcados.py --rubros ACCESORIOS,LENCERIA --aplicar

Desde el 2026-09-08 el rubro apagado le gana a "Publicar siempre": un producto
marcado a mano en un rubro deshabilitado ya no sale a la tienda. Accesorios y
Lenceria tenian 21 y 14 productos asi, y se iban a caer de la vidriera.

Este script hace las dos cosas que hacen falta para que sigan estando y no
entre nadie mas:
  1. agrega el rubro a `tienda_config/publicacion` (con la ortografia exacta
     con la que esta escrito en el catalogo, tilde incluida: la comparacion
     del sync es exacta y "LENCERIA" no matchea "LENCERÍA"),
  2. le pone `tienda_publicar: false` a los productos de ese rubro que
     entrarian por tener foto y stock pero que nadie habia publicado a mano.

Lo que ya estaba marcado con "Publicar siempre" no se toca: sigue saliendo.

Deja respaldo en `backup_prender_rubro_<fecha>.json` con la lista de rubros
anterior y el valor previo de cada producto tocado. Para volver atras: sacar
el rubro de la lista y borrar el campo `tienda_publicar` de esos productos.

Ojo con el despues: con el rubro prendido, un producto NUEVO de ese rubro que
tenga foto y stock entra solo a la tienda en la proxima corrida del sync. Si
la idea es una vidriera curada a mano y cerrada, hay que revisarla cada tanto.
"""
import argparse
import json
import os
import sys
import unicodedata
from datetime import datetime

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

RAIZ = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, RAIZ)

import firebase_admin
from firebase_admin import credentials, firestore

from scripts.sync_tienda import se_publica


def conectar():
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(
            credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))
    return firestore.client()


def sin_tilde(texto):
    return ''.join(c for c in unicodedata.normalize('NFD', str(texto or ''))
                   if unicodedata.category(c) != 'Mn').strip().upper()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rubros', required=True,
                    help='rubros a prender, separados por coma (se comparan sin tilde)')
    ap.add_argument('--aplicar', action='store_true', help='sin esto solo muestra')
    args = ap.parse_args()

    db = conectar()
    pedidos = {sin_tilde(r) for r in args.rubros.split(',') if r.strip()}

    cfg_ref = db.collection('tienda_config').document('publicacion')
    cfg = cfg_ref.get().to_dict() or {}
    antes = [str(r) for r in (cfg.get('rubros') or [])]
    excluidos = cfg.get('subrubros_excluidos') or {}
    print('Rubros habilitados hoy:', ', '.join(antes) or '(ninguno)')

    # La ortografia buena sale del catalogo: el rubro se tipea a mano en el POS
    # y conviven "LENCERIA" y "LENCERÍA". Se habilitan TODAS las que existan,
    # o los productos escritos de la otra forma quedan afuera sin que se vea.
    docs = []
    grafias = set()
    for d in db.collection('catalogo').stream():
        c = d.to_dict() or {}
        if sin_tilde(c.get('rubro')) in pedidos:
            docs.append((d.id, c))
            grafias.add(str(c.get('rubro') or '').strip().upper())

    if not docs:
        print('Ningun producto en esos rubros. Revisa como estan escritos.')
        return

    print('Como estan escritos en el catalogo:', ', '.join(sorted(grafias)))
    nuevos = [g for g in sorted(grafias) if g not in {r.strip().upper() for r in antes}]
    despues = antes + nuevos
    print('Se agregan a la lista:', ', '.join(nuevos) or '(ya estaban)')

    habilitados = {r.strip().upper() for r in despues}
    sub_ex = {str(k).strip().upper(): {str(s).strip().upper() for s in (v or [])}
              for k, v in excluidos.items()}

    marcados, tapar = [], []
    for pid, c in docs:
        if c.get('tienda_publicar') is True:
            marcados.append((pid, c))
            continue
        ok, _motivo = se_publica(c, habilitados, sub_ex)
        if ok:
            tapar.append((pid, c))

    print(f'\n{len(marcados)} ya publicados a mano: se quedan en la tienda.')
    print(f'{len(tapar)} entrarian de mas y se van a marcar "no publicar":')
    for pid, c in tapar:
        print(f'    {pid}  {c.get("nombre")}  (sub {c.get("sub_rubro") or "-"}, '
              f'stock {c.get("stock")})')

    if not args.aplicar:
        print('\nCorrer con --aplicar para hacerlo.')
        return

    sello = f'{datetime.now():%Y%m%d_%H%M}'
    respaldo = os.path.join(RAIZ, f'backup_prender_rubro_{sello}.json')
    with open(respaldo, 'w', encoding='utf-8') as f:
        json.dump({
            'rubros_antes': antes,
            'rubros_despues': despues,
            'tapados': {pid: {'nombre': c.get('nombre'),
                              'rubro': c.get('rubro'),
                              'tienda_publicar': c.get('tienda_publicar')}
                        for pid, c in tapar},
        }, f, ensure_ascii=False, indent=2)
    print(f'\nRespaldo en {respaldo}')

    # Primero se tapan los que no van y despues se prende el rubro: al reves,
    # una corrida del sync en el medio los publicaria por un rato.
    lote = db.batch()
    for i, (pid, _c) in enumerate(tapar, 1):
        lote.update(db.collection('catalogo').document(pid), {'tienda_publicar': False})
        if i % 400 == 0:
            lote.commit()
            lote = db.batch()
    lote.commit()
    print(f'{len(tapar)} productos marcados "no publicar".')

    cfg_ref.set({'rubros': despues}, merge=True)
    print(f'Rubros habilitados ahora: {", ".join(despues)}')
    print('\nCorrer el sync para que la tienda lo tome: gh workflow run sync_tienda.yml')


if __name__ == '__main__':
    main()
