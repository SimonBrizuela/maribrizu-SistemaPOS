"""
Vista Fiscal — Pestaña principal para gestión de facturas electrónicas AFIP.
Contiene dos sub-tabs: Emitir Factura (manual) e Historial de Facturas.
"""
from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTabWidget, QTableWidget,
    QTableWidgetItem, QLabel, QPushButton, QLineEdit, QFormLayout,
    QGroupBox, QComboBox, QHeaderView, QMessageBox, QFrame, QScrollArea
)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont, QColor
from datetime import datetime, timezone, timedelta
from pos_system.utils.firebase_sync import now_ar

_TZ_AR = timezone(timedelta(hours=-3))

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

        # Título
        title = QLabel('Facturación Electrónica AFIP')
        title.setFont(QFont('Segoe UI', 15, QFont.Bold))
        title.setStyleSheet('color: #c1521f;')
        layout.addWidget(title)

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
    def _build_historial_tab(self):
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(8)

        # Selector de perfil (toma los perfiles_facturacion ya cargados)
        perfil_row = QHBoxLayout()
        perfil_row.setSpacing(8)
        perfil_lbl = QLabel('Perfil ARCA:')
        perfil_lbl.setFont(QFont('Segoe UI', 10, QFont.Bold))
        perfil_row.addWidget(perfil_lbl)
        self.perfil_combo = QComboBox()
        self.perfil_combo.setFont(QFont('Segoe UI', 10))
        self.perfil_combo.setMinimumWidth(280)
        self._cargar_perfiles_combo()
        perfil_row.addWidget(self.perfil_combo)

        test_nc_btn = QPushButton('Probar permisos NC')
        test_nc_btn.setFont(QFont('Segoe UI', 9, QFont.Bold))
        test_nc_btn.setMinimumHeight(34)
        test_nc_btn.setToolTip(
            'Consulta a AFIP si el perfil seleccionado puede emitir Nota de Crédito.\n'
            'No emite ningún comprobante.'
        )
        test_nc_btn.setStyleSheet(
            'QPushButton { background:#fff; color:#a01616;'
            '              border:2px solid #a01616; border-radius:6px; padding:0 12px; }'
            'QPushButton:hover { background:#fff5f5; }'
        )
        test_nc_btn.clicked.connect(self._test_permisos_nc)
        perfil_row.addWidget(test_nc_btn)
        perfil_row.addStretch()
        layout.addLayout(perfil_row)

        # Barra de acciones
        action_row = QHBoxLayout()
        refresh_btn = QPushButton('Actualizar')
        refresh_btn.setFont(QFont('Segoe UI', 9))
        refresh_btn.clicked.connect(self.refresh_data)
        action_row.addWidget(refresh_btn)
        action_row.addStretch()
        layout.addLayout(action_row)

        # ── Panel de totales ────────────────────────────────────────────────
        totales_row = QHBoxLayout()
        totales_row.setSpacing(10)

        def _totbox(color_bg, color_txt):
            box = QFrame()
            box.setStyleSheet(
                f'background:{color_bg}; border:1px solid {color_txt}; '
                'border-radius:8px; padding:10px 14px;'
            )
            v = QVBoxLayout(box)
            v.setContentsMargins(10, 8, 10, 8)
            v.setSpacing(2)
            title = QLabel()
            title.setFont(QFont('Segoe UI', 9, QFont.Bold))
            title.setStyleSheet(f'color:{color_txt}; background:transparent; border:none;')
            value = QLabel('$0.00')
            value.setFont(QFont('Segoe UI', 14, QFont.Bold))
            value.setStyleSheet(f'color:{color_txt}; background:transparent; border:none;')
            v.addWidget(title)
            v.addWidget(value)
            return box, title, value

        box_total, self.t_total_title, self.t_total_value = _totbox('#fbeee5', '#7a3514')
        self.t_total_title.setText('Total facturado')
        totales_row.addWidget(box_total)

        box_v2, self.t_v2_title, self.t_v2_value = _totbox('#f3e8ff', '#a3441a')
        self.t_v2_title.setText('Varios 2 facturado')
        totales_row.addWidget(box_v2)

        box_reg, self.t_reg_title, self.t_reg_value = _totbox('#e7f4ec', '#0a3622')
        self.t_reg_title.setText('Facturas regulares')
        totales_row.addWidget(box_reg)

        box_cnt, self.t_cnt_title, self.t_cnt_value = _totbox('#fbeee5', '#664d03')
        self.t_cnt_title.setText('Cant. total / Varios 2')
        totales_row.addWidget(box_cnt)

        layout.addLayout(totales_row)

        # Tabla
        self.h_table = QTableWidget()
        self.h_table.setColumnCount(9)
        self.h_table.setHorizontalHeaderLabels(
            ['#', 'Tipo', 'Nro.', 'Fecha', 'Cliente', 'CAE', 'Total', 'PDF', 'Origen']
        )
        self.h_table.verticalHeader().setVisible(False)
        self.h_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.h_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.h_table.setAlternatingRowColors(True)
        hh = self.h_table.horizontalHeader()
        hh.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(2, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(3, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(4, QHeaderView.Stretch)
        hh.setSectionResizeMode(5, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(6, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(7, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(8, QHeaderView.ResizeToContents)
        layout.addWidget(self.h_table)

        # Botones de acción sobre la fila seleccionada
        actions_row = QHBoxLayout()
        actions_row.setSpacing(8)

        reimp_btn = QPushButton('Abrir / Reimprimir seleccionada')
        reimp_btn.setFont(QFont('Segoe UI', 10))
        reimp_btn.setMinimumHeight(40)
        reimp_btn.clicked.connect(self._reprint_selected)
        actions_row.addWidget(reimp_btn)

        nc_btn = QPushButton('Hacer Nota de Crédito')
        nc_btn.setFont(QFont('Segoe UI', 10, QFont.Bold))
        nc_btn.setMinimumHeight(40)
        nc_btn.setToolTip(
            'Emite una NC vinculada a la factura seleccionada (total o parcial).\n'
            'Solicita CAE a AFIP automáticamente.'
        )
        nc_btn.setStyleSheet(
            'QPushButton { background:#a01616; color:white; border:none;'
            '              border-radius:8px; padding:0 18px; }'
            'QPushButton:hover { background:#7a1010; }'
        )
        nc_btn.clicked.connect(self._on_nota_credito)
        actions_row.addWidget(nc_btn)

        layout.addLayout(actions_row)

        return widget

    def _on_nota_credito(self):
        """Abre el diálogo de Nota de Crédito sobre la factura seleccionada."""
        row = self.h_table.currentRow()
        if row < 0:
            QMessageBox.information(self, 'Sin selección',
                'Seleccioná una factura del historial para emitir su NC.')
            return
        # Recuperar la factura por ID (columna 0)
        try:
            id_item = self.h_table.item(row, 0)
            fid = int(id_item.text()) if id_item else 0
        except (ValueError, AttributeError):
            QMessageBox.warning(self, 'Error', 'No se pudo leer la fila seleccionada.')
            return
        from pos_system.database.db_manager import DatabaseManager
        db = DatabaseManager()
        rows = db.execute_query("SELECT * FROM facturas WHERE id=? LIMIT 1", (fid,))
        if not rows:
            QMessageBox.warning(self, 'Error', f'No se encontró la factura #{fid}.')
            return
        factura = rows[0]
        # Validar que sea una factura (no otra NC) — para simplificar, no permitir
        # encadenar NC sobre NC.
        tipo = (factura.get('tipo_comprobante') or '').upper()
        if tipo.startswith('NOTA'):
            QMessageBox.warning(self, 'No permitido',
                'No se puede emitir una Nota de Crédito sobre otra Nota de Crédito.')
            return
        # Validar que tenga CAE (factura emitida en AFIP)
        if not (factura.get('cae') or '').strip():
            QMessageBox.warning(self, 'Factura sin CAE',
                'Solo se pueden hacer Notas de Crédito sobre facturas con CAE.\n'
                'Esta factura figura como "manual" o aún no fue autorizada por AFIP.')
            return
        # Pasar el perfil seleccionado para que la NC use sus credenciales
        perfil = self._get_perfil_seleccionado()
        if not perfil:
            QMessageBox.warning(self, 'Sin perfil',
                'Seleccioná un perfil ARCA del combo arriba antes de emitir la NC.')
            return
        from pos_system.ui.nota_credito_dialog import NotaCreditoDialog
        dlg = NotaCreditoDialog(factura, self, perfil=perfil)
        if dlg.exec_() == dlg.Accepted:
            self.refresh_data()
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
        row = self.h_table.currentRow()
        if row < 0:
            QMessageBox.information(self, 'Sin selección', 'Seleccione una factura de la lista.')
            return
        pdf_item = self.h_table.item(row, 7)
        if not pdf_item:
            return
        pdf_path = pdf_item.data(Qt.UserRole)
        if not pdf_path:
            QMessageBox.warning(self, 'Sin PDF', 'No hay PDF disponible para esta factura.')
            return
        import os, subprocess, sys
        if not os.path.exists(pdf_path):
            QMessageBox.warning(self, 'Archivo no encontrado',
                                f'No se encontró el archivo:\n{pdf_path}')
            return
        if sys.platform == 'win32':
            os.startfile(pdf_path)
        else:
            subprocess.Popen(['xdg-open', pdf_path])

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
            ('Teléfono:',          'telefono',         'Ej: 3511234567'),
            ('Email:',             'email',            'Ej: info@tuempresa.com'),
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
        """Llena el combo con los perfiles de perfiles_facturacion.activo=1."""
        from pos_system.database.db_manager import DatabaseManager
        try:
            db = DatabaseManager()
            rows = db.execute_query(
                "SELECT id, nombre, cuit, punto_venta FROM perfiles_facturacion "
                "WHERE activo=1 ORDER BY nombre"
            ) or []
        except Exception:
            rows = []
        self.perfil_combo.clear()
        if not rows:
            self.perfil_combo.addItem('— sin perfiles cargados —', None)
            return
        for r in rows:
            cuit = (r.get('cuit') or '').strip()
            pv = int(r.get('punto_venta') or 1)
            label = f"{r.get('nombre', '?')} — CUIT {cuit} — PV {pv}"
            self.perfil_combo.addItem(label, int(r['id']))

    def _get_perfil_seleccionado(self) -> dict:
        """Devuelve el dict completo del perfil seleccionado en el combo, o {}."""
        if not hasattr(self, 'perfil_combo') or self.perfil_combo is None:
            return {}
        pid = self.perfil_combo.currentData()
        if not pid:
            return {}
        from pos_system.database.db_manager import DatabaseManager
        try:
            db = DatabaseManager()
            rows = db.execute_query(
                "SELECT * FROM perfiles_facturacion WHERE id=? AND activo=1 LIMIT 1",
                (int(pid),)
            ) or []
            return rows[0] if rows else {}
        except Exception:
            return {}

    def _test_permisos_nc(self):
        """Llama a AFIP para verificar si el perfil seleccionado puede emitir NC."""
        from PyQt5.QtWidgets import QApplication
        perfil = self._get_perfil_seleccionado()
        if not perfil:
            QMessageBox.warning(
                self, 'Sin perfil',
                'Seleccioná un perfil ARCA del combo de arriba.\n'
                'Los perfiles se cargan en la pestaña "Perfiles ARCA".'
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
        self._load_historial()
        self._load_config_fields()

    def _load_historial(self):
        try:
            from pos_system.database.db_manager import DatabaseManager
            db = DatabaseManager()
            rows = db.execute_query(
                "SELECT * FROM facturas ORDER BY created_at DESC LIMIT 500"
            )
            self.h_table.setRowCount(len(rows))
            total_all = 0.0
            total_v2 = 0.0
            total_reg = 0.0
            count_v2 = 0
            for i, r in enumerate(rows):
                fecha_str = ''
                try:
                    fecha_str = _parse_ar(r['created_at']).strftime('%d/%m/%Y %H:%M')
                except Exception:
                    fecha_str = r.get('created_at', '')

                cae_short = str(r.get('cae', ''))[:14] if r.get('cae') else '—'
                has_cae = bool(r.get('cae'))
                es_v2 = bool(r.get('es_varios_2'))
                tot = float(r.get('total', 0) or 0)
                total_all += tot
                if es_v2:
                    total_v2 += tot
                    count_v2 += 1
                else:
                    total_reg += tot

                self.h_table.setItem(i, 0, QTableWidgetItem(str(r['id'])))
                self.h_table.setItem(i, 1, QTableWidgetItem(r.get('tipo_comprobante', '')))
                nro_item = QTableWidgetItem(str(r.get('nro_comprobante', '')).zfill(8))
                self.h_table.setItem(i, 2, nro_item)
                self.h_table.setItem(i, 3, QTableWidgetItem(fecha_str))
                self.h_table.setItem(i, 4, QTableWidgetItem(r.get('cliente', '')))
                cae_item = QTableWidgetItem(cae_short)
                if has_cae:
                    cae_item.setForeground(QColor('#3d7a3a'))
                else:
                    cae_item.setForeground(QColor('#a01616'))
                self.h_table.setItem(i, 5, cae_item)
                self.h_table.setItem(i, 6, QTableWidgetItem(f'${tot:,.2f}'))

                pdf_item = QTableWidgetItem('Abrir' if r.get('pdf_path') else '—')
                pdf_item.setData(Qt.UserRole, r.get('pdf_path'))
                if r.get('pdf_path'):
                    pdf_item.setForeground(QColor('#c1521f'))
                self.h_table.setItem(i, 7, pdf_item)

                origen_item = QTableWidgetItem('Varios 2' if es_v2 else 'Venta/Manual')
                if es_v2:
                    origen_item.setForeground(QColor('#a3441a'))
                    origen_item.setFont(QFont('Segoe UI', 9, QFont.Bold))
                self.h_table.setItem(i, 8, origen_item)

            # Actualizar panel de totales
            self.t_total_value.setText(f'${total_all:,.2f}')
            self.t_v2_value.setText(f'${total_v2:,.2f}')
            self.t_reg_value.setText(f'${total_reg:,.2f}')
            self.t_cnt_value.setText(f'{len(rows)}  /  {count_v2}')
        except Exception:
            pass

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
