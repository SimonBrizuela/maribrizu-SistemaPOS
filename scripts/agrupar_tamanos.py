"""
Detecta familias de tamaños en el catalogo y las agrupa para la tienda.

Busca productos cuyo nombre es el MISMO salvo la medida del final ("CIERRE
COMUN REFORZADO DE METAL 10 CM" / "12 CM" / "14 CM") y les escribe
`tienda_grupo` + `tienda_tamano`: en la tienda salen como una sola
publicacion y el tamaño se elige adentro de la ficha.

Que agrupa solo: colas que son una medida de verdad (numero con unidad,
"Nº 3", "10x15 cm"). Un numero pelado al final ("CIERRE INVISIBLE 30") puede
ser un modelo o un codigo, asi que esas familias van al informe como DUDOSAS
y las decide una persona desde el panel (boton Tamaños). Tampoco se agrupa
una familia con etiquetas repetidas ni una que cruza rubros distintos.

    python scripts/agrupar_tamanos.py             # solo mira
    python scripts/agrupar_tamanos.py --aplicar

Escribe el detalle en `grupos_tamanos_detectados.txt` y, al aplicar, los ids
tocados en `grupos_tamanos_rollback.txt` (los dos locales, no se commitean:
el repo es publico). Vuelta atras: borrar `tienda_grupo`/`tienda_tamano` de
esos ids (el panel tiene "Sacar de este grupo" por producto).
"""
import argparse
import os
import re
import sys
from datetime import datetime

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)
sys.path.insert(0, os.path.join(RAIZ, 'scripts'))
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

from sync_tienda import nombre_bonito, normalizar  # noqa: E402

DETECTADOS = os.path.join(RAIZ, 'grupos_tamanos_detectados.txt')
ROLLBACK = os.path.join(RAIZ, 'grupos_tamanos_rollback.txt')

# Unidades que hacen que un numero del final sea una medida y no un codigo.
# Sin contadores de pack ("x80", "10 u"): llevar mas unidades no es un tamaño.
_UNIDAD = r'(?:cms?|mm|mts?|mtr|m|ml|cc|grs?|g|kgs?|lts?|l)'
_NUM = r'\d+(?:[.,]\d+)?'

# La cola que se considera medida. Sobre el nombre ya normalizado.
MEDIDA_FINAL = re.compile(
    r'^(?P<base>.+?) '
    r'(?P<medida>'
    rf'(?:n[º°] ?\d+)'                                    # nº 3
    rf'|(?:{_NUM} ?x ?{_NUM}(?: ?{_UNIDAD})?)'            # 10x15, 40x50 cm
    rf'|(?:{_NUM} ?{_UNIDAD})'                            # 40 cm, 6mm, 250 ml
    r')\.?$'
)

# Un numero pelado al final: puede ser talle o puede ser modelo. No se aplica
# solo; va al informe de dudosos.
NUMERO_FINAL = re.compile(r'^(?P<base>.+?[a-z].*?) (?P<medida>\d{1,3})$')

# Lo que no puede quedar colgando al final del nombre de un grupo.
COLGANTES = {'de', 'del', 'la', 'las', 'el', 'los', 'y', 'con', 'sin', 'para',
             'por', 'a', 'en', 'x', 'nº', 'n°'}

# Familias donde la cola parece medida pero NO es un tamaño, revisadas a mano
# el 2026-08-24: packs de x1/x10 unidades (rollos, pilas, papel secante,
# laminas), modelos (talonarios, pilas por numero), cajas de lapices ("x 12 L"
# son lapices largos) y talles con etiqueta ilegible. Van al informe como
# dudosas para decidirlas desde el panel, no se arman solas.
EXCLUIR = {
    'Banderitas Justino C/sol 13X',
    'Cancan Cashmilon Oriana Adulto Talle',
    'Cuaderno Laprida AB7 21',
    'Globo Globolandia Perlados',
    'Goma Borrar Sabonis Blanca',
    'Lámina Luma Transparente 48',
    'Lápiz Color Pizzini',
    'Papel Secante Congreso 16',
    'Papel Secante Congreso 30',
    'Pila Audifono Varta',
    'Pila Euroenergy',
    'Pila Fulltotal',
    'Rollo Obra Gtc 44',
    'Rollo Obra Mauger / Self Obra 43',
    'Rollo Obra Mauger 37',
    'Rollo Obra Mauger 44',
    'Rollo Obra Mauger 57',
    'Rollo Obra Mauger 60',
    'Rollo Termico Husares 80',
    'Rollo Termico Mauger 80',
    'Talonario Roll-maq',
}


def _nombre_de_grupo(base, nombre_original):
    """
    El nombre del grupo, con las palabras ORIGINALES del catalogo.

    La base viene normalizada (sin tildes ni eñes, que es como se compara),
    pero el nombre que ve el cliente no puede salir de ahi: "CIERRE COMÚN" se
    volvia "Cierre Comun" y "NAVIDEÑA", "Navidena". Se cortan del nombre
    original tantas palabras como tiene la base.
    """
    n = len(base.split())
    palabras = str(nombre_original or '').strip().split()[:n]
    while palabras and normalizar(palabras[-1]) in COLGANTES:
        palabras.pop()
    return nombre_bonito(' '.join(palabras))


def _base_valida(base):
    palabras = [p for p in base.split() if p not in COLGANTES]
    return any(len(p) >= 3 and any(c.isalpha() for c in p) for p in palabras)


def detectar(productos):
    """
    Separa el catalogo en familias.

    `productos`: [{id, nombre, rubro, tienda_grupo}]
    Devuelve (aplicables, dudosos, conflictos):
      aplicables: [{grupo, rubro, miembros: [(id, nombre, tamano)]}]
      dudosos:    igual, pero con numero pelado — no se escriben
      conflictos: [(motivo, grupo, detalle)]
    """
    seguras = {}
    peladas = {}
    for p in productos:
        if str(p.get('tienda_grupo') or '').strip():
            continue          # ya lo agrupo alguien; no se toca
        nombre = normalizar(p.get('nombre'))
        if not nombre:
            continue
        m = MEDIDA_FINAL.match(nombre)
        destino = seguras
        if not m:
            m = NUMERO_FINAL.match(nombre)
            destino = peladas
        if not m or not _base_valida(m.group('base')):
            continue
        clave = (str(p.get('rubro') or '').strip().upper(), m.group('base'))
        destino.setdefault(clave, []).append(
            (p['id'], p.get('nombre'), nombre_bonito(m.group('medida').upper())))

    conflictos = []

    def armar(familias, con_conflictos):
        # El nombre del grupo manda global (grupo_clave), asi que la misma
        # base en dos rubros mezclaria tamaños de cosas distintas en una
        # ficha: esas familias no se arman solas.
        por_nombre = {}
        for (rubro, base), miembros in familias.items():
            if len(miembros) < 2:
                continue
            nombre_grupo = _nombre_de_grupo(base, miembros[0][1])
            por_nombre.setdefault(nombre_grupo, []).append((rubro, base, miembros))

        salida = []
        for nombre_grupo, versiones in sorted(por_nombre.items()):
            if not nombre_grupo:
                continue
            if len({r for r, _b, _m in versiones}) > 1:
                if con_conflictos:
                    conflictos.append(('la misma base vive en varios rubros', nombre_grupo,
                                       ', '.join(sorted({r for r, _b, _m in versiones}))))
                continue
            for rubro, _base, miembros in versiones:
                etiquetas = [t for _i, _n, t in miembros]
                if len(set(etiquetas)) != len(etiquetas):
                    if con_conflictos:
                        conflictos.append(('etiquetas de tamaño repetidas', nombre_grupo,
                                           ', '.join(etiquetas)))
                    continue
                miembros.sort(key=lambda x: ([float(n.replace(',', '.'))
                                              for n in re.findall(r'\d+(?:[.,]\d+)?', x[2])]
                                             or [float('inf')], x[2]))
                salida.append({'grupo': nombre_grupo, 'rubro': rubro, 'miembros': miembros})
        return salida

    aplicables = armar(seguras, con_conflictos=True)
    dudosos = armar(peladas, con_conflictos=False)

    # Las familias revisadas donde la cola no es un tamaño pasan a dudosas.
    dudosos = [g for g in aplicables if g['grupo'] in EXCLUIR] + dudosos
    aplicables = [g for g in aplicables if g['grupo'] not in EXCLUIR]
    return aplicables, dudosos, conflictos


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--aplicar', action='store_true',
                    help='escribir; sin esto solo muestra')
    args = ap.parse_args()

    import firebase_admin
    from firebase_admin import credentials, firestore
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(
            credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))
    db = firestore.client()

    productos = []
    for d in db.collection('catalogo').select(['nombre', 'rubro', 'tienda_grupo',
                                               'estado', 'duplicado']).stream():
        x = d.to_dict() or {}
        if x.get('duplicado') is True:
            continue
        productos.append({'id': d.id, 'nombre': x.get('nombre'),
                          'rubro': x.get('rubro'), 'tienda_grupo': x.get('tienda_grupo')})

    aplicables, dudosos, conflictos = detectar(productos)
    publicados = {d.id for d in db.collection('tienda_productos').select([]).stream()}

    lineas = [f'Familias de tamaños detectadas · {datetime.now():%d/%m/%Y %H:%M}',
              f'{len(productos)} productos mirados', '',
              f'SE AGRUPAN ({len(aplicables)} grupos):']
    for g in aplicables:
        lineas.append(f'\n  {g["grupo"]}  [{g["rubro"]}]')
        for doc_id, nombre, tamano in g['miembros']:
            en_tienda = 'en tienda' if doc_id in publicados else 'no publicado'
            lineas.append(f'    {doc_id:<16} {tamano:<12} {en_tienda:<12} ({nombre})')

    lineas += ['', f'DUDOSOS — numero pelado al final, decidir en el panel ({len(dudosos)}):']
    for g in dudosos:
        etiquetas = ', '.join(t for _i, _n, t in g['miembros'])
        lineas.append(f'  {g["grupo"]}  [{g["rubro"]}]  → {etiquetas}')

    if conflictos:
        lineas += ['', 'NO SE ARMAN SOLOS:']
        lineas += [f'  {motivo}: {grupo} ({detalle})' for motivo, grupo, detalle in conflictos]

    with open(DETECTADOS, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lineas) + '\n')

    total = sum(len(g['miembros']) for g in aplicables)
    print(f'{len(aplicables)} grupos para armar ({total} productos), '
          f'{len(dudosos)} familias dudosas, {len(conflictos)} conflictos.')
    print(f'Detalle en {DETECTADOS}')

    if not args.aplicar:
        print('\nSin --aplicar no se escribio nada.')
        return

    batch = db.batch()
    n = 0
    tocados = []
    for g in aplicables:
        for doc_id, _nombre, tamano in g['miembros']:
            batch.set(db.collection('catalogo').document(doc_id),
                      {'tienda_grupo': g['grupo'], 'tienda_tamano': tamano}, merge=True)
            n += 1
            if doc_id in publicados:
                batch.set(db.collection('tienda_productos').document(doc_id),
                          {'grupo': g['grupo'], 'grupo_clave': normalizar(g['grupo']),
                           'tamano': tamano}, merge=True)
                n += 1
            tocados.append(doc_id)
            if n >= 400:
                batch.commit()
                batch = db.batch()
                n = 0
    if n:
        batch.commit()

    with open(ROLLBACK, 'w', encoding='utf-8') as fh:
        fh.write('# Estos ids NO tenian tienda_grupo antes de esta corrida.\n'
                 '# Vuelta atras = borrarles tienda_grupo y tienda_tamano.\n')
        fh.write('\n'.join(tocados) + '\n')

    print(f'\nListo: {len(aplicables)} grupos escritos ({len(tocados)} productos). '
          f'Rollback en {ROLLBACK}')


if __name__ == '__main__':
    main()
