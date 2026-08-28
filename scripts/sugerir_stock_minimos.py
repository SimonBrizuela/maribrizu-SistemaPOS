"""
Propone stock minimo y maximo para los productos que no tienen ninguno, a
partir de lo que realmente se vende. No pisa nada: un producto (o una
variedad) con minimo O maximo ya cargado queda como esta.

Sin `--aplicar` solo muestra que cargaria. Antes de aplicar: python backup_catalogo.py

    python scripts/sugerir_stock_minimos.py
    python scripts/sugerir_stock_minimos.py --aplicar

De donde sale la demanda:
  - `ventas_por_dia` de los ultimos 90 dias, renglon por renglon, con la
    variedad ([Color]  NOMBRE  ·  N u). Las ventas por caja/rollo se pasan a
    unidades multiplicando por el contenido del pack.
  - `stock_movimientos` con motivo vinculacion/venta_vinculada: el papel que
    consumen las impresiones no pasa por ventas, pero es demanda igual.

La cuenta, por producto y por variedad:
  - velocidad = vendido en los ultimos 30 dias / 30; si en 30 no hubo nada,
    la de 90. Se le suma el consumo por vinculos.
  - minimo = 7 dias de venta, redondeado para arriba (al menos 1).
  - maximo = 28 dias de venta, y nunca menos que 2 veces el minimo.
  - Sin señal suficiente no se propone nada: hacen falta >= 3 unidades
    vendidas en 90 dias y una venta en los ultimos 45 (o consumo por vinculo).

Donde se escribe:
  - Producto sin variedades: `stock_min` / `stock_max` a nivel producto, en
    unidades (asi los leen las alertas).
  - Producto con variedades: en cada fila de `conjunto_colores` que no tenga
    nada cargado, con `stock_min_um` explicito: 'pack' cuando el minimo llega
    a un pack entero, 'unidad' si no. El nivel producto no se toca, y si el
    producto ya tiene un minimo global cargado se saltea entero.
  - Servicios / ilimitados / sin ventas: no se tocan.
"""
import argparse
import math
import os
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta, timezone

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

from pos_system.models.conjunto import contenido_de

DIAS_VENTAS = 90
DIAS_RECIENTE = 30
DIAS_SIN_VENTA_MAX = 45
DIAS_MINIMO = 7
DIAS_MAXIMO = 28
SENAL_MINIMA_90 = 3

# Unidades de medida que ya vienen en unidad base en el renglon de venta:
# "1.5 m" son metros, no packs. Todo lo demas (caja, rollo, pack, bolsa...)
# multiplica por el contenido.
SUFIJOS_BASE = {'u', 'm', 'cm', 'g', 'kg', 'l', 'ml', 'm2'}


def num(v, por_defecto=0.0):
    try:
        return float(v) if v not in (None, '') else por_defecto
    except (TypeError, ValueError):
        return por_defecto


def normalizar(texto):
    """MAYUSCULAS, sin tildes y con los espacios colapsados, para matchear."""
    t = unicodedata.normalize('NFD', str(texto or ''))
    t = ''.join(ch for ch in t if not unicodedata.combining(ch))
    return re.sub(r'\s+', ' ', t).strip().upper()


RE_RENGLON = re.compile(r'^(?:\[(?P<color>[^\]]*)\]\s*)?(?P<nombre>.*?)(?:\s+·\s+(?P<cant>[\d.,]+)\s*(?P<sufijo>\S.*)?)?$')


def parsear_renglon(producto, cantidad, contenido):
    """(nombre_base, color, unidades_base) de un renglon de ventas_por_dia.

    El POS guarda "[Negra]  BOLIGRAFO BIC 1 MM  ·  3 u". La cantidad del campo
    es la de la unidad de venta: si el sufijo no es una unidad base (u, m, g...)
    la venta fue por envase y se multiplica por el contenido del pack.
    """
    m = RE_RENGLON.match(str(producto or '').strip())
    if not m:
        return normalizar(producto), '', num(cantidad)
    nombre = m.group('nombre') or ''
    color = m.group('color') or ''
    sufijo = (m.group('sufijo') or 'u').strip().lower()
    sufijo = re.sub(r'\(.*\)$', '', sufijo).strip() or 'u'
    unidades = num(cantidad)
    if sufijo not in SUFIJOS_BASE and num(contenido) > 1:
        unidades *= num(contenido)
    return normalizar(nombre), normalizar(color), unidades


def velocidad(total_30, total_90, vel_vinculos=0.0):
    """Unidades por dia: lo reciente manda, lo viejo es el fallback."""
    base = (total_30 / DIAS_RECIENTE) if total_30 > 0 else (total_90 / DIAS_VENTAS)
    return base + max(0.0, vel_vinculos)


def proponer_umbrales(vel):
    """(minimo, maximo) en unidades para una velocidad de venta diaria."""
    if vel <= 0:
        return None
    minimo = max(1, math.ceil(vel * DIAS_MINIMO))
    maximo = max(math.ceil(vel * DIAS_MAXIMO), minimo * 2)
    return minimo, maximo


def umbrales_variedad(vel, contenido):
    """Umbrales de una variedad con su unidad: en packs cuando el minimo llega
    a un pack entero (asi el numero queda chico y se compra por envase), en
    unidades si no. Devuelve dict listo para la fila o None."""
    prop = proponer_umbrales(vel)
    if not prop:
        return None
    minimo, maximo = prop
    cont = num(contenido)
    if cont > 1 and minimo >= cont:
        min_p = math.ceil(minimo / cont)
        max_p = max(math.ceil(maximo / cont), min_p * 2)
        return {'stock_min': min_p, 'stock_max': max_p, 'stock_min_um': 'pack'}
    return {'stock_min': minimo, 'stock_max': maximo, 'stock_min_um': 'unidad'}


def tiene_umbral(d):
    return num(d.get('stock_min')) > 0 or num(d.get('stock_max')) > 0


def variedades_de(p):
    c = p.get('conjunto_colores')
    return [v for v in c if isinstance(v, dict)] if isinstance(c, list) else []


def conectar():
    import firebase_admin
    from firebase_admin import credentials, firestore
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(
            credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))
    return firestore.client()


def leer_ventas(db, hoy):
    """Renglones de ventas_por_dia de los ultimos DIAS_VENTAS dias.

    `fecha_dt` no tiene indice de rango en esa coleccion, asi que se consulta
    dia por dia con el campo `fecha` (dd/mm/yyyy), que si lo tiene.
    """
    filas = []
    for i in range(DIAS_VENTAS):
        dia = hoy - timedelta(days=i)
        fecha = dia.strftime('%d/%m/%Y')
        for d in db.collection('ventas_por_dia').where('fecha', '==', fecha).stream():
            v = d.to_dict() or {}
            filas.append((i, v.get('producto'), v.get('conjunto_color'), v.get('cantidad')))
        if i % 30 == 29:
            print(f'   ... {i + 1} dias leidos, {len(filas)} renglones')
    return filas


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--aplicar', action='store_true', help='escribir; sin esto solo muestra')
    args = ap.parse_args()

    db = conectar()
    print('Leyendo el catalogo...')
    docs = {d.id: (d.to_dict() or {}) for d in db.collection('catalogo').stream()}
    print(f'{len(docs)} productos')

    # Indice nombre normalizado -> doc. Los nombres repetidos se descartan:
    # no se puede saber a cual de los dos fue la venta.
    por_nombre, repetidos = {}, set()
    for did, p in docs.items():
        n = normalizar(p.get('nombre'))
        if not n:
            continue
        if n in por_nombre:
            repetidos.add(n)
        else:
            por_nombre[n] = did
    for n in repetidos:
        por_nombre.pop(n, None)

    hoy = datetime.now(timezone.utc)
    print(f'Leyendo ventas de los ultimos {DIAS_VENTAS} dias...')
    filas = leer_ventas(db, hoy)
    print(f'{len(filas)} renglones')

    print('Leyendo consumo por vinculos (papel de impresiones)...')
    desde = hoy - timedelta(days=DIAS_RECIENTE)
    consumo = defaultdict(float)
    ts_min = hoy
    for m in db.collection('stock_movimientos').where('ts', '>=', desde).stream():
        d = m.to_dict() or {}
        if d.get('motivo') in ('vinculacion', 'venta_vinculada') and num(d.get('cantidad')) < 0:
            fid = d.get('firebase_id')
            if fid:
                consumo[fid] += -num(d.get('cantidad'))
                if d.get('ts') and d['ts'] < ts_min:
                    ts_min = d['ts']
    dias_ledger = max(7.0, (hoy - ts_min).total_seconds() / 86400)
    vel_vinc = {fid: total / dias_ledger for fid, total in consumo.items()}
    print(f'{len(vel_vinc)} productos con consumo por vinculo (ventana {dias_ledger:.0f} dias)')

    # Demanda por producto y por (producto, color), en unidades base.
    v30, v90 = defaultdict(float), defaultdict(float)
    v30_color, v90_color = defaultdict(float), defaultdict(float)
    ultima = {}
    sin_match = defaultdict(float)
    for dias_atras, producto, color_campo, cantidad in filas:
        nombre, color_parseado, _ = parsear_renglon(producto, cantidad, 0)
        did = por_nombre.get(nombre)
        if not did:
            sin_match[nombre] += num(cantidad)
            continue
        p = docs[did]
        color = normalizar(color_campo) or color_parseado
        cont = num(p.get('conjunto_contenido'))
        if color:
            for v in variedades_de(p):
                if normalizar(v.get('color')) == color:
                    cont = contenido_de(v, num(p.get('conjunto_contenido')))
                    break
        _, _, unidades = parsear_renglon(producto, cantidad, cont)
        v90[did] += unidades
        if dias_atras < DIAS_RECIENTE:
            v30[did] += unidades
        if did not in ultima or dias_atras < ultima[did]:
            ultima[did] = dias_atras
        if color:
            k = (did, color)
            v90_color[k] += unidades
            if dias_atras < DIAS_RECIENTE:
                v30_color[k] += unidades

    # Propuestas
    planes = {}            # did -> {'producto': {...}} | {'variedades': {color_norm: fila_umbral}}
    saltados = defaultdict(int)
    for did, p in docs.items():
        if p.get('stock_ilimitado') is True or num(p.get('stock')) == -1:
            saltados['ilimitado'] += 1
            continue
        if tiene_umbral(p):
            saltados['ya configurado'] += 1
            continue
        vs = variedades_de(p)
        vinc = vel_vinc.get(did, 0.0)
        if vs:
            filas_nuevas = {}
            for v in vs:
                if tiene_umbral(v):
                    continue
                color = normalizar(v.get('color'))
                k = (did, color)
                t90 = v90_color.get(k, 0.0)
                if t90 < SENAL_MINIMA_90:
                    continue
                vel = velocidad(v30_color.get(k, 0.0), t90)
                fila = umbrales_variedad(vel, contenido_de(v, num(p.get('conjunto_contenido'))))
                if fila:
                    filas_nuevas[color] = fila
            if filas_nuevas:
                planes[did] = {'variedades': filas_nuevas}
            else:
                saltados['sin señal'] += 1
        else:
            t90 = v90.get(did, 0.0)
            con_senal = t90 >= SENAL_MINIMA_90 and ultima.get(did, 999) <= DIAS_SIN_VENTA_MAX
            if not con_senal and vinc <= 0:
                saltados['sin señal'] += 1
                continue
            prop = proponer_umbrales(velocidad(v30.get(did, 0.0), t90, vinc))
            if not prop:
                saltados['sin señal'] += 1
                continue
            minimo, maximo = prop
            planes[did] = {'producto': {'stock_min': minimo, 'stock_max': maximo}}

    # Reporte
    n_prod = sum(1 for a in planes.values() if 'producto' in a)
    n_var = sum(len(a['variedades']) for a in planes.values() if 'variedades' in a)
    n_prod_var = sum(1 for a in planes.values() if 'variedades' in a)
    print(f'\n== propuesta: {n_prod} productos + {n_var} variedades (en {n_prod_var} productos)')
    for motivo, cant in sorted(saltados.items()):
        print(f'   saltados por {motivo}: {cant}')

    en_alerta = 0
    muestras = []
    for did, acc in planes.items():
        p = docs[did]
        if 'producto' in acc:
            if num(p.get('stock')) <= acc['producto']['stock_min']:
                en_alerta += 1
            muestras.append((v90.get(did, 0.0), p.get('nombre'), '', acc['producto']))
        else:
            for color, fila in acc['variedades'].items():
                muestras.append((v90_color.get((did, color), 0.0), p.get('nombre'), color, fila))
    print(f'   productos que quedarian EN ALERTA ya mismo: {en_alerta}')
    print('\n   Los 15 de mas movimiento:')
    for total, nombre, color, fila in sorted(muestras, reverse=True)[:15]:
        um = fila.get('stock_min_um', 'unidad')
        print(f"   {str(nombre)[:42]:<42} {('[' + color + ']') if color else '':<18} "
              f"min {fila['stock_min']:>4} max {fila['stock_max']:>5} {um:<6} (vendio {total:.0f} en 90d)")

    if not args.aplicar:
        print('\nSin --aplicar no se escribio nada.')
        return

    print('\nEscribiendo...')
    import json
    ahora = datetime.now(timezone.utc)
    col = db.collection('catalogo')
    escritos = 0
    batch = db.batch()
    n = 0
    # Vuelta atras exacta: que se escribio y donde, con lo que habia antes.
    # (Restaurar `conjunto_colores` entero desde un backup pisaria el stock que
    # se movio con las ventas; esto guarda solo los umbrales tocados.)
    rollback = {'ts': ahora.isoformat(), 'productos': {}, 'variedades': {}}
    for did, acc in planes.items():
        if 'producto' in acc:
            p = docs[did]
            rollback['productos'][did] = {
                'nombre': p.get('nombre'),
                'antes': {'stock_min': p.get('stock_min'), 'stock_max': p.get('stock_max')},
                'escrito': acc['producto'],
            }
            batch.set(col.document(did),
                      {**acc['producto'], 'ultima_actualizacion': ahora}, merge=True)
            n += 1
        else:
            # La fila vive adentro del array: se relee el doc fresco y se
            # mergea, para no pisar un stock que se haya movido en el medio.
            doc = col.document(did).get()
            p = doc.to_dict() or {}
            vs = variedades_de(p)
            cambiadas = []
            for v in vs:
                fila = acc['variedades'].get(normalizar(v.get('color')))
                if fila and not tiene_umbral(v):
                    v.update(fila)
                    cambiadas.append(v.get('color'))
            if not cambiadas:
                continue
            rollback['variedades'][did] = {
                'nombre': p.get('nombre'), 'colores': cambiadas,
                'escrito': {c: acc['variedades'][normalizar(c)] for c in cambiadas},
            }
            batch.set(col.document(did),
                      {'conjunto_colores': vs, 'ultima_actualizacion': ahora}, merge=True)
            n += 1
        escritos += 1
        if n >= 400:
            batch.commit()
            batch = db.batch()
            n = 0
    if n:
        batch.commit()
    ruta_rb = os.path.join(RAIZ, f"minmax_rollback_{ahora.strftime('%Y%m%d_%H%M')}.json")
    with open(ruta_rb, 'w', encoding='utf-8') as f:
        json.dump(rollback, f, ensure_ascii=False, indent=1)
    print(f'Vuelta atras guardada en {os.path.basename(ruta_rb)}')
    db.collection('config').document('catalogo_meta').set(
        {'last_updated': ahora.strftime('%Y-%m-%dT%H:%M:%S%z')}, merge=True)
    print(f'Listo: {escritos} productos escritos. Panel y POS lo ven en el proximo sync.')


if __name__ == '__main__':
    main()
