"""
Reglas de las promociones del panel (colección `promociones` de Firestore),
en funciones puras para que el POS las aplique igual en todos lados y se
puedan probar sin Qt ni base de datos.

La regla la define el panel web (webapp/src/pages/promociones.js); acá se
replica, no se inventa otra:

  - `productos`: doc_ids del catálogo a los que aplica la promo.
  - `variantes`: [{producto_id, color}] para variantes puntuales.
  - `modos`:     {key: {'pack': {'min': N}, 'unidad': {'min': N}}}
                 key = doc_id o "doc_id::var::Color".
                 * Modo PRESENTE en la entrada = habilitado para esa key.
                 * Modo AUSENTE = la promo NO aplica en ese modo de venta.
                 * min = 0 -> usa la `cantidad_minima` global de la promo.
                 * Si la key no tiene entrada en `modos` = todos los modos,
                   mínimo global (el panel solo guarda lo que difiere del
                   default).
                 * Forma legacy: {key: ['pack', 'unidad']} (lista = modos
                   habilitados, sin override de mínimo).

Probado por pos_system/tests/test_promos_modos.py.
"""
from pos_system.models.promotion import Promotion


def promo_match_key(fb_promo: dict, refs: tuple, color: str = '', sale_mode: str = ''):
    """Si la promo matchea este item, devuelve la key matcheada; sino None.

    refs: identificadores posibles del producto (firebase_id, barcode, id, nombre).
    color: color/variante del item conjunto. '' = sin variante.
    sale_mode: 'pack' | 'unidad' | '' (N/A: el filtro de modos no aplica).
    """
    modos_map = fb_promo.get('modos') or {}
    if not isinstance(modos_map, dict):
        modos_map = {}

    def _modo_ok(key: str) -> bool:
        if not sale_mode:
            return True
        allowed = modos_map.get(key)
        if not allowed:
            return True  # default: cualquier modo
        return sale_mode in allowed  # dict o list: mismo `in`

    prod_refs = fb_promo.get('productos') or []
    for p in prod_refs:
        if p in refs and _modo_ok(p):
            return p
    variantes = fb_promo.get('variantes') or []
    if color and variantes:
        color_lc = str(color).strip().lower()
        for v in variantes:
            if not isinstance(v, dict):
                continue
            pid = v.get('producto_id') or v.get('product_id')
            vcolor = str(v.get('color') or '').strip().lower()
            if pid in refs and vcolor == color_lc:
                key = f"{pid}::var::{v.get('color')}"
                if _modo_ok(key):
                    return key
    return None


def promo_min_override(fb_promo: dict, key: str, sale_mode: str) -> int:
    """Cantidad mínima por modo definida en el chip del producto/variante.
    0 si no hay override (se cae al `cantidad_minima` global de la promo).
    """
    if not key or not sale_mode:
        return 0
    modos_map = fb_promo.get('modos') or {}
    if not isinstance(modos_map, dict):
        return 0
    entry = modos_map.get(key)
    if not isinstance(entry, dict):
        return 0
    mode_entry = entry.get(sale_mode)
    if isinstance(mode_entry, dict):
        return max(0, int(mode_entry.get('min') or 0))
    if isinstance(mode_entry, (int, float)):
        return max(0, int(mode_entry))
    return 0


def promo_a_formato_local(fb_promo: dict) -> dict:
    """Doc de Firestore -> formato de Promotion.calculate_promo_for_cart_item."""
    return {
        'promo_type':        fb_promo.get('tipo', ''),
        'discount_value':    float(fb_promo.get('valor') or 0),
        'required_quantity': int(fb_promo.get('cantidad_requerida') or 1),
        'free_quantity':     max(0, int(fb_promo.get('cantidad_requerida') or 1)
                                    - int(fb_promo.get('cantidad_paga') or 1)),
        'max_quantity':      int(fb_promo.get('cantidad_maxima') or 0),
        'name':              fb_promo.get('nombre', ''),
    }


def evaluar_promo_linea(fb_promo: dict, refs: tuple, qty: int, unit_price: float,
                        color: str = '', sale_mode: str = ''):
    """Evalúa UNA promo contra una línea del carrito.

    Devuelve (eff_unit_price, discount_total, label) si aplica; None si no
    (inactiva, no matchea producto/variante/modo, o no llega al mínimo).
    """
    if not fb_promo.get('activo', True):
        return None
    key = promo_match_key(fb_promo, refs, color=color, sale_mode=sale_mode)
    if not key:
        return None
    cant_min_global = int(fb_promo.get('cantidad_minima') or 1)
    cant_min_modo   = promo_min_override(fb_promo, key, sale_mode)
    if qty < max(cant_min_global, cant_min_modo):
        return None
    eff, disc, label = Promotion.calculate_promo_for_cart_item(
        promo_a_formato_local(fb_promo), qty, unit_price
    )
    if disc <= 0:
        return None
    return eff, disc, label


def mejor_promo_linea(fb_promos: list, refs: tuple, qty: int, unit_price: float,
                      color: str = '', sale_mode: str = ''):
    """La promo que más descuenta para esta línea, o None si ninguna aplica.

    Devuelve (fb_promo, eff_unit_price, discount_total, label).
    """
    best = None
    for fb_promo in (fb_promos or []):
        r = evaluar_promo_linea(fb_promo, refs, qty, unit_price,
                                color=color, sale_mode=sale_mode)
        if r is None:
            continue
        if best is None or r[1] > best[2]:
            best = (fb_promo, r[0], r[1], r[2])
    return best
