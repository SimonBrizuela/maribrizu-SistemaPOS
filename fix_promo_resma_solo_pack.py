"""
RESMA PAMPA: dejar la promo SOLO para packs (sacar el modo Unidad del chip).

El 26-08 la promo tenia modos = {LI6487: {pack: {min:10}, unidad: {min:0}}}:
con Unidad habilitado, el minimo global (10) tambien se cumplia con 10 hojas
sueltas y el POS descontaba igual. La intencion del dueno: solo desde 10 packs.

    python fix_promo_resma_solo_pack.py             # dry-run: muestra antes/despues
    python fix_promo_resma_solo_pack.py --aplicar   # escribe
    python fix_promo_resma_solo_pack.py --volver    # vuelve a dejar Unidad (min global)

Solo toca el campo `modos` del doc promociones/R1eS6RVy88sRnRwQxBc5.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

import firebase_admin
from firebase_admin import credentials, firestore

DOC_ID = 'R1eS6RVy88sRnRwQxBc5'
KEY = 'LI6487'


def _init_db():
    try:
        firebase_admin.get_app()
    except ValueError:
        cred = credentials.Certificate('firebase_key.json')
        firebase_admin.initialize_app(cred)
    return firestore.client()


def main():
    aplicar = '--aplicar' in sys.argv
    volver = '--volver' in sys.argv
    db = _init_db()
    ref = db.collection('promociones').document(DOC_ID)
    snap = ref.get()
    if not snap.exists:
        print(f'No existe promociones/{DOC_ID}')
        return 1
    p = snap.to_dict()
    modos = dict(p.get('modos') or {})
    print(f"Promo: {p.get('nombre')}  min_global={p.get('cantidad_minima')}")
    print(f"ANTES  modos[{KEY}] = {modos.get(KEY)}")

    if volver:
        nuevo = {'pack': {'min': 10}, 'unidad': {'min': 0}}
    else:
        nuevo = {'pack': {'min': 10}}
    print(f"DESPUES modos[{KEY}] = {nuevo}")

    if not (aplicar or volver):
        print('\nDry-run: nada escrito. Corre con --aplicar para guardar.')
        return 0

    modos[KEY] = nuevo
    ref.update({'modos': modos})
    print('\nGuardado. El POS lo toma en el proximo refresh de promos (tiempo real).')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
