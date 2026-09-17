"""
Corre la regla de stock de los pedidos de la tienda del POS sobre los casos de
prueba y escupe el resultado como JSON.

Existe para que `tienda/pruebas/pedido_venta_pos.test.js` compare lo que decide
`pos_system/models/pedido_tienda.py` con su gemelo `webapp/src/pedido_venta.js`
(y el número y el mensaje de WhatsApp con `tienda/src/telefono.js` y
`webapp/src/avisos_pedido.js`).
El panel descuenta el stock cuando marca un pedido entregado y la caja lo hace
cuando lo entrega ella o cuando lo entregó el repartidor: si las dos cuentas se
separan, el mismo pedido deja un stock distinto según quién lo entregó.

    python scripts/casos_pedido_venta.py

No toca Firestore ni necesita credenciales.
"""
import json
import os
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)

from pos_system.models.pedido_tienda import (  # noqa: E402
    DIRECCION_LOCAL, mensaje_whatsapp, plan_descuento, whatsapp_de_telefono)

CASOS = os.path.join(RAIZ, 'tienda', 'pruebas', 'casos_pedido_venta.json')


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

    with open(CASOS, encoding='utf-8') as f:
        casos = json.load(f)

    salida = {
        'plan': [
            {'que_prueba': c['que_prueba'], 'plan': plan_descuento(c['items'], c['catalogo'])}
            for c in casos['plan']
        ],
        # El número y el mensaje de WhatsApp: el panel y la caja escriben al
        # mismo cliente.
        'whatsapp': [whatsapp_de_telefono(t) for t in casos.get('whatsapp', [])],
        'mensajes': [mensaje_whatsapp(p, DIRECCION_LOCAL) for p in casos.get('mensajes', [])],
    }
    json.dump(salida, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
