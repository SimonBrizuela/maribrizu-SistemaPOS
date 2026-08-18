"""
Revive los productos que el POS borra por una lápida vieja de un código reciclado.

Cuando se borra un producto queda una lápida en `catalogo_deleted/{codigo}`. El
POS la usa para borrar ese producto de la base local de cada PC. El problema es
que los generadores de código (panel y POS) vuelven a repartir el código de un
producto borrado, así que un producto NUEVO puede nacer con un código que ya
tiene lápida: el POS lo baja, ve la lápida y lo borra. El producto existe en la
nube, se ve en el panel, y en la caja no aparece nunca.

Este script busca los códigos que están vivos en `catalogo` y a la vez tienen
lápida, y:

  · Si el producto se creó o se tocó DESPUÉS de la lápida  → borra la lápida y
    le pone `ultima_actualizacion` de ahora, para que el delta sync lo vuelva a
    bajar en todas las PCs.
  · Si la lápida es POSTERIOR                              → no toca nada y lo
    reporta: ahí el borrado es real y lo que sobra es el documento del catálogo.

    python fix_tombstones_resucitados.py            # muestra qué va a hacer
    python fix_tombstones_resucitados.py --aplicar  # escribe

Antes de aplicar guarda un backup JSON con las lápidas que borra.
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


def _a_utc(v):
    if isinstance(v, datetime.datetime):
        return v if v.tzinfo else v.replace(tzinfo=datetime.timezone.utc)
    return None


def _fecha(v):
    dt = _a_utc(v)
    return dt.strftime('%Y-%m-%d %H:%M') if dt else '—'


def relevar(db):
    """Devuelve (revivir, borrado_real) comparando catálogo vivo vs lápidas."""
    por_id = {}
    por_codigo = {}
    for doc in db.collection('catalogo').stream():
        data = doc.to_dict() or {}
        por_id[doc.id] = data
        for campo in ('cod_barra', 'codigo'):
            valor = data.get(campo)
            if valor is not None and str(valor).strip():
                por_codigo.setdefault(str(valor).strip(), doc.id)

    revivir, borrado_real = [], []
    for doc in db.collection('catalogo_deleted').stream():
        lapida = _a_utc((doc.to_dict() or {}).get('deleted_at'))

        if doc.id in por_id:
            doc_id, via = doc.id, 'doc_id'
        elif doc.id in por_codigo:
            doc_id, via = por_codigo[doc.id], 'codigo'
        else:
            continue

        data = por_id[doc_id]
        creado = _a_utc(data.get('fecha_creacion'))
        tocado = _a_utc(data.get('ultima_actualizacion'))
        vivo = max([d for d in (creado, tocado) if d], default=None)

        caso = {
            'lapida_id': doc.id,
            'doc_id': doc_id,
            'nombre': str(data.get('nombre') or ''),
            'cod_barra': str(data.get('cod_barra') or ''),
            'precio_venta': data.get('precio_venta'),
            'stock': data.get('stock'),
            'via': via,
            'deleted_at': lapida,
            'fecha_creacion': creado,
            'ultima_actualizacion': tocado,
        }

        if lapida and vivo and vivo > lapida:
            revivir.append(caso)
        else:
            borrado_real.append(caso)

    revivir.sort(key=lambda c: c['deleted_at'] or datetime.datetime.min)
    borrado_real.sort(key=lambda c: c['deleted_at'] or datetime.datetime.min)
    return revivir, borrado_real


def mostrar(titulo, casos):
    print(f'\n{titulo} ({len(casos)})')
    if not casos:
        print('  (ninguno)')
        return
    for c in casos:
        print(f"  {c['lapida_id']:<16} {c['nombre'][:38]:<38} "
              f"barras={c['cod_barra'] or '—':<14} ${c['precio_venta']} "
              f"stock={c['stock']}")
        print(f"      lápida={_fecha(c['deleted_at'])}  "
              f"creado={_fecha(c['fecha_creacion'])}  "
              f"tocado={_fecha(c['ultima_actualizacion'])}  vía={c['via']}")


def aplicar(db, revivir):
    sello = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    ruta = os.path.join(RAIZ, f'backup_tombstones_{sello}.json')
    with open(ruta, 'w', encoding='utf-8') as f:
        json.dump([{
            'lapida_id': c['lapida_id'],
            'doc_id': c['doc_id'],
            'nombre': c['nombre'],
            'deleted_at': c['deleted_at'].isoformat() if c['deleted_at'] else None,
        } for c in revivir], f, ensure_ascii=False, indent=2)
    print(f'\nBackup de las lápidas: {ruta}')

    lote = db.batch()
    for c in revivir:
        lote.delete(db.collection('catalogo_deleted').document(c['lapida_id']))
        lote.update(db.collection('catalogo').document(c['doc_id']),
                    {'ultima_actualizacion': firestore.SERVER_TIMESTAMP})
    lote.commit()

    db.collection('config').document('catalogo_meta').set({
        'last_updated': firestore.SERVER_TIMESTAMP,
        'updated_at': firestore.SERVER_TIMESTAMP,
        'updated_by': 'fix_tombstones_resucitados.py',
    }, merge=True)

    print(f'Listo: {len(revivir)} lápidas borradas y {len(revivir)} productos '
          f'marcados para que las PCs los vuelvan a bajar.')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--aplicar', action='store_true',
                    help='escribe los cambios (sin esto solo muestra)')
    args = ap.parse_args()

    db = conectar()
    revivir, borrado_real = relevar(db)

    mostrar('PRODUCTOS VIVOS QUE EL POS BORRA POR UNA LÁPIDA VIEJA', revivir)
    mostrar('LÁPIDAS POSTERIORES AL PRODUCTO (borrado real, no se tocan)',
            borrado_real)

    if not args.aplicar:
        print('\nModo lectura: no se escribió nada. '
              'Corré con --aplicar para reparar.')
        return

    if not revivir:
        print('\nNo hay nada para reparar.')
        return

    aplicar(db, revivir)
    print('\nCada PC los baja en el próximo arranque, o desde '
          'Sincronizar → Descargar.')


if __name__ == '__main__':
    main()
