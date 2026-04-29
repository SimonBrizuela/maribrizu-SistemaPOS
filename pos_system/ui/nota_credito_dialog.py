"""
Diálogo para emitir Nota de Crédito vinculada a una factura existente.

Flujo:
  1. Recibe la fila original de la tabla `facturas` (ya emitida con CAE).
  2. Muestra los datos del comprobante original como referencia (read-only).
  3. Permite elegir entre:
       - NC TOTAL: anula el total de la factura original.
       - NC PARCIAL: el usuario edita el monto a anular (debe ser <= total original).
  4. Pide motivo (texto corto que se guarda en notes/motivo_nc).
  5. Solicita CAE a AFIP (WSFE FECAESolicitar) pasando CbtesAsoc con el comprobante
     original en el campo correspondiente.
  6. Genera el PDF y persiste el registro en la tabla `facturas` con
     `tipo_comprobante='NOTA CRED. X'` y los campos `cbte_asoc_*`.
"""
import logging
from datetime import datetime

from PyQt5.QtCore import Qt, QThread, pyqtSignal
from PyQt5.QtGui import QFont
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QFormLayout, QLabel,
    QPushButton, QLineEdit, QPlainTextEdit, QFrame, QMessageBox,
    QDoubleSpinBox, QCheckBox, QApplication,
)

from pos_system.database.db_manager import DatabaseManager
from pos_system.utils.firebase_sync import now_ar

logger = logging.getLogger(__name__)


# Mapeo Factura → Nota de Crédito (mismo "tipo" A/B/C)
NC_DE_FACTURA = {
    'FAC. ELEC. A': 'NOTA CRED. A',
    'FAC. ELEC. B': 'NOTA CRED. B',
    'FAC. ELEC. C': 'NOTA CRED. C',
}


class _NCWorker(QThread):
    """Worker que solicita CAE en background para no congelar la UI."""
    ok   = pyqtSignal(dict)
    fail = pyqtSignal(object)

    def __init__(self, afip, tipo_nc, pv, total, neto, iva, otros,
                 cuit_rec, cond_iva_rec, cbtes_asoc):
        super().__init__()
        self.afip = afip
        self.tipo_nc = tipo_nc
        self.pv = pv
        self.total = total
        self.neto = neto
        self.iva = iva
        self.otros = otros
        self.cuit_rec = cuit_rec
        self.cond_iva_rec = cond_iva_rec
        self.cbtes_asoc = cbtes_asoc

    def run(self):
        try:
            ult = self.afip.ultimo_comprobante(self.tipo_nc, self.pv)
            nro = int(ult) + 1
            res = self.afip.solicitar_cae(
                tipo_comprobante=self.tipo_nc,
                punto_venta=self.pv,
                nro_comprobante=nro,
                importe_total=self.total,
                importe_neto_gravado=self.neto,
                importe_iva=self.iva,
                importe_otros=self.otros,
                concepto=1,
                cuit_receptor=self.cuit_rec,
                condicion_iva_receptor=self.cond_iva_rec,
                cbtes_asoc=self.cbtes_asoc,
            )
            self.ok.emit(res)
        except Exception as e:
            self.fail.emit(e)


class NotaCreditoDialog(QDialog):
    """
    Diálogo de Nota de Crédito vinculada a una factura ya emitida.

    Args:
        factura_orig: dict con la fila completa de la tabla `facturas`
                      (debe traer al menos: id, tipo_comprobante, punto_venta,
                      nro_comprobante, cliente, cuit_cliente, total,
                      iva_contenido, otros_impuestos).
        parent: widget padre.
    """

    def __init__(self, factura_orig: dict, parent=None, perfil: dict = None):
        super().__init__(parent)
        self.factura_orig = factura_orig or {}
        # Perfil ARCA con CUIT, cert, key, PV, etc. Si no viene, se cae a la
        # config global (afip_*) por compatibilidad.
        self.perfil = perfil or {}
        self.setWindowTitle('Emitir Nota de Crédito')
        self.setModal(True)
        self.setMinimumWidth(560)
        # Limitar alto al 85% de la pantalla para que en monitores chicos
        # entre cómodo (el contenido se scrollea, los botones quedan fijos).
        try:
            from PyQt5.QtWidgets import QApplication
            avail = QApplication.primaryScreen().availableGeometry()
            self.setMaximumHeight(int(avail.height() * 0.85))
        except Exception:
            pass
        self._worker = None
        self._build_ui()
        self._poblar_datos_originales()

    # ────────────────────────────────────── UI ──────────────────────────────────
    def _build_ui(self):
        # Layout root: scroll arriba (contenido) + botones fijos abajo.
        from PyQt5.QtWidgets import QScrollArea, QFrame as _QFrame, QWidget as _QWidget
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # Área scrolleable (todo el contenido va acá)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(_QFrame.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)

        body = _QWidget()
        layout = QVBoxLayout(body)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        # Título
        ttl = QLabel('Nota de Crédito')
        ttl.setFont(QFont('Segoe UI', 15, QFont.Bold))
        ttl.setStyleSheet('color: #c1521f;')
        layout.addWidget(ttl)

        sub = QLabel('Anula total o parcialmente una factura ya emitida.')
        sub.setFont(QFont('Segoe UI', 9))
        sub.setStyleSheet('color: #6f6a5d;')
        layout.addWidget(sub)
        # Guardamos refs para usar más abajo
        self._root_layout = root
        self._scroll_widget = scroll
        self._body_widget = body

        # ── Datos de la factura original (read-only) ────────────────────────
        orig_box = QFrame()
        orig_box.setStyleSheet(
            'QFrame { background:#fafaf7; border:1px solid #dcd6c8;'
            '         border-radius:8px; padding:8px; }'
        )
        ob = QFormLayout(orig_box)
        ob.setSpacing(4)

        self.lbl_tipo_orig    = QLabel('—')
        self.lbl_nro_orig     = QLabel('—')
        self.lbl_cliente_orig = QLabel('—')
        self.lbl_cuit_orig    = QLabel('—')
        self.lbl_fecha_orig   = QLabel('—')
        self.lbl_total_orig   = QLabel('—')
        self.lbl_cae_orig     = QLabel('—')
        for lbl in (self.lbl_tipo_orig, self.lbl_nro_orig, self.lbl_cliente_orig,
                    self.lbl_cuit_orig, self.lbl_fecha_orig, self.lbl_total_orig,
                    self.lbl_cae_orig):
            lbl.setFont(QFont('Segoe UI', 10))
            lbl.setStyleSheet('color:#1c1c1e; background:transparent; border:none;')

        ob.addRow(QLabel('<b>Comprobante original</b>'))
        ob.addRow('Tipo:',     self.lbl_tipo_orig)
        ob.addRow('Número:',   self.lbl_nro_orig)
        ob.addRow('Cliente:',  self.lbl_cliente_orig)
        ob.addRow('CUIT:',     self.lbl_cuit_orig)
        ob.addRow('Fecha:',    self.lbl_fecha_orig)
        ob.addRow('Total:',    self.lbl_total_orig)
        ob.addRow('CAE:',      self.lbl_cae_orig)
        layout.addWidget(orig_box)

        # ── Tipo de NC y total a anular ─────────────────────────────────────
        nc_box = QFrame()
        nc_box.setStyleSheet(
            'QFrame { background:#fff5f5; border:2px solid #a01616;'
            '         border-radius:8px; padding:10px; }'
        )
        nb = QFormLayout(nc_box)
        nb.setSpacing(8)

        self.lbl_tipo_nc = QLabel('—')
        self.lbl_tipo_nc.setFont(QFont('Segoe UI', 11, QFont.Bold))
        self.lbl_tipo_nc.setStyleSheet('color:#a01616;')
        nb.addRow('Tipo a emitir:', self.lbl_tipo_nc)

        # Checkbox: NC parcial
        self.chk_parcial = QCheckBox('NC parcial (anular un monto menor)')
        self.chk_parcial.setStyleSheet('color:#5a5448;')
        self.chk_parcial.toggled.connect(self._on_parcial_toggled)
        nb.addRow('', self.chk_parcial)

        # Spin del monto a anular
        self.sp_monto = QDoubleSpinBox()
        self.sp_monto.setDecimals(2)
        self.sp_monto.setMaximum(99_999_999.99)
        self.sp_monto.setMinimum(0.01)
        self.sp_monto.setSingleStep(100.0)
        self.sp_monto.setFont(QFont('Segoe UI', 12, QFont.Bold))
        self.sp_monto.setReadOnly(True)
        self.sp_monto.setButtonSymbols(QDoubleSpinBox.NoButtons)
        self.sp_monto.setStyleSheet(
            'QDoubleSpinBox { padding:6px 10px; background:#fafaf7; }'
            'QDoubleSpinBox:!read-only { background:#fff; border:2px solid #c1521f; }'
        )
        nb.addRow('Monto a anular:', self.sp_monto)

        # Motivo
        self.txt_motivo = QPlainTextEdit()
        self.txt_motivo.setPlaceholderText(
            'Ej: Devolución de mercadería, error de facturación, '
            'descuento posterior, etc.'
        )
        self.txt_motivo.setFont(QFont('Segoe UI', 10))
        self.txt_motivo.setFixedHeight(60)
        nb.addRow('Motivo:', self.txt_motivo)

        layout.addWidget(nc_box)

        # Estado/Status (dentro del scroll)
        self.lbl_status = QLabel('')
        self.lbl_status.setStyleSheet('color:#5a5448;')
        layout.addWidget(self.lbl_status)

        layout.addStretch(1)

        # Cerramos el scroll con el body
        self._scroll_widget.setWidget(self._body_widget)
        self._root_layout.addWidget(self._scroll_widget, 1)

        # ── Botones FIJOS abajo (fuera del scroll, siempre visibles) ──────
        from PyQt5.QtWidgets import QFrame as _QFrame
        btn_bar = _QFrame()
        btn_bar.setStyleSheet(
            'QFrame { background: #fafaf7; border-top: 1px solid #dcd6c8; }'
        )
        btn_row = QHBoxLayout(btn_bar)
        btn_row.setContentsMargins(16, 10, 16, 10)
        btn_row.addStretch()

        self.btn_cancel = QPushButton('Cancelar')
        self.btn_cancel.setMinimumHeight(40)
        self.btn_cancel.setFont(QFont('Segoe UI', 10))
        self.btn_cancel.setStyleSheet(
            'QPushButton { background:#fafaf7; color:#6f6a5d;'
            '              border:1px solid #dcd6c8; border-radius:8px; padding:0 18px; }'
            'QPushButton:hover { background:#ece8df; }'
        )
        self.btn_cancel.clicked.connect(self.reject)
        btn_row.addWidget(self.btn_cancel)

        self.btn_emit = QPushButton('Emitir Nota de Crédito')
        self.btn_emit.setMinimumHeight(40)
        self.btn_emit.setFont(QFont('Segoe UI', 11, QFont.Bold))
        self.btn_emit.setStyleSheet(
            'QPushButton { background:#a01616; color:white;'
            '              border:none; border-radius:8px; padding:0 22px; }'
            'QPushButton:hover { background:#7a1010; }'
            'QPushButton:disabled { background:#d6d2c8; color:#fafaf7; }'
        )
        self.btn_emit.clicked.connect(self._on_emitir)
        btn_row.addWidget(self.btn_emit)

        self._root_layout.addWidget(btn_bar)

    # ──────────────────────────── Datos originales ──────────────────────────
    def _poblar_datos_originales(self):
        f = self.factura_orig
        tipo_orig = f.get('tipo_comprobante', '') or ''
        pv = int(f.get('punto_venta') or 1)
        nro = int(f.get('nro_comprobante') or 0)
        total = float(f.get('total') or 0)
        cliente = str(f.get('cliente') or '')
        cuit_cli = str(f.get('cuit_cliente') or '')
        cae = str(f.get('cae') or '')

        self.lbl_tipo_orig.setText(tipo_orig or '—')
        self.lbl_nro_orig.setText(f'{pv:04d}-{nro:08d}')
        self.lbl_cliente_orig.setText(cliente or 'CONSUMIDOR FINAL')
        self.lbl_cuit_orig.setText(cuit_cli or '—')
        # Fecha del comprobante (created_at en general)
        try:
            from pos_system.ui.fiscal_view import _parse_ar
            fch = _parse_ar(f.get('created_at')).strftime('%d/%m/%Y %H:%M')
        except Exception:
            fch = str(f.get('created_at') or '')
        self.lbl_fecha_orig.setText(fch or '—')
        self.lbl_total_orig.setText(f'${total:,.2f}')
        self.lbl_cae_orig.setText(cae or '—')

        # Calcular tipo de NC correspondiente
        tipo_nc = NC_DE_FACTURA.get(tipo_orig.upper())
        if not tipo_nc:
            self.lbl_tipo_nc.setText(f'No reconocido ({tipo_orig})')
            self.btn_emit.setEnabled(False)
        else:
            self.lbl_tipo_nc.setText(tipo_nc)

        # Default del monto = total de la factura
        self.sp_monto.setValue(total)
        self.sp_monto.setMaximum(total if total > 0 else 99_999_999.99)

    def _on_parcial_toggled(self, checked: bool):
        self.sp_monto.setReadOnly(not checked)
        self.sp_monto.setButtonSymbols(
            QDoubleSpinBox.UpDownArrows if checked else QDoubleSpinBox.NoButtons
        )
        if not checked:
            # Volver al total completo
            self.sp_monto.setValue(float(self.factura_orig.get('total') or 0))

    # ──────────────────────────── Emisión ───────────────────────────────────
    def _on_emitir(self):
        f = self.factura_orig
        tipo_orig = f.get('tipo_comprobante', '') or ''
        tipo_nc = NC_DE_FACTURA.get(tipo_orig.upper())
        if not tipo_nc:
            QMessageBox.warning(self, 'Tipo no soportado',
                f'No se puede generar NC para "{tipo_orig}".')
            return

        monto = float(self.sp_monto.value())
        total_orig = float(f.get('total') or 0)
        if monto <= 0:
            QMessageBox.warning(self, 'Monto inválido',
                'El monto a anular debe ser mayor a cero.')
            return
        if monto > total_orig + 0.01:
            QMessageBox.warning(self, 'Monto excede el original',
                f'El monto (${monto:,.2f}) supera el total de la factura '
                f'original (${total_orig:,.2f}).')
            return

        motivo = self.txt_motivo.toPlainText().strip()

        # Confirmación
        es_parcial = monto < total_orig - 0.01
        kind = 'parcial' if es_parcial else 'total'
        resp = QMessageBox.question(
            self, 'Confirmar Nota de Crédito',
            f'¿Emitir Nota de Crédito {kind} por ${monto:,.2f}\n'
            f'sobre {tipo_orig} #{int(f.get("nro_comprobante") or 0):08d}?\n\n'
            f'Esta acción solicita CAE a AFIP y no se puede revertir.',
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No
        )
        if resp != QMessageBox.Yes:
            return

        # Calcular IVA y neto proporcional al monto (mismo ratio que la factura original)
        iva_orig   = float(f.get('iva_contenido') or 0)
        otros_orig = float(f.get('otros_impuestos') or 0)
        if total_orig > 0:
            ratio = monto / total_orig
        else:
            ratio = 1.0
        iva_nc   = round(iva_orig   * ratio, 2)
        otros_nc = round(otros_orig * ratio, 2)
        neto_nc  = round(monto - iva_nc - otros_nc, 2)

        # Buscar credenciales y emisor — primero del perfil ARCA, fallback a config global
        db = DatabaseManager()
        def cfg(key, default=''):
            res = db.execute_query("SELECT value FROM config WHERE key=?", (key,))
            return (res[0]['value'] or default) if res and res[0]['value'] else default

        p = self.perfil or {}
        cuit_emisor = (p.get('cuit') or cfg('afip_cuit') or '').strip()
        razon_em    = p.get('razon_social') or p.get('nombre') or cfg('afip_razon_social')
        domicilio_em= p.get('domicilio') or cfg('afip_domicilio')
        localidad_em= p.get('localidad') or cfg('afip_localidad')
        cond_iva_em = p.get('condicion_iva') or cfg('afip_condicion_iva', 'Responsable Inscripto')
        try:
            pv = int(p.get('punto_venta') or cfg('afip_punto_venta', '1') or '1')
        except (ValueError, TypeError):
            pv = 1
        cert_path   = (p.get('cert_path') or cfg('afip_cert_path') or '').strip()
        key_path    = (p.get('key_path')  or cfg('afip_key_path')  or '').strip()
        produccion  = bool(p.get('produccion')) if p else (cfg('afip_produccion', '0') == '1')

        if not cert_path or not key_path or not cuit_emisor:
            QMessageBox.warning(
                self, 'Configuración AFIP incompleta',
                'Para emitir Notas de Crédito a AFIP se requiere CUIT del\n'
                'emisor + certificado .crt + clave .key configurados.\n\n'
                'Revisalos en la pestaña "Configuracion AFIP".'
            )
            return

        # Cliente / condición IVA receptor (usamos lo que tenía la factura original
        # para que la NC sea coherente)
        cuit_cli = str(f.get('cuit_cliente') or '').strip() or None
        cond_iva_recep = self._inferir_cond_iva_receptor(tipo_orig, cuit_cli)

        # Comprobante asociado
        cbtes_asoc = [(tipo_orig, int(f.get('punto_venta') or 1),
                       int(f.get('nro_comprobante') or 0))]

        # Cliente WSFE
        try:
            from pos_system.utils.afip_wsfe import AfipWsfe
            afip = AfipWsfe(cuit=cuit_emisor, cert_path=cert_path,
                            key_path=key_path, produccion=produccion)
        except ImportError as e:
            QMessageBox.critical(self, 'Dependencia faltante', str(e))
            return
        except Exception as e:
            QMessageBox.critical(self, 'Error AFIP', f'No se pudo iniciar el cliente AFIP:\n{e}')
            return

        # UI: deshabilitar botones, lanzar worker
        self.btn_emit.setEnabled(False)
        self.btn_cancel.setEnabled(False)
        self.lbl_status.setText('Solicitando CAE a AFIP...')
        self.lbl_status.setStyleSheet('color:#a3441a; font-style:italic;')
        QApplication.processEvents()

        # Guardar contexto para el slot
        self._ctx = {
            'tipo_nc': tipo_nc, 'pv': pv, 'monto': monto,
            'iva': iva_nc, 'otros': otros_nc, 'neto': neto_nc,
            'cliente': str(f.get('cliente') or 'CONSUMIDOR FINAL'),
            'cuit_cli': cuit_cli or '',
            'cond_iva_recep': cond_iva_recep, 'cbtes_asoc': cbtes_asoc,
            'motivo': motivo, 'sale_id': f.get('sale_id'),
            'cuit_emisor': cuit_emisor, 'razon_em': razon_em,
            'domicilio_em': domicilio_em, 'localidad_em': localidad_em,
            'cond_iva_em': cond_iva_em,
        }

        self._worker = _NCWorker(
            afip, tipo_nc, pv, monto, neto_nc, iva_nc, otros_nc,
            cuit_cli, cond_iva_recep, cbtes_asoc,
        )
        self._worker.ok.connect(self._on_cae_ok)
        self._worker.fail.connect(self._on_cae_fail)
        self._worker.start()

    @staticmethod
    def _inferir_cond_iva_receptor(tipo_orig: str, cuit_cli: str) -> str:
        """Para preservar coherencia: si la factura original era A, el receptor era
        Resp. Inscripto / Monotributista; si era B, Cons. Final con CUIT; si era C,
        Cons. Final."""
        t = (tipo_orig or '').upper()
        if 'A' in t.split()[-1]:
            return 'Responsable Inscripto'
        if cuit_cli:
            return 'Responsable Inscripto'
        return 'Consumidor Final'

    def _on_cae_ok(self, resultado: dict):
        ctx = self._ctx
        cae = resultado.get('cae', '')
        vto = resultado.get('vto_cae', '')
        nro_real = int(resultado.get('nro_comprobante') or 0)

        # Persistir en DB
        try:
            db = DatabaseManager()
            db.execute_update(
                """INSERT INTO facturas
                   (sale_id, tipo_comprobante, punto_venta, nro_comprobante, fecha,
                    cliente, cuit_cliente, cae, vto_cae, total, iva_contenido,
                    otros_impuestos, pdf_path,
                    cbte_asoc_tipo, cbte_asoc_pv, cbte_asoc_nro, motivo_nc)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (ctx['sale_id'], ctx['tipo_nc'], ctx['pv'], nro_real,
                 now_ar().isoformat(), ctx['cliente'], ctx['cuit_cli'],
                 cae, vto, ctx['monto'], ctx['iva'], ctx['otros'], '',
                 self.factura_orig.get('tipo_comprobante', ''),
                 int(self.factura_orig.get('punto_venta') or 0),
                 int(self.factura_orig.get('nro_comprobante') or 0),
                 ctx['motivo'])
            )
        except Exception as e:
            logger.exception('NC: error persistiendo en DB')
            QMessageBox.warning(self, 'NC emitida (DB error)',
                f'AFIP otorgó CAE pero falló el guardado local:\n{e}\n\n'
                f'CAE: {cae}\nVto: {vto}\nNro: {nro_real}')
            self.accept()
            return

        # Generar PDF
        pdf_path = ''
        try:
            from pos_system.utils.pdf_generator import PDFGenerator
            factura_dict = {
                'cuit':              ctx['cuit_emisor'],
                'razon_social':      ctx['razon_em'],
                'domicilio':         ctx['domicilio_em'],
                'localidad':         ctx['localidad_em'],
                'condicion_iva':     ctx['cond_iva_em'],
                'tipo_comprobante':  ctx['tipo_nc'],
                'tipo_comprobante_nombre': 'NOTA DE CREDITO',
                'punto_venta':       ctx['pv'],
                'nro_comprobante':   nro_real,
                'fecha':             now_ar().strftime('%d/%m/%Y'),
                'cliente':           ctx['cliente'],
                'cuit_receptor':     ctx['cuit_cli'],
                'condicion_iva_receptor': ctx['cond_iva_recep'],
                'concepto':          1,
                'items': [{
                    'descripcion': (
                        f'Nota de Crédito s/ {self.factura_orig.get("tipo_comprobante", "")} '
                        f'#{int(self.factura_orig.get("punto_venta") or 0):04d}-'
                        f'{int(self.factura_orig.get("nro_comprobante") or 0):08d}'
                        + (f' — {ctx["motivo"]}' if ctx['motivo'] else '')
                    ),
                    'cantidad': 1,
                    'precio_unitario': ctx['monto'],
                    'subtotal': ctx['monto'],
                }],
                'total':           ctx['monto'],
                'iva_contenido':   ctx['iva'],
                'otros_impuestos': ctx['otros'],
                'cae':             cae,
                'vto_cae':         vto,
                'cbte_asoc_tipo':  self.factura_orig.get('tipo_comprobante', ''),
                'cbte_asoc_pv':    int(self.factura_orig.get('punto_venta') or 0),
                'cbte_asoc_nro':   int(self.factura_orig.get('nro_comprobante') or 0),
                'motivo_nc':       ctx['motivo'],
            }
            gen = PDFGenerator()
            pdf_path = gen.generate_factura_afip_a4(factura_dict)
            db.execute_update(
                "UPDATE facturas SET pdf_path=? WHERE tipo_comprobante=? "
                "AND punto_venta=? AND nro_comprobante=?",
                (pdf_path, ctx['tipo_nc'], ctx['pv'], nro_real)
            )
        except Exception as e:
            logger.exception('NC: error generando PDF')
            QMessageBox.warning(self, 'NC emitida (PDF error)',
                f'AFIP otorgó CAE y se guardó la NC, pero falló el PDF:\n{e}\n\n'
                f'CAE: {cae}')
            self.pdf_path = ''
            self.accept()
            return

        self.pdf_path = pdf_path
        self.lbl_status.setText('NC emitida correctamente.')
        self.lbl_status.setStyleSheet('color:#3d7a3a; font-weight:bold;')
        QMessageBox.information(
            self, 'Nota de Crédito emitida',
            f'NC {ctx["tipo_nc"]} #{ctx["pv"]:04d}-{nro_real:08d} '
            f'por ${ctx["monto"]:,.2f}.\n\nCAE: {cae}\nVencimiento: {vto}'
        )
        self.accept()

    def _on_cae_fail(self, exc):
        self.btn_emit.setEnabled(True)
        self.btn_cancel.setEnabled(True)
        self.lbl_status.setText('')
        try:
            from pos_system.utils.afip_error_reporter import report_afip_error
            report_afip_error(exc, {
                'etapa': 'nota_credito_dialog.solicitar_cae',
                'tipo_nc': self._ctx.get('tipo_nc', ''),
                'pv': self._ctx.get('pv', 0),
                'cuit_emisor': self._ctx.get('cuit_emisor', ''),
                'cuit_receptor': self._ctx.get('cuit_cli', ''),
                'monto': self._ctx.get('monto', 0),
                'cbtes_asoc': self._ctx.get('cbtes_asoc', []),
            })
        except Exception:
            pass
        logger.exception('NC: error AFIP')
        QMessageBox.critical(self, 'Error AFIP', f'AFIP rechazo la Nota de Credito:\n\n{exc}')
