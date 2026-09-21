"""
Los productos que se compran en dolares, pasados a pesos.

Hay mercaderia que el proveedor cobra en dolares (importado, accesorios de
plata, algun juguete). Cargar el precio en pesos a mano significa que cada
salto del dolar deja el precio viejo hasta que alguien se acuerda de tocarlo
producto por producto. La alternativa es guardar el precio EN DOLARES y pasarlo
a pesos con la cotizacion del momento, cada vez que se vende.

Como se guarda un producto en dolares
-------------------------------------
En el documento de `catalogo`, ademas de lo de siempre:

    moneda_costo: 'USD'     el producto se maneja en dolares. Cualquier otra
                            cosa (o nada) = pesos, y aca no pasa nada.
    costo_usd:    12.5      lo que cuesta el pack/la unidad, en dolares
    precio_usd:   43.75     lo que se vende, en dolares (costo x margen)
    conjunto_precio_unidad_usd
                            lo que sale UNA unidad, en dolares
    conjunto_colores[].costo_usd / .precio_pack_usd / .precio_usd
                            lo mismo por variedad

`costo`, `precio_venta`, `conjunto_precio_unidad` y los precios de cada
variedad SIGUEN escritos en pesos. Son el ultimo precio calculado, y es lo que
usa todo lo que no sabe de dolares: el balance, los reportes, el Centro de
Compras, y el propio POS cuando se queda sin cotizacion. Un producto en dolares
nunca se queda sin precio: en el peor caso vende al ultimo que se calculo.

Por que esta escrito dos veces
------------------------------
Gemelo de `webapp/src/precio_usd.js`. El panel muestra el precio en pesos
mientras se edita la ficha, el POS lo calcula al vender y el sync de la tienda
lo publica: si las dos cuentas no dan EXACTAMENTE lo mismo, el cliente ve un
precio en la vidriera, el cajero cobra otro y nadie entiende por que.
`tienda/pruebas/precio_usd.test.js` las compara con los casos de
`scripts/casos_precio_usd.py`.

No importa Qt, ni Firestore, ni nada: lo usan el POS, el sync de la tienda y
las pruebas.
"""
import math

# Nombre del campo que marca un producto en dolares, y su unico valor valido.
MONEDA_USD = 'USD'


def _redondear(n, decimales):
    """floor(x + 0.5) al decimal pedido, la unica forma de redondear que
    Python y JavaScript escriben igual.

    round() de Python redondea al par (round(2.675, 2) -> 2.67) y el
    Math.round() de JavaScript sube siempre (2.68). Sobre un precio son dos
    centavos; sobre el mismo precio calculado en los dos lados es un numero
    que baila solo y no se puede explicar.
    """
    factor = 10 ** decimales
    return math.floor(n * factor + 0.5) / factor


def _numero(v, por_defecto=0.0):
    """Lo que venga (texto, None, numero) leido como float."""
    if v is None or v is False or v == '':
        return por_defecto
    try:
        n = float(v)
    except (TypeError, ValueError):
        return por_defecto
    if n != n or n in (float('inf'), float('-inf')):   # NaN / infinito
        return por_defecto
    return n


def redondear_centena(v):
    """A la centena mas cercana, con caida a decena si el monto es chico.

    Copia exacta de `redondear_centena` en scripts/sync_tienda.py y de
    `redondearCentena` en webapp/src/tienda_descuentos_regla.js — la misma
    regla que el boton +-100 del editor de productos. Es como se manejan los
    precios del local: un dolar que deja $14.437 desentona al lado del resto.

    floor(x + 0.5) y no round(): es la unica forma de redondear que Python y
    JavaScript escriben igual (round() de Python redondea al par, 250 -> 200).
    """
    n = _numero(v)
    if n <= 0:
        return 0
    r100 = math.floor(n / 100 + 0.5) * 100
    if r100 > 0:
        return r100
    r10 = math.floor(n / 10 + 0.5) * 10
    return r10 if r10 > 0 else math.floor(n + 0.5)


def es_usd(producto):
    """True si este producto lleva los precios en dolares."""
    if not isinstance(producto, dict):
        return False
    return str(producto.get('moneda_costo') or '').strip().upper() == MONEDA_USD


def cotizacion_valida(cotizacion):
    """La cotizacion sirve solo si es un numero positivo y creible.

    El tope de 1.000.000 no es paranoia: una respuesta rota de la API que
    devuelva el valor en centavos, o un cero mal leido al cargarla a mano,
    multiplicaria todos los precios del local de una. Ante la duda, no se
    convierte nada y se vende con el ultimo precio en pesos.
    """
    n = _numero(cotizacion)
    return 0 < n < 1_000_000


def precio_en_pesos(monto_usd, cotizacion):
    """Un precio de venta en dolares, en pesos y redondeado como el local.

    Devuelve 0 cuando no hay con que calcular: el que llama decide con que
    precio se queda (siempre el ultimo en pesos, nunca cero).
    """
    usd = _numero(monto_usd)
    if usd <= 0 or not cotizacion_valida(cotizacion):
        return 0
    return redondear_centena(usd * _numero(cotizacion))


def costo_en_pesos(monto_usd, cotizacion):
    """Un costo en dolares, en pesos.

    El costo NO se redondea a la centena: no es un precio de mostrador, es lo
    que se paga. Redondearlo ensuciaria el margen y el Centro de Compras.
    """
    usd = _numero(monto_usd)
    if usd <= 0 or not cotizacion_valida(cotizacion):
        return 0
    return _redondear(usd * _numero(cotizacion), 2)


def precio_unidad_en_pesos(monto_usd, cotizacion):
    """El precio de UNA unidad fraccionada (un metro, un boligrafo) en pesos.

    Sin redondeo a la centena: un metro de cinta a $150 pasaria a $200, un 33%
    mas. El precio unitario se maneja con dos decimales, igual que cuando se
    deriva del precio del pack.
    """
    usd = _numero(monto_usd)
    if usd <= 0 or not cotizacion_valida(cotizacion):
        return 0
    return _redondear(usd * _numero(cotizacion), 2)


def precio_desde_costo(costo_usd, margen_pct):
    """El precio de venta en dolares que sale de un costo y un margen.

    Se guarda calculado (`precio_usd`) para que pasar a pesos sea una sola
    multiplicacion y no dependa de que el margen siga estando.
    """
    costo = _numero(costo_usd)
    if costo <= 0:
        return 0
    return _redondear(costo * (1 + _numero(margen_pct) / 100.0), 4)


def convertir_variedad(variedad, cotizacion):
    """Una variedad con sus precios del dia, si tiene precios en dolares.

    Devuelve una copia. Los campos en dolares se dejan tal cual: el que los
    lea despues tiene que poder recalcular.
    """
    if not isinstance(variedad, dict):
        return variedad
    copia = dict(variedad)
    if not cotizacion_valida(cotizacion):
        return copia

    costo_usd = _numero(copia.get('costo_usd'))
    if costo_usd > 0:
        copia['costo'] = costo_en_pesos(costo_usd, cotizacion)

    pack_usd = _numero(copia.get('precio_pack_usd'))
    if pack_usd > 0:
        copia['precio_pack'] = precio_en_pesos(pack_usd, cotizacion)

    unit_usd = _numero(copia.get('precio_usd'))
    if unit_usd > 0:
        copia['precio'] = precio_unidad_en_pesos(unit_usd, cotizacion)

    return copia


def convertir_producto(producto, cotizacion):
    """El producto con los precios en pesos de hoy.

    Devuelve una copia con `price`/`precio_venta`, `cost`/`costo`,
    `conjunto_precio_unidad` y cada variedad recalculados con la cotizacion.
    Si el producto no es en dolares, o la cotizacion no sirve, devuelve una
    copia sin tocar: el ultimo precio en pesos es siempre un precio valido.

    Acepta tanto el documento del catalogo (`precio_venta`, `costo`) como la
    fila de SQLite del POS (`price`, `cost`), y escribe las dos formas cuando
    ya estaban, para que cualquiera de los dos lados lo lea igual.
    """
    if not isinstance(producto, dict):
        return producto
    copia = dict(producto)
    if not es_usd(producto) or not cotizacion_valida(cotizacion):
        return copia

    precio_usd = _numero(copia.get('precio_usd'))
    if precio_usd > 0:
        pesos = precio_en_pesos(precio_usd, cotizacion)
        if pesos > 0:
            if 'price' in copia:
                copia['price'] = pesos
            if 'precio_venta' in copia or 'price' not in copia:
                copia['precio_venta'] = pesos

    costo_usd = _numero(copia.get('costo_usd'))
    if costo_usd > 0:
        pesos_costo = costo_en_pesos(costo_usd, cotizacion)
        if pesos_costo > 0:
            if 'cost' in copia:
                copia['cost'] = pesos_costo
            if 'costo' in copia or 'cost' not in copia:
                copia['costo'] = pesos_costo

    unidad_usd = _numero(copia.get('conjunto_precio_unidad_usd'))
    if unidad_usd > 0:
        pesos_unidad = precio_unidad_en_pesos(unidad_usd, cotizacion)
        if pesos_unidad > 0:
            copia['conjunto_precio_unidad'] = pesos_unidad

    colores = copia.get('conjunto_colores')
    if isinstance(colores, list) and colores:
        copia['conjunto_colores'] = [
            convertir_variedad(c, cotizacion) if isinstance(c, dict) else c
            for c in colores
        ]

    return copia


def tiene_precios_usd(producto):
    """True si el producto trae algun precio en dolares para convertir.

    Un producto marcado en dolares pero sin ningun `*_usd` cargado todavia no
    tiene nada que recalcular: se vende con lo que diga en pesos.
    """
    if not es_usd(producto):
        return False
    if _numero(producto.get('precio_usd')) > 0:
        return True
    if _numero(producto.get('costo_usd')) > 0:
        return True
    if _numero(producto.get('conjunto_precio_unidad_usd')) > 0:
        return True
    colores = producto.get('conjunto_colores')
    if isinstance(colores, list):
        for c in colores:
            if not isinstance(c, dict):
                continue
            if (_numero(c.get('precio_usd')) > 0
                    or _numero(c.get('precio_pack_usd')) > 0
                    or _numero(c.get('costo_usd')) > 0):
                return True
    return False
