"""
El resumen de cuenta del fiado.

El cliente pide el detalle de lo que debe antes de pagar. Hasta ahora el único
papel salía al cobrar, así que para dárselo había que cobrar una deuda que
todavía no estaba pagada. El resumen se imprime desde la tarjeta del cliente y
no toca nada: ni la deuda, ni la caja, ni las ventas.

Lo que tiene que cerrar:

  · están todos los productos que debe, agrupados por el día que se los llevó,
    del más viejo al más nuevo;
  · el saldo es lo mismo que la pantalla dice que debe (productos menos lo que
    dejó a cuenta);
  · dice en claro que no es un comprobante de pago;
  · y el botón no cobra: la deuda sigue igual después de imprimir.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

from pos_system.database.db_manager import DatabaseManager  # noqa: E402
from pos_system.models.fiado import Fiado, nuevo_entrega_id  # noqa: E402
from pos_system.utils.pdf_generator import PDFGenerator  # noqa: E402


@pytest.fixture
def db(tmp_path):
    base = DatabaseManager(str(tmp_path / 'resumen.db'))
    base.initialize_database()
    yield base


def linea(nombre, cantidad, precio):
    return {'product_id': None, 'product_name': nombre, 'quantity': cantidad,
            'unit_price': precio, 'subtotal': cantidad * precio,
            'category': 'LIBRERIA'}


@pytest.fixture
def cuenta(db):
    """Una clienta con dos entregas: la del 20/10 y la del 28/10."""
    fiado = Fiado(db)
    cid = fiado.crear_cliente('Meli Ruellitas', dni='30111222', telefono='351 555 0000')
    cli = fiado.get_cliente(cid)
    vieja = fiado.cargar_items(cli, [linea('CUADERNO RIVADAVIA', 2, 3500.0),
                                     linea('LAPIZ FABER', 1, 800.0)],
                               entrega_id=nuevo_entrega_id(), cajero='Agus')
    nueva = fiado.cargar_items(cli, [linea('RESMA A4', 1, 9000.0)],
                               entrega_id=nuevo_entrega_id(), cajero='Agus')
    for iid in vieja:
        db.execute_update("UPDATE fiado_items SET fecha = ? WHERE id = ?",
                          ('2026-10-20 10:00:00', iid))
    for iid in nueva:
        db.execute_update("UPDATE fiado_items SET fecha = ? WHERE id = ?",
                          ('2026-10-28 17:40:00', iid))
    return {'db': db, 'fiado': fiado, 'cid': cid}


def la_clienta(cuenta):
    return next(c for c in cuenta['fiado'].get_clientes() if c['id'] == cuenta['cid'])


def resumen(cuenta):
    cli = la_clienta(cuenta)
    items = cuenta['fiado'].get_items(cli)
    return PDFGenerator().render_resumen_fiado_html(cli, items, cajero_name='Agus')


class TestElPapel:

    def test_trae_la_clienta_y_todos_los_productos(self, cuenta):
        html = resumen(cuenta)
        assert 'Meli Ruellitas' in html
        assert 'DNI 30111222' in html
        for nombre in ('CUADERNO RIVADAVIA', 'LAPIZ FABER', 'RESMA A4'):
            assert nombre in html

    def test_agrupa_por_dia_del_mas_viejo_al_mas_nuevo(self, cuenta):
        # get_items devuelve primero lo más nuevo; una cuenta se lee al revés.
        html = resumen(cuenta)
        assert html.index('Se llevó el 20/10/2026') < html.index('Se llevó el 28/10/2026')
        assert html.index('CUADERNO RIVADAVIA') < html.index('RESMA A4')

    def test_el_total_de_cada_dia(self, cuenta):
        html = resumen(cuenta)
        assert '$7.800,00' in html     # 2 cuadernos + 1 lápiz
        assert '$9.000,00' in html     # la resma

    def test_cuando_lleva_mas_de_uno_dice_el_precio_de_cada_uno(self, cuenta):
        assert '2 x $3.500,00' in resumen(cuenta)

    def test_el_saldo_es_lo_que_debe(self, cuenta):
        html = resumen(cuenta)
        assert la_clienta(cuenta)['deuda'] == 16800.0
        assert '$16.800,00' in html
        assert 'Entregas a cuenta' not in html

    def test_lo_que_dejo_a_cuenta_se_descuenta_del_saldo(self, cuenta):
        cuenta['fiado'].registrar_pago(la_clienta(cuenta), 'a_cuenta', 5000.0,
                                       metodo_pago='cash')
        html = resumen(cuenta)
        assert la_clienta(cuenta)['deuda'] == 11800.0
        assert '-$5.000,00' in html
        assert '$11.800,00' in html

    def test_dice_que_no_es_un_comprobante_de_pago(self, cuenta):
        assert 'NO ES UN COMPROBANTE DE PAGO' in resumen(cuenta)

    def test_un_nombre_con_signos_no_rompe_el_html(self, cuenta):
        cuenta['fiado'].actualizar_cliente(cuenta['cid'], nombre='Ana <Pérez> & Cía')
        html = resumen(cuenta)
        assert 'Ana &lt;Pérez&gt; &amp; Cía' in html

    def test_una_cuenta_larga_no_se_salta_la_primera_hoja(self):
        # Con 60 renglones el documento no entra en una hoja: si el bloque
        # entero lleva "no partir", el navegador lo manda completo a la página
        # siguiente y deja la primera vacía. Sólo se protege lo chico.
        tpl = open(os.path.join(os.path.dirname(__file__), '..', 'assets',
                                'resumen_fiado.html'), encoding='utf-8').read()
        regla_ticket = tpl.split('@media print')[1].split('.ticket {')[1].split('}')[0]
        assert 'break-inside' not in regla_ticket
        assert 'transform' not in regla_ticket


# ── El botón en la pestaña Fiados ────────────────────────────────────────────

_ABIERTAS = []


@pytest.fixture(scope='module')
def app():
    pytest.importorskip('PyQt5.QtWidgets', reason='el POS necesita PyQt5')
    from PyQt5.QtWidgets import QApplication
    yield QApplication.instance() or QApplication([])
    _ABIERTAS.clear()


@pytest.fixture
def vista(app, cuenta, monkeypatch):
    import pos_system.utils.firebase_sync as fs
    monkeypatch.setattr(fs, 'init_firebase_sync', lambda: None)
    monkeypatch.setattr(fs, 'get_firebase_sync', lambda: None)
    import pos_system.ui.fiados_view as fv
    monkeypatch.setattr(fv, 'DatabaseManager', lambda: cuenta['db'])
    v = fv.FiadosView(None, current_user={'username': 'agus', 'full_name': 'Agus'})
    _ABIERTAS.append(v)
    v.refresh_data()
    v._seleccionar(la_clienta(cuenta))
    app.processEvents()
    return v


def boton(vista, texto):
    from PyQt5.QtWidgets import QPushButton
    return next(b for b in vista.findChildren(QPushButton) if b.text() == texto)


class TestElBoton:

    def test_esta_en_la_tarjeta_de_la_clienta(self, vista):
        assert boton(vista, 'Imprimir resumen').isEnabled()

    def test_imprime_lo_que_debe_y_no_cobra_nada(self, vista, cuenta, monkeypatch):
        import pos_system.utils.ticket_printer as tp
        llamadas = []
        monkeypatch.setattr(tp, 'imprimir_resumen_fiado',
                            lambda cli, items, **k: llamadas.append((cli, items, k)))
        ventas_antes = cuenta['db'].execute_query("SELECT COUNT(*) AS n FROM sales")[0]['n']

        boton(vista, 'Imprimir resumen').click()

        assert len(llamadas) == 1
        cli, items, k = llamadas[0]
        assert cli['nombre'] == 'Meli Ruellitas'
        assert len(items) == 3
        assert k['cajero_name'] == 'Agus'
        assert la_clienta(cuenta)['deuda'] == 16800.0
        assert cuenta['db'].execute_query("SELECT COUNT(*) AS n FROM sales")[0]['n'] == ventas_antes

    def test_sin_deuda_el_boton_queda_apagado(self, vista, cuenta, app):
        for it in cuenta['fiado'].get_items(la_clienta(cuenta)):
            cuenta['fiado'].anular_item(int(it['id']))
        vista.refresh_data()
        vista._seleccionar(la_clienta(cuenta))
        # La tarjeta vieja se borra con deleteLater: hasta que Qt procesa ese
        # borrado, su botón sigue entre los hijos de la vista.
        from PyQt5.QtCore import QEvent
        app.sendPostedEvents(None, QEvent.DeferredDelete)
        app.processEvents()
        assert not boton(vista, 'Imprimir resumen').isEnabled()
