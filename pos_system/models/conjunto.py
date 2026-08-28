"""
Las cuentas de un producto conjunto, en un solo lugar.

Un conjunto se guarda en dos numeros que se suman y nunca se pisan:

    total = unidades × contenido + restante

`unidades` son los packs CERRADOS y `restante` son las unidades sueltas. Cuando
se abre un pack para vender suelto, ese pack baja de `unidades` y su contenido
pasa a `restante`: por eso los dos se suman sin descontar nada.

Este modulo existe porque esa cuenta estaba escrita a mano en nueve lugares del
POS y del panel, y no todos la hacian igual. Dos se desviaban:

  · Al revertir una venta se hacia `unidades = cerrados + 1` cuando quedaba
    resto, que agrega un pack cerrado inexistente. Con 35 sueltas y cajas de 60
    el producto pasaba a figurar con 95.
  · Al recalcular el total de un producto con variedades se usaba siempre el
    `conjunto_contenido` del producto, aunque la variedad tuviera el suyo. Un
    producto con azules por 50 y violetas por 12 quedaba mal en las dos.
"""

EPS = 1e-9

# ── Como se llama cada presentacion y cada unidad ─────────────────────────
#
# Viven aca, en un modulo sin Qt, porque no las usa solo el dialogo de venta:
# el POS escribe el nombre del renglon con estas etiquetas ("PAPEL A4 · 1
# pack(s)", "CINTA · 2,5 m") y el panel las vuelve a leer para saber cuanto
# stock devolver cuando se borra una venta (`webapp/src/stock_revert.js`, que
# tiene su copia). Si una etiqueta cambia de un lado y no del otro, borrar la
# venta NO devuelve el stock de ese producto y solo queda un aviso en consola.
#
# `tienda/pruebas/stock_revert.test.js` compara las dos tablas.

TIPOS = {
    'rollo':     {'label': 'Rollo',     'unidad_default': 'm',  'vende_por': ['fraccion', 'conjunto']},
    'pack':      {'label': 'Pack',      'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
    'caja':      {'label': 'Caja',      'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
    'bobina':    {'label': 'Bobina',    'unidad_default': 'm',  'vende_por': ['fraccion', 'conjunto']},
    'bolsa':     {'label': 'Bolsa',     'unidad_default': 'kg', 'vende_por': ['fraccion', 'conjunto']},
    'plancha':   {'label': 'Plancha',   'unidad_default': 'm2', 'vende_por': ['fraccion', 'conjunto']},
    'cartulina': {'label': 'Cartulina', 'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
    'papel':     {'label': 'Papel',     'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
    'carton':    {'label': 'Cartón',    'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
    'goma_eva':  {'label': 'Goma Eva',  'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
    'cinta':     {'label': 'Cinta',     'unidad_default': 'm',  'vende_por': ['fraccion', 'conjunto']},
    'tela':      {'label': 'Tela',      'unidad_default': 'm',  'vende_por': ['fraccion', 'conjunto']},
    'unidad':    {'label': 'Unidad',    'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
    'otro':      {'label': 'Otro',      'unidad_default': 'u',  'vende_por': ['unidad', 'conjunto']},
}

UNIDADES = {
    'm':   {'label': 'metros',      'short': 'm',  'base': 'longitud', 'factor': 1.0},
    'cm':  {'label': 'centímetros', 'short': 'cm', 'base': 'longitud', 'factor': 0.01},
    'u':   {'label': 'unidades',    'short': 'u',  'base': 'cuenta',   'factor': 1.0},
    'g':   {'label': 'gramos',      'short': 'g',  'base': 'masa',     'factor': 0.001},
    'kg':  {'label': 'kilogramos',  'short': 'kg', 'base': 'masa',     'factor': 1.0},
    'l':   {'label': 'litros',      'short': 'L',  'base': 'volumen',  'factor': 1.0},
    'ml':  {'label': 'mililitros',  'short': 'mL', 'base': 'volumen',  'factor': 0.001},
    'm2':  {'label': 'metro²',      'short': 'm²', 'base': 'area',     'factor': 1.0},
}

# La webapp guarda nombres largos ('metros', 'unidades'); aca se normalizan al
# short. Gemelo de UNIDAD_WEBAPP en `webapp/src/stock_revert.js`.
WEBAPP_UNIDAD = {
    'metros':      'm',
    'centimetros': 'cm',
    'cm':          'cm',
    'unidades':    'u',
    'gramos':      'g',
    'kilos':       'kg',
    'kg':          'kg',
    'litros':      'l',
    'l':           'l',
    'm2':          'm2',
}


def _num(x, por_defecto=0.0):
    try:
        return float(x if x not in (None, '') else por_defecto)
    except (TypeError, ValueError):
        return por_defecto


def contenido_de(variedad, contenido_producto):
    """
    Cuantas unidades trae el pack de esta variedad.

    Una variedad puede venir en otra presentacion que el resto del producto
    (los boligrafos azules por caja de 50 y los violetas por caja de 12). Si
    tiene el suyo se usa ese; si no, el del producto.
    """
    propio = _num((variedad or {}).get('contenido'))
    if propio > 0:
        return propio
    return _num(contenido_producto)


def total_variedad(variedad, contenido_producto):
    """Unidades sueltas totales de una variedad: cerrados × contenido + sueltos."""
    v = variedad or {}
    return _num(v.get('unidades')) * contenido_de(v, contenido_producto) + _num(v.get('restante'))


def total_conjunto(colores, contenido_producto):
    """Lo mismo, sumado sobre todas las variedades."""
    return sum(total_variedad(c, contenido_producto)
               for c in (colores or []) if isinstance(c, dict))


def repartir_total(total, contenido):
    """
    Parte un total en (packs cerrados, sueltos), que es la inversa exacta de
    `total_variedad`: repartir_total(t, c) devuelve (u, r) tal que u × c + r == t.

    Sin contenido no hay packs posibles y todo queda como suelto.
    """
    t = max(0.0, _num(total))
    c = _num(contenido)
    if c <= 0:
        return 0.0, t
    cerrados = int(t // c)
    resto = t - cerrados * c
    if resto < EPS:
        return float(cerrados), 0.0
    return float(cerrados), resto


def descontar_de_total(total, delta, contenido):
    """
    Saca `delta` unidades sueltas de un conjunto y vuelve a partir lo que queda
    en (cerrados, sueltos). Si los sueltos no alcanzan, se abre un pack solo.
    `delta` negativo devuelve mercaderia. Nunca baja de cero.

    Devuelve (total, unidades, restante).
    """
    nuevo = max(0.0, _num(total) - _num(delta))
    u, r = repartir_total(nuevo, contenido)
    return nuevo, u, r


def packs_a_guardar(packs_vistos, sueltos):
    """
    Packs cerrados a guardar a partir de lo que carga el personal.

    En el estante se cuentan los packs que se ven, incluido el abierto, y aparte
    los sueltos: "3 packs y 36 sueltos" son 2 cerrados mas uno abierto con 36.
    Con sueltos, uno de los packs vistos es el abierto y no se cuenta entero.
    El panel hace la misma traduccion en `webapp/src/conjunto.js`.
    """
    p = max(0.0, _num(packs_vistos))
    return max(0.0, p - 1) if _num(sueltos) > 0 else p


def packs_a_mostrar(cerrados, sueltos):
    """Inversa de `packs_a_guardar`: los cerrados mas el abierto, si hay sueltos."""
    c = max(0.0, _num(cerrados))
    return c + 1 if _num(sueltos) > 0 else c
