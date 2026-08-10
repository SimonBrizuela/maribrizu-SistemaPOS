"""
Como se mueve el negocio: ventas, stock y rotacion.

    python scripts/estudio_negocio.py
    python scripts/estudio_negocio.py --meses 6 --salida datos.json

Contesta tres cosas que `estudio_canales.py` no mira, porque aquel elige QUE
producto va a cada canal y este mira COMO se mueve el local:

  · Cuando y cuanto se vende — por mes, por dia de la semana, por hora, y como
    se reparte la facturacion entre tickets chicos y grandes. De ahi sale si el
    local ya le vende a otros comercios sin haberselo propuesto.
  · Que plata esta parada — cuanto capital hay en mercaderia, cuanta de esa
    mercaderia no se vendio nunca y cuantos dias de stock queda de lo que si
    se vende.
  · Que se lleva la gente — la facturacion por rubro y por categoria, para
    ordenar la vidriera de la tienda por lo que se vende y no por lo que hay.

Escribe un JSON con todo calculado y un resumen por pantalla.

No toca nada: solo lee.
"""
import argparse
import json
import os
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import firebase_admin
from firebase_admin import credentials, firestore

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Un renglon de esta cantidad para arriba no es una compra de mostrador: es
# alguien reponiendo. Doce es la caja tipica de lapices, biromes y gomas.
BULTO = 12

# Arriba de esto un ticket ya no es "vine a comprar una carpeta". Sale del
# propio dato: es diez veces el ticket promedio del local.
TICKET_GRANDE = 60000

# Sin ventas en tantos dias, la mercaderia esta dormida.
DIAS_DORMIDO = 90

TRAMOS_TICKET = [
    (0, 2000, 'hasta $2.000'),
    (2000, 5000, '$2.000 a $5.000'),
    (5000, 10000, '$5.000 a $10.000'),
    (10000, 20000, '$10.000 a $20.000'),
    (20000, 60000, '$20.000 a $60.000'),
    (60000, float('inf'), 'más de $60.000'),
]

DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo']

# Firestore guarda todo en UTC. Córdoba está tres horas atrás y no tiene horario
# de verano desde 2009, así que alcanza con restar tres: sin esto el informe
# dice que el local vende a las once de la noche.
CORDOBA = timezone(timedelta(hours=-3))

# Los servicios se cargan en el catalogo como si fueran productos, con un stock
# que en realidad es un contador. "TRABAJO DE EDICION / CORTE X MIN" figura con
# 199.991 unidades a $89: el solo agrega $17,7 millones de capital inmovilizado
# que no existe. Se cuentan aparte, no se descartan: son el 16% de lo que
# factura el local.
PALABRAS_SERVICIO = ('IMPRESION', 'FOTOCOPIA', 'ESCANEO', 'PLASTIFICAD',
                     'ANILLAD', 'EDICION', 'CORTE X MIN', 'ENCUADERNAD')


def es_servicio(nombre, rubro=''):
    if str(rubro or '').strip().upper().startswith('SERVICIO'):
        return True
    n = str(nombre or '').upper()
    return any(palabra in n for palabra in PALABRAS_SERVICIO)


def normalizar(t):
    s = unicodedata.normalize('NFD', str(t or '').lower())
    return ' '.join(''.join(c for c in s if unicodedata.category(c) != 'Mn').split())


def clave_producto(nombre):
    """
    El nombre de venta, limpio, para poder cruzarlo contra el catalogo.

    El POS no guarda el codigo en el renglon: guarda el nombre decorado con lo
    que se eligio al vender.

        [Celeste]  CARTULINA LUMA COMUN  ·  1 u
        PAPEL OBRA A4 75 GR PAMPA  ·  10 pack(s)

    Cruzar por el nombre crudo dejaba el 38% de la facturacion "fuera del
    catalogo", que no era cierto: eran los productos con variedad y los que se
    venden por pack, o sea justo los que mas se venden. Sin esto, el estudio
    dice que el rubro mas grande del local es uno que no existe.
    """
    limpio = str(nombre or '')
    # La variedad elegida va adelante, entre corchetes.
    if limpio.lstrip().startswith('['):
        cierre = limpio.find(']')
        if cierre != -1:
            limpio = limpio[cierre + 1:]
    # Lo que se vendio (1 u, 10 pack(s)) va al final, despues de un punto medio.
    limpio = limpio.split('·')[0]
    return normalizar(limpio)


def conectar():
    clave = os.path.join(RAIZ, 'firebase_key.json')
    if not os.path.exists(clave):
        sys.exit(f'Falta {clave}')
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(clave))
    return firestore.client()


# ── Lectura ─────────────────────────────────────────────────────────────────

def leer_lineas(db, desde):
    """Cada renglon vendido. Es la tabla mas rica que hay: producto, cantidad,
    precio, dia, hora y forma de pago."""
    lineas = []
    for d in db.collection('ventas_por_dia').where('fecha_dt', '>=', desde).stream():
        x = d.to_dict() or {}
        if x.get('deleted') is True:
            continue
        fecha = x.get('fecha_dt')
        if not fecha:
            continue
        fecha = fecha.astimezone(CORDOBA)
        lineas.append({
            'producto': str(x.get('producto') or ''),
            'clave': clave_producto(x.get('producto')),
            'categoria': str(x.get('categoria') or '').strip().upper(),
            'cantidad': float(x.get('cantidad') or 0),
            'subtotal': float(x.get('subtotal') or 0),
            'precio': float(x.get('precio_unitario') or 0),
            'fecha': fecha,
            'pago': str(x.get('tipo_pago') or '').strip(),
            'venta': f"{x.get('pc_id')}_{x.get('num_venta')}",
            'servicio': es_servicio(x.get('producto'), x.get('categoria')),
        })
    return lineas


def leer_tickets(db, desde):
    tickets = []
    for d in db.collection('ventas').where('created_at', '>=', desde).stream():
        x = d.to_dict() or {}
        if x.get('deleted') is True:
            continue
        total = float(x.get('total_amount') or 0)
        if total <= 0:
            continue
        tickets.append({
            'total': total,
            'items': int(x.get('items_count') or 0),
            'fecha': x.get('created_at').astimezone(CORDOBA) if x.get('created_at') else None,
            'pago': str(x.get('payment_type') or ''),
            'id': f"{x.get('pc_id')}_{x.get('sale_id')}",
        })
    return tickets


def leer_catalogo(db):
    """
    Precio y costo de UNA unidad.

    Un producto fraccionado guarda el precio del rollo entero en `precio_venta`
    y el de un metro en `conjunto_precio_unidad`. Mezclarlos infla el capital
    inmovilizado y disfraza de estrella a cualquier cosa.
    """
    productos = {}
    for d in db.collection('catalogo').stream():
        x = d.to_dict() or {}
        if x.get('estado') == 'baja' or x.get('duplicado') is True:
            continue

        def numero(clave):
            try:
                return float(x.get(clave) or 0)
            except (TypeError, ValueError):
                return 0.0

        contenido = int(numero('conjunto_contenido'))
        if x.get('es_conjunto') is True:
            precio = numero('conjunto_precio_unidad') or numero('precio_venta')
            costo = numero('costo') / contenido if contenido > 1 else numero('costo')
            stock = numero('conjunto_total') or numero('stock')
        else:
            precio, costo, stock = numero('precio_venta'), numero('costo'), numero('stock')

        nombre = str(x.get('nombre') or '')
        productos[clave_producto(nombre)] = {
            'nombre': nombre,
            'rubro': str(x.get('rubro') or '').strip().upper() or '(sin rubro)',
            'categoria': str(x.get('categoria') or '').strip().upper() or '(sin categoría)',
            'marca': str(x.get('marca') or '').strip(),
            'proveedor': str(x.get('proveedor') or '').strip() or 'SIN PROVEEDOR',
            'precio': precio,
            'costo': costo,
            'stock': max(0.0, stock),
            'con_foto': bool(x.get('tienda_imagenes')),
            'servicio': es_servicio(nombre, x.get('rubro')),
        }
    return productos


# ── Cuentas ─────────────────────────────────────────────────────────────────

def por_tiempo(lineas, tickets):
    """Cuando se vende."""
    meses = defaultdict(lambda: {'importe': 0.0, 'tickets': set(), 'lineas': 0})
    semana = defaultdict(lambda: {'importe': 0.0, 'dias': set()})
    horas = defaultdict(lambda: {'importe': 0.0, 'tickets': set()})

    for l in lineas:
        f = l['fecha']
        clave = f.strftime('%Y-%m')
        meses[clave]['importe'] += l['subtotal']
        meses[clave]['tickets'].add(l['venta'])
        meses[clave]['lineas'] += 1

        semana[f.weekday()]['importe'] += l['subtotal']
        semana[f.weekday()]['dias'].add(f.strftime('%Y-%m-%d'))

        horas[f.hour]['importe'] += l['subtotal']
        horas[f.hour]['tickets'].add(l['venta'])

    salida_meses = [{
        'mes': k, 'importe': v['importe'], 'tickets': len(v['tickets']),
        'lineas': v['lineas'],
        'ticket_promedio': v['importe'] / len(v['tickets']) if v['tickets'] else 0,
    } for k, v in sorted(meses.items())]

    salida_semana = [{
        'dia': DIAS[i],
        'importe': semana[i]['importe'],
        'jornadas': len(semana[i]['dias']),
        # Lo que importa no es cuanto factura el sabado en total, sino cuanto
        # factura UN sabado: hay la mitad de sabados que de dias habiles.
        'por_jornada': semana[i]['importe'] / len(semana[i]['dias']) if semana[i]['dias'] else 0,
    } for i in range(7) if semana[i]['dias']]

    salida_horas = [{
        'hora': h, 'importe': horas[h]['importe'], 'tickets': len(horas[h]['tickets']),
    } for h in sorted(horas)]

    return {'meses': salida_meses, 'semana': salida_semana, 'horas': salida_horas}


def por_ticket(tickets, lineas):
    """Como se reparte la facturacion entre compras chicas y grandes."""
    total = sum(t['total'] for t in tickets)
    ordenados = sorted(t['total'] for t in tickets)
    mediana = ordenados[len(ordenados) // 2] if ordenados else 0

    # `items_count` viene en cero en casi todas las ventas, asi que los
    # renglones se cuentan desde `ventas_por_dia`, que es donde estan de verdad.
    renglones = defaultdict(int)
    for l in lineas:
        renglones[l['venta']] += 1
    con_renglones = [renglones[t['id']] for t in tickets if t['id'] in renglones]

    tramos = []
    for piso, techo, texto in TRAMOS_TICKET:
        dentro = [t for t in tickets if piso <= t['total'] < techo]
        tramos.append({
            'texto': texto, 'tickets': len(dentro),
            'importe': sum(t['total'] for t in dentro),
            'parte_tickets': len(dentro) / len(tickets) if tickets else 0,
            'parte_importe': sum(t['total'] for t in dentro) / total if total else 0,
        })

    # Que hay adentro de los tickets grandes: si son cinco productos caros o
    # veinte renglones de reposicion, son dos negocios distintos.
    grandes = {t['id'] for t in tickets if t['total'] >= TICKET_GRANDE}
    lineas_grandes = [l for l in lineas if l['venta'] in grandes]
    productos_grandes = defaultdict(lambda: {'importe': 0.0, 'unidades': 0.0, 'veces': 0})
    for l in lineas_grandes:
        p = productos_grandes[l['producto']]
        p['importe'] += l['subtotal']
        p['unidades'] += l['cantidad']
        p['veces'] += 1

    return {
        'cantidad': len(tickets),
        'total': total,
        'promedio': total / len(tickets) if tickets else 0,
        'mediana': mediana,
        'items_promedio': sum(con_renglones) / len(con_renglones) if con_renglones else 0,
        # Cuantos tickets se pudieron cruzar contra sus renglones: si esto baja,
        # todo lo que dependa del cruce (que hay adentro de un ticket grande)
        # esta mirando una parte y no el total.
        'cruzados': len(con_renglones),
        'tramos': tramos,
        'grandes': {
            'desde': TICKET_GRANDE,
            'cantidad': len(grandes),
            'importe': sum(t['total'] for t in tickets if t['total'] >= TICKET_GRANDE),
            'productos': sorted(
                [{'nombre': k, **v} for k, v in productos_grandes.items()],
                key=lambda x: -x['importe'])[:25],
        },
    }


def por_bulto(lineas):
    """
    Renglones de doce unidades para arriba.

    Es la venta mayorista que ya esta pasando sin que nadie la haya buscado: al
    mostrador no se llevan doce gomas de borrar.
    """
    # Sin servicios: el renglón más grande del local es "IMPRESION / FOTOCOPIA
    # A4 (B/N) × 10.462", que es un trabajo de impresión y no una reposición.
    bultos = [l for l in lineas if l['cantidad'] >= BULTO and not l['servicio']]
    porProducto = defaultdict(lambda: {'importe': 0.0, 'unidades': 0.0, 'veces': 0})
    for l in bultos:
        p = porProducto[l['producto']]
        p['importe'] += l['subtotal']
        p['unidades'] += l['cantidad']
        p['veces'] += 1

    total = sum(l['subtotal'] for l in lineas if not l['servicio'])
    return {
        'desde': BULTO,
        'sobre': 'mercadería, sin contar servicios',
        'lineas': len(bultos),
        'importe': sum(l['subtotal'] for l in bultos),
        'parte': sum(l['subtotal'] for l in bultos) / total if total else 0,
        'productos': sorted([{'nombre': k, **v} for k, v in porProducto.items()],
                            key=lambda x: -x['importe'])[:30],
    }


def por_rubro(lineas, catalogo, dias):
    """
    Que se lleva la gente, agrupado como lo agrupa el catalogo.

    Sirve para dos cosas distintas: ordenar la vidriera por lo que se vende, y
    ver el desbalance entre cuantos productos tiene un rubro y cuanto factura.
    """
    rubros = defaultdict(lambda: {'importe': 0.0, 'unidades': 0.0, 'lineas': 0})
    categorias = defaultdict(lambda: {'importe': 0.0, 'unidades': 0.0, 'lineas': 0,
                                      'rubro': '', 'productos': set()})
    sin_encontrar = 0

    for l in lineas:
        p = catalogo.get(l['clave'])
        if not p:
            sin_encontrar += 1
            rubro, categoria = '(fuera del catálogo)', l['categoria'] or '(sin categoría)'
        else:
            rubro, categoria = p['rubro'], p['categoria']

        rubros[rubro]['importe'] += l['subtotal']
        rubros[rubro]['unidades'] += l['cantidad']
        rubros[rubro]['lineas'] += 1

        c = categorias[categoria]
        c['importe'] += l['subtotal']
        c['unidades'] += l['cantidad']
        c['lineas'] += 1
        c['rubro'] = rubro
        c['productos'].add(l['clave'])

    # Cuantos productos y cuanto stock tiene cada rubro, para cruzarlo contra
    # lo que factura.
    surtido = defaultdict(lambda: {'productos': 0, 'con_stock': 0, 'con_foto': 0,
                                   'capital': 0.0})
    for p in catalogo.values():
        s = surtido[p['rubro']]
        s['productos'] += 1
        if p['stock'] > 0:
            s['con_stock'] += 1
            s['capital'] += p['stock'] * p['costo']
            if p['con_foto']:
                s['con_foto'] += 1

    salida = []
    total = sum(r['importe'] for r in rubros.values())
    for nombre, v in rubros.items():
        s = surtido.get(nombre, {})
        salida.append({
            'rubro': nombre, 'importe': v['importe'], 'unidades': v['unidades'],
            'lineas': v['lineas'], 'parte': v['importe'] / total if total else 0,
            'por_dia': v['importe'] / dias if dias else 0,
            'productos': s.get('productos', 0), 'con_stock': s.get('con_stock', 0),
            'con_foto': s.get('con_foto', 0), 'capital': s.get('capital', 0.0),
        })

    cats = sorted([{'categoria': k, 'rubro': v['rubro'], 'importe': v['importe'],
                    'unidades': v['unidades'], 'lineas': v['lineas'],
                    'productos': len(v['productos'])}
                   for k, v in categorias.items()], key=lambda x: -x['importe'])

    return {
        'rubros': sorted(salida, key=lambda x: -x['importe']),
        'categorias': cats[:40],
        'lineas_sin_catalogo': sin_encontrar,
    }


def por_producto(lineas, catalogo, dias):
    """Rotacion producto por producto, y la plata que esta parada."""
    vendido = defaultdict(lambda: {'importe': 0.0, 'unidades': 0.0, 'lineas': 0,
                                   'ultima': None})
    for l in lineas:
        v = vendido[l['clave']]
        v['importe'] += l['subtotal']
        v['unidades'] += l['cantidad']
        v['lineas'] += 1
        if v['ultima'] is None or l['fecha'] > v['ultima']:
            v['ultima'] = l['fecha']

    filas = []
    for clave, p in catalogo.items():
        v = vendido.get(clave)
        unidades = v['unidades'] if v else 0.0
        importe = v['importe'] if v else 0.0
        # Margen sobre el costo, en pesos y por unidad. Sin costo cargado no se
        # puede saber si se gana: se marca y no se inventa.
        ganancia = (p['precio'] - p['costo']) * unidades if p['costo'] > 0 else None
        por_dia = unidades / dias if dias else 0
        filas.append({
            'nombre': p['nombre'], 'rubro': p['rubro'], 'categoria': p['categoria'],
            'proveedor': p['proveedor'], 'marca': p['marca'],
            'precio': p['precio'], 'costo': p['costo'], 'stock': p['stock'],
            'con_foto': p['con_foto'], 'servicio': p['servicio'],
            'unidades': unidades, 'importe': importe,
            'ganancia': ganancia,
            'por_dia': por_dia,
            # Cuantos dias dura el stock al ritmo actual. Sin ventas no hay
            # ritmo: es None, no infinito, porque son cosas distintas.
            'cobertura': (p['stock'] / por_dia) if por_dia > 0 else None,
            'capital': p['stock'] * p['costo'],
            'ultima_venta': v['ultima'].strftime('%Y-%m-%d') if v and v['ultima'] else None,
        })

    return filas


def resumen_stock(filas, dias):
    # Los servicios quedan afuera: su "stock" es un contador de minutos o de
    # copias, no mercadería comprada.
    filas = [f for f in filas if not f['servicio']]
    con_stock = [f for f in filas if f['stock'] > 0]
    capital = sum(f['capital'] for f in con_stock)

    dormidos = [f for f in con_stock if f['unidades'] == 0]
    vivos = [f for f in con_stock if f['unidades'] > 0]

    # Lo que se va a acabar antes de un mes al ritmo de estos meses.
    por_acabarse = sorted([f for f in vivos if f['cobertura'] is not None
                           and f['cobertura'] < 30],
                          key=lambda f: f['cobertura'])
    # Lo contrario: mercaderia comprada para diez años.
    excedidos = sorted([f for f in vivos if f['cobertura'] is not None
                        and f['cobertura'] > 730],
                       key=lambda f: -f['capital'])

    return {
        'productos': len(filas),
        'con_stock': len(con_stock),
        'sin_stock': len(filas) - len(con_stock),
        'capital': capital,
        'sin_costo': len([f for f in con_stock if f['costo'] <= 0]),
        'dormidos': {
            'cantidad': len(dormidos),
            'capital': sum(f['capital'] for f in dormidos),
            'parte_capital': (sum(f['capital'] for f in dormidos) / capital) if capital else 0,
            'peores': sorted(dormidos, key=lambda f: -f['capital'])[:25],
        },
        'vivos': {
            'cantidad': len(vivos),
            'capital': sum(f['capital'] for f in vivos),
        },
        'por_acabarse': por_acabarse[:30],
        'excedidos': excedidos[:20],
    }


def concentracion(filas):
    """Cuanta facturacion hacen los primeros productos: dice cuanto del negocio
    depende de cuan poco."""
    ordenados = sorted([f for f in filas if f['importe'] > 0], key=lambda f: -f['importe'])
    total = sum(f['importe'] for f in ordenados)
    cortes = {}
    for n in (20, 50, 100, 250, 500):
        cortes[n] = sum(f['importe'] for f in ordenados[:n]) / total if total else 0
    return {
        'vendieron': len(ordenados),
        'total': total,
        'cortes': cortes,
        'top': ordenados[:40],
    }


# ── Salida por pantalla ─────────────────────────────────────────────────────

def plata(n):
    return f'${n:,.0f}'.replace(',', '.')


def main():
    # La consola de Windows sale en cp1252 y se atraganta con "≥".
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--meses', type=int, default=6)
    ap.add_argument('--salida', default=os.path.join(RAIZ, 'estudio_negocio.json'))
    args = ap.parse_args()

    desde = datetime.now(timezone.utc) - timedelta(days=args.meses * 30)
    db = conectar()

    print('Leyendo ventas...')
    lineas = leer_lineas(db, desde)
    tickets = leer_tickets(db, desde)
    dias = len({l['fecha'].strftime('%Y-%m-%d') for l in lineas})
    print(f'  {len(lineas)} renglones · {len(tickets)} tickets · {dias} días con movimiento')

    print('Leyendo catálogo...')
    catalogo = leer_catalogo(db)
    print(f'  {len(catalogo)} productos activos')

    filas = por_producto(lineas, catalogo, dias)
    datos = {
        'meta': {
            'meses': args.meses, 'dias': dias, 'lineas': len(lineas),
            'tickets': len(tickets),
            'desde': min(l['fecha'] for l in lineas).strftime('%Y-%m-%d') if lineas else None,
            'hasta': max(l['fecha'] for l in lineas).strftime('%Y-%m-%d') if lineas else None,
            'generado': datetime.now().strftime('%d/%m/%Y'),
        },
        'tiempo': por_tiempo(lineas, tickets),
        'tickets': por_ticket(tickets, lineas),
        'bultos': por_bulto(lineas),
        'rubros': por_rubro(lineas, catalogo, dias),
        'stock': resumen_stock(filas, dias),
        'concentracion': concentracion(filas),
    }

    with open(args.salida, 'w', encoding='utf-8') as f:
        json.dump(datos, f, ensure_ascii=False, indent=1, default=str)

    # ── Resumen ──
    t = datos['tickets']
    print(f"\nTicket · promedio {plata(t['promedio'])} · mediana {plata(t['mediana'])} "
          f"· {t['items_promedio']:.1f} renglones "
          f"({t['cruzados']}/{t['cantidad']} cruzados con sus renglones)")
    print(f"  grandes (≥{plata(TICKET_GRANDE)}): {t['grandes']['cantidad']} tickets, "
          f"{plata(t['grandes']['importe'])} "
          f"({t['grandes']['importe'] / t['total']:.0%} de la facturación)")

    b = datos['bultos']
    print(f"Bultos (≥{BULTO} u) · {b['lineas']} renglones · {plata(b['importe'])} "
          f"({b['parte']:.0%} de la facturación)")

    s = datos['stock']
    print(f"\nStock · {s['con_stock']} productos · capital {plata(s['capital'])}")
    print(f"  dormidos sin vender: {s['dormidos']['cantidad']} productos, "
          f"{plata(s['dormidos']['capital'])} ({s['dormidos']['parte_capital']:.0%} del capital)")
    print(f"  se acaban en menos de 30 días: {len(s['por_acabarse'])}")

    c = datos['concentracion']
    print(f"\nConcentración · vendieron {c['vendieron']} productos")
    for n, parte in c['cortes'].items():
        print(f"  top {n:<4} → {parte:.0%} de la facturación")

    print('\nRubros:')
    for r in datos['rubros']['rubros'][:8]:
        print(f"  {r['rubro'][:18]:<18} {plata(r['importe']):>12} ({r['parte']:.0%}) · "
              f"{r['productos']} productos · {r['con_stock']} con stock")

    print(f'\nGuardado en {args.salida}')


if __name__ == '__main__':
    main()
