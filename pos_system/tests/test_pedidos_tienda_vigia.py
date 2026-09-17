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


class _Escucha:
    _closed = False

    def unsubscribe(self):
        pass


class _Consulta:
    def __init__(self, falla=False):
        self.falla = falla

    def on_snapshot(self, _fn):
        if self.falla:
            raise RuntimeError('sin permiso')
        return _Escucha()


def _vigia(monkeypatch, fallan=()):
    # QApplication: una QCoreApplication creada acá tira abajo las pruebas de
    # pantallas que corren después en la misma suite.
    os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
    from PyQt5.QtWidgets import QApplication
    global _APP
    _APP = QApplication.instance() or QApplication([])
    from pos_system.utils.pedidos_tienda_watcher import VigiaPedidos
    v = VigiaPedidos(db=None, nube=None, descontar_reparto=False)
    monkeypatch.setattr(v, '_consultas', lambda: {n: _Consulta(n in fallan)
                                                  for n in ('en_curso', 'reparto', 'cobrar', 'entregados')})
    monkeypatch.setattr(v, '_probar_conexion', lambda: v.estado_conexion.emit(True))
    return v


def test_la_hora_del_servidor_corrige_un_reloj_atrasado(monkeypatch):
    v = _vigia(monkeypatch)
    ahora = datetime.now(timezone.utc)
    v._anotar_hora(ahora + timedelta(hours=1))
    assert abs((v.ahora() - (ahora + timedelta(hours=1))).total_seconds()) < 5
    # Unos segundos son la demora de la red, no un reloj corrido.
    v._anotar_hora(datetime.now(timezone.utc) - timedelta(seconds=3))
    assert abs((v.ahora() - datetime.now(timezone.utc)).total_seconds()) < 1
    v._anotar_hora(None)
    assert abs((v.ahora() - datetime.now(timezone.utc)).total_seconds()) < 1


def test_una_escucha_que_no_abre_no_queda_tapada_por_en_vivo(monkeypatch):
    v = _vigia(monkeypatch, fallan=('cobrar',))
    estados = []
    v.estado_conexion.connect(estados.append)
    v._activo = True
    v._abrir_todas()
    assert estados == [False]
    for _ in range(3):
        v.revisar()
    assert True not in estados


def test_completo_recien_con_las_cuatro(monkeypatch):
    v = _vigia(monkeypatch)
    estados = []
    v.estado_conexion.connect(estados.append)
    for n, nombre in enumerate(('en_curso', 'reparto', 'cobrar')):
        v._recibir(nombre, {})
        assert not v.completo()
    v._recibir('entregados', {})
    assert v.completo() and estados == [True]
    v._recibir('cobrar', {})
    assert estados == [True]
