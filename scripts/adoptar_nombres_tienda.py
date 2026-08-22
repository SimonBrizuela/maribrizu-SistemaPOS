"""
Los nombres propios de la tienda pasan a ser el nombre del catalogo.

Hasta el 2026-08-22 un producto podia llamarse de una manera en el catalogo
("CINTA PAPEL AUCA") y de otra en la tienda ("Cinta de papel Auca", en
`tienda_nombre`). Dos nombres para lo mismo: lo que se corregia en la tienda
no llegaba a la caja, y lo que se cambiaba en el catalogo no llegaba a la
tienda. Desde ahora hay uno solo: el del catalogo, en mayusculas como lo
muestra el POS, y la tienda lo escribe bonito sola (`nombre_bonito`).

Este script adopta los nombres de la tienda como nombre del catalogo, borra
`tienda_nombre` y deja el espejo de la tienda al dia en el momento, sin
esperar al sync. Escribe un informe en `nombres_tienda_adoptados.txt`.

    python scripts/adoptar_nombres_tienda.py             # solo mira
    python scripts/adoptar_nombres_tienda.py --aplicar

Antes de aplicar: python backup_catalogo.py
"""
import argparse
import os
import sys
from datetime import datetime, timezone

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)
sys.path.insert(0, os.path.join(RAIZ, 'scripts'))
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

import firebase_admin
from firebase_admin import credentials, firestore

from sync_tienda import nombre_bonito, normalizar, tokenizar  # noqa: E402

INFORME = os.path.join(RAIZ, 'nombres_tienda_adoptados.txt')


def conectar():
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(
            credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))
    return firestore.client()


def nombre_de_catalogo(nombre_tienda):
    """El nombre propio de la tienda, como lo guarda el catalogo: mayusculas y
    un solo espacio entre palabras."""
    return ' '.join(str(nombre_tienda or '').split()).upper()


def planear(docs_con_nombre, nombres_existentes):
    """
    Que le pasa a cada producto. Devuelve una lista de dicts:
      id, antes (catalogo), despues (catalogo), tienda_antes, tienda_despues,
      cambia_catalogo, cambia_tienda, motivo (None o por que se saltea)
    Un nombre nuevo que ya lo usa OTRO producto no se adopta: dos productos con
    el mismo nombre rompen la busqueda y el cruce de ventas por nombre.
    """
    plan = []
    usados = dict(nombres_existentes)   # nombre en mayusculas -> doc_id
    for doc_id, datos in docs_con_nombre:
        propio = str(datos.get('tienda_nombre') or '').strip()
        antes = str(datos.get('nombre') or '').strip()
        despues = nombre_de_catalogo(propio)
        tienda_despues = nombre_bonito(despues)
        fila = {
            'id': doc_id, 'antes': antes, 'despues': despues,
            'tienda_antes': propio, 'tienda_despues': tienda_despues,
            'cambia_catalogo': despues != antes,
            'cambia_tienda': tienda_despues != propio,
            'motivo': None,
        }
        if not despues:
            fila['motivo'] = 'nombre propio vacio'
        elif usados.get(despues) not in (None, doc_id):
            fila['motivo'] = f'ya se llama asi el producto {usados[despues]}'
        else:
            usados[despues] = doc_id
        plan.append(fila)
    return plan


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--aplicar', action='store_true', help='escribir; sin esto solo muestra')
    args = ap.parse_args()

    db = conectar()
    todos = {d.id: (d.to_dict() or {}) for d in db.collection('catalogo').stream()}
    con_propio = [(i, x) for i, x in todos.items() if str(x.get('tienda_nombre') or '').strip()]
    existentes = {}
    for i, x in todos.items():
        n = str(x.get('nombre') or '').strip()
        if n and n not in existentes:
            existentes[n] = i
    plan = planear(con_propio, existentes)

    cambian = [f for f in plan if not f['motivo'] and f['cambia_catalogo']]
    solo_marca = [f for f in plan if not f['motivo'] and not f['cambia_catalogo']]
    saltados = [f for f in plan if f['motivo']]
    forma = [f for f in cambian if f['cambia_tienda']]

    lineas = [
        f'Nombres propios de la tienda adoptados por el catalogo · {datetime.now():%d/%m/%Y %H:%M}',
        f'Productos con nombre propio: {len(plan)}',
        f'  cambian de nombre en el catalogo: {len(cambian)}',
        f'    de esos, la tienda los va a mostrar con otra forma (solo mayusculas/minusculas): {len(forma)}',
        f'  ya se llamaban igual (solo se borra el nombre propio): {len(solo_marca)}',
        f'  salteados: {len(saltados)}',
        '',
        f"{'codigo':<16} | {'catalogo antes':<52} | {'catalogo despues':<52} | {'tienda antes':<48} | {'tienda despues':<48}",
        '-' * 230,
    ]
    for f in cambian:
        lineas.append(f"{f['id']:<16} | {f['antes'][:52]:<52} | {f['despues'][:52]:<52} | {f['tienda_antes'][:48]:<48} | {f['tienda_despues'][:48]:<48}")
    if saltados:
        lineas += ['', 'SALTEADOS:']
        lineas += [f"  {f['id']} | {f['antes']} -> {f['despues']} | {f['motivo']}" for f in saltados]
    with open(INFORME, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lineas) + '\n')
    print('\n'.join(lineas[:7]))
    print(f'\nInforme completo en {INFORME}')

    if not args.aplicar:
        print('\nSin --aplicar no se escribio nada.')
        return

    ahora = datetime.now(timezone.utc)
    col_cat = db.collection('catalogo')
    col_tp = db.collection('tienda_productos')
    batch = db.batch()
    n = 0

    def _commit():
        nonlocal batch, n
        if n:
            batch.commit()
            batch = db.batch()
            n = 0

    for f in cambian + solo_marca:
        campos = {'tienda_nombre': firestore.DELETE_FIELD, 'ultima_actualizacion': ahora}
        if f['cambia_catalogo']:
            campos['nombre'] = f['despues']
        batch.set(col_cat.document(f['id']), campos, merge=True)
        n += 1
        # El espejo, al instante: el nombre bonito y lo que se busca por el.
        tp = col_tp.document(f['id']).get()
        if tp.exists:
            datos = todos[f['id']]
            batch.set(col_tp.document(f['id']), {
                'nombre':          f['tienda_despues'],
                'nombre_busqueda': normalizar(f['tienda_despues']),
                'tokens':          tokenizar(f['tienda_despues'], datos.get('marca'),
                                             datos.get('categoria'), datos.get('sub_rubro')),
                'actualizado':     ahora,
            }, merge=True)
            n += 1
        if n >= 400:
            _commit()
    _commit()

    db.collection('config').document('catalogo_meta').set(
        {'last_updated': ahora.strftime('%Y-%m-%dT%H:%M:%S%z')}, merge=True)
    print(f'\nListo: {len(cambian)} renombrados en el catalogo, {len(cambian) + len(solo_marca)} sin nombre propio. '
          f'Las PCs bajan los nombres nuevos en el proximo sync.')


if __name__ == '__main__':
    main()
