"""
La franja de pedidos web arriba de todas las pestañas del POS.

Lo que tiene que pasar en el mostrador:
  · llega un pedido: suena una vez y la franja dice cuál es, sin tapar nada;
  · mientras nadie lo acepte, vuelve a sonar cada tanto (no con la pestaña a
    la vista);
  · lo acepta cualquier caja: la franja se va y deja de sonar en todas;
  · lo que falta cobrar se muestra, pero no insiste con sonidos.
"""
import os
import sys
from datetime import datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

pytest.importorskip('PyQt5.QtWidgets')
from PyQt5.QtWidgets import QApplication  # noqa: E402

from pos_system.models import pedido_tienda as reglas  # noqa: E402
from pos_system.ui import pedidos_web_aviso as aviso  # noqa: E402

AHORA = datetime.now(reglas.TZ_AR)


@pytest.fixture(scope='module')
def app():
    yield QApplication.instance() or QApplication([])


def pedido(pid, **extra):
    p = {'id': pid, 'codigo': pid.upper(), 'estado': 'nuevo', 'creado': AHORA, 'total': 12500,
         'cliente': {'nombre': 'María Fernanda Gómez'}, 'entrega': {'modo': 'delivery'}}
    p.update(extra)
    return p


A_COBRAR = dict(estado='entregado', cobro_pendiente=True, stock_descontado=True, entregado_por='reparto',
                entregado_en=AHORA)


# ── Qué pedidos avisa ───────────────────────────────────────────────────────

def test_pendientes_nuevos_y_a_cobrar_los_mas_viejos_primero():
    pedidos = {
        'b': pedido('b', creado=AHORA),
        'a': pedido('a', creado=AHORA - timedelta(minutes=5), entrega={'modo': 'retiro'}),
        'c': pedido('c', **A_COBRAR),
        'd': pedido('d', estado='preparando'),
        'e': pedido('e', estado='entregado', cobro={'estado': 'hecho'}),
    }
    r = reglas.pendientes_de_aviso(pedidos)
    assert [p['id'] for p in r['nuevos']] == ['a', 'b']
    assert [p['id'] for p in r['cobrar']] == ['c']
    assert r['nuevos'][0] == {'id': 'a', 'codigo': 'A', 'cliente': 'María Fernanda Gómez', 'total': 12500,
                              'envio': False, 'por_reparto': False}
    assert r['cobrar'][0]['por_reparto'] is True


def test_textos_de_la_franja():
    uno = reglas.pendientes_de_aviso([pedido('k7m2')])
    assert aviso.textos_de_la_franja(uno) == (
        'Pedido web nuevo', 'K7M2 · María Fernanda Gómez · $12.500 · envío a domicilio', 'nuevo', 'Ver pedido')
    varios = reglas.pendientes_de_aviso([pedido('a'), pedido('b'), pedido('c'), pedido('r', **A_COBRAR)])
    titulo, detalle, tono, boton = aviso.textos_de_la_franja(varios)
    assert titulo == '3 pedidos web sin aceptar' and detalle == 'A, B y C · para cobrar: R'
    assert tono == 'nuevo' and boton == 'Ver pedidos'
    cobrar = reglas.pendientes_de_aviso([pedido('r', **A_COBRAR)])
    assert aviso.textos_de_la_franja(cobrar) == (
        'Pedido web para cobrar', 'R · María Fernanda Gómez · $12.500 · lo entregó el repartidor', 'cobrar',
        'Ver pedido')
    assert aviso.textos_de_la_franja({'nuevos': [], 'cobrar': []}) is None


# ── La franja ───────────────────────────────────────────────────────────────

class Reloj:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture
def franja(app):
    sonidos = []
    reloj = Reloj()
    f = aviso.FranjaPedidos(None, sonar=lambda: sonidos.append(reloj.t), reloj=reloj)
    f.resize(1200, 60)
    f.show()
    yield f, sonidos, reloj
    f.close()


def test_se_muestra_con_pendientes_y_se_va_cuando_otra_caja_lo_acepta(franja):
    f, sonidos, _ = franja
    f.actualizar(reglas.pendientes_de_aviso([pedido('k7m2')]))
    assert f.isVisible() and f._titulo.text() == 'Pedido web nuevo'
    # Otra caja lo aceptó: llega el pedido en "preparando".
    f.actualizar(reglas.pendientes_de_aviso([pedido('k7m2', estado='preparando')]))
    assert not f.isVisible()


def test_con_la_pestana_a_la_vista_no_se_muestra(franja):
    f, _, _ = franja
    f.actualizar(reglas.pendientes_de_aviso([pedido('k7m2')]))
    f.set_en_pestana(True)
    assert not f.isVisible()
    f.set_en_pestana(False)
    assert f.isVisible()


def test_recuerda_cada_tanto_mientras_nadie_lo_acepta(franja):
    f, sonidos, reloj = franja
    f.actualizar(reglas.pendientes_de_aviso([pedido('k7m2')]))
    f.avisar_llegada()
    assert sonidos == [1000.0]
    reloj.t += aviso.RECORDAR_CADA_S - 1
    f.revisar_recordatorio()
    assert len(sonidos) == 1
    reloj.t += 1
    f.revisar_recordatorio()
    assert len(sonidos) == 2
    # Con la pestaña abierta no insiste: ya se ve.
    f.set_en_pestana(True)
    reloj.t += aviso.RECORDAR_CADA_S * 3
    f.revisar_recordatorio()
    assert len(sonidos) == 2


def test_aceptado_en_otra_caja_deja_de_sonar(franja):
    f, sonidos, reloj = franja
    f.actualizar(reglas.pendientes_de_aviso([pedido('k7m2')]))
    f.avisar_llegada()
    f.actualizar(reglas.pendientes_de_aviso([pedido('k7m2', estado='preparando')]))
    for _ in range(5):
        reloj.t += aviso.RECORDAR_CADA_S
        f.revisar_recordatorio()
    assert len(sonidos) == 1


def test_lo_que_falta_cobrar_no_insiste_con_sonidos(franja):
    f, sonidos, reloj = franja
    f.actualizar(reglas.pendientes_de_aviso([pedido('r', **A_COBRAR)]))
    assert f.isVisible()
    for _ in range(5):
        reloj.t += aviso.RECORDAR_CADA_S
        f.revisar_recordatorio()
    assert sonidos == []


def test_el_boton_abre_el_pedido_o_la_lista(franja):
    f, _, _ = franja
    pedidos_vistos = []
    f.ver.connect(pedidos_vistos.append)
    f.actualizar(reglas.pendientes_de_aviso([pedido('k7m2')]))
    f._boton.click()
    f.actualizar(reglas.pendientes_de_aviso([pedido('a'), pedido('b')]))
    f._boton.click()
    assert pedidos_vistos == ['k7m2', '']
