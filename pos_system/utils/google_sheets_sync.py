"""
Google Sheets Sync – Webhook via Google Apps Script
=====================================================
No requiere API keys ni cuenta de servicio de Google.
Solo necesitás un Google Sheets con el script pegado y la URL del Web App.

Cómo obtener la URL:
  1. Abrí tu Google Sheets
  2. Extensiones → Apps Script
  3. Pegá el contenido de google_apps_script.js
  4. Implementar → Nueva implementación → Tipo: App web
     - Ejecutar como: Yo
     - Quién tiene acceso: Cualquier usuario (Anyone)
  5. Copiá la URL que te da Google
  6. Pegala en config.py como GOOGLE_SHEETS_WEBHOOK_URL
     o en la variable de entorno GOOGLE_SHEETS_WEBHOOK_URL

El POS envía los datos en segundo plano (hilo separado) para no bloquear
la interfaz gráfica. Si falla el envío, se registra en el log pero el
sistema sigue funcionando normalmente.
"""

import json
import logging
import threading
from datetime import datetime
from typing import Optional
from urllib.request import urlopen, Request
from urllib.parse import urlencode
from urllib.error import URLError, HTTPError

logger = logging.getLogger(__name__)


def _fmt_qty(q):
    """Formatea cantidades: 1.0 -> '1', 0.3 -> '0.3', 2.55 -> '2.55'."""
    q = float(q or 0)
    if q == int(q):
        return str(int(q))
    return f"{q:.2f}".rstrip('0').rstrip('.')


MESES_ES = [
    "", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
]


def _month_name(dt: datetime) -> str:
    return f"{MESES_ES[dt.month].capitalize()} {dt.year}"


class GoogleSheetsSync:
    """
    Envía datos al Google Sheets via HTTP POST al Web App de Apps Script.
    Toda comunicación se realiza en un hilo de fondo para no bloquear la UI.
    """

    def __init__(self, webhook_url: str):
        """
        Args:
            webhook_url: URL del Web App de Google Apps Script.
        """
        self.webhook_url = webhook_url.strip()
        self._enabled = bool(self.webhook_url)
        self._sync_mode = False  # True = envios sincronicos (sin hilos), para sync completo
        if self._enabled:
            logger.info("Google Sheets Sync: Webhook configurado correctamente.")
        else:
            logger.info("Google Sheets Sync: No configurado (webhook_url vacío).")

    @property
    def enabled(self) -> bool:
        return self._enabled

    # ──────────────────────────────────────────────
    #  Métodos públicos
    # ──────────────────────────────────────────────

    def sync_sale(self, sale: dict):
        """Envía una venta al Google Sheets (hoja del mes).
        Evita duplicados usando el ID de venta como clave de control local.
        """
        if not self._enabled:
            return
        try:
            sale_id = sale.get("id")

            # Verificar si esta venta ya fue enviada en esta sesión
            if sale_id and sale_id in _synced_sale_ids:
                logger.debug(f"Google Sheets: Venta #{sale_id} ya sincronizada, omitiendo duplicado.")
                return

            created_at = self._parse_dt(sale.get("created_at"))
            items = sale.get("items", [])
            productos = " | ".join(
                str(i.get("product_name") or i.get("name", "?")) for i in items
            )
            cantidades = " | ".join(_fmt_qty(i.get("quantity", 1)) for i in items)
            tipo_pago = "Efectivo" if sale.get("payment_type") == "cash" else "Transferencia"

            # Descuentos por ítem
            descuentos = " | ".join(
                self._fmt_discount(i) for i in items
            )
            total_descuento = sum(float(i.get("discount_amount", 0) or 0) for i in items)

            payload = {
                "tipo": "venta",
                "hoja": _month_name(created_at),
                "datos": [
                    sale_id or "",
                    created_at.strftime("%d/%m/%Y"),
                    created_at.strftime("%H:%M:%S"),
                    productos,
                    cantidades,
                    tipo_pago,
                    self._fmt(sale.get("total_amount", 0)),
                    self._fmt(sale.get("cash_received", 0)),
                    self._fmt(sale.get("change_given", 0)),
                    sale.get("username") or str(sale.get("user_id", "")),
                    descuentos if descuentos.strip(" |") else "",
                    self._fmt(total_descuento),
                ]
            }
            self._send_async(payload)
            if sale_id:
                _synced_sale_ids.add(sale_id)
            logger.info(f"Google Sheets: Enviando venta #{sale_id}...")
        except Exception as e:
            logger.error(f"Google Sheets: Error preparando datos de venta: {e}")

    def sync_withdrawal(self, withdrawal: dict, register_id=None):
        """Envía un retiro de efectivo al Google Sheets.
        Evita duplicados usando el ID del retiro como clave de control local.
        """
        if not self._enabled:
            return
        try:
            withdrawal_id = withdrawal.get("id")

            # Verificar si este retiro ya fue enviado en esta sesión
            if withdrawal_id and withdrawal_id in _synced_withdrawal_ids:
                logger.debug(f"Google Sheets: Retiro #{withdrawal_id} ya sincronizado, omitiendo duplicado.")
                return

            created_at = self._parse_dt(withdrawal.get("created_at"))
            payload = {
                "tipo": "retiro",
                "hoja": "Retiros",
                "datos": [
                    withdrawal_id or "",
                    created_at.strftime("%d/%m/%Y"),
                    created_at.strftime("%H:%M:%S"),
                    self._fmt(withdrawal.get("amount", 0)),
                    withdrawal.get("reason", ""),
                    str(register_id) if register_id else "",
                ]
            }
            self._send_async(payload)
            if withdrawal_id:
                _synced_withdrawal_ids.add(withdrawal_id)
            logger.info(f"Google Sheets: Enviando retiro #{withdrawal_id}...")
        except Exception as e:
            logger.error(f"Google Sheets: Error preparando datos de retiro: {e}")

    def sync_inventory(self, products: list):
        """
        Sincroniza el inventario completo con la hoja 'Inventario'.
        Muestra stock actual, alerta si es bajo o negativo.

        Args:
            products: Lista de dicts con id, name, category, price, cost, stock.
        """
        if not self._enabled:
            return
        try:
            now = datetime.now()
            payload = {
                "tipo": "inventario",
                "hoja": "Inventario",
                "datos": [],
                "productos": [
                    {
                        "id":          p.get("id", ""),
                        "nombre":      p.get("name", ""),
                        "categoria":   p.get("category") or "Sin categoria",
                        "precio":      self._fmt(p.get("price", 0)),
                        "costo":       self._fmt(p.get("cost", 0)),
                        "stock":       p.get("stock", 0),
                        "descuento":   self._fmt_product_discount(p),
                        "actualizado": now.strftime("%d/%m/%Y %H:%M"),
                    }
                    for p in products
                ],
            }
            self._send_async(payload)
            logger.info(f"Google Sheets: Enviando inventario ({len(products)} productos)...")
        except Exception as e:
            logger.error(f"Google Sheets: Error preparando inventario: {e}")

    def sync_daily_summary(self, sales: list, date: datetime = None):
        """
        Envía el resumen de ventas del día a la hoja 'Historial Diario'.
        Usa cache local para evitar duplicados en la misma sesion.
        """
        if not self._enabled:
            return
        global _synced_day_summaries
        try:
            if date is None:
                date = datetime.now()
            day_key = date.strftime("%Y-%m-%d")
            if day_key in _synced_day_summaries:
                logger.debug(f"Google Sheets: Resumen de {day_key} ya sincronizado, omitiendo.")
                return
            total = sum(float(s.get("total_amount", 0)) for s in sales)
            efectivo = sum(float(s.get("total_amount", 0)) for s in sales if s.get("payment_type") == "cash")
            transferencia = total - efectivo
            n = len(sales)
            promedio = total / n if n > 0 else 0

            payload = {
                "tipo": "resumen_dia",
                "hoja": "Historial Diario",
                "datos": [
                    date.strftime("%d/%m/%Y"),
                    _month_name(date),
                    n,
                    self._fmt(total),
                    self._fmt(efectivo),
                    self._fmt(transferencia),
                    self._fmt(promedio),
                ],
            }
            self._send_async(payload)
            _synced_day_summaries.add(day_key)
            logger.info(f"Google Sheets: Enviando resumen del dia {date.strftime('%d/%m/%Y')}...")
        except Exception as e:
            logger.error(f"Google Sheets: Error preparando resumen diario: {e}")

    def sync_top_products(self, db=None):
        """
        Envía ranking de productos más vendidos a la hoja 'Productos Mas Vendidos'.
        Consulta directamente la DB para obtener totales por producto.
        Puede recibir db (DatabaseManager) o funcionar sin argumentos si se pasa None
        (en ese caso no hace nada, debe llamarse con db).
        """
        if not self._enabled:
            return
        if db is None:
            return
        try:
            rows = db.execute_query("""
                SELECT
                    si.product_name,
                    COALESCE(p.category, 'Sin categoria') as category,
                    SUM(si.quantity)  as total_vendido,
                    SUM(si.subtotal)  as ingresos,
                    MAX(s.created_at) as ultima_venta
                FROM sale_items si
                JOIN sales s ON si.sale_id = s.id
                LEFT JOIN products p ON si.product_id = p.id
                GROUP BY si.product_id, si.product_name
                ORDER BY total_vendido DESC
            """)

            productos_list = []
            for r in (rows or []):
                ultima = self._parse_dt(r.get("ultima_venta"))
                productos_list.append({
                    "nombre":        r.get("product_name", "?"),
                    "categoria":     r.get("category") or "Sin categoria",
                    "total_vendido": int(r.get("total_vendido") or 0),
                    "ingresos":      self._fmt(r.get("ingresos", 0)),
                    "ultima_venta":  ultima.strftime("%d/%m/%Y %H:%M"),
                })

            payload = {
                "tipo": "productos_mas_vendidos",
                "hoja": "Productos Mas Vendidos",
                "datos": [],
                "productos": productos_list,
            }
            self._send_async(payload)
            logger.info(f"Google Sheets: Enviando ranking de {len(productos_list)} productos...")
        except Exception as e:
            logger.error(f"Google Sheets: Error preparando ranking de productos: {e}")

    def sync_sale_detail_by_day(self, sale: dict, db=None):
        """
        Envía el detalle de cada producto de una venta a la hoja 'Ventas por Dia'.
        Cada item de la venta genera una fila separada, agrupada por fecha.
        Si se pasa db (DatabaseManager) y la venta no trae items, los consulta.
        """
        if not self._enabled:
            return
        try:
            sale_id    = sale.get("id")
            created_at = self._parse_dt(sale.get("created_at"))
            tipo_pago  = "Efectivo" if sale.get("payment_type") == "cash" else "Transferencia"
            cajero     = sale.get("username") or str(sale.get("user_id", ""))
            items      = sale.get("items") or []

            # Si no trae items pero tenemos DB, los buscamos con categoría incluida
            if not items and db is not None and sale_id:
                items = db.execute_query("""
                    SELECT si.product_name, si.quantity, si.unit_price, si.subtotal,
                           COALESCE(p.category, 'Sin categoria') as category
                    FROM sale_items si
                    LEFT JOIN products p ON si.product_id = p.id
                    WHERE si.sale_id = ?
                """, (sale_id,)) or []

            for item in items:
                name     = item.get("product_name") or item.get("name", "?")
                cat      = item.get("category") or "Sin categoria"
                qty      = float(item.get("quantity", 1) or 0)
                price    = float(item.get("unit_price", 0) or 0)
                subtotal = float(item.get("subtotal", 0) or 0)

                payload = {
                    "tipo": "ventas_dia",
                    "hoja": "Ventas por Dia",
                    "datos": [
                        created_at.strftime("%d/%m/%Y"),
                        created_at.strftime("%H:%M:%S"),
                        sale_id or "",
                        name,
                        cat,
                        qty,
                        self._fmt(price),
                        self._fmt(subtotal),
                        tipo_pago,
                        cajero,
                    ],
                }
                self._send_async(payload)

            logger.info(f"Google Sheets: Enviando detalle por dia de venta #{sale_id} ({len(items)} items)...")
        except Exception as e:
            logger.error(f"Google Sheets: Error preparando detalle por dia: {e}")

    def sync_cash_closing(self, closing_report: dict):
        """Envía un cierre de caja al Google Sheets.
        Evita duplicados usando el ID del cierre como clave de control local.
        """
        if not self._enabled:
            return
        try:
            closing_id = closing_report.get("id")

            # Verificar si este cierre ya fue enviado en esta sesión
            if closing_id and closing_id in _synced_closing_ids:
                logger.debug(f"Google Sheets: Cierre #{closing_id} ya sincronizado, omitiendo duplicado.")
                return
            opening = self._parse_dt(closing_report.get("opening_date"))
            closing = self._parse_dt(
                closing_report.get("closing_date") or datetime.now().isoformat()
            )
            withdrawals = closing_report.get("withdrawals") or []
            total_withdrawals = sum(w.get("amount", 0) for w in withdrawals)
            expected = closing_report.get("expected_amount") or 0
            final = closing_report.get("final_amount") or 0

            payload = {
                "tipo": "cierre",
                "hoja": "Cierres de Caja",
                "datos": [
                    closing_report.get("id", ""),
                    opening.strftime("%d/%m/%Y %H:%M"),
                    closing.strftime("%d/%m/%Y %H:%M"),
                    self._fmt(closing_report.get("initial_amount", 0)),
                    self._fmt(closing_report.get("cash_sales", 0)),
                    self._fmt(closing_report.get("transfer_sales", 0)),
                    self._fmt(closing_report.get("total_sales", 0)),
                    self._fmt(total_withdrawals),
                    self._fmt(expected),
                    self._fmt(final),
                    self._fmt(final - expected),
                    closing_report.get("num_cash_sales", 0),
                    closing_report.get("num_transfer_sales", 0),
                    closing_report.get("notes", ""),
                ]
            }
            self._send_async(payload)
            if closing_id:
                _synced_closing_ids.add(closing_id)
            logger.info(f"Google Sheets: Enviando cierre #{closing_id}...")
        except Exception as e:
            logger.error(f"Google Sheets: Error preparando datos de cierre: {e}")

    def clear_sheet(self, sheet_name: str, subtipo: str = "venta"):
        """Limpia una hoja en Google Sheets (mantiene cabecera) antes de re-sync."""
        if not self._enabled:
            return
        try:
            payload = {
                "tipo": "limpiar",
                "hoja": sheet_name,
                "subtipo": subtipo,
                "datos": [],
            }
            self._send(payload)  # Siempre sincrónico para garantizar orden
            logger.info(f"Google Sheets: Hoja '{sheet_name}' limpiada para re-sync.")
        except Exception as e:
            logger.error(f"Google Sheets: Error limpiando hoja '{sheet_name}': {e}")

    # ──────────────────────────────────────────────
    #  Envío en segundo plano
    # ──────────────────────────────────────────────

    def _send_async(self, payload: dict, on_success=None, on_error=None):
        """Envía el payload en un hilo separado para no bloquear la UI."""
        if self._sync_mode:
            # En modo sincrónico (sync completo), enviar directo sin hilo
            self._send(payload, on_success, on_error)
        else:
            t = threading.Thread(
                target=self._send,
                args=(payload, on_success, on_error),
                daemon=True
            )
            t.start()

    def _send(self, payload: dict, on_success=None, on_error=None):
        """Realiza el HTTP POST al webhook de Apps Script.

        Args:
            on_success: callable() invocado si el envío fue exitoso.
            on_error:   callable(msg: str) invocado si hubo un error.
        """
        try:
            body = json.dumps(payload).encode("utf-8")
            req = Request(
                self.webhook_url,
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urlopen(req, timeout=15) as resp:
                response_body = resp.read().decode("utf-8")
                logger.info(f"Google Sheets: Respuesta del webhook: {response_body[:200]}")
            if on_success:
                on_success()
        except HTTPError as e:
            msg = f"HTTP {e.code} - {e.reason}"
            logger.error(f"Google Sheets: {msg}")
            if on_error:
                on_error(msg)
        except URLError as e:
            msg = f"Sin conexión: {e.reason}"
            logger.error(f"Google Sheets: {msg}")
            if on_error:
                on_error(msg)
        except Exception as e:
            msg = str(e)
            logger.error(f"Google Sheets: Error inesperado en envío: {msg}")
            if on_error:
                on_error(msg)

    # ──────────────────────────────────────────────
    #  Helpers
    # ──────────────────────────────────────────────

    @staticmethod
    def _parse_dt(value) -> datetime:
        if isinstance(value, datetime):
            return value
        if not value:
            return datetime.now()
        for fmt in (
            "%Y-%m-%dT%H:%M:%S.%f",
            "%Y-%m-%dT%H:%M:%S",
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%d",
        ):
            try:
                return datetime.strptime(str(value), fmt)
            except ValueError:
                continue
        return datetime.now()

    @staticmethod
    def _fmt(value) -> str:
        try:
            return f"{float(value):.2f}"
        except (TypeError, ValueError):
            return "0.00"

    @staticmethod
    def _fmt_product_discount(product: dict) -> str:
        """Formatea el descuento de un producto para la hoja de Inventario."""
        dtype = product.get("discount_type") or ""
        dval  = float(product.get("discount_value", 0) or 0)
        if not dtype or dval <= 0:
            return ""
        if dtype == "percentage":
            return f"-{dval:.0f}%"
        elif dtype == "fixed":
            return f"-${dval:.2f}"
        return ""

    @staticmethod
    def _fmt_discount(item: dict) -> str:
        """Formatea el descuento de un ítem de venta para Sheets."""
        dtype  = item.get("discount_type") or ""
        dval   = float(item.get("discount_value", 0) or 0)
        damnt  = float(item.get("discount_amount", 0) or 0)
        if not dtype or damnt <= 0:
            return ""
        if dtype == "percentage":
            return f"-{dval:.0f}% (${damnt:.2f})"
        elif dtype == "fixed":
            return f"-${dval:.2f} (${damnt:.2f})"
        elif dtype in ("2x1", "nxm"):
            return f"Promo: {item.get('promo_label', dtype)} (${damnt:.2f})"
        elif dtype == "bundle":
            return f"Pack (${damnt:.2f})"
        return f"${damnt:.2f}"


# ──────────────────────────────────────────────
#  Singleton global
# ──────────────────────────────────────────────

_sync_instance: Optional[GoogleSheetsSync] = None

# Cache local de IDs ya sincronizados para evitar duplicados en la misma sesión
_synced_sale_ids: set = set()         # IDs de ventas ya enviadas
_synced_withdrawal_ids: set = set()   # IDs de retiros ya enviados
_synced_closing_ids: set = set()      # IDs de cierres de caja ya enviados
_synced_day_summaries: set = set()    # fechas (YYYY-MM-DD) de resúmenes ya enviados


def init_google_sheets(webhook_url: str) -> GoogleSheetsSync:
    """Inicializa el singleton. Llamar una vez al arrancar la app."""
    global _sync_instance
    _sync_instance = GoogleSheetsSync(webhook_url)
    return _sync_instance


def get_sync() -> Optional[GoogleSheetsSync]:
    """Retorna la instancia singleton (puede ser None si no se inicializó)."""
    return _sync_instance
