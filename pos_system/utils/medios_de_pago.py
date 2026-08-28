"""
Cómo se reparte la plata de una venta entre efectivo y transferencia.

Existe por el Pago Mixto. Una venta mixta cobra una parte en mano y otra por
transferencia, y hasta acá el resto del sistema la trataba como si fuera de un
solo medio: el cierre de caja contaba TODO el subtotal de sus renglones como
efectivo, así que el `monto_esperado` pedía en el cajón una plata que se había
cobrado por el banco. Una mixta de $10.000 con $6.000 transferidos dejaba al
cajero buscando un faltante de $6.000 que nunca existió.

La regla vive acá una sola vez del lado Python y tiene gemelo en JavaScript
(`webapp/src/medios_de_pago.js`), porque el cierre se arma en los dos lados: el
POS lo sube a `cierres_caja` y el panel lo recalcula desde `ventas_por_dia`.
`tienda/pruebas/medios_pago.test.js` corre las dos sobre los mismos casos y las
compara — si se separan, el panel muestra un número y el ticket otro.

Ver [reference_mapa_acoplamientos] para el resto de las reglas duplicadas.
"""
import math
import sys
from typing import Dict, List, Sequence, Tuple

# Las etiquetas con que viajan los renglones en `ventas_por_dia`.
EFECTIVO = 'Efectivo'
TRANSFERENCIA = 'Transferencia'
MIXTO = 'Mixto'


def _num(valor) -> float:
    try:
        return float(valor or 0)
    except (TypeError, ValueError):
        return 0.0


def _centavos(n) -> float:
    """Redondeo a dos decimales, calcado del `Math.round` de JavaScript.

    El `round()` de Python redondea el medio centavo al par y JavaScript lo
    redondea para arriba: sobre los mismos números daban resultados distintos y
    la prueba que compara las dos implementaciones fallaba sola.
    """
    return math.floor((_num(n) + sys.float_info.epsilon) * 100 + 0.5) / 100


def etiqueta_de_pago(payment_type) -> str:
    """El `payment_type` de SQLite ('cash'/'transfer'/'mixed') como lo escribe
    el sync y como lo lee la persona."""
    tipo = str(payment_type or '').strip().lower()
    if tipo == 'cash':
        return EFECTIVO
    if tipo == 'mixed':
        return MIXTO
    return TRANSFERENCIA


def partes_de_venta(venta: Dict) -> Tuple[float, float]:
    """Cuánto de una venta entró en efectivo y cuánto por transferencia.

    Toma un registro de `sales` (o su gemelo de la colección `ventas`). En una
    mixta el efectivo es lo recibido menos el vuelto: el vuelto sale del cajón,
    así que no es plata que entró.

    Si la venta dice ser mixta pero no trae el desglose, se devuelve todo como
    transferencia. Es la mitad que no inventa efectivo: equivocarse para ese
    lado deja un sobrante que se ve y se corrige, y para el otro manda a contar
    la caja tres veces buscando algo que no falta.
    """
    total = _num(venta.get('total_amount'))
    tipo = str(venta.get('payment_type') or '').strip().lower()

    if tipo == 'cash':
        return total, 0.0
    if tipo != 'mixed':
        return 0.0, total

    efectivo = max(0.0, _num(venta.get('cash_received')) - _num(venta.get('change_given')))
    transferencia = max(0.0, _num(venta.get('transfer_amount')))
    suma = efectivo + transferencia
    if suma <= 0:
        return 0.0, total
    # Una venta editada puede haber quedado con las partes desfasadas del total.
    # Se respeta la proporción cobrada y se ajusta al total, que es el número
    # que el resto del sistema da por cierto.
    if abs(suma - total) > 0.01:
        efectivo = total * efectivo / suma
        transferencia = total - efectivo
    return efectivo, transferencia


def repartir_subtotales(subtotales: Sequence[float], efectivo: float,
                        transferencia: float) -> List[Tuple[float, float]]:
    """Prorratea el efectivo y la transferencia de una venta entre sus renglones.

    El último renglón se lleva el resto en vez de su parte redondeada: así la
    suma de los renglones da exactamente lo cobrado, sin el centavo perdido que
    después hace que el cierre no cuadre por un peso.
    """
    subtotales = [_num(s) for s in (subtotales or [])]
    if not subtotales:
        return []

    total = sum(subtotales)
    if total <= 0:
        # Sin subtotales sobre los que repartir (una venta de $0, un renglón
        # bonificado): la plata se le carga al primero y no se pierde.
        return [(_centavos(efectivo), _centavos(transferencia))] + [(0.0, 0.0)] * (len(subtotales) - 1)

    salida = []
    ef_dado = 0.0
    tr_dado = 0.0
    for i, sub in enumerate(subtotales):
        if i == len(subtotales) - 1:
            salida.append((_centavos(efectivo - ef_dado), _centavos(transferencia - tr_dado)))
            break
        ef = _centavos(efectivo * sub / total)
        tr = _centavos(transferencia * sub / total)
        ef_dado += ef
        tr_dado += tr
        salida.append((ef, tr))
    return salida


def reparto_de_item(item: Dict) -> Tuple[float, float]:
    """Cuánto aporta a efectivo y cuánto a transferencia un renglón de
    `ventas_por_dia`.

    Los renglones nuevos traen `monto_efectivo` y `monto_transferencia` ya
    repartidos por el POS. Los viejos no, y para esos vale el `tipo_pago`:
    igual que siempre, salvo el 'Mixto', que va entero a transferencia por lo
    que explica `partes_de_venta`.
    """
    sub = _num(item.get('subtotal'))
    me = item.get('monto_efectivo')
    mt = item.get('monto_transferencia')
    if me is not None or mt is not None:
        return _num(me), _num(mt)

    tipo = str(item.get('tipo_pago') or '').strip().lower()
    if tipo == 'transferencia':
        return 0.0, sub
    if tipo == 'mixto':
        return 0.0, sub
    return sub, 0.0


def resumir_items(items: Sequence[Dict],
                  clave_venta=None) -> Dict:
    """Los totales de una caja a partir de sus renglones de `ventas_por_dia`.

    `clave_venta(item)` devuelve qué venta es cada renglón (por ejemplo
    "PC1|37"); sin ella se usa `pc_id|num_venta`.

    Una venta mixta cuenta en las dos listas de ventas —aportó a las dos— así
    que `transacciones` NO es la suma de las otras dos: es cuántas ventas
    distintas hubo, que es lo que la palabra quiere decir.
    """
    if clave_venta is None:
        def clave_venta(it):
            return f"{it.get('pc_id') or ''}|{it.get('num_venta')}"

    efectivo = 0.0
    transferencia = 0.0
    ventas_ef = set()
    ventas_tr = set()
    ventas = set()

    for it in (items or []):
        ef, tr = reparto_de_item(it)
        clave = clave_venta(it)
        efectivo += ef
        transferencia += tr
        ventas.add(clave)
        if ef:
            ventas_ef.add(clave)
        if tr:
            ventas_tr.add(clave)

    return {
        'efectivo': _centavos(efectivo),
        'transferencia': _centavos(transferencia),
        'ventas_efectivo': ventas_ef,
        'ventas_transferencia': ventas_tr,
        'ventas': ventas,
        'num_ventas_efectivo': len(ventas_ef),
        'num_ventas_transferencia': len(ventas_tr),
        'transacciones': len(ventas),
    }


def partes_para_total(venta: Dict, nuevo_total: float) -> Tuple[float, float]:
    """Cómo queda el desglose de una venta mixta cuando le cambia el total.

    El efectivo es plata contada que ya está en el cajón: no se toca. Lo que se
    corrige es la transferencia, que se puede verificar contra el banco. Si el
    total nuevo no alcanza a cubrir el efectivo cobrado, la venta pasa a ser
    toda en efectivo y la transferencia queda en cero.
    """
    efectivo, _transferencia = partes_de_venta(venta)
    nuevo_total = _num(nuevo_total)
    if efectivo >= nuevo_total:
        return _centavos(nuevo_total), 0.0
    return _centavos(efectivo), _centavos(nuevo_total - efectivo)
