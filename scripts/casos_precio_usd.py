"""
Corre los casos del precio en dolares con el codigo del POS y los devuelve.

Existe para una sola cosa: que `tienda/pruebas/precio_usd.test.js` pueda
comparar `pos_system/utils/precio_usd.py` con su gemelo
`webapp/src/precio_usd.js` sobre exactamente las mismas entradas.

Por que importa: el panel muestra el precio en pesos mientras se edita la
ficha, el POS lo calcula al vender y el sync lo publica en la tienda. Si las
cuentas se desvian aunque sea en un peso, el cliente ve un precio en la
vidriera y el cajero cobra otro.

    python scripts/casos_precio_usd.py

Lee los casos de tienda/pruebas/casos_precio_usd.json y escribe el resultado
en JSON por salida estandar. No importa Qt ni toca Firestore.
"""
import json
import os
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)

from pos_system.utils.precio_usd import (  # noqa: E402
    convertir_producto, precio_desde_costo, es_usd, tiene_precios_usd,
    cotizacion_valida, redondear_centena,
)

CASOS = os.path.join(RAIZ, 'tienda', 'pruebas', 'casos_precio_usd.json')


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

    with open(CASOS, encoding='utf-8') as f:
        datos = json.load(f)

    productos = [
        convertir_producto(c['producto'], c.get('cotizacion'))
        for c in datos['casos']
    ]
    banderas = [
        {
            'es_usd': es_usd(c['producto']),
            'tiene_precios_usd': tiene_precios_usd(c['producto']),
            'cotizacion_valida': cotizacion_valida(c.get('cotizacion')),
        }
        for c in datos['casos']
    ]
    desde_costo = [
        precio_desde_costo(c['costo_usd'], c['margen'])
        for c in datos['precio_desde_costo']
    ]
    # La escalera del redondeo, que es donde las dos cuentas se pueden separar
    # sin que ningun caso de arriba lo note.
    centenas = [redondear_centena(v) for v in
                [0, 1, 4, 5, 9, 24, 26, 45, 49, 50, 51, 99, 100, 149, 150,
                 151, 249, 250, 251, 1207, 14437, 14450, 49699.99]]

    print(json.dumps({
        'productos': productos,
        'banderas': banderas,
        'precio_desde_costo': desde_costo,
        'centenas': centenas,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
