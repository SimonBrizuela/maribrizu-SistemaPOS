"""
El nombre con que la tienda muestra lo que el catalogo guarda en mayusculas.

    python -m pytest pos_system/tests/test_nombre_bonito.py -q

Mismos casos que tienda/pruebas/nombre_bonito.test.js: la regla esta escrita
en Python (sync) y en JS (panel) y tienen que dar lo mismo.
"""
import importlib.util
import json
import os

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_spec = importlib.util.spec_from_file_location(
    'sync_tienda', os.path.join(RAIZ, 'scripts', 'sync_tienda.py'))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
nombre_bonito = _mod.nombre_bonito

with open(os.path.join(RAIZ, 'tienda', 'pruebas', 'casos_nombre_bonito.json'), encoding='utf-8') as f:
    CASOS = json.load(f)['casos']


def test_casos_compartidos():
    for c in CASOS:
        assert nombre_bonito(c['entrada']) == c['salida'], c['que']


def test_es_estable_sobre_su_propio_resultado():
    for c in CASOS:
        assert nombre_bonito(c['salida'].upper()) == c['salida'], c['que']
