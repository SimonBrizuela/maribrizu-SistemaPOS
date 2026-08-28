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

Demanda = _mod.Demanda
QUITAR = _mod.QUITAR
con_senal = _mod.con_senal
decidir = _mod.decidir
es_propio = _mod.es_propio
normalizar = _mod.normalizar
parsear_renglon = _mod.parsear_renglon
proponer_umbrales = _mod.proponer_umbrales
tiene_umbral = _mod.tiene_umbral
umbrales_variedad = _mod.umbrales_variedad
velocidad = _mod.velocidad


def demanda(ventas):
    """[(unidades, dias_atras), ...] -> Demanda"""
    d = Demanda()
    for unidades, dias in ventas:
        d.sumar(unidades, dias)
    return d


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
    _, _, unidades = parsear_renglon('CINTA RASO  ·  1.5 m', 1.5, 100, base='m')
    assert unidades == 1.5


def test_los_centimetros_se_convierten_a_metros():
    # El caso real de la fiselina: "50 cm" entraba como 50 unidades y el
    # minimo saltaba a 13 metros. Son 0,5 m.
    _, _, unidades = parsear_renglon(
        '[Blanco]  FISELINA (NOVOTEC) LISA GRUESA XMT  ·  50 cm', 50.0, 0, base='m')
    assert unidades == 0.5


def test_una_unidad_de_otra_magnitud_va_tal_cual():
    # "3 u" en un producto por metro no se puede convertir: queda 3.
    _, _, unidades = parsear_renglon('ALGO  ·  3 u', 3.0, 0, base='m')
    assert unidades == 3.0


def test_la_venta_por_rollo_multiplica_en_productos_por_metro():
    # "2 rollo(s)" de hilo de 70 m son 140 m.
    _, _, unidades = parsear_renglon(
        '[Blanco]  HILO ENCERADO COLOR (70 MT)  ·  2 rollo(s)', 2.0, 70, base='m')
    assert unidades == 140.0


def test_renglon_simple_sin_sufijo():
    nombre, color, unidades = parsear_renglon('LAPIZ COLOR GIOTTO X 12 LARGOS', 1.0, 0)
    assert nombre == 'LAPIZ COLOR GIOTTO X 12 LARGOS'
    assert color == ''
    assert unidades == 1.0


def test_el_nombre_matchea_sin_tildes_ni_espacios_dobles():
    # Trampa conocida del catalogo: rubros con y sin tilde.
    assert normalizar('  Boligrafo   BIC ') == normalizar('BOLÍGRAFO BIC')


# --------------------------------------------------------------------------
# La velocidad: mediana de tres miradas, acotada a la edad del producto
# --------------------------------------------------------------------------

def test_ritmo_parejo_da_lo_mismo_en_las_tres_miradas():
    # 1 por dia durante 180 dias: las tres tasas son 1.
    d = demanda([(1, i) for i in range(180)])
    assert velocidad(d) == 1.0


def test_un_pico_del_ultimo_mes_no_infla_el_minimo():
    # Vendia ~1/dia y el ultimo mes exploto a 5/dia: la mediana se queda con
    # la mirada larga, no con el pico.
    d = demanda([(5, i) for i in range(30)] + [(1, i) for i in range(30, 180)])
    assert velocidad(d) < 2.5


def test_la_temporada_que_paso_no_mantiene_el_minimo_alto():
    # Vendio fuerte hace meses y este mes casi nada: manda lo reciente/medio.
    d = demanda([(0.2, i) for i in range(30)] + [(6, i) for i in range(120, 180)])
    assert velocidad(d) < 1.0


def test_un_producto_nuevo_no_divide_por_meses_que_no_vivio():
    # Arranco hace 20 dias vendiendo 2/dia: la velocidad es 2, no 40/180.
    d = demanda([(2, i) for i in range(20)])
    assert abs(velocidad(d) - 2.0) < 0.01


def test_el_consumo_por_vinculo_suma():
    d = demanda([(1, i) for i in range(90)])
    assert velocidad(d, vel_vinculos=2.0) == velocidad(d) + 2.0


def test_senal_pide_volumen_y_venta_reciente():
    assert con_senal(demanda([(2, 5), (2, 40)]))
    assert not con_senal(demanda([(1, 5)]))            # poco volumen
    assert not con_senal(demanda([(9, 60), (9, 80)]))  # nada en 45 dias


def test_quitar_es_mas_conservador_que_agregar():
    # El hilo encerado: ultimo rollo hace 46 dias. No alcanza para AGREGAR un
    # umbral nuevo, pero uno propio existente se mantiene hasta los 90 dias.
    d = demanda([(70, 46), (280, 77)])
    assert not con_senal(d)
    assert _mod.con_senal_para_mantener(d)
    assert not _mod.con_senal_para_mantener(demanda([(9, 100), (9, 120)]))


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


def test_variedad_de_mucha_venta_va_en_packs():
    # 10 por dia en cajas de 50: minimo 70 unidades -> 2 packs.
    fila = umbrales_variedad(10.0, 50)
    assert fila == {'stock_min': 2, 'stock_max': 6, 'stock_min_um': 'pack'}


def test_variedad_lenta_va_en_unidades_explicitas():
    # 0.5 por dia en cajas de 50: minimo 4 unidades, ni un pack. La unidad va
    # explicita porque sin ella las alertas la leerian como packs.
    fila = umbrales_variedad(0.5, 50)
    assert fila == {'stock_min': 4, 'stock_max': 14, 'stock_min_um': 'unidad'}


# --------------------------------------------------------------------------
# Corregirse sin pisar lo cargado a mano
# --------------------------------------------------------------------------

PROPIO = {'stock_min': 10, 'stock_max': 40, 'stock_min_um': 'unidad'}


def test_umbral_a_mano_es_intocable():
    actual = {'stock_min': 5, 'stock_max': 20}
    assert decidir(actual, escrito_previo=None, propuesta=PROPIO) is None


def test_umbral_propio_editado_por_el_dueno_pasa_a_ser_suyo():
    actual = {'stock_min': 12, 'stock_max': 40, 'stock_min_um': 'unidad'}
    assert not es_propio(actual, PROPIO)      # el dueño subio el minimo
    assert decidir(actual, escrito_previo=PROPIO, propuesta={'stock_min': 8, 'stock_max': 30, 'stock_min_um': 'unidad'}) is None


def test_umbral_propio_intacto_se_corrige():
    nueva = {'stock_min': 7, 'stock_max': 28, 'stock_min_um': 'unidad'}
    assert decidir(dict(PROPIO), escrito_previo=PROPIO, propuesta=nueva) == nueva


def test_umbral_propio_sin_senal_se_quita():
    assert decidir(dict(PROPIO), escrito_previo=PROPIO, propuesta=None) == QUITAR


def test_umbral_propio_igual_no_se_reescribe():
    assert decidir(dict(PROPIO), escrito_previo=PROPIO, propuesta=dict(PROPIO)) is None


def test_lugar_libre_recibe_la_propuesta():
    assert decidir({}, escrito_previo=None, propuesta=PROPIO) == PROPIO
    assert decidir({}, escrito_previo=None, propuesta=None) is None


def test_tiene_umbral():
    assert tiene_umbral({'stock_min': 5})
    assert tiene_umbral({'stock_max': 20})
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
