"""
Productos Madre con Variantes (mp_*)
─────────────────────────────────────────────────────────────────────────────
Modelo local que espeja las colecciones Firestore mp_products, mp_nodes
y mp_discounts, gestionadas desde la webapp en
`webapp/src/pages/lab_productos_madre.js`.

Cada producto madre define un schema de atributos (color, tamaño, gramaje…),
una jerarquía arbitraria de nodos (raíces → sub-raíces → hojas), y solo las
hojas se venden. Cada hoja puede tener varias presentaciones embebidas
(unidad/pack/caja/rollo+sueltos…), cada una con su propio stock y precio.

Los descuentos se resuelven con override puro: presentación → nodo →
ancestros → producto madre. Primer match cierra; nunca se acumulan.
"""

import json
import logging
from datetime import datetime
from typing import List, Dict, Optional, Tuple

from pos_system.database.db_manager import DatabaseManager

logger = logging.getLogger(__name__)


# ── Helpers JSON tolerantes ────────────────────────────────────────────────
def _loads(s, default):
    if s is None or s == '':
        return default
    if isinstance(s, (dict, list)):
        return s
    try:
        return json.loads(s)
    except Exception:
        return default


def _dumps(v) -> str:
    try:
        return json.dumps(v, ensure_ascii=False, default=str)
    except Exception:
        return ''


# ── Helpers de filas → diccionarios "ricos" ────────────────────────────────
def _row_to_product(row) -> Dict:
    if row is None:
        return None
    d = dict(row)
    d['atributos_definidos'] = _loads(d.get('atributos_definidos'), [])
    return d


def _row_to_node(row) -> Dict:
    if row is None:
        return None
    d = dict(row)
    d['atributos'] = _loads(d.get('atributos'), {})
    d['presentaciones'] = _loads(d.get('presentaciones'), [])
    d['hereda_de_padre'] = _loads(d.get('hereda_de_padre'),
                                   {'categoria': True, 'marca': True, 'descripcion': True})
    d['overrides'] = _loads(d.get('overrides'), {})
    d['path'] = _loads(d.get('path'), [])
    d['es_hoja'] = bool(d.get('es_hoja'))
    return d


def _row_to_discount(row) -> Dict:
    if row is None:
        return None
    d = dict(row)
    d['activo'] = bool(d.get('activo'))
    d['stackable'] = bool(d.get('stackable'))
    return d


# ── MotherProduct ──────────────────────────────────────────────────────────
class MotherProduct:
    """Acceso a la colección espejo `mp_products`."""

    def __init__(self, db_manager: DatabaseManager):
        self.db = db_manager

    def upsert(self, doc: Dict) -> None:
        """Inserta o actualiza un producto madre. `doc` es el documento Firestore tal cual."""
        params = (
            doc.get('id'),
            doc.get('nombre') or '',
            doc.get('slug') or '',
            doc.get('codigo_barras') or '',
            doc.get('categoria') or '',
            doc.get('marca') or '',
            doc.get('descripcion') or '',
            _dumps(doc.get('atributos_definidos') or []),
            1 if doc.get('_seed') else 0,
            _ts(doc.get('creado')),
            _ts(doc.get('actualizado')),
            _dumps(doc),
        )
        self.db.execute_update("""
            INSERT INTO mp_products (id, nombre, slug, codigo_barras, categoria, marca,
                descripcion, atributos_definidos, is_seed, creado, actualizado, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                nombre = excluded.nombre,
                slug = excluded.slug,
                codigo_barras = excluded.codigo_barras,
                categoria = excluded.categoria,
                marca = excluded.marca,
                descripcion = excluded.descripcion,
                atributos_definidos = excluded.atributos_definidos,
                is_seed = excluded.is_seed,
                actualizado = excluded.actualizado,
                raw_json = excluded.raw_json
        """, params)

    def delete(self, product_id: str) -> None:
        """Borra el producto madre + sus nodos + sus descuentos en cascada."""
        self.db.execute_update("DELETE FROM mp_products WHERE id = ?", (product_id,))
        self.db.execute_update("DELETE FROM mp_nodes WHERE product_id = ?", (product_id,))
        self.db.execute_update("DELETE FROM mp_discounts WHERE product_id = ?", (product_id,))

    def get_all(self) -> List[Dict]:
        rows = self.db.execute_query("SELECT * FROM mp_products ORDER BY nombre")
        return [_row_to_product(r) for r in rows]

    def get_by_id(self, product_id: str) -> Optional[Dict]:
        rows = self.db.execute_query("SELECT * FROM mp_products WHERE id = ? LIMIT 1", (product_id,))
        return _row_to_product(rows[0]) if rows else None

    def get_by_codigo(self, codigo: str) -> Optional[Dict]:
        rows = self.db.execute_query("SELECT * FROM mp_products WHERE codigo_barras = ? LIMIT 1", (codigo,))
        return _row_to_product(rows[0]) if rows else None


# ── Node ───────────────────────────────────────────────────────────────────
class Node:
    """Acceso a la colección espejo `mp_nodes`. Hojas son las que se venden."""

    def __init__(self, db_manager: DatabaseManager):
        self.db = db_manager

    def upsert(self, doc: Dict) -> None:
        precio = doc.get('precio') or {}
        params = (
            doc.get('id'),
            doc.get('product_id') or '',
            doc.get('parent_id'),
            doc.get('nombre') or '',
            doc.get('sku_sufijo') or '',
            _dumps(doc.get('atributos') or {}),
            precio.get('costo'),
            precio.get('venta'),
            _dumps(doc.get('presentaciones') or []),
            _dumps(doc.get('hereda_de_padre') or {}),
            _dumps(doc.get('overrides') or {}),
            1 if doc.get('es_hoja') else 0,
            int(doc.get('depth') or 0),
            _dumps(doc.get('path') or []),
            1 if doc.get('_seed') else 0,
            _ts(doc.get('creado')),
            _ts(doc.get('actualizado')),
            _dumps(doc),
        )
        self.db.execute_update("""
            INSERT INTO mp_nodes (id, product_id, parent_id, nombre, sku_sufijo,
                atributos, precio_costo, precio_venta, presentaciones,
                hereda_de_padre, overrides, es_hoja, depth, path,
                is_seed, creado, actualizado, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                product_id = excluded.product_id,
                parent_id = excluded.parent_id,
                nombre = excluded.nombre,
                sku_sufijo = excluded.sku_sufijo,
                atributos = excluded.atributos,
                precio_costo = excluded.precio_costo,
                precio_venta = excluded.precio_venta,
                presentaciones = excluded.presentaciones,
                hereda_de_padre = excluded.hereda_de_padre,
                overrides = excluded.overrides,
                es_hoja = excluded.es_hoja,
                depth = excluded.depth,
                path = excluded.path,
                is_seed = excluded.is_seed,
                actualizado = excluded.actualizado,
                raw_json = excluded.raw_json
        """, params)

    def delete(self, node_id: str) -> None:
        self.db.execute_update("DELETE FROM mp_nodes WHERE id = ?", (node_id,))

    def get_by_id(self, node_id: str) -> Optional[Dict]:
        rows = self.db.execute_query("SELECT * FROM mp_nodes WHERE id = ? LIMIT 1", (node_id,))
        return _row_to_node(rows[0]) if rows else None

    def get_by_product(self, product_id: str) -> List[Dict]:
        rows = self.db.execute_query(
            "SELECT * FROM mp_nodes WHERE product_id = ? ORDER BY depth, nombre",
            (product_id,))
        return [_row_to_node(r) for r in rows]

    def get_hojas_by_product(self, product_id: str) -> List[Dict]:
        rows = self.db.execute_query(
            "SELECT * FROM mp_nodes WHERE product_id = ? AND es_hoja = 1 ORDER BY nombre",
            (product_id,))
        return [_row_to_node(r) for r in rows]

    def find_by_codigo(self, codigo: str) -> Optional[Tuple[Dict, Optional[Dict]]]:
        """
        Busca por código de barras de presentación O de SKU sufijo.
        Devuelve (nodo, presentación) si matchea presentación, o (nodo, None) si matchea
        nombre/sku del nodo. None si no encuentra.
        """
        if not codigo:
            return None
        # Búsqueda directa: el código de la presentación está embebido en el JSON.
        # Se hace pull en memoria de las hojas con presentaciones que tengan ese código.
        rows = self.db.execute_query(
            "SELECT * FROM mp_nodes WHERE es_hoja = 1 AND presentaciones LIKE ?",
            (f'%"{codigo}"%',))
        for r in rows:
            n = _row_to_node(r)
            for p in (n.get('presentaciones') or []):
                if (p.get('codigo_barras') or '').strip() == codigo.strip():
                    return n, p
        # Fallback: SKU sufijo
        rows = self.db.execute_query(
            "SELECT * FROM mp_nodes WHERE es_hoja = 1 AND sku_sufijo = ? LIMIT 1",
            (codigo,))
        if rows:
            n = _row_to_node(rows[0])
            pres = (n.get('presentaciones') or [None])[0]
            return n, pres
        return None

    def buscar_por_texto(self, texto: str, limite: int = 30) -> List[Dict]:
        """Búsqueda por nombre del nodo. Devuelve hojas que matcheen."""
        if not texto:
            return []
        rows = self.db.execute_query("""
            SELECT * FROM mp_nodes
            WHERE es_hoja = 1
              AND (norm_text(nombre) LIKE norm_text(?) OR norm_text(sku_sufijo) LIKE norm_text(?))
            LIMIT ?
        """, (f"%{texto}%", f"%{texto}%", limite))
        return [_row_to_node(r) for r in rows]

    def update_presentaciones(self, node_id: str, presentaciones: List[Dict]) -> None:
        """Persistencia local del array de presentaciones (después de descontar stock)."""
        self.db.execute_update("""
            UPDATE mp_nodes SET presentaciones = ?, actualizado = ? WHERE id = ?
        """, (_dumps(presentaciones), _ts(datetime.now()), node_id))


# ── Discount ───────────────────────────────────────────────────────────────
class Discount:
    """Acceso a la colección espejo `mp_discounts`."""

    def __init__(self, db_manager: DatabaseManager):
        self.db = db_manager

    def upsert(self, doc: Dict) -> None:
        params = (
            doc.get('id'),
            doc.get('product_id') or '',
            doc.get('scope_type') or '',
            doc.get('scope_id') or '',
            doc.get('tipo') or 'porcentaje',
            float(doc.get('valor') or 0),
            doc.get('cantidad_min'),
            doc.get('desde') or '',
            doc.get('hasta') or '',
            int(doc.get('prioridad') or 0),
            1 if doc.get('activo') is not False else 0,
            1 if doc.get('stackable') else 0,
            doc.get('etiqueta') or '',
            1 if doc.get('_seed') else 0,
            _ts(doc.get('creado')),
            _ts(doc.get('actualizado')),
            _dumps(doc),
        )
        self.db.execute_update("""
            INSERT INTO mp_discounts (id, product_id, scope_type, scope_id, tipo, valor,
                cantidad_min, desde, hasta, prioridad, activo, stackable, etiqueta,
                is_seed, creado, actualizado, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                product_id = excluded.product_id,
                scope_type = excluded.scope_type,
                scope_id = excluded.scope_id,
                tipo = excluded.tipo,
                valor = excluded.valor,
                cantidad_min = excluded.cantidad_min,
                desde = excluded.desde,
                hasta = excluded.hasta,
                prioridad = excluded.prioridad,
                activo = excluded.activo,
                stackable = excluded.stackable,
                etiqueta = excluded.etiqueta,
                is_seed = excluded.is_seed,
                actualizado = excluded.actualizado,
                raw_json = excluded.raw_json
        """, params)

    def delete(self, disc_id: str) -> None:
        self.db.execute_update("DELETE FROM mp_discounts WHERE id = ?", (disc_id,))

    def get_by_product(self, product_id: str) -> List[Dict]:
        rows = self.db.execute_query(
            "SELECT * FROM mp_discounts WHERE product_id = ? ORDER BY prioridad DESC",
            (product_id,))
        return [_row_to_discount(r) for r in rows]

    @staticmethod
    def vigente_hoy(d: Dict, hoy: Optional[datetime] = None) -> bool:
        return _vigente_hoy_impl(d, hoy)


# ── Modelo: StockMovement (mp_stock_movements) ───────────────────────────────
# Espejo local de la auditoría que el POS escribe en Firestore al vender y
# que la webapp escribe al ajustar stock manualmente. El id es el doc_id de
# Firestore para que `upsert` sea idempotente cuando el listener pulla.

class StockMovement:
    """Acceso a la colección espejo `mp_stock_movements` (auditoría)."""

    def __init__(self, db_manager: DatabaseManager):
        self.db = db_manager

    def upsert(self, doc: Dict) -> None:
        params = (
            doc.get('id'),
            doc.get('product_id') or '',
            doc.get('node_id') or '',
            doc.get('presentation_id') or '',
            float(doc.get('delta') or 0),
            float(doc.get('delta_sueltos') or 0),
            doc.get('motivo') or '',
            doc.get('usuario') or '',
            _ts(doc.get('ts')),
            _dumps(doc),
        )
        self.db.execute_update("""
            INSERT INTO mp_stock_movements
                (id, product_id, node_id, presentation_id, delta, delta_sueltos,
                 motivo, usuario, ts, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                product_id      = excluded.product_id,
                node_id         = excluded.node_id,
                presentation_id = excluded.presentation_id,
                delta           = excluded.delta,
                delta_sueltos   = excluded.delta_sueltos,
                motivo          = excluded.motivo,
                usuario         = excluded.usuario,
                ts              = excluded.ts,
                raw_json        = excluded.raw_json
        """, params)

    def delete(self, mov_id: str) -> None:
        self.db.execute_update("DELETE FROM mp_stock_movements WHERE id = ?", (mov_id,))

    def get_by_node(self, node_id: str, limit: int = 200) -> List[Dict]:
        rows = self.db.execute_query(
            "SELECT * FROM mp_stock_movements WHERE node_id = ? ORDER BY ts DESC LIMIT ?",
            (node_id, int(limit)))
        return [_row_to_movement(r) for r in rows]

    def get_by_product(self, product_id: str, limit: int = 500) -> List[Dict]:
        rows = self.db.execute_query(
            "SELECT * FROM mp_stock_movements WHERE product_id = ? ORDER BY ts DESC LIMIT ?",
            (product_id, int(limit)))
        return [_row_to_movement(r) for r in rows]

    def get_recientes(self, limit: int = 200) -> List[Dict]:
        rows = self.db.execute_query(
            "SELECT * FROM mp_stock_movements ORDER BY ts DESC LIMIT ?",
            (int(limit),))
        return [_row_to_movement(r) for r in rows]


def _row_to_movement(row) -> Dict:
    return {
        '_id':              row['id'],
        'id':               row['id'],
        'product_id':       row['product_id'],
        'node_id':          row['node_id'],
        'presentation_id':  row['presentation_id'],
        'delta':            row['delta'],
        'delta_sueltos':    row['delta_sueltos'],
        'motivo':           row['motivo'],
        'usuario':          row['usuario'],
        'ts':               row['ts'],
    }


def _vigente_hoy_impl(d: Dict, hoy: Optional[datetime] = None) -> bool:
    """Aplica filtro por activo=True y rango de fechas si hay."""
    if not d.get('activo'):
        return False
    hoy = hoy or datetime.now()
    try:
        desde = d.get('desde')
        if desde:
            if hoy < datetime.strptime(desde, '%Y-%m-%d'):
                return False
        hasta = d.get('hasta')
        if hasta:
            # incluye el día completo
            fin = datetime.strptime(hasta + ' 23:59:59', '%Y-%m-%d %H:%M:%S')
            if hoy > fin:
                return False
    except Exception:
        return True
    return True


# ── Resolución de descuento efectivo (override puro) ──────────────────────
def descuento_efectivo(producto: Dict, nodo: Dict, presentacion: Optional[Dict],
                       todos_los_nodos: List[Dict], descuentos_producto: List[Dict],
                       cantidad: float = 1) -> Optional[Dict]:
    """
    Resuelve qué descuento aplica para una venta concreta. Override puro:
    presentación → nodo (hoja) → ancestros → producto. Primer match cierra.
    Si hay varios candidatos en el mismo scope, gana mayor prioridad.
    """
    if not descuentos_producto:
        return None

    def aplica(d: Dict, scope_type: str, scope_id: str) -> bool:
        if d.get('scope_type') != scope_type or d.get('scope_id') != scope_id:
            return False
        if not Discount.vigente_hoy(d):
            return False
        if d.get('tipo') == 'por_cantidad' and cantidad < float(d.get('cantidad_min') or 1):
            return False
        return True

    def ganador(cands: List[Dict]) -> Optional[Dict]:
        if not cands:
            return None
        return sorted(cands, key=lambda x: (x.get('prioridad') or 0), reverse=True)[0]

    # 1) Presentación
    if presentacion and presentacion.get('id'):
        cand = [d for d in descuentos_producto if aplica(d, 'presentation', presentacion['id'])]
        g = ganador(cand)
        if g:
            return g

    # 2) Nodo + ancestros (hoja → producto)
    if nodo:
        path = nodo.get('path') or []
        # path = [productId, ancestor1, ..., self]. Recorrer de hoja a ancestros, sin productId
        for i in range(len(path) - 1, 0, -1):
            cand = [d for d in descuentos_producto if aplica(d, 'node', path[i])]
            g = ganador(cand)
            if g:
                return g

    # 3) Producto madre
    cand = [d for d in descuentos_producto if aplica(d, 'product', producto.get('id'))]
    return ganador(cand)


# Margen extra al vender una unidad fraccionada de un contenedor (rollo/caja).
# Mismo valor que en webapp/src/pages/lab_productos_madre.js (FRACCION_MARGIN).
FRACCION_MARGIN = 1.15


def node_precio_venta(node: Dict) -> float:
    """Devuelve el precio venta del nodo, soportando dos formas de la data:
       - Plana (espejo SQLite): node['precio_venta'] = 1200.
       - Anidada (Firestore directo): node['precio'] = {'venta': 1200, 'costo': 1000}.
    """
    pv = node.get('precio_venta')
    if pv is not None and pv != '':
        try:
            return float(pv)
        except (TypeError, ValueError):
            pass
    p = node.get('precio') or {}
    try:
        return float(p.get('venta') or 0)
    except (TypeError, ValueError):
        return 0.0


def precio_efectivo_presentacion(node: Dict, presentacion: Dict) -> float:
    """
    Devuelve el precio venta efectivo de una presentación.
    Si la presentación es vinculada (corte a medida desde un contenedor) y NO tiene
    precio propio, se calcula automático: fuente.precio / fuente.equivalencia × FRACCION_MARGIN.
    Si tiene precio propio explícito, ese gana.
    """
    propio = presentacion.get('precio_venta')
    if propio is not None and float(propio) > 0:
        return float(propio)
    fuente_id = presentacion.get('vinculada_a')
    if presentacion.get('stock_modo') == 'vinculado' and fuente_id:
        fuente = next((p for p in (node.get('presentaciones') or [])
                       if (p.get('id') or '') == fuente_id), None)
        if fuente:
            src_precio = float(fuente.get('precio_venta') or 0) or node_precio_venta(node)
            src_equiv  = float(fuente.get('equivalencia_base') or 0)
            if src_precio > 0 and src_equiv > 0:
                return src_precio / src_equiv * FRACCION_MARGIN
    # Fallback final: precio del nodo
    return node_precio_venta(node)


def aplicar_descuento(precio_base: float, descuento: Optional[Dict], cantidad: float = 1) -> Tuple[float, float, str]:
    """Devuelve (precio_final, descuento_monto, etiqueta_visible)."""
    if not descuento or not precio_base:
        return float(precio_base or 0), 0.0, ''
    tipo = descuento.get('tipo')
    valor = float(descuento.get('valor') or 0)
    if tipo in ('porcentaje', 'por_cantidad', 'por_fecha'):
        precio_final = precio_base * (1 - valor / 100.0)
        etiqueta = f"−{valor:g}%"
    elif tipo == 'monto_fijo':
        precio_final = max(0.0, precio_base - valor)
        etiqueta = f"−${valor:g}"
    else:
        return float(precio_base), 0.0, ''
    return precio_final, precio_base - precio_final, etiqueta


# ── Util ──────────────────────────────────────────────────────────────────
def _ts(v):
    """Convierte timestamps de Firestore (datetime, dict, None) a string ISO local."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.strftime('%Y-%m-%d %H:%M:%S')
    if isinstance(v, dict):
        # Firestore SDK a veces devuelve {seconds, nanoseconds}
        secs = v.get('seconds') or v.get('_seconds')
        if secs:
            try:
                return datetime.fromtimestamp(secs).strftime('%Y-%m-%d %H:%M:%S')
            except Exception:
                return None
    if isinstance(v, str):
        return v
    return None
