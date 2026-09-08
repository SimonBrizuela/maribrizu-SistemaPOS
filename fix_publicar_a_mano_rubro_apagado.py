"""
Saca de la tienda los productos "publicados a mano" de un rubro que esta apagado.

    python fix_publicar_a_mano_rubro_apagado.py                      # solo muestra
    python fix_publicar_a_mano_rubro_apagado.py --rubros COTILLON,MERCERIA --aplicar

Nacio el 2026-09-08 como parche: la duena destildo Cotillon y Merceria en
Configuracion de la Tienda y tres productos con `tienda_publicar: true`
siguieron en la vidriera, porque la marca por producto le ganaba al rubro.
Ese mismo dia se dio vuelta la regla en las dos implementaciones
(`se_publica()` y `motivoDeNoPublicar()`), asi que el sync ya los saca solo en
la proxima corrida y este script quedo de respaldo: sirve para verlos ahora
mismo, o para dejarlos en "automatico" y no depender de que corra el sync.

Que hace, para los rubros que se le pasan y solo para ellos:
  1. guarda en `backup_tienda_publicar_<fecha>.json` que tenia cada producto,
  2. borra el campo `tienda_publicar` (queda en "automatico": vuelve solo
     cuando el rubro se prenda, si tiene foto y stock),
  3. borra su documento del espejo `tienda_productos`.

El conteo de la portada (`tienda_config/rubros`) NO se toca aca: lo rehace el
sync (`gh workflow run sync_tienda.yml`), que ademas corrige cualquier otro
conteo viejo.

Los rubros se comparan sin tilde: COTILLON agarra "COTILLON" y "COTILLÓN".
"""
import argparse
import json
import os
import sys
import unicodedata
from datetime import datetime

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1 import DELETE_FIELD, FieldFilter

RAIZ = os.path.dirname(os.path.abspath(__file__))


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
    ap.add_argument('--rubros', default='',
                    help='rubros a tocar, separados por coma (ej: COTILLON,MERCERIA)')
    ap.add_argument('--aplicar', action='store_true', help='sin esto solo muestra')
    args = ap.parse_args()

    db = conectar()

    cfg = db.collection('tienda_config').document('publicacion').get().to_dict() or {}
    habilitados = {sin_tilde(r) for r in (cfg.get('rubros') or [])}
    print('Rubros habilitados:', ', '.join(sorted(habilitados)) or '(ninguno)')

    elegidos = {sin_tilde(r) for r in args.rubros.split(',') if r.strip()}
    if elegidos & habilitados:
        print('ERROR: estos rubros estan habilitados, no corresponde tocarlos:',
              ', '.join(sorted(elegidos & habilitados)))
        sys.exit(1)

    marcados = list(db.collection('catalogo')
                    .where(filter=FieldFilter('tienda_publicar', '==', True)).stream())
    fuera = [d for d in marcados if sin_tilde((d.to_dict() or {}).get('rubro')) not in habilitados]

    por_rubro = {}
    for d in fuera:
        por_rubro.setdefault(sin_tilde(d.to_dict().get('rubro')), []).append(d)
    print(f'\n{len(marcados)} productos con "Publicar siempre"; '
          f'{len(fuera)} estan en rubros apagados:')
    for rubro, docs in sorted(por_rubro.items()):
        marca = '  <- se tocan' if rubro in elegidos else ''
        print(f'  {rubro}: {len(docs)}{marca}')
        for d in docs:
            x = d.to_dict()
            print(f'      {d.id}  {x.get("nombre")}  (sub {x.get("sub_rubro")}, stock {x.get("stock")})')

    tocar = [d for d in fuera if sin_tilde(d.to_dict().get('rubro')) in elegidos]
    if not tocar:
        print('\nNada para tocar. Pasa --rubros con los rubros a limpiar.')
        return
    if not args.aplicar:
        print(f'\nSe tocarian {len(tocar)} productos. Correr con --aplicar para hacerlo.')
        return

    respaldo = os.path.join(RAIZ, f'backup_tienda_publicar_{datetime.now():%Y%m%d_%H%M}.json')
    with open(respaldo, 'w', encoding='utf-8') as f:
        json.dump({d.id: {'tienda_publicar': d.to_dict().get('tienda_publicar'),
                          'nombre': d.to_dict().get('nombre'),
                          'rubro': d.to_dict().get('rubro')} for d in tocar},
                  f, ensure_ascii=False, indent=2)
    print(f'\nRespaldo en {respaldo}')

    lote = db.batch()
    for d in tocar:
        lote.update(db.collection('catalogo').document(d.id), {'tienda_publicar': DELETE_FIELD})
        lote.delete(db.collection('tienda_productos').document(d.id))
    lote.commit()
    print(f'Listo: {len(tocar)} productos en automatico y fuera de la tienda.')
    print('Ahora correr el sync para rehacer la portada: '
          'gh workflow run sync_tienda.yml')


if __name__ == '__main__':
    main()
