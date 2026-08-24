"""
El detector de familias de tamaños del catalogo.

    python -m pytest pos_system/tests/test_agrupar_tamanos.py -q

Agrupa solo lo que termina en una medida de verdad; un numero pelado puede
ser un modelo o un codigo y queda como dudoso, para decidirlo una persona.
"""
import importlib.util
import os

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_spec = importlib.util.spec_from_file_location(
    'agrupar_tamanos', os.path.join(RAIZ, 'scripts', 'agrupar_tamanos.py'))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
detectar = _mod.detectar


def _p(doc_id, nombre, rubro='MERCERIA', grupo=None):
    return {'id': doc_id, 'nombre': nombre, 'rubro': rubro, 'tienda_grupo': grupo}


def test_agrupa_por_medida_del_final():
    aplicables, dudosos, conflictos = detectar([
        _p('a', 'CIERRE COMÚN REFORZADO DE METAL 10 CM'),
        _p('b', 'CIERRE COMÚN REFORZADO DE METAL 12 CM'),
        _p('c', 'CINTA RASO Nº 1'),
        _p('d', 'CINTA RASO Nº 3'),
        _p('e', 'BOLSA CARTON COLOR 14X20'),
        _p('f', 'BOLSA CARTON COLOR 22 X 30'),
    ])
    assert not conflictos
    assert not dudosos
    assert {g['grupo'] for g in aplicables} == {
        'Cierre Común Reforzado de Metal', 'Cinta Raso', 'Bolsa Cartón Color'}
    metal = next(g for g in aplicables if 'Metal' in g['grupo'])
    assert [t for _i, _n, t in metal['miembros']] == ['10 cm', '12 cm']


def test_los_tamanos_quedan_en_orden_numerico():
    aplicables, _d, _c = detectar([
        _p('a', 'CIERRE COMUN 10 CM'),
        _p('b', 'CIERRE COMUN 9 CM'),
        _p('c', 'CIERRE COMUN 25 CM'),
    ])
    assert [t for _i, _n, t in aplicables[0]['miembros']] == ['9 cm', '10 cm', '25 cm']


def test_numero_pelado_es_dudoso_no_se_aplica():
    aplicables, dudosos, _c = detectar([
        _p('a', 'CIERRE INVISIBLE 16'),
        _p('b', 'CIERRE INVISIBLE 18'),
    ])
    assert not aplicables
    assert len(dudosos) == 1


def test_un_solo_miembro_no_hace_grupo():
    aplicables, dudosos, _c = detectar([_p('a', 'CIERRE COMUN 10 CM')])
    assert not aplicables and not dudosos


def test_lo_ya_agrupado_no_se_toca():
    aplicables, _d, _c = detectar([
        _p('a', 'CIERRE COMUN 10 CM', grupo='Cierre Común'),
        _p('b', 'CIERRE COMUN 12 CM', grupo='Cierre Común'),
    ])
    assert not aplicables


def test_etiquetas_repetidas_no_se_arman():
    # Dos productos cargados con el MISMO nombre: dos botones "10 cm" iguales
    # en la ficha no dicen nada, asi que la familia no se arma sola.
    aplicables, _d, conflictos = detectar([
        _p('a', 'CINTA LINDA 10 CM'),
        _p('b', 'CINTA LINDA 10 CM'),
        _p('c', 'CINTA LINDA 12 CM'),
    ])
    assert not aplicables
    assert conflictos and conflictos[0][0] == 'etiquetas de tamaño repetidas'


def test_la_misma_base_en_dos_rubros_no_se_arma_sola():
    # `grupo_clave` es global: si "Regla Acero" existiera en dos rubros, una
    # sola ficha mezclaria tamaños de cosas distintas.
    aplicables, _d, conflictos = detectar([
        _p('a', 'REGLA ACERO 30 CM', rubro='LIBRERIA'),
        _p('b', 'REGLA ACERO 50 CM', rubro='LIBRERIA'),
        _p('c', 'REGLA ACERO 20 CM', rubro='MERCERIA'),
        _p('d', 'REGLA ACERO 60 CM', rubro='MERCERIA'),
    ])
    assert not aplicables
    assert conflictos and conflictos[0][0] == 'la misma base vive en varios rubros'


def test_familias_revisadas_a_mano_quedan_dudosas():
    aplicables, dudosos, _c = detectar([
        _p('a', 'PILA FULLTOTAL 13 X 1', rubro='LIBRERIA'),
        _p('b', 'PILA FULLTOTAL 13 X 6', rubro='LIBRERIA'),
    ])
    assert not aplicables
    assert [g['grupo'] for g in dudosos] == ['Pila Fulltotal']


def test_el_nombre_del_grupo_conserva_tildes_y_enes():
    # La comparacion es sin acentos, pero el nombre que ve el cliente sale de
    # las palabras originales: "CIERRE COMÚN" no puede volverse "Cierre Comun".
    aplicables, _d, _c = detectar([
        _p('a', 'CIERRE COMÚN REFORZADO 10 CM'),
        _p('b', 'CIERRE COMUN REFORZADO 12 CM'),
        _p('c', 'CINTA NAVIDEÑA BROOKLYN 15MM'),
        _p('d', 'CINTA NAVIDEÑA BROOKLYN 25MM'),
    ])
    assert {g['grupo'] for g in aplicables} == {
        'Cierre Común Reforzado', 'Cinta Navideña Brooklyn'}


def test_un_codigo_al_final_no_es_medida():
    aplicables, dudosos, _c = detectar([
        _p('a', 'SOBRE FW A4 HOLOGRAFICO CON CIERRE 7410', rubro='LIBRERIA'),
        _p('b', 'SOBRE FW A4 METALICO CON CIERRE 7411', rubro='LIBRERIA'),
    ])
    # Bases distintas (holografico / metalico): ni grupo ni dudoso juntos.
    assert not aplicables
    assert not dudosos
