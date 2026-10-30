"""
Vista Fiscal — Pestaña principal para gestión de facturas electrónicas AFIP.
Contiene dos sub-tabs: Emitir Factura (manual) e Historial de Facturas.
"""
import html
import logging

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTabWidget, QTableWidget,
    QTableWidgetItem, QLabel, QPushButton, QLineEdit, QFormLayout,
    QGroupBox, QComboBox, QHeaderView, QMessageBox, QFrame, QScrollArea,
    QDateEdit, QGridLayout, QSplitter, QStackedWidget, QSizePolicy
)
from PyQt5.QtCore import Qt, QDate, QThread, QTimer, pyqtSignal
from PyQt5.QtGui import QFont, QColor
from datetime import datetime, timezone, timedelta
from pos_system.utils.firebase_sync import now_ar
from pos_system.utils import historial_facturas as hf
from pos_system.ui.theme import COLORS as _T

logger = logging.getLogger(__name__)

_TZ_AR = timezone(timedelta(hours=-3))


def _pesos(valor: float) -> str:
    """$ 1.234.567,89 — como se escribe acá."""
    s = f'{abs(valor):,.2f}'.replace(',', '#').replace('.', ',').replace('#', '.')
    return f'-${s}' if valor < 0 else f'${s}'


def _html(texto) -> str:
    return html.escape(str(texto or ''))


def _leer_facturas_nube(desde, hasta):
    """Facturas de todas las cajas entre dos días, desde Firestore.

    Devuelve None si no hay conexión (la pantalla avisa y muestra lo local).
    `created_at` es texto ISO en hora argentina, así que el rango se pide como
    texto: desde <= created_at < día siguiente.
    """
    from pos_system.utils.firebase_sync import get_firebase_sync
    fb = get_firebase_sync()
    if not fb or not getattr(fb, 'enabled', False) or getattr(fb, 'db', None) is None:
        return None
    from google.cloud.firestore_v1.base_query import FieldFilter
    lo, hi = hf.limites_iso(desde, hasta)
    consulta = (fb.db.collection('facturas')
                .where(filter=FieldFilter('created_at', '>=', lo))
                .where(filter=FieldFilter('created_at', '<', hi)))
    return [hf.fila_de_nube(s.id, s.to_dict()) for s in consulta.stream(timeout=25)]


class _CargaFacturasNube(QThread):
    """Lee la nube fuera del hilo de la pantalla: sin internet, Firestore puede
    tardar varios segundos en rendirse y la caja no se puede congelar."""
    listo = pyqtSignal(int, object)

    def __init__(self, generacion, desde, hasta, parent=None):
        super().__init__(parent)
        self._gen = generacion
        self._desde = desde
        self._hasta = hasta

    def run(self):
        try:
            filas = _leer_facturas_nube(self._desde, self._hasta)
        except Exception as e:
            logger.warning(f'Fiscal: no se pudieron leer las facturas de la nube: {e}')
            filas = None
        self.listo.emit(self._gen, filas)

def _parse_ar(s):
    """Parsea un timestamp guardado en SQLite y lo devuelve en hora AR (naive).

    Maneja 3 casos:
      - String con tzinfo (ej. '2026-04-28T14:08:00-03:00') → convierte a AR.
      - String naive en hora AR (ej. '2026-04-28 14:08:00' insertado por
        localtime_now() o now_ar()) → devuelve tal cual.
      - String naive en hora UTC (rows viejos con CURRENT_TIMESTAMP de SQLite,
        antes de la migración a localtime_now). Heurística: si la fecha
        parsed está >1.5h adelante de "ahora AR", asumimos UTC y restamos 3h.
    """
    try:
        dt = datetime.fromisoformat(str(s))
    except (ValueError, TypeError):
        # Intentar formato 'YYYY-MM-DD HH:MM:SS' sin separador T
        try:
            dt = datetime.strptime(str(s), '%Y-%m-%d %H:%M:%S')
        except (ValueError, TypeError):
            return datetime.now(_TZ_AR).replace(tzinfo=None)
    if dt.tzinfo is not None:
        return dt.astimezone(_TZ_AR).replace(tzinfo=None)
    # Naive — heurística para detectar rows viejos guardados en UTC
    now_ar_naive = datetime.now(_TZ_AR).replace(tzinfo=None)
    if (dt - now_ar_naive).total_seconds() > 1.5 * 3600:
        # Parece UTC (o futuro absurdo) → restar 3h
        return dt - timedelta(hours=3)
    return dt


class FiscalView(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(10)

        # Título, con la explicación en la misma línea para dejarle alto a la lista.
        cabecera = QHBoxLayout()
        cabecera.setSpacing(12)
        title = QLabel('Facturación Electrónica AFIP')
        title.setFont(QFont('Segoe UI', 15, QFont.Bold))
        title.setStyleSheet('color: #c1521f;')
        cabecera.addWidget(title, 0, Qt.AlignBaseline)
        self.lbl_subtitulo = QLabel('Las facturas de todas las cajas, separadas por emisor.')
        self.lbl_subtitulo.setStyleSheet(
            f'color:{_T["text_muted"]}; font-size:12px; background:transparent;')
        cabecera.addWidget(self.lbl_subtitulo, 1, Qt.AlignBaseline)
        layout.addLayout(cabecera)

        # Solo se expone Historial de Facturas. La emisión manual, la config
        # AFIP global y los perfiles ARCA están detrás (siguen accesibles desde
        # otros menús si hace falta), pero acá se concentra todo en lo que el
        # usuario realmente necesita: ver e historial + emitir Notas de Crédito.
        self.historial_tab = self._build_historial_tab()
        layout.addWidget(self.historial_tab)
        # Compat: algunos métodos referencian self.tabs / self._on_tab_changed
        # — los dejamos como atributos vacíos para no romper.
        self.tabs = None

    # ── TAB 1: Emitir factura manual ─────────────────────────────────────────
    def _build_emitir_tab(self):
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(12)

        info = QLabel(
            'Desde aquí podés emitir una factura manualmente ingresando los ítems y datos del cliente.\n'
            'Para facturar desde una venta registrada, usá el botón "Facturar AFIP" en la pestaña Ventas.'
        )
        info.setWordWrap(True)
        info.setStyleSheet(
            'background:#fbeee5; border:1px solid #dcd6c8; border-radius:6px;'
            'padding:8px 12px; color:#7a3514; font-size:11px;'
        )
        layout.addWidget(info)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setStyleSheet('QScrollArea { border: none; }')
        inner = QWidget()
        form_layout = QVBoxLayout(inner)
        form_layout.setSpacing(10)

        # ── Tipo de comprobante ───────────────────────────────────────────────
        tipo_group = QGroupBox('Comprobante')
        tipo_group.setFont(QFont('Segoe UI', 10, QFont.Bold))
        tipo_form = QFormLayout(tipo_group)
        tipo_form.setSpacing(8)

        self.m_tipo_combo = QComboBox()
        self.m_tipo_combo.addItems([
            'FAC. ELEC. B', 'FAC. ELEC. A', 'FAC. ELEC. C',
            'NOTA CRED. B', 'NOTA CRED. A', 'NOTA CRED. C',
            'NOTA DEB. B',  'NOTA DEB. A',  'NOTA DEB. C',
        ])
        self.m_tipo_combo.setFont(QFont('Segoe UI', 10))
        self.m_tipo_combo.currentTextChanged.connect(self._on_tipo_changed)
        tipo_form.addRow('Tipo:', self.m_tipo_combo)

        self.m_nombre_comp_input = QLineEdit('FACTURA')
        self.m_nombre_comp_input.setFont(QFont('Segoe UI', 10))
        self.m_nombre_comp_input.setPlaceholderText('FACTURA / NOTA DE CRÉDITO / etc.')
        tipo_form.addRow('Nombre comprobante:', self.m_nombre_comp_input)

        self.m_concepto_combo = QComboBox()
        self.m_concepto_combo.addItems(['1 - Productos', '2 - Servicios', '3 - Productos y Servicios'])
        self.m_concepto_combo.setFont(QFont('Segoe UI', 10))
        tipo_form.addRow('Concepto:', self.m_concepto_combo)

        self.m_pago_input = QLineEdit('Efectivo')
        self.m_pago_input.setFont(QFont('Segoe UI', 10))
        tipo_form.addRow('Forma de pago:', self.m_pago_input)

        form_layout.addWidget(tipo_group)

        # ── Cliente ───────────────────────────────────────────────────────────
        cli_group = QGroupBox('Datos del Receptor (Cliente)')
        cli_group.setFont(QFont('Segoe UI', 10, QFont.Bold))
        cli_form = QFormLayout(cli_group)
        cli_form.setSpacing(8)

        self.m_cliente_input = QLineEdit('CONSUMIDOR FINAL')
        self.m_cliente_input.setFont(QFont('Segoe UI', 10))
        cli_form.addRow('Razón Social:', self.m_cliente_input)

        self.m_cuit_input = QLineEdit('')
        self.m_cuit_input.setFont(QFont('Segoe UI', 10))
        self.m_cuit_input.setPlaceholderText('Vacío = Consumidor Final')
        cli_form.addRow('CUIT:', self.m_cuit_input)

        self.m_dom_receptor_input = QLineEdit('')
        self.m_dom_receptor_input.setFont(QFont('Segoe UI', 10))
        self.m_dom_receptor_input.setPlaceholderText('Domicilio del cliente')
        cli_form.addRow('Domicilio:', self.m_dom_receptor_input)

        self.m_cond_iva_receptor_combo = QComboBox()
        self.m_cond_iva_receptor_combo.addItems([
            'Consumidor Final', 'Responsable Inscripto', 'Monotributista', 'Exento', 'No Categorizado'
        ])
        self.m_cond_iva_receptor_combo.setFont(QFont('Segoe UI', 10))
        cli_form.addRow('Condición IVA:', self.m_cond_iva_receptor_combo)

        form_layout.addWidget(cli_group)

        # ── Items ─────────────────────────────────────────────────────────────
        items_group = QGroupBox('Ítems de la Factura')
        items_group.setFont(QFont('Segoe UI', 10, QFont.Bold))
        items_v = QVBoxLayout(items_group)

        self.m_items_table = QTableWidget()
        self.m_items_table.setColumnCount(4)
        self.m_items_table.setHorizontalHeaderLabels(['Descripción', 'Cantidad', 'Precio Unit.', 'Importe'])
        self.m_items_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.m_items_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeToContents)
        self.m_items_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        self.m_items_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeToContents)
        self.m_items_table.setMinimumHeight(160)
        items_v.addWidget(self.m_items_table)

        items_btn_row = QHBoxLayout()
        add_item_btn = QPushButton('+ Agregar ítem')
        add_item_btn.setFont(QFont('Segoe UI', 9))
        add_item_btn.clicked.connect(self._add_item_row)
        items_btn_row.addWidget(add_item_btn)

        del_item_btn = QPushButton('− Quitar seleccionado')
        del_item_btn.setFont(QFont('Segoe UI', 9))
        del_item_btn.setObjectName('btnSecondary')
        del_item_btn.clicked.connect(self._del_item_row)
        items_btn_row.addWidget(del_item_btn)
        items_btn_row.addStretch()
        items_v.addLayout(items_btn_row)
        form_layout.addWidget(items_group)

        # ── CAE / Totales ─────────────────────────────────────────────────────
        afip_group = QGroupBox('Totales y Datos AFIP')
        afip_group.setFont(QFont('Segoe UI', 10, QFont.Bold))
        afip_form = QFormLayout(afip_group)
        afip_form.setSpacing(8)

        self.m_total_input = QLineEdit('0.00')
        self.m_total_input.setFont(QFont('Segoe UI', 10))
        afip_form.addRow('Total ($):', self.m_total_input)

        self.m_iva_input = QLineEdit('0.00')
        self.m_iva_input.setFont(QFont('Segoe UI', 10))
        afip_form.addRow('IVA Contenido ($):', self.m_iva_input)

        self.m_otros_imp_input = QLineEdit('0.00')
        self.m_otros_imp_input.setFont(QFont('Segoe UI', 10))
        afip_form.addRow('Otros Imp. ($):', self.m_otros_imp_input)

        afip_form.addRow(QLabel('── CAE (se puede cargar manual o solicitar a AFIP) ──'))

        self.m_cae_input = QLineEdit('')
        self.m_cae_input.setFont(QFont('Segoe UI', 10))
        self.m_cae_input.setPlaceholderText('Se completa automático al solicitar a AFIP')
        afip_form.addRow('CAE:', self.m_cae_input)

        self.m_vto_input = QLineEdit('')
        self.m_vto_input.setFont(QFont('Segoe UI', 10))
        self.m_vto_input.setPlaceholderText('AAAAMMDD — se completa automático')
        afip_form.addRow('Vto. CAE:', self.m_vto_input)

        form_layout.addWidget(afip_group)
        scroll.setWidget(inner)
        layout.addWidget(scroll)

        # ── Botones emitir ────────────────────────────────────────────────────
        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)

        afip_btn = QPushButton('Solicitar CAE a AFIP y Generar PDF')
        afip_btn.setMinimumHeight(46)
        afip_btn.setFont(QFont('Segoe UI', 11, QFont.Bold))
        afip_btn.setStyleSheet('''
            QPushButton {
                background: #3d7a3a; color: white;
                border: none; border-radius: 8px;
            }
            QPushButton:hover { background: #2f5e2c; }
        ''')
        afip_btn.clicked.connect(self._emit_con_afip)
        btn_row.addWidget(afip_btn, 2)

        manual_btn = QPushButton('Solo PDF (sin AFIP)')
        manual_btn.setMinimumHeight(46)
        manual_btn.setFont(QFont('Segoe UI', 11, QFont.Bold))
        manual_btn.setStyleSheet('''
            QPushButton {
                background: #c1521f; color: white;
                border: none; border-radius: 8px;
            }
            QPushButton:hover { background: #a3441a; }
        ''')
        manual_btn.clicked.connect(self._emit_manual)
        btn_row.addWidget(manual_btn, 1)

        layout.addLayout(btn_row)
        return widget

    def _add_item_row(self):
        row = self.m_items_table.rowCount()
        self.m_items_table.insertRow(row)
        self.m_items_table.setItem(row, 0, QTableWidgetItem('Producto'))
        self.m_items_table.setItem(row, 1, QTableWidgetItem('1'))
        self.m_items_table.setItem(row, 2, QTableWidgetItem('0.00'))
        self.m_items_table.setItem(row, 3, QTableWidgetItem('0.00'))

    def _del_item_row(self):
        row = self.m_items_table.currentRow()
        if row >= 0:
            self.m_items_table.removeRow(row)

    def _on_tipo_changed(self, tipo_txt):
        """Actualiza el nombre del comprobante automáticamente al cambiar el tipo."""
        mapping = {
            'FAC. ELEC. A': 'FACTURA',
            'FAC. ELEC. B': 'FACTURA',
            'FAC. ELEC. C': 'FACTURA',
            'NOTA CRED. A': 'NOTA DE CRÉDITO',
            'NOTA CRED. B': 'NOTA DE CRÉDITO',
            'NOTA CRED. C': 'NOTA DE CRÉDITO',
            'NOTA DEB. A':  'NOTA DE DÉBITO',
            'NOTA DEB. B':  'NOTA DE DÉBITO',
            'NOTA DEB. C':  'NOTA DE DÉBITO',
        }
        self.m_nombre_comp_input.setText(mapping.get(tipo_txt, 'FACTURA'))

    def _get_factura_dict(self, cae='', vto_cae='', nro=None):
        """Arma el dict factura con todos los datos del formulario."""
        from pos_system.database.db_manager import DatabaseManager
        tipo = self.m_tipo_combo.currentText()
        cliente = self.m_cliente_input.text().strip() or 'CONSUMIDOR FINAL'
        cuit_cli = self.m_cuit_input.text().strip()
        dom_receptor = self.m_dom_receptor_input.text().strip()
        cond_iva_receptor = self.m_cond_iva_receptor_combo.currentText()
        concepto = int(self.m_concepto_combo.currentText()[0])

        try:
            total  = float(self.m_total_input.text().replace(',', '.'))
            iva    = float(self.m_iva_input.text().replace(',', '.'))
            otros  = float(self.m_otros_imp_input.text().replace(',', '.'))
        except ValueError:
            raise ValueError('Total, IVA u Otros Imp. inválido')

        items = []
        for r in range(self.m_items_table.rowCount()):
            try:
                desc    = (self.m_items_table.item(r, 0) or QTableWidgetItem('')).text()
                cant    = float((self.m_items_table.item(r, 1) or QTableWidgetItem('1')).text())
                precio  = float((self.m_items_table.item(r, 2) or QTableWidgetItem('0')).text())
                importe = float((self.m_items_table.item(r, 3) or QTableWidgetItem('0')).text())
                items.append({'cantidad': cant, 'descripcion': desc, 'iva': 21.0,
                              'precio': precio, 'importe': importe})
            except Exception:
                pass

        if not items:
            raise ValueError('Agregue al menos un ítem')

        # Datos emisor desde DB
        db = DatabaseManager()
        def cfg(key, default=''):
            res = db.execute_query("SELECT value FROM config WHERE key=?", (key,))
            return (res[0]['value'] or default) if res and res[0]['value'] else default

        cuit_emisor   = cfg('afip_cuit')
        razon_social  = cfg('afip_razon_social')
        domicilio     = cfg('afip_domicilio')
        localidad     = cfg('afip_localidad')
        telefono      = cfg('afip_telefono')
        ing_brutos    = cfg('afip_ing_brutos')
        inicio_act    = cfg('afip_inicio_actividades')
        cond_iva_em   = cfg('afip_condicion_iva', 'Responsable Inscripto')
        punto_venta   = int(cfg('afip_punto_venta', '1') or '1')

        if nro is None:
            res = db.execute_query(
                "SELECT MAX(nro_comprobante) as m FROM facturas WHERE tipo_comprobante=?", (tipo,)
            )
            nro = (res[0]['m'] or 0) + 1 if res else 1

        return {
            'cuit': cuit_emisor, 'razon_social': razon_social,
            'domicilio': domicilio, 'localidad': localidad,
            'telefono': telefono, 'ing_brutos': ing_brutos,
            'inicio_actividades': inicio_act, 'condicion_iva': cond_iva_em,
            'tipo_comprobante': tipo,
            'tipo_comprobante_nombre': self.m_nombre_comp_input.text().strip() or 'FACTURA',
            'punto_venta': punto_venta,
            'nro_comprobante': nro,
            'fecha': now_ar().strftime('%d/%m/%Y'),
            'pago': self.m_pago_input.text(),
            'cliente': cliente,
            'cuit_receptor': cuit_cli,
            'domicilio_receptor': dom_receptor,
            'condicion_iva_receptor': cond_iva_receptor,
            'concepto': concepto,
            'items': items,
            'total': total,
            'iva_contenido': iva,
            'otros_impuestos': otros,
            'cae': cae,
            'vto_cae': vto_cae,
        }, db, punto_venta, tipo, cuit_cli, cliente, iva, otros, nro

    def _abrir_pdf(self, pdf_path):
        import os, subprocess, sys
        if sys.platform == 'win32':
            os.startfile(pdf_path)
        else:
            subprocess.Popen(['xdg-open', pdf_path])

    def _emit_manual(self):
        """Genera PDF con CAE manual (ya cargado en el formulario)."""
        from pos_system.utils.pdf_generator import PDFGenerator
        cae = self.m_cae_input.text().strip()
        vto = self.m_vto_input.text().strip()
        try:
            factura, db, pto_venta, tipo, cuit_cli, cliente, iva, otros, nro = \
                self._get_factura_dict(cae=cae, vto_cae=vto)
        except ValueError as e:
            QMessageBox.warning(self, 'Error', str(e))
            return
        try:
            gen = PDFGenerator()
            pdf_path = gen.generate_factura_afip_a4(factura)
            db.execute_update(
                """INSERT INTO facturas
                   (sale_id, tipo_comprobante, punto_venta, nro_comprobante, fecha,
                    cliente, cuit_cliente, cae, vto_cae, total, iva_contenido,
                    otros_impuestos, pdf_path)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (None, tipo, pto_venta, nro,
                 now_ar().isoformat(), cliente, cuit_cli,
                 cae, vto, factura['total'], iva, otros, pdf_path)
            )
            reply = QMessageBox.question(
                self, 'PDF generado',
                f'Comprobante #{nro} generado.\n\n¿Abrir el PDF?',
                QMessageBox.Yes | QMessageBox.No, QMessageBox.Yes
            )
            if reply == QMessageBox.Yes:
                self._abrir_pdf(pdf_path)
            self.refresh_data()
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'Error al generar PDF:\n{str(e)}')

    def _emit_con_afip(self):
        """Solicita CAE a AFIP (WSFE) y genera el PDF con diseño oficial."""
        from pos_system.utils.pdf_generator import PDFGenerator
        from pos_system.database.db_manager import DatabaseManager
        try:
            factura, db, pto_venta, tipo, cuit_cli, cliente, iva, otros, nro = \
                self._get_factura_dict()
        except ValueError as e:
            QMessageBox.warning(self, 'Error', str(e))
            return

        # Leer credenciales AFIP
        def cfg(key, default=''):
            res = db.execute_query("SELECT value FROM config WHERE key=?", (key,))
            return (res[0]['value'] or default) if res and res[0]['value'] else default

        cert_path  = cfg('afip_cert_path')
        key_path   = cfg('afip_key_path')
        produccion = cfg('afip_produccion', '0') == '1'

        if not cert_path or not key_path:
            QMessageBox.warning(
                self, 'Sin certificado AFIP',
                'Para solicitar CAE automáticamente necesitás configurar el\n'
                'certificado (.crt) y la clave privada (.key) de AFIP.\n\n'
                'Configuralos en la pestaña Configuracion AFIP.\n\n'
                'Por ahora podés usar "Solo PDF" ingresando el CAE manualmente.'
            )
            return

        from pos_system.utils.afip_wsfe import AfipWsfe, AFIPError, calcular_iva_neto
        try:
            afip = AfipWsfe(
                cuit=factura['cuit'],
                cert_path=cert_path,
                key_path=key_path,
                produccion=produccion,
            )
            total     = factura['total']
            iva_cont  = factura['iva_contenido']
            neto_grav = round(total - iva_cont - factura['otros_impuestos'], 2)
            concepto  = factura.get('concepto', 1)

            resultado = afip.solicitar_cae(
                tipo_comprobante=tipo,
                punto_venta=pto_venta,
                nro_comprobante=nro,
                importe_total=total,
                importe_neto_gravado=neto_grav,
                importe_iva=iva_cont,
                importe_otros=factura['otros_impuestos'],
                concepto=concepto,
                cuit_receptor=cuit_cli or None,
                condicion_iva_receptor=factura['condicion_iva_receptor'],
            )
        except ImportError as e:
            QMessageBox.critical(self, 'Dependencia faltante', str(e))
            return
        except AFIPError as e:
            import logging
            logging.getLogger(__name__).exception('AFIP error en fiscal_view')
            try:
                from pos_system.utils.afip_error_reporter import report_afip_error
                report_afip_error(e, {
                    'etapa': 'fiscal_view.solicitar_cae',
                    'tipo_comprobante': tipo,
                    'punto_venta': pto_venta,
                    'nro': nro,
                    'cuit_emisor': factura.get('cuit', ''),
                    'cuit_receptor': cuit_cli,
                    'total': factura.get('total'),
                    'produccion': produccion,
                })
            except Exception:
                pass
            QMessageBox.critical(self, 'Error AFIP', str(e))
            return
        except Exception as e:
            import logging
            logging.getLogger(__name__).exception('Error inesperado AFIP en fiscal_view')
            try:
                from pos_system.utils.afip_error_reporter import report_afip_error
                report_afip_error(e, {
                    'etapa': 'fiscal_view.inesperado',
                    'tipo_comprobante': tipo,
                    'punto_venta': pto_venta,
                    'cuit_emisor': factura.get('cuit', ''),
                    'produccion': produccion,
                })
            except Exception:
                pass
            QMessageBox.critical(self, 'Error', f'Error inesperado al contactar AFIP:\n{str(e)}')
            return

        cae     = resultado['cae']
        vto_cae = resultado['vto_cae']
        nro_real = resultado['nro_comprobante']

        # Actualizar campos en la UI
        self.m_cae_input.setText(cae)
        self.m_vto_input.setText(vto_cae)

        # Actualizar factura con CAE real
        factura['cae']             = cae
        factura['vto_cae']         = vto_cae
        factura['nro_comprobante'] = nro_real

        try:
            gen = PDFGenerator()
            pdf_path = gen.generate_factura_afip_a4(factura)
            db.execute_update(
                """INSERT INTO facturas
                   (sale_id, tipo_comprobante, punto_venta, nro_comprobante, fecha,
                    cliente, cuit_cliente, cae, vto_cae, total, iva_contenido,
                    otros_impuestos, pdf_path)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (None, tipo, pto_venta, nro_real,
                 now_ar().isoformat(), cliente, cuit_cli,
                 cae, vto_cae, total, iva_cont, otros, pdf_path)
            )
            entorno = 'PRODUCCIÓN' if produccion else 'HOMOLOGACIÓN'
            reply = QMessageBox.question(
                self, f'CAE obtenido — {entorno}',
                f'CAE: {cae}\nVto.: {vto_cae}\nComprobante Nro: {nro_real}\n\n¿Abrir el PDF?',
                QMessageBox.Yes | QMessageBox.No, QMessageBox.Yes
            )
            if reply == QMessageBox.Yes:
                self._abrir_pdf(pdf_path)
            self.refresh_data()
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'CAE obtenido pero error al generar PDF:\n{str(e)}')

    # ── TAB 2: Historial ──────────────────────────────────────────────────────
    #
    # Muestra las facturas de TODAS las cajas (colección `facturas` de la nube)
    # más las de esta PC que no llegaron a subir, y las separa por emisor.
    # La lógica de filas, emisores y totales vive en utils/historial_facturas.py.

    _COLUMNAS = ['Comprobante', 'Fecha', 'Emisor', 'Cliente', 'CUIT / DNI',
                 'Pago', 'Origen', 'Total', 'CAE']
    _COL_EMISOR = 2

    def _build_historial_tab(self):
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setContentsMargins(0, 2, 0, 0)
        layout.setSpacing(10)

        self._perfiles = []
        self._filas = []
        self._visibles = []
        self._sin_nube = False
        self._generacion = 0
        self._cargas = set()
        self._pendiente = True
        self._cargado_alguna_vez = False

        # ── Filtros ─────────────────────────────────────────────────────────
        filter_scroll = QScrollArea()
        filter_scroll.setWidgetResizable(True)
        filter_scroll.setMaximumHeight(64)
        filter_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        filter_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        filter_scroll.setFrameShape(QFrame.NoFrame)
        filter_scroll.setStyleSheet('QScrollArea { background:transparent; border:none; }')

        filter_frame = QFrame()
        filter_frame.setObjectName('fiscalFiltros')
        filter_frame.setStyleSheet(
            f'QFrame#fiscalFiltros {{ background:{_T["surface"]}; border:1px solid {_T["border"]};'
            f' border-radius:8px; }}'
        )
        fl = QHBoxLayout(filter_frame)
        fl.setContentsMargins(12, 8, 12, 8)
        fl.setSpacing(8)

        input_qss = (
            f"QDateEdit, QComboBox, QLineEdit {{ border:1px solid {_T['border']}; border-radius:6px;"
            f" background:{_T['surface']}; padding:4px 10px; color:{_T['text']}; }}"
            f"QDateEdit:focus, QComboBox:focus, QLineEdit:focus {{ border-color:{_T['accent']}; }}"
            f"QComboBox::drop-down, QDateEdit::drop-down {{ border:none; width:20px; }}"
        )
        flabel_qss = (f'color:{_T["text_muted"]}; font-size:11px; font-weight:600;'
                      ' background:transparent; border:none;')

        def _flabel(txt):
            lbl = QLabel(txt)
            lbl.setStyleSheet(flabel_qss)
            return lbl

        fl.addWidget(_flabel('Emisor'))
        self.perfil_combo = QComboBox()
        self.perfil_combo.setMinimumHeight(34)
        self.perfil_combo.setMinimumWidth(250)
        self.perfil_combo.setStyleSheet(input_qss)
        self.perfil_combo.setToolTip('Perfil ARCA que emitió la factura')
        self._cargar_perfiles_combo()
        self.perfil_combo.currentIndexChanged.connect(self._aplicar_filtro)
        fl.addWidget(self.perfil_combo)

        fl.addSpacing(6)
        fl.addWidget(_flabel('Desde'))
        hoy = QDate.currentDate()
        self.f_desde = QDateEdit()
        self.f_hasta = QDateEdit()
        for de in (self.f_desde, self.f_hasta):
            de.setCalendarPopup(True)
            de.setDisplayFormat('dd/MM/yyyy')
            de.setMinimumHeight(34)
            de.setMinimumWidth(112)
            de.setStyleSheet(input_qss)
        self.f_desde.setDate(QDate(hoy.year(), hoy.month(), 1))
        self.f_hasta.setDate(hoy)
        fl.addWidget(self.f_desde)
        fl.addWidget(_flabel('Hasta'))
        fl.addWidget(self.f_hasta)

        # Un solo recargado aunque se toquen las dos fechas seguidas.
        self._timer_fechas = QTimer(self)
        self._timer_fechas.setSingleShot(True)
        self._timer_fechas.setInterval(350)
        self._timer_fechas.timeout.connect(self._cargar)
        self.f_desde.dateChanged.connect(self._fechas_cambiadas)
        self.f_hasta.dateChanged.connect(self._fechas_cambiadas)

        rango_qss = (
            f"QPushButton {{ background:{_T['surface_alt']}; color:{_T['text_muted']};"
            f" border:1px solid {_T['border']}; border-radius:6px;"
            f" padding:4px 10px; font-size:11px; font-weight:700; min-height:32px; }}"
            f"QPushButton:hover {{ border-color:{_T['accent']}; color:{_T['accent']}; }}"
            f"QPushButton:checked {{ background:{_T['accent']}; color:white; border-color:{_T['accent']}; }}"
        )
        self._botones_rango = {}
        for clave, texto in hf.PERIODOS:
            b = QPushButton(texto)
            b.setCheckable(True)
            b.setCursor(Qt.PointingHandCursor)
            b.setStyleSheet(rango_qss)
            b.clicked.connect(lambda _=False, c=clave: self._elegir_periodo(c))
            fl.addWidget(b)
            self._botones_rango[clave] = b

        fl.addSpacing(6)
        self.f_buscar = QLineEdit()
        self.f_buscar.setPlaceholderText('Buscar cliente, CUIT o número')
        self.f_buscar.setClearButtonEnabled(True)
        self.f_buscar.setMinimumHeight(34)
        self.f_buscar.setMinimumWidth(210)
        self.f_buscar.setStyleSheet(input_qss)
        self.f_buscar.textChanged.connect(self._aplicar_filtro)
        fl.addWidget(self.f_buscar, 1)

        refresh_btn = QPushButton('Actualizar')
        refresh_btn.setCursor(Qt.PointingHandCursor)
        refresh_btn.setToolTip('Vuelve a traer las facturas de todas las cajas')
        refresh_btn.setStyleSheet(
            f"QPushButton {{ background:{_T['accent']}; color:white; border:none;"
            f" border-radius:6px; padding:4px 18px; font-weight:700; min-height:34px; }}"
            f"QPushButton:hover {{ background:{_T['accent_hover']}; }}"
        )
        refresh_btn.clicked.connect(lambda: (self._cargar_perfiles_combo(), self._cargar()))
        fl.addWidget(refresh_btn)

        filter_scroll.setWidget(filter_frame)
        layout.addWidget(filter_scroll)

        # ── Totales ─────────────────────────────────────────────────────────
        totales_row = QHBoxLayout()
        totales_row.setSpacing(10)

        def _totbox(color_bg, color_txt, titulo):
            box = QFrame()
            box.setObjectName('fiscalTot')
            box.setStyleSheet(
                f'QFrame#fiscalTot {{ background:{color_bg}; border:1px solid {color_txt};'
                ' border-radius:8px; }'
            )
            v = QVBoxLayout(box)
            v.setContentsMargins(14, 8, 14, 9)
            v.setSpacing(1)
            t = QLabel(titulo)
            t.setFont(QFont('Segoe UI', 9, QFont.Bold))
            t.setStyleSheet(f'color:{color_txt}; background:transparent; border:none;')
            val = QLabel('$0,00')
            val.setFont(QFont('Segoe UI', 15, QFont.Bold))
            val.setStyleSheet(f'color:{color_txt}; background:transparent; border:none;')
            sub = QLabel('')
            sub.setFont(QFont('Segoe UI', 9))
            sub.setStyleSheet(f'color:{_T["text_muted"]}; background:transparent; border:none;')
            v.addWidget(t)
            v.addWidget(val)
            v.addWidget(sub)
            totales_row.addWidget(box, 1)
            return val, sub

        self.t_total_value, self.t_total_sub = _totbox('#fbeee5', '#7a3514', 'Total facturado')
        self.t_v2_value, self.t_v2_sub = _totbox('#f3e8ff', '#a3441a', 'Varios 2 facturado')
        self.t_reg_value, self.t_reg_sub = _totbox('#e7f4ec', '#0a3622', 'Facturas a clientes')
        self.t_transf_value, self.t_transf_sub = _totbox(
            '#fbeee5', '#664d03', 'Clientes por transferencia')
        self.t_transf_value.parentWidget().setToolTip(
            'Facturas a clientes o empresas cobradas por transferencia.\n'
            'Es lo que hay que restar de lo que entró por Mercado Pago\n'
            'antes de hacer la factura Varios 2 del día.'
        )
        layout.addLayout(totales_row)

        # Reparto por emisor (solo con "Todos los emisores")
        self.lbl_por_emisor = QLabel('')
        self.lbl_por_emisor.setTextFormat(Qt.RichText)
        self.lbl_por_emisor.setStyleSheet(
            f'color:{_T["text_muted"]}; font-size:12px; background:transparent;')
        layout.addWidget(self.lbl_por_emisor)

        # ── Tabla + detalle ─────────────────────────────────────────────────
        splitter = QSplitter(Qt.Vertical)
        splitter.setHandleWidth(8)
        splitter.setChildrenCollapsible(False)
        splitter.setStyleSheet('QSplitter::handle { background:transparent; }')

        self.h_table = QTableWidget()
        self.h_table.setColumnCount(len(self._COLUMNAS))
        self.h_table.setHorizontalHeaderLabels(self._COLUMNAS)
        self.h_table.verticalHeader().setVisible(False)
        self.h_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.h_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.h_table.setSelectionMode(QTableWidget.SingleSelection)
        self.h_table.setAlternatingRowColors(True)
        self.h_table.setShowGrid(False)
        self.h_table.setWordWrap(False)
        self.h_table.verticalHeader().setDefaultSectionSize(28)
        self.h_table.setStyleSheet(self._tabla_qss())
        hh = self.h_table.horizontalHeader()
        hh.setHighlightSections(False)
        for c in range(len(self._COLUMNAS)):
            hh.setSectionResizeMode(c, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(3, QHeaderView.Stretch)
        self.h_table.itemSelectionChanged.connect(self._mostrar_detalle)
        self.h_table.cellDoubleClicked.connect(lambda *_: self._reprint_selected())

        self._tabla_stack = QStackedWidget()
        self._tabla_stack.addWidget(self.h_table)
        vacio = QFrame()
        vacio.setObjectName('fiscalVacio')
        vacio.setStyleSheet(
            f'QFrame#fiscalVacio {{ background:{_T["surface"]}; border:1px solid {_T["border"]};'
            ' border-radius:8px; }')
        vv = QVBoxLayout(vacio)
        vv.addStretch(1)
        self.lbl_vacio = QLabel('Cargando facturas…')
        self.lbl_vacio.setAlignment(Qt.AlignCenter)
        self.lbl_vacio.setStyleSheet(
            f'color:{_T["text"]}; font-size:14px; font-weight:700; background:transparent;')
        self.lbl_vacio_sub = QLabel('')
        self.lbl_vacio_sub.setAlignment(Qt.AlignCenter)
        self.lbl_vacio_sub.setStyleSheet(
            f'color:{_T["text_muted"]}; font-size:12px; background:transparent;')
        vv.addWidget(self.lbl_vacio)
        vv.addWidget(self.lbl_vacio_sub)
        vv.addStretch(1)
        self._tabla_stack.addWidget(vacio)
        self._tabla_stack.setCurrentIndex(1)
        splitter.addWidget(self._tabla_stack)
        splitter.addWidget(self._build_detalle())
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([400, 175])
        layout.addWidget(splitter, 1)

        self._marcar_periodo()
        return widget

    def _tabla_qss(self):
        return (
            # Sin `color` en ::item: pisaría los colores por celda (CAE, Varios 2, NC).
            f"QTableWidget {{ border:1px solid {_T['border']}; border-radius:8px;"
            f" background:{_T['surface']}; alternate-background-color:{_T['surface_alt']};"
            f" gridline-color:{_T['border_soft']}; outline:none; color:{_T['text']};"
            f" selection-background-color:{_T['accent_soft']}; selection-color:{_T['text']}; }}"
            f"QTableWidget::item {{ padding:4px 10px; border:none; }}"
            f"QHeaderView::section {{ background:{_T['surface_alt']}; color:{_T['text_muted']};"
            f" padding:8px 10px; border:none; border-bottom:1px solid {_T['border']};"
            f" font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.4px; }}"
            f"QScrollBar:vertical {{ background:transparent; width:10px; margin:2px; }}"
            f"QScrollBar::handle:vertical {{ background:{_T['border']}; border-radius:5px; min-height:30px; }}"
            f"QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height:0; }}"
        )

    def _build_detalle(self):
        panel = QWidget()
        v = QVBoxLayout(panel)
        v.setContentsMargins(0, 4, 0, 0)
        v.setSpacing(8)

        cab = QHBoxLayout()
        cab.setSpacing(8)
        self.lbl_detalle_titulo = QLabel('Detalle de la factura')
        self.lbl_detalle_titulo.setFont(QFont('Segoe UI', 12, QFont.Bold))
        self.lbl_detalle_titulo.setStyleSheet(f'color:{_T["text"]}; background:transparent;')
        cab.addWidget(self.lbl_detalle_titulo)
        cab.addStretch()

        quiet_qss = (
            f"QPushButton {{ background:{_T['surface']}; color:{_T['text']};"
            f" border:1px solid {_T['border']}; border-radius:6px; padding:6px 16px;"
            f" font-weight:600; min-height:34px; }}"
            f"QPushButton:hover {{ background:{_T['surface_alt']}; border-color:{_T['text_dim']}; }}"
            f"QPushButton:disabled {{ color:{_T['text_dim']}; border-color:{_T['border_soft']}; }}"
        )
        outline_danger_qss = (
            f"QPushButton {{ background:{_T['surface']}; color:{_T['danger']};"
            f" border:1px solid {_T['danger']}; border-radius:6px; padding:6px 14px;"
            f" font-weight:600; min-height:34px; }}"
            f"QPushButton:hover {{ background:{_T['danger_bg']}; }}"
        )
        danger_qss = (
            f"QPushButton {{ background:{_T['danger']}; color:white; border:none;"
            f" border-radius:6px; padding:6px 16px; font-weight:700; min-height:34px; }}"
            f"QPushButton:hover {{ background:#7a1010; }}"
            f"QPushButton:disabled {{ background:{_T['border']}; color:{_T['text_dim']}; }}"
        )

        self.btn_pdf = QPushButton('Abrir PDF')
        self.btn_pdf.setStyleSheet(quiet_qss)
        self.btn_pdf.setCursor(Qt.PointingHandCursor)
        self.btn_pdf.setToolTip('Abre la factura. Si se hizo en otra caja, se arma el PDF de nuevo.')
        self.btn_pdf.clicked.connect(self._reprint_selected)
        cab.addWidget(self.btn_pdf)

        test_nc_btn = QPushButton('Probar permisos NC')
        test_nc_btn.setStyleSheet(outline_danger_qss)
        test_nc_btn.setCursor(Qt.PointingHandCursor)
        test_nc_btn.setToolTip(
            'Consulta a AFIP si el emisor puede hacer Notas de Crédito.\n'
            'Usa el emisor elegido arriba o, si están todos, el de la factura marcada.\n'
            'No emite ningún comprobante.'
        )
        test_nc_btn.clicked.connect(self._test_permisos_nc)
        cab.addWidget(test_nc_btn)

        self.btn_nc = QPushButton('Hacer Nota de Crédito')
        self.btn_nc.setStyleSheet(danger_qss)
        self.btn_nc.setCursor(Qt.PointingHandCursor)
        self.btn_nc.setToolTip(
            'Anula total o parcialmente la factura marcada.\n'
            'Sale con el CUIT y el punto de venta de quien la emitió.'
        )
        self.btn_nc.clicked.connect(self._on_nota_credito)
        cab.addWidget(self.btn_nc)
        v.addLayout(cab)

        cuerpo = QHBoxLayout()
        cuerpo.setSpacing(10)

        datos = QFrame()
        datos.setObjectName('fiscalDatos')
        datos.setStyleSheet(
            f'QFrame#fiscalDatos {{ background:{_T["surface"]}; border:1px solid {_T["border"]};'
            ' border-radius:8px; }')
        g = QGridLayout(datos)
        g.setContentsMargins(14, 10, 14, 10)
        g.setHorizontalSpacing(12)
        g.setVerticalSpacing(6)
        self._detalle_vals = {}
        # Dos columnas de datos: a la izquierda quién y cuándo, a la derecha a quién y cómo.
        campos = [('emisor', 'Emisor', 0, 0), ('comprobante', 'Comprobante', 1, 0),
                  ('fecha', 'Fecha', 2, 0), ('cae', 'CAE', 3, 0),
                  ('cliente', 'Cliente', 0, 2), ('documento', 'Documento', 1, 2),
                  ('pago', 'Pago', 2, 2), ('venta', 'Venta', 3, 2)]
        for clave, rotulo, fila, col in campos:
            r = QLabel(rotulo)
            r.setStyleSheet(f'color:{_T["text_muted"]}; font-size:11px; font-weight:600;'
                            ' background:transparent; border:none;')
            val = QLabel('—')
            val.setStyleSheet(f'color:{_T["text"]}; font-size:12px; background:transparent; border:none;')
            val.setTextInteractionFlags(Qt.TextSelectableByMouse)
            # Ignorado a lo ancho: un nombre de empresa largo se corta en vez de
            # empujar el panel; el texto entero queda en el globito.
            val.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
            g.addWidget(r, fila, col, Qt.AlignLeft | Qt.AlignTop)
            g.addWidget(val, fila, col + 1, Qt.AlignTop)
            self._detalle_vals[clave] = val
        g.setColumnStretch(1, 1)
        g.setColumnStretch(3, 1)
        g.setColumnMinimumWidth(2, 70)
        g.setRowStretch(4, 1)
        cuerpo.addWidget(datos, 7)

        self.items_table = QTableWidget()
        self.items_table.setColumnCount(4)
        self.items_table.setHorizontalHeaderLabels(['Producto', 'Cant.', 'Precio', 'Importe'])
        self.items_table.verticalHeader().setVisible(False)
        self.items_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.items_table.setSelectionMode(QTableWidget.NoSelection)
        self.items_table.setFocusPolicy(Qt.NoFocus)
        self.items_table.setAlternatingRowColors(True)
        self.items_table.setShowGrid(False)
        self.items_table.setStyleSheet(self._tabla_qss())
        ih = self.items_table.horizontalHeader()
        ih.setHighlightSections(False)
        ih.setSectionResizeMode(0, QHeaderView.Stretch)
        for c in (1, 2, 3):
            ih.setSectionResizeMode(c, QHeaderView.ResizeToContents)
        cuerpo.addWidget(self.items_table, 5)
        v.addLayout(cuerpo, 1)

        self._limpiar_detalle()
        return panel

    # ── Cargar ─────────────────────────────────────────────────────────────
    def _rango(self):
        return self.f_desde.date().toPyDate(), self.f_hasta.date().toPyDate()

    def _fechas_cambiadas(self, *_):
        self._marcar_periodo()
        self._timer_fechas.start()

    def _elegir_periodo(self, clave):
        desde, hasta = hf.rango_de(clave, now_ar().date())
        for de, d in ((self.f_desde, desde), (self.f_hasta, hasta)):
            de.blockSignals(True)
            de.setDate(QDate(d.year, d.month, d.day))
            de.blockSignals(False)
        self._marcar_periodo()
        self._timer_fechas.stop()
        self._cargar()

    def _marcar_periodo(self):
        """Prende el botón de rango que coincide con las fechas elegidas."""
        desde, hasta = self._rango()
        hoy = now_ar().date()
        for clave, b in self._botones_rango.items():
            b.setChecked(hf.rango_de(clave, hoy) == (desde, hasta))

    def _leer_locales(self):
        from pos_system.database.db_manager import DatabaseManager
        try:
            rows = DatabaseManager().execute_query(
                "SELECT * FROM facturas ORDER BY created_at DESC LIMIT 5000") or []
        except Exception as e:
            logger.warning(f'Fiscal: no se pudo leer la base local de facturas: {e}')
            return []
        filas = []
        for r in rows:
            f = hf.fila_local(r)
            try:
                # Filas viejas guardadas en UTC: misma corrección que el resto de la pestaña.
                f['fecha'] = _parse_ar(r['created_at']) if r.get('created_at') else f['fecha']
            except Exception:
                pass
            filas.append(f)
        return filas

    def _cargar(self):
        if not hasattr(self, 'h_table'):
            return
        self._pendiente = False
        self._generacion += 1
        gen = self._generacion
        desde, hasta = self._rango()
        if desde > hasta:
            desde, hasta = hasta, desde
        if not self._filas:
            self.lbl_vacio.setText('Cargando facturas…')
            self.lbl_vacio_sub.setText('')
            self._tabla_stack.setCurrentIndex(1)
        hilo = _CargaFacturasNube(gen, desde, hasta, self)
        hilo.listo.connect(self._nube_lista)
        hilo.finished.connect(lambda h=hilo: self._cargas.discard(h))
        self._cargas.add(hilo)
        hilo.start()

    def _nube_lista(self, gen, nube):
        if gen != self._generacion:
            return  # llegó tarde: el usuario ya pidió otro rango
        self._cargado_alguna_vez = True
        locales = self._leer_locales()
        if nube is None:
            self._sin_nube = True
            self._filas = hf.combinar([], locales)
            self.lbl_subtitulo.setText('Sin conexión con la nube: se ven solo las facturas de esta PC.')
            self.lbl_subtitulo.setStyleSheet(
                f'color:{_T["warning"]}; font-size:12px; font-weight:600; background:transparent;')
        else:
            self._sin_nube = False
            self._filas = hf.combinar(nube, locales)
            self.lbl_subtitulo.setStyleSheet(
                f'color:{_T["text_muted"]}; font-size:12px; background:transparent;')
            self.lbl_subtitulo.setText(
                'Las facturas de todas las cajas, separadas por emisor. '
                f'Actualizado a las {now_ar():%H:%M}.')
        self._aplicar_filtro()

    # ── Filtrar y dibujar ──────────────────────────────────────────────────
    def _perfil_filtro(self):
        pid = self.perfil_combo.currentData() if hasattr(self, 'perfil_combo') else None
        if pid is None:
            return None
        return next((p for p in self._perfiles if p.get('id') == pid), None)

    def _aplicar_filtro(self, *_):
        if not hasattr(self, 'h_table'):
            return
        perfil = self._perfil_filtro()
        desde, hasta = self._rango()
        if desde > hasta:
            desde, hasta = hasta, desde
        self._visibles = hf.filtrar(self._filas, self._perfiles, perfil=perfil,
                                    desde=desde, hasta=hasta,
                                    texto=self.f_buscar.text())
        self.h_table.setColumnHidden(self._COL_EMISOR, perfil is not None)
        self._dibujar_tabla()
        self._dibujar_totales(perfil)

    def _dibujar_tabla(self):
        t = self.h_table
        t.setUpdatesEnabled(False)
        t.clearSelection()
        t.setRowCount(len(self._visibles))
        rojo, verde = QColor(_T['danger']), QColor(_T['success'])
        for i, f in enumerate(self._visibles):
            es_nc = hf.es_nota_de_credito(f['tipo'])
            letra = (f['tipo'].split()[-1] if f['tipo'] else '').upper()
            prefijo = f'NC {letra}' if es_nc else f'Fac. {letra}'
            comp = QTableWidgetItem(f"{prefijo}  {f['pv']:05d}-{f['nro']:08d}")
            comp.setData(Qt.UserRole, i)
            comp.setFont(QFont('Consolas', 9))
            if es_nc:
                comp.setForeground(rojo)
            t.setItem(i, 0, comp)

            t.setItem(i, 1, QTableWidgetItem(
                f['fecha'].strftime('%d/%m/%Y %H:%M') if f['fecha'] else '—'))
            t.setItem(i, 2, QTableWidgetItem(hf.nombre_de_emisor(f, self._perfiles)))
            cli = QTableWidgetItem(f['cliente'])
            cli.setToolTip(f['cliente'])
            t.setItem(i, 3, cli)
            t.setItem(i, 4, QTableWidgetItem(hf.formatear_documento(f['doc_receptor']) or '—'))
            t.setItem(i, 5, QTableWidgetItem(f['pago'] or '—'))

            if f['solo_local'] and not self._sin_nube:
                origen = QTableWidgetItem('Sin subir')
                origen.setForeground(QColor(_T['warning']))
                origen.setToolTip('Está solo en esta PC: no llegó a la nube al facturar.')
            elif es_nc:
                origen = QTableWidgetItem('Nota de crédito')
                origen.setForeground(rojo)
            elif f['es_varios_2']:
                origen = QTableWidgetItem('Varios 2')
                origen.setForeground(QColor('#a3441a'))
                origen.setFont(QFont('Segoe UI', 9, QFont.Bold))
            else:
                origen = QTableWidgetItem('Venta')
            t.setItem(i, 6, origen)

            imp = hf.importe_con_signo(f)
            tot = QTableWidgetItem(_pesos(imp))
            tot.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            tot.setFont(QFont('Segoe UI', 9, QFont.Bold))
            if imp < 0:
                tot.setForeground(rojo)
            t.setItem(i, 7, tot)

            cae = QTableWidgetItem(f['cae'] or 'Sin CAE')
            cae.setFont(QFont('Consolas', 9) if f['cae'] else QFont('Segoe UI', 9, QFont.Bold))
            cae.setForeground(verde if f['cae'] else rojo)
            t.setItem(i, 8, cae)
        t.setUpdatesEnabled(True)

        if self._visibles:
            self._tabla_stack.setCurrentIndex(0)
        else:
            self._tabla_stack.setCurrentIndex(1)
            if self.f_buscar.text().strip():
                self.lbl_vacio.setText('Ninguna factura coincide con la búsqueda')
                self.lbl_vacio_sub.setText('Probá con otro nombre, CUIT o número.')
            elif self._filas or self._cargado_alguna_vez:
                self.lbl_vacio.setText('No hay facturas en este período')
                self.lbl_vacio_sub.setText('Cambiá las fechas o el emisor.')
        self._limpiar_detalle()

    def _dibujar_totales(self, perfil):
        tt = hf.totales(self._visibles)

        def _cant(n, uno, varios):
            return f'{n} {uno if n == 1 else varios}'

        self.t_total_value.setText(_pesos(tt['total']))
        sub = _cant(tt['cant'], 'comprobante', 'comprobantes')
        if tt['cant_notas_credito']:
            sub += f" · {_cant(tt['cant_notas_credito'], 'nota de crédito', 'notas de crédito')}"
        if tt['sin_cae']:
            sub += f" · <span style='color:{_T['danger']};'>{tt['sin_cae']} sin CAE</span>"
        self.t_total_sub.setText(sub)
        self.t_v2_value.setText(_pesos(tt['varios_2']))
        self.t_v2_sub.setText(_cant(tt['cant_varios_2'], 'factura del día', 'facturas del día'))
        self.t_reg_value.setText(_pesos(tt['clientes']))
        self.t_reg_sub.setText(_cant(tt['cant_clientes'], 'factura', 'facturas'))
        self.t_transf_value.setText(_pesos(tt['clientes_transferencia']))
        self.t_transf_sub.setText(_cant(tt['cant_clientes_transferencia'], 'factura', 'facturas'))

        partes = []
        if perfil is None:
            for nombre, total, cant in hf.por_emisor(self._visibles, self._perfiles):
                partes.append(
                    f"<b style='color:{_T['text']};'>{_html(nombre)}</b> "
                    f"{_pesos(total)} <span style='color:{_T['text_dim']};'>"
                    f"({_cant(cant, 'comprobante', 'comprobantes')})</span>")
        estado = []
        # Sin conexión ya lo dice el subtítulo de arriba.
        if not self._sin_nube:
            sin_subir = sum(1 for f in self._visibles if f['solo_local'])
            if sin_subir:
                estado.append(f"<span style='color:{_T['warning']};'>"
                              f"{_cant(sin_subir, 'factura', 'facturas')} de esta PC sin subir a la nube.</span>")
        texto = '&nbsp;&nbsp;&nbsp;·&nbsp;&nbsp;&nbsp;'.join(partes)
        if estado:
            texto = (texto + '&nbsp;&nbsp;&nbsp;&nbsp;' if texto else '') + ' '.join(estado)
        self.lbl_por_emisor.setText(texto)
        self.lbl_por_emisor.setVisible(bool(texto))

    # ── Detalle ────────────────────────────────────────────────────────────
    def _fila_seleccionada(self):
        row = self.h_table.currentRow()
        if row < 0 or not self.h_table.selectionModel().hasSelection():
            return None
        item = self.h_table.item(row, 0)
        if item is None:
            return None
        idx = item.data(Qt.UserRole)
        if idx is None or idx >= len(self._visibles):
            return None
        return self._visibles[idx]

    def _limpiar_detalle(self):
        if not hasattr(self, '_detalle_vals'):
            return
        self.lbl_detalle_titulo.setText('Detalle de la factura')
        for clave, val in self._detalle_vals.items():
            val.setText('Elegí una factura de la lista.' if clave == 'emisor' else '—')
        self.items_table.setRowCount(0)
        self.btn_pdf.setEnabled(False)
        self.btn_nc.setEnabled(False)

    def _mostrar_detalle(self):
        f = self._fila_seleccionada()
        if f is None:
            self._limpiar_detalle()
            return
        es_nc = hf.es_nota_de_credito(f['tipo'])
        letra = (f['tipo'].split()[-1] if f['tipo'] else '').upper()
        nombre_tipo = f'Nota de crédito {letra}' if es_nc else f'Factura {letra}'
        numero = f"{f['pv']:05d}-{f['nro']:08d}"
        self.lbl_detalle_titulo.setText(f'{nombre_tipo}  {numero}')

        perfil = hf.perfil_de(f, self._perfiles)
        emisor = hf.nombre_de_emisor(f, self._perfiles)
        cuit_em = f['cuit_emisor'] or (hf.solo_digitos(perfil.get('cuit')) if perfil else '')
        self._detalle_vals['emisor'].setText(
            f"{emisor}  ·  CUIT {hf.formatear_documento(cuit_em)}" if cuit_em else emisor)
        self._detalle_vals['comprobante'].setText(f"{nombre_tipo}  ·  PV {f['pv']}  ·  N.º {f['nro']}")
        self._detalle_vals['fecha'].setText(
            f['fecha'].strftime('%d/%m/%Y  %H:%M') if f['fecha'] else '—')
        self._detalle_vals['cliente'].setText(f['cliente'])
        doc = hf.formatear_documento(f['doc_receptor'])
        if doc:
            tipo_doc = 'CUIT' if len(f['doc_receptor']) == 11 else 'DNI'
            doc_txt = f'{tipo_doc} {doc}'
        else:
            doc_txt = 'Sin identificar'
        if f['cond_iva_receptor']:
            doc_txt += f"  ·  {f['cond_iva_receptor']}"
        self._detalle_vals['documento'].setText(doc_txt)
        self._detalle_vals['pago'].setText(f['pago'] or '—')
        if f['cae']:
            vto = f['vto_cae']
            if len(vto) == 8 and vto.isdigit():
                vto = f'{vto[6:]}/{vto[4:6]}/{vto[:4]}'
            self._detalle_vals['cae'].setText(f"{f['cae']}  ·  vence {vto}" if vto else f['cae'])
        else:
            self._detalle_vals['cae'].setText('Sin CAE: ARCA no la autorizó')
        venta = []
        if f['es_varios_2']:
            venta.append('Factura Varios 2 del día')
        elif f['turno'] and f['turno'].strip('0'):
            venta.append(f"Venta N.º {f['turno'].lstrip('0')}")
        if f['solo_local'] and not self._sin_nube:
            venta.append('solo en esta PC')
        if f['notas']:
            venta.append(f['notas'])
        self._detalle_vals['venta'].setText('  ·  '.join(venta) or '—')

        items = f['items']
        self.items_table.setRowCount(len(items))
        for i, it in enumerate(items):
            desc = str(it.get('descripcion') or it.get('nombre') or '')
            cant = float(it.get('cantidad') or 0)
            precio = float(it.get('precio') or it.get('precio_unitario') or 0)
            importe = float(it.get('importe') or it.get('subtotal') or cant * precio)
            d_item = QTableWidgetItem(desc)
            d_item.setToolTip(desc)
            self.items_table.setItem(i, 0, d_item)
            c_item = QTableWidgetItem(f'{cant:g}'.replace('.', ','))
            c_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            self.items_table.setItem(i, 1, c_item)
            p_item = QTableWidgetItem(_pesos(precio))
            p_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            self.items_table.setItem(i, 2, p_item)
            m_item = QTableWidgetItem(_pesos(importe))
            m_item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
            self.items_table.setItem(i, 3, m_item)
        if not items:
            self.items_table.setRowCount(1)
            vacio = QTableWidgetItem('El detalle de productos está en el PDF.'
                                     if f['solo_local'] else 'Sin renglones guardados.')
            vacio.setForeground(QColor(_T['text_dim']))
            self.items_table.setItem(0, 0, vacio)

        for val in self._detalle_vals.values():
            val.setToolTip(val.text())
        self.btn_pdf.setEnabled(bool(f['pdf_path'] or f['documento']))
        self.btn_nc.setEnabled(bool(f['cae']) and not es_nc)

    # ── Acciones ───────────────────────────────────────────────────────────
    def _on_nota_credito(self):
        """Nota de crédito sobre la factura marcada, con el emisor de esa factura."""
        f = self._fila_seleccionada()
        if f is None:
            QMessageBox.information(self, 'Sin selección',
                'Elegí una factura de la lista para hacerle la Nota de Crédito.')
            return
        if hf.es_nota_de_credito(f['tipo']):
            QMessageBox.warning(self, 'No permitido',
                'No se puede hacer una Nota de Crédito sobre otra Nota de Crédito.')
            return
        if not f['cae']:
            QMessageBox.warning(self, 'Factura sin CAE',
                'Solo se pueden hacer Notas de Crédito sobre facturas autorizadas por ARCA.')
            return
        # Antes salía con el perfil elegido arriba: con José elegido, una NC sobre
        # una factura de Agustín iba con el CUIT y el punto de venta equivocados.
        p = hf.perfil_de(f, self._perfiles)
        perfil = self._perfil_completo(p.get('id')) if p else {}
        if not perfil:
            QMessageBox.warning(self, 'Emisor no encontrado',
                'No encontré el perfil ARCA que emitió esta factura '
                f"(punto de venta {f['pv']}"
                + (f", CUIT {hf.formatear_documento(f['cuit_emisor'])}" if f['cuit_emisor'] else '')
                + ').\nRevisá que el perfil esté activo en esta PC.')
            return
        from pos_system.ui.nota_credito_dialog import NotaCreditoDialog
        dlg = NotaCreditoDialog(hf.factura_para_nota_de_credito(f), self, perfil=perfil)
        if dlg.exec_() == dlg.Accepted:
            self._cargar()
            pdf = getattr(dlg, 'pdf_path', '')
            if pdf:
                resp = QMessageBox.question(
                    self, 'NC generada',
                    '¿Abrir el PDF de la Nota de Crédito?',
                    QMessageBox.Yes | QMessageBox.No, QMessageBox.Yes
                )
                if resp == QMessageBox.Yes:
                    try:
                        self._abrir_pdf(pdf)
                    except Exception:
                        pass

    def _reprint_selected(self):
        import os
        f = self._fila_seleccionada()
        if f is None:
            QMessageBox.information(self, 'Sin selección', 'Elegí una factura de la lista.')
            return
        if f['pdf_path'] and os.path.exists(f['pdf_path']):
            self._abrir_pdf(f['pdf_path'])
            return
        if not f['documento']:
            QMessageBox.warning(self, 'Sin PDF',
                'Esta factura no tiene PDF guardado en esta PC.')
            return
        # Hecha en otra caja (o el PDF se borró): se arma de nuevo con los
        # mismos datos que se usaron al emitirla.
        try:
            from pos_system.utils.pdf_generator import PDFGenerator
            ruta = PDFGenerator().generate_factura_afip_a4(dict(f['documento']))
        except Exception as e:
            logger.exception('Fiscal: no se pudo armar el PDF de la factura')
            QMessageBox.critical(self, 'Error', f'No se pudo armar el PDF:\n{e}')
            return
        f['pdf_path'] = ruta
        self._abrir_pdf(ruta)

    # ── TAB 3: Configuración AFIP ─────────────────────────────────────────────
    def _build_config_tab(self):
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        info = QLabel(
            'Configurá los datos del emisor (tu negocio) para que aparezcan en todas las facturas.\n'
            'Estos datos se guardan en la base de datos y se usan automáticamente al emitir facturas.'
        )
        info.setWordWrap(True)
        info.setStyleSheet(
            'background:#fbeee5; border:1px solid #ffecb5; border-radius:6px;'
            'padding:8px 12px; color:#664d03; font-size:11px;'
        )
        layout.addWidget(info)

        group = QGroupBox('Datos del Emisor (Tu Negocio)')
        group.setFont(QFont('Segoe UI', 10, QFont.Bold))
        form = QFormLayout(group)
        form.setSpacing(10)

        fields = [
            ('CUIT:',              'cuit',             'Ej: 20123456789'),
            ('Razón Social:',      'razon_social',     'Nombre legal del negocio'),
            ('Domicilio:',         'domicilio',        'Ej: Av. Colón 123'),
            ('Localidad:',         'localidad',        'Ej: CÓRDOBA (5000) - CÓRDOBA'),
            ('Teléfono:',          'telefono',         'Ej: 3517046684'),
            ('Email:',             'email',            'Ej: libreria.liceo@hotmail.com'),
            ('Ing. Brutos:',       'ing_brutos',       'Número de Ingresos Brutos'),
            ('Inicio de Act.:',    'inicio_actividades','Ej: 01/01/2020'),
            ('Condición IVA:',     'condicion_iva',    'Ej: Responsable Inscripto'),
            ('Punto de Venta:',    'punto_venta',      'Número de punto de venta AFIP'),
            ('Cert. AFIP (.crt):', 'cert_path',        'Ruta completa al certificado digital AFIP'),
            ('Clave Priv. (.key):','key_path',         'Ruta completa a la clave privada AFIP'),
        ]

        self.cfg_fields = {}
        for label, key, placeholder in fields:
            inp = QLineEdit()
            inp.setFont(QFont('Segoe UI', 10))
            inp.setPlaceholderText(placeholder)
            form.addRow(label, inp)
            self.cfg_fields[key] = inp

        # Entorno AFIP
        from PyQt5.QtWidgets import QCheckBox
        self.cfg_produccion_check = QCheckBox('Usar entorno PRODUCCIÓN (desactivado = Homologación/Prueba)')
        self.cfg_produccion_check.setFont(QFont('Segoe UI', 10))
        self.cfg_produccion_check.setStyleSheet('color: #a01616; font-weight: bold;')
        form.addRow('Entorno AFIP:', self.cfg_produccion_check)

        layout.addWidget(group)

        info2 = QLabel(
            'Para obtener CAE automatico:\n'
            '1. Obtené tu certificado digital en AFIP (Mis Aplicaciones Web → Administración de Certificados)\n'
            '2. Generá tu clave privada: openssl genrsa -out clave.key 2048\n'
            '3. Generá el CSR: openssl req -new -key clave.key -out solicitud.csr\n'
            '4. Cargá el CSR en AFIP y descargá el .crt\n'
            '5. Cargá las rutas del .crt y .key en los campos de arriba\n'
            '6. Instalar dependencias: pip install zeep pyOpenSSL'
        )
        info2.setWordWrap(True)
        info2.setStyleSheet(
            'background:#e7f4ec; border:1px solid #a3cfbb; border-radius:6px;'
            'padding:10px 12px; color:#0a3622; font-size:10px;'
        )
        layout.addWidget(info2)

        save_btn = QPushButton('Guardar Configuración AFIP')
        save_btn.setMinimumHeight(44)
        save_btn.setFont(QFont('Segoe UI', 11, QFont.Bold))
        save_btn.setStyleSheet('''
            QPushButton {
                background: #3d7a3a; color: white;
                border: none; border-radius: 8px;
            }
            QPushButton:hover { background: #2f5e2c; }
        ''')
        save_btn.clicked.connect(self._save_config)
        layout.addWidget(save_btn)

        # Botón de diagnóstico de permisos NC
        test_nc_btn = QPushButton('Probar permisos para Nota de Crédito')
        test_nc_btn.setMinimumHeight(38)
        test_nc_btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
        test_nc_btn.setToolTip(
            'Consulta a AFIP si tu CUIT y punto de venta están habilitados\n'
            'para emitir Notas de Crédito A/B/C. No emite ningún comprobante.'
        )
        test_nc_btn.setStyleSheet('''
            QPushButton {
                background: #fff; color: #a01616;
                border: 2px solid #a01616; border-radius: 8px;
            }
            QPushButton:hover { background: #fff5f5; }
        ''')
        test_nc_btn.clicked.connect(self._test_permisos_nc)
        layout.addWidget(test_nc_btn)
        layout.addStretch()

        self._load_config_fields()
        return widget

    def _cargar_perfiles_combo(self):
        """Llena el selector de emisor con los perfiles ARCA activos.

        Conserva lo elegido: los perfiles se vuelven a leer en cada recarga
        (pueden cambiar desde el panel) y no tiene que saltar a "Todos".
        """
        from pos_system.database.db_manager import DatabaseManager
        try:
            rows = DatabaseManager().execute_query(
                "SELECT id, nombre, razon_social, cuit, punto_venta FROM perfiles_facturacion "
                "WHERE activo=1"
            ) or []
        except Exception:
            rows = []
        self._perfiles = [dict(r, id=int(r['id'])) for r in rows]
        self._perfiles.sort(key=hf.nombre_de_perfil)

        elegido = self.perfil_combo.currentData()
        self.perfil_combo.blockSignals(True)
        self.perfil_combo.clear()
        self.perfil_combo.addItem('Todos los emisores', None)
        for p in self._perfiles:
            cuit = hf.formatear_documento(p.get('cuit')) or 'sin CUIT'
            pv = int(p.get('punto_venta') or 1)
            self.perfil_combo.addItem(f"{hf.nombre_de_perfil(p)}  ·  PV {pv}", p['id'])
            self.perfil_combo.setItemData(
                self.perfil_combo.count() - 1, f'CUIT {cuit} · punto de venta {pv}', Qt.ToolTipRole)
        idx = self.perfil_combo.findData(elegido) if elegido is not None else 0
        self.perfil_combo.setCurrentIndex(max(idx, 0))
        self.perfil_combo.blockSignals(False)

    def _perfil_completo(self, pid) -> dict:
        """La fila entera del perfil (con certificado y clave), o {}."""
        if not pid:
            return {}
        from pos_system.database.db_manager import DatabaseManager
        try:
            rows = DatabaseManager().execute_query(
                "SELECT * FROM perfiles_facturacion WHERE id=? AND activo=1 LIMIT 1",
                (int(pid),)
            ) or []
            return rows[0] if rows else {}
        except Exception:
            return {}

    def _get_perfil_seleccionado(self) -> dict:
        """El emisor elegido arriba; con "Todos", el de la factura marcada."""
        if not hasattr(self, 'perfil_combo') or self.perfil_combo is None:
            return {}
        pid = self.perfil_combo.currentData()
        if pid is None:
            f = self._fila_seleccionada()
            p = hf.perfil_de(f, self._perfiles) if f else None
            pid = p.get('id') if p else None
        return self._perfil_completo(pid)

    def _test_permisos_nc(self):
        """Llama a AFIP para verificar si el perfil seleccionado puede emitir NC."""
        from PyQt5.QtWidgets import QApplication
        perfil = self._get_perfil_seleccionado()
        if not perfil:
            QMessageBox.warning(
                self, 'Elegí un emisor',
                'Elegí un emisor arriba, o marcá una factura de la lista,\n'
                'para saber con qué perfil ARCA hacer la prueba.'
            )
            return

        cuit       = (perfil.get('cuit') or '').strip()
        cert_path  = (perfil.get('cert_path') or '').strip()
        key_path   = (perfil.get('key_path') or '').strip()
        produccion = bool(perfil.get('produccion'))
        try:
            pv = int(perfil.get('punto_venta') or 1)
        except (ValueError, TypeError):
            pv = 1

        if not cuit or not cert_path or not key_path:
            QMessageBox.warning(
                self, 'Perfil incompleto',
                f'El perfil "{perfil.get("nombre", "?")}" no tiene CUIT, certificado o clave.\n'
                'Editalo desde la pestaña "Perfiles ARCA".'
            )
            return

        try:
            from pos_system.utils.afip_wsfe import AfipWsfe
            afip = AfipWsfe(cuit=cuit, cert_path=cert_path, key_path=key_path,
                            produccion=produccion)
        except ImportError as e:
            QMessageBox.critical(self, 'Dependencia faltante', str(e))
            return
        except Exception as e:
            QMessageBox.critical(self, 'Error AFIP', f'No se pudo iniciar el cliente AFIP:\n{e}')
            return

        QApplication.setOverrideCursor(Qt.WaitCursor)
        try:
            r = afip.diagnosticar_permisos_nc(pv)
        except Exception as e:
            QApplication.restoreOverrideCursor()
            QMessageBox.critical(self, 'Error', f'Error consultando a AFIP:\n{e}')
            return
        QApplication.restoreOverrideCursor()

        # Construir reporte legible
        env = 'PRODUCCIÓN' if produccion else 'HOMOLOGACIÓN'
        lines = [
            f'<b>Entorno:</b> {env}',
            f'<b>CUIT emisor:</b> {cuit}',
            f'<b>Punto de venta a usar:</b> {pv}',
            '',
            f'• Autenticación WSAA: {"✅ OK" if r["auth_ok"] else "❌ FALLO"}',
            f'• PV {pv}: {"✅" if r["pv_ok"] else "❌"} {r["pv_msg"]}',
        ]
        # Mostrar TODOS los PVs que AFIP reporta para que veas el raw data
        pvs_raw = r.get('pvs_raw') or []
        if pvs_raw:
            lines.append('')
            lines.append('<b>PVs que AFIP devuelve para este CUIT:</b>')
            for p in pvs_raw:
                bloq = (p.get('Bloqueado') or 'N').strip().upper()
                fbaja = (p.get('FchBaja') or '').strip() or '—'
                tipo = p.get('EmisionTipo') or '?'
                marker = '✅' if (bloq != 'S' and fbaja in ('—', '', 'NULL')) else '⚠️'
                lines.append(f'&nbsp;&nbsp;{marker} N° {p.get("Nro")} · '
                             f'tipo: {tipo} · bloqueado: {bloq} · fch_baja: {fbaja}')
        if r['error']:
            lines.append('')
            lines.append(f'<span style="color:#a01616;"><b>Error:</b> {r["error"]}</span>')

        lines.append('')
        for letra in ('a', 'b', 'c'):
            nc = r.get(f'nc_{letra}', {})
            ok = '✅' if nc.get('permitido') else '❌'
            cod = nc.get('codigo', '?')
            msg = nc.get('msg', '')
            lines.append(f'• NC {letra.upper()} (cód. {cod:02d}): {ok} {msg}')

        lines.append('')
        if r['puede_emitir_nc']:
            lines.append('<b style="color:#3d7a3a;">✅ El emisor PUEDE emitir Notas de Crédito.</b>')
        else:
            lines.append('<b style="color:#a01616;">❌ El emisor NO puede emitir NC en este PV.</b>')
            lines.append('<i>Si los PVs aparecen arriba como ✅, pero el test marca ❌, '
                         'puede ser que estés en HOMOLOGACIÓN y no tengas los PVs '
                         'registrados en ese entorno (son distintos a producción).</i>')

        mb = QMessageBox(self)
        mb.setWindowTitle('Permisos AFIP — Nota de Crédito')
        mb.setIcon(QMessageBox.Information if r['puede_emitir_nc'] else QMessageBox.Warning)
        mb.setTextFormat(Qt.RichText)
        mb.setText('<br>'.join(lines))
        mb.exec_()

    def _load_config_fields(self):
        """Carga los valores actuales de config en los campos."""
        try:
            from pos_system.database.db_manager import DatabaseManager
            db = DatabaseManager()
            field_map = {
                'afip_cuit': 'cuit', 'afip_razon_social': 'razon_social',
                'afip_domicilio': 'domicilio', 'afip_localidad': 'localidad',
                'afip_telefono': 'telefono', 'afip_email': 'email',
                'afip_ing_brutos': 'ing_brutos',
                'afip_inicio_actividades': 'inicio_actividades',
                'afip_condicion_iva': 'condicion_iva', 'afip_punto_venta': 'punto_venta',
                'afip_cert_path': 'cert_path', 'afip_key_path': 'key_path',
            }
            for db_key, field_key in field_map.items():
                res = db.execute_query("SELECT value FROM config WHERE key=?", (db_key,))
                if res and res[0]['value'] and field_key in self.cfg_fields:
                    self.cfg_fields[field_key].setText(res[0]['value'])
            # Entorno
            res = db.execute_query("SELECT value FROM config WHERE key='afip_produccion'")
            if res and res[0]['value']:
                self.cfg_produccion_check.setChecked(res[0]['value'] == '1')
        except Exception:
            pass

    def _save_config(self):
        """Guarda los datos del emisor en la tabla config."""
        try:
            from pos_system.database.db_manager import DatabaseManager
            db = DatabaseManager()
            field_map = {
                'cuit': 'afip_cuit', 'razon_social': 'afip_razon_social',
                'domicilio': 'afip_domicilio', 'localidad': 'afip_localidad',
                'telefono': 'afip_telefono', 'email': 'afip_email',
                'ing_brutos': 'afip_ing_brutos',
                'inicio_actividades': 'afip_inicio_actividades',
                'condicion_iva': 'afip_condicion_iva', 'punto_venta': 'afip_punto_venta',
                'cert_path': 'afip_cert_path', 'key_path': 'afip_key_path',
            }
            for field_key, db_key in field_map.items():
                value = self.cfg_fields[field_key].text().strip()
                db.execute_update(
                    "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)",
                    (db_key, value, now_ar().isoformat())
                )
            # Guardar entorno
            prod_val = '1' if self.cfg_produccion_check.isChecked() else '0'
            db.execute_update(
                "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)",
                ('afip_produccion', prod_val, now_ar().isoformat())
            )
            QMessageBox.information(self, 'Guardado', 'Configuración AFIP guardada correctamente.')
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'Error al guardar:\n{str(e)}')

    # ── Refresh ───────────────────────────────────────────────────────────────
    def refresh_data(self):
        """La llama la ventana después de cada venta, cierre o sync.

        Leer la nube en cada venta sería gastar consultas en una pestaña que
        nadie está mirando: si no está a la vista, solo queda anotado y se
        recarga al abrirla.
        """
        self._cargar_perfiles_combo()
        self._load_config_fields()
        if self.isVisible():
            self._cargar()
        else:
            self._pendiente = True

    def showEvent(self, event):
        super().showEvent(event)
        if getattr(self, '_pendiente', False):
            self._cargar()

    def _load_historial(self):
        self._cargar()

    def _on_tab_changed(self, index):
        if index == 1:
            self._load_historial()
        elif index == 2:
            self._load_config_fields()
        elif index == 3:
            self._load_perfiles()

    # ── TAB 4: Perfiles ARCA ─────────────────────────────────────────────────
    def _build_perfiles_tab(self):
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(10)

        info = QLabel(
            'Cada perfil es un emisor (dueno/socio) con su propio CUIT y cuenta ARCA.\n'
            'Al cobrar una venta, el cajero elige en que perfil facturar para equilibrar ventas.'
        )
        info.setWordWrap(True)
        info.setStyleSheet(
            'background:#fbeee5; border:1px solid #dcd6c8; border-radius:6px;'
            'padding:8px 12px; color:#7a3514; font-size:11px;'
        )
        layout.addWidget(info)

        # ── Formulario ────────────────────────────────────────────────────────
        form_group = QGroupBox('Nuevo perfil / Editar')
        form_group.setFont(QFont('Segoe UI', 10, QFont.Bold))
        form = QFormLayout(form_group)
        form.setSpacing(8)

        self.p_nombre_input = QLineEdit()
        self.p_nombre_input.setPlaceholderText('Ej: Maria / Juan')
        self.p_nombre_input.setFont(QFont('Segoe UI', 10))
        form.addRow('Nombre (para el boton):', self.p_nombre_input)

        self.p_razon_input = QLineEdit()
        self.p_razon_input.setPlaceholderText('Nombre completo para la factura')
        self.p_razon_input.setFont(QFont('Segoe UI', 10))
        form.addRow('Razon Social:', self.p_razon_input)

        self.p_cuit_input = QLineEdit()
        self.p_cuit_input.setPlaceholderText('Ej: 20123456789')
        self.p_cuit_input.setFont(QFont('Segoe UI', 10))
        form.addRow('CUIT:', self.p_cuit_input)

        self.p_domicilio_input = QLineEdit()
        self.p_domicilio_input.setPlaceholderText('Domicilio fiscal')
        self.p_domicilio_input.setFont(QFont('Segoe UI', 10))
        form.addRow('Domicilio:', self.p_domicilio_input)

        self.p_localidad_input = QLineEdit()
        self.p_localidad_input.setFont(QFont('Segoe UI', 10))
        form.addRow('Localidad:', self.p_localidad_input)

        self.p_telefono_input = QLineEdit()
        self.p_telefono_input.setPlaceholderText('Ej: 3511234567')
        self.p_telefono_input.setFont(QFont('Segoe UI', 10))
        form.addRow('Telefono:', self.p_telefono_input)

        self.p_ing_brutos_input = QLineEdit()
        self.p_ing_brutos_input.setPlaceholderText('Numero Ing. Brutos')
        self.p_ing_brutos_input.setFont(QFont('Segoe UI', 10))
        form.addRow('Ing. Brutos:', self.p_ing_brutos_input)

        self.p_inicio_act_input = QLineEdit()
        self.p_inicio_act_input.setPlaceholderText('Ej: 01/01/2020')
        self.p_inicio_act_input.setFont(QFont('Segoe UI', 10))
        form.addRow('Inicio de Act.:', self.p_inicio_act_input)

        self.p_cond_combo = QComboBox()
        self.p_cond_combo.setFont(QFont('Segoe UI', 10))
        self.p_cond_combo.addItems(['Monotributista', 'Responsable Inscripto', 'Exento'])
        form.addRow('Condicion IVA:', self.p_cond_combo)

        self.p_pv_input = QLineEdit('1')
        self.p_pv_input.setPlaceholderText('Ej: 1')
        self.p_pv_input.setFont(QFont('Segoe UI', 10))
        form.addRow('Punto de Venta:', self.p_pv_input)

        self.p_cert_input = QLineEdit()
        self.p_cert_input.setPlaceholderText('Ruta al archivo .crt de AFIP')
        self.p_cert_input.setFont(QFont('Segoe UI', 10))
        form.addRow('Certificado (.crt):', self.p_cert_input)

        self.p_key_input = QLineEdit()
        self.p_key_input.setPlaceholderText('Ruta al archivo .key de AFIP')
        self.p_key_input.setFont(QFont('Segoe UI', 10))
        form.addRow('Clave privada (.key):', self.p_key_input)

        self.p_prod_combo = QComboBox()
        self.p_prod_combo.setFont(QFont('Segoe UI', 10))
        self.p_prod_combo.addItems(['Produccion (real)', 'Homologacion (prueba)'])
        form.addRow('Entorno AFIP:', self.p_prod_combo)

        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)

        self.p_guardar_btn = QPushButton('Guardar perfil')
        self.p_guardar_btn.setMinimumHeight(38)
        self.p_guardar_btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
        self.p_guardar_btn.setStyleSheet('''
            QPushButton { background:#c1521f; color:white; border:none; border-radius:6px; }
            QPushButton:hover { background:#a3441a; }
        ''')
        self.p_guardar_btn.clicked.connect(self._guardar_perfil)
        btn_row.addWidget(self.p_guardar_btn)

        self.p_limpiar_btn = QPushButton('Limpiar')
        self.p_limpiar_btn.setMinimumHeight(38)
        self.p_limpiar_btn.setFont(QFont('Segoe UI', 10))
        self.p_limpiar_btn.setStyleSheet('''
            QPushButton { background:#6f6a5d; color:white; border:none; border-radius:6px; }
            QPushButton:hover { background:#5c636a; }
        ''')
        self.p_limpiar_btn.clicked.connect(self._limpiar_form_perfil)
        btn_row.addWidget(self.p_limpiar_btn)

        form.addRow(btn_row)
        layout.addWidget(form_group)

        # ── Tabla ─────────────────────────────────────────────────────────────
        lbl_tabla = QLabel('Perfiles cargados:')
        lbl_tabla.setFont(QFont('Segoe UI', 10, QFont.Bold))
        layout.addWidget(lbl_tabla)

        self.p_table = QTableWidget()
        self.p_table.setColumnCount(6)
        self.p_table.setHorizontalHeaderLabels([
            'ID', 'Nombre', 'CUIT', 'Condicion IVA', 'Entorno', 'Acciones'
        ])
        self.p_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)
        self.p_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeToContents)
        self.p_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeToContents)
        self.p_table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeToContents)
        self.p_table.setColumnHidden(0, True)
        self.p_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.p_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.p_table.setAlternatingRowColors(True)
        self.p_table.setFont(QFont('Segoe UI', 9))
        self.p_table.verticalHeader().setDefaultSectionSize(36)
        layout.addWidget(self.p_table)

        self._perfil_editando_id = None
        return widget

    def _load_perfiles(self):
        try:
            from pos_system.database.db_manager import DatabaseManager
            db = DatabaseManager()
            rows = db.execute_query(
                "SELECT * FROM perfiles_facturacion WHERE activo=1 ORDER BY nombre ASC"
            )
            self.p_table.setRowCount(len(rows))
            for i, r in enumerate(rows):
                entorno = 'Produccion' if r.get('produccion') else 'Homologacion'
                cert_ok = 'OK' if r.get('cert_path') else '—'

                self.p_table.setItem(i, 0, QTableWidgetItem(str(r['id'])))
                self.p_table.setItem(i, 1, QTableWidgetItem(r.get('nombre', '')))
                self.p_table.setItem(i, 2, QTableWidgetItem(r.get('cuit', '')))
                self.p_table.setItem(i, 3, QTableWidgetItem(r.get('condicion_iva', '')))
                entorno_item = QTableWidgetItem(f'{entorno}  cert:{cert_ok}')
                entorno_item.setForeground(
                    QColor('#3d7a3a') if r.get('produccion') else QColor('#b07020')
                )
                self.p_table.setItem(i, 4, entorno_item)

                acciones_widget = QWidget()
                acc_layout = QHBoxLayout(acciones_widget)
                acc_layout.setContentsMargins(4, 2, 4, 2)
                acc_layout.setSpacing(6)

                edit_btn = QPushButton('Editar')
                edit_btn.setFixedHeight(28)
                edit_btn.setStyleSheet('QPushButton{background:#c1521f;color:white;border:none;border-radius:4px;font-size:11px;} QPushButton:hover{background:#a3441a;}')
                edit_btn.clicked.connect(lambda _, row=r: self._editar_perfil(row))
                acc_layout.addWidget(edit_btn)

                del_btn = QPushButton('Eliminar')
                del_btn.setFixedHeight(28)
                del_btn.setStyleSheet('QPushButton{background:#a01616;color:white;border:none;border-radius:4px;font-size:11px;} QPushButton:hover{background:#7f1212;}')
                del_btn.clicked.connect(lambda _, rid=r['id']: self._eliminar_perfil(rid))
                acc_layout.addWidget(del_btn)

                self.p_table.setCellWidget(i, 5, acciones_widget)

        except Exception as e:
            QMessageBox.warning(self, 'Error', f'Error al cargar perfiles: {e}')

    def _guardar_perfil(self):
        nombre = self.p_nombre_input.text().strip()
        cuit = self.p_cuit_input.text().strip()
        if not nombre:
            QMessageBox.warning(self, 'Falta nombre', 'Ingresa el nombre del perfil.')
            return
        if not cuit:
            QMessageBox.warning(self, 'Falta CUIT', 'Ingresa el CUIT del emisor.')
            return

        from pos_system.database.db_manager import DatabaseManager
        db = DatabaseManager()
        produccion = 1 if self.p_prod_combo.currentIndex() == 0 else 0

        try:
            if self._perfil_editando_id:
                db.execute_update(
                    """UPDATE perfiles_facturacion SET
                       nombre=?, razon_social=?, cuit=?, domicilio=?, localidad=?,
                       telefono=?, ing_brutos=?, inicio_actividades=?,
                       condicion_iva=?, punto_venta=?, cert_path=?, key_path=?,
                       produccion=?, updated_at=(SELECT localtime_now())
                       WHERE id=?""",
                    (
                        nombre,
                        self.p_razon_input.text().strip() or nombre,
                        cuit,
                        self.p_domicilio_input.text().strip(),
                        self.p_localidad_input.text().strip(),
                        self.p_telefono_input.text().strip(),
                        self.p_ing_brutos_input.text().strip(),
                        self.p_inicio_act_input.text().strip(),
                        self.p_cond_combo.currentText(),
                        int(self.p_pv_input.text().strip() or 1),
                        self.p_cert_input.text().strip(),
                        self.p_key_input.text().strip(),
                        produccion,
                        self._perfil_editando_id,
                    )
                )
            else:
                db.execute_update(
                    """INSERT INTO perfiles_facturacion
                       (nombre, razon_social, cuit, domicilio, localidad,
                        telefono, ing_brutos, inicio_actividades,
                        condicion_iva, punto_venta, cert_path, key_path, produccion)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        nombre,
                        self.p_razon_input.text().strip() or nombre,
                        cuit,
            self.p_domicilio_input.text().strip(),
                        self.p_localidad_input.text().strip(),
                        self.p_telefono_input.text().strip(),
                        self.p_ing_brutos_input.text().strip(),
                        self.p_inicio_act_input.text().strip(),
                        self.p_cond_combo.currentText(),
                        int(self.p_pv_input.text().strip() or 1),
                        self.p_cert_input.text().strip(),
                        self.p_key_input.text().strip(),
                        produccion,
                    )
                )
            self._limpiar_form_perfil()
            self._load_perfiles()
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo guardar el perfil:\n{e}')

    def _editar_perfil(self, row: dict):
        self._perfil_editando_id = row['id']
        self.p_nombre_input.setText(row.get('nombre', ''))
        self.p_razon_input.setText(row.get('razon_social', ''))
        self.p_cuit_input.setText(row.get('cuit', ''))
        self.p_domicilio_input.setText(row.get('domicilio', ''))
        self.p_localidad_input.setText(row.get('localidad', ''))
        self.p_telefono_input.setText(row.get('telefono', ''))
        self.p_ing_brutos_input.setText(row.get('ing_brutos', ''))
        self.p_inicio_act_input.setText(row.get('inicio_actividades', ''))
        idx = self.p_cond_combo.findText(row.get('condicion_iva', 'Monotributista'))
        if idx >= 0:
            self.p_cond_combo.setCurrentIndex(idx)
        self.p_pv_input.setText(str(row.get('punto_venta', 1)))
        self.p_cert_input.setText(row.get('cert_path', ''))
        self.p_key_input.setText(row.get('key_path', ''))
        self.p_prod_combo.setCurrentIndex(0 if row.get('produccion') else 1)
        self.p_guardar_btn.setText('Actualizar perfil')

    def _eliminar_perfil(self, perfil_id: int):
        resp = QMessageBox.question(
            self, 'Confirmar', 'Eliminar este perfil?',
            QMessageBox.Yes | QMessageBox.No
        )
        if resp != QMessageBox.Yes:
            return
        try:
            from pos_system.database.db_manager import DatabaseManager
            db = DatabaseManager()
            db.execute_update(
                "UPDATE perfiles_facturacion SET activo=0 WHERE id=?", (perfil_id,)
            )
            self._load_perfiles()
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo eliminar el perfil:\n{e}')

    def _limpiar_form_perfil(self):
        self._perfil_editando_id = None
        self.p_nombre_input.clear()
        self.p_razon_input.clear()
        self.p_cuit_input.clear()
        self.p_domicilio_input.clear()
        self.p_localidad_input.clear()
        self.p_telefono_input.clear()
        self.p_ing_brutos_input.clear()
        self.p_inicio_act_input.clear()
        self.p_cond_combo.setCurrentIndex(0)
        self.p_pv_input.setText('1')
        self.p_cert_input.clear()
        self.p_key_input.clear()
        self.p_prod_combo.setCurrentIndex(0)
        self.p_guardar_btn.setText('Guardar perfil')
