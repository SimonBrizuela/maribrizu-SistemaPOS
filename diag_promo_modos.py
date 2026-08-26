"""
Que tiene guardado cada promocion en `modos` (pack/unidad por producto o
variante) y por que el POS aplica o no el descuento en cada modo de venta.

Solo lectura. Uso:
    python diag_promo_modos.py                # todas las promos activas
    python diag_promo_modos.py "RESMA PAMPA"  # solo las que matchean el nombre
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

import firebase_admin
from firebase_admin import credentials, firestore


def _init_db():
    try:
        firebase_admin.get_app()
    except ValueError:
        cred = credentials.Certificate('firebase_key.json')
        firebase_admin.initialize_app(cred)
    return firestore.client()


def _fmt_modos(raw):
    if raw is None:
        return 'sin entrada -> TODOS los modos, minimo global'
    if isinstance(raw, list):
        return f"legacy {raw} -> esos modos, minimo global"
    if isinstance(raw, dict):
        partes = []
        for m, mv in raw.items():
            if isinstance(mv, dict):
                mn = int(mv.get('min') or 0)
            elif isinstance(mv, (int, float)):
                mn = int(mv)
            else:
                mn = 0
            partes.append(f"{m}(min={'global' if mn == 0 else mn})")
        return ' + '.join(partes) if partes else 'entrada vacia -> ningun modo?'
    return f'??? {raw!r}'


def main():
    filtro = (sys.argv[1] if len(sys.argv) > 1 else '').strip().lower()
    db = _init_db()

    nombres = {}   # cache doc_id -> nombre de catalogo
    def nombre_de(pid):
        if pid not in nombres:
            snap = db.collection('catalogo').document(str(pid)).get()
            d = snap.to_dict() or {}
            nombres[pid] = d.get('nombre') or d.get('name') or pid
        return nombres[pid]

    docs = list(db.collection('promociones').stream())
    print(f"{len(docs)} promociones en Firestore\n")
    for doc in docs:
        p = doc.to_dict() or {}
        nombre = p.get('nombre', '(sin nombre)')
        if filtro and filtro not in nombre.lower():
            continue
        activo = p.get('activo', True)
        print(f"== {nombre}  [{doc.id}]  {'ACTIVA' if activo else 'inactiva'}")
        print(f"   tipo={p.get('tipo')}  valor={p.get('valor')}  "
              f"min_global={p.get('cantidad_minima')}  max={p.get('cantidad_maxima')}")
        modos = p.get('modos') or {}
        for pid in (p.get('productos') or []):
            print(f"   producto: {nombre_de(pid)}  [{pid}]")
            print(f"     modos: {_fmt_modos(modos.get(pid))}")
        for v in (p.get('variantes') or []):
            pid = v.get('producto_id')
            key = f"{pid}::var::{v.get('color')}"
            print(f"   variante: {nombre_de(pid)} - {v.get('color')}")
            print(f"     modos: {_fmt_modos(modos.get(key))}")
        print()


if __name__ == '__main__':
    main()
