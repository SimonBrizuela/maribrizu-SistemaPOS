"""
Corre el reparto entre efectivo y transferencia del POS sobre los casos de
prueba y escupe el resultado como JSON.

Existe para una sola cosa: que `tienda/pruebas/medios_pago.test.js` pueda
comparar lo que decide `pos_system/utils/medios_de_pago.py` con lo que decide
su gemelo `webapp/src/medios_de_pago.js`. Son dos implementaciones de la misma
regla, en dos lenguajes: el POS arma el cierre y lo sube, y el panel lo vuelve
a calcular desde `ventas_por_dia`. Si se separan, el ticket dice un número y la
pantalla otro.

    python scripts/casos_medios_pago.py

No toca Firestore ni necesita credenciales.
"""
import json
import os
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)

from pos_system.utils.medios_de_pago import (  # noqa: E402
    _centavos, partes_de_venta, repartir_subtotales, reparto_de_item,
    resumir_items, etiqueta_de_pago,
)

CASOS = os.path.join(RAIZ, 'tienda', 'pruebas', 'casos_medios_pago.json')

# El `payment_type` de SQLite y la etiqueta con que viaja a `ventas_por_dia`.
ETIQUETAS = ['cash', 'transfer', 'mixed', '', None, 'CASH']


def main():
    # En Windows la consola sale en cp1252. Lo lee otro programa, no una
    # persona: tiene que ser UTF-8 siempre.
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

    with open(CASOS, encoding='utf-8') as f:
        casos = json.load(f)

    ventas = [
        {'que_prueba': c['que_prueba'], 'efectivo': _centavos(ef), 'transferencia': _centavos(tr)}
        for c in casos['ventas']
        for ef, tr in [partes_de_venta(c['venta'])]
    ]

    repartos = [
        {'que_prueba': c['que_prueba'],
         'partes': [{'efectivo': ef, 'transferencia': tr}
                    for ef, tr in repartir_subtotales(c['subtotales'], c['efectivo'], c['transferencia'])]}
        for c in casos['repartos']
    ]

    items = [
        {'que_prueba': c['que_prueba'], 'efectivo': ef, 'transferencia': tr}
        for c in casos['items']
        for ef, tr in [reparto_de_item(c['item'])]
    ]

    cajas = []
    for c in casos['cajas']:
        r = resumir_items(c['items'])
        cajas.append({
            'que_prueba': c['que_prueba'],
            'efectivo': r['efectivo'],
            'transferencia': r['transferencia'],
            'num_ventas_efectivo': r['num_ventas_efectivo'],
            'num_ventas_transferencia': r['num_ventas_transferencia'],
            'transacciones': r['transacciones'],
            'ventas': sorted(r['ventas']),
        })

    etiquetas = [{'payment_type': pt, 'etiqueta': etiqueta_de_pago(pt)} for pt in ETIQUETAS]

    print(json.dumps({'ventas': ventas, 'repartos': repartos, 'items': items,
                      'cajas': cajas, 'etiquetas': etiquetas}, ensure_ascii=False))


if __name__ == '__main__':
    main()
