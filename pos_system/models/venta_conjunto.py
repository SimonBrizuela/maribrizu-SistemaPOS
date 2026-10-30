"""
Lo que una venta le saca a un conjunto, calculado siempre desde el stock VIVO.

Hasta el 29-10-2026 la venta de un conjunto viajaba como un número absoluto:
el diálogo calculaba "cuánto queda" (`conjunto_after_unidades/restante`) al
agregar la línea y eso se escribía tal cual al cobrar, en la PC y en la nube.
Dos cosas lo rompían:

  · Al cambiar la cantidad en el carrito, el ajuste usaba la CANTIDAD VENDIDA
    como si fuera el contenido del pack. Bajar de 2 a 1 un elástico de 25 dejó
    9,5 m convertidos en 200,92; un lápiz de 69 pasó a 4.752.
  · El número absoluto se calculaba contra la copia de la PC, que podía estar
    atrasada respecto de lo que habían vendido o cargado las otras.

Acá la venta se describe por lo que SE PIDE (packs cerrados y sueltos) y el
estado final sale de aplicar ese pedido sobre el stock que haya en el momento,
el de SQLite al cobrar y el de la nube al subir. Una venta nunca suma stock.

Sin Qt ni Firebase: lo importan el modelo de venta, el carrito y el sync.
"""
import json
from typing import Dict, List, Optional, Tuple

from pos_system.models.conjunto import (
    EPS, UNIDADES, _num, contenido_de, repartir_total, total_conjunto,
)


def convertir(cantidad, desde, hasta):
    """Pasa una cantidad entre unidades compatibles (50 cm → 0,5 m). None si no
    se puede. Misma cuenta que `convertir()` del diálogo de venta."""
    if desde == hasta:
        return cantidad
    f, t = UNIDADES.get(desde), UNIDADES.get(hasta)
    if not f or not t or f['base'] != t['base']:
        return None
    return (cantidad * f['factor']) / t['factor']


def parse_colores(raw) -> List[dict]:
    """`conjunto_colores` como lista de dicts (acepta el JSON de SQLite)."""
    if isinstance(raw, list):
        return [c for c in raw if isinstance(c, dict)]
    if isinstance(raw, str) and raw.strip():
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            return []
        if isinstance(data, list):
            return [c for c in data if isinstance(c, dict)]
    return []


def buscar_color(colores: List[dict], color: str) -> Optional[dict]:
    clave = str(color or '').strip()
    if not clave:
        return None
    return next((c for c in colores
                 if str(c.get('color', '')).strip() == clave), None)


def pedido_de_linea(item: dict, contenido: float) -> Optional[Tuple[float, float]]:
    """
    Qué se lleva una línea de carrito: (packs cerrados, sueltos en unidad base).

    Sale de `conjunto_cantidad` y el modo de venta, que es lo que eligió el
    cajero. Si la línea no los trae (un carrito guardado por una versión
    vieja) se usa `conjunto_cantidad_base` como sueltos. None si no hay con
    qué saberlo.
    """
    cantidad = _num(item.get('conjunto_cantidad'))
    vender_por = item.get('conjunto_vender_por')
    if cantidad > 0 and vender_por:
        if vender_por == 'conjunto':
            return cantidad, 0.0
        base = cantidad
        u_venta = item.get('conjunto_unidad_venta')
        u_base = item.get('conjunto_unidad_base')
        if u_venta and u_base and u_venta != u_base:
            c = convertir(cantidad, u_venta, u_base)
            if c is None:
                return None
            base = c
        return 0.0, base
    base = _num(item.get('conjunto_cantidad_base'))
    if base > 0:
        return 0.0, base
    return None


def cantidad_base_del_pedido(packs: float, sueltos: float, contenido: float) -> float:
    """El pedido entero en unidades base (los packs a su contenido)."""
    return _num(packs) * _num(contenido) + _num(sueltos)


def descontar(unidades, restante, contenido, packs, sueltos):
    """
    Saca un pedido de un conjunto como lo hace el diálogo de venta: los packs
    salen de los cerrados y los sueltos primero de lo abierto y después
    abriendo packs de a uno.

    Si no alcanza, el conjunto queda en cero y lo que faltó se devuelve aparte:
    el modelo de packs y sueltos no tiene forma de guardar un negativo (ver
    `faltante` en el historial). Un pack pedido que ya no está cerrado se toma
    de lo suelto.

    Devuelve (unidades, restante, faltante en unidad base).
    """
    u = max(0.0, _num(unidades))
    r = max(0.0, _num(restante))
    c = _num(contenido)
    packs = max(0.0, _num(packs))
    sueltos = max(0.0, _num(sueltos))

    toma = min(u, packs)
    u -= toma
    sueltos += (packs - toma) * c

    take = min(r, sueltos)
    r -= take
    falta = sueltos - take
    while falta > EPS and u > EPS and c > 0:
        u -= 1
        if falta >= c - EPS:
            falta -= c
        else:
            r = c - falta
            falta = 0.0
    if falta <= EPS:
        falta = 0.0
    if r < EPS:
        r = 0.0
    return u, r, falta


def devolver(unidades, restante, contenido, cantidad_base):
    """Lo inverso: suma unidades base y vuelve a partir en cerrados + sueltos,
    igual que el reverso de una venta (`Sale._preparar_reverso_conjunto`)."""
    total = _num(unidades) * _num(contenido) + _num(restante) + max(0.0, _num(cantidad_base))
    u, r = repartir_total(total, contenido)
    return u, r


def stock_plano(total) -> int:
    """El `stock` plano de un conjunto: el total entero, nunca negativo. Es lo
    que escriben el panel (ficha y pedidos) y la venta del POS."""
    try:
        t = float(total)
    except (TypeError, ValueError):
        return 0
    if t != t:  # NaN
        return 0
    return max(0, int(t // 1))


# ── El carrito entero ──────────────────────────────────────────────────────

def simular_carrito(items: List[dict], leer_producto) -> List[dict]:
    """
    Recalcula `conjunto_after_*` de todas las líneas de conjunto del carrito,
    en orden, partiendo del stock vivo. Dos líneas del mismo producto y color
    se encadenan: la segunda parte de lo que dejó la primera.

    `leer_producto(product_id)` devuelve la fila de `products` (dict con
    conjunto_unidades, conjunto_restante, conjunto_contenido, conjunto_colores
    y es_conjunto) o None.

    Escribe en cada línea `conjunto_after_unidades/restante` y
    `conjunto_cantidad_base`. Devuelve los problemas encontrados:
    [{idx, nombre, motivo, falta}] con motivo 'sin_stock', 'sin_variedad' o
    'variedad_inexistente'. Una línea de producto que no está en la base o
    sin datos para calcular se deja como vino.
    """
    estados: Dict[tuple, Tuple[float, float]] = {}
    filas: Dict[int, Optional[dict]] = {}
    problemas: List[dict] = []
    for idx, it in enumerate(items or []):
        if not isinstance(it, dict) or not it.get('is_conjunto'):
            continue
        if it.get('stock_descontado'):
            continue
        try:
            pid = int(it.get('product_id') or 0)
        except (TypeError, ValueError):
            pid = 0
        if not pid:
            continue
        if pid not in filas:
            filas[pid] = leer_producto(pid)
        fila = filas[pid]
        if not fila:
            continue
        nombre = it.get('product_name') or ''
        contenido = _num(fila.get('conjunto_contenido'))
        colores = parse_colores(fila.get('conjunto_colores'))
        color = str(it.get('conjunto_color') or '').strip()
        if colores and not color:
            problemas.append({'idx': idx, 'nombre': nombre,
                              'motivo': 'sin_variedad', 'falta': 0.0})
            continue
        if color and colores:
            entry = buscar_color(colores, color)
            if entry is None:
                problemas.append({'idx': idx, 'nombre': nombre,
                                  'motivo': 'variedad_inexistente', 'falta': 0.0})
                continue
            contenido = contenido_de(entry, contenido)
            base = (_num(entry.get('unidades')), _num(entry.get('restante')))
        else:
            base = (_num(fila.get('conjunto_unidades')), _num(fila.get('conjunto_restante')))
        clave = (pid, color)
        u, r = estados.get(clave, base)
        pedido = pedido_de_linea(it, contenido)
        if pedido is None:
            continue
        packs, sueltos = pedido
        nu, nr, falta = descontar(u, r, contenido, packs, sueltos)
        estados[clave] = (nu, nr)
        it['conjunto_after_unidades'] = nu
        it['conjunto_after_restante'] = nr
        it['conjunto_cantidad_base'] = cantidad_base_del_pedido(packs, sueltos, contenido)
        if falta > 0:
            problemas.append({'idx': idx, 'nombre': nombre,
                              'motivo': 'sin_stock', 'falta': falta})
    return problemas


# ── La misma venta aplicada sobre el documento de la nube ─────────────────

def aplicar_en_doc(doc: dict, color: str, packs: float, sueltos: float,
                   devolucion: float = 0.0) -> dict:
    """
    Aplica una línea de venta (o una devolución) sobre el documento del
    catálogo tal como está en la nube. No escribe nada: devuelve qué campos
    cambiar y cuánto faltó.

    Solo toca `unidades`/`restante` de la variedad vendida; las demás filas y
    todo lo que el panel guarda en la vendida (mínimos, foto, contenido
    propio) quedan como estaban. Los agregados planos y el `stock` se
    recalculan de las variedades, así quedan coherentes con `conjunto_total`.

    Devuelve {'campos': {...}, 'faltante': x, 'antes': total, 'despues': total}
    o {'saltado': motivo} si no se puede aplicar sin inventar.
    """
    d = doc or {}
    contenido = _num(d.get('conjunto_contenido'))
    colores_raw = d.get('conjunto_colores')
    colores = [dict(c) for c in colores_raw if isinstance(c, dict)] \
        if isinstance(colores_raw, list) else []
    color = str(color or '').strip()
    falta = 0.0

    if colores:
        if not color:
            return {'saltado': 'sin variedad elegida'}
        fila = buscar_color(colores, color)
        if fila is None:
            return {'saltado': f'la variedad {color} no está en la nube'}
        cont = contenido_de(fila, contenido)
        antes = total_conjunto(colores, contenido)
        if devolucion > 0:
            u, r = devolver(fila.get('unidades'), fila.get('restante'), cont, devolucion)
        else:
            u, r, falta = descontar(fila.get('unidades'), fila.get('restante'),
                                    cont, packs, sueltos)
        fila['unidades'] = u
        fila['restante'] = r
        total = total_conjunto(colores, contenido)
        campos = {
            'conjunto_colores':  colores,
            'conjunto_unidades': sum(_num(c.get('unidades')) for c in colores),
            'conjunto_restante': sum(_num(c.get('restante')) for c in colores),
            'conjunto_total':    total,
            'stock':             stock_plano(total),
        }
    else:
        u0 = _num(d.get('conjunto_unidades'))
        r0 = _num(d.get('conjunto_restante'))
        antes = _num(d.get('conjunto_total')) if d.get('conjunto_total') is not None \
            else u0 * contenido + r0
        # Si los planos no cierran con el total (una carga vieja), manda el
        # total: es el número que leen la tienda, el panel y las alertas.
        if abs(u0 * contenido + r0 - antes) > 1e-6:
            u0, r0 = repartir_total(antes, contenido)
        if devolucion > 0:
            u, r = devolver(u0, r0, contenido, devolucion)
        else:
            u, r, falta = descontar(u0, r0, contenido, packs, sueltos)
        total = u * contenido + r
        campos = {
            'conjunto_unidades': u,
            'conjunto_restante': r,
            'conjunto_total':    total,
            'stock':             stock_plano(total),
        }
    return {'campos': campos, 'faltante': falta, 'antes': antes,
            'despues': campos['conjunto_total']}

