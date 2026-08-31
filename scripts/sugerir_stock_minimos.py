"""
Propone stock minimo y maximo para los productos que no tienen ninguno, a
partir de lo que realmente se vende, y corrige sus propias cargas anteriores.
No pisa lo cargado a mano: un umbral que no escribio este script queda como
esta, siempre.

Sin `--aplicar` solo muestra que cambiaria. Antes de aplicar: python backup_catalogo.py

    python scripts/sugerir_stock_minimos.py
    python scripts/sugerir_stock_minimos.py --aplicar

De donde sale la demanda:
  - `ventas_por_dia` de todo el historial disponible (hasta 180 dias), renglon
    por renglon, con la variedad ([Color]  NOMBRE  ·  N u). Las ventas por
    caja/rollo se pasan a unidades multiplicando por el contenido del pack.
  - `stock_movimientos` con motivo vinculacion/venta_vinculada: el papel que
    consumen las impresiones no pasa por ventas, pero es demanda igual.

La cuenta, por producto y por variedad:
  - Tres miradas de velocidad: ultimos 30 dias, ultimos 90, y el historial
    completo desde la PRIMERA venta del producto (asi un producto nuevo no
    divide por meses que no vivio). La velocidad es la MEDIANA de las tres:
    un pico del ultimo mes no infla el minimo, y la temporada que ya paso no
    lo mantiene alto.
  - minimo = 7 dias de venta, redondeado para arriba (al menos 1).
  - maximo = 28 dias de venta, y nunca menos que 2 veces el minimo.
  - Sin señal suficiente no se propone nada: hacen falta >= 3 unidades en la
    ventana y una venta en los ultimos 45 dias (o consumo por vinculo).

Que toca y que no:
  - Umbral cargado a mano (no figura en ningun minmax_rollback_*.json de este
    script, o figura con otro valor): NO SE TOCA.
  - Umbral que escribio este script y sigue tal cual: se recalcula; si cambia
    se actualiza, y si el producto perdio la señal se QUITA (mejor sin alerta
    que con una alerta inventada).
  - Producto sin variedades: `stock_min` / `stock_max` a nivel producto, en
    unidades; si es conjunto con pack de mas de una unidad, redondeados para
    arriba al pack cerrado (no se compran 3 metros de un rollo de 10). Con
    variedades: por fila de `conjunto_colores`, con `stock_min_um` explicito
    ('pack' siempre que el pack traiga mas de una unidad, 'unidad' cuando el
    pack ES la unidad). Servicios / ilimitados / sin ventas: no se tocan.
  - Cada aplicacion deja un minmax_rollback_<ts>.json con lo escrito y lo que
    habia antes; las corridas siguientes lo usan para reconocer lo suyo.
"""
import argparse
import glob
import json
import math
import os
import re
import statistics
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta, timezone

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

from pos_system.models.conjunto import contenido_de

DIAS_VENTAS = 180
DIAS_MEDIO = 90
DIAS_RECIENTE = 30
DIAS_SIN_VENTA_MAX = 45   # para AGREGAR un umbral hace falta venta reciente
DIAS_PARA_QUITAR = 90     # para QUITAR uno propio, 90 dias sin ventas: un
                          # producto lento no pierde la alerta por un dia
DIAS_MINIMO = 7
DIAS_MAXIMO = 28
SENAL_MINIMA = 3
EDAD_PISO = 7  # dias: un producto de dos dias no define velocidad

# Unidades de medida que ya vienen en unidad de MEDIDA en el renglon de venta:
# "1.5 m" son metros, no packs. Todo lo demas (caja, rollo, pack, bolsa...)
# multiplica por el contenido.
SUFIJOS_BASE = {'u', 'mm', 'cm', 'm', 'm2', 'g', 'kg', 'l', 'ml'}

# Conversion a la unidad base del producto: 50 cm de fiselina son 0,5 m, no
# 50 unidades. Solo entre unidades de la misma magnitud; el resto va tal cual.
_FACTOR = {'mm': 0.001, 'cm': 0.01, 'm': 1.0, 'ml': 0.001, 'l': 1.0,
           'g': 1.0, 'kg': 1000.0}
_MAGNITUD = {'mm': 'm', 'cm': 'm', 'm': 'm', 'ml': 'l', 'l': 'l',
             'g': 'g', 'kg': 'g'}
_BASE_PRODUCTO = {
    'metros': 'm', 'metro': 'm', 'm': 'm', 'centimetros': 'cm', 'cm': 'cm',
    'unidades': 'u', 'unidad': 'u', 'u': 'u', 'gramos': 'g', 'g': 'g',
    'kilos': 'kg', 'kilogramos': 'kg', 'kg': 'kg', 'litros': 'l', 'l': 'l',
    'mililitros': 'ml', 'ml': 'ml', 'm2': 'm2',
}


def unidad_base_de(p):
    crudo = normalizar(p.get('conjunto_unidad_medida')).lower()
    return _BASE_PRODUCTO.get(crudo, 'u')


def a_unidad_base(cantidad, sufijo, base):
    if sufijo == base or sufijo not in _MAGNITUD or base not in _MAGNITUD:
        return cantidad
    if _MAGNITUD[sufijo] != _MAGNITUD[base]:
        return cantidad
    return cantidad * _FACTOR[sufijo] / _FACTOR[base]


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


def parsear_renglon(producto, cantidad, contenido, base='u'):
    """(nombre_base, color, unidades_base) de un renglon de ventas_por_dia.

    El POS guarda "[Negra]  BOLIGRAFO BIC 1 MM  ·  3 u". La cantidad del campo
    es la de la unidad de venta: si el sufijo es de medida (u, m, cm, g...) se
    convierte a la unidad base del producto; si es un envase (caja, rollo...)
    se multiplica por el contenido del pack.
    """
    m = RE_RENGLON.match(str(producto or '').strip())
    if not m:
        return normalizar(producto), '', num(cantidad)
    nombre = m.group('nombre') or ''
    color = m.group('color') or ''
    sufijo = (m.group('sufijo') or base).strip().lower()
    sufijo = re.sub(r'\(.*\)$', '', sufijo).strip() or base
    unidades = num(cantidad)
    if sufijo in SUFIJOS_BASE:
        unidades = a_unidad_base(unidades, sufijo, base)
    elif num(contenido) > 1:
        unidades *= num(contenido)
    return normalizar(nombre), normalizar(color), unidades


class Demanda:
    """Ventas acumuladas de un producto o una variedad, por antiguedad."""

    __slots__ = ('t30', 't90', 'total', 'primera', 'ultima')

    def __init__(self):
        self.t30 = self.t90 = self.total = 0.0
        self.primera = 0    # dias atras de la venta mas vieja
        self.ultima = 10 ** 6

    def sumar(self, unidades, dias_atras):
        self.total += unidades
        if dias_atras < DIAS_RECIENTE:
            self.t30 += unidades
        if dias_atras < DIAS_MEDIO:
            self.t90 += unidades
        self.primera = max(self.primera, dias_atras)
        self.ultima = min(self.ultima, dias_atras)


def velocidad(d, vel_vinculos=0.0):
    """Unidades por dia: la mediana de las tres miradas, mas los vinculos.

    Las ventanas se acortan a la edad del producto (dias desde su primera
    venta): uno que arranco hace 20 dias no divide por 90.
    """
    edad = max(EDAD_PISO, min(DIAS_VENTAS, d.primera + 1))
    tasas = [
        d.t30 / min(DIAS_RECIENTE, edad),
        d.t90 / min(DIAS_MEDIO, edad),
        d.total / edad,
    ]
    return statistics.median(tasas) + max(0.0, vel_vinculos)


def con_senal(d):
    """Señal para AGREGAR un umbral nuevo: volumen y venta reciente."""
    return d.total >= SENAL_MINIMA and d.ultima <= DIAS_SIN_VENTA_MAX


def con_senal_para_mantener(d):
    """Señal para CONSERVAR un umbral propio: mas tolerante. Un producto lento
    (el hilo encerado que vendio su ultimo rollo hace 46 dias) mantiene su
    alerta; recien a los 90 dias sin ventas se la saca."""
    return d.total >= SENAL_MINIMA and d.ultima <= DIAS_PARA_QUITAR


def proponer_umbrales(vel):
    """(minimo, maximo) en unidades para una velocidad de venta diaria."""
    if vel <= 0:
        return None
    minimo = max(1, math.ceil(vel * DIAS_MINIMO))
    maximo = max(math.ceil(vel * DIAS_MAXIMO), minimo * 2)
    return minimo, maximo


def umbrales_variedad(vel, contenido):
    """Umbrales de una variedad con su unidad: en packs siempre que el pack
    traiga mas de una unidad, porque la reposicion se compra por envase
    cerrado: un minimo de 3 metros no existe si la cinta viene en rollos de
    10, el minimo real es 1 rollo. En unidades solo cuando el pack ES la
    unidad. Devuelve dict listo para la fila o None."""
    prop = proponer_umbrales(vel)
    if not prop:
        return None
    minimo, maximo = prop
    cont = num(contenido)
    if cont > 1:
        min_p = math.ceil(minimo / cont)
        max_p = max(math.ceil(maximo / cont), min_p * 2)
        return {'stock_min': min_p, 'stock_max': max_p, 'stock_min_um': 'pack'}
    return {'stock_min': minimo, 'stock_max': maximo, 'stock_min_um': 'unidad'}


def _entero_si_da(x):
    x = round(x, 4)
    return int(x) if float(x).is_integer() else x


def umbrales_producto(vel, contenido):
    """Umbrales a nivel producto, siempre en unidades (a este nivel no existe
    `stock_min_um` y las alertas comparan contra el stock plano). Si el
    producto se compra por pack (contenido > 1), los dos umbrales suben al
    multiplo de pack cerrado: mismo criterio que la variedad, expresado en
    unidades."""
    prop = proponer_umbrales(vel)
    if not prop:
        return None
    minimo, maximo = prop
    cont = num(contenido)
    if cont > 1:
        min_p = math.ceil(minimo / cont)
        max_p = max(math.ceil(maximo / cont), min_p * 2)
        minimo = _entero_si_da(min_p * cont)
        maximo = _entero_si_da(max_p * cont)
    return {'stock_min': minimo, 'stock_max': maximo}


def tiene_umbral(d):
    return num(d.get('stock_min')) > 0 or num(d.get('stock_max')) > 0


def variedades_de(p):
    c = p.get('conjunto_colores')
    return [v for v in c if isinstance(v, dict)] if isinstance(c, list) else []


# --------------------------------------------------------------------------
# Reconocer lo que escribio este script (para corregirse sin pisar lo manual)
# --------------------------------------------------------------------------

def cargar_propios(raiz):
    """Ultimo umbral escrito por este script en cada lugar, leyendo los
    minmax_rollback_*.json en orden. Devuelve (por_producto, por_variedad):
    did -> escrito, y (did, color_norm) -> fila escrita."""
    productos, filas = {}, {}
    for ruta in sorted(glob.glob(os.path.join(raiz, 'minmax_rollback_*.json'))):
        try:
            data = json.load(open(ruta, encoding='utf-8'))
        except (OSError, ValueError):
            continue
        for did, e in (data.get('productos') or {}).items():
            productos[did] = e.get('escrito') or {}
        for did, e in (data.get('variedades') or {}).items():
            for color, fila in (e.get('escrito') or {}).items():
                filas[(did, normalizar(color))] = fila or {}
    return productos, filas


def es_propio(actual, escrito):
    """El umbral que esta cargado es exactamente el que escribio el script.
    Si el dueño lo toco (cualquier campo distinto), ya es suyo y no se pisa."""
    if not escrito:
        return False
    if num(actual.get('stock_min')) != num(escrito.get('stock_min')):
        return False
    if num(actual.get('stock_max')) != num(escrito.get('stock_max')):
        return False
    um_a, um_e = actual.get('stock_min_um'), escrito.get('stock_min_um')
    return (um_a or None) == (um_e or None)


QUITAR = {'stock_min': None, 'stock_max': None, 'stock_min_um': None}


def decidir(actual, escrito_previo, propuesta):
    """Que hacer en un lugar (producto o fila): None = no tocar, o el dict a
    escribir. `propuesta` None significa que la señal no alcanza."""
    if tiene_umbral(actual):
        if not es_propio(actual, escrito_previo):
            return None                      # cargado a mano: intocable
        if propuesta is None:
            return dict(QUITAR)              # lo puse yo y perdio la señal
        if es_propio(actual, propuesta):
            return None                      # ya esta igual
        return propuesta                     # lo puse yo: se corrige
    return propuesta                         # libre: solo si hay propuesta


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

    propios_prod, propios_fila = cargar_propios(RAIZ)
    print(f'Umbrales propios de corridas anteriores: {len(propios_prod)} productos, {len(propios_fila)} variedades')

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
    dem = defaultdict(Demanda)
    dem_color = defaultdict(Demanda)
    for dias_atras, producto, color_campo, cantidad in filas:
        nombre, color_parseado, _ = parsear_renglon(producto, cantidad, 0)
        did = por_nombre.get(nombre)
        if not did:
            continue
        p = docs[did]
        color = normalizar(color_campo) or color_parseado
        cont = num(p.get('conjunto_contenido'))
        if color:
            for v in variedades_de(p):
                if normalizar(v.get('color')) == color:
                    cont = contenido_de(v, num(p.get('conjunto_contenido')))
                    break
        _, _, unidades = parsear_renglon(producto, cantidad, cont, unidad_base_de(p))
        dem[did].sumar(unidades, dias_atras)
        if color:
            dem_color[(did, color)].sumar(unidades, dias_atras)

    # Decisiones
    planes = {}            # did -> {'producto': campos} | {'variedades': {color: campos}}
    stats = defaultdict(int)
    detalle = []           # (total_ventana, nombre, color, antes, campos)
    for did, p in docs.items():
        if p.get('stock_ilimitado') is True or num(p.get('stock')) == -1:
            stats['ilimitados'] += 1
            continue
        vs = variedades_de(p)
        vinc = vel_vinc.get(did, 0.0)
        if vs:
            # Nivel producto cargado a mano (no propio): esquema del dueño.
            if tiene_umbral(p) and not es_propio(p, propios_prod.get(did)):
                stats['configurados a mano'] += 1
                continue
            filas_nuevas = {}
            for v in vs:
                color = normalizar(v.get('color'))
                d = dem_color.get((did, color))
                propio = tiene_umbral(v) and es_propio(v, propios_fila.get((did, color)))
                senal = con_senal_para_mantener if propio else con_senal
                propuesta = None
                if d and senal(d):
                    propuesta = umbrales_variedad(
                        velocidad(d), contenido_de(v, num(p.get('conjunto_contenido'))))
                accion = decidir(v, propios_fila.get((did, color)), propuesta)
                if accion is None:
                    if tiene_umbral(v) and not es_propio(v, propios_fila.get((did, color))):
                        stats['variedades a mano'] += 1
                    continue
                filas_nuevas[color] = accion
                clave = ('quitados' if accion == QUITAR
                         else ('corregidos' if tiene_umbral(v) else 'nuevos'))
                stats[clave] += 1
                detalle.append((d.total if d else 0.0, p.get('nombre'), v.get('color'),
                                {'stock_min': v.get('stock_min'), 'stock_max': v.get('stock_max')},
                                accion))
            if filas_nuevas:
                planes[did] = {'variedades': filas_nuevas}
        else:
            d = dem.get(did)
            propio = tiene_umbral(p) and es_propio(p, propios_prod.get(did))
            senal = con_senal_para_mantener if propio else con_senal
            propuesta = None
            if (d and senal(d)) or vinc > 0:
                cont = (num(p.get('conjunto_contenido'))
                        if p.get('es_conjunto') in (True, 1) else 0)
                propuesta = umbrales_producto(velocidad(d or Demanda(), vinc), cont)
            accion = decidir(p, propios_prod.get(did), propuesta)
            if accion is None:
                if tiene_umbral(p) and not es_propio(p, propios_prod.get(did)):
                    stats['configurados a mano'] += 1
                continue
            planes[did] = {'producto': accion}
            clave = ('quitados' if accion == QUITAR
                     else ('corregidos' if tiene_umbral(p) else 'nuevos'))
            stats[clave] += 1
            detalle.append((d.total if d else 0.0, p.get('nombre'), '',
                            {'stock_min': p.get('stock_min'), 'stock_max': p.get('stock_max')},
                            accion))

    # Reporte
    print(f'\n== decision: {stats["nuevos"]} nuevos · {stats["corregidos"]} corregidos · '
          f'{stats["quitados"]} quitados · intactos a mano: '
          f'{stats["configurados a mano"]} productos + {stats["variedades a mano"]} variedades')
    en_alerta = 0
    for did, acc in planes.items():
        campos = acc.get('producto')
        if campos and num(campos.get('stock_min')) > 0 \
                and num(docs[did].get('stock')) <= num(campos.get('stock_min')):
            en_alerta += 1
    print(f'   productos que quedarian EN ALERTA ya mismo: {en_alerta}')
    print('\n   Los 20 de mas movimiento:')
    for total, nombre, color, antes, campos in sorted(detalle, key=lambda t: -t[0])[:20]:
        um = campos.get('stock_min_um') or 'unidad'
        antes_txt = (f"{antes['stock_min']:g}/{antes['stock_max']:g}"
                     if num(antes.get('stock_min')) or num(antes.get('stock_max')) else 'nada')
        ahora_txt = ('QUITADO' if campos == QUITAR
                     else f"min {campos['stock_min']} max {campos['stock_max']} {um}")
        print(f"   {str(nombre)[:40]:<40} {('[' + str(color) + ']') if color else '':<16} "
              f"{antes_txt:>10} -> {ahora_txt}  ({total:.0f} en {DIAS_VENTAS}d)")

    quitados = [(t, n, c, a) for t, n, c, a, campos in detalle if campos == QUITAR]
    if quitados:
        print('\n   Umbrales propios que se quitan (90+ dias sin ventas):')
        for total, nombre, color, antes in sorted(quitados, key=lambda t: -t[0]):
            print(f"   {str(nombre)[:44]:<44} {('[' + str(color) + ']') if color else '':<16} "
                  f"tenia {antes.get('stock_min'):g}/{antes.get('stock_max'):g} · vendio {total:.0f} en {DIAS_VENTAS}d")

    if not args.aplicar:
        print('\nSin --aplicar no se escribio nada.')
        return

    print('\nEscribiendo...')
    ahora = datetime.now(timezone.utc)
    col = db.collection('catalogo')
    escritos = 0
    batch = db.batch()
    n = 0
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
            cambiadas = {}
            for v in vs:
                color = normalizar(v.get('color'))
                fila = acc['variedades'].get(color)
                if fila is None:
                    continue
                # Chequeo fresco: solo si sigue siendo mio o esta libre.
                if tiene_umbral(v) and not es_propio(v, propios_fila.get((did, color))):
                    continue
                v.update(fila)
                cambiadas[v.get('color')] = fila
            if not cambiadas:
                continue
            rollback['variedades'][did] = {
                'nombre': p.get('nombre'), 'colores': list(cambiadas),
                'escrito': cambiadas,
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
    db.collection('config').document('catalogo_meta').set(
        {'last_updated': ahora.strftime('%Y-%m-%dT%H:%M:%S%z')}, merge=True)
    ruta_rb = os.path.join(RAIZ, f"minmax_rollback_{ahora.strftime('%Y%m%d_%H%M')}.json")
    with open(ruta_rb, 'w', encoding='utf-8') as f:
        json.dump(rollback, f, ensure_ascii=False, indent=1)
    print(f'Vuelta atras guardada en {os.path.basename(ruta_rb)}')
    print(f'Listo: {escritos} productos escritos. Panel y POS lo ven en el proximo sync.')


if __name__ == '__main__':
    main()
