"""Stock efectivo por vínculo (consumibles, nivel catálogo).

Un producto del catálogo puede estar "vinculado" a otro(s) producto(s) de stock:
al venderlo se descuenta del/los producto(s) fuente, no de su stock propio (ej:
"Impresión A3" → "Papel Obra A3"). Para esos productos el stock propio no aplica;
la disponibilidad real sale de los targets.

Formato de vínculos:
  - Nuevo:  columna `vinculaciones` = JSON [{doc_id, cantidad, nombre}]
  - Legacy: columnas vinculado_a / vinculado_cantidad / vinculado_nombre
  `doc_id` == `firebase_id` del producto target.

Stock efectivo = min( floor(stock_target / cantidad) ) sobre todos los vínculos.
  - target conjunto → se usa `conjunto_total` como stock físico.
  - target con stock == -1 (servicio/ilimitado) → no restringe.
  - si TODOS los targets son ilimitados → -1 (servicio).
"""
import json
import math


def parse_links(product):
    """Vínculos normalizados [{doc_id, cantidad}] de un producto (dict/Row de la
    tabla `products`). [] si no tiene, es inválido o es el sentinel mp_*."""
    if product is None:
        return []
    try:
        raw = product.get('vinculaciones')
    except AttributeError:
        return []

    vincs = []
    if raw:
        try:
            parsed = json.loads(raw) if isinstance(raw, str) else raw
            if isinstance(parsed, list):
                vincs = parsed
        except Exception:
            vincs = []

    out = []
    for v in vincs:
        if not isinstance(v, dict):
            continue
        did = str(v.get('doc_id') or '').strip()
        try:
            cant = float(v.get('cantidad') or 0)
        except (TypeError, ValueError):
            cant = 0.0
        if did and cant > 0:
            out.append({'doc_id': did, 'cantidad': cant})

    # Fallback legacy: vinculado_a / vinculado_cantidad
    if not out:
        va = product.get('vinculado_a')
        try:
            vc = float(product.get('vinculado_cantidad') or 0)
        except (TypeError, ValueError):
            vc = 0.0
        if va and vc > 0:
            out.append({'doc_id': str(va).strip(), 'cantidad': vc})
    return out


def has_links(product):
    """True si el producto está vinculado a otro(s) de stock."""
    return len(parse_links(product)) > 0


def _target_base_stock(target):
    """Stock físico de un target: conjunto → conjunto_total; si no, stock crudo.
    -1 = servicio/ilimitado. None/0 si no existe."""
    if target is None:
        return 0.0
    try:
        es_conj = bool(target.get('es_conjunto'))
    except AttributeError:
        return 0.0
    if es_conj:
        try:
            return max(0.0, float(target.get('conjunto_total') or 0))
        except (TypeError, ValueError):
            return 0.0
    try:
        s = float(target.get('stock'))
    except (TypeError, ValueError):
        return 0.0
    return -1.0 if s == -1 else max(0.0, s)


def build_target_index(products, db_manager):
    """Pre-carga en UNA sola query el stock de todos los productos fuente de una
    lista de productos vinculados. Devuelve dict firebase_id → row. Pasalo a
    effective_stock(..., targets_index=idx) para evitar N+1 queries al renderizar
    una grilla (cada effective_stock haría una query por target)."""
    fids = set()
    for p in (products or []):
        for l in parse_links(p):
            fids.add(l['doc_id'])
    if not fids or db_manager is None:
        return {}
    fids = list(fids)
    placeholders = ','.join('?' * len(fids))
    try:
        rows = db_manager.execute_query(
            "SELECT firebase_id, stock, es_conjunto, conjunto_total FROM products "
            "WHERE firebase_id IN (%s)" % placeholders,
            tuple(fids)
        )
    except Exception:
        return {}
    out = {}
    for r in rows or []:
        try:
            out[str(r.get('firebase_id'))] = r
        except AttributeError:
            continue
    return out


def shown_stock(product, db_manager=None, targets_index=None):
    """Stock a MOSTRAR para un producto plano (no conjunto/mp). Nunca devuelve un
    número negativo. Reglas:
      - vinculado          → disponibilidad efectiva del/los producto(s) fuente
      - stock == -1        → servicio/ilimitado          → ('∞', inf)
      - stock < 0 (sobrevendido, sin reponer) → físicamente 0 → ('0', 0)
      - resto              → (str(n), n)
    Devuelve (texto, num) donde `num` sirve para decidir color/umbral
    (inf = servicio, no dispara alarma de stock bajo)."""
    if has_links(product):
        v = effective_stock(product, db_manager, targets_index=targets_index)
    else:
        try:
            v = float(product.get('stock') or 0)
        except (TypeError, ValueError):
            v = 0.0
    if v == -1:
        return ('∞', float('inf'))   # ∞ servicio / ilimitado
    v = max(0.0, v)
    txt = str(int(v)) if v == int(v) else ('%g' % v)
    return (txt, v)


def effective_stock(product, db_manager=None, targets_index=None):
    """Stock efectivo de un producto vinculado = min(floor(stockTarget/cantidad)).
    Devuelve -1 si todos los targets son ilimitados (servicio). Si el producto no
    tiene vínculos, devuelve su stock propio.

    Los targets se resuelven por `firebase_id`: si se pasa `targets_index` (de
    build_target_index) se usa esa cache; si no, se consulta la tabla `products`
    una vez por target con `db_manager`."""
    links = parse_links(product)
    if not links:
        try:
            return float(product.get('stock') or 0)
        except (TypeError, ValueError):
            return 0.0

    best = None
    for l in links:
        if targets_index is not None:
            target = targets_index.get(l['doc_id'])
        elif db_manager is not None:
            rows = db_manager.execute_query(
                "SELECT stock, es_conjunto, conjunto_total FROM products "
                "WHERE firebase_id = ? LIMIT 1",
                (l['doc_id'],)
            )
            target = rows[0] if rows else None
        else:
            target = None
        base = _target_base_stock(target)   # target inexistente → 0
        if base == -1:
            continue  # ilimitado: no restringe
        cap = math.floor(base / l['cantidad'])
        if best is None or cap < best:
            best = cap

    if best is None:
        return -1.0   # todos los targets ilimitados
    return max(0.0, float(best))
