"""
El plan de correccion de stock del catalogo, sin tocar Firestore.

    python -m pytest pos_system/tests/test_fix_stock_catalogo.py -q

Cada `plan_*` decide que le pasa a UN producto y devuelve los campos a escribir,
o None si no hay nada que hacer. Todo lo de este archivo corre sobre diccionarios
sueltos: la parte que habla con la nube no se toca.
"""
import importlib.util
import os
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, RAIZ)

_spec = importlib.util.spec_from_file_location(
    'fix_stock_catalogo', os.path.join(RAIZ, 'scripts', 'fix_stock_catalogo.py'))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

plan_precio = _mod.plan_precio
plan_servicio = _mod.plan_servicio
plan_packs = _mod.plan_packs
plan_descuadre = _mod.plan_descuadre
total_de = _mod.total_de
cargas_manuales_vigentes = _mod.cargas_manuales_vigentes
aplicar_proteccion = _mod.aplicar_proteccion


# --------------------------------------------------------------------------
# descuadre: el stock plano sigue al total del conjunto
# --------------------------------------------------------------------------

def test_el_stock_pasa_a_valer_lo_que_dice_el_conjunto():
    # El caso de LIMPIA PIPA: el conjunto contaba 11.648 y el campo plano 3.486.
    p = {'es_conjunto': True, 'conjunto_contenido': 100,
         'conjunto_unidades': 116, 'conjunto_restante': 48, 'stock': 3486}
    plan = plan_descuadre('x', p)
    assert plan['campos'] == {'stock': 11648}
    assert plan['antes']['stock'] == 3486


def test_con_variedades_el_stock_sigue_a_la_suma():
    p = {'es_conjunto': True, 'conjunto_contenido': 50, 'stock': 1000,
         'conjunto_colores': [
             {'color': 'Azul',  'unidades': 12, 'restante': 52},
             {'color': 'Roja',  'unidades': 2,  'restante': 15},
         ]}
    # 12x50+52 + 2x50+15 = 652 + 115
    assert plan_descuadre('x', p)['campos'] == {'stock': 767}


def test_cada_variedad_usa_su_propia_presentacion():
    p = {'es_conjunto': True, 'conjunto_contenido': 12, 'stock': 0,
         'conjunto_colores': [
             {'color': 'Violeta', 'unidades': 0, 'restante': 13},
             {'color': 'Azul',    'unidades': 3, 'restante': 50, 'contenido': 50},
         ]}
    # 13 + (3x50+50) = 13 + 200
    assert plan_descuadre('x', p)['campos'] == {'stock': 213}


def test_un_conjunto_cuadrado_no_se_toca():
    p = {'es_conjunto': True, 'conjunto_contenido': 50,
         'conjunto_unidades': 2, 'conjunto_restante': 10, 'stock': 110}
    assert plan_descuadre('x', p) is None


def test_un_total_con_decimales_ya_redondeado_no_se_reescribe():
    # ABROJO por metro: 995,4 m en el conjunto y 995 en el plano. El plano ya
    # es el piso del total: reescribirlo lo dejaria igual para siempre.
    p = {'es_conjunto': True, 'conjunto_contenido': 100,
         'conjunto_unidades': 9, 'conjunto_restante': 95.4, 'stock': 995}
    assert plan_descuadre('x', p) is None
    p['stock'] = 996
    assert plan_descuadre('x', p)['campos'] == {'stock': 995}


def test_un_conjunto_ilimitado_no_se_toca():
    p = {'es_conjunto': True, 'conjunto_contenido': 50, 'stock_ilimitado': True,
         'conjunto_unidades': 2, 'conjunto_restante': 10, 'stock': 999}
    assert plan_descuadre('x', p) is None


def test_un_producto_plano_no_entra_en_el_descuadre():
    assert plan_descuadre('x', {'stock': 5}) is None
    assert plan_descuadre('x', {'es_conjunto': True, 'conjunto_contenido': 0,
                                'stock': 5}) is None


def test_el_stock_nunca_queda_negativo():
    p = {'es_conjunto': True, 'conjunto_contenido': 50,
         'conjunto_unidades': 0, 'conjunto_restante': 0, 'stock': 40}
    assert plan_descuadre('x', p)['campos'] == {'stock': 0}


# --------------------------------------------------------------------------
# packs: los cerrados vuelven a ser enteros sin mover la cantidad
# --------------------------------------------------------------------------

def test_los_packs_fraccionarios_se_reparten_de_nuevo():
    # LIMPIA PIPA: 105,12 packs de 100 + 1.136 sueltas = 11.648 unidades.
    p = {'es_conjunto': True, 'conjunto_contenido': 100,
         'conjunto_unidades': 105.12, 'conjunto_restante': 1136.0, 'stock': 3486}
    plan = plan_packs('x', p)
    assert plan['campos']['conjunto_unidades'] == 116
    assert plan['campos']['conjunto_restante'] == 48
    # La cantidad no se mueve: 105,12 x 100 + 1.136 == 116 x 100 + 48
    assert plan['campos']['conjunto_total'] == 11648
    assert plan['campos']['stock'] == 11648


def test_las_variedades_rotas_se_reparten_una_por_una():
    # Los cuatro colores del BIC tal cual estaban guardados.
    p = {'es_conjunto': True, 'conjunto_contenido': 50, 'stock': 625,
         'conjunto_colores': [
             {'color': 'Azul',  'unidades': 5.92, 'restante': 9.0},
             {'color': 'Roja',  'unidades': -0.06000000000000005, 'restante': 21.0},
             {'color': 'Verde', 'unidades': 0.8400000000000001, 'restante': 35.0},
             {'color': 'Negra', 'unidades': 3.6999999999999993, 'restante': 40.0},
         ]}
    plan = plan_packs('x', p)
    nuevos = plan['campos']['conjunto_colores']
    assert [c['unidades'] for c in nuevos] == [6, 0, 1, 4]
    assert [c['restante'] for c in nuevos] == [5, 18, 27, 25]
    # Sin limpiar el ruido de float, Roja quedaria en 17,999999999999996.
    assert all(float(c['restante']).is_integer() for c in nuevos)
    # Lo que no es unidades/restante viaja intacto.
    assert [c['color'] for c in nuevos] == ['Azul', 'Roja', 'Verde', 'Negra']
    # El total del producto no cambia: seguian siendo 625 unidades.
    assert plan['campos']['conjunto_total'] == 625
    assert plan['campos']['stock'] == 625


def test_la_variedad_negativa_queda_en_cero_packs():
    # Roja tenia -0,06 packs (3 unidades vendidas de mas) y 21 sueltas: son 18.
    p = {'es_conjunto': True, 'conjunto_contenido': 50, 'stock': 18,
         'conjunto_colores': [{'color': 'Roja', 'unidades': -0.06, 'restante': 21.0}]}
    nuevos = plan_packs('x', p)['campos']['conjunto_colores']
    assert nuevos[0]['unidades'] == 0
    assert nuevos[0]['restante'] == 18


def test_un_conjunto_con_packs_enteros_no_se_toca():
    p = {'es_conjunto': True, 'conjunto_contenido': 50,
         'conjunto_unidades': 12, 'conjunto_restante': 52, 'stock': 652}
    assert plan_packs('x', p) is None


def test_sin_contenido_no_se_reparte_nada():
    p = {'es_conjunto': True, 'conjunto_contenido': 0,
         'conjunto_unidades': 3.5, 'conjunto_restante': 0, 'stock': 3}
    assert plan_packs('x', p) is None


def test_el_original_no_se_modifica():
    p = {'es_conjunto': True, 'conjunto_contenido': 50, 'stock': 305,
         'conjunto_colores': [{'color': 'Azul', 'unidades': 5.92, 'restante': 9.0}]}
    plan_packs('x', p)
    assert p['conjunto_colores'][0]['unidades'] == 5.92


# --------------------------------------------------------------------------
# servicios: no llevan control de stock
# --------------------------------------------------------------------------

def test_una_impresion_en_negativo_pasa_a_ilimitada():
    p = {'nombre': 'IMPRESION / FOTOCOPIA A4 (B/N)', 'stock': -3168}
    plan = plan_servicio('x', p)
    assert plan['campos'] == {'stock_ilimitado': True, 'stock': 0}
    assert plan['antes']['stock'] == -3168


def test_el_insumo_no_es_un_servicio():
    # "Hoja para fotocopias" es lo que SE REPONE: su stock es de verdad.
    p = {'nombre': 'HOJA BOREAL OFICIO 75 GR X 1', 'stock': -3}
    assert plan_servicio('x', p) is None
    assert plan_servicio('x', {'nombre': 'PAPEL OBRA A3 180 GR', 'stock': -5}) is None


def test_un_servicio_en_positivo_no_se_toca():
    assert plan_servicio('x', {'nombre': 'PLASTIFICADO A4/OFICIO', 'stock': 4}) is None


def test_un_servicio_ya_marcado_no_se_vuelve_a_escribir():
    p = {'nombre': 'ANILLADO A4 1', 'stock': -76, 'stock_ilimitado': True}
    assert plan_servicio('x', p) is None


def test_un_producto_comun_en_negativo_no_pasa_a_ilimitado():
    # Un globo en -470 es un problema de conteo, no un servicio.
    assert plan_servicio('x', {'nombre': 'GLOBO GLOBOLANDIA FELIZ CUMPLE X 1',
                               'stock': -470}) is None


# --------------------------------------------------------------------------
# precios: valores fijos, uno por uno
# --------------------------------------------------------------------------

def test_el_precio_inflado_x1000_vuelve_a_su_valor():
    p = {'nombre': 'GORROS NAVIDAD', 'precio_venta': 1139000.0, 'costo': 500.0}
    plan = plan_precio('24620', p)
    assert plan['campos'] == {'precio_venta': 1100.0}
    assert plan['antes']['precio_venta'] == 1139000.0


def test_cuando_el_costo_tambien_estaba_inflado_bajan_los_dos():
    # La lista admite costo ademas de precio (asi se corrigieron dos productos
    # en la corrida del 28-08; los costos reales no viajan en el repo, que es
    # publico). Entrada sintetica con la misma forma.
    _mod.PRECIOS['TEST1'] = {'nombre': 'PRODUCTO DE PRUEBA',
                             'precio_venta': 1300.0, 'costo': 700.0}
    try:
        p = {'nombre': 'PRODUCTO DE PRUEBA',
             'precio_venta': 1300000.0, 'costo': 700000.0}
        plan = plan_precio('TEST1', p)
        assert plan['campos'] == {'precio_venta': 1300.0, 'costo': 700.0}
    finally:
        del _mod.PRECIOS['TEST1']


def test_un_producto_que_no_esta_en_la_lista_no_se_toca():
    assert plan_precio('190500001479', {'precio_venta': 688300.0}) is None
    assert plan_precio('otro', {'precio_venta': 999999.0}) is None


def test_si_ya_esta_corregido_no_se_reescribe():
    p = {'nombre': 'GORROS NAVIDAD', 'precio_venta': 1100.0, 'costo': 632.77}
    assert plan_precio('24620', p) is None


# --------------------------------------------------------------------------
# cargas manuales: el numero que puso una persona no se pisa
# --------------------------------------------------------------------------

def test_la_carga_manual_vigente_queda_protegida():
    # CUADERNO POTOSI, 26-08: cargaron 21 a mano por el editor rapido (que no
    # toca el conjunto) y el conjunto decia 19. El 21 manda.
    movs = [{'firebase_id': 'c1', 'motivo': 'edicion_manual',
             'stock_despues': 21, 'ts': 2}]
    assert cargas_manuales_vigentes(movs, {'c1': {'stock': 21}}) == {'c1'}


def test_si_el_stock_ya_se_movio_la_carga_no_vale():
    # Algo toco el plano despues de la carga: el 21 dejo de ser la foto.
    movs = [{'firebase_id': 'c1', 'motivo': 'reposicion',
             'stock_despues': 21, 'ts': 1}]
    assert cargas_manuales_vigentes(movs, {'c1': {'stock': 19}}) == set()


def test_gana_la_ultima_carga_manual():
    movs = [
        {'firebase_id': 'c1', 'motivo': 'conteo',         'stock_despues': 50, 'ts': 1},
        {'firebase_id': 'c1', 'motivo': 'edicion_manual', 'stock_despues': 30, 'ts': 2},
    ]
    assert cargas_manuales_vigentes(movs, {'c1': {'stock': 30}}) == {'c1'}
    assert cargas_manuales_vigentes(movs, {'c1': {'stock': 50}}) == set()


def test_una_venta_no_es_una_carga():
    movs = [{'firebase_id': 'c1', 'motivo': 'venta', 'stock_despues': 21, 'ts': 1}]
    assert cargas_manuales_vigentes(movs, {'c1': {'stock': 21}}) == set()


def test_las_filas_del_propio_script_no_protegen():
    # Si el script ya corrio una vez, sus propias filas no pueden frenar la
    # proxima corrida.
    movs = [{'firebase_id': 'c1', 'motivo': 'edicion_manual',
             'usuario': 'fix_stock_catalogo', 'stock_despues': 21, 'ts': 1}]
    assert cargas_manuales_vigentes(movs, {'c1': {'stock': 21}}) == set()


def test_una_fila_sin_ts_no_rompe_el_orden():
    movs = [
        {'firebase_id': 'c1', 'motivo': 'conteo', 'stock_despues': 50},
        {'firebase_id': 'c1', 'motivo': 'conteo', 'stock_despues': 40},
        {'firebase_id': 'c1', 'motivo': 'edicion_manual', 'stock_despues': 21, 'ts': 1},
    ]
    assert cargas_manuales_vigentes(movs, {'c1': {'stock': 21}}) == {'c1'}


def test_el_plan_protegido_no_escribe_el_stock_plano():
    planes = {'c1': {'campos': {'stock': 19}, 'antes': {'stock': 21},
                     'nombre': 'CUADERNO', 'grupos': ['descuadre']}}
    filtrados, avisos = aplicar_proteccion(planes, {'c1'})
    assert 'c1' not in filtrados
    assert avisos['c1']['campos']['stock'] == 19


def test_el_resto_del_plan_protegido_sigue_en_pie():
    # Packs fraccionarios: el reparto se arregla igual, solo el plano queda quieto.
    planes = {'c1': {'campos': {'stock': 100, 'conjunto_unidades': 2,
                                'conjunto_restante': 0},
                     'antes': {'stock': 105}, 'nombre': 'X', 'grupos': ['packs']}}
    filtrados, avisos = aplicar_proteccion(planes, {'c1'})
    assert filtrados['c1']['campos'] == {'conjunto_unidades': 2, 'conjunto_restante': 0}
    assert 'c1' in avisos


def test_sin_proteccion_el_plan_pasa_intacto():
    planes = {'c1': {'campos': {'stock': 19}, 'antes': {'stock': 21},
                     'nombre': 'X', 'grupos': ['descuadre']}}
    filtrados, avisos = aplicar_proteccion(planes, set())
    assert filtrados == planes
    assert avisos == {}


# --------------------------------------------------------------------------
# total_de: la cuenta que usan los dos planes de conjunto
# --------------------------------------------------------------------------

def test_total_de_suma_packs_por_contenido_mas_sueltas():
    assert total_de({'conjunto_contenido': 50, 'conjunto_unidades': 2,
                     'conjunto_restante': 38}) == 138


def test_total_de_prefiere_las_variedades():
    p = {'conjunto_contenido': 50, 'conjunto_unidades': 99, 'conjunto_restante': 99,
         'conjunto_colores': [{'color': 'A', 'unidades': 1, 'restante': 5}]}
    assert total_de(p) == 55


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
