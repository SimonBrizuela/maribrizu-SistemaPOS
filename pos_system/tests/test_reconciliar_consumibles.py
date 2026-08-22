"""
Las reglas del reconciliador de consumibles, sin Firestore.

    python -m pytest pos_system/tests/test_reconciliar_consumibles.py -q
"""
import importlib.util
import os
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, RAIZ)

_spec = importlib.util.spec_from_file_location(
    'reconciliar_consumibles', os.path.join(RAIZ, 'scripts', 'reconciliar_consumibles.py'))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

from pos_system.utils.vinculos_pendientes import planear

IMPRESION = {
    'doc_id': '17106', 'nombre': 'IMPRESION A4 ILUSTRACION 200 GR (COLOR)',
    'vinculaciones': [{'doc_id': '250430', 'cantidad': 1, 'nombre': 'PAPEL'}],
    'vinculado_a': '250430', 'vinculado_cantidad': 1,
}
LEGACY = {'doc_id': 'L', 'nombre': 'IMPRESION VIEJA', 'vinculado_a': 'LI6487', 'vinculado_cantidad': 2}
CONJ_VAR = {
    'doc_id': 'C', 'nombre': 'PACK CON VARIEDADES', 'es_conjunto': True,
    'vinculaciones': [{'doc_id': 'GLOBAL', 'cantidad': 1}],
    'conjunto_colores': [
        {'color': 'Rojo', 'vinculaciones': [{'doc_id': 'ROJO-T', 'cantidad': 3}]},
        {'color': 'Azul'},
    ],
}


def test_links_nuevo_y_legacy():
    assert _mod.links_de(IMPRESION) == [{'doc_id': '250430', 'cantidad': 1.0}]
    assert _mod.links_de(LEGACY) == [{'doc_id': 'LI6487', 'cantidad': 2.0}]
    assert _mod.links_de({'vinculaciones': [{'doc_id': 'X', 'cantidad': 0}]}) == []
    assert _mod.links_de({}) == []


def test_indice_prefiere_el_doc_con_vinculos_si_el_nombre_esta_repetido():
    sin = {'doc_id': 'viejo', 'nombre': 'impresion a4 ilustracion 200 gr (color) '}
    idx = _mod.indice_por_nombre([sin, IMPRESION])
    assert idx['IMPRESION A4 ILUSTRACION 200 GR (COLOR)']['doc_id'] == '17106'
    idx = _mod.indice_por_nombre([IMPRESION, sin])
    assert idx['IMPRESION A4 ILUSTRACION 200 GR (COLOR)']['doc_id'] == '17106'


def test_variedad_manda_sobre_el_producto():
    assert _mod.links_del_item({'conjunto_color': 'rojo'}, CONJ_VAR) == [{'doc_id': 'ROJO-T', 'cantidad': 3.0}]
    # Variedad sin vinculos propios: no cae al global.
    assert _mod.links_del_item({'conjunto_color': 'Azul'}, CONJ_VAR) == []
    # Sin color se usan los del producto.
    assert _mod.links_del_item({'conjunto_color': ''}, CONJ_VAR) == [{'doc_id': 'GLOBAL', 'cantidad': 1.0}]


def test_grupo_multiplica_por_la_cantidad_vendida():
    grupo = _mod.grupo_del_item({'cantidad': 13, 'producto': 'x'}, IMPRESION)
    assert grupo == [{'item_idx': 0, 'target_fid': '250430', 'delta': 13.0,
                      'contexto': 'IMPRESION A4 ILUSTRACION 200 GR (COLOR)'}]
    # Cantidad ausente cuenta como 1, y un vinculo repetido se aplica una vez.
    doble = dict(IMPRESION, vinculaciones=IMPRESION['vinculaciones'] * 2)
    assert [g['delta'] for g in _mod.grupo_del_item({}, doble)] == [1.0]


def test_el_grupo_se_aplica_con_la_regla_del_pos():
    grupo = _mod.grupo_del_item({'cantidad': 8}, IMPRESION)
    plan = planear(grupo, {'250430': {'es_conjunto': True, 'conjunto_total': 536, 'conjunto_contenido': 250}})
    assert plan['conjuntos']['250430']['total'] == 528
    assert plan['items'][0][0]['cantidad'] == 8.0


def test_candidatos_y_clave_de_venta():
    assert _mod.es_candidato({'producto': 'x'})
    assert not _mod.es_candidato({'consumibles_procesado': True})
    assert not _mod.es_candidato({'deleted': True})
    assert _mod.clave_venta({'pc_id': 'LIBRERIA-d228146f', 'num_venta': 4367}, 'LIBRERIA-d228146f_4367_0') == 'LIBRERIA-d228146f_4367'
    # Sin pc_id en el doc, sale del id.
    assert _mod.clave_venta({'num_venta': 4367}, 'LIBRERIA-d228146f_4367_0') == 'LIBRERIA-d228146f_4367'
    assert _mod.clave_venta({}, 'raro') is None
