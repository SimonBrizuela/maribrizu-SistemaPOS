"""
Historial de facturas en Fiscal AFIP: todas las cajas, separadas por emisor.

Pedido del dueño (29-10-2026): en Fiscal AFIP, elegir "Di Filippo Agustín" o
"Di Filippo José" en Perfil ARCA mostraba las mismas facturas. El selector solo
se usaba para la Nota de Crédito y la tabla leía únicamente la base de la PC.
Lo necesita para saber a qué cuenta se le facturó a cada empresa y restarlo de
lo que entró por Mercado Pago antes de hacer la factura Varios 2 del día.

El emisor se reconoce por CUIT + punto de venta, no por el nombre: 206
facturas de Agustín salieron con la razón social de José antes del 06-10.
"""
import os
import sys
from datetime import date, datetime

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.utils import historial_facturas as hf  # noqa: E402

JOSE = {'id': 7, 'nombre': 'DI FILIPPO JOSE LUIS', 'razon_social': 'DI FILIPPO JOSE LUIS',
        'cuit': '20149210408', 'punto_venta': 1990}
AGUSTIN = {'id': 6, 'nombre': 'DI FILIPPO AGUSTINN', 'razon_social': 'DI FILIPPO AGUSTIN',
           'cuit': '23351080639', 'punto_venta': 2}
PERFILES = [AGUSTIN, JOSE]


def doc(nro, pv=2, cuit='23351080639', total=1000.0, varios=False, pago='Efectivo',
        cuando='2026-10-29T10:00:00-03:00', cliente='CONSUMIDOR FINAL', receptor='',
        razon='DI FILIPPO AGUSTIN', tipo='FAC. ELEC. C', cae='86449954267510'):
    return {'tipo_comprobante': tipo, 'punto_venta': pv, 'nro_comprobante': nro,
            'cuit': cuit, 'razon_social': razon, 'nombre_perfil': razon,
            'total': total, 'es_varios_2': varios, 'pago': pago, 'created_at': cuando,
            'fecha': '29/10/2026 10:00:00 AM', 'cliente': cliente, 'cuit_receptor': receptor,
            'cae': cae, 'vto_cae': '20261108', 'items': [], 'sale_id': 50, 'turno': '00050'}


def nube(*docs):
    return [hf.fila_de_nube(f'id{i}', d) for i, d in enumerate(docs)]


# ── Emisor ────────────────────────────────────────────────────────────────

class TestEmisor:
    def test_por_cuit_y_punto_de_venta(self):
        a, j = nube(doc(1), doc(2, pv=1990, cuit='20149210408'))
        assert hf.perfil_de(a, PERFILES) is AGUSTIN
        assert hf.perfil_de(j, PERFILES) is JOSE

    def test_el_nombre_viejo_no_engana(self):
        # Factura de Agustín emitida cuando el perfil decía "DI FILIPPO JOSE LUIS".
        (f,) = nube(doc(1, razon='DI FILIPPO JOSE LUIS'))
        assert hf.perfil_de(f, PERFILES) is AGUSTIN
        assert hf.nombre_de_emisor(f, PERFILES) == 'DI FILIPPO AGUSTIN'

    def test_mismo_cuit_otro_punto_de_venta_no_es_el_mismo(self):
        (f,) = nube(doc(1, pv=1990))   # CUIT de Agustín con el PV de José
        assert hf.perfil_de(f, PERFILES) is None
        assert hf.nombre_de_emisor(f, PERFILES) == 'CUIT 23-35108063-9'

    def test_factura_local_sin_cuit_se_reconoce_por_el_punto_de_venta(self):
        f = hf.fila_local({'id': 3, 'tipo_comprobante': 'FAC. ELEC. C', 'punto_venta': 1990,
                           'nro_comprobante': 9, 'total': 10, 'created_at': '2026-10-29 10:00:00'})
        assert hf.perfil_de(f, PERFILES) is JOSE

    def test_punto_de_venta_compartido_sin_cuit_no_adivina(self):
        otro = dict(JOSE, id=9, cuit='27000000001')
        f = hf.fila_local({'tipo_comprobante': 'FAC. ELEC. C', 'punto_venta': 1990, 'nro_comprobante': 1})
        assert hf.perfil_de(f, [JOSE, otro]) is None


# ── Juntar nube y base local ──────────────────────────────────────────────

class TestCombinar:
    def test_la_misma_factura_no_se_repite_y_toma_el_pdf_local(self):
        n = nube(doc(289))
        loc = [hf.fila_local({'id': 41, 'tipo_comprobante': 'FAC. ELEC. C', 'punto_venta': 2,
                              'nro_comprobante': 289, 'total': 1000, 'sale_id': 7,
                              'pdf_path': r'C:\facturas\f289.pdf',
                              'created_at': '2026-10-29T10:00:01-03:00'})]
        (f,) = hf.combinar(n, loc)
        assert f['clave_nube'] == 'id0'
        assert f['id_local'] == 41
        assert f['pdf_path'].endswith('f289.pdf')
        assert f['solo_local'] is False

    def test_la_que_no_llego_a_subir_aparece_marcada(self):
        loc = [hf.fila_local({'id': 42, 'tipo_comprobante': 'FAC. ELEC. C', 'punto_venta': 2,
                              'nro_comprobante': 290, 'total': 500,
                              'created_at': '2026-10-29T11:00:00-03:00'})]
        filas = hf.combinar(nube(doc(289)), loc)
        assert [f['nro'] for f in filas] == [290, 289]   # la más nueva arriba
        assert filas[0]['solo_local'] is True

    def test_mismo_numero_en_dos_emisores_son_dos_facturas(self):
        filas = hf.combinar(nube(doc(5), doc(5, pv=1990, cuit='20149210408')), [])
        assert len(filas) == 2


# ── Filtrar ───────────────────────────────────────────────────────────────

class TestFiltrar:
    def setup_method(self):
        self.filas = hf.combinar(nube(
            doc(1, total=100),
            doc(2, pv=1990, cuit='20149210408', total=200),
            doc(3, total=300, cuando='2026-10-28T23:59:00-03:00', cliente='MINISTERIO DE EDUCACION',
                receptor='30999252449'),
        ), [])

    def test_por_emisor(self):
        assert [f['nro'] for f in hf.filtrar(self.filas, PERFILES, perfil=AGUSTIN)] == [1, 3]
        assert [f['nro'] for f in hf.filtrar(self.filas, PERFILES, perfil=JOSE)] == [2]
        assert len(hf.filtrar(self.filas, PERFILES, perfil=None)) == 3

    def test_por_dia_en_hora_argentina(self):
        hoy = date(2026, 10, 29)
        assert sorted(f['nro'] for f in hf.filtrar(self.filas, PERFILES, desde=hoy, hasta=hoy)) == [1, 2]

    def test_buscar_por_cliente_sin_tildes_ni_mayusculas(self):
        assert [f['nro'] for f in hf.filtrar(self.filas, PERFILES, texto='educación')] == [3]

    def test_buscar_por_cuit_con_guiones(self):
        assert [f['nro'] for f in hf.filtrar(self.filas, PERFILES, texto='30-99925244-9')] == [3]

    def test_buscar_por_numero(self):
        assert [f['nro'] for f in hf.filtrar(self.filas, PERFILES, texto='01990-00000002')] == [2]


# ── Totales ───────────────────────────────────────────────────────────────

class TestTotales:
    def test_los_cuatro_recuadros(self):
        filas = nube(
            doc(1, total=150000, varios=True),
            doc(2, total=40000, pago='Transferencia', cliente='EMPRESA SA', receptor='30711314810'),
            doc(3, total=9600, pago='Efectivo', cliente='MINISTERIO'),
        )
        t = hf.totales(filas)
        assert t['total'] == 199600
        assert (t['varios_2'], t['cant_varios_2']) == (150000, 1)
        assert (t['clientes'], t['cant_clientes']) == (49600, 2)
        assert (t['clientes_transferencia'], t['cant_clientes_transferencia']) == (40000, 1)

    def test_la_nota_de_credito_resta(self):
        filas = nube(doc(1, total=1000), doc(1, total=400, tipo='NOTA CRED. C'))
        t = hf.totales(filas)
        assert t['total'] == 600
        assert t['cant_notas_credito'] == 1
        assert t['clientes'] == 1000

    def test_cuenta_las_que_no_tienen_cae(self):
        assert hf.totales(nube(doc(1, cae=''), doc(2)))['sin_cae'] == 1

    def test_reparto_por_emisor(self):
        filas = nube(doc(1, total=100), doc(2, total=50),
                     doc(3, pv=1990, cuit='20149210408', total=70))
        assert hf.por_emisor(filas, PERFILES) == [
            ('DI FILIPPO AGUSTIN', 150, 2), ('DI FILIPPO JOSE LUIS', 70, 1)]


# ── Fechas y formatos ─────────────────────────────────────────────────────

class TestFechas:
    @pytest.mark.parametrize('periodo, esperado', [
        ('hoy',        (date(2026, 10, 29), date(2026, 10, 29))),
        ('ayer',       (date(2026, 10, 28), date(2026, 10, 28))),
        ('7',          (date(2026, 10, 23), date(2026, 10, 29))),
        ('mes',        (date(2026, 10, 1),  date(2026, 10, 29))),
        ('mes_pasado', (date(2026, 9, 1),   date(2026, 9, 30))),
    ])
    def test_rangos(self, periodo, esperado):
        assert hf.rango_de(periodo, date(2026, 10, 29)) == esperado

    def test_mes_pasado_en_enero(self):
        assert hf.rango_de('mes_pasado', date(2027, 1, 15)) == (date(2026, 12, 1), date(2026, 12, 31))

    def test_limites_para_la_consulta(self):
        assert hf.limites_iso(date(2026, 10, 1), date(2026, 10, 31)) == ('2026-10-01', '2026-11-01')
        # El texto que guarda el POS cae adentro del rango comparado como texto.
        lo, hi = hf.limites_iso(date(2026, 10, 29), date(2026, 10, 29))
        assert lo <= '2026-10-29T23:59:59.9-03:00' < hi

    def test_hora_con_zona_pasa_a_hora_argentina(self):
        assert hf.a_hora_ar('2026-10-29T13:00:00+00:00') == datetime(2026, 10, 29, 10, 0)

    def test_fecha_del_pdf(self):
        assert hf.a_hora_ar('29/10/2026 08:24:00 PM') == datetime(2026, 10, 29, 20, 24)

    def test_documentos(self):
        assert hf.formatear_documento('20149210408') == '20-14921040-8'
        assert hf.formatear_documento('30.123.456') == '30123456'
        assert hf.formatear_documento('') == ''
        assert hf.formatear_documento('0') == ''


# ── Nota de crédito ───────────────────────────────────────────────────────

class TestParaNotaDeCredito:
    def test_venta_de_otra_caja_no_lleva_su_numero(self):
        # En la tabla local sale_id apunta a sales(id): el 50 de otra caja es otra venta.
        (f,) = nube(doc(287))
        d = hf.factura_para_nota_de_credito(f)
        assert d['sale_id'] is None
        assert (d['tipo_comprobante'], d['punto_venta'], d['nro_comprobante']) == ('FAC. ELEC. C', 2, 287)
        assert d['cae']

    def test_venta_de_esta_pc_conserva_su_numero(self):
        loc = [hf.fila_local({'id': 41, 'tipo_comprobante': 'FAC. ELEC. C', 'punto_venta': 2,
                              'nro_comprobante': 287, 'sale_id': 12,
                              'created_at': '2026-10-29 10:00:00'})]
        (f,) = hf.combinar(nube(doc(287)), loc)
        assert hf.factura_para_nota_de_credito(f)['sale_id'] == 12


# ── La pantalla ───────────────────────────────────────────────────────────

qt = pytest.importorskip('PyQt5.QtWidgets', reason='la pantalla necesita PyQt5')
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')


@pytest.fixture(scope='module')
def app():
    from PyQt5.QtWidgets import QApplication
    return QApplication.instance() or QApplication([])


@pytest.fixture
def pantalla(app, tmp_path, monkeypatch):
    """Fiscal AFIP contra una base temporal con los dos perfiles y una nube falsa."""
    from pos_system.database.db_manager import DatabaseManager
    import pos_system.database.db_manager as dbm
    import pos_system.utils.firebase_sync as fs
    import pos_system.ui.fiscal_view as fv

    base = DatabaseManager(str(tmp_path / 'fiscal.db'))
    base.initialize_database()
    for p in (AGUSTIN, JOSE):
        base.execute_update(
            "INSERT INTO perfiles_facturacion"
            " (id, firebase_id, nombre, razon_social, cuit, punto_venta, activo)"
            " VALUES (?, ?, ?, ?, ?, ?, 1)",
            (p['id'], f"fb{p['id']}", p['nombre'], p['razon_social'], p['cuit'], p['punto_venta']))
    original = dbm.DatabaseManager

    class Base(original):
        def __new__(cls, *a, **k):
            return base

    monkeypatch.setattr(dbm, 'DatabaseManager', Base)
    monkeypatch.setattr(fs, 'get_firebase_sync', lambda: None)

    hoy = fv.now_ar().date().isoformat()
    docs = [
        doc(10, total=150000, varios=True, cuando=f'{hoy}T10:00:00-03:00'),
        doc(11, total=42400, pago='Transferencia', cliente='BOMBEROS', receptor='33718648179',
            cuando=f'{hoy}T11:00:00-03:00'),
        doc(20, pv=1990, cuit='20149210408', razon='DI FILIPPO JOSE LUIS', total=4000,
            pago='Transferencia', cuando=f'{hoy}T12:00:00-03:00'),
    ]
    estado = {'nube': docs}

    def leer(desde, hasta):
        if estado['nube'] is None:
            return None
        lo, hi = hf.limites_iso(desde, hasta)
        return [hf.fila_de_nube(f'd{i}', d) for i, d in enumerate(estado['nube'])
                if lo <= d['created_at'] < hi]

    monkeypatch.setattr(fv, '_leer_facturas_nube', leer)
    w = fv.FiscalView(None)
    w.show()
    w.refresh_data()
    _esperar(app, w)
    yield w, estado
    w.close()
    w.deleteLater()
    app.processEvents()


def _esperar(app, w):
    import time
    fin = time.time() + 5
    while time.time() < fin:
        app.processEvents()
        if not w._cargas and w._cargado_alguna_vez:
            app.processEvents()
            return
        time.sleep(0.01)
    raise AssertionError('la carga de facturas no terminó')


def _filas_tabla(w):
    return [w.h_table.item(i, 0).text() for i in range(w.h_table.rowCount())]


class TestPantalla:
    def test_todos_los_emisores(self, pantalla):
        w, _ = pantalla
        assert w.perfil_combo.currentText() == 'Todos los emisores'
        assert w.h_table.rowCount() == 3
        assert not w.h_table.isColumnHidden(w._COL_EMISOR)
        assert 'DI FILIPPO AGUSTIN' in w.lbl_por_emisor.text()
        assert 'DI FILIPPO JOSE LUIS' in w.lbl_por_emisor.text()

    def test_elegir_un_emisor_filtra_y_suma_solo_lo_suyo(self, pantalla):
        w, _ = pantalla
        w.perfil_combo.setCurrentIndex(w.perfil_combo.findData(JOSE['id']))
        assert _filas_tabla(w) == ['Fac. C  01990-00000020']
        assert w.t_total_value.text() == '$4.000,00'
        assert w.t_transf_value.text() == '$4.000,00'
        assert w.h_table.isColumnHidden(w._COL_EMISOR)

        w.perfil_combo.setCurrentIndex(w.perfil_combo.findData(AGUSTIN['id']))
        assert len(_filas_tabla(w)) == 2
        assert w.t_total_value.text() == '$192.400,00'
        assert w.t_v2_value.text() == '$150.000,00'
        assert w.t_reg_value.text() == '$42.400,00'
        assert w.t_transf_value.text() == '$42.400,00'

    def test_el_emisor_elegido_sobrevive_a_la_recarga(self, pantalla, app):
        w, _ = pantalla
        w.perfil_combo.setCurrentIndex(w.perfil_combo.findData(JOSE['id']))
        w.refresh_data()
        _esperar(app, w)
        assert w.perfil_combo.currentData() == JOSE['id']
        assert w.h_table.rowCount() == 1

    def test_detalle_de_la_factura(self, pantalla):
        w, _ = pantalla
        w.h_table.selectRow(1)   # la de BOMBEROS
        assert w._detalle_vals['cliente'].text() == 'BOMBEROS'
        assert w._detalle_vals['documento'].text().startswith('CUIT 33-71864817-9')
        assert 'CUIT 23-35108063-9' in w._detalle_vals['emisor'].text()
        assert w.btn_nc.isEnabled()

    def test_nota_de_credito_sale_con_el_emisor_de_la_factura(self, pantalla, monkeypatch):
        """Con José elegido arriba no importa: la factura es de Agustín."""
        w, _ = pantalla
        import pos_system.ui.nota_credito_dialog as ncd
        visto = {}

        class Dialogo:
            Accepted = 1

            def __init__(self, factura, parent=None, perfil=None):
                visto['factura'], visto['perfil'] = factura, perfil

            def exec_(self):
                return 0

        monkeypatch.setattr(ncd, 'NotaCreditoDialog', Dialogo)
        w.perfil_combo.setCurrentIndex(0)
        w.h_table.selectRow(1)
        w._on_nota_credito()
        assert visto['perfil']['cuit'] == AGUSTIN['cuit']
        assert int(visto['perfil']['punto_venta']) == 2
        assert visto['factura']['nro_comprobante'] == 11
        assert visto['factura']['sale_id'] is None

    def test_sin_conexion_avisa_y_muestra_lo_de_esta_pc(self, pantalla, app):
        w, estado = pantalla
        estado['nube'] = None
        from pos_system.database.db_manager import DatabaseManager
        DatabaseManager().execute_update(
            "INSERT INTO facturas (tipo_comprobante, punto_venta, nro_comprobante, cliente,"
            " total, cae, created_at) VALUES ('FAC. ELEC. C', 2, 99, 'LOCAL', 10, '1', ?)",
            (w.f_hasta.date().toString('yyyy-MM-dd') + ' 09:00:00',))
        w._cargar()
        _esperar(app, w)
        assert 'Sin conexión' in w.lbl_subtitulo.text()
        assert _filas_tabla(w) == ['Fac. C  00002-00000099']

    def test_no_consulta_la_nube_con_la_pestana_escondida(self, pantalla, monkeypatch):
        w, _ = pantalla
        w.hide()
        llamadas = []
        monkeypatch.setattr(w, '_cargar', lambda: llamadas.append(1))
        w.refresh_data()
        assert llamadas == []
        assert w._pendiente is True
