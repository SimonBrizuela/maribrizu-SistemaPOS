"""
El comprobante que sube el cliente, visto en la caja, y el ticket del pedido.

  · el comprobante abre entero, con zoom de la rueda o de los botones (con tope),
    se gira y vuelve a entrar entero;
  · un archivo que no es imagen no se muestra (va al navegador);
  · el ticket lleva el mismo logo que la factura de ARCA, achicado para que la
    vista previa (que no muestra HTML de más de 2 MB) lo cargue.
"""
import base64
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

pytest.importorskip('PyQt5.QtWidgets')
from PyQt5.QtCore import QBuffer, QByteArray, QIODevice  # noqa: E402
from PyQt5.QtGui import QColor, QImage  # noqa: E402
from PyQt5.QtWidgets import QApplication  # noqa: E402

from pos_system.ui import visor_comprobante as vc  # noqa: E402


@pytest.fixture(scope='module')
def app():
    yield QApplication.instance() or QApplication([])


def comprobante(ancho=1080, alto=2280, formato='WEBP'):
    imagen = QImage(ancho, alto, QImage.Format_RGB32)
    imagen.fill(QColor('#f4f6fb'))
    crudo = QByteArray()
    buf = QBuffer(crudo)
    buf.open(QIODevice.WriteOnly)
    assert imagen.save(buf, formato)
    return bytes(crudo)


def test_lee_la_foto_que_sube_la_tienda_y_no_lo_que_no_es_imagen():
    assert vc.imagen_de_bytes(comprobante()).width() == 1080
    assert vc.imagen_de_bytes(b'%PDF-1.7 no es una imagen') is None
    assert vc.imagen_de_bytes(b'') is None
    assert vc.imagen_de_bytes(b'x' * (vc.TOPE_BYTES + 1)) is None


@pytest.fixture
def visor(app):
    v = vc.VisorComprobante(vc.imagen_de_bytes(comprobante()), 'Comprobante del pedido K7M2',
                            'https://firebasestorage.googleapis.com/x')
    v.resize(1000, 700)
    v.show()
    app.processEvents()
    yield v
    v.close()


def test_abre_entero_sin_agrandarlo(visor):
    assert visor.ajustado
    alto_visible = visor._lienzo.viewport().height()
    assert 2280 * visor.zoom() <= alto_visible
    assert visor.zoom() < 1


def test_zoom_con_tope_y_vuelta_a_entero(visor):
    for _ in range(40):
        visor.zoom_por(vc.PASO)
    assert visor.zoom() == vc.ZOOM_MAX and not visor._mas.isEnabled()
    assert visor._porcentaje.text() == f'{round(vc.ZOOM_MAX * 100)}%'
    for _ in range(80):
        visor.zoom_por(1 / vc.PASO)
    assert visor.zoom() == vc.ZOOM_MIN and not visor._menos.isEnabled()
    visor.alternar_ajuste()
    assert visor.ajustado
    visor.alternar_ajuste()
    assert visor.zoom() == 1.0 and not visor.ajustado


def test_girar_lo_acuesta_y_sigue_entrando_entero(visor):
    parado = visor.zoom()
    visor.girar()
    acostado = visor.zoom()
    # Acostado, el lado largo va a lo ancho de la ventana: entra más grande.
    assert acostado > parado
    assert 2280 * acostado <= visor._lienzo.viewport().width()
    for _ in range(3):
        visor.girar()
    assert abs(visor.zoom() - parado) < 1e-9


def test_el_ticket_lleva_el_logo_de_la_factura_achicado():
    from pos_system.utils import ticket_pedido as tp
    html = tp.html_del_pedido({'codigo': 'K7M2', 'items': [{'nombre': 'Goma', 'cantidad': 2, 'subtotal': 1000}],
                               'subtotal': 1000, 'total': 1000, 'cliente': {'nombre': 'Ana'}})
    logo = tp.logo_del_local()
    assert logo.startswith('data:image/png;base64,') and f'src="{logo}"' in html
    imagen = QImage()
    assert imagen.loadFromData(base64.b64decode(logo.split(',', 1)[1]))
    assert imagen.width() == tp.LOGO_PX
    # La vista previa carga el HTML con setHtml, que corta en 2 MB.
    assert len(html.encode('utf-8')) < 500_000


def test_recorta_el_aire_transparente_del_logo():
    from pos_system.utils import ticket_pedido as tp
    imagen = QImage(100, 100, QImage.Format_ARGB32)
    imagen.fill(QColor(0, 0, 0, 0))
    for x in range(30, 70):
        for y in range(40, 60):
            imagen.setPixelColor(x, y, QColor('red'))
    recorte = tp._sin_bordes_transparentes(imagen, paso=1)
    assert (recorte.width(), recorte.height()) == (42, 22)
