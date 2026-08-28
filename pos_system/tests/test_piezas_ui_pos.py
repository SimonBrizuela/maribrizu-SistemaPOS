"""
Las piezas sueltas del POS: los widgets compartidos, el tema, las fotos de
producto y el reporte de errores de AFIP.

Son las que usan todas las pantallas. Un `PriceInput` que lee mal lo tipeado
cobra de menos en cada venta; un `Toast` que revienta tumba la ventana entera
justo cuando iba a avisar algo; y el reporte de AFIP es lo único que queda
cuando una factura falla en la caja y nadie anotó el error.

Corre sin pantalla (`QT_QPA_PLATFORM=offscreen`).
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

pytest.importorskip('PyQt5.QtWidgets', reason='el POS necesita PyQt5')

from PyQt5.QtWidgets import QApplication, QLabel, QPushButton, QWidget  # noqa: E402

_ABIERTAS = []


@pytest.fixture(scope='module')
def app():
    """La QApplication compartida del suite: Qt no admite dos.

    En el cierre sólo se sueltan las ventanas de este archivo. Llamar a
    `processEvents()` acá tumbaba el proceso: otros módulos todavía tienen
    las suyas vivas.
    """
    yield QApplication.instance() or QApplication([])
    _ABIERTAS.clear()


def guardar(w):
    """Los widgets se sueltan al final, con la aplicación todavía viva."""
    _ABIERTAS.append(w)
    return w


# ── El campo de precio ───────────────────────────────────────────────────────

class TestCampoDePrecio:
    """Lo que se tipea acá termina siendo lo que se cobra."""

    def campo(self, app, **kw):
        from pos_system.ui.components import PriceInput
        return guardar(PriceInput(**kw))

    def test_lo_tipeado_vuelve_como_numero(self, app):
        c = self.campo(app)
        c.setValue(3500)
        assert c.value() == pytest.approx(3500.0)

    def test_los_centavos_no_se_pierden(self, app):
        c = self.campo(app)
        c.setValue(3500.5)
        assert c.value() == pytest.approx(3500.5)

    def test_vacio_es_cero_y_no_revienta(self, app):
        # Un campo en blanco no puede tirar una excepción en medio de una venta.
        c = self.campo(app)
        c._edit.setText('')
        assert c.value() == 0

    def test_letras_no_se_convierten_en_un_precio(self, app):
        c = self.campo(app)
        c._edit.setText('cuarenta pesos')
        assert c.value() == 0

    def test_se_puede_escribir_con_coma_como_aca(self, app):
        # El campo usa el idioma del sistema (es_AR): acepta la coma y rechaza
        # el punto. Pero se leía con `float()` a secas, que sólo entiende el
        # punto, así que devolvía CERO. Un cierre contando 1500,50 registraba 0
        # y daba un faltante de toda la caja.
        c = self.campo(app)
        c._edit.setText('3500,50')
        assert c.value() == pytest.approx(3500.5)

    def test_con_separador_de_miles_tambien(self, app):
        # `1.500,50` lo acepta el validador tal cual.
        c = self.campo(app)
        c._edit.setText('1.500,50')
        assert c.value() == pytest.approx(1500.5)

    def test_lo_que_ya_estaba_guardado_con_punto_se_sigue_leyendo(self, app):
        c = self.campo(app)
        c._edit.setText('3500.50')
        assert c.value() == pytest.approx(3500.5)

    def test_un_entero_pelado_no_se_confunde_con_miles(self, app):
        c = self.campo(app)
        c._edit.setText('3500')
        assert c.value() == pytest.approx(3500.0)


# ── Los avisos ───────────────────────────────────────────────────────────────

class TestAvisos:
    """El aviso lleva animación y temporizador propios: acá se prueba que se
    arme con su texto, sin pisar el bucle de eventos compartido del suite."""

    def test_los_tres_tipos_se_arman_con_su_texto(self, app):
        from pos_system.ui.components import Toast
        padre = guardar(QWidget())
        padre.resize(800, 600)
        for llamada, texto in ((Toast.success, 'Venta registrada'),
                               (Toast.error, 'No se pudo cobrar'),
                               (Toast.info, 'Sincronizando')):
            aviso = guardar(llamada(padre, texto))
            if aviso is not None:
                escrito = ' '.join(l.text() for l in aviso.findChildren(QLabel))
                assert texto in escrito
        assert padre.isEnabled()

    def test_sin_padre_no_rompe(self, app):
        # Se llama desde hilos y desde diálogos que ya se cerraron.
        from pos_system.ui.components import Toast
        Toast.info(None, 'algo')


# ── Las tarjetas de la pantalla ──────────────────────────────────────────────

class TestTarjetas:

    def test_la_tarjeta_de_un_numero_muestra_su_titulo_y_su_valor(self, app):
        from pos_system.ui.components import StatCard
        t = guardar(StatCard('Ventas de hoy', '$35.000'))
        texto = ' '.join(l.text() for l in t.findChildren(QLabel))
        assert 'Ventas de hoy' in texto
        assert '35.000' in texto

    def test_una_tarjeta_vacia_se_arma_igual(self, app):
        from pos_system.ui.components import Card
        assert guardar(Card()) is not None


# ── Los widgets de los diálogos ──────────────────────────────────────────────

class TestWidgetsDeDialogo:

    def test_los_botones_salen_con_su_texto(self, app):
        from pos_system.ui import graphite_widgets as g
        for hacer in (g.PrimaryButton, g.AccentButton, g.DangerButton,
                      g.SecondaryButton):
            b = guardar(hacer('Guardar'))
            assert b.text() == 'Guardar'

    def test_el_encabezado_de_un_dialogo_dice_de_que_se_trata(self, app):
        from pos_system.ui.graphite_widgets import DialogHeader
        h = guardar(DialogHeader('Cerrar caja', 'Contá la plata del cajón'))
        texto = ' '.join(l.text() for l in h.findChildren(QLabel))
        assert 'Cerrar caja' in texto
        assert 'Contá la plata' in texto

    def test_una_etiqueta_de_estado_por_cada_tipo(self, app):
        from pos_system.ui.graphite_widgets import Badge
        for tipo in ('ok', 'warn', 'danger', 'info'):
            b = guardar(Badge('Activo', tipo))
            assert b.text() == 'Activo'

    def test_un_tipo_de_etiqueta_desconocido_no_deja_un_hueco(self, app):
        from pos_system.ui.graphite_widgets import Badge
        b = guardar(Badge('Raro', 'inventado'))
        assert b.text() == 'Raro'

    def test_una_fila_de_dato_muestra_el_nombre_y_el_valor(self, app):
        from pos_system.ui.graphite_widgets import KVRow
        f = guardar(KVRow('Total', '$35.000'))
        texto = ' '.join(l.text() for l in f.findChildren(QLabel))
        assert 'Total' in texto
        assert '35.000' in texto

    def test_un_campo_con_su_etiqueta(self, app):
        from pos_system.ui.graphite_widgets import Field
        from PyQt5.QtWidgets import QLineEdit
        f = guardar(Field('Nombre', QLineEdit()))
        assert any('Nombre' in l.text() for l in f.findChildren(QLabel))


# ── El tema ──────────────────────────────────────────────────────────────────

class TestTema:

    def test_la_hoja_de_estilo_se_lee(self, app):
        from pos_system.ui.theme import load_qss
        qss = load_qss()
        assert isinstance(qss, str)

    def test_una_hoja_que_no_existe_no_voltea_el_arranque(self, app):
        # Sin esto, un archivo que no viajó en el instalador deja el POS sin
        # abrir en vez de abrirlo feo.
        from pos_system.ui.theme import load_qss
        assert load_qss('no_existe_este_archivo.qss') == ''

    def test_aplicar_el_tema_no_rompe(self, app):
        from pos_system.ui.theme import apply_theme
        apply_theme(app)

    def test_marcar_un_widget_le_deja_la_marca_puesta(self, app):
        # El QSS pinta por estas propiedades: si no quedan, el botón sale gris.
        from pos_system.ui.theme import set_variant, set_role, set_badge
        b = guardar(QPushButton('x'))
        set_variant(b, 'primary')
        assert b.property('variant') == 'primary'

        set_role(b, 'danger')
        assert b.property('role') == 'danger'

        l = guardar(QLabel('Activo'))
        set_badge(l, 'ok')
        assert l.property('badge') == 'ok'

    def test_repolish_no_rompe_con_un_widget_suelto(self, app):
        from pos_system.ui.theme import repolish
        repolish(guardar(QLabel('x')))


# ── Las fotos de producto ────────────────────────────────────────────────────

class TestFotosDeProducto:

    @pytest.fixture
    def manejador(self, tmp_path):
        pytest.importorskip('PIL', reason='las fotos necesitan Pillow')
        from pos_system.utils.image_handler import ImageHandler
        return ImageHandler(base_path=str(tmp_path))

    def imagen(self, tmp_path, nombre='foto.png', tam=(400, 300)):
        from PIL import Image
        ruta = tmp_path / nombre
        Image.new('RGB', tam, (200, 100, 50)).save(ruta)
        return str(ruta)

    def test_guardar_una_foto_la_deja_en_su_carpeta(self, manejador, tmp_path):
        origen = self.imagen(tmp_path)
        destino = manejador.save_product_image(origen, product_id=42)
        assert destino
        assert os.path.exists(destino)

    def test_dos_productos_no_se_pisan_la_foto(self, manejador, tmp_path):
        a = manejador.save_product_image(self.imagen(tmp_path, 'a.png'), product_id=1)
        b = manejador.save_product_image(self.imagen(tmp_path, 'b.png'), product_id=2)
        assert a != b

    def test_un_archivo_que_no_existe_no_rompe_la_ficha(self, manejador):
        assert not manejador.save_product_image('no_existe.png', product_id=1)

    def test_algo_que_no_es_una_imagen_tampoco(self, manejador, tmp_path):
        falsa = tmp_path / 'no_es_imagen.png'
        falsa.write_text('esto es texto', encoding='utf-8')
        assert not manejador.save_product_image(str(falsa), product_id=1)

    def test_la_miniatura_sale_mas_chica(self, manejador, tmp_path):
        from PIL import Image
        mini = manejador.create_thumbnail(self.imagen(tmp_path), size=(80, 80))
        assert mini and os.path.exists(mini)
        with Image.open(mini) as im:
            assert im.width <= 80 and im.height <= 80

    def test_recortar_a_cuadrado_deja_un_cuadrado(self, manejador, tmp_path):
        from PIL import Image
        cuadrada = manejador.crop_to_square(self.imagen(tmp_path, tam=(400, 300)))
        assert cuadrada
        with Image.open(cuadrada) as im:
            assert im.width == im.height

    def test_se_puede_saber_el_tamano_de_una_foto(self, manejador, tmp_path):
        info = manejador.get_image_info(self.imagen(tmp_path, tam=(400, 300)))
        assert info
        assert info['size'] == (400, 300)
        assert info['format'] == 'PNG'
        assert info['file_size'] > 0

    def test_borrar_una_foto_la_saca(self, manejador, tmp_path):
        guardada = manejador.save_product_image(self.imagen(tmp_path), product_id=9)
        assert manejador.delete_product_image(guardada) is True
        assert not os.path.exists(guardada)

    def test_borrar_una_que_ya_no_esta_no_es_un_error(self, manejador):
        # Pasa al borrar un producto dos veces desde dos pantallas.
        assert manejador.delete_product_image('no_existe.png') in (True, False)


# ── El reporte de errores de AFIP ────────────────────────────────────────────

class TestReporteAfip:

    def test_sin_firebase_no_hace_nada_y_no_tapa_el_error(self, monkeypatch):
        # La factura ya falló: el reporte no puede fallar encima.
        import pos_system.utils.firebase_sync as fs
        monkeypatch.setattr(fs, 'get_firebase_sync', lambda: None)
        from pos_system.utils.afip_error_reporter import report_afip_error
        report_afip_error(ValueError('CAE rechazado'), {'punto_venta': 1})

    def test_sube_el_error_con_el_contexto_de_la_factura(self, monkeypatch):
        subidos = []

        class ColeccionFalsa:
            def add(self, payload):
                subidos.append(payload)

        class DbFalsa:
            def collection(self, nombre):
                assert nombre == 'error_reports'
                return ColeccionFalsa()

        class SyncFalso:
            enabled = True
            db = DbFalsa()

            # El reporte se lanza con el ayudante de hilos del propio sync,
            # para no congelar la caja mientras sube.
            @staticmethod
            def _run(fn):
                fn()

        import pos_system.utils.firebase_sync as fs
        monkeypatch.setattr(fs, 'get_firebase_sync', lambda: SyncFalso())

        from pos_system.utils.afip_error_reporter import report_afip_error
        try:
            raise ValueError('El CAE fue rechazado por AFIP')
        except ValueError as e:
            report_afip_error(e, {'punto_venta': 1, 'total': 35000})

        # La subida corre en un hilo aparte para no congelar la caja.
        import time
        for _ in range(200):
            if subidos:
                break
            time.sleep(0.01)

        assert subidos, 'el error tendría que haberse subido'
        d = subidos[0]
        assert d['tipo_error'] == 'ValueError'
        assert 'rechazado por AFIP' in d['mensaje']
        assert d['contexto']['punto_venta'] == '1'
        assert d['stack_trace']
        assert d['pc_id']

    def test_un_contexto_enorme_se_recorta(self, monkeypatch):
        # Un payload gigante lo rechaza Firestore y el reporte se pierde entero.
        subidos = []

        class SyncFalso:
            enabled = True

            @staticmethod
            def _run(fn):
                fn()

            class db:
                @staticmethod
                def collection(_):
                    class C:
                        @staticmethod
                        def add(p):
                            subidos.append(p)
                    return C

        import pos_system.utils.firebase_sync as fs
        monkeypatch.setattr(fs, 'get_firebase_sync', lambda: SyncFalso())

        from pos_system.utils.afip_error_reporter import report_afip_error
        report_afip_error(ValueError('x' * 5000), {'xml': 'y' * 5000})

        import time
        for _ in range(200):
            if subidos:
                break
            time.sleep(0.01)

        assert subidos
        assert len(subidos[0]['mensaje']) <= 2000
        assert len(subidos[0]['contexto']['xml']) <= 500
