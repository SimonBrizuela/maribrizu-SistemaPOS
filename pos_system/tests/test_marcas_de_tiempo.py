"""
Leer la marca de tiempo del catálogo venga de donde venga.

    python -m pytest pos_system/tests/test_marcas_de_tiempo.py -q

El caso que estaba mal: `config/catalogo_meta.last_updated` lo escribe el panel
como fecha UTC y el POS como texto ISO en hora de acá. Comparados como texto,
la fecha ("2026-08-18 21:22", con espacio) siempre daba menor que el texto
("2026-08-18T18:24", con T), así que el sync de arranque decidía que no había
nada nuevo y los productos cargados desde el panel no bajaban a las cajas.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from pos_system.models.marcas_de_tiempo import TZ_AR, a_fecha, hay_cambios

UTC = timezone.utc


def test_el_caso_que_rompia_el_sync():
    # Panel: 21:22 UTC. POS: 18:24 hora de acá, o sea 21:24 UTC. La PC está
    # más adelantada, pero como texto la nube parecía mayor... o al revés,
    # según el carácter. Con fechas se compara lo que importa.
    nube = datetime(2026, 8, 18, 21, 22, 46, tzinfo=UTC)
    pc = '2026-08-18T18:24:15'
    assert hay_cambios(nube, pc) is False

    nube_nueva = datetime(2026, 8, 18, 21, 30, 0, tzinfo=UTC)
    assert hay_cambios(nube_nueva, pc) is True


def test_como_texto_el_orden_salia_al_reves():
    # La prueba de que no era un detalle: así comparaba el código viejo.
    nube = datetime(2026, 8, 18, 21, 30, tzinfo=UTC)
    pc = '2026-08-18T18:24:15'
    assert str(nube) <= pc            # texto: "no hay nada nuevo"
    assert hay_cambios(nube, pc)      # fechas: sí lo hay


def test_una_fecha_sin_zona_se_lee_en_hora_de_aca():
    # Es lo que escribe el POS, que usa now_ar().
    assert a_fecha('2026-08-18T18:24:15') == datetime(2026, 8, 18, 18, 24, 15, tzinfo=TZ_AR)
    assert a_fecha(datetime(2026, 8, 18, 18, 24, 15)).utcoffset() == timedelta(hours=-3)


def test_lee_los_formatos_que_aparecen_en_el_sistema():
    esperada = datetime(2026, 8, 18, 21, 22, 46, tzinfo=UTC)
    assert a_fecha('2026-08-18T21:22:46+0000') == esperada
    assert a_fecha('2026-08-18T21:22:46+00:00') == esperada
    assert a_fecha('2026-08-18T21:22:46Z') == esperada
    assert a_fecha('2026-08-18 21:22:46+00:00') == esperada
    assert a_fecha('2026-08-18 21:22:46.000000+00:00') == esperada
    assert a_fecha(datetime(2026, 8, 18, 21, 22, 46, tzinfo=UTC)) == esperada


def test_lo_que_no_se_puede_leer_da_none():
    assert a_fecha('') is None
    assert a_fecha('   ') is None
    assert a_fecha(None) is None
    assert a_fecha('ayer') is None
    assert a_fecha(1755550000) is None


def test_sin_poder_fechar_se_sincroniza_igual():
    # Bajar de más cuesta lecturas; no bajar deja productos sin vender.
    assert hay_cambios('', '2026-08-18T18:24:15') is True
    assert hay_cambios('2026-08-18T18:24:15', '') is True
    assert hay_cambios(None, None) is True
    assert hay_cambios('cualquier cosa', '2026-08-18T18:24:15') is True


def test_el_marcador_nuevo_del_pos_trae_la_zona():
    # Formato que escribe el delta sync al terminar: %z sin dos puntos.
    assert a_fecha('2026-08-18T18:24:15-0300') == datetime(
        2026, 8, 18, 18, 24, 15, tzinfo=TZ_AR)


def test_misma_marca_no_es_cambio():
    marca = '2026-08-18T18:24:15-0300'
    assert hay_cambios(marca, marca) is False


if __name__ == '__main__':
    import pytest
    raise SystemExit(pytest.main([__file__, '-q']))
