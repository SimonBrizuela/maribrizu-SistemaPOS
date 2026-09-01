"""
El merge de colores que sube una venta: lo que escribio el panel sobrevive
aunque la PC tenga el catalogo viejo en SQLite.

    python -m pytest pos_system/tests/test_merge_colores_venta.py -q
"""
import os
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, RAIZ)

from pos_system.utils.firebase_sync import merge_colores_con_nube

NUBE = [
    {'color': 'Rojo', 'unidades': 3, 'restante': 10, 'stock_min': 1,
     'stock_max': 2, 'stock_min_um': 'pack', 'imagen': 'rojo.webp'},
    {'color': 'Azul', 'unidades': 5, 'restante': 0, 'stock_min': 2,
     'stock_max': 4, 'stock_min_um': 'pack'},
]


def test_el_color_vendido_toma_el_stock_local_y_conserva_lo_del_panel():
    locales = [{'color': 'Rojo', 'unidades': 3, 'restante': 8},
               {'color': 'Azul', 'unidades': 5, 'restante': 0}]
    out = merge_colores_con_nube(NUBE, locales, {'Rojo'})
    rojo = next(c for c in out if c['color'] == 'Rojo')
    assert rojo['unidades'] == 3 and rojo['restante'] == 8
    assert rojo['stock_min'] == 1 and rojo['stock_max'] == 2
    assert rojo['imagen'] == 'rojo.webp'


def test_un_color_no_vendido_queda_como_en_la_nube():
    # La PC tiene el catalogo de ayer (Azul con 9 sueltos); otra PC ya lo
    # vendio. Esta venta no toca el Azul: manda la nube.
    locales = [{'color': 'Rojo', 'unidades': 3, 'restante': 8},
               {'color': 'Azul', 'unidades': 5, 'restante': 9}]
    out = merge_colores_con_nube(NUBE, locales, {'Rojo'})
    azul = next(c for c in out if c['color'] == 'Azul')
    assert azul['restante'] == 0
    assert azul['stock_min'] == 2


def test_los_minimos_del_panel_sobreviven_a_la_pc_desactualizada():
    # El caso del 01-09: el panel cargo minimos a la noche, la PC prendio a la
    # mañana con filas sin stock_min y al vender los borraba de la nube.
    locales = [{'color': 'Rojo', 'unidades': 3, 'restante': 8},
               {'color': 'Azul', 'unidades': 5, 'restante': 0}]
    out = merge_colores_con_nube(NUBE, locales, {'Rojo'})
    assert all('stock_min' in c for c in out)


def test_color_solo_en_la_nube_se_conserva():
    locales = [{'color': 'Rojo', 'unidades': 1, 'restante': 0}]
    out = merge_colores_con_nube(NUBE, locales, {'Rojo'})
    assert any(c.get('color') == 'Azul' for c in out)


def test_color_solo_local_viaja_tal_cual():
    locales = [{'color': 'Verde', 'unidades': 2, 'restante': 1}]
    out = merge_colores_con_nube(NUBE, locales, {'Verde'})
    assert {'color': 'Verde', 'unidades': 2, 'restante': 1} in out


def test_sin_nube_devuelve_lo_local():
    locales = [{'color': 'Rojo', 'unidades': 1, 'restante': 2}]
    assert merge_colores_con_nube(None, locales, {'Rojo'}) == locales
    assert merge_colores_con_nube([], locales, {'Rojo'}) == locales


if __name__ == '__main__':
    fallos = 0
    for nombre, fn in sorted(globals().items()):
        if not nombre.startswith('test_') or not callable(fn):
            continue
        try:
            fn()
            print(f'  ok   {nombre}')
        except AssertionError as e:
            fallos += 1
            print(f'  FALLA {nombre}: {e}')
    print(f'\n{fallos} fallas' if fallos else '\nTodo en verde')
    sys.exit(1 if fallos else 0)
