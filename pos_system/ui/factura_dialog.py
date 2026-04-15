"""
Diálogo para emitir Facturas Electrónicas AFIP.
Permite ingresar datos del cliente y tipo de comprobante,
luego genera el PDF con generate_factura_afip().
"""
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QFormLayout, QLabel,
    QPushButton, QLineEdit, QComboBox, QFrame, QMessageBox,
    QGroupBox, QDoubleSpinBox, QScrollArea, QWidget, QApplication
)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont
from datetime import datetime
from pos_system.utils.firebase_sync import now_ar


class FacturaDialog(QDialog):
    """
    Diálogo para emitir una factura electrónica AFIP a partir de una venta.

    Parámetros:
        sale: dict con los datos de la venta (items, total, payment_type, etc.)
        auto_virtual: Si True, pre-completa como transferencia → Tipo B, Consumidor Final
        parent: widget padre
        perfil: dict con datos del perfil ARCA seleccionado
        cliente_data: dict con datos del cliente receptor
    """

    def __init__(self, parent=None, sale: dict = None, auto_virtual: bool = False,
                 perfil: dict = None, cliente_data: dict = None):
        super().__init__(parent)
        self.sale = sale or {}
        self.auto_virtual = auto_virtual
        self.perfil = perfil
        self.cliente_data = cliente_data
        self.pdf_path = None
        self._setup_emisor_data()
        self.init_ui()
        if perfil:
            self._prefill_perfil(perfil)
        elif auto_virtual:
            self._prefill_virtual()
        if cliente_data:
            self._prefill_cliente(cliente_data)

    def _setup_emisor_data(self):
        """Carga datos del emisor desde config."""
        try:
            from pos_system.config import (
                AFIP_CUIT, AFIP_RAZON_SOCIAL, AFIP_DOMICILIO, AFIP_LOCALIDAD,
                AFIP_TELEFONO, AFIP_ING_BRUTOS, AFIP_INICIO_ACT,
                AFIP_CONDICION_IVA, AFIP_PUNTO_VENTA
            )
            self.emisor = {
                'cuit':             AFIP_CUIT,
                'razon_social':     AFIP_RAZON_SOCIAL,
                'domicilio':        AFIP_DOMICILIO,
                'localidad':        AFIP_LOCALIDAD,
                'telefono':         AFIP_TELEFONO,
                'ing_brutos':       AFIP_ING_BRUTOS,
                'inicio_actividades': AFIP_INICIO_ACT,
                'condicion_iva':    AFIP_CONDICION_IVA,
                'punto_venta':      AFIP_PUNTO_VENTA,
            }
        except Exception:
            self.emisor = {
                'cuit': '', 'razon_social': '', 'domicilio': '',
                'localidad': '', 'telefono': '', 'ing_brutos': '',
                'inicio_actividades': '', 'condicion_iva': 'Resp. Inscripto',
                'punto_venta': 1,
            }

    def init_ui(self):
        self.setWindowTitle('Emitir Factura Electronica AFIP')
        self.setModal(True)
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowContextHelpButtonHint)

        # Tamaño adaptable a la pantalla
        screen = QApplication.primaryScreen().availableGeometry()
        w = max(480, min(560, int(screen.width() * 0.38)))
        h = max(420, min(680, int(screen.height() * 0.82)))
        self.resize(w, h)
        self.setMinimumSize(420, 380)

        # Layout externo: scroll + botones fijos abajo
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        # ── Encabezado fijo ───────────────────────────────────────────────
        header_w = QWidget()
        header_w.setStyleSheet('background: #f8f9fa; border-bottom: 1px solid #dee2e6;')
        header_lay = QVBoxLayout(header_w)
        header_lay.setContentsMargins(16, 12, 16, 10)
        header_lay.setSpacing(2)

        title = QLabel('Factura Electronica AFIP')
        title.setFont(QFont('Segoe UI', 13, QFont.Bold))
        title.setStyleSheet('color: #0d6efd; background: transparent;')
        header_lay.addWidget(title)

        total = self.sale.get('total_amount', 0)
        total_lbl = QLabel(f'Total de la venta: <b>${total:,.2f}</b>')
        total_lbl.setFont(QFont('Segoe UI', 10))
        total_lbl.setTextFormat(Qt.RichText)
        total_lbl.setStyleSheet('background: transparent;')
        header_lay.addWidget(total_lbl)

        outer.addWidget(header_w)

        # ── Área scrolleable ──────────────────────────────────────────────
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)

        content = QWidget()
        main = QVBoxLayout(content)
        main.setSpacing(10)
        main.setContentsMargins(16, 12, 16, 12)

        # ── Tipo de comprobante ───────────────────────────────────────────
        tipo_group = QGroupBox('Comprobante')
        tipo_group.setFont(QFont('Segoe UI', 9, QFont.Bold))
        tipo_layout = QFormLayout(tipo_group)
        tipo_layout.setSpacing(6)

        self.tipo_combo = QComboBox()
        self.tipo_combo.setFont(QFont('Segoe UI', 10))
        self.tipo_combo.addItems(['FAC. ELEC. B', 'FAC. ELEC. A', 'FAC. ELEC. C'])
        tipo_layout.addRow('Tipo:', self.tipo_combo)

        self.modalidad_input = QLineEdit('LOCAL')
        self.modalidad_input.setFont(QFont('Segoe UI', 10))
        tipo_layout.addRow('Modalidad:', self.modalidad_input)

        payment_type = self.sale.get('payment_type', 'cash')
        pago_text = 'Transferencia' if payment_type == 'transfer' else 'Efectivo'
        self.pago_input = QLineEdit(pago_text)
        self.pago_input.setFont(QFont('Segoe UI', 10))
        tipo_layout.addRow('Forma de pago:', self.pago_input)

        main.addWidget(tipo_group)

        # ── Datos del cliente ─────────────────────────────────────────────
        cliente_group = QGroupBox('Datos del Cliente')
        cliente_group.setFont(QFont('Segoe UI', 9, QFont.Bold))
        cliente_layout = QFormLayout(cliente_group)
        cliente_layout.setSpacing(6)

        self.cliente_input = QLineEdit('CONSUMIDOR FINAL')
        self.cliente_input.setFont(QFont('Segoe UI', 10))
        self.cliente_input.setPlaceholderText('Nombre o Razon Social')
        cliente_layout.addRow('Cliente:', self.cliente_input)

        self.cuit_cliente_input = QLineEdit('')
        self.cuit_cliente_input.setFont(QFont('Segoe UI', 10))
        self.cuit_cliente_input.setPlaceholderText('Ej: 20123456789 (vacio = Consumidor Final)')
        cliente_layout.addRow('CUIT Cliente:', self.cuit_cliente_input)

        self.domicilio_cliente_input = QLineEdit('')
        self.domicilio_cliente_input.setFont(QFont('Segoe UI', 10))
        self.domicilio_cliente_input.setPlaceholderText('Opcional')
        cliente_layout.addRow('Domicilio:', self.domicilio_cliente_input)

        self.condicion_iva_cliente = QComboBox()
        self.condicion_iva_cliente.setFont(QFont('Segoe UI', 10))
        self.condicion_iva_cliente.addItems([
            'Consumidor Final', 'Responsable Inscripto', 'Monotributista', 'Exento'
        ])
        cliente_layout.addRow('Condicion IVA:', self.condicion_iva_cliente)

        main.addWidget(cliente_group)

        # ── Datos AFIP (CAE) ──────────────────────────────────────────────
        afip_group = QGroupBox('Datos AFIP (CAE)')
        afip_group.setFont(QFont('Segoe UI', 9, QFont.Bold))
        afip_layout = QFormLayout(afip_group)
        afip_layout.setSpacing(6)

        self.cae_input = QLineEdit('')
        self.cae_input.setFont(QFont('Segoe UI', 10))
        self.cae_input.setPlaceholderText('CAE otorgado por AFIP (dejar vacio si no disponible)')
        afip_layout.addRow('CAE:', self.cae_input)

        self.vto_cae_input = QLineEdit('')
        self.vto_cae_input.setFont(QFont('Segoe UI', 10))
        self.vto_cae_input.setPlaceholderText('AAAAMMDD — Ej: 20260412')
        afip_layout.addRow('Vto. CAE:', self.vto_cae_input)

        iva_row = QHBoxLayout()
        self.iva_spin = QDoubleSpinBox()
        self.iva_spin.setFont(QFont('Segoe UI', 10))
        self.iva_spin.setMinimum(0)
        self.iva_spin.setMaximum(999999)
        self.iva_spin.setDecimals(2)
        total_val = float(self.sale.get('total_amount', 0))
        self.iva_spin.setValue(0.0)  # Monotributo: IVA = 0
        iva_row.addWidget(self.iva_spin)
        iva_auto_btn = QPushButton('21%')
        iva_auto_btn.setFixedWidth(48)
        iva_auto_btn.setToolTip('Calcular IVA 21% incluido')
        iva_auto_btn.clicked.connect(self._calc_iva_21)
        iva_row.addWidget(iva_auto_btn)
        afip_layout.addRow('IVA Contenido ($):', iva_row)

        main.addWidget(afip_group)

        # Badge CAE
        if self.emisor.get('cert_path') and self.emisor.get('key_path'):
            badge = QLabel('CAE automatico — se solicitara a AFIP al generar')
            badge.setStyleSheet(
                'background:#e7f3ff; color:#0d6efd; border:1px solid #b6d4fe;'
                'border-radius:6px; padding:6px 10px; font-size:10px;'
            )
            main.addWidget(badge)
        elif not self.emisor.get('cuit'):
            warn = QLabel('Configure los datos del emisor en Fiscal → Configuracion AFIP')
            warn.setStyleSheet('color: #dc3545; font-size: 10px; padding: 4px;')
            warn.setWordWrap(True)
            main.addWidget(warn)
        else:
            badge = QLabel('Sin certificado — ingresa el CAE manualmente si lo tenes')
            badge.setStyleSheet(
                'background:#fff3cd; color:#856404; border:1px solid #ffecb5;'
                'border-radius:6px; padding:6px 10px; font-size:10px;'
            )
            main.addWidget(badge)

        scroll.setWidget(content)
        outer.addWidget(scroll, 1)

        # ── Botones fijos abajo ───────────────────────────────────────────
        btn_bar = QWidget()
        btn_bar.setStyleSheet('background: #f8f9fa; border-top: 1px solid #dee2e6;')
        btn_row = QHBoxLayout(btn_bar)
        btn_row.setContentsMargins(16, 10, 16, 10)
        btn_row.setSpacing(8)

        cancel_btn = QPushButton('Cancelar')
        cancel_btn.setObjectName('btnSecondary')
        cancel_btn.setMinimumHeight(40)
        cancel_btn.setFont(QFont('Segoe UI', 10))
        cancel_btn.clicked.connect(self.reject)
        btn_row.addWidget(cancel_btn)

        emit_btn = QPushButton('Generar Factura PDF')
        emit_btn.setMinimumHeight(44)
        emit_btn.setFont(QFont('Segoe UI', 11, QFont.Bold))
        emit_btn.setStyleSheet('''
            QPushButton {
                background: #0d6efd; color: white;
                border: none; border-radius: 8px;
            }
            QPushButton:hover { background: #0b5ed7; }
        ''')
        emit_btn.clicked.connect(self._emit_factura)
        btn_row.addWidget(emit_btn, 2)

        outer.addWidget(btn_bar)

    def _prefill_perfil(self, perfil: dict):
        """Usa los datos del perfil como EMISOR (reemplaza config AFIP global)."""
        self.emisor = {
            'cuit':               perfil.get('cuit', ''),
            'razon_social':       perfil.get('razon_social') or perfil.get('nombre', ''),
            'domicilio':          perfil.get('domicilio', ''),
            'localidad':          perfil.get('localidad', ''),
            'telefono':           '',
            'ing_brutos':         perfil.get('ing_brutos', ''),
            'inicio_actividades': perfil.get('inicio_actividades', ''),
            'condicion_iva':      perfil.get('condicion_iva', 'Monotributista'),
            'punto_venta':        perfil.get('punto_venta', 1),
            'cert_path':          perfil.get('cert_path', ''),
            'key_path':           perfil.get('key_path', ''),
            'produccion':         bool(perfil.get('produccion', 0)),
            'nombre_perfil':      perfil.get('nombre', ''),
        }

    def _prefill_cliente(self, cliente: dict):
        """Pre-rellena los datos del receptor con el cliente seleccionado."""
        nombre = cliente.get('razon_social') or cliente.get('nombre', '')
        cuit = cliente.get('cuit', '')
        domicilio = cliente.get('domicilio', '')
        cond_iva = cliente.get('condicion_iva', '')
        if nombre:
            self.cliente_input.setText(nombre)
        if cuit:
            self.cuit_cliente_input.setText(cuit)
        if domicilio:
            self.domicilio_cliente_input.setText(domicilio)
        if cond_iva:
            idx = self.condicion_iva_cliente.findText(cond_iva)
            if idx >= 0:
                self.condicion_iva_cliente.setCurrentIndex(idx)
        if cond_iva == 'Responsable Inscripto':
            self.tipo_combo.setCurrentText('FAC. ELEC. A')

    def _prefill_virtual(self):
        """Pre-rellena para pago virtual: Tipo B, Consumidor Final."""
        self.tipo_combo.setCurrentText('FAC. ELEC. B')
        self.pago_input.setText('Transferencia')
        self.cliente_input.setText('CONSUMIDOR FINAL')
        self.cuit_cliente_input.clear()

    def _calc_iva_21(self):
        """Calcula IVA 21% incluido sobre el total."""
        total = float(self.sale.get('total_amount', 0))
        self.iva_spin.setValue(round(total - total / 1.21, 2))

    def auto_emit(self):
        """
        Genera la factura como Consumidor Final sin mostrar el dialog.
        Pre-configura tipo C (Monotributo) y llama directamente a _emit_factura.
        """
        # Para monotributo: Factura C, Consumidor Final, sin IVA
        self.tipo_combo.setCurrentText('FAC. ELEC. C')
        self.cliente_input.setText('CONSUMIDOR FINAL')
        self.cuit_cliente_input.clear()
        self.condicion_iva_cliente.setCurrentIndex(0)  # Consumidor Final
        self.iva_spin.setValue(0.0)
        payment_type = self.sale.get('payment_type', 'cash')
        self.pago_input.setText('Transferencia' if payment_type == 'transfer' else 'Efectivo')
        self._emit_factura()

    def _get_next_nro_comprobante(self, tipo: str) -> int:
        """Obtiene el próximo número de comprobante para el tipo dado."""
        try:
            from pos_system.database.db_manager import DatabaseManager
            db = DatabaseManager()
            result = db.execute_query(
                "SELECT MAX(nro_comprobante) as max_nro FROM facturas WHERE tipo_comprobante = ?",
                (tipo,)
            )
            max_nro = result[0]['max_nro'] if result and result[0]['max_nro'] else 0
            return max_nro + 1
        except Exception:
            return 1

    def _emit_factura(self):
        """Genera el PDF. Si el perfil tiene cert+key, solicita CAE a AFIP automáticamente."""
        from pos_system.utils.pdf_generator import PDFGenerator
        from pos_system.database.db_manager import DatabaseManager

        tipo = self.tipo_combo.currentText()
        cliente = self.cliente_input.text().strip() or 'CONSUMIDOR FINAL'
        cuit_cliente = self.cuit_cliente_input.text().strip()
        dom_cliente = self.domicilio_cliente_input.text().strip()
        cond_iva_cliente = self.condicion_iva_cliente.currentText()
        cae = self.cae_input.text().strip()
        vto_cae = self.vto_cae_input.text().strip()
        total = float(self.sale.get('total_amount', 0))
        iva = self.iva_spin.value()
        nro = self._get_next_nro_comprobante(tipo)

        # ── Intentar CAE automático si el perfil tiene certificados ─────
        cert_path = self.emisor.get('cert_path', '')
        key_path  = self.emisor.get('key_path', '')
        if cert_path and key_path and not cae:
            try:
                from pos_system.utils.afip_wsfe import AfipWsfe, AFIPError, calcular_iva_neto
                afip = AfipWsfe(
                    cuit=self.emisor.get('cuit', ''),
                    cert_path=cert_path,
                    key_path=key_path,
                    produccion=bool(self.emisor.get('produccion', False)),
                )
                neto, iva_calc = calcular_iva_neto(total, 21.0)
                resultado = afip.solicitar_cae(
                    tipo_comprobante=tipo,
                    punto_venta=int(self.emisor.get('punto_venta', 1)),
                    nro_comprobante=nro,
                    importe_total=total,
                    importe_neto_gravado=neto,
                    importe_iva=iva if iva > 0 else iva_calc,
                    concepto=1,
                    cuit_receptor=cuit_cliente or None,
                    condicion_iva_receptor=cond_iva_cliente,
                )
                cae     = str(resultado['cae'])
                vto_cae = str(resultado['vto_cae'])
                self.cae_input.setText(cae)
                self.vto_cae_input.setText(vto_cae)
            except ImportError:
                QMessageBox.warning(
                    self, 'Dependencia faltante',
                    'Para CAE automatico instala: pip install zeep pyOpenSSL\n\n'
                    'Se generara la factura sin CAE.'
                )
            except Exception as e:
                resp = QMessageBox.question(
                    self, 'Error AFIP',
                    f'No se pudo obtener el CAE de AFIP:\n{e}\n\n'
                    'Generar igualmente la factura sin CAE?',
                    QMessageBox.Yes | QMessageBox.No, QMessageBox.No
                )
                if resp != QMessageBox.Yes:
                    return

        items_factura = []
        for it in self.sale.get('items', []):
            items_factura.append({
                'cantidad':    it.get('quantity', 1),
                'descripcion': it.get('product_name', 'Producto'),
                'iva':         0.0,  # Monotributo: sin IVA discriminado
                'precio':      float(it.get('unit_price', 0)),
                'importe':     float(it.get('subtotal', 0)),
            })
        if not items_factura:
            items_factura = [{
                'cantidad':    1,
                'descripcion': 'Venta general',
                'iva':         0.0,
                'precio':      total,
                'importe':     total,
            }]

        nombre_perfil = self.emisor.get('nombre_perfil', self.emisor.get('razon_social', ''))

        factura = {
            # Emisor
            'cuit':               self.emisor.get('cuit', ''),
            'razon_social':       self.emisor.get('razon_social', ''),
            'domicilio':          self.emisor.get('domicilio', ''),
            'localidad':          self.emisor.get('localidad', ''),
            'telefono':           self.emisor.get('telefono', ''),
            'ing_brutos':         self.emisor.get('ing_brutos', ''),
            'inicio_actividades': self.emisor.get('inicio_actividades', ''),
            'condicion_iva':      self.emisor.get('condicion_iva', 'Monotributista'),
            # Comprobante
            'tipo_comprobante':   tipo,
            'punto_venta':        self.emisor.get('punto_venta', 1),
            'nro_comprobante':    nro,
            'fecha':              now_ar().strftime('%d/%m/%Y %I:%M:%S %p'),
            'turno':              str(self.sale.get('id', '')).zfill(5),
            'pago':               self.pago_input.text().strip(),
            'modalidad':          self.modalidad_input.text().strip(),
            # Cliente / Receptor
            'cliente':               cliente,
            'cuit_receptor':         cuit_cliente,
            'domicilio_receptor':    dom_cliente,
            'condicion_iva_receptor': cond_iva_cliente,
            # Items
            'items':              items_factura,
            # Totales
            'total':              total,
            'iva_contenido':      iva,
            'otros_impuestos':    0.0,
            # AFIP
            'cae':                cae,
            'vto_cae':            vto_cae,
            # Perfil emisor (para resumen webapp)
            'nombre_perfil':      nombre_perfil,
        }

        try:
            gen = PDFGenerator()
            self.pdf_path = gen.generate_factura_afip_a4(factura)

            # Guardar en tabla facturas local
            db = DatabaseManager()
            db.execute_update(
                """INSERT INTO facturas
                   (sale_id, tipo_comprobante, punto_venta, nro_comprobante, fecha,
                    cliente, cuit_cliente, cae, vto_cae, total, iva_contenido,
                    otros_impuestos, pdf_path)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    self.sale.get('id'),
                    tipo,
                    self.emisor.get('punto_venta', 1),
                    nro,
                    now_ar().isoformat(),
                    cliente,
                    cuit_cliente,
                    cae,
                    vto_cae,
                    total,
                    iva,
                    0.0,
                    self.pdf_path,
                )
            )

            # Sincronizar a Firebase para verlo en la webapp
            try:
                from pos_system.utils.firebase_sync import get_firebase_sync, now_ar_iso
                fb = get_firebase_sync()
                if fb and fb.enabled:
                    import threading
                    factura_fb = dict(factura)
                    factura_fb['sale_id'] = self.sale.get('id')
                    factura_fb['created_at'] = now_ar_iso()
                    threading.Thread(
                        target=lambda: fb.sync_factura(factura_fb), daemon=True
                    ).start()
            except Exception:
                pass

            self.accept()
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'Error al generar la factura:\n{str(e)}')
