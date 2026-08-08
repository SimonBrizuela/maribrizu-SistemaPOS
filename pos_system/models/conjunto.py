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
