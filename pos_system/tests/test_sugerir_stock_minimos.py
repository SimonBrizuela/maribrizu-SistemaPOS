"""
La propuesta de stock minimo/maximo, sin tocar Firestore.

    python -m pytest pos_system/tests/test_sugerir_stock_minimos.py -q
"""
import importlib.util
import os
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, RAIZ)

_spec = importlib.util.spec_from_file_location(
    'sugerir_stock_minimos', os.path.join(RAIZ, 'scripts', 'sugerir_stock_minimos.py'))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

parsear_renglon = _mod.parsear_renglon
proponer_umbrales = _mod.proponer_umbrales
umbrales_variedad = _mod.umbrales_variedad
velocidad = _mod.velocidad
tiene_umbral = _mod.tiene_umbral
normalizar = _mod.normalizar


# --------------------------------------------------------------------------
# El renglon de venta se lee tal cual lo guarda el POS
# --------------------------------------------------------------------------

def test_renglon_con_color_y_sufijo():
    nombre, color, unidades = parsear_renglon(
        '[Negra]  BOLIGRAFO BIC 1 MM TRAZO GRUESO  ·  3 u', 3.0, 50)
    assert nombre == 'BOLIGRAFO BIC 1 MM TRAZO GRUESO'
    assert color == 'NEGRA'
    assert unidades == 3.0          # "u" ya es unidad base: no multiplica


def test_renglon_vendido_por_caja_multiplica_el_contenido():
    _, _, unidades = parsear_renglon('RESMA A4  ·  2 caja(s)', 2.0, 500)
    assert unidades == 1000.0


def test_renglon_por_metro_no_multiplica():
    _, _, unidades = parsear_renglon('CINTA RASO  ·  1.5 m', 1.5, 100)
    assert unidades == 1.5


def test_renglon_simple_sin_sufijo():
    nombre, color, unidades = parsear_renglon('LAPIZ COLOR GIOTTO X 12 LARGOS', 1.0, 0)
    assert nombre == 'LAPIZ COLOR GIOTTO X 12 LARGOS'
    assert color == ''
    assert unidades == 1.0


def test_el_nombre_matchea_sin_tildes_ni_espacios_dobles():
    # Trampa conocida del catalogo: rubros con y sin tilde.
    assert normalizar('  Boligrafo   BIC ') == normalizar('BOLÍGRAFO BIC')


# --------------------------------------------------------------------------
# La cuenta de los umbrales
# --------------------------------------------------------------------------

def test_minimo_es_una_semana_y_maximo_cuatro():
    minimo, maximo = proponer_umbrales(2.0)   # 2 por dia
    assert minimo == 14
    assert maximo == 56


def test_producto_lento_arranca_en_uno():
    minimo, maximo = proponer_umbrales(0.05)  # ~1 cada 20 dias
    assert minimo == 1
    assert maximo == 2                        # nunca menos que 2 x minimo


def test_sin_velocidad_no_hay_propuesta():
    assert proponer_umbrales(0) is None


def test_velocidad_prefiere_los_ultimos_30_dias():
    assert velocidad(30, 999) == 1.0          # 30 en 30 dias
    assert velocidad(0, 90) == 1.0            # sin ventas recientes: 90 en 90


def test_el_consumo_por_vinculo_suma():
    assert velocidad(30, 30, vel_vinculos=2.0) == 3.0


# --------------------------------------------------------------------------
# Variedades: la unidad del umbral acompaña al numero
# --------------------------------------------------------------------------

def test_variedad_de_mucha_venta_va_en_packs():
    # 10 por dia en cajas de 50: minimo 70 unidades -> 2 packs.
    fila = umbrales_variedad(10.0, 50)
    assert fila == {'stock_min': 2, 'stock_max': 6, 'stock_min_um': 'pack'}


def test_variedad_lenta_va_en_unidades_explicitas():
    # 0.5 por dia en cajas de 50: minimo 4 unidades, ni un pack. La unidad va
    # explicita porque sin ella las alertas la leerian como packs.
    fila = umbrales_variedad(0.5, 50)
    assert fila == {'stock_min': 4, 'stock_max': 14, 'stock_min_um': 'unidad'}


def test_variedad_suelta_sin_contenido_va_en_unidades():
    fila = umbrales_variedad(1.0, 0)
    assert fila['stock_min_um'] == 'unidad'
    assert fila['stock_min'] == 7


# --------------------------------------------------------------------------
# No pisar nada
# --------------------------------------------------------------------------

def test_con_minimo_cargado_se_respeta():
    assert tiene_umbral({'stock_min': 5})
    assert tiene_umbral({'stock_max': 20})
    assert tiene_umbral({'stock_min': 5, 'stock_max': 20})


def test_sin_umbrales_esta_libre():
    assert not tiene_umbral({})
    assert not tiene_umbral({'stock_min': 0, 'stock_max': None})


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
