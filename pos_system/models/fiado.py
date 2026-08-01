"""Modelo de Fiado — cuenta corriente de clientes.

Concepto:
- Un cliente se lleva mercadería sin pagar. Cada producto que se lleva se
  guarda como una fila en `fiado_items` con estado 'pendiente'. NO se descuenta
  stock: el producto salió del local, pero la venta todavía no existe.
- Cuando el cliente viene a pagar, se eligen los items que salda y el POS crea
  una venta real: ahí se descuenta el stock, entra a la caja y la venta queda
  marcada con es_fiado=1 para que la webapp la muestre distinta.
- También se pueden registrar entregas de dinero sueltas ("a cuenta"), que
  generan saldo a favor del cliente y se aplican en un cobro posterior.

Deuda del cliente = Σ(items pendientes) − saldo a favor

Sincronización: espejo de las colecciones Firestore fiado_clientes /
fiado_items / fiado_pagos. El POS escribe local primero (funciona offline) y
empuja a Firebase; el listener mergea lo que se carga desde la webapp.
"""
import json
import logging
import uuid
from typing import List, Dict, Optional

from pos_system.database.db_manager import DatabaseManager

logger = logging.getLogger(__name__)

ESTADOS_ITEM = ('pendiente', 'pagado', 'anulado')
TIPOS_PAGO = ('productos', 'a_cuenta', 'credito_aplicado')


def nuevo_entrega_id() -> str:
    """Id que agrupa todo lo que un cliente se llevó de una sola vez."""
    return uuid.uuid4().hex[:16]


class Fiado:
    """CRUD de clientes, items y pagos de la cuenta corriente."""

    def __init__(self, db_manager: DatabaseManager):
        self.db = db_manager

    # ══════════════════════════════════════════════════
    #  CLIENTES
    # ══════════════════════════════════════════════════
    def crear_cliente(self, nombre: str, dni: str = '', telefono: str = '',
                      email: str = '', direccion: str = '', notas: str = '',
                      pc_id: str = '') -> int:
        nombre = (nombre or '').strip()
        if not nombre:
            raise ValueError('El nombre del cliente es obligatorio')
        return self.db.execute_update(
            "INSERT INTO fiado_clientes "
            "(nombre, dni, telefono, email, direccion, notas, pc_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (nombre, str(dni or '').strip(), str(telefono or '').strip(),
             str(email or '').strip(), str(direccion or '').strip(),
             str(notas or '').strip(), str(pc_id or ''))
        )

    def actualizar_cliente(self, cliente_id: int, **campos) -> None:
        permitidos = ('nombre', 'dni', 'telefono', 'email', 'direccion',
                      'notas', 'activo')
        sets, params = [], []
        for k, v in campos.items():
            if k not in permitidos:
                continue
            sets.append(f"{k} = ?")
            params.append(int(v) if k == 'activo' else str(v or '').strip())
        if not sets:
            return
        sets.append("updated_at = (SELECT localtime_now())")
        params.append(int(cliente_id))
        self.db.execute_update(
            f"UPDATE fiado_clientes SET {', '.join(sets)} WHERE id = ?",
            tuple(params)
        )

    def set_cliente_firebase_id(self, cliente_id: int, firebase_id: str) -> None:
        if not firebase_id:
            return
        self.db.execute_update(
            "UPDATE fiado_clientes SET firebase_id = ? WHERE id = ?",
            (str(firebase_id), int(cliente_id))
        )

    def eliminar_cliente(self, cliente_id: int) -> None:
        """Baja lógica. Los items pendientes quedan como estaban (el historial
        no se pierde), pero el cliente sale de la lista."""
        self.db.execute_update(
            "UPDATE fiado_clientes SET deleted = 1, "
            "updated_at = (SELECT localtime_now()) WHERE id = ?",
            (int(cliente_id),)
        )

    def get_cliente(self, cliente_id: int) -> Optional[Dict]:
        rows = self.db.execute_query(
            "SELECT * FROM fiado_clientes WHERE id = ? LIMIT 1", (int(cliente_id),)
        ) or []
        return rows[0] if rows else None

    def get_cliente_por_fid(self, firebase_id: str) -> Optional[Dict]:
        if not firebase_id:
            return None
        rows = self.db.execute_query(
            "SELECT * FROM fiado_clientes WHERE firebase_id = ? LIMIT 1",
            (str(firebase_id),)
        ) or []
        return rows[0] if rows else None

    def get_clientes(self, buscar: str = '', incluir_inactivos: bool = False) -> List[Dict]:
        """Clientes con sus totales calculados (deuda, saldo a favor, items)."""
        where = "WHERE deleted = 0"
        params: list = []
        if not incluir_inactivos:
            where += " AND activo = 1"
        if buscar and buscar.strip():
            where += (" AND (norm_text(nombre) LIKE ? OR dni LIKE ? "
                      "OR REPLACE(REPLACE(telefono,' ',''),'-','') LIKE ?)")
            like = f"%{buscar.strip().lower()}%"
            solo_num = ''.join(ch for ch in buscar if ch.isdigit())
            params += [like, f"%{solo_num or buscar.strip()}%",
                       f"%{solo_num or buscar.strip()}%"]
        clientes = self.db.execute_query(
            f"SELECT * FROM fiado_clientes {where} ORDER BY nombre COLLATE NOCASE",
            tuple(params)
        ) or []
        pendientes = self._pendientes_agrupados()
        creditos   = self._creditos_agrupados()
        for c in clientes:
            t = self._sumar_para(pendientes, c)
            c['pendiente']    = round(t['monto'], 2)
            c['items_count']  = int(t['cantidad'])
            cr = self._sumar_para(creditos, c)
            c['credito']      = round(max(0.0, cr['monto']), 2)
            c['deuda']        = round(max(0.0, c['pendiente'] - c['credito']), 2)
            c['saldo_favor']  = round(max(0.0, c['credito'] - c['pendiente']), 2)
        return clientes

    def _sumar_para(self, filas: List[Dict], cliente: Dict) -> Dict:
        """Suma las filas agrupadas que pertenecen a este cliente.

        Un cliente puede tener filas apuntadas de dos formas: por `cliente_fid`
        (lo normal) y por `cliente_local_id` con fid vacío (creadas offline,
        antes de que el push a Firebase le asignara un id). Las dos cuentan —
        si sólo mirásemos una, la lista mostraría productos que el total no suma.
        """
        fid = str(cliente.get('firebase_id') or '').strip()
        local_id = cliente.get('id')
        monto, cantidad = 0.0, 0
        for f in filas:
            f_fid = str(f.get('cliente_fid') or '').strip()
            if f_fid:
                coincide = bool(fid) and f_fid == fid
            else:
                coincide = (f.get('cliente_local_id') is not None
                            and local_id is not None
                            and int(f['cliente_local_id']) == int(local_id))
            if coincide:
                monto += float(f.get('monto') or 0)
                cantidad += int(f.get('cantidad') or 0)
        return {'monto': monto, 'cantidad': cantidad}

    def _pendientes_agrupados(self) -> List[Dict]:
        return self.db.execute_query(
            "SELECT cliente_fid, cliente_local_id, "
            "       COALESCE(SUM(subtotal), 0) AS monto, COUNT(*) AS cantidad "
            "FROM fiado_items "
            "WHERE deleted = 0 AND estado = 'pendiente' "
            "GROUP BY cliente_fid, cliente_local_id"
        ) or []

    def _creditos_agrupados(self) -> List[Dict]:
        return self.db.execute_query(
            "SELECT cliente_fid, cliente_local_id, "
            "       COALESCE(SUM(CASE WHEN tipo = 'a_cuenta' THEN monto ELSE 0 END), 0) "
            "     - COALESCE(SUM(CASE WHEN tipo = 'credito_aplicado' THEN monto ELSE 0 END), 0) "
            "     - COALESCE(SUM(credito_usado), 0) AS monto, "
            "       0 AS cantidad "
            "FROM fiado_pagos WHERE deleted = 0 "
            "GROUP BY cliente_fid, cliente_local_id"
        ) or []

    def get_credito(self, cliente: Dict) -> float:
        """Saldo a favor: entregas 'a cuenta' menos lo ya aplicado a productos."""
        cr = self._sumar_para(self._creditos_agrupados(), cliente)
        return round(max(0.0, cr['monto']), 2)

    def _cond_cliente(self, cliente: Dict) -> tuple:
        """WHERE que matchea las filas de un cliente por fid o por id local."""
        fid = str(cliente.get('firebase_id') or '').strip()
        if fid:
            # Incluye filas creadas antes de tener fid (todavía referencian el local_id).
            return ("(cliente_fid = ? OR (cliente_fid = '' AND cliente_local_id = ?))",
                    (fid, cliente.get('id')))
        return ("(cliente_local_id = ? AND cliente_fid = '')", (cliente.get('id'),))

    # ══════════════════════════════════════════════════
    #  ITEMS
    # ══════════════════════════════════════════════════
    def cargar_items(self, cliente: Dict, items: List[Dict],
                     entrega_id: str = '', cajero: str = '',
                     pc_id: str = '', origen: str = 'pos',
                     nota: str = '') -> List[int]:
        """Carga líneas de carrito a la cuenta del cliente. Devuelve los ids
        locales creados. NO toca stock."""
        items = items or []
        if not items:
            return []
        entrega_id = entrega_id or nuevo_entrega_id()
        cliente_fid = str(cliente.get('firebase_id') or '').strip()
        cliente_nombre = str(cliente.get('nombre') or '').strip()
        creados = []
        for it in items:
            qty = float(it.get('quantity') or 0)
            precio = float(it.get('unit_price') or 0)
            subtotal = float(it.get('subtotal') if it.get('subtotal') is not None
                             else qty * precio)
            new_id = self.db.execute_update(
                "INSERT INTO fiado_items "
                "(cliente_fid, cliente_local_id, cliente_nombre, entrega_id, "
                " product_id, product_fid, product_name, categoria, quantity, "
                " unit_price, subtotal, item_json, estado, nota, origen, pc_id, cajero) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?)",
                (cliente_fid, cliente.get('id'), cliente_nombre, entrega_id,
                 int(it.get('product_id') or 0),
                 str(it.get('product_fid') or it.get('firebase_id') or ''),
                 str(it.get('product_name') or 'Item'),
                 str(it.get('category') or it.get('categoria') or ''),
                 qty, precio, round(subtotal, 2),
                 json.dumps(it, ensure_ascii=False, default=str),
                 str(nota or ''), str(origen or 'pos'),
                 str(pc_id or ''), str(cajero or ''))
            )
            creados.append(new_id)
        return creados

    def set_item_firebase_id(self, item_id: int, firebase_id: str) -> None:
        if not firebase_id:
            return
        self.db.execute_update(
            "UPDATE fiado_items SET firebase_id = ? WHERE id = ?",
            (str(firebase_id), int(item_id))
        )

    def get_item(self, item_id: int) -> Optional[Dict]:
        rows = self.db.execute_query(
            "SELECT * FROM fiado_items WHERE id = ? LIMIT 1", (int(item_id),)
        ) or []
        if not rows:
            return None
        return self._hidratar_item(rows[0])

    def get_items(self, cliente: Dict, estado: Optional[str] = 'pendiente',
                  limit: int = 500) -> List[Dict]:
        cond, params = self._cond_cliente(cliente)
        sql = f"SELECT * FROM fiado_items WHERE deleted = 0 AND {cond}"
        params = list(params)
        if estado:
            sql += " AND estado = ?"
            params.append(estado)
        sql += " ORDER BY fecha DESC, id DESC LIMIT ?"
        params.append(int(limit))
        rows = self.db.execute_query(sql, tuple(params)) or []
        return [self._hidratar_item(r) for r in rows]

    def _hidratar_item(self, row: Dict) -> Dict:
        d = dict(row)
        d['cart_item'] = self._parse_json(d.get('item_json')) or {}
        return d

    def anular_item(self, item_id: int, motivo: str = '') -> None:
        """Saca un item de la deuda sin cobrarlo (se cargó por error, se devolvió)."""
        self.db.execute_update(
            "UPDATE fiado_items SET estado = 'anulado', nota = ?, "
            "updated_at = (SELECT localtime_now()) WHERE id = ?",
            (str(motivo or ''), int(item_id))
        )

    def editar_item(self, item_id: int, quantity: float = None,
                    unit_price: float = None, product_name: str = None,
                    nota: str = None) -> None:
        """Corrige una línea pendiente (cantidad anotada mal, precio, etc.).

        Recalcula el subtotal y mantiene `item_json` en sincronía para que la
        venta generada al cobrar use los valores corregidos.
        """
        item = self.get_item(item_id)
        if not item or item.get('estado') != 'pendiente':
            return
        qty   = float(quantity if quantity is not None else item.get('quantity') or 0)
        price = float(unit_price if unit_price is not None else item.get('unit_price') or 0)
        name  = str(product_name if product_name is not None else item.get('product_name') or '')
        subtotal = round(qty * price, 2)

        cart = item.get('cart_item') or {}
        cart['quantity']     = qty
        cart['unit_price']   = price
        cart['product_name'] = name
        cart['subtotal']     = subtotal
        # Un precio editado a mano invalida cualquier promo guardada en la línea.
        if price != float(item.get('unit_price') or 0):
            cart['original_price']  = price
            cart['discount_amount'] = 0
            cart['discount_type']   = None
            cart['promo_id']        = None
            cart['promo_label']     = ''

        self.db.execute_update(
            "UPDATE fiado_items SET quantity = ?, unit_price = ?, subtotal = ?, "
            "product_name = ?, item_json = ?, nota = COALESCE(?, nota), "
            "updated_at = (SELECT localtime_now()) WHERE id = ?",
            (qty, price, subtotal, name,
             json.dumps(cart, ensure_ascii=False, default=str),
             nota, int(item_id))
        )

    def marcar_items_pagados(self, item_ids: List[int], venta_id: Optional[int],
                             pago_fid: str = '') -> int:
        """Marca los items como pagados. Devuelve cuántas filas cambiaron.

        Sólo afecta filas que sigan en 'pendiente' — si otra PC ya las cobró,
        no se pisan (idempotente frente a cobros simultáneos).
        """
        ids = [int(i) for i in (item_ids or []) if i is not None]
        if not ids:
            return 0
        ph = ','.join(['?'] * len(ids))
        return self.db.execute_delete(
            f"UPDATE fiado_items SET estado = 'pagado', venta_id = ?, "
            f"pago_fid = ?, pagado_at = (SELECT localtime_now()), "
            f"updated_at = (SELECT localtime_now()) "
            f"WHERE id IN ({ph}) AND estado = 'pendiente'",
            tuple([venta_id, str(pago_fid or '')] + ids)
        )

    # ══════════════════════════════════════════════════
    #  PAGOS
    # ══════════════════════════════════════════════════
    def registrar_pago(self, cliente: Dict, tipo: str, monto: float,
                       metodo_pago: str = '', venta_id: Optional[int] = None,
                       item_ids: Optional[List[int]] = None,
                       credito_usado: float = 0.0, nota: str = '',
                       cajero: str = '', pc_id: str = '') -> int:
        if tipo not in TIPOS_PAGO:
            raise ValueError(f'Tipo de pago de fiado inválido: {tipo}')
        return self.db.execute_update(
            "INSERT INTO fiado_pagos "
            "(cliente_fid, cliente_local_id, cliente_nombre, tipo, monto, "
            " credito_usado, metodo_pago, venta_id, items_json, nota, pc_id, cajero) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (str(cliente.get('firebase_id') or ''), cliente.get('id'),
             str(cliente.get('nombre') or ''), tipo, round(float(monto or 0), 2),
             round(float(credito_usado or 0), 2), str(metodo_pago or ''),
             venta_id,
             json.dumps([int(i) for i in (item_ids or [])], ensure_ascii=False),
             str(nota or ''), str(pc_id or ''), str(cajero or ''))
        )

    def set_pago_firebase_id(self, pago_id: int, firebase_id: str) -> None:
        if not firebase_id:
            return
        self.db.execute_update(
            "UPDATE fiado_pagos SET firebase_id = ? WHERE id = ?",
            (str(firebase_id), int(pago_id))
        )

    def get_pago(self, pago_id: int) -> Optional[Dict]:
        rows = self.db.execute_query(
            "SELECT * FROM fiado_pagos WHERE id = ? LIMIT 1", (int(pago_id),)
        ) or []
        return rows[0] if rows else None

    def get_pagos(self, cliente: Dict, limit: int = 200) -> List[Dict]:
        cond, params = self._cond_cliente(cliente)
        rows = self.db.execute_query(
            f"SELECT * FROM fiado_pagos WHERE deleted = 0 AND {cond} "
            f"ORDER BY fecha DESC, id DESC LIMIT ?",
            tuple(list(params) + [int(limit)])
        ) or []
        for r in rows:
            r['items'] = self._parse_json(r.get('items_json')) or []
        return rows

    # ══════════════════════════════════════════════════
    #  RESUMEN GLOBAL
    # ══════════════════════════════════════════════════
    def resumen(self) -> Dict:
        """Totales para el badge/encabezado: deuda total y clientes con deuda."""
        rows = self.db.execute_query(
            "SELECT COALESCE(SUM(subtotal), 0) AS total, "
            "       COUNT(DISTINCT COALESCE(NULLIF(cliente_fid, ''), "
            "                               'local:' || cliente_local_id)) AS clientes "
            "FROM fiado_items WHERE deleted = 0 AND estado = 'pendiente'"
        ) or []
        if not rows:
            return {'total': 0.0, 'clientes': 0}
        return {
            'total':    round(float(rows[0]['total'] or 0), 2),
            'clientes': int(rows[0]['clientes'] or 0),
        }

    # ══════════════════════════════════════════════════
    #  SYNC DESDE FIREBASE
    # ══════════════════════════════════════════════════
    def upsert_cliente_from_firebase(self, firebase_id: str, data: Dict) -> Optional[int]:
        if not firebase_id:
            return None
        nombre = str(data.get('nombre') or '').strip()
        if not nombre:
            return None
        campos = (
            nombre,
            str(data.get('dni') or ''), str(data.get('telefono') or ''),
            str(data.get('email') or ''), str(data.get('direccion') or ''),
            str(data.get('notas') or ''),
            0 if data.get('activo') is False else 1,
            str(data.get('pc_id') or ''),
            1 if data.get('deleted') else 0,
        )
        existing = self.db.execute_query(
            "SELECT id FROM fiado_clientes WHERE firebase_id = ? LIMIT 1",
            (firebase_id,)
        ) or []
        if existing:
            cid = existing[0]['id']
            self.db.execute_update(
                "UPDATE fiado_clientes SET nombre = ?, dni = ?, telefono = ?, "
                "email = ?, direccion = ?, notas = ?, activo = ?, pc_id = ?, "
                "deleted = ?, updated_at = (SELECT localtime_now()) WHERE id = ?",
                campos + (cid,)
            )
            return cid
        # Reconciliar el doc con una fila local creada offline (mismo local_id
        # + misma PC) para no duplicar el cliente cuando vuelve por el listener.
        local_id = data.get('local_id')
        if local_id:
            match = self.db.execute_query(
                "SELECT id FROM fiado_clientes WHERE id = ? AND "
                "(firebase_id IS NULL OR firebase_id = '') LIMIT 1",
                (int(local_id),)
            ) or []
            if match:
                cid = match[0]['id']
                self.db.execute_update(
                    "UPDATE fiado_clientes SET firebase_id = ?, nombre = ?, dni = ?, "
                    "telefono = ?, email = ?, direccion = ?, notas = ?, activo = ?, "
                    "pc_id = ?, deleted = ?, updated_at = (SELECT localtime_now()) "
                    "WHERE id = ?",
                    (firebase_id,) + campos + (cid,)
                )
                self._reasignar_fid_local(cid, firebase_id)
                return cid
        return self.db.execute_update(
            "INSERT INTO fiado_clientes "
            "(firebase_id, nombre, dni, telefono, email, direccion, notas, "
            " activo, pc_id, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (firebase_id,) + campos
        )

    def _reasignar_fid_local(self, cliente_local_id: int, firebase_id: str) -> None:
        """Cuando un cliente creado offline recibe su firebase_id, se lo
        propagamos a sus items y pagos para que queden bajo la misma clave."""
        for tabla in ('fiado_items', 'fiado_pagos'):
            try:
                self.db.execute_update(
                    f"UPDATE {tabla} SET cliente_fid = ? "
                    f"WHERE cliente_local_id = ? AND (cliente_fid IS NULL OR cliente_fid = '')",
                    (str(firebase_id), int(cliente_local_id))
                )
            except Exception as e:
                logger.warning(f"fiado: no se pudo reasignar fid en {tabla}: {e}")

    def upsert_item_from_firebase(self, firebase_id: str, data: Dict) -> Optional[int]:
        if not firebase_id:
            return None
        nombre = str(data.get('product_name') or '').strip()
        if not nombre:
            return None
        estado = str(data.get('estado') or 'pendiente')
        if estado not in ESTADOS_ITEM:
            estado = 'pendiente'
        item_json = data.get('item_json')
        if isinstance(item_json, (dict, list)):
            item_json = json.dumps(item_json, ensure_ascii=False, default=str)
        campos = (
            str(data.get('cliente_fid') or ''),
            data.get('cliente_local_id'),
            str(data.get('cliente_nombre') or ''),
            str(data.get('entrega_id') or ''),
            int(data.get('product_id') or 0),
            str(data.get('product_fid') or ''),
            nombre,
            str(data.get('categoria') or ''),
            float(data.get('quantity') or 0),
            float(data.get('unit_price') or 0),
            float(data.get('subtotal') or 0),
            item_json,
            estado,
            data.get('venta_id'),
            str(data.get('pago_fid') or ''),
            str(data.get('nota') or ''),
            str(data.get('origen') or 'web'),
            str(data.get('pc_id') or ''),
            str(data.get('cajero') or ''),
            1 if data.get('deleted') else 0,
        )
        existing = self.db.execute_query(
            "SELECT id FROM fiado_items WHERE firebase_id = ? LIMIT 1", (firebase_id,)
        ) or []
        if existing:
            iid = existing[0]['id']
            self.db.execute_update(
                "UPDATE fiado_items SET cliente_fid = ?, cliente_local_id = ?, "
                "cliente_nombre = ?, entrega_id = ?, product_id = ?, product_fid = ?, "
                "product_name = ?, categoria = ?, quantity = ?, unit_price = ?, "
                "subtotal = ?, item_json = ?, estado = ?, venta_id = ?, pago_fid = ?, "
                "nota = ?, origen = ?, pc_id = ?, cajero = ?, deleted = ?, "
                "updated_at = (SELECT localtime_now()) WHERE id = ?",
                campos + (iid,)
            )
            return iid
        local_id = data.get('local_id')
        if local_id:
            match = self.db.execute_query(
                "SELECT id FROM fiado_items WHERE id = ? AND "
                "(firebase_id IS NULL OR firebase_id = '') LIMIT 1",
                (int(local_id),)
            ) or []
            if match:
                iid = match[0]['id']
                self.db.execute_update(
                    "UPDATE fiado_items SET firebase_id = ?, estado = ?, "
                    "venta_id = ?, deleted = ?, updated_at = (SELECT localtime_now()) "
                    "WHERE id = ?",
                    (firebase_id, estado, data.get('venta_id'),
                     1 if data.get('deleted') else 0, iid)
                )
                return iid
        fecha = data.get('fecha_str') or data.get('fecha')
        if isinstance(fecha, str) and fecha.strip():
            return self.db.execute_update(
                "INSERT INTO fiado_items "
                "(firebase_id, cliente_fid, cliente_local_id, cliente_nombre, "
                " entrega_id, product_id, product_fid, product_name, categoria, "
                " quantity, unit_price, subtotal, item_json, estado, venta_id, "
                " pago_fid, nota, origen, pc_id, cajero, deleted, fecha) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (firebase_id,) + campos + (fecha.strip(),)
            )
        return self.db.execute_update(
            "INSERT INTO fiado_items "
            "(firebase_id, cliente_fid, cliente_local_id, cliente_nombre, "
            " entrega_id, product_id, product_fid, product_name, categoria, "
            " quantity, unit_price, subtotal, item_json, estado, venta_id, "
            " pago_fid, nota, origen, pc_id, cajero, deleted) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (firebase_id,) + campos
        )

    def upsert_pago_from_firebase(self, firebase_id: str, data: Dict) -> Optional[int]:
        if not firebase_id:
            return None
        tipo = str(data.get('tipo') or 'productos')
        if tipo not in TIPOS_PAGO:
            tipo = 'productos'
        items_json = data.get('items_json') or data.get('items')
        if isinstance(items_json, (dict, list)):
            items_json = json.dumps(items_json, ensure_ascii=False, default=str)
        campos = (
            str(data.get('cliente_fid') or ''),
            data.get('cliente_local_id'),
            str(data.get('cliente_nombre') or ''),
            tipo,
            float(data.get('monto') or 0),
            float(data.get('credito_usado') or 0),
            str(data.get('metodo_pago') or ''),
            data.get('venta_id'),
            items_json,
            str(data.get('nota') or ''),
            str(data.get('pc_id') or ''),
            str(data.get('cajero') or ''),
            1 if data.get('deleted') else 0,
        )
        existing = self.db.execute_query(
            "SELECT id FROM fiado_pagos WHERE firebase_id = ? LIMIT 1", (firebase_id,)
        ) or []
        if existing:
            pid = existing[0]['id']
            self.db.execute_update(
                "UPDATE fiado_pagos SET cliente_fid = ?, cliente_local_id = ?, "
                "cliente_nombre = ?, tipo = ?, monto = ?, credito_usado = ?, "
                "metodo_pago = ?, venta_id = ?, items_json = ?, nota = ?, "
                "pc_id = ?, cajero = ?, deleted = ? WHERE id = ?",
                campos + (pid,)
            )
            return pid
        local_id = data.get('local_id')
        if local_id:
            match = self.db.execute_query(
                "SELECT id FROM fiado_pagos WHERE id = ? AND "
                "(firebase_id IS NULL OR firebase_id = '') LIMIT 1",
                (int(local_id),)
            ) or []
            if match:
                self.db.execute_update(
                    "UPDATE fiado_pagos SET firebase_id = ? WHERE id = ?",
                    (firebase_id, match[0]['id'])
                )
                return match[0]['id']
        fecha = data.get('fecha_str') or data.get('fecha')
        if isinstance(fecha, str) and fecha.strip():
            return self.db.execute_update(
                "INSERT INTO fiado_pagos "
                "(firebase_id, cliente_fid, cliente_local_id, cliente_nombre, tipo, "
                " monto, credito_usado, metodo_pago, venta_id, items_json, nota, "
                " pc_id, cajero, deleted, fecha) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (firebase_id,) + campos + (fecha.strip(),)
            )
        return self.db.execute_update(
            "INSERT INTO fiado_pagos "
            "(firebase_id, cliente_fid, cliente_local_id, cliente_nombre, tipo, "
            " monto, credito_usado, metodo_pago, venta_id, items_json, nota, "
            " pc_id, cajero, deleted) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (firebase_id,) + campos
        )

    @staticmethod
    def _parse_json(raw):
        if not raw:
            return None
        if isinstance(raw, (dict, list)):
            return raw
        try:
            return json.loads(raw)
        except Exception:
            return None
