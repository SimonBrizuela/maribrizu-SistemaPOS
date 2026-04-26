"""
Diálogo para seleccionar o crear un cliente de facturación.
Los clientes se guardan en la tabla local clientes_facturacion y se sincronizan con Firebase.
"""
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QFrame, QScrollArea, QWidget, QSizePolicy, QFormLayout,
    QLineEdit, QComboBox, QMessageBox, QApplication
)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont


class ClientePerfilDialog(QDialog):
    """
    Permite seleccionar un cliente existente o crear uno nuevo.

    Resultado:
        - self.selected_cliente: dict con datos del cliente (o None)
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self.selected_cliente = None
        self._clientes = []
        self._load_clientes()
        self._setup_ui()

    def _load_clientes(self):
        try:
            from pos_system.database.db_manager import DatabaseManager
            db = DatabaseManager()
            self._clientes = db.execute_query(
                "SELECT * FROM clientes_facturacion WHERE activo=1 ORDER BY nombre ASC"
            )
        except Exception:
            self._clientes = []

    def _setup_ui(self):
        self.setWindowTitle('Seleccionar Cliente')
        self.setModal(True)
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowContextHelpButtonHint)
        self.setMinimumWidth(480)

        main = QVBoxLayout(self)
        main.setSpacing(12)
        main.setContentsMargins(20, 18, 20, 18)

        # Título
        title = QLabel('¿A nombre de quién facturar?')
        title.setFont(QFont('Segoe UI', 13, QFont.Bold))
        title.setAlignment(Qt.AlignCenter)
        main.addWidget(title)

        sub = QLabel('Seleccioná un cliente guardado o ingresá uno nuevo')
        sub.setFont(QFont('Segoe UI', 9))
        sub.setAlignment(Qt.AlignCenter)
        sub.setStyleSheet('color: #6f6a5d;')
        main.addWidget(sub)

        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet('background:#dcd6c8; max-height:1px;')
        main.addWidget(sep)

        # ── Lista de clientes guardados ───────────────────────────────────────
        if self._clientes:
            lbl = QLabel('Clientes guardados:')
            lbl.setFont(QFont('Segoe UI', 9, QFont.Bold))
            lbl.setStyleSheet('color: #5a5448;')
            main.addWidget(lbl)

            scroll = QScrollArea()
            scroll.setWidgetResizable(True)
            scroll.setFrameShape(QFrame.NoFrame)
            scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)
            scroll.setMaximumHeight(220)

            cards_widget = QWidget()
            cards_layout = QVBoxLayout(cards_widget)
            cards_layout.setSpacing(6)
            cards_layout.setContentsMargins(0, 0, 0, 0)

            colors = [
                ('#c1521f', '#a3441a'),
                ('#c1521f', '#a3441a'),
                ('#a01616', '#7f1212'),
                ('#c1521f', '#dc6502'),
                ('#3d7a3a', '#2f5e2c'),
                ('#c1521f', '#a3441a'),
            ]

            for i, c in enumerate(self._clientes):
                color_bg, color_hv = colors[i % len(colors)]
                nombre = c.get('nombre', '—')
                cuit = c.get('cuit', '') or ''
                razon = c.get('razon_social', '') or ''
                sub_txt = ''
                if razon and razon != nombre:
                    sub_txt = f'{razon}'
                if cuit:
                    sub_txt = (sub_txt + f'  CUIT: {cuit}').strip()

                btn = QPushButton()
                btn.setCursor(Qt.PointingHandCursor)
                btn.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
                btn.setFixedHeight(52)

                layout = QHBoxLayout(btn)
                layout.setContentsMargins(14, 0, 14, 0)
                layout.setSpacing(10)

                icon = QLabel('')
                icon.setFont(QFont('Segoe UI', 16))
                icon.setStyleSheet('background:transparent; color:white;')
                layout.addWidget(icon)

                info = QVBoxLayout()
                info.setSpacing(0)
                n_lbl = QLabel(nombre)
                n_lbl.setFont(QFont('Segoe UI', 10, QFont.Bold))
                n_lbl.setStyleSheet('background:transparent; color:white;')
                info.addWidget(n_lbl)
                if sub_txt:
                    s_lbl = QLabel(sub_txt)
                    s_lbl.setFont(QFont('Segoe UI', 8))
                    s_lbl.setStyleSheet('background:transparent; color:rgba(255,255,255,0.85);')
                    info.addWidget(s_lbl)
                layout.addLayout(info)
                layout.addStretch()

                btn.setStyleSheet(f'''
                    QPushButton {{
                        background: {color_bg};
                        border: none;
                        border-radius: 10px;
                    }}
                    QPushButton:hover {{ background: {color_hv}; }}
                    QPushButton:pressed {{
                        background: {color_hv};
                        border: 2px solid rgba(255,255,255,0.4);
                    }}
                ''')
                btn.clicked.connect(lambda _, cli=c: self._select(cli))
                cards_layout.addWidget(btn)

            scroll.setWidget(cards_widget)
            main.addWidget(scroll)

            sep2 = QFrame()
            sep2.setFrameShape(QFrame.HLine)
            sep2.setStyleSheet('background:#dcd6c8; max-height:1px;')
            main.addWidget(sep2)

        # ── Formulario nuevo cliente ──────────────────────────────────────────
        nuevo_lbl = QLabel('Nuevo cliente:' if self._clientes else 'Ingresar datos del cliente:')
        nuevo_lbl.setFont(QFont('Segoe UI', 9, QFont.Bold))
        nuevo_lbl.setStyleSheet('color: #5a5448;')
        main.addWidget(nuevo_lbl)

        form = QFormLayout()
        form.setSpacing(8)

        self.nombre_input = QLineEdit()
        self.nombre_input.setPlaceholderText('Nombre comercial *')
        self.nombre_input.setMinimumHeight(34)
        self.nombre_input.setFont(QFont('Segoe UI', 10))
        form.addRow('Nombre:', self.nombre_input)

        self.razon_social_input = QLineEdit()
        self.razon_social_input.setPlaceholderText('Razón Social legal (se autocompleta con Buscar AFIP)')
        self.razon_social_input.setMinimumHeight(34)
        self.razon_social_input.setFont(QFont('Segoe UI', 10))
        form.addRow('Razón Social:', self.razon_social_input)

        cuit_row = QHBoxLayout()
        self.cuit_input = QLineEdit()
        self.cuit_input.setPlaceholderText('20123456789 (vacio = Consumidor Final)')
        self.cuit_input.setMinimumHeight(34)
        self.cuit_input.setFont(QFont('Segoe UI', 10))
        cuit_row.addWidget(self.cuit_input)
        self._buscar_btn = QPushButton('Buscar AFIP')
        self._buscar_btn.setMinimumHeight(34)
        self._buscar_btn.setFont(QFont('Segoe UI', 9))
        self._buscar_btn.setStyleSheet('''
            QPushButton {
                background: #c1521f; color: white; border: none;
                border-radius: 6px; padding: 0 10px;
            }
            QPushButton:hover { background: #a3441a; }
            QPushButton:disabled { background: #9b958a; }
        ''')
        self._buscar_btn.setCursor(Qt.PointingHandCursor)
        self._buscar_btn.clicked.connect(self._buscar_cuit_afip)
        cuit_row.addWidget(self._buscar_btn)
        form.addRow('CUIT:', cuit_row)

        self.domicilio_input = QLineEdit()
        self.domicilio_input.setPlaceholderText('Dirección (opcional)')
        self.domicilio_input.setMinimumHeight(34)
        self.domicilio_input.setFont(QFont('Segoe UI', 10))
        form.addRow('Domicilio:', self.domicilio_input)

        self.condicion_combo = QComboBox()
        self.condicion_combo.setMinimumHeight(34)
        self.condicion_combo.setFont(QFont('Segoe UI', 10))
        self.condicion_combo.addItems([
            'Consumidor Final', 'Responsable Inscripto',
            'Monotributista', 'Exento'
        ])
        form.addRow('Condición IVA:', self.condicion_combo)

        self.guardar_check = QPushButton('[ ] Guardar para la próxima vez')
        self.guardar_check.setCheckable(True)
        self.guardar_check.setChecked(False)
        self.guardar_check.setFont(QFont('Segoe UI', 9))
        self.guardar_check.setStyleSheet('''
            QPushButton {
                background: transparent; border: 1px solid #dcd6c8;
                border-radius: 6px; padding: 6px 10px; color: #5a5448; text-align: left;
            }
            QPushButton:checked {
                background: #fbeee5; border-color: #dcd6c8; color: #c1521f;
            }
        ''')
        self.guardar_check.clicked.connect(self._toggle_guardar_text)
        form.addRow('', self.guardar_check)

        main.addLayout(form)

        # ── Botones ───────────────────────────────────────────────────────────
        sep3 = QFrame()
        sep3.setFrameShape(QFrame.HLine)
        sep3.setStyleSheet('background:#dcd6c8; max-height:1px;')
        main.addWidget(sep3)

        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)

        cancel_btn = QPushButton('Cancelar')
        cancel_btn.setMinimumHeight(38)
        cancel_btn.setFont(QFont('Segoe UI', 10))
        cancel_btn.setStyleSheet('''
            QPushButton {
                background:transparent; border:1px solid #dcd6c8;
                border-radius:8px; color:#6f6a5d;
            }
            QPushButton:hover { background:#fafaf7; color:#5a5448; }
        ''')
        cancel_btn.clicked.connect(self.reject)
        btn_row.addWidget(cancel_btn)

        ok_btn = QPushButton('Usar este cliente')
        ok_btn.setMinimumHeight(40)
        ok_btn.setFont(QFont('Segoe UI', 11, QFont.Bold))
        ok_btn.setStyleSheet('''
            QPushButton {
                background:#c1521f; color:white;
                border:none; border-radius:8px;
            }
            QPushButton:hover { background:#a3441a; }
        ''')
        ok_btn.clicked.connect(self._use_new)
        btn_row.addWidget(ok_btn, 2)

        main.addLayout(btn_row)

    def _buscar_cuit_afip(self):
        """Consulta datos del CUIT al padrón oficial AFIP (ws_sr_constancia_inscripcion)
        usando el cert del perfil activo. Autocompleta nombre, razón social,
        domicilio y condición IVA."""
        cuit_raw = self.cuit_input.text().strip().replace('-', '').replace(' ', '')
        if len(cuit_raw) != 11 or not cuit_raw.isdigit():
            QMessageBox.warning(self, 'CUIT incompleto', 'Ingresa un CUIT de 11 digitos.')
            return

        self._buscar_btn.setEnabled(False)
        self._buscar_btn.setText('Buscando...')
        QApplication.processEvents()

        try:
            # Levantar el perfil activo con cert para autenticar en el padrón
            from pos_system.database.db_manager import DatabaseManager
            from pos_system.utils.afip_wsfe import AFIPPadron
            db = DatabaseManager()
            cfg = db.execute_query("SELECT value FROM config WHERE key='emisor_activo_id'")
            emisor_id = cfg[0]['value'] if cfg and cfg[0].get('value') else ''
            perfil = None
            if emisor_id:
                r = db.execute_query(
                    "SELECT * FROM perfiles_facturacion WHERE firebase_id=? AND activo=1",
                    (emisor_id,)
                )
                if r: perfil = r[0]
            if not perfil:
                r = db.execute_query(
                    "SELECT * FROM perfiles_facturacion "
                    "WHERE activo=1 AND LENGTH(cuit) >= 10 "
                    "ORDER BY updated_at DESC LIMIT 1"
                )
                if r: perfil = r[0]
            if not perfil or not perfil.get('cert_path') or not perfil.get('key_path'):
                QMessageBox.warning(
                    self, 'Sin certificado AFIP',
                    'No hay perfil AFIP con certificado cargado.\nCompletá los datos manualmente.'
                )
                return

            padron = AFIPPadron(
                cuit=perfil['cuit'],
                cert_path=perfil['cert_path'],
                key_path=perfil['key_path'],
                produccion=bool(perfil['produccion']),
            )
            data = padron.consultar(cuit_raw)
            if not data:
                QMessageBox.warning(
                    self, 'No encontrado',
                    f'No se encontraron datos para el CUIT {cuit_raw}.\nVerifica que sea correcto.'
                )
                return

            razon = (data.get('razon_social') or '').strip()
            dom   = (data.get('domicilio') or '').strip()
            loc   = (data.get('localidad') or '').strip()
            cond  = (data.get('condicion_iva') or '').strip()

            if razon:
                self.nombre_input.setText(razon)
                self.razon_social_input.setText(razon)
            if dom:
                self.domicilio_input.setText(f'{dom} - {loc}' if loc else dom)
            if cond:
                idx = self.condicion_combo.findText(cond)
                if idx >= 0:
                    self.condicion_combo.setCurrentIndex(idx)

        except Exception as e:
            QMessageBox.warning(
                self, 'No se pudo consultar',
                f'Error consultando padron AFIP.\n\nDetalle: {e}'
            )
        finally:
            self._buscar_btn.setEnabled(True)
            self._buscar_btn.setText('Buscar AFIP')

    def _toggle_guardar_text(self):
        if self.guardar_check.isChecked():
            self.guardar_check.setText('[X] Guardar para la próxima vez')
        else:
            self.guardar_check.setText('[ ] Guardar para la próxima vez')

    def _select(self, cliente: dict):
        self.selected_cliente = {
            'nombre':       cliente.get('nombre', ''),
            'razon_social': cliente.get('razon_social', ''),
            'cuit':         cliente.get('cuit', ''),
            'domicilio':    cliente.get('domicilio', ''),
            'localidad':    cliente.get('localidad', ''),
            'condicion_iva': cliente.get('condicion_iva', 'Consumidor Final'),
        }
        self.accept()

    def _use_new(self):
        nombre = self.nombre_input.text().strip()
        if not nombre:
            QMessageBox.warning(self, 'Nombre requerido', 'Ingresá al menos el nombre del cliente.')
            return

        razon = self.razon_social_input.text().strip() or nombre
        self.selected_cliente = {
            'nombre':       nombre,
            'razon_social': razon,
            'cuit':         self.cuit_input.text().strip(),
            'domicilio':    self.domicilio_input.text().strip(),
            'localidad':    '',
            'condicion_iva': self.condicion_combo.currentText(),
        }

        if self.guardar_check.isChecked():
            self._save_new_cliente()

        self.accept()

    def _save_new_cliente(self):
        """Guarda el cliente en la BD local y lo sube a Firebase."""
        try:
            from pos_system.database.db_manager import DatabaseManager
            db = DatabaseManager()
            new_id = db.execute_update(
                """INSERT INTO clientes_facturacion
                   (nombre, razon_social, cuit, domicilio, localidad, condicion_iva, activo)
                   VALUES (?, ?, ?, ?, ?, ?, 1)""",
                (
                    self.selected_cliente['nombre'],
                    self.selected_cliente['razon_social'],
                    self.selected_cliente['cuit'],
                    self.selected_cliente['domicilio'],
                    self.selected_cliente['localidad'],
                    self.selected_cliente['condicion_iva'],
                )
            )

            # Sincronizar con Firebase en segundo plano
            try:
                from pos_system.utils.firebase_sync import get_firebase_sync
                fb = get_firebase_sync()
                if fb and fb.enabled:
                    import threading
                    threading.Thread(
                        target=lambda: fb.sync_clientes(db), daemon=True
                    ).start()
            except Exception:
                pass

        except Exception as e:
            QMessageBox.warning(
                self, 'Aviso',
                f'El cliente se usará en la factura pero no pudo guardarse: {e}'
            )
