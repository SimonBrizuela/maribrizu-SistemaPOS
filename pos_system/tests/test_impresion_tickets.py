"""
Imprimir el ticket y el remito.

Es lo último que pasa en cada venta y lo primero que se nota cuando falla: el
cliente está esperando el papel. La vista previa tiene tres botones —imprimir,
guardar PDF y cerrar— y detrás hay dos trampas que ya se vivieron:

  · el callback de "PDF guardado" se conectaba en cada clic sobre la misma
    página, así que guardar dos veces abría dos diálogos, tres veces tres;
  · y `os.startfile` falla en una PC sin lector de PDF instalado. Ahí no puede
    quedar en nada: se abre el Explorador con el archivo marcado, que existe
    siempre.

Corre sin pantalla (`QT_QPA_PLATFORM=offscreen`).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

pytest.importorskip('PyQt5.QtWidgets', reason='el POS necesita PyQt5')

from PyQt5.QtWidgets import QApplication  # noqa: E402

from pos_system.utils import ticket_printer as tp  # noqa: E402

# Las pantallas abiertas se sueltan con la aplicación todavía viva: es el único
# orden en el que Qt no se queja.
_ABIERTAS = []


@pytest.fixture(scope='module')
def app():
    # La QApplication la comparten todos los módulos de Qt del suite: el
    # primero que corre la crea y los demás la reusan. En el cierre sólo se
    # sueltan las ventanas de este archivo — llamar a `processEvents()` acá
    # tumbaba el proceso, porque otros módulos todavía tienen las suyas vivas.
    yield QApplication.instance() or QApplication([])
    _ABIERTAS.clear()


VENTA = {
    'id': 4520,
    'total_amount': 10500.0,
    'payment_type': 'cash',
    'cash_received': 11000.0,
    'change_given': 500.0,
    'created_at': '2026-08-28 14:30:00',
    'items': [
        {'product_name': 'CUADERNO RIVADAVIA', 'quantity': 2,
         'unit_price': 3500.0, 'subtotal': 7000.0},
        {'product_name': 'LAPIZ FABER', 'quantity': 1,
         'unit_price': 3500.0, 'subtotal': 3500.0},
    ],
}


def hay_webengine():
    # `QWebEngineView` no se puede construir con `QT_QPA_PLATFORM=offscreen`:
    # el runtime de Chromium tumba el proceso entero, sin excepción que atrapar.
    # La vista previa se prueba a mano; lo que sí se prueba acá es el HTML que
    # va al papel y qué pasa cuando algo del camino falla.
    return False


# ── El HTML que se imprime ───────────────────────────────────────────────────

class TestElTicket:
    """Lo que sale en el papel se arma antes de tocar la impresora."""

    def test_el_ticket_trae_los_productos_y_el_total(self):
        from pos_system.utils.pdf_generator import PDFGenerator
        html = PDFGenerator().render_non_fiscal_ticket_html(
            VENTA, cajero_name='Marta', cliente_name='Consumidor Final')

        assert 'CUADERNO RIVADAVIA' in html
        assert 'LAPIZ FABER' in html
        assert '10.500,00' in html

    def test_la_plata_sale_como_se_lee_aca(self):
        # El ticket salía con formato de Estados Unidos —$10,500.00— que acá se
        # lee como diez con quinientos. Es el papel que se lleva el cliente.
        from pos_system.utils.pdf_generator import PDFGenerator
        html = PDFGenerator().render_non_fiscal_ticket_html(VENTA, cajero_name='Marta')
        assert '$10.500,00' in html
        assert '10,500.00' not in html
        assert '11.000,00' in html      # lo que entregó
        assert '500,00' in html         # el vuelto

    def test_una_venta_mixta_muestra_las_dos_partes_bien_escritas(self):
        from pos_system.utils.pdf_generator import PDFGenerator
        mixta = {**VENTA, 'payment_type': 'mixed', 'cash_received': 5000.0,
                 'change_given': 0.0, 'transfer_amount': 5500.0}
        html = PDFGenerator().render_non_fiscal_ticket_html(mixta, cajero_name='Marta')
        assert 'Efectivo' in html and 'Transferencia' in html
        assert '5.000,00' in html
        assert '5.500,00' in html

    def test_dice_quien_atendio(self):
        from pos_system.utils.pdf_generator import PDFGenerator
        html = PDFGenerator().render_non_fiscal_ticket_html(
            VENTA, cajero_name='Marta', cliente_name='Consumidor Final')
        assert 'Marta' in html

    def test_una_venta_sin_renglones_no_voltea_la_impresion(self):
        # Pasa con ventas viejas migradas: el detalle no está.
        from pos_system.utils.pdf_generator import PDFGenerator
        html = PDFGenerator().render_non_fiscal_ticket_html(
            {**VENTA, 'items': []}, cajero_name='Marta')
        assert len(html) > 0

    def test_el_remito_sale_con_su_numero(self):
        from pos_system.utils.pdf_generator import PDFGenerator
        html = PDFGenerator().render_remito_html(
            VENTA, remito_meta={'nro_remito': '0001-00000123', 'letra': 'X'},
            cajero_name='Marta', cliente=None)
        assert '0001-00000123' in html


# ── La vista previa ──────────────────────────────────────────────────────────

@pytest.mark.skipif(not hay_webengine(),
                    reason='la vista web tumba el proceso sin pantalla real')
class TestVistaPrevia:

    def armar(self, app, **kw):
        from pos_system.utils.pdf_generator import PDFGenerator
        html = PDFGenerator().render_non_fiscal_ticket_html(
            VENTA, cajero_name='Marta', cliente_name='Consumidor Final')
        dlg = tp.TicketPreviewDialog(html, sale_id='4520', **kw)
        _ABIERTAS.append(dlg)
        app.processEvents()
        return dlg

    def test_se_abre_con_los_tres_botones(self, app):
        dlg = self.armar(app)
        assert dlg.print_btn.isEnabled()
        assert dlg.save_pdf_btn.isEnabled()
        assert dlg.close_btn.isEnabled()
        assert '4520' in dlg.windowTitle()

    def test_el_titulo_dice_si_es_ticket_o_remito(self, app):
        dlg = self.armar(app, doc_label='Remito')
        assert 'Remito' in dlg.windowTitle()

    def test_el_callback_del_pdf_se_conecta_una_sola_vez(self, app):
        # Conectarlo en cada clic acumulaba handlers sobre la misma página y
        # guardar dos veces abría dos diálogos, tres veces tres.
        dlg = self.armar(app)
        recibidos = []
        dlg._on_pdf_saved = lambda path, ok: recibidos.append(path)

        # Se emite la señal a mano: es lo que dispara Qt al terminar de guardar.
        dlg.view.page().pdfPrintingFinished.emit('C:/x/ticket.pdf', True)
        app.processEvents()
        assert len(recibidos) <= 1

    def test_cerrar_no_deja_la_ventana_dando_vueltas(self, app):
        dlg = self.armar(app)
        dlg.close_btn.click()
        app.processEvents()
        assert not dlg.isVisible()


# ── Abrir el archivo guardado ────────────────────────────────────────────────

class TestAbrirElPDF:

    def test_en_windows_se_abre_con_el_visor(self, monkeypatch, tmp_path):
        archivo = tmp_path / 'ticket.pdf'
        archivo.write_bytes(b'%PDF-1.4')
        abiertos = []
        monkeypatch.setattr(tp.os, 'startfile', abiertos.append, raising=False)
        monkeypatch.setattr('platform.system', lambda: 'Windows')

        assert tp._abrir_archivo_con_fallback(str(archivo)) is True
        assert abiertos == [str(archivo)]

    def test_sin_lector_de_pdf_igual_se_abre_la_carpeta(self, monkeypatch, tmp_path):
        # En una PC recién instalada no hay con qué abrir un PDF. El archivo
        # está guardado: mostrar dónde es mejor que un cartel de error.
        archivo = tmp_path / 'ticket.pdf'
        archivo.write_bytes(b'%PDF-1.4')

        def sin_programa(_):
            raise OSError('no application associated')

        monkeypatch.setattr(tp.os, 'startfile', sin_programa, raising=False)
        monkeypatch.setattr('platform.system', lambda: 'Windows')
        lanzados = []
        monkeypatch.setattr('subprocess.Popen', lambda args, **kw: lanzados.append(args))

        assert tp._abrir_archivo_con_fallback(str(archivo)) is True
        assert lanzados and 'explorer' in lanzados[0][0]

    def test_mostrar_en_carpeta_marca_el_archivo(self, monkeypatch, tmp_path):
        archivo = tmp_path / 'ticket.pdf'
        archivo.write_bytes(b'%PDF-1.4')
        monkeypatch.setattr('platform.system', lambda: 'Windows')
        lanzados = []
        monkeypatch.setattr('subprocess.Popen', lambda args, **kw: lanzados.append(args))

        assert tp._mostrar_en_carpeta(str(archivo)) is True
        assert '/select,' in lanzados[0][1]

    def test_si_ni_el_explorador_abre_no_se_cae_el_pos(self, monkeypatch, tmp_path):
        archivo = tmp_path / 'ticket.pdf'
        archivo.write_bytes(b'%PDF-1.4')
        monkeypatch.setattr('platform.system', lambda: 'Windows')

        def revienta(*_a, **_k):
            raise OSError('explorer no responde')

        monkeypatch.setattr('subprocess.Popen', revienta)
        assert tp._mostrar_en_carpeta(str(archivo)) is False


# ── Sin la dependencia de impresión ──────────────────────────────────────────

class TestSinPyQtWebEngine:

    def test_lo_avisa_y_devuelve_que_no_pudo(self, app, monkeypatch):
        # En vez de reventar con un ImportError en medio de una venta.
        monkeypatch.setattr(tp, '_qweb_available', lambda: False)
        avisos = []
        monkeypatch.setattr(tp.QMessageBox, 'warning',
                            lambda *a, **k: avisos.append(a))

        assert tp.imprimir_ticket_no_fiscal(VENTA) is False
        assert avisos
        assert 'PyQtWebEngine' in ' '.join(str(x) for x in avisos[0])

    def test_el_remito_tambien(self, app, monkeypatch):
        monkeypatch.setattr(tp, '_qweb_available', lambda: False)
        monkeypatch.setattr(tp.QMessageBox, 'warning', lambda *a, **k: None)
        assert tp.imprimir_remito(VENTA) is False


class TestCuandoAlgoFalla:

    def test_si_el_html_no_se_puede_armar_se_avisa_sin_romper(self, app, monkeypatch):
        # La venta sigue guardada: lo único que falta es el papel.
        monkeypatch.setattr(tp, '_qweb_available', lambda: True)

        class GeneradorRoto:
            def render_non_fiscal_ticket_html(self, *a, **k):
                raise ValueError('plantilla rota')

        import pos_system.utils.pdf_generator as pg
        monkeypatch.setattr(pg, 'PDFGenerator', GeneradorRoto)
        criticos = []
        monkeypatch.setattr(tp.QMessageBox, 'critical',
                            lambda *a, **k: criticos.append(a))

        assert tp.imprimir_ticket_no_fiscal(VENTA) is False
        assert criticos
