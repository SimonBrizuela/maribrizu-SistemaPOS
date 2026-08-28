"""
Expone las tablas de presentaciones y unidades del POS como JSON.

Existe para una sola cosa: que `tienda/pruebas/stock_revert.test.js` pueda
comparar `TIPOS` / `UNIDADES` / `WEBAPP_UNIDAD` de
`pos_system/models/conjunto.py` con su copia en `webapp/src/stock_revert.js`.

Por que importa: el POS escribe el nombre del renglon de una venta con estas
etiquetas ("PAPEL A4  ·  1 pack(s)", "CINTA  ·  2,5 m"), y cuando se borra esa
venta desde el panel, el panel vuelve a LEER ese nombre para saber cuanto stock
devolver. Si se agrega una presentacion nueva de un solo lado, el panel no la
reconoce, no devuelve nada y solo queda un aviso en la consola del navegador:
el stock queda mal y nadie se entera.

    python scripts/casos_conjunto_tipos.py

No importa Qt ni toca Firestore.
"""
import json
import os
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)

from pos_system.models.conjunto import TIPOS, UNIDADES, WEBAPP_UNIDAD  # noqa: E402


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

    print(json.dumps({
        # Del tipo solo viaja la etiqueta en minuscula: es lo que el POS escribe
        # en el nombre del renglon ("1 pack(s)") y lo unico que el panel lee.
        'tipos': {k: str(v['label']).lower() for k, v in TIPOS.items()},
        'unidades': {k: {'short': v['short'], 'base': v['base'], 'factor': v['factor']}
                     for k, v in UNIDADES.items()},
        'webapp_unidad': dict(WEBAPP_UNIDAD),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
