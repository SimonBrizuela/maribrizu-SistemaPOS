"""
Los packs cerrados de un conjunto son SIEMPRE un numero entero.

    python -m pytest pos_system/tests/test_conjunto_enteros.py -q
    python pos_system/tests/test_conjunto_enteros.py

Por que existe este archivo: un pack cerrado es una caja fisica en el estante,
asi que 5,92 cajas no significa nada. Un codigo viejo, al vender UNA unidad
suelta, en vez de bajar una suelta le restaba una fraccion de pack
(`packs -= 1 / contenido`). El total seguia dando bien -- 5,92 x 50 + 9 son las
305 unidades correctas -- y por eso nadie lo noto durante meses: la pantalla del
POS y la tienda muestran el total, no el reparto.

Lo que quedaba roto era el reparto interno, y ahi si dolia: cuando las sueltas
llegaban a cero, en vez de abrir un pack el contador seguia restando 0,02 y
cruzaba a negativo. El BOLIGRAFO BIC 1 MM termino con la variedad Roja en -0,06
packs, o sea 3 unidades vendidas de mas, escondidas detras de un total que
seguia dando 18 en positivo.

`test_conjunto.py` cubre el invariante `total = unidades x contenido + restante`,
que nunca se rompio. Este cubre el otro, el que si se rompio: que `unidades`
sea entero y no negativo despues de cualquier operacion.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from pos_system.models.conjunto import (
    descontar_de_total, packs_a_guardar, packs_a_mostrar, repartir_total,
    total_variedad,
)
from pos_system.ui.conjunto_dialog import (
    UNIDADES, aplicar_venta, normalizar_unidad,
)

# Presentaciones reales del catalogo. El 50 es la caja de boligrafos donde
# aparecio el bug, el 100 el paquete de limpia pipas y el 6 el blister de aros.
CONTENIDOS = (1, 5, 6, 10, 12, 24, 25, 50, 60, 100, 250, 500)


def es_entero(valor):
    return abs(float(valor) - round(float(valor))) < 1e-9


# --------------------------------------------------------------------------
# El invariante, sobre la logica pura
# --------------------------------------------------------------------------

def test_repartir_total_nunca_devuelve_packs_fraccionarios():
    for contenido in CONTENIDOS:
        for total in range(0, 3 * contenido + 3):
            packs, sueltas = repartir_total(total, contenido)
            assert es_entero(packs), f'{total} en packs de {contenido} -> {packs}'
            assert packs >= 0
            assert sueltas >= 0


def test_repartir_total_deja_las_sueltas_por_debajo_del_pack():
    # Si las sueltas llegan al tamano del pack es un pack cerrado, no sueltas.
    # Azul del BIC quedo con 52 sueltas en packs de 50: son 13 packs y 2.
    for contenido in CONTENIDOS:
        for total in range(0, 3 * contenido + 3):
            _, sueltas = repartir_total(total, contenido)
            assert sueltas < contenido or contenido <= 0


def test_descontar_de_total_mantiene_los_packs_enteros():
    for contenido in (6, 50, 100, 250):
        for delta in (0.5, 1, 2, 7, 13, 50, 99):
            _, packs, _ = descontar_de_total(5 * contenido, delta, contenido)
            assert es_entero(packs), f'delta {delta} en packs de {contenido}'


def test_descontar_de_total_nunca_baja_de_cero():
    total, packs, sueltas = descontar_de_total(10, 999, 50)
    assert (total, packs, sueltas) == (0.0, 0.0, 0.0)


# --------------------------------------------------------------------------
# El escenario exacto que ensucio los datos
# --------------------------------------------------------------------------

def test_vender_de_a_una_unidad_muchas_veces_no_ensucia_los_packs():
    """La caja de 50 del BIC, vendida unidad por unidad hasta vaciarla.

    Este es el recorrido que dejaba 5,92 / 0,84 / 3,70 / -0,06: todos multiplos
    de 1/50 = 0,02. Si alguna vez vuelve a dividir, el assert cae en la primera
    venta que abra un pack.
    """
    contenido = 50
    packs, sueltas = 6.0, 9.0
    total_inicial = total_variedad({'unidades': packs, 'restante': sueltas}, contenido)

    for i in range(int(total_inicial)):
        ok, err, packs, sueltas = aplicar_venta(
            packs, contenido, sueltas, 1, 'fraccion', 'u')
        assert ok, f'venta {i + 1}: {err}'
        assert es_entero(packs), f'venta {i + 1} dejo {packs} packs'
        assert packs >= 0, f'venta {i + 1} dejo {packs} packs (negativo)'
        assert sueltas >= 0, f'venta {i + 1} dejo {sueltas} sueltas'
        esperado = total_inicial - (i + 1)
        assert total_variedad(
            {'unidades': packs, 'restante': sueltas}, contenido) == esperado

    assert (packs, sueltas) == (0.0, 0.0)


def test_vender_la_ultima_unidad_no_cruza_a_negativo():
    # Lo que le paso a la variedad Roja: sin sueltas y sin packs, la venta se
    # rechaza. No se resta "un poquito de pack".
    ok, err, packs, sueltas = aplicar_venta(0, 50, 0, 1, 'fraccion', 'u')
    assert not ok
    assert (packs, sueltas) == (0, 0)
    assert 'disponible' in err.lower() or 'suficiente' in err.lower()


def test_no_se_puede_vender_mas_de_lo_que_hay():
    ok, _, packs, sueltas = aplicar_venta(1, 50, 10, 61, 'fraccion', 'u')
    assert not ok
    assert packs >= 0 and sueltas >= 0


def test_vender_packs_enteros_deja_packs_enteros():
    ok, err, packs, sueltas = aplicar_venta(5, 50, 12, 3, 'conjunto', 'u')
    assert ok, err
    assert es_entero(packs) and packs == 2
    assert sueltas == 12


def test_abrir_un_pack_baja_exactamente_uno():
    # 2 packs y 3 sueltas: vender 4 consume las 3 y abre UN pack.
    ok, err, packs, sueltas = aplicar_venta(2, 50, 3, 4, 'fraccion', 'u')
    assert ok, err
    assert (packs, sueltas) == (1, 49)


# --------------------------------------------------------------------------
# Regresion con los valores rotos que quedaron en el catalogo
# --------------------------------------------------------------------------

# (nombre, packs guardados, sueltas, contenido) tal cual estaban en Firestore.
ROTOS = [
    ('BIC 1 MM Azul',        5.92,                 9.0,    50),
    ('BIC 1 MM Roja',       -0.06000000000000005, 21.0,    50),
    ('BIC 1 MM Verde',       0.8400000000000001,  35.0,    50),
    ('BIC 1 MM Negra',       3.6999999999999993,  40.0,    50),
    ('LIMPIA PIPA CBX',    105.12,              1136.0,   100),
    ('ACCESORIO ARO',        3.666666666666667,     0.0,     6),
    ('PAPEL ILUSTRACION',    0.98,                  0.0,   250),
]


def test_los_valores_rotos_se_normalizan_sin_mover_el_total():
    """Repartir de nuevo el total arregla el reparto y no toca la cantidad.

    Es lo que hay que correr sobre los productos que quedaron sucios: el total
    es correcto, lo unico mal es como esta partido.
    """
    for nombre, packs, sueltas, contenido in ROTOS:
        total = total_variedad({'unidades': packs, 'restante': sueltas}, contenido)
        nuevos_packs, nuevas_sueltas = repartir_total(total, contenido)

        assert es_entero(nuevos_packs), nombre
        assert nuevos_packs >= 0, nombre
        assert nuevas_sueltas < contenido, nombre
        # El total no se mueve: no se inventa ni se pierde mercaderia.
        assert total_variedad(
            {'unidades': nuevos_packs, 'restante': nuevas_sueltas},
            contenido) == total, nombre


def test_la_variedad_roja_esconde_un_negativo():
    # -0,06 packs de 50 son 3 unidades vendidas de mas. El total daba 18 y
    # positivo, asi que ninguna alerta lo veia.
    total = total_variedad({'unidades': -0.06, 'restante': 21.0}, 50)
    assert total == 18.0
    assert -0.06 * 50 == -3.0


def test_el_reparto_del_boligrafo_coincide_con_lo_que_quedo_guardado():
    # Al guardar la ficha el 27-08 quedo Azul 12/52. Repartido de nuevo son
    # 13 packs y 2 sueltas, con el mismo total de 652.
    total = total_variedad({'unidades': 12, 'restante': 52}, 50)
    assert total == 652
    assert repartir_total(total, 50) == (13.0, 2.0)


# --------------------------------------------------------------------------
# Lo que tipea el personal tampoco puede quedar fraccionario
# --------------------------------------------------------------------------

def test_packs_a_guardar_con_enteros_devuelve_enteros():
    for vistos in range(0, 30):
        for sueltos in (0, 1, 7, 49):
            assert es_entero(packs_a_guardar(vistos, sueltos))


def test_packs_a_mostrar_con_enteros_devuelve_enteros():
    for cerrados in range(0, 30):
        for sueltos in (0, 1, 7, 49):
            assert es_entero(packs_a_mostrar(cerrados, sueltos))


def test_packs_a_guardar_nunca_es_negativo():
    # Con 0 packs vistos y sueltas cargadas no se puede restar el pack abierto.
    assert packs_a_guardar(0, 36) == 0
    assert packs_a_guardar(-5, 36) == 0


# --------------------------------------------------------------------------
# La unidad de medida siempre tiene que ser una clave conocida
# --------------------------------------------------------------------------

def test_normalizar_unidad_siempre_devuelve_una_clave_valida():
    """El catalogo guarda 'metros' / 'unidades' y UNIDADES usa 'm' / 'u'.

    `aplicar_venta` indexa UNIDADES[unidad_base] al armar el mensaje de "no hay
    suficiente", asi que una unidad sin traducir revienta con KeyError justo en
    la rama del error. Todo lo que entre tiene que salir como clave valida.
    """
    crudos = [
        'metros', 'centimetros', 'unidades', 'gramos', 'kilos', 'litros',
        'cm', 'm', 'u', 'g', 'kg', 'l', 'ml', 'm2',
        'METROS', '  Unidades  ', 'inventada', '', None, 0,
    ]
    for crudo in crudos:
        assert normalizar_unidad(crudo) in UNIDADES, repr(crudo)


def test_el_mensaje_de_falta_de_stock_no_revienta_con_ninguna_unidad():
    # Con la unidad ya normalizada, pedir de mas devuelve el error y no explota.
    for unidad in UNIDADES:
        ok, err, _, _ = aplicar_venta(0, 50, 5, 999, 'fraccion', unidad)
        assert not ok
        assert err


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
