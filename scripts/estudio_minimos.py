"""
Cuanto hay que vender de cada cosa para que el pedido deje plata.

    python scripts/estudio_minimos.py
    python scripts/estudio_minimos.py --preparar 2500 --objetivo 1200

La tienda hereda los precios del mostrador, y en el mostrador atender una venta
cuesta cero: la persona ya esta ahi. Un pedido online no: hay que leerlo,
recorrer el local juntando las cosas, embalarlo, avisar y despachar. Ese costo
es el mismo para un pedido de $600 que para uno de $60.000.

Vender una cartulina de $600 por internet no es un negocio chico: es un negocio
al reves. Este script calcula, producto por producto, cuantas unidades hacen
falta para que el renglon pague su parte del trabajo, y de ahi salen las reglas.

El costo de un pedido tiene dos partes, y confundirlas lleva a reglas absurdas:

  · Un costo FIJO por pedido — leerlo, embalarlo, avisar, despachar. Es el
    mismo para un renglon que para diez. Se cubre con un MINIMO DE PEDIDO.
  · Un costo por RENGLON — buscar esa cosa entre dos mil cuatrocientas,
    contarla, cortarla. Se cubre con un minimo POR PRODUCTO.

Cargarle a cada renglon la mitad del costo fijo (el primer intento de este
script) daba "para comprar boligrafos Bic hay que llevar el rollo de 50". Con
los dos costos separados da "de a uno esta bien, el pedido tiene que llegar a
$6.500", que es lo mismo en plata y se puede vender.

Tres parametros, los tres discutibles y por eso a la vista:

  --preparar   lo que cuesta preparar UN pedido, sin contar el envio (que se
               cobra aparte). Tiempo de la persona, bolsa, cinta, el ida y
               vuelta del WhatsApp. Por defecto $2.000.
  --objetivo   lo que se quiere ganar limpio en un pedido, ademas de cubrir el
               costo de prepararlo. Por defecto $1.500.
  --renglon    lo que cuesta agregar un renglon mas: buscarlo, contarlo,
               cortarlo. Por defecto $400, unos dos minutos.

No escribe nada: imprime las reglas y, con --salida, las deja en un JSON.
"""
import argparse
import json
import math
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from estudio_negocio import (CORDOBA, clave_producto, conectar, es_servicio,  # noqa: E402
                             leer_lineas, normalizar)
from datetime import datetime, timedelta, timezone  # noqa: E402

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Cuantos renglones trae un pedido. Sale del propio local: 2,1 de promedio en el
# mostrador. Se usa para repartir el costo de preparar entre los renglones.
RENGLONES_POR_PEDIDO = 2

# Los escalones de venta que existen de verdad en una libreria. Un minimo de 7
# no se lo cree nadie; de a 6 o por docena, si.
ESCALONES = [1, 2, 3, 5, 6, 10, 12, 25, 50, 100]


def plata(n):
    return f'${n:,.0f}'.replace(',', '.')


def leer_catalogo(db):
    productos = []
    for d in db.collection('catalogo').stream():
        x = d.to_dict() or {}
        if x.get('estado') == 'baja' or x.get('duplicado') is True:
            continue

        def numero(clave):
            try:
                return float(x.get(clave) or 0)
            except (TypeError, ValueError):
                return 0.0

        nombre = str(x.get('nombre') or '')
        rubro = str(x.get('rubro') or '').strip().upper()
        if es_servicio(nombre, rubro):
            continue

        contenido = int(numero('conjunto_contenido'))
        tipo = str(x.get('conjunto_tipo') or '').strip().lower()
        hay_pack = (x.get('es_conjunto') is True and contenido > 1
                    and tipo in ('rollo', 'caja', 'pack', 'bolsa', 'bobina', 'carton'))

        if x.get('es_conjunto') is True:
            precio = numero('conjunto_precio_unidad') or numero('precio_venta')
            costo = numero('costo') / contenido if contenido > 1 else numero('costo')
            stock = numero('conjunto_total') or numero('stock')
            unidad = ('metro' if str(x.get('conjunto_unidad_medida') or '').strip().lower()
                      == 'metros' else 'unidad')
        else:
            precio, costo, stock, unidad = (numero('precio_venta'), numero('costo'),
                                            numero('stock'), 'unidad')

        if precio <= 0 or costo <= 0 or stock <= 0:
            continue

        productos.append({
            'doc_id': d.id,
            'clave': clave_producto(nombre),
            'nombre': nombre,
            # Lo que ya haya puesto el panel, para no reescribir lo mismo ni
            # pisar una decision tomada a mano.
            'tienda_minimo': numero('tienda_minimo') or None,
            'tienda_paso': numero('tienda_paso') or None,
            'rubro': rubro or '(sin rubro)',
            'unidad': unidad,
            'precio': precio,
            'costo': costo,
            'ganancia': precio - costo,
            'stock': stock,
            'pack_contenido': contenido if hay_pack else None,
            'pack_precio': numero('precio_venta') if hay_pack else None,
            'pack_costo': numero('costo') if hay_pack else None,
            'pack_tipo': tipo if hay_pack else None,
        })
    return productos


def escalon(n):
    """Redondea un minimo crudo al escalon de venta mas cercano hacia arriba."""
    for e in ESCALONES:
        if n <= e:
            return e
    return int(math.ceil(n / 50.0) * 50)


def regla_de(p, objetivo_renglon):
    """
    Cuanto hay que llevar de este producto para que el renglon valga la pena.

    Tres salidas posibles, en orden de preferencia:

      suelto  — una unidad ya paga su parte. Es el caso comodo.
      minimo  — hace falta llevar N. Se redondea a un escalon creible.
      pack    — el producto ya viene en rollo o caja y conviene ofrecer eso
                entero en vez de inventar un minimo: el cliente entiende
                "el rollo de 25" mucho mejor que "minimo 23 metros".
    """
    if p['ganancia'] <= 0:
        return {'tipo': 'revisar', 'minimo': None,
                'motivo': 'el precio no cubre el costo'}

    crudo = objetivo_renglon / p['ganancia']

    if crudo <= 1:
        return {'tipo': 'suelto', 'minimo': 1, 'crudo': crudo}

    # El pack solo se impone cuando el minimo necesario ya es casi el pack
    # entero: ahi obligar a llevar 40 de 50 y dejar 10 sueltos no tiene sentido,
    # y "el rollo de 50" se entiende mejor que "minimo 40". Si el minimo es
    # mucho menor, el pack queda como opcion y no como condicion.
    if p['pack_contenido'] and p['pack_precio'] and p['pack_costo']:
        if crudo >= p['pack_contenido'] * 0.6:
            return {'tipo': 'pack', 'minimo': p['pack_contenido'], 'crudo': crudo,
                    'ganancia_pack': p['pack_precio'] - p['pack_costo']}

    minimo = escalon(crudo)
    # Un minimo mas grande que el stock no es un minimo: es no vender.
    if minimo > p['stock']:
        return {'tipo': 'no_vender', 'minimo': minimo, 'crudo': crudo,
                'motivo': f'harian falta {minimo} y hay {p["stock"]:.0f}'}
    return {'tipo': 'minimo', 'minimo': minimo, 'crudo': crudo}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--preparar', type=float, default=2000,
                    help='lo que cuesta preparar un pedido (default 2000)')
    ap.add_argument('--objetivo', type=float, default=1500,
                    help='ganancia limpia buscada por pedido (default 1500)')
    ap.add_argument('--renglon', type=float, default=400,
                    help='lo que cuesta buscar y contar un renglón (default 400)')
    ap.add_argument('--meses', type=int, default=4)
    ap.add_argument('--salida', default='')
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

    db = conectar()
    print('Leyendo catálogo...')
    productos = leer_catalogo(db)
    print(f'  {len(productos)} productos con precio, costo y stock')

    print('Leyendo ventas...')
    desde = datetime.now(timezone.utc) - timedelta(days=args.meses * 30)
    lineas = leer_lineas(db, desde)
    vendidos = defaultdict(float)
    for l in lineas:
        if not l['servicio']:
            vendidos[l['clave']] += l['cantidad']
    for p in productos:
        p['vendidos'] = vendidos.get(p['clave'], 0)

    # ── La cuenta del pedido ──────────────────────────────────────────────
    costo_pedido = args.preparar
    objetivo = args.objetivo
    # El renglón solo tiene que pagar SU trabajo. El costo fijo del pedido lo
    # cubre el mínimo de pedido, no cada producto por separado.
    objetivo_renglon = args.renglon

    margenes = sorted(p['ganancia'] / p['precio'] for p in productos)
    margen_medio = margenes[len(margenes) // 2]

    print(f'\n{"─" * 70}')
    print('LA CUENTA DE UN PEDIDO')
    print(f'{"─" * 70}')
    print(f'  Preparar un pedido cuesta          {plata(costo_pedido)}')
    print(f'  Se quiere ganar limpio             {plata(objetivo)}')
    print(f'  De cada peso vendido queda          {margen_medio:.0%}  (mediana del catálogo)')
    minimo_pedido = (costo_pedido + objetivo) / margen_medio
    print(f'  → el pedido tiene que ser de       {plata(minimo_pedido)} para arriba')
    print(f'  → cada renglón tiene que dejar     {plata(objetivo_renglon)} '
          f'(lo que cuesta buscarlo y contarlo)')

    print(f'\n  Debajo de {plata(costo_pedido / margen_medio)} el pedido pierde plata: '
          'lo que deja no paga el trabajo de armarlo.')

    # ── Cuanto deja cada producto por unidad ──────────────────────────────
    tramos = [(0, 200), (200, 500), (500, 1000), (1000, 2500), (2500, 10 ** 9)]
    print(f'\n{"─" * 70}')
    print('CUÁNTO DEJA UNA UNIDAD')
    print(f'{"─" * 70}')
    for piso, techo in tramos:
        dentro = [p for p in productos if piso <= p['ganancia'] < techo]
        rot = [p for p in dentro if p['vendidos'] > 0]
        etiqueta = (f'{plata(piso)} a {plata(techo)}' if techo < 10 ** 8
                    else f'más de {plata(piso)}')
        print(f'  {etiqueta:<22} {len(dentro):>5} productos '
              f'({len(dentro)/len(productos):>4.0%})  ·  {len(rot)} con venta')

    # ── Las reglas ────────────────────────────────────────────────────────
    for p in productos:
        p['regla'] = regla_de(p, objetivo_renglon)

    grupos = defaultdict(list)
    for p in productos:
        grupos[p['regla']['tipo']].append(p)

    print(f'\n{"─" * 70}')
    print(f'LA REGLA DE CADA PRODUCTO  (renglón tiene que dejar {plata(objetivo_renglon)})')
    print(f'{"─" * 70}')
    nombres = {
        'suelto': 'Se puede vender de a uno',
        'pack': 'Se vende el pack entero (rollo, caja)',
        'minimo': 'Necesita un mínimo de unidades',
        'no_vender': 'No da ni vendiendo todo el stock',
        'revisar': 'El precio no cubre el costo — revisar',
    }
    for tipo, texto in nombres.items():
        lista = grupos.get(tipo, [])
        conVenta = [p for p in lista if p['vendidos'] > 0]
        print(f'  {texto:<40} {len(lista):>5} ({len(lista)/len(productos):>4.0%})'
              f'  ·  {len(conVenta)} con venta')

    # ── Los que mas se venden, con su regla ───────────────────────────────
    print(f'\n{"─" * 70}')
    print('LOS 25 QUE MÁS SE VENDEN, CON SU REGLA')
    print(f'{"─" * 70}')
    print(f'  {"producto":<40}{"precio":>9}{"deja":>9}  regla')
    for p in sorted(productos, key=lambda x: -x['vendidos'])[:25]:
        r = p['regla']
        if r['tipo'] == 'suelto':
            regla = 'de a uno'
        elif r['tipo'] == 'pack':
            regla = f"solo el {r.get('pack_tipo') or 'pack'} de {r['minimo']:.0f}"
        elif r['tipo'] == 'minimo':
            unidad = 'm' if p['unidad'] == 'metro' else 'u'
            regla = f"mínimo {r['minimo']}{unidad}  ({plata(r['minimo'] * p['precio'])})"
        else:
            regla = r.get('motivo', r['tipo'])
        print(f"  {p['nombre'][:39]:<40}{plata(p['precio']):>9}{plata(p['ganancia']):>9}  {regla}")

    # ── Minimos por rubro ─────────────────────────────────────────────────
    print(f'\n{"─" * 70}')
    print('POR RUBRO: cuántos necesitan mínimo')
    print(f'{"─" * 70}')
    por_rubro = defaultdict(lambda: defaultdict(int))
    for p in productos:
        por_rubro[p['rubro']][p['regla']['tipo']] += 1
    for rubro, cuenta in sorted(por_rubro.items(), key=lambda x: -sum(x[1].values()))[:10]:
        total = sum(cuenta.values())
        sueltos = cuenta.get('suelto', 0)
        print(f"  {rubro[:16]:<16} {total:>5} productos · {sueltos:>4} de a uno "
              f"({sueltos/total:>4.0%}) · {cuenta.get('minimo',0)} con mínimo · "
              f"{cuenta.get('pack',0)} por pack")

    if args.salida:
        with open(args.salida, 'w', encoding='utf-8') as f:
            json.dump({
                'parametros': {'preparar': costo_pedido, 'objetivo': objetivo,
                               'objetivo_renglon': objetivo_renglon,
                               'margen_medio': margen_medio,
                               'minimo_pedido': minimo_pedido},
                'productos': productos,
            }, f, ensure_ascii=False, default=str)
        print(f'\nGuardado en {args.salida}')


if __name__ == '__main__':
    main()
