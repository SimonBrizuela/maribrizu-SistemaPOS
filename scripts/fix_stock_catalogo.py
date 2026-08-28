"""
Arregla de una pasada los cuatro desvios de stock/precio del catalogo.

Sin `--aplicar` solo muestra que cambiaria. Antes de aplicar: python backup_catalogo.py

    python scripts/fix_stock_catalogo.py --todo
    python scripts/fix_stock_catalogo.py --todo --aplicar
    python scripts/fix_stock_catalogo.py --descuadre --aplicar

Los cuatro grupos, en orden de gravedad:

--descuadre  Un conjunto guarda la misma mercaderia en `conjunto_total` (packs x
             contenido + sueltas) y en el campo `stock` plano. La venta directa
             movia solo el primero, asi que el segundo quedaba con el numero del
             dia que se cargo el producto. `stock` pasa a valer lo que dice el
             conjunto, que es lo que leen el POS, la tienda y las alertas.
             El origen ya esta tapado en pos_system/models/sale.py; esto migra
             lo que quedo descuadrado de antes.

--packs      Packs cerrados fraccionarios (5,92 cajas no significa nada). Un
             codigo viejo restaba 1/contenido por unidad vendida en vez de bajar
             una suelta. Se vuelve a repartir el total, que es correcto, en
             packs enteros + sueltas. La cantidad no se mueve.

--servicios  Impresiones, fotocopias, plastificados y anillados con stock
             negativo. No se reponen: lo que se repone es la hoja vinculada, que
             ya se descuenta aparte. Van a `stock_ilimitado` para que dejen de
             hundirse (llevaban -11.998 unidades entre todos).

--precios    Cinco productos que entraron por `csv_import` el 14-04 con el punto
             decimal leido como separador de miles. El precio se calculaba bien
             y se rompia al escribirlo: quedaba multiplicado por mil. Van con
             valores fijos, uno por uno, sin heuristica.

NO toca el EXHIBIDOR NORPAC (688.300): su costo tiene decimales reales y el
markup es normal, asi que no hay firma de error. Un exhibidor de piso puede
valer eso; si esta mal, es una correccion comercial y va a mano.

Cargas manuales: el editor rapido de stock del panel escribe solo el campo
plano, sin tocar el conjunto, asi que despues de una carga el numero fresco
queda en `stock` y el conjunto es el que dice de menos. Si el ultimo movimiento
del ledger de un producto es una carga a mano que coincide con su `stock`
actual, ese numero lo puso una persona y ningun grupo lo pisa: se listan aparte
para cuadrar la ficha a mano.
"""
import argparse
import math
import os
import sys
from datetime import datetime, timedelta, timezone

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

import firebase_admin
from firebase_admin import credentials, firestore

from pos_system.models.conjunto import contenido_de, repartir_total

import re

USUARIO = 'fix_stock_catalogo'

# Precio de venta correcto, producto por producto: es el precio publico que ya
# muestra la tienda. Dos de estos tenian tambien el costo inflado; se corrigio
# en la corrida aplicada el 28-08 y los costos no viajan en el repo, que es
# publico. La referencia del MOÑO X 1 es su hermano X 3 (LI6655).
PRECIOS = {
    '24620':  {'nombre': 'GORROS NAVIDAD',                     'precio_venta': 1100.0},
    'LI7091': {'nombre': 'ADORNO BOLAS MEDIANAS N°4 X 4',      'precio_venta': 1000.0},
    'LI7402': {'nombre': 'ADORNO CORAZONES X 2',               'precio_venta': 1000.0},
    '525256': {'nombre': 'GORRO DE EGRESADO FISELINA',         'precio_venta': 1500.0},
    'LI6656': {'nombre': 'MOÑO GRANDE BRILLANTE PLATEADO X 1', 'precio_venta': 1300.0},
}

RE_SERVICIO = re.compile(
    r'impres|fotocopia|plastific|anillad|encuaderna|escane|laminad|'
    r'ampliaci[oó]n|reducci[oó]n', re.I)
RE_INSUMO = re.compile(r'hoja|resma|papel|cartulina|opalina|acetato|etiqueta', re.I)


def conectar():
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(
            credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))
    return firestore.client()


def num(v, por_defecto=0.0):
    try:
        return float(v) if v not in (None, '') else por_defecto
    except (TypeError, ValueError):
        return por_defecto


def entero(v):
    return abs(num(v) - round(num(v))) < 1e-7


def es_conjunto(p):
    return bool(p.get('es_conjunto')) or p.get('conjunto_colores') \
        or num(p.get('conjunto_contenido')) > 0


def variedades(p):
    c = p.get('conjunto_colores')
    return [v for v in c if isinstance(v, dict)] if isinstance(c, list) else []


def limpio(t):
    """Saca el ruido binario que dejaron los packs fraccionarios.

    -0,06 x 50 + 21 da 17,999999999999996, no 18. `repartir_total` en Python
    arrastra ese resto tal cual (el espejo en JS lo redondea), asi que sin esto
    el arreglo escribiria sueltas como 17,999999999999996. Cuatro decimales
    alcanzan: los conjuntos por metro o por gramo se venden de a 0,5 o 0,25.
    """
    return round(num(t), 4)


def total_de(p):
    """Las unidades sueltas que hay de verdad: la suma de todas las variedades."""
    cont = num(p.get('conjunto_contenido'))
    vs = variedades(p)
    if vs:
        return limpio(sum(num(v.get('unidades')) * contenido_de(v, cont) + num(v.get('restante'))
                          for v in vs))
    return limpio(num(p.get('conjunto_unidades')) * cont + num(p.get('conjunto_restante')))


def es_servicio(p):
    nombre = p.get('nombre') or ''
    if RE_INSUMO.search(nombre):
        return False
    return bool(RE_SERVICIO.search(nombre))


# --------------------------------------------------------------------------
# Planes: que cambiaria en cada producto, sin escribir nada
# --------------------------------------------------------------------------

def plan_precio(did, p):
    fijo = PRECIOS.get(str(did))
    if not fijo:
        return None
    campos, antes = {}, {}
    for campo in ('precio_venta', 'costo'):
        if campo in fijo and abs(num(p.get(campo)) - fijo[campo]) > 0.005:
            campos[campo] = fijo[campo]
            antes[campo] = num(p.get(campo))
    return {'campos': campos, 'antes': antes} if campos else None


def plan_servicio(did, p):
    if p.get('stock_ilimitado') is True:
        return None
    if num(p.get('stock')) >= 0 or not es_servicio(p):
        return None
    return {'campos': {'stock_ilimitado': True, 'stock': 0},
            'antes': {'stock': num(p.get('stock'))}}


def plan_packs(did, p):
    """Reparte de nuevo lo que quedo con packs fraccionarios. El total no se mueve."""
    if not es_conjunto(p):
        return None
    cont = num(p.get('conjunto_contenido'))
    vs = variedades(p)
    sucio = (p.get('conjunto_unidades') is not None and not entero(p.get('conjunto_unidades'))) \
        or any(v.get('unidades') is not None and not entero(v.get('unidades')) for v in vs)
    if not sucio or cont <= 0:
        return None

    campos, detalle = {}, []
    if vs:
        nuevas = []
        for v in vs:
            nv = dict(v)
            cv = contenido_de(v, cont)
            t = limpio(num(v.get('unidades')) * cv + num(v.get('restante')))
            u, r = repartir_total(t, cv)
            r = limpio(r)
            if not entero(v.get('unidades')):
                detalle.append(f"{v.get('color')}: {num(v.get('unidades'))!r} -> {u:g}")
            nv['unidades'], nv['restante'] = u, r
            nuevas.append(nv)
        campos['conjunto_colores'] = nuevas
        campos['conjunto_unidades'] = sum(num(v.get('unidades')) for v in nuevas)
        campos['conjunto_restante'] = sum(num(v.get('restante')) for v in nuevas)
    else:
        t = total_de(p)
        u, r = repartir_total(t, cont)
        r = limpio(r)
        detalle.append(f"{num(p.get('conjunto_unidades'))!r} -> {u:g}")
        campos['conjunto_unidades'], campos['conjunto_restante'] = u, r

    total = total_de({**p, **campos})
    campos['conjunto_total'] = total
    campos['stock'] = max(0, int(math.floor(total)))
    return {'campos': campos, 'antes': {'stock': num(p.get('stock'))},
            'total': total, 'detalle': ' · '.join(detalle)}


def plan_descuadre(did, p):
    """El `stock` plano pasa a valer lo que dice el conjunto."""
    if not es_conjunto(p) or num(p.get('conjunto_contenido')) <= 0:
        return None
    if p.get('stock_ilimitado') is True:
        return None
    total = total_de(p)
    nuevo = max(0, int(math.floor(total)))
    # Se compara contra lo que se escribiria, no contra el total crudo: un
    # conjunto por metro con 995,4 m y stock plano 995 ya esta bien guardado.
    if abs(num(p.get('stock')) - nuevo) <= 0.01:
        return None
    return {'campos': {'stock': nuevo}, 'antes': {'stock': num(p.get('stock'))},
            'total': total}


GRUPOS = [
    ('descuadre', 'stock plano desincronizado del conjunto', plan_descuadre),
    ('packs',     'packs cerrados fraccionarios',            plan_packs),
    ('servicios', 'servicios con stock negativo',            plan_servicio),
    ('precios',   'precios rotos del csv_import',            plan_precio),
]


# --------------------------------------------------------------------------
# Cargas manuales: el numero que puso una persona no se pisa
# --------------------------------------------------------------------------

MOTIVOS_CARGA = ('edicion_manual', 'reposicion', 'conteo')


def cargas_manuales_vigentes(movs, productos):
    """Productos cuyo `stock` plano es una carga hecha a mano todavia vigente.

    El editor rapido de stock del panel (catalogo.js, editarStockInv) escribe
    solo el campo plano, sin tocar el conjunto. Despues de una carga el numero
    fresco queda en `stock` y el conjunto se queda atras: alinear `stock` al
    conjunto seria pisar el conteo de una persona con un numero viejo.

    Vigente = la ultima carga manual del ledger coincide con el `stock` actual.
    Si algo lo movio despues, la carga dejo de ser la foto y no protege.
    """
    ultima_carga = {}
    for m in sorted(movs, key=lambda m: (m.get('ts') is not None,
                                         m.get('ts') if m.get('ts') is not None else 0)):
        fid = m.get('firebase_id')
        if not fid or m.get('usuario') == USUARIO:
            continue
        if m.get('motivo') in MOTIVOS_CARGA and m.get('stock_despues') is not None:
            ultima_carga[fid] = num(m.get('stock_despues'))
    protegidos = set()
    for fid, cargado in ultima_carga.items():
        p = productos.get(fid)
        if p is not None and abs(num(p.get('stock')) - cargado) <= 0.01:
            protegidos.add(fid)
    return protegidos


def aplicar_proteccion(planes, protegidos):
    """Ningun plan escribe el `stock` plano de un producto protegido.

    Devuelve (planes, avisos): un plan que quedaba solo en ese campo sale
    entero; al resto se le quita la clave `stock`. En `avisos` va el plan
    original de cada protegido, para listarlo y cuadrarlo a mano.
    """
    filtrados, avisos = {}, {}
    for did, acc in planes.items():
        if did not in protegidos or 'stock' not in acc['campos']:
            filtrados[did] = acc
            continue
        avisos[did] = acc
        campos = {k: v for k, v in acc['campos'].items() if k != 'stock'}
        if campos:
            filtrados[did] = {**acc, 'campos': campos}
    return filtrados, avisos


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for nombre, ayuda, _ in GRUPOS:
        ap.add_argument(f'--{nombre}', action='store_true', help=ayuda)
    ap.add_argument('--todo', action='store_true', help='los cuatro grupos')
    ap.add_argument('--aplicar', action='store_true', help='escribir; sin esto solo muestra')
    args = ap.parse_args()

    elegidos = [g for g in GRUPOS if args.todo or getattr(args, g[0])]
    if not elegidos:
        ap.error('elegi al menos un grupo, o --todo')

    db = conectar()
    print('Leyendo el catalogo...')
    docs = [(d.id, d.to_dict() or {}) for d in db.collection('catalogo').stream()]
    print(f'{len(docs)} productos')

    print('Leyendo el ledger para respetar las cargas manuales...')
    desde = datetime.now(timezone.utc) - timedelta(days=90)
    movs = [m.to_dict() or {} for m in db.collection('stock_movimientos')
            .where('ts', '>=', desde).order_by('ts').stream()]
    protegidos = cargas_manuales_vigentes(movs, dict(docs))
    print(f'{len(movs)} movimientos, {len(protegidos)} productos con carga manual vigente\n')

    planes = {}          # doc_id -> {campos, ...}
    por_grupo = {}
    for nombre, _, fn in elegidos:
        encontrados = []
        for did, p in docs:
            plan = fn(did, p)
            if plan:
                encontrados.append((did, p, plan))
                acumulado = planes.setdefault(did, {'campos': {}, 'nombre': p.get('nombre') or did,
                                                    'antes': {}, 'grupos': []})
                acumulado['campos'].update(plan['campos'])
                acumulado['antes'].update(plan.get('antes') or {})
                acumulado['grupos'].append(nombre)
                if 'total' in plan:
                    acumulado['total'] = plan['total']
        por_grupo[nombre] = encontrados

    planes, avisos = aplicar_proteccion(planes, protegidos)

    for nombre, ayuda, _ in elegidos:
        enc = [e for e in por_grupo[nombre] if not (e[0] in avisos and nombre == 'descuadre')]
        print(f'== {nombre}: {len(enc)} productos  ({ayuda})')
        if nombre == 'precios':
            for did, p, plan in enc:
                for campo, valor in plan['campos'].items():
                    print(f"   {(p.get('nombre') or did)[:44]:<44} {campo:<13} "
                          f"{plan['antes'][campo]:>12,.2f} -> {valor:>10,.2f}")
        elif nombre == 'packs':
            for did, p, plan in enc:
                print(f"   {(p.get('nombre') or did)[:44]:<44} {plan['detalle']}")
        elif nombre == 'servicios':
            for did, p, plan in enc[:12]:
                print(f"   {(p.get('nombre') or did)[:52]:<52} stock {plan['antes']['stock']:>8,.0f} -> ilimitado")
            if len(enc) > 12:
                print(f'   ... y {len(enc) - 12} mas')
        else:
            enc_ord = sorted(enc, key=lambda t: -abs(t[2]['antes']['stock'] - t[2]['campos']['stock']))
            print(f"   {'Producto':<46} {'stock':>10} {'conjunto':>10} {'dif':>9}")
            for did, p, plan in enc_ord[:15]:
                a, d = plan['antes']['stock'], plan['campos']['stock']
                print(f"   {(p.get('nombre') or did)[:46]:<46} {a:>10,.0f} {d:>10,.0f} {d - a:>+9,.0f}")
            if len(enc) > 15:
                print(f'   ... y {len(enc) - 15} mas')
        print()

    if avisos:
        print(f'== respetados: {len(avisos)} con carga manual vigente — el stock plano no se les toca')
        print('   El numero lo puso una persona hace poco y el conjunto quedo atras.')
        print('   Para cuadrarlos, cargar el conteo en la ficha (variedades) a mano.')
        for did, acc in sorted(avisos.items(), key=lambda t: t[1]['nombre']):
            print(f"   {acc['nombre'][:46]:<46} a mano {acc['antes']['stock']:>8,.0f} "
                  f"· el conjunto dice {acc['campos']['stock']:>8,.0f}")
        print()

    print(f'TOTAL: {len(planes)} productos a escribir')
    if not args.aplicar:
        print('\nSin --aplicar no se escribio nada.')
        return

    ahora = datetime.now(timezone.utc)
    col_cat = db.collection('catalogo')
    col_mov = db.collection('stock_movimientos')
    col_inv = db.collection('inventario')
    batch = db.batch()
    n = 0

    def commit():
        nonlocal batch, n
        if n:
            batch.commit()
            batch = db.batch()
            n = 0

    por_doc = {did: p for did, p in docs}
    for did, acc in planes.items():
        campos = dict(acc['campos'])
        campos['ultima_actualizacion'] = ahora
        batch.set(col_cat.document(did), campos, merge=True)
        n += 1

        # Todo movimiento de stock deja su fila, con el antes y el despues.
        if 'stock' in campos and 'stock' in acc['antes']:
            antes, despues = acc['antes']['stock'], num(campos['stock'])
            if abs(antes - despues) > 1e-9:
                batch.set(col_mov.document(), {
                    'ts': ahora, 'origen': 'script', 'pc_id': 'script',
                    'usuario': USUARIO, 'producto_id': None, 'firebase_id': did,
                    'producto_nombre': acc['nombre'],
                    'motivo': 'edicion_manual',
                    'cantidad': round(despues - antes, 4),
                    'stock_antes': round(antes, 4),
                    'stock_despues': round(despues, 4),
                    'referencia': '',
                    'detalle': 'fix_stock_catalogo: ' + ', '.join(acc['grupos']),
                })
                n += 1
            pos_id = (por_doc.get(did) or {}).get('pos_id')
            if pos_id is not None:
                batch.set(col_inv.document(str(pos_id)),
                          {'stock': campos['stock'], 'ultima_actualizacion': ahora},
                          merge=True)
                n += 1
        if n >= 450:
            commit()
    commit()

    # Semaforo del catalogo: texto ISO con zona, la forma que el POS sabe leer.
    db.collection('config').document('catalogo_meta').set(
        {'last_updated': ahora.strftime('%Y-%m-%dT%H:%M:%S%z')}, merge=True)
    print(f'\nListo: {len(planes)} productos escritos. Las PCs lo bajan en el '
          f'proximo sync; la tienda en su proxima corrida.')


if __name__ == '__main__':
    main()
