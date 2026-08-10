"""
Que conviene vender en cada canal: Mercado Libre, la tienda del barrio y la
venta mayorista a otras librerias.

    python scripts/estudio_canales.py
    python scripts/estudio_canales.py --meses 4 --salida datos.json

Es la version ampliada de `estudio_ml.py`. Aquella contestaba una sola pregunta
—que subir a Mercado Libre— y esta contesta tres, porque los tres canales cobran
distinto y por eso el producto que sirve en uno no sirve en el otro:

  · Mercado Libre se lleva una comision y un costo fijo en pesos por unidad. El
    costo fijo es lo que mata al producto barato, asi que ahi solo entra ticket
    alto o bulto cerrado.
  · La tienda del barrio no cobra comision. El limite no es la rentabilidad sino
    la logistica: que se pueda fotografiar, embalar y repartir en moto.
  · El mayorista a otras librerias no cobra nada, pero hay que resignar parte
    del margen. El limite es cuanto descuento aguanta cada producto.

Escribe un JSON con todo calculado para que `armar_presupuesto_xlsx.py` lo
convierta en planillas y graficos sin volver a tocar Firestore.
"""
import argparse
import json
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
# Contrastadas en agosto de 2026 contra fuentes publicas independientes: los
# tres tramos de costo fijo y el umbral de $33.000 coinciden. La comision
# publicada va de 11,8% a 15% en clasica y de 14,8% a 17,14% en premium, y los
# valores de abajo caen adentro de ese rango. Igual hay que confirmarlos contra
# el simulador oficial al abrir la cuenta: las paginas de ayuda de ML devuelven
# 403 al acceso automatico y la API de precios pide sesion de vendedor.

IVA = 0.21

COMISION = {
    'clasica': {'JUGUETERIA': 0.13, 'LIBRERIA': 0.14, 'PAPELERA': 0.14,
                'MERCERIA': 0.13, 'REGALERIA': 0.14, 'PERFUMERIA': 0.15,
                'ACCESORIOS': 0.13, 'LENCERIA': 0.13, '_': 0.14},
    'premium': {'JUGUETERIA': 0.17, 'LIBRERIA': 0.18, 'PAPELERA': 0.18,
                'MERCERIA': 0.17, 'REGALERIA': 0.18, 'PERFUMERIA': 0.19,
                'ACCESORIOS': 0.17, 'LENCERIA': 0.17, '_': 0.18},
}

COSTO_FIJO = [
    (15_000, 1_115),
    (25_000, 2_300),
    (33_000, 2_810),
]
SIN_COSTO_FIJO_DESDE = 33_000
ENVIO_GRATIS_DESDE = 33_000

# Lo que sale despachar un paquete chico por cross-docking, que es el metodo
# que le toca a un vendedor nuevo. Las referencias publicas de 2026 lo ubican
# en $1.800 para CABA y $2.800 para el interior sobre un paquete de 200 gramos.
# Se toma el interior porque desde Cordoba la mayoria de los envios cruzan
# provincia. El estudio anterior usaba $5.000 y era demasiado castigo.
COSTO_ENVIO_ESTIMADO = 2_800
ESCENARIOS_ENVIO = [
    (1_800, 'Paquete chico, destino CABA'),
    (2_800, 'Paquete chico, interior del pais'),
    (5_000, 'Paquete mediano o mal despachado'),
]

# ── Reglas de corte ─────────────────────────────────────────────────────────
# Cuanto se puede recargar sobre el precio de mostrador antes de dejar de ser
# competitivo. Arriba de esto el producto esta en ML pero no se vende.
SOBREPRECIO_MAX = 0.45
# Con una unidad sola, la venta que entra mientras alguien la compra en el local
# obliga a cancelar, y una cancelacion cuesta mas reputacion de lo que valia.
STOCK_MIN_ML = 2
# Rubros que no se despachan: se hacen o se prueban en el local.
RUBROS_NO_DESPACHABLES = {'SERVICIOS', 'SELLOS', 'TELGOPOR', 'CARCASA DE SELLOS',
                          'ALMOHADILLAS', 'GOMAS PARA SELLOS', 'TINTAS',
                          'NUMERADORES', 'FECHADORES VARIOS', 'FECHADORES MANUALES',
                          'AUTOMATICOS SHINY', 'AUTOMATICOS CON FECHA', 'MADERA'}

# Descuentos mayoristas a evaluar sobre el precio de mostrador.
DESCUENTOS_MAYORISTA = [0.20, 0.25, 0.30, 0.35]
# Piso de ganancia sobre el costo para que una venta mayorista valga la pena.
MARKUP_MINIMO_MAYORISTA = 0.25

# Lo que Mercado Libre Argentina mas vende y mas busca en librerias, segun los
# informes publicos de mercado de 2026. Se cruza contra el catalogo para ver
# cuanto de esa demanda el local ya tiene en gondola.
DEMANDA_ML = [
    ('Sets de marcadores', ['marcador', 'resaltador', 'fibra', 'fibron'],
     'Casi la mitad del top diez de librería en ML. Se vende en set, no suelto.'),
    ('Resmas y papel', ['resma', 'papel obra', 'papel ilustracion', 'cartulina',
                        'papel misionero', 'papel craft', 'papel madera'],
     'El más vendido del nicho Comercial y Oficina, el de mayor facturación.'),
    ('Calculadoras', ['calculadora'],
     'Alto crecimiento sostenido y más del 55% de las ventas por catálogo.'),
    ('Cuadernos y agendas', ['cuaderno', 'agenda', 'anotador', 'block'],
     'Demanda todo el año con pico en marzo.'),
    ('Carpetas y archivo', ['carpeta', 'bibliorato', 'folio', 'archivo'],
     '"Carpetas metálicas" es de los términos más buscados del rubro.'),
    ('Pizarras y encuadernación', ['pizarra', 'anillado', 'espiral', 'encuaderna'],
     'Nicho de oficina con ticket alto, que es justo lo que ML premia.'),
    ('Mochilas y escolar', ['mochila', 'cartuchera'],
     'Ticket promedio de $16.000 en escolares, arriba del piso de rentabilidad.'),
]


# ── Cuentas de Mercado Libre ────────────────────────────────────────────────

def costo_fijo_de(precio):
    if precio >= SIN_COSTO_FIJO_DESDE:
        return 0
    for tope, monto in COSTO_FIJO:
        if precio < tope:
            return monto
    return 0


def normalizar_rubro(rubro):
    return ''.join(c for c in unicodedata.normalize('NFD', str(rubro or '').upper())
                   if unicodedata.category(c) != 'Mn').strip()


def comision_de(rubro, tipo):
    tabla = COMISION[tipo]
    return tabla.get(normalizar_rubro(rubro), tabla['_'])


def descuenta_ml(precio, rubro, tipo, envio=None):
    """Lo que se lleva ML de una venta a ese precio. Devuelve (total, detalle)."""
    if envio is None:
        envio = COSTO_ENVIO_ESTIMADO
    comision = precio * comision_de(rubro, tipo)
    fijo = costo_fijo_de(precio)
    costo_envio = envio if precio >= ENVIO_GRATIS_DESDE else 0
    iva = (comision + fijo) * IVA
    return comision + fijo + iva + costo_envio, {
        'comision': comision, 'fijo': fijo, 'iva': iva, 'envio': costo_envio,
    }


def precio_para_ganar(objetivo, costo, rubro, tipo, envio=None):
    """
    A que precio hay que publicarlo para que queden `objetivo` pesos de ganancia.

    El costo fijo depende del precio y el precio depende del costo fijo, asi que
    no se despeja de una: se prueba tramo por tramo y se acepta el primero cuyo
    resultado caiga adentro del tramo con el que se calculo. Sin esa
    verificacion salen precios que dicen pagar un costo fijo que no les toca.
    """
    if envio is None:
        envio = COSTO_ENVIO_ESTIMADO
    c = comision_de(rubro, tipo)
    denominador = 1 - c * (1 + IVA)
    if denominador <= 0:
        return None

    tramos = [(t, m) for t, m in COSTO_FIJO] + [(float('inf'), 0)]
    piso_anterior = 0
    for tope, fijo in tramos:
        costo_envio = envio if piso_anterior >= ENVIO_GRATIS_DESDE else 0
        precio = (costo + objetivo + fijo * (1 + IVA) + costo_envio) / denominador
        if piso_anterior <= precio < tope:
            return precio
        piso_anterior = tope
    return None


def piso_absoluto(tipo='clasica'):
    """Abajo de este precio ML se lleva mas de lo que entra, con producto gratis."""
    c = COMISION[tipo]['_']
    return COSTO_FIJO[0][1] * (1 + IVA) / (1 - c * (1 + IVA))


# ── Lectura ─────────────────────────────────────────────────────────────────

def normalizar(t):
    s = unicodedata.normalize('NFD', str(t or '').lower())
    return ' '.join(''.join(c for c in s if unicodedata.category(c) != 'Mn').split())


def clave_producto(nombre):
    """
    El nombre de venta, limpio, para cruzarlo contra el catalogo.

    El renglon de venta no guarda el codigo del producto: guarda el nombre con
    lo que se eligio al vender pegado adelante y atras.

        [Celeste]  CARTULINA LUMA COMUN  ·  1 u
        PAPEL OBRA A4 75 GR PAMPA  ·  10 pack(s)

    Cruzando por el nombre crudo, el 38% de la facturacion no encontraba su
    producto — y no era cualquier 38%: eran justo los que tienen variedad o se
    venden por pack. Con la rotacion en cero, este estudio los descartaba de
    todos los canales por "sin rotacion en el periodo".
    """
    limpio = str(nombre or '')
    if limpio.lstrip().startswith('['):
        cierre = limpio.find(']')
        if cierre != -1:
            limpio = limpio[cierre + 1:]
    return normalizar(limpio.split('·')[0])


def conectar():
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(
            credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))
    return firestore.client()


def leer_ventas(db, meses):
    """Unidades e importe por producto y el ticket de cada venta."""
    desde = datetime.now(timezone.utc) - timedelta(days=meses * 30)
    unidades = defaultdict(float)
    importe = defaultdict(float)
    dias = set()
    lineas = 0

    for d in db.collection('ventas_por_dia').where('fecha_dt', '>=', desde).stream():
        x = d.to_dict() or {}
        if x.get('deleted') is True:
            continue
        clave = clave_producto(x.get('producto') or x.get('product_name'))
        if not clave:
            continue
        unidades[clave] += float(x.get('cantidad') or 0)
        importe[clave] += float(x.get('subtotal') or 0)
        lineas += 1
        if x.get('fecha'):
            dias.add(str(x['fecha']))

    tickets = []
    for d in db.collection('ventas').where('created_at', '>=', desde).stream():
        x = d.to_dict() or {}
        if x.get('deleted') is True:
            continue
        total = float(x.get('total_amount') or 0)
        if total > 0:
            tickets.append(total)

    return unidades, importe, len(dias), tickets, lineas


def leer_catalogo(db):
    """
    El catalogo activo con los precios de UNA unidad.

    Un producto fraccionado guarda dos precios: `precio_venta` es el rollo o la
    caja entera y `conjunto_precio_unidad` es lo que sale un metro o un
    boligrafo. Tomar el primero para todo es el error que ya habia pasado en la
    tienda, y sobre un estudio de rentabilidad no se ve: se disfraza de producto
    estrella con margen enorme.

    A diferencia de `estudio_ml.py`, aca no se descarta nada. Los productos sin
    costo o sin stock entran igual con una marca, porque el informe necesita
    contar cuantos quedan afuera y por que.
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
        tipo_conj = str(x.get('conjunto_tipo') or '').strip().lower()
        hay_pack = (es_conjunto and contenido > 1
                    and tipo_conj in ('rollo', 'caja', 'pack', 'bolsa', 'bobina', 'carton'))

        if es_conjunto:
            precio = numero('conjunto_precio_unidad') or precio_entero
            costo = (costo_entero / contenido) if contenido > 1 else costo_entero
            stock = numero('conjunto_total') or numero('stock')
            unidad = ('metro' if str(x.get('conjunto_unidad_medida') or '').strip().lower() == 'metros'
                      else 'unidad')
        else:
            precio, costo, stock, unidad = precio_entero, costo_entero, numero('stock'), 'unidad'

        productos.append({
            'codigo': x.get('codigo') or d.id,
            'nombre': x.get('nombre') or '',
            'rubro': normalizar_rubro(x.get('rubro')) or '(sin rubro)',
            'categoria': (x.get('categoria') or '').strip(),
            'marca': (x.get('marca') or '').strip(),
            'proveedor': (x.get('proveedor') or '').strip() or 'SIN PROVEEDOR',
            'unidad': unidad,
            'costo': costo,
            'precio': precio,
            'stock': max(0.0, stock),
            'tiene_foto': bool(x.get('tienda_imagenes')),
            'pack_contenido': contenido if hay_pack else None,
            'pack_precio': precio_entero if hay_pack else None,
            'pack_costo': costo_entero if hay_pack else None,
            'pack_tipo': tipo_conj if hay_pack else None,
        })
    return productos


# ── Analisis comun ──────────────────────────────────────────────────────────

def enriquecer(productos, unidades, importe, meses, tipo='clasica'):
    """Le agrega a cada producto la rotacion y las cuentas de los tres canales."""
    piso = piso_absoluto(tipo)
    filas = []

    for p in productos:
        clave = clave_producto(p['nombre'])
        vendidas = unidades.get(clave, 0)
        f = dict(p)
        f['unidades'] = vendidas
        f['facturado'] = importe.get(clave, 0)
        f['por_mes'] = vendidas / meses if meses else 0
        f['ganancia_local'] = p['precio'] - p['costo']
        f['markup'] = (p['precio'] / p['costo'] - 1) if p['costo'] > 0 else None
        f['margen_pct'] = ((p['precio'] - p['costo']) / p['precio']) if p['precio'] > 0 else None

        # ── Mercado Libre ────────────────────────────────────────────────
        f['ml_motivo'] = motivo_ml(f, piso)
        f['ml_apto'] = f['ml_motivo'] is None

        if p['costo'] > 0 and p['precio'] > p['costo']:
            quita, detalle = descuenta_ml(p['precio'], p['rubro'], tipo)
            f['ml_quita_pct'] = quita / p['precio']
            f['ml_ganancia_mismo_precio'] = p['precio'] - quita - p['costo']
            precio_igual = precio_para_ganar(f['ganancia_local'], p['costo'], p['rubro'], tipo)
            f['ml_precio'] = precio_igual
            f['ml_sobreprecio'] = (precio_igual / p['precio'] - 1) if precio_igual else None
            f['ml_gana_mes'] = f['ganancia_local'] * f['por_mes']
        else:
            f['ml_quita_pct'] = None
            f['ml_ganancia_mismo_precio'] = None
            f['ml_precio'] = None
            f['ml_sobreprecio'] = None
            f['ml_gana_mes'] = 0

        # El bulto que el local ya compra armado. En ML es mejor candidato que
        # la unidad suelta: paga un costo fijo en vez de uno por unidad.
        f['pack'] = None
        if p['pack_contenido'] and p['pack_costo'] > 0 and p['pack_precio'] > p['pack_costo']:
            ganancia_pack = p['pack_precio'] - p['pack_costo']
            precio_pack = precio_para_ganar(ganancia_pack, p['pack_costo'], p['rubro'], tipo)
            if precio_pack:
                quita_pack, _ = descuenta_ml(precio_pack, p['rubro'], tipo)
                f['pack'] = {
                    'contenido': p['pack_contenido'],
                    'tipo': p['pack_tipo'],
                    'precio_local': p['pack_precio'],
                    'ganancia': ganancia_pack,
                    'precio_ml': precio_pack,
                    'sobreprecio': precio_pack / p['pack_precio'] - 1,
                    'quita_pct': quita_pack / precio_pack,
                    'por_mes': (vendidas / meses / p['pack_contenido']) if meses else 0,
                }

        # ── Mayorista ────────────────────────────────────────────────────
        f['mayorista'] = {}
        for d in DESCUENTOS_MAYORISTA:
            if p['costo'] <= 0:
                f['mayorista'][d] = None
                continue
            precio_may = p['precio'] * (1 - d)
            ganancia = precio_may - p['costo']
            markup = (precio_may / p['costo'] - 1)
            f['mayorista'][d] = {
                'precio': precio_may,
                'ganancia': ganancia,
                'markup': markup,
                'viable': ganancia > 0 and markup >= MARKUP_MINIMO_MAYORISTA,
            }

        filas.append(f)
    return filas


def motivo_ml(f, piso):
    """
    Por que este producto no va a Mercado Libre, o None si va.

    El orden importa: cada producto se cuenta una sola vez, en el primer motivo
    que lo saca. Asi los motivos suman el total del catalogo y el embudo cierra.
    """
    if f['rubro'] in RUBROS_NO_DESPACHABLES:
        return 'No se despacha'
    if f['costo'] <= 0:
        return 'Sin costo cargado'
    if f['precio'] <= f['costo']:
        return 'Sin margen en el local'
    if f['stock'] <= 0:
        return 'Sin stock'
    if f['precio'] < piso:
        return 'Abajo del piso de ML'
    if f['unidades'] <= 0:
        return 'No se vendió en el período'
    if f['stock'] < STOCK_MIN_ML:
        return 'Stock de una sola unidad'
    sobre = None
    if f['costo'] > 0 and f['precio'] > f['costo']:
        precio_igual = precio_para_ganar(f['precio'] - f['costo'], f['costo'], f['rubro'], 'clasica')
        sobre = (precio_igual / f['precio'] - 1) if precio_igual else None
    if sobre is None or sobre > SOBREPRECIO_MAX:
        return 'Necesita más de 45% de sobreprecio'
    return None


# ── Armado del informe ──────────────────────────────────────────────────────

def bloque_ml(filas, meses, tipo='clasica'):
    piso = piso_absoluto(tipo)
    con_stock = [f for f in filas if f['stock'] > 0]
    aptos = [f for f in filas if f['ml_apto']]
    aptos.sort(key=lambda f: -(f['ml_gana_mes'] or 0))

    # Lo que ML se lleva a cada precio.
    quita = []
    for p in (1_000, 2_000, 3_500, 6_000, 10_000, 18_000, 28_000, 32_900, 35_000, 60_000):
        q, d = descuenta_ml(p, 'LIBRERIA', tipo)
        quita.append({'precio': p, 'comision': d['comision'], 'fijo': d['fijo'],
                      'iva': d['iva'], 'envio': d['envio'], 'total': q,
                      'pct': q / p, 'queda': p - q})

    # Embudo: de todo el catalogo activo a la lista final, con la baja en cada paso.
    orden = ['No se despacha', 'Sin costo cargado', 'Sin margen en el local', 'Sin stock',
             'Abajo del piso de ML', 'No se vendió en el período',
             'Stock de una sola unidad', 'Necesita más de 45% de sobreprecio']
    motivos = defaultdict(int)
    for f in filas:
        if f['ml_motivo']:
            motivos[f['ml_motivo']] += 1

    embudo = []
    quedan = len(filas)
    embudo.append({'paso': 'Catálogo activo', 'saca': 0, 'quedan': quedan})
    for m in orden:
        quedan -= motivos[m]
        embudo.append({'paso': m, 'saca': motivos[m], 'quedan': quedan})

    # Bandas de precio: cuantos hay y que porcentaje pasa el filtro.
    cortes = [(0, 3_000, 'Menos de $3.000'), (3_000, 5_000, 'De $3.000 a $5.000'),
              (5_000, 10_000, 'De $5.000 a $10.000'), (10_000, 20_000, 'De $10.000 a $20.000'),
              (20_000, 33_000, 'De $20.000 a $33.000'),
              (33_000, float('inf'), 'Más de $33.000')]
    bandas = []
    for lo, hi, nombre in cortes:
        dentro = [f for f in con_stock if lo <= f['precio'] < hi]
        ok = [f for f in dentro if f['ml_apto']]
        bandas.append({'banda': nombre, 'cuantos': len(dentro), 'aptos': len(ok),
                       'pct': (len(ok) / len(dentro)) if dentro else 0})

    # Por rubro: donde esta la parte publicable del catalogo.
    por_rubro = defaultdict(lambda: {'cuantos': 0, 'aptos': 0, 'gana_mes': 0.0})
    for f in con_stock:
        r = por_rubro[f['rubro']]
        r['cuantos'] += 1
        if f['ml_apto']:
            r['aptos'] += 1
            r['gana_mes'] += f['ml_gana_mes'] or 0
    rubros = [{'rubro': k, **v, 'pct': (v['aptos'] / v['cuantos']) if v['cuantos'] else 0}
              for k, v in por_rubro.items() if v['cuantos'] >= 20]
    rubros.sort(key=lambda r: -r['aptos'])

    # Pareto: cuanta de la ganancia se junta en los primeros productos.
    top = aptos[:150]
    total_top = sum(f['ml_gana_mes'] or 0 for f in top) or 1
    pareto, acum = [], 0.0
    for i, f in enumerate(top, 1):
        acum += f['ml_gana_mes'] or 0
        if i in (5, 10, 20, 30, 50, 75, 100, 150) or i == len(top):
            pareto.append({'n': i, 'acumulado': acum, 'pct': acum / total_top})

    # Sensibilidad al costo de envio, que es el numero mas flojo del estudio.
    escenarios = []
    for envio, etiqueta in ESCENARIOS_ENVIO:
        vivos, gana = 0, 0.0
        for f in con_stock:
            if f['costo'] <= 0 or f['precio'] <= f['costo'] or f['unidades'] <= 0:
                continue
            pi = precio_para_ganar(f['ganancia_local'], f['costo'], f['rubro'], tipo, envio)
            if pi and (pi / f['precio'] - 1) <= SOBREPRECIO_MAX and f['stock'] >= STOCK_MIN_ML:
                vivos += 1
                gana += f['ml_gana_mes'] or 0
        escenarios.append({'envio': envio, 'etiqueta': etiqueta,
                           'aptos': vivos, 'gana_mes': gana})

    # El escalon de los $33.000, ahora con el envio corregido.
    q32, _ = descuenta_ml(32_900, 'LIBRERIA', tipo)
    neto32 = 32_900 - q32
    com35 = 35_000 * comision_de('LIBRERIA', tipo)
    neto35_sin_envio = 35_000 - com35 * (1 + IVA)
    escalon = {
        'neto_32900': neto32,
        'neto_35000_sin_envio': neto35_sin_envio,
        'envio_indiferente': neto35_sin_envio - neto32,
        'envio_estimado': COSTO_ENVIO_ESTIMADO,
        'conviene': (neto35_sin_envio - COSTO_ENVIO_ESTIMADO) > neto32,
        'diferencia': (neto35_sin_envio - COSTO_ENVIO_ESTIMADO) - neto32,
    }

    # Los bultos que el local ya compra armados.
    packs = [f for f in filas
             if f['pack'] and f['stock'] > 0 and f['unidades'] > 0
             and f['pack']['sobreprecio'] <= SOBREPRECIO_MAX]
    packs.sort(key=lambda f: -(f['pack']['ganancia'] * f['pack']['por_mes']))

    # Packs a armar a mano, para el candidato que no viene en caja.
    armados = []
    for f in aptos:
        if f['pack'] or f['precio'] >= 15_000:
            continue
        n = max(2, min(24, round(20_000 / max(f['precio'], 1)) or 2))
        objetivo = f['ganancia_local'] * n
        precio_pack = precio_para_ganar(objetivo, f['costo'] * n, f['rubro'], tipo)
        if not precio_pack:
            continue
        qp, _ = descuenta_ml(precio_pack, f['rubro'], tipo)
        armados.append({'nombre': f['nombre'], 'precio': f['precio'],
                        'quita_suelto': f['ml_quita_pct'], 'n': n,
                        'precio_pack': precio_pack, 'quita_pack': qp / precio_pack,
                        'ganancia': objetivo})
        if len(armados) >= 12:
            break

    # Cruce con lo que ML mas vende en libreria.
    demanda = []
    for nombre, claves, nota in DEMANDA_ML:
        tiene, aptos_d, gana = 0, 0, 0.0
        for f in con_stock:
            n = normalizar(f['nombre'])
            if any(k in n for k in claves):
                tiene += 1
                if f['ml_apto']:
                    aptos_d += 1
                    gana += f['ml_gana_mes'] or 0
        demanda.append({'nicho': nombre, 'en_catalogo': tiene, 'aptos': aptos_d,
                        'gana_mes': gana, 'nota': nota})

    return {
        'piso': piso,
        'total_activos': len(filas),
        'con_stock': len(con_stock),
        'aptos': len(aptos),
        'quita': quita,
        'embudo': embudo,
        'bandas': bandas,
        'rubros': rubros,
        'pareto': pareto,
        'escenarios': escenarios,
        'escalon': escalon,
        'si': [{'nombre': f['nombre'], 'rubro': f['rubro'], 'precio': f['precio'],
                'ml_precio': f['ml_precio'], 'sobreprecio': f['ml_sobreprecio'],
                'ganancia': f['ganancia_local'], 'por_mes': f['por_mes'],
                'gana_mes': f['ml_gana_mes'], 'stock': f['stock']}
               for f in aptos[:60]],
        'gana_mes_top20': sum(f['ml_gana_mes'] or 0 for f in aptos[:20]),
        'gana_mes_top150': sum(f['ml_gana_mes'] or 0 for f in aptos[:150]),
        'no': [{'motivo': m, 'cuantos': motivos[m]} for m in orden],
        'packs': [{'nombre': f['nombre'], 'precio': f['precio'], 'unidad': f['unidad'],
                   'quita_suelto': f['ml_quita_pct'], 'tipo': f['pack']['tipo'],
                   'contenido': f['pack']['contenido'], 'precio_ml': f['pack']['precio_ml'],
                   'quita_pack': f['pack']['quita_pct'], 'ganancia': f['pack']['ganancia']}
                  for f in packs[:15]],
        'armados': armados,
        'demanda': demanda,
    }


def bloque_tienda(filas, meses, tickets, tramos):
    """
    La tienda del barrio no cobra comision, asi que el filtro es otro: no es
    "cuanto queda" sino "se puede fotografiar, embalar y repartir".
    """
    publicables = [f for f in filas
                   if f['stock'] > 0 and f['rubro'] not in RUBROS_NO_DESPACHABLES
                   and f['precio'] > 0]
    con_foto = [f for f in publicables if f['tiene_foto']]

    # Que rubros mueven la caja. Es el orden en que tiene que salir el menu.
    por_rubro = defaultdict(lambda: {'facturado': 0.0, 'unidades': 0.0,
                                     'publicables': 0, 'con_foto': 0})
    for f in filas:
        r = por_rubro[f['rubro']]
        r['facturado'] += f['facturado']
        r['unidades'] += f['unidades']
        if f['stock'] > 0 and f['rubro'] not in RUBROS_NO_DESPACHABLES:
            r['publicables'] += 1
            if f['tiene_foto']:
                r['con_foto'] += 1
    total_fact = sum(r['facturado'] for r in por_rubro.values()) or 1
    rubros = [{'rubro': k, **v, 'part': v['facturado'] / total_fact,
               'cobertura': (v['con_foto'] / v['publicables']) if v['publicables'] else 0}
              for k, v in por_rubro.items() if v['facturado'] > 0 or v['publicables'] >= 20]
    rubros.sort(key=lambda r: -r['facturado'])

    # El ticket real del local, que es lo que va a llegar por la tienda.
    tickets = sorted(tickets)
    n = len(tickets)
    def pct(q):
        return tickets[min(n - 1, int(n * q))] if n else 0
    ticket = {
        'cantidad': n,
        'promedio': (sum(tickets) / n) if n else 0,
        'mediana': pct(0.50),
        'p25': pct(0.25),
        'p75': pct(0.75),
        'p90': pct(0.90),
    }
    # Distribucion por tramo, para decidir el minimo de pedido.
    cortes = [(0, 3_000), (3_000, 6_000), (6_000, 10_000), (10_000, 20_000),
              (20_000, 40_000), (40_000, float('inf'))]
    etiquetas = ['Menos de $3.000', 'De $3.000 a $6.000', 'De $6.000 a $10.000',
                 'De $10.000 a $20.000', 'De $20.000 a $40.000', 'Más de $40.000']
    dist = []
    for (lo, hi), et in zip(cortes, etiquetas):
        c = sum(1 for t in tickets if lo <= t < hi)
        dist.append({'tramo': et, 'cuantos': c, 'pct': (c / n) if n else 0})

    # Cuanto tiene que gastar el cliente para que el reparto no se coma la venta.
    # Se toma el margen medio del catalogo publicable, ponderado por lo que rota.
    peso = sum(f['facturado'] for f in publicables if f['margen_pct'] is not None) or 1
    margen_medio = sum((f['margen_pct'] or 0) * f['facturado']
                       for f in publicables if f['margen_pct'] is not None) / peso
    envio_caro = max(t['precio'] for t in tramos) if tramos else 0
    minimos = []
    for t in tramos:
        # El piso donde la ganancia del pedido paga el reparto dos veces: una
        # para cubrirlo y otra para que la venta valga la pena.
        piso = (2 * t['precio'] / margen_medio) if margen_medio else 0
        minimos.append({'hasta_km': t['hasta_km'], 'precio': t['precio'], 'piso': piso})

    # Que destacar en la portada: lo que mas rota, con stock y con foto.
    destacados = sorted([f for f in con_foto if f['unidades'] > 0],
                        key=lambda f: -f['unidades'])[:30]

    # Lo que hoy queda afuera de la tienda y factura igual.
    afuera = [{'rubro': r['rubro'], 'facturado': r['facturado'], 'part': r['part'],
               'publicables': r['publicables']}
              for r in rubros
              if r['rubro'] in ('ACCESORIOS', 'LENCERIA', 'NAVIDAD', 'COTILLON')]

    return {
        'publicables': len(publicables),
        'con_foto': len(con_foto),
        'cobertura': (len(con_foto) / len(publicables)) if publicables else 0,
        'sin_stock': sum(1 for f in filas if f['stock'] <= 0),
        'no_despachables': sum(1 for f in filas if f['rubro'] in RUBROS_NO_DESPACHABLES),
        'rubros': rubros,
        'ticket': ticket,
        'dist_ticket': dist,
        'margen_medio': margen_medio,
        'minimos': minimos,
        'envio_caro': envio_caro,
        'destacados': [{'nombre': f['nombre'], 'rubro': f['rubro'], 'precio': f['precio'],
                        'por_mes': f['por_mes'], 'stock': f['stock']}
                       for f in destacados],
        'afuera': afuera,
    }


def bloque_mayorista(filas, meses):
    """
    Vender a otras librerias es resignar margen a cambio de volumen. La pregunta
    no es que producto tiene mas margen sino cual aguanta el descuento y sigue
    dejando plata, y de esos cuales hay en cantidad como para abastecer a otro.
    """
    con_costo = [f for f in filas if f['costo'] > 0 and f['precio'] > f['costo']]

    # Cuantos productos aguantan cada nivel de descuento.
    niveles = []
    for d in DESCUENTOS_MAYORISTA:
        ok = [f for f in con_costo if f['mayorista'][d] and f['mayorista'][d]['viable']]
        con_stock = [f for f in ok if f['stock'] >= 6]
        niveles.append({'descuento': d, 'viables': len(ok), 'con_volumen': len(con_stock),
                        'pct': len(ok) / len(con_costo) if con_costo else 0})

    # Distribucion del markup del catalogo, que es lo que define el techo.
    cortes = [(0, 0.40), (0.40, 0.70), (0.70, 1.00), (1.00, 1.50), (1.50, float('inf'))]
    etiquetas = ['Menos de 40%', 'De 40% a 70%', 'De 70% a 100%',
                 'De 100% a 150%', 'Más de 150%']
    dist = []
    for (lo, hi), et in zip(cortes, etiquetas):
        c = sum(1 for f in con_costo if lo <= (f['markup'] or 0) < hi)
        dist.append({'tramo': et, 'cuantos': c,
                     'pct': c / len(con_costo) if con_costo else 0})

    # Los candidatos: aguantan 25% de descuento, hay cantidad y ya rotan.
    D = 0.25
    candidatos = [f for f in con_costo
                  if f['mayorista'][D] and f['mayorista'][D]['viable']
                  and f['stock'] >= 6 and f['unidades'] > 0
                  and f['rubro'] not in RUBROS_NO_DESPACHABLES]
    candidatos.sort(key=lambda f: -(f['mayorista'][D]['ganancia'] * f['stock']))

    # Los que ya vienen en caja o rollo: es la unidad natural del mayorista.
    # Solo entran si hay al menos un bulto entero: media caja no se vende.
    bultos = [f for f in candidatos
              if f['pack_contenido'] and f['stock'] >= f['pack_contenido']]
    bultos.sort(key=lambda f: -(f['pack_precio'] or 0) * (1 - D))

    # Por proveedor: donde esta concentrado el catalogo que aguanta descuento.
    por_prov = defaultdict(lambda: {'cuantos': 0, 'viables': 0, 'stock': 0.0})
    for f in con_costo:
        p = por_prov[f['proveedor']]
        p['cuantos'] += 1
        if f['mayorista'][D] and f['mayorista'][D]['viable'] and f['stock'] >= 6:
            p['viables'] += 1
            p['stock'] += f['stock']
    provs = [{'proveedor': k, **v, 'pct': v['viables'] / v['cuantos'] if v['cuantos'] else 0}
             for k, v in por_prov.items() if v['cuantos'] >= 25]
    provs.sort(key=lambda p: -p['viables'])

    # Por rubro, para saber con que arrancar la lista mayorista. Los rubros que
    # no se despachan no cuentan: un sello a pedido no se revende por bulto.
    por_rubro = defaultdict(lambda: {'cuantos': 0, 'viables': 0})
    for f in con_costo:
        if f['rubro'] in RUBROS_NO_DESPACHABLES:
            continue
        r = por_rubro[f['rubro']]
        r['cuantos'] += 1
        if f['mayorista'][D] and f['mayorista'][D]['viable'] and f['stock'] >= 6:
            r['viables'] += 1
    rubros = [{'rubro': k, **v, 'pct': v['viables'] / v['cuantos'] if v['cuantos'] else 0}
              for k, v in por_rubro.items() if v['cuantos'] >= 20]
    rubros.sort(key=lambda r: -r['viables'])

    def fila(f, d):
        m = f['mayorista'][d]
        return {'nombre': f['nombre'], 'rubro': f['rubro'], 'precio': f['precio'],
                'costo': f['costo'], 'markup': f['markup'], 'stock': f['stock'],
                'precio_may': m['precio'], 'ganancia': m['ganancia'],
                'markup_may': m['markup'], 'por_mes': f['por_mes'],
                'pack_tipo': f['pack_tipo'], 'pack_contenido': f['pack_contenido'],
                'pack_precio': f['pack_precio']}

    # Lo que NO va al mayorista y por que.
    fino = sum(1 for f in con_costo if (f['markup'] or 0) < 0.40)
    poco = sum(1 for f in con_costo if f['stock'] < 6)
    sin_rot = sum(1 for f in con_costo if f['unidades'] <= 0)

    return {
        'con_costo': len(con_costo),
        'niveles': niveles,
        'dist_markup': dist,
        'candidatos': [fila(f, D) for f in candidatos[:60]],
        'bultos': [fila(f, D) for f in bultos[:20]],
        'proveedores': provs[:12],
        'rubros': rubros,
        'descuento_base': D,
        'no': [{'motivo': 'Margen fino: menos de 40% sobre el costo', 'cuantos': fino},
               {'motivo': 'Menos de 6 unidades: no alcanza para abastecer a otro', 'cuantos': poco},
               {'motivo': 'Sin rotación en el período', 'cuantos': sin_rot}],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--meses', type=int, default=4)
    ap.add_argument('--tipo', choices=['clasica', 'premium'], default='clasica')
    ap.add_argument('--salida', default=os.path.join(RAIZ, 'estudio_canales.json'))
    args = ap.parse_args()

    db = conectar()
    print('Leyendo ventas...')
    unidades, importe, dias, tickets, lineas = leer_ventas(db, args.meses)
    print(f'  {lineas} líneas de venta en {dias} días · {len(tickets)} tickets')
    print('Leyendo catálogo...')
    productos = leer_catalogo(db)
    print(f'  {len(productos)} productos activos')

    filas = enriquecer(productos, unidades, importe, args.meses, args.tipo)

    tramos = [{'hasta_km': 3, 'precio': 1500}, {'hasta_km': 6, 'precio': 2500},
              {'hasta_km': 12, 'precio': 3500}]

    datos = {
        'meta': {
            'meses': args.meses, 'dias_con_venta': dias, 'tipo': args.tipo,
            'lineas_venta': lineas, 'tickets': len(tickets),
            'generado': datetime.now().strftime('%d/%m/%Y'),
            'envio_estimado': COSTO_ENVIO_ESTIMADO,
            'sobreprecio_max': SOBREPRECIO_MAX,
        },
        'ml': bloque_ml(filas, args.meses, args.tipo),
        'tienda': bloque_tienda(filas, args.meses, tickets, tramos),
        'mayorista': bloque_mayorista(filas, args.meses),
    }

    with open(args.salida, 'w', encoding='utf-8') as f:
        json.dump(datos, f, ensure_ascii=False, indent=1, default=float)

    m = datos['ml']
    print(f"\nML  · piso ${m['piso']:,.0f} · {m['aptos']} aptos de {m['con_stock']} con stock"
          .replace(',', '.'))
    print(f"     top 20 = ${m['gana_mes_top20']:,.0f}/mes · top 150 = ${m['gana_mes_top150']:,.0f}/mes"
          .replace(',', '.'))
    t = datos['tienda']
    print(f"Tienda · {t['publicables']} publicables · {t['con_foto']} con foto "
          f"({t['cobertura']:.0%}) · ticket ${t['ticket']['promedio']:,.0f}".replace(',', '.'))
    y = datos['mayorista']
    print(f"Mayorista · {y['niveles'][1]['viables']} aguantan -25% · "
          f"{y['niveles'][1]['con_volumen']} con volumen")
    print(f'\nGuardado en {args.salida}')


if __name__ == '__main__':
    main()
