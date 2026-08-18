"""
Cuándo una lápida de `catalogo_deleted` borra un producto y cuándo no.

    python -m pytest pos_system/tests/test_tombstones.py -q

El caso que estaba mal: BLISTER DE CEBITAS (código JUG545000, barras 987913).
El código venía de un producto borrado el 23/07, el producto nuevo se creó el
27/07 y el POS lo borraba de la base de cada PC apenas lo bajaba. Se veía en el
panel y en la tienda, y en la caja no aparecía nunca.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from pos_system.models.tombstones import lapida_manda, senal_de_vida

LAPIDA = datetime(2026, 7, 23, 22, 28, tzinfo=timezone.utc)
DESPUES = LAPIDA + timedelta(days=4)
ANTES = LAPIDA - timedelta(days=4)


def test_producto_creado_despues_de_la_lapida_se_queda():
    # El caso Cebitas: código reciclado.
    cebitas = {'nombre': 'BLISTER DE CEBITAS',
               'fecha_creacion': DESPUES,
               'ultima_actualizacion': DESPUES}
    assert lapida_manda(LAPIDA, cebitas) is False


def test_producto_sin_fecha_de_creacion_pero_tocado_despues_se_queda():
    # AUTO-60 y AUTO-62: sin fecha_creacion, con ultima_actualizacion posterior.
    assert lapida_manda(LAPIDA, {'ultima_actualizacion': DESPUES}) is False


def test_lapida_posterior_al_producto_si_borra():
    # DESCUENTO 15 %: creado y borrado siete segundos después.
    borrado = {'fecha_creacion': ANTES, 'ultima_actualizacion': ANTES}
    assert lapida_manda(LAPIDA, borrado) is True


def test_sin_producto_en_el_catalogo_la_lapida_manda():
    assert lapida_manda(LAPIDA, None) is True


def test_producto_en_el_catalogo_sin_ninguna_fecha_se_queda():
    # No se puede fechar: manda el catálogo, que dice que existe.
    assert lapida_manda(LAPIDA, {'nombre': 'ALGO'}) is False


def test_lapida_sin_fecha_sobre_producto_vivo_no_borra():
    assert lapida_manda(None, {'ultima_actualizacion': ANTES}) is False


def test_fechas_en_texto_valen_igual():
    producto = {'ultima_actualizacion': '2026-07-27T15:53:34.836000+00:00'}
    assert lapida_manda('2026-07-23T22:28:20.700000+00:00', producto) is False


def test_fecha_sin_zona_se_lee_como_utc():
    producto = {'ultima_actualizacion': datetime(2026, 7, 27, 15, 53)}
    assert lapida_manda(LAPIDA, producto) is False


def test_senal_de_vida_toma_la_fecha_mas_reciente():
    assert senal_de_vida({'fecha_creacion': ANTES,
                          'ultima_actualizacion': DESPUES}) == DESPUES
    assert senal_de_vida({'fecha_creacion': DESPUES,
                          'ultima_actualizacion': ANTES}) == DESPUES
    assert senal_de_vida(None) is None
    assert senal_de_vida({}) is None


if __name__ == '__main__':
    import pytest
    raise SystemExit(pytest.main([__file__, '-q']))
