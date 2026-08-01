import json
import logging
import math
import threading
from datetime import datetime
from pos_system.utils.firebase_sync import now_ar
from typing import List, Dict, Optional
from pos_system.database.db_manager import DatabaseManager

logger = logging.getLogger(__name__)

class Sale:
    """Modelo para ventas"""
    
    def __init__(self, db_manager: DatabaseManager):
        self.db = db_manager
    
    def create(self, sale_data: dict) -> int:
        """
        Crea una nueva venta con sus items en una sola transacción atómica.
        sale_data: dict con keys: items, payment_type, total_amount
        items: Lista de diccionarios con {product_id, product_name, quantity, unit_price}
        payment_type: 'cash' o 'transfer'
        """
        items = sale_data.get('items', [])
        payment_type = sale_data.get('payment_type')
        total_amount = sale_data.get('total_amount')

        if not items:
            raise ValueError("La venta debe tener al menos un item")
        if payment_type not in ('cash', 'transfer', 'mixed'):
            raise ValueError(f"Tipo de pago inválido: {payment_type}")
        if total_amount is None or total_amount <= 0:
            raise ValueError("El monto total debe ser mayor a cero")

        # Obtener caja registradora actual
        cash_register = self.db.get_current_cash_register()
        cash_register_id = cash_register['id'] if cash_register else None

        cash_received = sale_data.get('cash_received', 0) or 0
        change_given = sale_data.get('change_given', 0) or 0
        # transfer_amount: parte de transferencia en pago mixto (0 si no aplica)
        transfer_amount = sale_data.get('transfer_amount', 0) or 0
        user_id = sale_data.get('user_id')
        notes = sale_data.get('notes', '')
        turno_nombre = sale_data.get('turno_nombre', '') or ''
        # Cobro de fiado: la venta salda una cuenta corriente. Se guarda para
        # que el historial local y la webapp la distingan de una venta común.
        es_fiado          = 1 if sale_data.get('es_fiado') else 0
        fiado_tipo        = str(sale_data.get('fiado_tipo') or '')
        fiado_cliente     = str(sale_data.get('fiado_cliente') or '')
        fiado_cliente_fid = str(sale_data.get('fiado_cliente_fid') or '')

        # Validar consistencia para pago mixto
        if payment_type == 'mixed':
            suma = round(float(cash_received) + float(transfer_amount), 2)
            if abs(suma - float(total_amount)) > 0.01:
                raise ValueError(
                    f"Pago mixto inconsistente: efectivo {cash_received} + "
                    f"transferencia {transfer_amount} = {suma} ≠ total {total_amount}"
                )

        # Todo en una sola transacción atómica
        with self.db.get_connection() as conn:
            cursor = conn.cursor()

            # 1. Crear la venta — pasamos created_at explícito en hora AR para
            #    no depender del DEFAULT de la tabla (bases viejas lo tienen
            #    como CURRENT_TIMESTAMP = UTC)
            created_at_ar = now_ar().strftime('%Y-%m-%d %H:%M:%S')
            cursor.execute(
                "INSERT INTO sales (total_amount, payment_type, cash_received, change_given, transfer_amount, cash_register_id, user_id, notes, turno_nombre, created_at, es_fiado, fiado_tipo, fiado_cliente, fiado_cliente_fid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (total_amount, payment_type, cash_received, change_given, transfer_amount, cash_register_id, user_id, notes, turno_nombre, created_at_ar,
                 es_fiado, fiado_tipo, fiado_cliente, fiado_cliente_fid)
            )
            sale_id = cursor.lastrowid

            # 2. Insertar items y actualizar stock
            now_iso = datetime.now().isoformat()
            mp_para_sync_remoto = []   # items mp_* a sincronizar con Firestore después del commit
            # Vínculos consumibles: targets que recibieron descuento por vinculación.
            # Cada entry: {item_idx, target_firebase_id, target_local_id, is_conjunto, delta}.
            # Se sincronizan a Firestore en background tras commit y marca consumibles_procesado
            # en ventas_por_dia/{pc_id}_{sale_id}_{item_idx}.
            vincs_para_sync_remoto = []
            for item_idx, item in enumerate(items):
                subtotal       = item['quantity'] * item['unit_price']
                original_price = item.get('original_price', item['unit_price'])
                discount_type  = item.get('discount_type') or None
                discount_value = item.get('discount_value', 0) or 0
                discount_amount= item.get('discount_amount', 0) or 0
                promo_id       = item.get('promo_id') or None
                conjunto_color = (item.get('conjunto_color') or '').strip() or None
                # Productos Madre (mp_*) — usan product_id=0 (sentinel "Varios") en sale_items
                # y los IDs reales viven en columnas mp_* dedicadas.
                is_mp                  = bool(item.get('is_mp'))
                mp_product_id          = item.get('mp_product_id') if is_mp else None
                mp_node_id_val         = item.get('mp_node_id') if is_mp else None
                mp_presentation_id_val = item.get('mp_presentation_id') if is_mp else None
                product_id_for_db      = 0 if is_mp else item['product_id']
                cursor.execute(
                    """INSERT INTO sale_items
                       (sale_id, product_id, product_name, quantity,
                        unit_price, original_price, discount_type,
                        discount_value, discount_amount, promo_id, subtotal,
                        conjunto_color, mp_product_id, mp_node_id, mp_presentation_id)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (sale_id, product_id_for_db, item['product_name'],
                     item['quantity'], item['unit_price'], original_price,
                     discount_type, discount_value, discount_amount,
                     promo_id, subtotal, conjunto_color,
                     mp_product_id, mp_node_id_val, mp_presentation_id_val)
                )
                self._aplicar_stock_de_item(
                    cursor, item, item_idx, now_iso,
                    mp_para_sync_remoto, vincs_para_sync_remoto,
                    usuario=turno_nombre,
                )

            # 3. Actualizar caja registradora
            if cash_register_id:
                if payment_type == 'cash':
                    cursor.execute(
                        "UPDATE cash_register SET cash_sales = cash_sales + ?, total_sales = total_sales + ? WHERE id = ?",
                        (total_amount, total_amount, cash_register_id)
                    )
                elif payment_type == 'mixed':
                    # Parte efectivo + parte transferencia
                    cash_part = float(cash_received) - float(change_given)  # neto en caja
                    trans_part = float(transfer_amount)
                    cursor.execute(
                        "UPDATE cash_register SET cash_sales = cash_sales + ?, "
                        "transfer_sales = transfer_sales + ?, "
                        "total_sales = total_sales + ? WHERE id = ?",
                        (cash_part, trans_part, total_amount, cash_register_id)
                    )
                else:
                    cursor.execute(
                        "UPDATE cash_register SET transfer_sales = transfer_sales + ?, total_sales = total_sales + ? WHERE id = ?",
                        (total_amount, total_amount, cash_register_id)
                    )

        logger.info(f"Venta creada: ID={sale_id}, total=${total_amount:.2f}, pago={payment_type}")

        # ── Sync remoto de mp_* (best-effort, en background) ─────────────────
        # Ya descontamos stock localmente (atómico con la venta). Acá empujamos
        # los cambios a Firestore y registramos los movimientos. Si falla por red,
        # la venta queda consistente local; el listener de Firebase corregirá la
        # diferencia cuando la otra punta vuelva a estar online.
        if mp_para_sync_remoto:
            threading.Thread(
                target=self._sync_mp_to_firebase,
                args=(mp_para_sync_remoto,),
                daemon=True,
            ).start()

        # ── Sync remoto de vinculaciones (catalogo-level) ────────────────────
        # Ya descontamos stock de los targets en SQLite. Acá pusheamos los
        # nuevos stocks/conjunto_* al catalogo en Firestore y marcamos los items
        # con `consumibles_procesado: True` en ventas_por_dia (evita que el
        # watcher web duplique el descuento).
        if vincs_para_sync_remoto:
            threading.Thread(
                target=self._sync_vincs_to_firebase,
                args=(sale_id, vincs_para_sync_remoto),
                daemon=True,
            ).start()

        # Sincronizar resumen mensual
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if fb:
                now = now_ar()
                month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
                month_sales = self.get_all(
                    start_date=month_start.strftime('%Y-%m-%d 00:00:00'),
                    end_date=now.strftime('%Y-%m-%d 23:59:59')
                )
                fb.sync_monthly_summary(now.year, now.month, month_sales)
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(f'Error syncing monthly summary: {e}')
        
        return sale_id

    # ── Descuento de stock de una línea ───────────────────────────────────
    def _aplicar_stock_de_item(self, cursor, item: Dict, item_idx: int,
                               now_iso: str,
                               mp_acumulador: List[Dict],
                               vincs_acumulador: List[Dict],
                               usuario: str = '') -> None:
        """Aplica a SQLite el descuento de stock de UNA línea de carrito.

        Cubre los tres tipos de producto del sistema:
          - Producto Madre (mp_*): descuenta de mp_nodes.presentaciones.
          - Producto conjunto: recalcula unidades / restante / total (por color
            si el item trae `conjunto_color`).
          - Producto plano: `stock = stock - cantidad` (stock=-1 = ilimitado).
        Y en todos los casos aplica las vinculaciones a productos fuente.

        Los acumuladores recogen lo que hay que empujar a Firestore después del
        commit. Está extraído de create() para poder reusarlo cuando se salda
        un fiado con saldo a favor: ahí sale mercadería sin venta asociada.
        """
        is_mp = bool(item.get('is_mp'))
        if is_mp:
            # Producto Madre: descontar stock de mp_nodes.presentaciones (sueltos
            # primero, abrir contenedor cuando se agotan). Resolvemos la presentación
            # efectiva (si es vinculada al rollo/pack, descuenta de la fuente).
            target_pres_id = self._deduct_mp_stock_local(cursor, item, now_iso)
            if target_pres_id:
                mp_acumulador.append({
                    'node_id':         item.get('mp_node_id'),
                    'presentation_id': target_pres_id,
                    'qty':             float(item.get('quantity') or 0),
                    'product_id':      item.get('mp_product_id') or '',
                    'user':            usuario or '',
                })
            return  # no descontar `products.stock` para mp_*

        # Vínculos a productos fuente (consumibles, nivel producto). Si el
        # producto vendido está vinculado a otro(s) de stock, su stock
        # PROPIO no se descuenta (quedaría negativo): el stock real vive en
        # los targets, que se descuentan en _aplicar_vinculaciones_local.
        vincs_prod = self._parse_vinculos_producto(cursor, item['product_id'])

        if item.get('is_conjunto'):
            # Producto conjunto: no se descuenta stock clásico.
            # Si el item viene con `conjunto_color`, actualizamos el
            # color dentro del array `conjunto_colores` y recomputamos
            # los agregados planos (unidades / restante / total) como
            # SUMA de todos los colores. Si no trae color (legacy o
            # producto sin colores), updateamos los planos directamente.
            after_u = float(item.get('conjunto_after_unidades') or 0)
            after_r = float(item.get('conjunto_after_restante') or 0)
            color = (item.get('conjunto_color') or '').strip()
            row = cursor.execute(
                "SELECT conjunto_contenido, conjunto_colores "
                "FROM products WHERE id = ?",
                (item['product_id'],)
            ).fetchone()
            contenido = float(row[0]) if row and row[0] is not None else 0.0
            colores_raw = row[1] if row and len(row) > 1 else None

            if color and colores_raw:
                try:
                    colores = json.loads(colores_raw)
                    if not isinstance(colores, list):
                        colores = []
                except Exception:
                    colores = []
                # Actualizar el color correspondiente
                encontrado = False
                for c in colores:
                    if isinstance(c, dict) and str(c.get('color', '')).strip() == color:
                        c['unidades'] = after_u
                        c['restante'] = after_r
                        encontrado = True
                        break
                if not encontrado:
                    colores.append({
                        'color':    color,
                        'unidades': after_u,
                        'restante': after_r,
                    })
                # Agregados = suma de todos los colores
                sum_u = sum(float(c.get('unidades') or 0) for c in colores if isinstance(c, dict))
                sum_r = sum(float(c.get('restante') or 0) for c in colores if isinstance(c, dict))
                sum_total = sum(
                    float(c.get('unidades') or 0) * contenido + float(c.get('restante') or 0)
                    for c in colores if isinstance(c, dict)
                )
                cursor.execute(
                    """UPDATE products
                       SET conjunto_unidades = ?,
                           conjunto_restante = ?,
                           conjunto_total    = ?,
                           conjunto_colores  = ?,
                           updated_at        = ?
                       WHERE id = ?""",
                    (sum_u, sum_r, sum_total,
                     json.dumps(colores, ensure_ascii=False),
                     now_iso, item['product_id'])
                )
            else:
                # Legacy / sin colores: usar after_u / after_r directos
                after_total = after_u * contenido + after_r
                cursor.execute(
                    """UPDATE products
                       SET conjunto_unidades = ?,
                           conjunto_restante = ?,
                           conjunto_total    = ?,
                           updated_at        = ?
                       WHERE id = ?""",
                    (after_u, after_r, after_total, now_iso, item['product_id'])
                )
        else:
            # Descontar stock — se permite vender aunque no haya stock
            # suficiente. EXCEPTO si el producto está vinculado: en ese
            # caso el stock real vive en los productos fuente (se descuentan
            # más abajo) y NO se toca el propio para que no quede negativo.
            if not vincs_prod:
                cursor.execute(
                    "UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ? AND stock != -1",
                    (item['quantity'], now_iso, item['product_id'])
                )
            # stock = -1 significa servicio/ilimitado, no se descuenta

        # ── Vínculos consumibles (catalogo-level) ────────────────────
        # Si el producto vendido tiene `vinculaciones`, descontar stock
        # de los productos target en la misma transacción. Si el target
        # es conjunto, se recalcula conjunto_total/unidades/restante
        # para que el modal del webapp muestre el número correcto.
        # Idempotente con el watcher web: post-commit marcamos los items
        # con `consumibles_procesado: True` en ventas_por_dia.
        self._aplicar_vinculaciones_local(
            cursor, item, item_idx, now_iso, vincs_acumulador, vincs_prod
        )

    def descontar_stock_items(self, items: List[Dict], usuario: str = '') -> None:
        """Descuenta stock de una lista de líneas SIN generar una venta.

        Único caso de uso: saldar productos fiados con saldo a favor del cliente.
        La plata ya entró a la caja cuando el cliente la dejó "a cuenta" (esa
        entrega generó su propia venta), así que crear otra venta acá contaría
        el dinero dos veces — pero la mercadería sí sale ahora y el stock tiene
        que reflejarlo.

        Usa exactamente el mismo motor de descuento que una venta normal y
        propaga los cambios a Firebase igual que ella.
        """
        items = [it for it in (items or []) if it]
        if not items:
            return

        now_iso = datetime.now().isoformat()
        mp_para_sync_remoto = []
        vincs_para_sync_remoto = []

        with self.db.get_connection() as conn:
            cursor = conn.cursor()
            for idx, item in enumerate(items):
                self._aplicar_stock_de_item(
                    cursor, item, idx, now_iso,
                    mp_para_sync_remoto, vincs_para_sync_remoto,
                    usuario=usuario,
                )

        if mp_para_sync_remoto:
            threading.Thread(
                target=self._sync_mp_to_firebase,
                args=(mp_para_sync_remoto,),
                daemon=True,
            ).start()
        if vincs_para_sync_remoto:
            # sale_id=None → sync_vinculaciones_after_sale sólo empuja el stock
            # de los targets y no intenta marcar docs de `ventas_por_dia`.
            threading.Thread(
                target=self._sync_vincs_to_firebase,
                args=(None, vincs_para_sync_remoto),
                daemon=True,
            ).start()

        # Propagar el stock ya descontado al catálogo/inventario en Firebase.
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if fb and getattr(fb, 'enabled', False):
                fb.sync_stock_after_sale(items, self.db)
        except Exception as e:
            logger.warning(f"descontar_stock_items: push de stock a Firebase falló: {e}")

    # ── Productos Madre (mp_*) ────────────────────────────────────────────
    def _deduct_mp_stock_local(self, cursor, item: Dict, now_iso: str) -> Optional[str]:
        """Aplica el descuento de stock sobre mp_nodes.presentaciones (JSON) en la
        misma transacción de la venta. Devuelve el id de la presentación target
        (la fuente, si la presentación vendida es vinculada) para que el caller
        sincronice ese mismo a Firestore. None si el nodo o presentación no se
        encuentra (la venta sigue OK; queda warning en log).

        Lógica de descuento:
          1) Tomar primero de stock_sueltos.
          2) Si quedó cantidad pendiente, abrir contenedores enteros
             (decrementar `stock` de a 1, sumar equivalencia_base a sueltos).
          3) Si la presentación vendida tiene stock_modo='vinculado' y
             vinculada_a, redirigimos el descuento a la fuente.
        """
        node_id = item.get('mp_node_id')
        pres_id = item.get('mp_presentation_id')
        qty     = float(item.get('quantity') or 0)
        if not node_id or not pres_id or qty <= 0:
            return None

        row = cursor.execute(
            "SELECT presentaciones FROM mp_nodes WHERE id = ?",
            (node_id,),
        ).fetchone()
        if not row or not row[0]:
            logger.warning(f"_deduct_mp_stock_local: nodo {node_id} no encontrado en mp_nodes")
            return None
        try:
            presentaciones = json.loads(row[0])
            if not isinstance(presentaciones, list):
                presentaciones = []
        except Exception as e:
            logger.warning(f"_deduct_mp_stock_local: presentaciones JSON inválido en {node_id}: {e}")
            return None

        # Localizar la presentación vendida y resolver fuente si es vinculada
        pres = next((p for p in presentaciones if (p.get('id') or '') == pres_id), None)
        if not pres:
            logger.warning(f"_deduct_mp_stock_local: presentación {pres_id} no existe en {node_id}")
            return None
        target = pres
        if pres.get('stock_modo') == 'vinculado' and pres.get('vinculada_a'):
            fuente = next(
                (p for p in presentaciones if (p.get('id') or '') == pres['vinculada_a']),
                None,
            )
            if fuente:
                target = fuente

        # Aplicar la lógica sueltos → contenedores
        target_idx = next(
            i for i, p in enumerate(presentaciones)
            if (p.get('id') or '') == (target.get('id') or '')
        )
        t = dict(presentaciones[target_idx])
        pendiente = qty
        sueltos = float(t.get('stock_sueltos') or 0)
        if sueltos > 0:
            usar = min(pendiente, sueltos)
            t['stock_sueltos'] = sueltos - usar
            pendiente -= usar
        if pendiente > 0:
            equiv = float(t.get('equivalencia_base') or 0)
            if equiv > 0:
                contenedores = int(math.ceil(pendiente / equiv))
                t['stock'] = max(0.0, float(t.get('stock') or 0) - contenedores)
                sobrante = (contenedores * equiv) - pendiente
                t['stock_sueltos'] = float(t.get('stock_sueltos') or 0) + sobrante
            else:
                t['stock'] = max(0.0, float(t.get('stock') or 0) - pendiente)
        presentaciones[target_idx] = t

        # Persistir en SQLite local (en la misma transacción)
        cursor.execute(
            "UPDATE mp_nodes SET presentaciones = ?, actualizado = ? WHERE id = ?",
            (json.dumps(presentaciones, ensure_ascii=False), now_iso, node_id),
        )
        return target.get('id')

    def _sync_mp_to_firebase(self, items_to_sync: List[Dict]) -> None:
        """Empuja a Firestore el descuento de stock + registra mp_stock_movements
        de cada item mp_* vendido. Llamado en background tras commit local.
        """
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if not fb or not getattr(fb, 'enabled', False):
                return
            for it in items_to_sync:
                try:
                    fb.deduct_mp_stock(
                        node_id=it['node_id'],
                        presentation_id=it['presentation_id'],
                        delta_qty=it['qty'],
                        product_id=it.get('product_id') or '',
                        motivo='venta',
                        user=it.get('user') or '',
                        db_manager=self.db,  # espejo local del movimiento
                    )
                except Exception as e:
                    logger.warning(f"_sync_mp_to_firebase: item {it} falló: {e}")
        except Exception as e:
            logger.warning(f"_sync_mp_to_firebase: error general: {e}")

    # ── Vínculos consumibles (catalogo-level) ──────────────────────────────
    def _parse_vinculos_producto(self, cursor, product_id) -> List[Dict]:
        """Devuelve los vínculos normalizados de un producto del catálogo como
        lista de {doc_id, cantidad, nombre}. Soporta el array nuevo `vinculaciones`
        (JSON) y los campos legacy vinculado_a/_cantidad/_nombre. [] si no tiene,
        no existe o es el sentinel mp_* (id=0)."""
        if not product_id or product_id == 0:
            return []
        row = cursor.execute(
            "SELECT vinculaciones, vinculado_a, vinculado_cantidad, vinculado_nombre "
            "FROM products WHERE id = ?",
            (product_id,)
        ).fetchone()
        if not row:
            return []

        vincs_raw, vinc_a_legacy, vinc_cant_legacy, vinc_nom_legacy = row
        vincs = []
        if vincs_raw:
            try:
                parsed = json.loads(vincs_raw)
                if isinstance(parsed, list):
                    vincs = parsed
            except Exception:
                vincs = []
        # Fallback legacy: si no hay array pero hay vinculado_a/cantidad.
        if not vincs and vinc_a_legacy:
            try:
                cant_legacy = float(vinc_cant_legacy or 0)
            except (TypeError, ValueError):
                cant_legacy = 0.0
            if cant_legacy > 0:
                vincs = [{
                    'doc_id':   str(vinc_a_legacy),
                    'cantidad': cant_legacy,
                    'nombre':   vinc_nom_legacy or '',
                }]

        # Normalizar: descartar entries inválidas.
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
                out.append({'doc_id': did, 'cantidad': cant, 'nombre': v.get('nombre') or ''})
        return out

    def _aplicar_vinculaciones_local(self, cursor, item: Dict, item_idx: int,
                                     now_iso: str,
                                     acumulador_remoto: List[Dict],
                                     vincs: Optional[List[Dict]] = None) -> None:
        """Si el producto vendido tiene `vinculaciones`, descuenta stock de
        cada target en SQLite y acumula info para el sync remoto.

        `vincs`: vínculos ya parseados (de _parse_vinculos_producto). Si es None,
        se parsean acá. Permite reusar el parseo que ya hizo create() para decidir
        si saltear el descuento del stock propio.

        Soporta dos tipos de target:
          - Producto plano: stock = max(0, stock - delta)
          - Producto conjunto: recalcula conjunto_total/unidades/restante
            respetando el invariante total = (cerrados × contenido) + restante

        Skip si:
          - producto vendido es sentinel mp_* (id=0) o sin id
          - target tiene `conjunto_colores` (variedades) → descuento ambiguo
          - target con stock=-1 (servicio/ilimitado)
        """
        qty_vendida = float(item.get('quantity') or 0)
        if qty_vendida <= 0:
            return
        pid_vendido = item.get('product_id')
        if not pid_vendido or pid_vendido == 0:
            return

        if vincs is None:
            vincs = self._parse_vinculos_producto(cursor, pid_vendido)
        if not vincs:
            return

        seen = set()
        for v in vincs:
            if not isinstance(v, dict):
                continue
            target_fid = str(v.get('doc_id') or '').strip()
            try:
                cant_por_venta = float(v.get('cantidad') or 0)
            except (TypeError, ValueError):
                cant_por_venta = 0.0
            if not target_fid or cant_por_venta <= 0:
                continue
            if target_fid in seen:
                continue
            seen.add(target_fid)

            delta = qty_vendida * cant_por_venta

            target_row = cursor.execute(
                "SELECT id, stock, es_conjunto, conjunto_total, "
                "       conjunto_contenido, conjunto_colores "
                "FROM products WHERE firebase_id = ?",
                (target_fid,)
            ).fetchone()
            if not target_row:
                logger.warning(
                    f"_aplicar_vinculaciones_local: target firebase_id={target_fid} "
                    f"no existe en SQLite (¿catálogo sin sync?)"
                )
                continue

            t_local_id, t_stock, t_es_conj, t_total, t_contenido, t_colores = target_row
            t_stock      = float(t_stock or 0)
            t_es_conj    = bool(t_es_conj)
            t_total      = float(t_total or 0)
            t_contenido  = float(t_contenido or 0)

            # Servicio/ilimitado: no descontar.
            if t_stock == -1:
                continue

            # Target con variedades: descuento ambiguo, skip con warning.
            if t_colores:
                logger.info(
                    f"_aplicar_vinculaciones_local: target {target_fid} tiene "
                    f"conjunto_colores, skip (ambiguo cuál variedad descontar)."
                )
                continue

            if t_es_conj and t_contenido > 0:
                nuevo_total = max(0.0, t_total - delta)
                cerrados    = int(nuevo_total // t_contenido)
                resto       = nuevo_total - cerrados * t_contenido
                if resto > 0:
                    nueva_unid = cerrados + 1
                    nueva_rest = resto
                else:
                    nueva_unid = cerrados
                    nueva_rest = 0
                # `stock` clásico = espejo entero del total para que el POS que
                # aún no entiende conjunto vea un stock razonable.
                stock_mirror = max(0, int(nuevo_total))
                cursor.execute(
                    """UPDATE products
                       SET stock             = ?,
                           conjunto_total    = ?,
                           conjunto_unidades = ?,
                           conjunto_restante = ?,
                           updated_at        = ?
                       WHERE id = ?""",
                    (stock_mirror, nuevo_total, nueva_unid, nueva_rest,
                     now_iso, t_local_id)
                )
                acumulador_remoto.append({
                    'item_idx':        item_idx,
                    'target_local_id': t_local_id,
                    'target_fid':      target_fid,
                    'is_conjunto':     True,
                    'delta':           delta,
                    'contexto':        item.get('product_name') or '',
                })
            else:
                nuevo_stock = max(0.0, t_stock - delta)
                cursor.execute(
                    "UPDATE products SET stock = ?, updated_at = ? WHERE id = ?",
                    (nuevo_stock, now_iso, t_local_id)
                )
                acumulador_remoto.append({
                    'item_idx':        item_idx,
                    'target_local_id': t_local_id,
                    'target_fid':      target_fid,
                    'is_conjunto':     False,
                    'delta':           delta,
                    'contexto':        item.get('product_name') or '',
                })

    def _sync_vincs_to_firebase(self, sale_id: int,
                                vincs_to_sync: List[Dict]) -> None:
        """Empuja a Firestore el descuento de los targets vinculados + marca
        cada item afectado en `ventas_por_dia` con `consumibles_procesado: True`.
        Llamado en background tras commit local.
        """
        try:
            from pos_system.utils.firebase_sync import get_firebase_sync
            fb = get_firebase_sync()
            if not fb or not getattr(fb, 'enabled', False):
                return
            fb.sync_vinculaciones_after_sale(sale_id, vincs_to_sync, self.db)
        except Exception as e:
            logger.warning(f"_sync_vincs_to_firebase: error general: {e}")

    def update(self, sale_id: int, payment_type: Optional[str] = None,
               items_updates: Optional[List[Dict]] = None) -> Optional[Dict]:
        """Edita una venta existente: tipo de pago y/o precios unitarios de items.

        items_updates: lista de {'id': sale_item_id, 'unit_price': nuevo_precio}
        Recalcula subtotales e total_amount, y ajusta la caja (cash_register) para
        reflejar los cambios. Todo en una transacción atómica.

        Retorna la venta actualizada (con items) o None si no existe.
        """
        sale = self.get_by_id(sale_id)
        if not sale:
            return None
        if payment_type is not None and payment_type not in ('cash', 'transfer'):
            raise ValueError(f"Tipo de pago inválido: {payment_type}")

        old_total    = float(sale.get('total_amount', 0) or 0)
        old_ptype    = sale.get('payment_type')
        register_id  = sale.get('cash_register_id')
        new_ptype    = payment_type if payment_type is not None else old_ptype

        with self.db.get_connection() as conn:
            cursor = conn.cursor()

            # 1. Actualizar items si hay cambios de precio
            if items_updates:
                for upd in items_updates:
                    item_id   = upd.get('id')
                    new_price = upd.get('unit_price')
                    if item_id is None or new_price is None:
                        continue
                    cursor.execute(
                        "SELECT quantity, discount_amount FROM sale_items WHERE id = ? AND sale_id = ?",
                        (int(item_id), sale_id)
                    )
                    row = cursor.fetchone()
                    if not row:
                        continue
                    qty        = int(row[0] if row[0] is not None else 1)
                    disc_amt   = float(row[1] or 0)
                    new_price  = float(new_price)
                    new_sub    = max(0.0, new_price * qty - disc_amt)
                    cursor.execute(
                        "UPDATE sale_items SET unit_price = ?, subtotal = ? WHERE id = ?",
                        (new_price, new_sub, int(item_id))
                    )

            # 2. Recalcular total desde items actualizados
            cursor.execute(
                "SELECT COALESCE(SUM(subtotal), 0) FROM sale_items WHERE sale_id = ?",
                (sale_id,)
            )
            new_total = float(cursor.fetchone()[0] or 0)

            # 3. Actualizar venta (total + tipo de pago)
            cursor.execute(
                "UPDATE sales SET total_amount = ?, payment_type = ? WHERE id = ?",
                (new_total, new_ptype, sale_id)
            )

            # 4. Ajustar caja registradora: revertir el aporte viejo y sumar el nuevo.
            #    Se hace aunque la caja esté cerrada — get_closing_report lee la tabla
            #    cash_register, así que queda consistente en Firebase al re-sincronizar.
            if register_id:
                # Revertir venta vieja
                if old_ptype == 'cash':
                    cursor.execute(
                        "UPDATE cash_register SET cash_sales = cash_sales - ?, total_sales = total_sales - ? WHERE id = ?",
                        (old_total, old_total, register_id)
                    )
                else:
                    cursor.execute(
                        "UPDATE cash_register SET transfer_sales = transfer_sales - ?, total_sales = total_sales - ? WHERE id = ?",
                        (old_total, old_total, register_id)
                    )
                # Sumar venta nueva
                if new_ptype == 'cash':
                    cursor.execute(
                        "UPDATE cash_register SET cash_sales = cash_sales + ?, total_sales = total_sales + ? WHERE id = ?",
                        (new_total, new_total, register_id)
                    )
                else:
                    cursor.execute(
                        "UPDATE cash_register SET transfer_sales = transfer_sales + ?, total_sales = total_sales + ? WHERE id = ?",
                        (new_total, new_total, register_id)
                    )

        logger.info(
            f"Venta #{sale_id} actualizada: total ${old_total:.2f}→${new_total:.2f}, "
            f"pago {old_ptype}→{new_ptype}"
        )
        return self.get_by_id(sale_id)

    def _update_cash_register(self, cash_register_id: int, amount: float, payment_type: str):
        """Actualiza los totales de la caja registradora (método legacy, usar transacción en create())"""
        if payment_type == 'cash':
            query = """
                UPDATE cash_register 
                SET cash_sales = cash_sales + ?,
                    total_sales = total_sales + ?
                WHERE id = ?
            """
        else:
            query = """
                UPDATE cash_register 
                SET transfer_sales = transfer_sales + ?,
                    total_sales = total_sales + ?
                WHERE id = ?
            """
        self.db.execute_update(query, (amount, amount, cash_register_id))
    
    def get_by_id(self, sale_id: int) -> Optional[Dict]:
        """Obtiene una venta por su ID con sus items"""
        sale_query = "SELECT * FROM sales WHERE id = ?"
        sale_result = self.db.execute_query(sale_query, (sale_id,))
        
        if not sale_result:
            return None
        
        sale = sale_result[0]
        
        # Obtener items de la venta
        items_query = "SELECT * FROM sale_items WHERE sale_id = ?"
        items = self.db.execute_query(items_query, (sale_id,))
        sale['items'] = items
        
        return sale
    
    def get_all(self, start_date: str = None, end_date: str = None,
                payment_type: str = None, limit: int = None,
                offset: int = 0) -> List[Dict]:
        """Obtiene todas las ventas con filtros opcionales.
        limit:  si se pasa, corta el resultado (las ventas más recientes primero).
        offset: salta las primeras N filas — usado por la UI para paginar
                (carga 30 a 30 con scroll infinito sin traer miles a la vez).
        """
        query = "SELECT * FROM sales WHERE 1=1"
        params = []

        if start_date:
            query += " AND created_at >= ?"
            params.append(start_date)

        if end_date:
            query += " AND created_at <= ?"
            params.append(end_date)

        if payment_type:
            query += " AND payment_type = ?"
            params.append(payment_type)

        # Orden estable: desempate por id para ventas con el mismo timestamp.
        query += " ORDER BY created_at DESC, id DESC"
        if limit and int(limit) > 0:
            query += f" LIMIT {int(limit)}"
            # OFFSET sólo aplica si hay LIMIT — SQLite lo requiere así.
            if offset and int(offset) > 0:
                query += f" OFFSET {int(offset)}"
        return self.db.execute_query(query, tuple(params))
    
    def get_today_sales(self) -> List[Dict]:
        """Obtiene las ventas del día actual"""
        today = now_ar().strftime("%Y-%m-%d")
        return self.get_all(start_date=f"{today} 00:00:00", end_date=f"{today} 23:59:59")

    def get_sales_summary(self, start_date: str = None, end_date: str = None) -> Dict:
        """Obtiene resumen de ventas"""
        if not start_date:
            start_date = now_ar().strftime("%Y-%m-%d") + " 00:00:00"
        if not end_date:
            end_date = now_ar().strftime("%Y-%m-%d") + " 23:59:59"
            
        query = """
            SELECT 
                COUNT(*) as total_count,
                COALESCE(SUM(total_amount), 0) as total_amount,
                COALESCE(SUM(CASE WHEN payment_type = 'cash' THEN total_amount ELSE 0 END), 0) as cash_amount,
                COALESCE(SUM(CASE WHEN payment_type = 'transfer' THEN total_amount ELSE 0 END), 0) as transfer_amount,
                COALESCE(AVG(total_amount), 0) as average_sale
            FROM sales
            WHERE created_at >= ? AND created_at <= ?
        """
        
        result = self.db.execute_query(query, (start_date, end_date))
        if result and result[0]:
            return result[0]
        else:
            return {
                'total_count': 0,
                'total_amount': 0,
                'cash_amount': 0,
                'transfer_amount': 0,
                'average_sale': 0
            }
    
    def get_top_selling_products(self, limit: int = 10, start_date: str = None, end_date: str = None) -> List[Dict]:
        """Obtiene los productos más vendidos"""
        query = """
            SELECT 
                si.product_id,
                si.product_name,
                SUM(si.quantity) as total_quantity,
                SUM(si.subtotal) as total_revenue,
                COUNT(DISTINCT si.sale_id) as times_sold
            FROM sale_items si
            JOIN sales s ON si.sale_id = s.id
            WHERE 1=1
        """
        params = []
        
        if start_date:
            query += " AND s.created_at >= ?"
            params.append(start_date)
        
        if end_date:
            query += " AND s.created_at <= ?"
            params.append(end_date)
        
        query += """
            GROUP BY si.product_id, si.product_name
            ORDER BY total_quantity DESC
            LIMIT ?
        """
        params.append(limit)
        
        return self.db.execute_query(query, tuple(params))
    
    def get_sales_by_hour(self, date: str = None) -> List[Dict]:
        """Obtiene las ventas agrupadas por hora"""
        if not date:
            date = now_ar().strftime("%Y-%m-%d")
        
        query = """
            SELECT 
                CAST(strftime('%H', created_at) AS INTEGER) as hour,
                COUNT(*) as count,
                COALESCE(SUM(total_amount), 0) as total
            FROM sales
            WHERE date(created_at) = ?
            GROUP BY hour
            ORDER BY hour
        """
        return self.db.execute_query(query, (date,))
