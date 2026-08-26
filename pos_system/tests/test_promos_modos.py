"""
Promos del panel con filtro de modo de venta (pack/unidad) y mínimo por modo.

    python -m pytest pos_system/tests/test_promos_modos.py -q

Nace del caso RESMA PAMPA (2026-08-26): la promo estaba pensada "solo desde
10 packs", pero con el modo Unidad habilitado el mínimo global de 10 también
se cumplía con 10 unidades sueltas y el POS descontaba igual. Acá queda
clavado cómo se interpreta cada configuración para que no vuelva a moverse.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from pos_system.utils.promos import (
    evaluar_promo_linea, mejor_promo_linea, promo_match_key, promo_min_override,
)

REFS = ('LI6487', '7790001112223', '42', 'PAPEL OBRA A4 75 GR PAMPA')


def promo_resma(modos):
    """La promo real del caso: 12,82% desde 10, sobre el producto LI6487."""
    return {
        '_id': 'R1eS6RVy88sRnRwQxBc5',
        'nombre': 'RESMA PAMPA',
        'tipo': 'percentage',
        'valor': 12.82051282051282,
        'cantidad_minima': 10,
        'cantidad_maxima': 0,
        'productos': ['LI6487'],
        'variantes': [],
        'modos': modos,
        'activo': True,
    }


# ── promo_match_key: el filtro de modos ──────────────────────────────────────

def test_solo_pack_no_matchea_venta_por_unidad():
    p = promo_resma({'LI6487': {'pack': {'min': 10}}})
    assert promo_match_key(p, REFS, sale_mode='unidad') is None
    assert promo_match_key(p, REFS, sale_mode='pack') == 'LI6487'


def test_sin_entrada_en_modos_matchea_cualquier_modo():
    p = promo_resma({})
    assert promo_match_key(p, REFS, sale_mode='unidad') == 'LI6487'
    assert promo_match_key(p, REFS, sale_mode='pack') == 'LI6487'


def test_forma_legacy_lista_filtra_modos():
    p = promo_resma({'LI6487': ['pack']})
    assert promo_match_key(p, REFS, sale_mode='unidad') is None
    assert promo_match_key(p, REFS, sale_mode='pack') == 'LI6487'


def test_sin_sale_mode_el_filtro_no_aplica():
    # Productos no-conjunto: se venden de una sola forma, el filtro es N/A.
    p = promo_resma({'LI6487': {'pack': {'min': 10}}})
    assert promo_match_key(p, REFS) == 'LI6487'


def test_variante_con_modo():
    p = {
        'nombre': 'X', 'tipo': 'percentage', 'valor': 10,
        'cantidad_minima': 1, 'productos': [],
        'variantes': [{'producto_id': 'LI6487', 'color': 'Rojo'}],
        'modos': {'LI6487::var::Rojo': {'pack': {'min': 5}}},
        'activo': True,
    }
    assert promo_match_key(p, REFS, color='rojo', sale_mode='pack') == 'LI6487::var::Rojo'
    assert promo_match_key(p, REFS, color='rojo', sale_mode='unidad') is None
    assert promo_match_key(p, REFS, color='azul', sale_mode='pack') is None


# ── promo_min_override: el mínimo por modo del chip ──────────────────────────

def test_min_override_formas():
    p = promo_resma({'LI6487': {'pack': {'min': 10}, 'unidad': {'min': 0}}})
    assert promo_min_override(p, 'LI6487', 'pack') == 10
    assert promo_min_override(p, 'LI6487', 'unidad') == 0   # 0 = usa el global
    # Forma numérica directa
    p2 = promo_resma({'LI6487': {'pack': 7}})
    assert promo_min_override(p2, 'LI6487', 'pack') == 7
    # Legacy lista: sin override
    p3 = promo_resma({'LI6487': ['pack', 'unidad']})
    assert promo_min_override(p3, 'LI6487', 'pack') == 0
    # Sin key / sin modo
    assert promo_min_override(promo_resma({}), 'LI6487', 'pack') == 0
    assert promo_min_override(p, '', 'pack') == 0
    assert promo_min_override(p, 'LI6487', '') == 0


# ── evaluar_promo_linea: el caso completo ────────────────────────────────────

def test_caso_resma_config_vieja_documentado():
    # Con Unidad habilitado y min=0, el mínimo global (10) también vale para
    # unidades: 10 hojas sueltas disparaban el 12,82%. Es LO QUE ESTABA MAL
    # configurado — el test documenta que esa config se comporta así.
    p = promo_resma({'LI6487': {'pack': {'min': 10}, 'unidad': {'min': 0}}})
    assert evaluar_promo_linea(p, REFS, 10, 100.0, sale_mode='unidad') is not None


def test_caso_resma_config_solo_pack():
    # La config correcta para "solo desde 10 packs": Unidad deshabilitado.
    p = promo_resma({'LI6487': {'pack': {'min': 10}}})
    assert evaluar_promo_linea(p, REFS, 10, 100.0, sale_mode='unidad') is None
    assert evaluar_promo_linea(p, REFS, 500, 100.0, sale_mode='unidad') is None
    r = evaluar_promo_linea(p, REFS, 10, 8000.0, sale_mode='pack')
    assert r is not None
    eff, disc, label = r
    assert disc > 0 and eff < 8000.0


def test_minimo_por_modo_manda_sobre_el_global():
    # Global 2, pack con override 10: 5 packs no alcanzan, 10 sí.
    p = promo_resma({'LI6487': {'pack': {'min': 10}}})
    p['cantidad_minima'] = 2
    assert evaluar_promo_linea(p, REFS, 5, 8000.0, sale_mode='pack') is None
    assert evaluar_promo_linea(p, REFS, 10, 8000.0, sale_mode='pack') is not None


def test_minimo_global_sin_modos():
    p = promo_resma({})
    assert evaluar_promo_linea(p, REFS, 9, 100.0, sale_mode='unidad') is None
    r = evaluar_promo_linea(p, REFS, 10, 100.0, sale_mode='unidad')
    assert r is not None


def test_promo_inactiva_no_aplica():
    p = promo_resma({})
    p['activo'] = False
    assert evaluar_promo_linea(p, REFS, 50, 100.0, sale_mode='pack') is None


def test_producto_ajeno_no_aplica():
    p = promo_resma({})
    refs_otro = ('OTRO1', '999', '7', 'CUADERNO')
    assert evaluar_promo_linea(p, refs_otro, 50, 100.0, sale_mode='pack') is None


def test_porcentaje_calcula_bien():
    p = promo_resma({})
    p['valor'] = 10.0
    eff, disc, label = evaluar_promo_linea(p, REFS, 10, 100.0, sale_mode='pack')
    assert abs(disc - 100.0) < 0.01          # 10% de 10 x $100
    assert abs(eff - 90.0) < 0.01


# ── mejor_promo_linea: elige la que más descuenta ────────────────────────────

def test_mejor_promo_elige_mayor_descuento():
    p10 = promo_resma({})
    p10['nombre'] = 'DIEZ'
    p10['valor'] = 10.0
    p20 = promo_resma({})
    p20['nombre'] = 'VEINTE'
    p20['valor'] = 20.0
    best = mejor_promo_linea([p10, p20], REFS, 10, 100.0, sale_mode='pack')
    assert best is not None
    fb, eff, disc, label = best
    assert fb['nombre'] == 'VEINTE'
    assert abs(disc - 200.0) < 0.01


def test_mejor_promo_respeta_modos():
    # La del 20% es solo-pack: vendiendo por unidad gana la del 10%.
    p10 = promo_resma({})
    p10['nombre'] = 'DIEZ'
    p10['valor'] = 10.0
    p20 = promo_resma({'LI6487': {'pack': {'min': 10}}})
    p20['nombre'] = 'VEINTE'
    p20['valor'] = 20.0
    best = mejor_promo_linea([p10, p20], REFS, 10, 100.0, sale_mode='unidad')
    assert best is not None and best[0]['nombre'] == 'DIEZ'


def test_mejor_promo_ninguna():
    p = promo_resma({'LI6487': {'pack': {'min': 10}}})
    assert mejor_promo_linea([p], REFS, 10, 100.0, sale_mode='unidad') is None


if __name__ == '__main__':
    import pytest
    raise SystemExit(pytest.main([__file__, '-q']))
