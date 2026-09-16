"""
Cómo junta el vigía lo que trae cada escucha, sin Firestore.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import pytest  # noqa: E402

pytest.importorskip('PyQt5.QtCore')

from pos_system.utils.pedidos_tienda_watcher import dias_hacia_atras, juntar  # noqa: E402

TZ = timezone(timedelta(hours=-3))


def test_gana_la_version_mas_nueva_si_esta_en_dos_escuchas():
    t1 = datetime(2026, 9, 16, 18, 0, tzinfo=TZ)
    t2 = t1 + timedelta(seconds=3)
    r = juntar({
        'en_curso': {'A': (t1, {'id': 'A', 'estado': 'listo'})},
        'cobrar': {'A': (t2, {'id': 'A', 'estado': 'entregado'}), 'B': (t1, {'id': 'B'})},
    })
    assert r['A']['estado'] == 'entregado'
    assert set(r) == {'A', 'B'}
    r = juntar({'cobrar': {'A': (t2, {'estado': 'entregado'})}, 'en_curso': {'A': (t1, {'estado': 'listo'})}})
    assert r['A']['estado'] == 'entregado'


def test_dias_de_entregados_en_hora_argentina():
    # 01:30 UTC del 17 es todavía 16 en Argentina.
    ahora = datetime(2026, 9, 17, 1, 30, tzinfo=timezone.utc)
    dias = dias_hacia_atras(ahora, 3)
    assert dias == ['2026-09-16', '2026-09-15', '2026-09-14']
