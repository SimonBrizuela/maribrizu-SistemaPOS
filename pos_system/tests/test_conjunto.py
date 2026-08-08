"""
Las cuentas de un producto conjunto.

    python -m pytest pos_system/tests/test_conjunto.py -q
    python pos_system/tests/test_conjunto.py

Cubre el invariante `total = unidades × contenido + restante` y los dos casos
que estaban mal antes: el pack fantasma al revertir una venta y la variedad con
una presentacion distinta a la del producto.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from pos_system.models.conjunto import (
    contenido_de, repartir_total, total_conjunto, total_variedad,
)
from pos_system.ui.conjunto_dialog import aplicar_venta


def test_contenido_propio_gana_al_del_producto():
    assert contenido_de({'contenido': 50}, 12) == 50


def test_sin_contenido_propio_usa_el_del_producto():
    assert contenido_de({}, 12) == 12
    assert contenido_de({'contenido': 0}, 12) == 12
    assert contenido_de({'contenido': None}, 12) == 12


def test_total_de_una_variedad():
    # 2 cajas cerradas de 60 + 38 sueltas
    assert total_variedad({'unidades': 2, 'restante': 38}, 60) == 158


def test_cerrados_y_sueltos_se_suman_sin_descontar():
    # El caso del Papermate Economico: el total es la suma, no la suma menos un
    # pack. Antes el panel guardaba 208 y lo correcto son 328.
    colores = [
        {'color': 'Azul',  'unidades': 2, 'restante': 50},
        {'color': 'Negro', 'unidades': 2, 'restante': 38},
    ]
    assert total_conjunto(colores, 60) == 328


def test_cada_variedad_usa_su_propia_presentacion():
    # Papermate Kilometrico 1.0: los colores vienen por 12 y azul/negro por 50.
    colores = [
        {'color': 'Violeta', 'unidades': 0, 'restante': 13},
        {'color': 'Rosa',    'unidades': 0, 'restante': 3},
        {'color': 'Celeste', 'unidades': 0, 'restante': 10},
        {'color': 'Azul',    'unidades': 3, 'restante': 50, 'contenido': 50},
        {'color': 'Negro',   'unidades': 3, 'restante': 50, 'contenido': 50},
    ]
    assert total_conjunto(colores, 12) == 426
    # Con el contenido del producto para todos daba 198, que es lo que escribia
    # el POS antes de este arreglo.
    assert sum(c['unidades'] * 12 + c['restante'] for c in colores) == 198


def test_repartir_no_inventa_packs():
    # El bug del 95: 35 sueltas con cajas de 60 no son "1 caja + 35".
    assert repartir_total(35, 60) == (0.0, 35.0)
    assert repartir_total(95, 60) == (1.0, 35.0)
    assert repartir_total(120, 60) == (2.0, 0.0)
    assert repartir_total(0, 60) == (0.0, 0.0)


def test_repartir_sin_contenido_deja_todo_suelto():
    assert repartir_total(17, 0) == (0.0, 17.0)


def test_repartir_es_la_inversa_de_total():
    for total in (0, 1, 35, 59, 60, 61, 120, 158, 328):
        for contenido in (1, 10, 12, 50, 60):
            u, r = repartir_total(total, contenido)
            assert total_variedad({'unidades': u, 'restante': r}, contenido) == total


def test_vender_consume_los_sueltos_antes_de_abrir_un_pack():
    ok, err, u, r = aplicar_venta(2, 60, 38, 10, 'fraccion', 'unidad')
    assert ok, err
    assert (u, r) == (2, 28)


def test_vender_abre_un_pack_recien_cuando_se_acaban_los_sueltos():
    ok, err, u, r = aplicar_venta(2, 60, 38, 50, 'fraccion', 'unidad')
    assert ok, err
    # Se van las 38 sueltas y se abre una caja: quedan 1 cerrada y 48 sueltas.
    assert (u, r) == (1, 48)
    assert total_variedad({'unidades': u, 'restante': r}, 60) == 158 - 50


def test_venta_y_reverso_dejan_el_mismo_total():
    contenido = 60
    antes = total_variedad({'unidades': 2, 'restante': 38}, contenido)
    ok, _, u, r = aplicar_venta(2, contenido, 38, 50, 'fraccion', 'unidad')
    assert ok
    consumido = antes - total_variedad({'unidades': u, 'restante': r}, contenido)
    assert consumido == 50
    # El reverso vuelve a partir el total devuelto, sin agregar packs.
    ru, rr = repartir_total(
        total_variedad({'unidades': u, 'restante': r}, contenido) + consumido,
        contenido)
    assert total_variedad({'unidades': ru, 'restante': rr}, contenido) == antes


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
