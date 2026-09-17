"""
Registro local de los cobros de pedidos de la tienda que esta PC tiene a medias.

El cobro de un pedido son tres escrituras en dos lugares: el cobro en el pedido
(Firestore), la venta en la base local y la anotación de esa venta en el
pedido. Si la PC se corta, se queda sin red o la base local falla entre una y
otra, algo queda a medias. Antes de pedirle a la nube que registre el cobro se
anota acá lo necesario para terminarlo solo: el pedido, el pago y los
renglones. Cada paso completo avanza la fila; cuando el pedido anota la venta,
la fila se borra.

  cobrando       se pidió el cobro; no se sabe todavía si la nube lo registró
  venta_creada   la venta local existe; falta anotarla en el pedido

Quien la procesa (`PedidosWebView._procesar_cobros_pendientes`) relee el pedido:
si el cobro con este `intento` está hecho, crea la venta que falta; si no lo
está, el cobro nunca se registró y la fila se descarta. Así no depende de que
el pedido siga apareciendo en las escuchas ni de cuántos días pasaron.
"""
import json
from datetime import datetime, timedelta

from pos_system.models.pedido_tienda import TZ_AR

TABLA = """
    CREATE TABLE IF NOT EXISTS cobros_pedido_pendientes (
        intento       TEXT PRIMARY KEY,
        pedido_id     TEXT NOT NULL,
        codigo        TEXT DEFAULT '',
        estado        TEXT NOT NULL,
        pedido_json   TEXT NOT NULL,
        pago_json     TEXT NOT NULL,
        lineas_json   TEXT NOT NULL,
        sale_id       INTEGER,
        fallas        INTEGER DEFAULT 0,
        proximo       TEXT DEFAULT '',
        ultimo_error  TEXT DEFAULT '',
        creado        TEXT NOT NULL
    )
"""

# Espera entre reintentos de una fila que falla: 1, 2, 4… minutos, hasta media hora.
MINUTOS_MAXIMO = 30


def asegurar_tabla(db):
    with db.get_connection() as conn:
        conn.execute(TABLA)


def _ahora():
    return datetime.now(TZ_AR)


def _json(valor):
    return json.dumps(valor, ensure_ascii=False, default=str)


def anotar(db, *, intento, pedido_id, codigo, pedido, pago, lineas):
    asegurar_tabla(db)
    db.execute_update(
        "INSERT OR REPLACE INTO cobros_pedido_pendientes "
        "(intento, pedido_id, codigo, estado, pedido_json, pago_json, lineas_json, creado) "
        "VALUES (?, ?, ?, 'cobrando', ?, ?, ?, ?)",
        (intento, pedido_id, codigo or '', _json(pedido), _json(pago), _json(lineas),
         _ahora().isoformat()))


def marcar_venta(db, intento, sale_id):
    db.execute_update(
        "UPDATE cobros_pedido_pendientes SET estado = 'venta_creada', sale_id = ?, "
        "fallas = 0, proximo = '', ultimo_error = '' WHERE intento = ?",
        (int(sale_id), intento))


def borrar(db, intento):
    db.execute_update("DELETE FROM cobros_pedido_pendientes WHERE intento = ?", (intento,))


def posponer(db, intento, error):
    """Una falla más: la próxima vuelta espera el doble. Devuelve cuántas van."""
    fila = obtener(db, intento)
    if not fila:
        return 0
    fallas = int(fila.get('fallas') or 0) + 1
    espera = min(2 ** (fallas - 1), MINUTOS_MAXIMO)
    db.execute_update(
        "UPDATE cobros_pedido_pendientes SET fallas = ?, proximo = ?, ultimo_error = ? WHERE intento = ?",
        (fallas, (_ahora() + timedelta(minutes=espera)).isoformat(), str(error)[:500], intento))
    return fallas


def obtener(db, intento):
    asegurar_tabla(db)
    filas = db.execute_query("SELECT * FROM cobros_pedido_pendientes WHERE intento = ?", (intento,))
    return _leer(filas[0]) if filas else None


def pendientes(db, ahora=None):
    """Las filas a procesar ahora (las pospuestas esperan su turno)."""
    asegurar_tabla(db)
    ahora = ahora or _ahora()
    salida = []
    for f in db.execute_query("SELECT * FROM cobros_pedido_pendientes ORDER BY creado") or []:
        fila = _leer(f)
        proximo = fila.get('proximo')
        if proximo:
            try:
                if datetime.fromisoformat(proximo) > ahora:
                    continue
            except ValueError:
                pass
        salida.append(fila)
    return salida


def _leer(fila):
    fila = dict(fila)
    for campo in ('pedido_json', 'pago_json', 'lineas_json'):
        try:
            fila[campo.replace('_json', '')] = json.loads(fila.get(campo) or 'null')
        except ValueError:
            fila[campo.replace('_json', '')] = None
    return fila
