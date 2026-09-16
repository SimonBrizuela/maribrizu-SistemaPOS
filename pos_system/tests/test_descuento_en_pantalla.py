"""
El diálogo de Descuento (F6) tiene que entrar entero en la pantalla de la caja.

En una notebook de 768, o con la escala de Windows al 125/150%, se cortaba por
abajo y había que arrastrar la ventana para llegar a "Aplicar". Al elegir
"Solo los que elija" aparecía la lista y la ventana crecía para abajo, fuera de
la pantalla.

Corre sin pantalla (`QT_QPA_PLATFORM=offscreen`). La pantalla se simula: el
diálogo pregunta por la suya con `_pantalla()`.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

pytest.importorskip('PyQt5.QtWidgets', reason='el POS necesita PyQt5')

from PyQt5.QtCore import QPoint, QRect, Qt  # noqa: E402
from PyQt5.QtTest import QTest  # noqa: E402
from PyQt5.QtWidgets import QApplication  # noqa: E402

from pos_system.ui import descuento_dialog as dd  # noqa: E402
from pos_system.ui.descuento_dialog import MARGEN_PANTALLA, geometria_en_pantalla  # noqa: E402

_ABIERTAS = []

# Áreas útiles reales (sin barra de tareas) de las pantallas que hay en juego.
PANTALLAS = {
    '1920x1080':          QRect(0, 0, 1920, 1032),
    '1366x768':           QRect(0, 0, 1366, 728),
    '1920x1080 al 150%':  QRect(0, 0, 1280, 680),
    '1366x768 al 125%':   QRect(0, 0, 1093, 574),
    'segundo monitor':    QRect(1920, 0, 1366, 728),
}


@pytest.fixture(scope='module')
def app():
    yield QApplication.instance() or QApplication([])
    _ABIERTAS.clear()


class _Pantalla:
    def __init__(self, area):
        self._area = area

    def availableGeometry(self):
        return self._area


def carrito(n=10):
    return [{'product_name': f'CUADERNO RIVADAVIA ABC TAPA DURA 50 HOJAS RAYADAS NRO {i}',
             'quantity': i, 'subtotal': 12345.5 * i} for i in range(1, n + 1)]


def abrir(app, monkeypatch, area, **kw):
    monkeypatch.setattr(dd.DescuentoDialog, '_pantalla', lambda self: _Pantalla(area))
    dlg = dd.DescuentoDialog(None, cart=kw.pop('cart', carrito()), **kw)
    _ABIERTAS.append(dlg)
    dlg.show()
    app.processEvents()
    return dlg


def marco_adentro(dlg, area):
    f = dlg.frameGeometry()
    return (f.left() >= area.left() and f.top() >= area.top()
            and f.right() <= area.right() and f.bottom() <= area.bottom())


def boton_visible(dlg, boton):
    abajo = boton.mapTo(dlg, QPoint(0, boton.height()))
    return boton.isVisible() and abajo.y() <= dlg.height()


# ── La cuenta de dónde va ────────────────────────────────────────────────────

class TestGeometria:

    def test_si_entra_se_centra_donde_se_pidio(self):
        area = QRect(0, 0, 1920, 1032)
        x, y, w, h = geometria_en_pantalla(area, 560, 600, 16, 39, centro=QPoint(960, 516))
        assert (w, h) == (560, 600)
        assert x + (w + 16) // 2 == 960
        assert y + (h + 39) // 2 == 516

    def test_si_no_entra_se_achica_al_alto_util(self):
        area = QRect(0, 0, 1366, 728)
        _x, y, _w, h = geometria_en_pantalla(area, 560, 900, 16, 39, centro=area.center())
        assert h == 728 - 39 - 2 * MARGEN_PANTALLA
        assert y == MARGEN_PANTALLA

    def test_crecer_para_abajo_no_la_saca_de_la_pantalla(self):
        """El caso que había que arrastrar: la ventana abajo de todo y la lista
        que aparece."""
        area = QRect(0, 0, 1366, 728)
        x, y, _w, h = geometria_en_pantalla(area, 560, 600, 16, 39, esquina=QPoint(300, 400))
        assert x == 300
        assert y + h + 39 <= area.bottom() + 1 - MARGEN_PANTALLA

    def test_respeta_el_origen_del_segundo_monitor(self):
        area = QRect(1920, 0, 1366, 728)
        x, _y, _w, _h = geometria_en_pantalla(area, 560, 500, 16, 39, esquina=QPoint(100, 100))
        assert x >= 1920 + MARGEN_PANTALLA


# ── El diálogo de verdad ─────────────────────────────────────────────────────

@pytest.mark.parametrize('nombre', list(PANTALLAS))
def test_entra_entero_al_abrir(app, monkeypatch, nombre):
    area = PANTALLAS[nombre]
    dlg = abrir(app, monkeypatch, area)
    assert marco_adentro(dlg, area)
    assert boton_visible(dlg, dlg.aplicar_btn)


@pytest.mark.parametrize('nombre', list(PANTALLAS))
def test_elegir_productos_no_la_saca_de_la_pantalla(app, monkeypatch, nombre):
    area = PANTALLAS[nombre]
    dlg = abrir(app, monkeypatch, area)
    dlg.valor_input.setText('15')
    dlg.redondear_btn.setChecked(True)
    dlg.rb_elegidos.setChecked(True)
    app.processEvents()

    assert dlg.lista.isVisible()
    assert marco_adentro(dlg, area)
    assert boton_visible(dlg, dlg.aplicar_btn)
    assert dlg.resumen.isVisible()


def test_con_lugar_no_hace_falta_desplazar(app, monkeypatch):
    dlg = abrir(app, monkeypatch, PANTALLAS['1366x768'])
    dlg.valor_input.setText('15')
    dlg.redondear_btn.setChecked(True)
    dlg.rb_elegidos.setChecked(True)
    app.processEvents()
    assert dlg._cuerpo.verticalScrollBar().maximum() == 0


def test_volver_a_todo_el_carrito_la_achica(app, monkeypatch):
    dlg = abrir(app, monkeypatch, PANTALLAS['1920x1080'])
    alto_inicial = dlg.height()
    dlg.rb_elegidos.setChecked(True)
    app.processEvents()
    assert dlg.height() > alto_inicial
    dlg.rb_todo.setChecked(True)
    app.processEvents()
    assert dlg.height() == alto_inicial


def test_tocar_el_renglon_lo_tilda(app, monkeypatch):
    dlg = abrir(app, monkeypatch, PANTALLAS['1920x1080'], cart=carrito(3))
    dlg.valor_input.setText('10')
    dlg.rb_elegidos.setChecked(True)
    app.processEvents()

    fila = dlg.lista.topLevelItem(1)
    centro_del_nombre = dlg.lista.visualItemRect(fila).center()
    QTest.mouseClick(dlg.lista.viewport(), Qt.LeftButton, pos=centro_del_nombre)
    assert fila.checkState(0) == Qt.Checked
    assert dlg._filas_elegidas() == [1]

    QTest.mouseClick(dlg.lista.viewport(), Qt.LeftButton, pos=centro_del_nombre)
    assert fila.checkState(0) == Qt.Unchecked
    assert dlg._filas_elegidas() == []


def test_el_descuento_guardado_vuelve_con_sus_renglones(app, monkeypatch):
    actual = {'nombre': 'Docente', 'tipo': 'monto', 'valor': 500, 'filas': [0, 2]}
    dlg = abrir(app, monkeypatch, PANTALLAS['1366x768'], cart=carrito(3), actual=actual)
    assert dlg.rb_elegidos.isChecked() and dlg.rb_monto.isChecked()
    assert dlg._filas_elegidas() == [0, 2]
    monto, base, _filas = dlg.calcular()
    assert base == pytest.approx(12345.5 * 4)
    assert monto == pytest.approx(500)
    assert marco_adentro(dlg, PANTALLAS['1366x768'])


def test_aplicar_devuelve_lo_mismo_que_antes(app, monkeypatch):
    dlg = abrir(app, monkeypatch, PANTALLAS['1920x1080'], cart=carrito(3))
    dlg.nombre_input.setText('Jubilados')
    dlg.valor_input.setText('10')
    dlg.rb_elegidos.setChecked(True)
    dlg.lista.topLevelItem(2).setCheckState(0, Qt.Checked)
    dlg._aplicar()
    assert dlg.resultado == {'nombre': 'Jubilados', 'tipo': 'porcentaje',
                             'valor': 10.0, 'filas': [2]}
