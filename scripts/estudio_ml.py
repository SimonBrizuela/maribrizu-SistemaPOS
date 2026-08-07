"""
Que conviene publicar en Mercado Libre y cuanto queda despues de que ML cobra.

    python scripts/estudio_ml.py
    python scripts/estudio_ml.py --meses 4 --tipo clasica

Cruza el catalogo con las ventas reales y calcula, producto por producto, lo que
queda en el bolsillo despues de la comision, el costo fijo y el IVA. La pregunta
que responde no es "cuanto sale" sino "a que precio hay que publicarlo para
ganar lo mismo que en el mostrador, y si ese precio es vendible".

Sobre los numeros de ML
───────────────────────
La API de precios de ML (`sites/MLA/listing_prices`) devuelve 403 sin una cuenta
de vendedor, y las paginas de ayuda tambien bloquean el acceso automatico. Asi
que las tarifas de abajo estan cargadas a mano desde fuentes publicas de 2026 y
hay que confirmarlas contra el simulador oficial en cuanto la cuenta este
abierta. Estan todas juntas y con nombre para que actualizarlas sea cambiar tres
numeros y volver a correr esto.

Lo que ML cobra por cada venta son tres cosas que se suman:

  1. Comision, un porcentaje del precio que depende del rubro y del tipo de
     publicacion. Clasica es mas barata; premium se ve mas y cobra unos cuatro
     puntos mas.
  2. Costo fijo por unidad, solo en ventas de menos de $33.000. No es un
     porcentaje: son pesos por unidad vendida, y es lo que hace inviable el
     producto barato.
  3. IVA del 21% sobre la suma de los dos anteriores.

Y desde $33.000 el envio gratis pasa a ser obligatorio y lo paga el vendedor, lo
que abre un pozo justo arriba de ese numero.
"""
import argparse
import os
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import firebase_admin
from firebase_admin import credentials, firestore

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── Tarifas de Mercado Libre Argentina ──────────────────────────────────────
# Revisar contra el simulador oficial al abrir la cuenta. Fuentes publicas,
# agosto de 2026.

IVA = 0.21

# Comision por rubro y tipo de publicacion. Los rubros del local no coinciden
# con las categorias de ML, asi que se mapean a la categoria mas parecida y
# queda un valor por defecto para lo que no encaje.
COMISION = {
    'clasica': {'JUGUETERIA': 0.13, 'LIBRERIA': 0.14, 'PAPELERA': 0.14,
                'MERCERIA': 0.13, 'REGALERIA': 0.14, 'PERFUMERIA': 0.15,
                'ACCESORIOS': 0.13, 'LENCERIA': 0.13, '_': 0.14},
    'premium': {'JUGUETERIA': 0.17, 'LIBRERIA': 0.18, 'PAPELERA': 0.18,
                'MERCERIA': 0.17, 'REGALERIA': 0.18, 'PERFUMERIA': 0.19,
                'ACCESORIOS': 0.17, 'LENCERIA': 0.17, '_': 0.18},
}

# Pesos por unidad vendida, segun el precio. Arriba del ultimo tramo no se cobra.
COSTO_FIJO = [
    (15_000, 1_115),
    (25_000, 2_300),
    (33_000, 2_810),
]
SIN_COSTO_FIJO_DESDE = 33_000

# Desde aca el envio gratis es obligatorio y lo paga el vendedor. El numero de
# abajo es lo que cuesta despacharlo, estimado para un paquete chico con la
# bonificacion de un vendedor nuevo. Es el mas flojo de todos estos valores.
ENVIO_GRATIS_DESDE = 33_000
COSTO_ENVIO_ESTIMADO = 5_000


def costo_fijo_de(precio):
    if precio >= SIN_COSTO_FIJO_DESDE:
        return 0
    for tope, monto in COSTO_FIJO:
        if precio < tope:
            return monto
    return 0


def comision_de(rubro, tipo):
    tabla = COMISION[tipo]
    return tabla.get(normalizar_rubro(rubro), tabla['_'])


def normalizar_rubro(rubro):
    return ''.join(c for c in unicodedata.normalize('NFD', str(rubro or '').upper())
                   if unicodedata.category(c) != 'Mn').strip()


def descuenta_ml(precio, rubro, tipo):
    """Lo que se lleva ML de una venta a ese precio. Devuelve (total, detalle)."""
    comision = precio * comision_de(rubro, tipo)
    fijo = costo_fijo_de(precio)
    envio = COSTO_ENVIO_ESTIMADO if precio >= ENVIO_GRATIS_DESDE else 0
    iva = (comision + fijo) * IVA
    return comision + fijo + iva + envio, {
        'comision': comision, 'fijo': fijo, 'iva': iva, 'envio': envio,
    }


def precio_para_ganar(objetivo, costo, rubro, tipo):
    """
    A que precio hay que publicarlo para que queden `objetivo` pesos de ganancia.

    El costo fijo depende del precio y el precio depende del costo fijo, asi que
    no se despeja de una: se prueba tramo por tramo y se acepta el primero cuyo
    resultado caiga adentro del tramo con el que se calculo. Sin esa
    verificacion salen precios que dicen pagar un costo fijo que no les
    corresponde.
    """
    c = comision_de(rubro, tipo)
    denominador = 1 - c * (1 + IVA)
    if denominador <= 0:
        return None

    tramos = [(t, m) for t, m in COSTO_FIJO] + [(float('inf'), 0)]
    piso_anterior = 0
    for tope, fijo in tramos:
        envio = COSTO_ENVIO_ESTIMADO if piso_anterior >= ENVIO_GRATIS_DESDE else 0
        precio = (costo + objetivo + fijo * (1 + IVA) + envio) / denominador
        if piso_anterior <= precio < tope:
            return precio
        piso_anterior = tope
    return None


def normalizar(t):
    s = unicodedata.normalize('NFD', str(t or '').lower())
    return ' '.join(''.join(c for c in s if unicodedata.category(c) != 'Mn').split())


def conectar():
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(
            credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))
    return firestore.client()


def leer_ventas(db, meses):
    """Unidades e importe por producto, por nombre normalizado."""
    desde = datetime.now(timezone.utc) - timedelta(days=meses * 30)
    unidades = defaultdict(float)
    importe = defaultdict(float)
    dias = set()

    for d in db.collection('ventas_por_dia').where('fecha_dt', '>=', desde).stream():
        x = d.to_dict() or {}
        if x.get('deleted') is True:
            continue
        clave = normalizar(x.get('producto') or x.get('product_name'))
        if not clave:
            continue
        unidades[clave] += float(x.get('cantidad') or 0)
        importe[clave] += float(x.get('subtotal') or 0)
        if x.get('fecha'):
            dias.add(str(x['fecha']))

    return unidades, importe, len(dias)


def leer_catalogo(db):
    """
    El catalogo, con los precios de UNA unidad.

    Un producto fraccionado guarda dos precios: `precio_venta` es el rollo o la
    caja entera y `conjunto_precio_unidad` es lo que sale un metro o un
    boligrafo. Tomar el primero para todo es el error que ya habia pasado en la
    tienda: un metro de media perla figuraba a $23.800 cuando vale $1.200. Sobre
    un estudio de rentabilidad ese error no se ve, se disfraza de producto
    estrella con margen enorme.

    El costo viene de la misma manera: es el del rollo, asi que se divide por lo
    que trae. Y el stock vendible sale de `conjunto_total`, no de `stock`, que
    cuenta packs cerrados.

    Cuando el pack existe de verdad se devuelve aparte, porque en Mercado Libre
    el rollo entero es un candidato mejor que el metro suelto: un solo costo
    fijo en vez de uno por metro.
    """
    productos = []
    for d in db.collection('catalogo').stream():
        x = d.to_dict() or {}
        if x.get('estado') == 'baja' or x.get('duplicado'):
            continue

        def numero(clave, por_defecto=0):
            try:
                return float(x.get(clave) or por_defecto)
            except (TypeError, ValueError):
                return por_defecto

        precio_entero = numero('precio_venta')
        costo_entero = numero('costo')
        contenido = int(numero('conjunto_contenido'))
        es_conjunto = x.get('es_conjunto') is True
        tipo = str(x.get('conjunto_tipo') or '').strip().lower()
        hay_pack = (es_conjunto and contenido > 1
                    and tipo in ('rollo', 'caja', 'pack', 'bolsa', 'bobina', 'carton'))

        if es_conjunto:
            precio = numero('conjunto_precio_unidad') or precio_entero
            costo = (costo_entero / contenido) if contenido > 1 else costo_entero
            stock = numero('conjunto_total') or numero('stock')
            unidad = 'metro' if str(x.get('conjunto_unidad_medida') or '').strip().lower() == 'metros' else 'unidad'
        else:
            precio, costo, stock, unidad = precio_entero, costo_entero, numero('stock'), 'unidad'

        if costo <= 0 or precio <= 0 or precio <= costo:
            continue

        productos.append({
            'codigo': x.get('codigo') or d.id,
            'nombre': x.get('nombre') or '',
            'rubro': x.get('rubro') or '',
            'marca': (x.get('marca') or '').strip(),
            'proveedor': (x.get('proveedor') or '').strip(),
            'unidad': unidad,
            'costo': costo,
            'precio': precio,
            'stock': max(0.0, stock),
            # El pack tal como ya lo vende el local, si existe.
            'pack_contenido': contenido if hay_pack else None,
            'pack_precio': precio_entero if hay_pack else None,
            'pack_costo': costo_entero if hay_pack else None,
            'pack_tipo': tipo if hay_pack else None,
        })
    return productos


def analizar(productos, unidades, importe, meses, tipo):
    filas = []
    for p in productos:
        clave = normalizar(p['nombre'])
        vendidas = unidades.get(clave, 0)
        facturado = importe.get(clave, 0)

        ganancia_local = p['precio'] - p['costo']

        # 1. Publicarlo al mismo precio que en el mostrador.
        quita, detalle = descuenta_ml(p['precio'], p['rubro'], tipo)
        neto = p['precio'] - quita
        ganancia_ml = neto - p['costo']

        # 2. El precio que haria falta para ganar lo mismo que en el local.
        precio_igual = precio_para_ganar(ganancia_local, p['costo'], p['rubro'], tipo)
        sobreprecio = (precio_igual / p['precio'] - 1) if precio_igual else None

        # 3. El precio que hace que la venta no deje perdida.
        precio_cero = precio_para_ganar(0, p['costo'], p['rubro'], tipo)

        # 4. El pack que el local ya vende. Para un producto fraccionado es el
        #    candidato real en ML: un solo costo fijo en vez de uno por metro.
        pack = None
        if p['pack_contenido']:
            ganancia_pack = p['pack_precio'] - p['pack_costo']
            precio_pack = precio_para_ganar(ganancia_pack, p['pack_costo'], p['rubro'], tipo)
            if precio_pack:
                quita_pack, _ = descuenta_ml(precio_pack, p['rubro'], tipo)
                pack = {
                    'contenido': p['pack_contenido'],
                    'tipo': p['pack_tipo'],
                    'precio_local': p['pack_precio'],
                    'ganancia': ganancia_pack,
                    'precio_ml': precio_pack,
                    'sobreprecio': precio_pack / p['pack_precio'] - 1,
                    'quita_pct': quita_pack / precio_pack,
                    # Cuantos packs por mes salen al ritmo de venta actual.
                    'por_mes': (vendidas / meses / p['pack_contenido']) if meses else 0,
                }

        filas.append({
            **p,
            'ganancia_local': ganancia_local,
            'quita_ml': quita,
            'quita_pct': quita / p['precio'],
            'ganancia_ml_mismo_precio': ganancia_ml,
            'precio_igual_ganancia': precio_igual,
            'sobreprecio': sobreprecio,
            'precio_sin_perdida': precio_cero,
            'unidades': vendidas,
            'facturado': facturado,
            'por_mes': vendidas / meses if meses else 0,
            'detalle': detalle,
            'pack': pack,
        })
    return filas


def pesos(n):
    if n is None:
        return '—'
    return f'${n:,.0f}'.replace(',', '.')


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--meses', type=int, default=4,
                    help='meses de ventas para medir rotacion (hay historia desde abril)')
    ap.add_argument('--tipo', choices=['clasica', 'premium'], default='clasica')
    ap.add_argument('--cantidad', type=int, default=40, help='cuantos candidatos listar')
    ap.add_argument('--salida', default=os.path.join(RAIZ, 'ESTUDIO_ML.md'))
    args = ap.parse_args()

    db = conectar()
    print('Leyendo ventas...')
    unidades, importe, dias = leer_ventas(db, args.meses)
    print('Leyendo catalogo...')
    productos = leer_catalogo(db)
    filas = analizar(productos, unidades, importe, args.meses, args.tipo)

    print(f'\n{len(productos)} productos con costo y precio · {len(unidades)} nombres vendidos '
          f'en {dias} dias con ventas\n')

    informe = armar_informe(filas, args, dias)
    with open(args.salida, 'w', encoding='utf-8') as f:
        f.write(informe)
    print(informe)
    print(f'\nGuardado en {args.salida}')


def armar_informe(filas, args, dias):
    tipo = args.tipo
    con_venta = [f for f in filas if f['unidades'] > 0]
    hay = [f for f in filas if f['stock'] > 0]

    # El piso absoluto: abajo de este precio, el costo fijo mas la comision se
    # comen todo el precio aunque el producto fuera gratis.
    c = COMISION[tipo]['_']
    piso = COSTO_FIJO[0][1] * (1 + IVA) / (1 - c * (1 + IVA))

    bajo_piso = [f for f in hay if f['precio'] < piso]
    pierden = [f for f in hay if f['ganancia_ml_mismo_precio'] <= 0]

    # Candidatos: rotan, hay stock, y el precio que hay que ponerle en ML no es
    # un disparate frente al del mostrador.
    candidatos = [f for f in con_venta
                  if f['stock'] > 0
                  and f['sobreprecio'] is not None
                  and f['sobreprecio'] <= 0.45
                  and f['ganancia_local'] > 0]
    candidatos.sort(key=lambda f: -(f['ganancia_local'] * f['por_mes']))
    top = candidatos[:args.cantidad]

    lineas = []
    A = lineas.append

    A('# Qué conviene vender en Mercado Libre')
    A('')
    A(f'Generado con `scripts/estudio_ml.py` · publicación **{tipo}** · '
      f'{args.meses} meses de ventas ({dias} días con movimiento).')
    A('')
    A('> Los porcentajes y el costo fijo de ML están cargados a mano en el script: '
      'la API de precios y las páginas de ayuda bloquean el acceso automático. '
      'Confirmarlos contra el simulador oficial al abrir la cuenta.')
    A('')

    # ── 1. Cómo cobra ML ──────────────────────────────────────────────────
    A('## Lo que ML se lleva')
    A('')
    A('Tres cosas que se suman: la comisión, un costo fijo **por unidad** en toda '
      'venta de menos de $33.000, y el IVA del 21% sobre las dos anteriores. El '
      'costo fijo es el que importa acá, porque no es un porcentaje: son pesos, '
      'y contra un producto barato es casi todo el precio.')
    A('')
    A('| Precio de venta | Comisión | Costo fijo | IVA | Envío | **Se lleva ML** |')
    A('|---|---|---|---|---|---|')
    for p in (2_000, 3_500, 6_000, 10_000, 18_000, 28_000, 32_900, 35_000, 60_000):
        quita, d = descuenta_ml(p, 'LIBRERÍA', tipo)
        A(f'| {pesos(p)} | {pesos(d["comision"])} | {pesos(d["fijo"])} | '
          f'{pesos(d["iva"])} | {pesos(d["envio"]) if d["envio"] else "—"} | '
          f'**{pesos(quita)} · {quita / p:.0%}** |')
    A('')
    A(f'El piso está en **{pesos(piso)}**. Abajo de ese precio ML se lleva más de lo '
      'que entra: la venta deja pérdida aunque el producto no hubiera costado nada.')
    A('')
    def miles(n):
        return f'{n:,}'.replace(',', '.')

    A(f'De los {miles(len(hay))} productos con stock, **{miles(len(bajo_piso))} '
      f'({len(bajo_piso) / len(hay):.0%}) están abajo del piso** y '
      f'**{miles(len(pierden))} ({len(pierden) / len(hay):.0%}) darían pérdida** '
      'publicados al mismo precio del mostrador. Eso no es un problema de precios: '
      'es el modelo de ML contra el ticket de una librería.')
    A('')

    # ── 2. El pozo de los $33.000 ─────────────────────────────────────────
    A('## El escalón de los $33.000')
    A('')
    q32, _ = descuenta_ml(32_900, 'LIBRERÍA', tipo)
    neto32 = 32_900 - q32
    com35 = 35_000 * comision_de('LIBRERÍA', tipo)
    neto35_sin_envio = 35_000 - com35 - com35 * IVA
    envio_indiferente = neto35_sin_envio - neto32

    A(f'A {pesos(32_900)} ML se lleva {pesos(q32)} y quedan {pesos(neto32)}. Cruzando '
      f'los {pesos(33_000)} desaparece el costo fijo, pero el envío gratis pasa a ser '
      'obligatorio y lo paga el vendedor.')
    A('')
    A(f'Las dos cosas casi se cancelan: a {pesos(35_000)} quedan '
      f'{pesos(neto35_sin_envio)} antes del envío, así que **el escalón conviene '
      f'solo si despachar sale menos de {pesos(envio_indiferente)}**. Arriba de eso, '
      f'vender a {pesos(35_000)} deja menos plata que vender a {pesos(32_900)}.')
    A('')
    A(f'Con el envío estimado en {pesos(COSTO_ENVIO_ESTIMADO)} la diferencia es de '
      f'{pesos(abs(neto35_sin_envio - COSTO_ENVIO_ESTIMADO - neto32))}, o sea nada. '
      'Es el número más flojo de todo el estudio y el único que puede dar vuelta '
      'esta conclusión: hay que medir el costo real de despacho antes de fijar '
      'precios cerca del umbral.')
    A('')

    # ── 3. Los candidatos ─────────────────────────────────────────────────
    A('## Por cuáles empezar')
    A('')
    A('Ordenados por la ganancia mensual que dejarían en ML, entre los que ya se '
      'venden en el local, tienen stock y no necesitan más de 45% de sobreprecio '
      'para dejar la misma ganancia que en el mostrador. El sobreprecio es lo que '
      'hay que sumarle al precio de la vidriera para absorber lo que cobra ML.')
    A('')
    A('| Producto | Local | Precio en ML | Sobreprecio | Gana por unidad | Vendidos/mes | **Gana por mes** |')
    A('|---|---|---|---|---|---|---|')
    for f in top:
        A(f'| {f["nombre"][:44]} | {pesos(f["precio"])} | '
          f'{pesos(f["precio_igual_ganancia"])} | {f["sobreprecio"]:+.0%} | '
          f'{pesos(f["ganancia_local"])} | {f["por_mes"]:.1f} | '
          f'**{pesos(f["ganancia_local"] * f["por_mes"])}** |')
    A('')

    if top:
        total_mes = sum(f['ganancia_local'] * f['por_mes'] for f in top)
        A(f'Los {len(top)} juntos dejarían **{pesos(total_mes)} por mes** si en ML se '
          'vendieran al mismo ritmo que en el local, que es un supuesto optimista: '
          'ahí competís con todo el país y no con las cuatro librerías del barrio.')
        A('')

    # ── 4. Los packs ──────────────────────────────────────────────────────
    A('## La palanca de verdad: vender de a varios')
    A('')
    A('El costo fijo se cobra **por unidad vendida**, no por producto. Un rollo '
      'entero paga un costo fijo; los mismos metros vendidos de a uno pagan uno '
      'por metro. Es lo único que mueve la aguja en un catálogo de precio bajo, y '
      'no depende de conseguirle mejores precios a ningún proveedor.')
    A('')

    # Los packs que el local YA vende: el rollo, la caja, la bolsa.
    con_pack = [f for f in filas
                if f['pack'] and f['stock'] > 0 and f['unidades'] > 0
                and f['pack']['sobreprecio'] <= 0.45]
    con_pack.sort(key=lambda f: -(f['pack']['ganancia'] * f['pack']['por_mes']))

    if con_pack:
        A('Estos ya vienen armados: es el rollo o la caja que el local compra y '
          'fracciona. Publicar la presentación entera es la forma más directa de '
          'esquivar el costo fijo, y no hay que armar nada.')
        A('')
        A('| Producto | Suelto | ML se lleva | Presentación | Precio en ML | ML se lleva | Gana por venta |')
        A('|---|---|---|---|---|---|---|')
        for f in con_pack[:12]:
            k = f['pack']
            A(f'| {f["nombre"][:38]} | {pesos(f["precio"])} / {f["unidad"]} | '
              f'{f["quita_pct"]:.0%} | {k["tipo"] or "pack"} x{k["contenido"]} | '
              f'{pesos(k["precio_ml"])} | {k["quita_pct"]:.0%} | '
              f'**{pesos(k["ganancia"])}** |')
        A('')

    A('Y para lo que no viene en rollo, armar el pack a mano. La cuenta es la '
      'misma: se junta ticket hasta que el costo fijo deje de pesar.')
    A('')
    A('| Producto | Suelto | ML se lleva | Pack | Precio en ML | ML se lleva | Gana por venta |')
    A('|---|---|---|---|---|---|---|')
    sueltos = [f for f in top if not f['pack']][:8]
    for f in sueltos:
        # Se arma el pack apuntando a un ticket cerca del umbral del costo fijo,
        # que es donde la quita deja de doler.
        n = max(2, min(24, round(14_000 / max(f['precio'], 1)) or 2))
        objetivo = f['ganancia_local'] * n
        precio_pack = precio_para_ganar(objetivo, f['costo'] * n, f['rubro'], tipo)
        if not precio_pack:
            continue
        quita_pack, _ = descuenta_ml(precio_pack, f['rubro'], tipo)
        A(f'| {f["nombre"][:38]} | {pesos(f["precio"])} | {f["quita_pct"]:.0%} | '
          f'x{n} | {pesos(precio_pack)} | {quita_pack / precio_pack:.0%} | '
          f'**{pesos(objetivo)}** |')
    A('')

    # ── 5. Lo que falta ───────────────────────────────────────────────────
    A('## Lo que este estudio no puede responder')
    A('')
    A('**A qué precio se vende cada cosa en ML.** Es la pregunta que decide todo y '
      'no se puede contestar desde acá: la API pública devuelve 403 sin una cuenta '
      'de vendedor. Este informe dice dónde hay margen para absorber la comisión, '
      'no dónde hay demanda a ese precio. Con la cuenta abierta, el primer trabajo '
      'es bajar el precio de los tres primeros competidores de cada candidato y '
      'volver a filtrar esta lista.')
    A('')
    A('**Cuánto cuesta realmente el envío.** Cambia por peso, volumen, provincia y '
      'reputación, y arriba de $33.000 lo paga el vendedor. Está estimado.')
    A('')
    A('**Las retenciones.** IIBB y ganancias según la condición fiscal del local. '
      'No están contempladas y se descuentan además de todo lo anterior.')
    A('')

    return '\n'.join(lineas)


if __name__ == '__main__':
    main()
