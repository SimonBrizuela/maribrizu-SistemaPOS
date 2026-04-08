"""
Diálogo para emitir Facturas Electrónicas AFIP.
Permite ingresar datos del cliente y tipo de comprobante,
luego genera el PDF con generate_factura_afip().
"""
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QFormLayout, QLabel,
    QPushButton, QLineEdit, QComboBox, QFrame, QMessageBox,
    QGroupBox, QDoubleSpinBox
)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont
from datetime import datetime


class FacturaDialog(QDialog):
    """
    Diálogo para emitir una factura electrónica AFIP a partir de una venta.

    Parámetros:
        sale: dict con los datos de la venta (items, total, payment_type, etc.)
        auto_virtual: Si True, pre-completa como transferencia → Tipo B, Consumidor Final
        parent: widget padre
    """

    def __init__(self, parent=None, sale: dict = None, auto_virtual: bool = False):
        super().__init__(parent)
        self.sale = sale or {}
        self.auto_virtual = auto_virtual
        self.pdf_path = None
        self._setup_emisor_data()
        self.init_ui()
        if auto_virtual:
            self._prefill_virtual()

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
        self.setWindowTitle('Emitir Factura Electrónica AFIP')
        self.setMinimumWidth(520)
        self.setModal(True)

        main = QVBoxLayout(self)
        main.setSpacing(12)
        main.setContentsMargins(16, 16, 16, 16)

        # ── Título ────────────────────────────────────────────────────────────
        title = QLabel('Factura Electrónica AFIP')
        title.setFont(QFont('Segoe UI', 14, QFont.Bold))
        title.setStyleSheet('color: #0d6efd;')
        main.addWidget(title)

        total = self.sale.get('total_amount', 0)
        total_lbl = QLabel(f'Total de la venta: <b>${total:.2f}</b>')
        total_lbl.setFont(QFont('Segoe UI', 11))
        total_lbl.setTextFormat(Qt.RichText)
        main.addWidget(total_lbl)

        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet('color: #dee2e6;')
        main.addWidget(sep)

        # ── Tipo de comprobante ───────────────────────────────────────────────
        tipo_group = QGroupBox('Comprobante')
        tipo_group.setFont(QFont('Segoe UI', 10, QFont.Bold))
        tipo_layout = QFormLayout(tipo_group)
        tipo_layout.setSpacing(8)

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

        # ── Datos del cliente ─────────────────────────────────────────────────
        cliente_group = QGroupBox('Datos del Cliente')
        cliente_group.setFont(QFont('Segoe UI', 10, QFont.Bold))
        cliente_layout = QFormLayout(cliente_group)
        cliente_layout.setSpacing(8)

        self.cliente_input = QLineEdit('CONSUMIDOR FINAL')
        self.cliente_input.setFont(QFont('Segoe UI', 10))
        self.cliente_input.setPlaceholderText('Nombre o Razón Social')
        cliente_layout.addRow('Cliente:', self.cliente_input)

        self.cuit_cliente_input = QLineEdit('')
        self.cuit_cliente_input.setFont(QFont('Segoe UI', 10))
        self.cuit_cliente_input.setPlaceholderText('Ej: 20123456789 (vacío = Consumidor Final)')
        cliente_layout.addRow('CUIT Cliente:', self.cuit_cliente_input)

        main.addWidget(cliente_group)

        # ── Datos AFIP (CAE - completar cuando se integre WSFE) ──────────────
        afip_group = QGroupBox('Datos AFIP (CAE)')
        afip_group.setFont(QFont('Segoe UI', 10, QFont.Bold))
        afip_layout = QFormLayout(afip_group)
        afip_layout.setSpacing(8)

        self.cae_input = QLineEdit('')
        self.cae_input.setFont(QFont('Segoe UI', 10))
        self.cae_input.setPlaceholderText('CAE otorgado por AFIP (dejar vacío si aún no disponible)')
        afip_layout.addRow('CAE:', self.cae_input)

        self.vto_cae_input = QLineEdit('')
        self.vto_cae_input.setFont(QFont('Segoe UI', 10))
        self.vto_cae_input.setPlaceholderText('AAAAMMDD — Ej: 20260412')
        afip_layout.addRow('Vto. CAE:', self.vto_cae_input)

        # IVA contenido (calculado automáticamente si es 21%)
        iva_row = QHBoxLayout()
        self.iva_spin = QDoubleSpinBox()
        self.iva_spin.setFont(QFont('Segoe UI', 10))
        self.iva_spin.setMinimum(0)
        self.iva_spin.setMaximum(999999)
        self.iva_spin.setDecimals(2)
        # Auto-calcular IVA 21% incluido
        total_val = float(self.sale.get('total_amount', 0))
        self.iva_spin.setValue(round(total_val - total_val / 1.21, 2))
        iva_row.addWidget(self.iva_spin)
        iva_auto_btn = QPushButton('21%')
        iva_auto_btn.setFixedWidth(48)
        iva_auto_btn.setToolTip('Calcular IVA 21% incluido')
        iva_auto_btn.clicked.connect(self._calc_iva_21)
        iva_row.addWidget(iva_auto_btn)
        afip_layout.addRow('IVA Contenido ($):', iva_row)

        main.addWidget(afip_group)

        # Aviso si no hay datos del emisor configurados
        if not self.emisor.get('cuit'):
            warn = QLabel('Configure los datos del emisor en la pestana Fiscal → Configuración AFIP')
            warn.setStyleSheet('color: #dc3545; font-size: 11px; padding: 4px;')
            warn.setWordWrap(True)
            main.addWidget(warn)

        # ── Botones ───────────────────────────────────────────────────────────
        btn_row = QHBoxLayout()
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

        main.addLayout(btn_row)

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
        """Genera el PDF de la factura y lo guarda."""
        from pos_system.utils.pdf_generator import PDFGenerator
        from pos_system.database.db_manager import DatabaseManager

        tipo = self.tipo_combo.currentText()
        cliente = self.cliente_input.text().strip() or 'CONSUMIDOR FINAL'
        cuit_cliente = self.cuit_cliente_input.text().strip()
        cae = self.cae_input.text().strip()
        vto_cae = self.vto_cae_input.text().strip()
        total = float(self.sale.get('total_amount', 0))
        iva = self.iva_spin.value()
        nro = self._get_next_nro_comprobante(tipo)

        # Construir items de factura desde los items de la venta
        items_factura = []
        for it in self.sale.get('items', []):
            items_factura.append({
                'cantidad':    it.get('quantity', 1),
                'descripcion': it.get('product_name', 'Producto'),
                'iva':         21.0,
                'precio':      float(it.get('unit_price', 0)),
                'importe':     float(it.get('subtotal', 0)),
            })
        if not items_factura:
            items_factura = [{
                'cantidad':    1,
                'descripcion': 'Venta general',
                'iva':         21.0,
                'precio':      total,
                'importe':     total,
            }]

        factura = {
            # Emisor
            'cuit':               self.emisor.get('cuit', ''),
            'razon_social':       self.emisor.get('razon_social', ''),
            'domicilio':          self.emisor.get('domicilio', ''),
            'localidad':          self.emisor.get('localidad', ''),
            'telefono':           self.emisor.get('telefono', ''),
            'ing_brutos':         self.emisor.get('ing_brutos', ''),
            'inicio_actividades': self.emisor.get('inicio_actividades', ''),
            'condicion_iva':      self.emisor.get('condicion_iva', 'Resp. Inscripto'),
            # Comprobante
            'tipo_comprobante':   tipo,
            'punto_venta':        self.emisor.get('punto_venta', 1),
            'nro_comprobante':    nro,
            'fecha':              datetime.now().strftime('%d/%m/%Y %I:%M:%S %p'),
            'turno':              str(self.sale.get('id', '')).zfill(5),
            'pago':               self.pago_input.text().strip(),
            'modalidad':          self.modalidad_input.text().strip(),
            # Cliente
            'cliente':            cliente if not cuit_cliente else f'{cliente} — CUIT: {cuit_cliente}',
            # Items
            'items':              items_factura,
            # Totales
            'total':              total,
            'iva_contenido':      iva,
            'otros_impuestos':    0.0,
            # AFIP
            'cae':                cae,
            'vto_cae':            vto_cae,
        }

        try:
            gen = PDFGenerator()
            self.pdf_path = gen.generate_factura_afip_a4(factura)

            # Guardar en tabla facturas
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
                    datetime.now().isoformat(),
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
            self.accept()
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'Error al generar la factura:\n{str(e)}')
