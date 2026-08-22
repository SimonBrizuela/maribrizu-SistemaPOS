"""
El plan de correccion del pack fantasma, sin tocar Firestore.

    python -m pytest pos_system/tests/test_corregir_pack_abierto.py -q
"""
import importlib.util
import os
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, RAIZ)

_spec = importlib.util.spec_from_file_location(
    'corregir_pack_abierto', os.path.join(RAIZ, 'scripts', 'corregir_pack_abierto.py'))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
plan_para = _mod.plan_para
MARCA = _mod.MARCA


def test_no_conjunto_no_tiene_plan():
    assert plan_para({'stock': 5}) is None
    assert plan_para({'es_conjunto': False, 'conjunto_unidades': 3, 'conjunto_restante': 2}) is None


def test_papel_con_sueltos_pierde_el_pack_abierto():
    # El caso del 22-08: 3 packs de 250 y 36 sueltas guardados como 786.
    plan = plan_para({'es_conjunto': True, 'conjunto_contenido': 250,
                      'conjunto_unidades': 3, 'conjunto_restante': 36, 'conjunto_total': 786})
    assert plan['cambia']
    assert plan['total_antes'] == 786
    assert plan['total_despues'] == 536
    assert plan['campos']['conjunto_unidades'] == 2
    assert plan['campos']['conjunto_restante'] == 36
    assert plan['campos']['conjunto_total'] == 536
    assert plan['campos']['stock'] == 536
    assert plan['campos'][MARCA] is True


def test_sin_sueltos_solo_recibe_la_marca():
    plan = plan_para({'es_conjunto': True, 'conjunto_contenido': 250,
                      'conjunto_unidades': 3, 'conjunto_restante': 0, 'conjunto_total': 750})
    assert not plan['cambia']
    assert plan['campos'] == {MARCA: True}


def test_solo_sueltos_sin_packs_no_cambia():
    plan = plan_para({'es_conjunto': True, 'conjunto_contenido': 250,
                      'conjunto_unidades': 0, 'conjunto_restante': 40, 'conjunto_total': 40})
    assert not plan['cambia']
    assert plan['campos'] == {MARCA: True}


def test_sin_contenido_no_se_toca_el_numero():
    plan = plan_para({'es_conjunto': True, 'conjunto_contenido': 0,
                      'conjunto_unidades': 3, 'conjunto_restante': 5, 'conjunto_total': 8})
    assert not plan['cambia']
    assert plan['campos'] == {MARCA: True}


def test_variedades_se_corrigen_una_por_una():
    p = {
        'es_conjunto': True, 'conjunto_contenido': 60, 'conjunto_total': 328,
        'conjunto_colores': [
            {'color': 'Azul',  'unidades': 2, 'restante': 50},             # pierde un pack
            {'color': 'Negro', 'unidades': 2, 'restante': 0},              # queda igual
            {'color': 'Rojo',  'unidades': 1, 'restante': 3, 'contenido': 12},  # con su contenido
        ],
    }
    plan = plan_para(p)
    assert plan['cambia']
    assert plan['variedades'] == 2
    nuevos = plan['campos']['conjunto_colores']
    assert [c['unidades'] for c in nuevos] == [1, 2, 0]
    assert plan['campos']['conjunto_total'] == 1 * 60 + 50 + 2 * 60 + 0 + 0 * 12 + 3
    assert plan['campos']['conjunto_unidades'] == 3
    assert plan['campos']['conjunto_restante'] == 53
    # Lo que no es unidades/restante viaja intacto.
    assert nuevos[2]['contenido'] == 12
    assert nuevos[0]['color'] == 'Azul'


def test_el_original_no_se_modifica():
    p = {'es_conjunto': True, 'conjunto_contenido': 250,
         'conjunto_colores': [{'color': 'A', 'unidades': 3, 'restante': 36}]}
    plan_para(p)
    assert p['conjunto_colores'][0]['unidades'] == 3
