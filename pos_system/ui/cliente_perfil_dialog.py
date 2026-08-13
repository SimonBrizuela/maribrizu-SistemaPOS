"""
Diálogo para seleccionar o crear un cliente de facturación.
Los clientes se guardan en la tabla local clientes_facturacion y se sincronizan con Firebase.

La lista se filtra tipeando: nombre, razón social o CUIT. Antes eran tarjetas de
colores apiladas una abajo de la otra, que con treinta clientes obligaba a bajar
con la rueda buscando a ojo y empujaba el formulario fuera de la pantalla. Ahora
la lista tiene alto fijo con su propio scroll, el formulario de alta arranca
plegado y los últimos clientes usados van arriba de todo: facturar dos veces al
mismo es lo que más pasa en el mostrador.
"""
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QFrame, QWidget, QFormLayout, QListWidget, QListWidgetItem,
    QLineEdit, QComboBox, QMessageBox, QApplication, QStyledItemDelegate, QStyle
)
from PyQt5.QtCore import Qt, QSize
from PyQt5.QtGui import QFont, QColor, QPen

# Paleta del sistema (tema Graphite)
_ACENTO      = '#c1521f'
_ACENTO_HOVER = '#a3441a'
_BORDE       = '#dcd6c8'
_TEXTO       = '#3d3831'
_TEXTO_SUAVE = '#6f6a5d'
_TINTE       = '#fbeee5'


class _FilaClienteDelegate(QStyledItemDelegate):
    """Dibuja cada cliente en dos renglones: el nombre y, abajo, el dato fiscal.

    Con una sola línea el CUIT quedaba pegado al nombre y no se podía barrer la
    lista de un vistazo, que es justo lo que hace falta cuando hay alguien
    esperando del otro lado del mostrador.
    """

    ALTO = 50

    def sizeHint(self, option, index):
        return QSize(option.rect.width(), self.ALTO)

    def paint(self, painter, option, index):
        painter.save()
        rect = option.rect
        seleccionado = bool(option.state & QStyle.State_Selected)
        hover = bool(option.state & QStyle.State_MouseOver)

        if seleccionado:
            painter.fillRect(rect, QColor(_TINTE))
            painter.setPen(QPen(QColor(_ACENTO), 2))
            painter.drawLine(rect.left(), rect.top() + 1, rect.left(), rect.bottom() - 1)
        elif hover:
            painter.fillRect(rect, QColor('#faf8f4'))

        painter.setPen(QPen(QColor(_BORDE), 1))
        painter.drawLine(rect.left() + 12, rect.bottom(), rect.right() - 12, rect.bottom())

        nombre = index.data(Qt.DisplayRole) or ''
        detalle = index.data(Qt.UserRole + 1) or ''
        condicion = index.data(Qt.UserRole + 2) or ''

        x = rect.left() + 14
        painter.setPen(QColor(_TEXTO))
        f = QFont('Segoe UI', 10, QFont.Bold)
        painter.setFont(f)
        painter.drawText(x, rect.top() + 8, rect.width() - 150, 18,
                         Qt.AlignLeft | Qt.AlignVCenter, nombre)

        painter.setPen(QColor(_TEXTO_SUAVE))
        painter.setFont(QFont('Segoe UI', 8))
        painter.drawText(x, rect.top() + 26, rect.width() - 150, 16,
                         Qt.AlignLeft | Qt.AlignVCenter, detalle)

        if condicion:
            painter.setPen(QColor(_TEXTO_SUAVE))
            painter.setFont(QFont('Segoe UI', 8))
            painter.drawText(rect.right() - 150, rect.top(), 138, rect.height(),
                             Qt.AlignRight | Qt.AlignVCenter, condicion)
        painter.restore()


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
            # Los últimos usados primero: facturar de nuevo al mismo cliente es
            # lo más común, y así queda a un golpe de vista sin buscar nada.
            self._clientes = db.execute_query(
                "SELECT * FROM clientes_facturacion WHERE activo=1 "
                "ORDER BY COALESCE(ultimo_uso, '') DESC, nombre ASC"
            )
        except Exception:
            try:
                from pos_system.database.db_manager import DatabaseManager
                self._clientes = DatabaseManager().execute_query(
                    "SELECT * FROM clientes_facturacion WHERE activo=1 ORDER BY nombre ASC"
                )
            except Exception:
                self._clientes = []

    # ── Armado de la ventana ────────────────────────────────────────────────
    def _setup_ui(self):
        self.setWindowTitle('Seleccionar Cliente')
        self.setModal(True)
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowContextHelpButtonHint)
        self.setMinimumWidth(560)

        main = QVBoxLayout(self)
        main.setSpacing(10)
        main.setContentsMargins(20, 16, 20, 16)

        title = QLabel('¿A nombre de quién facturar?')
        title.setFont(QFont('Segoe UI', 13, QFont.Bold))
        title.setStyleSheet(f'color:{_TEXTO};')
        main.addWidget(title)

        if self._clientes:
            self._armar_buscador(main)
            self._armar_lista(main)

        self._armar_formulario(main)
        self._armar_botones(main)

        if self._clientes:
            self.buscador.setFocus()
        else:
            self.nombre_input.setFocus()

    def _armar_buscador(self, main):
        self.buscador = QLineEdit()
        self.buscador.setPlaceholderText('Buscar por nombre, razón social o CUIT…')
        self.buscador.setMinimumHeight(38)
        self.buscador.setFont(QFont('Segoe UI', 10))
        self.buscador.setClearButtonEnabled(True)
        self.buscador.setStyleSheet(f'''
            QLineEdit {{
                border: 1.5px solid {_BORDE}; border-radius: 8px;
                padding: 0 12px; background: white; color: {_TEXTO};
            }}
            QLineEdit:focus {{ border-color: {_ACENTO}; }}
        ''')
        self.buscador.textChanged.connect(self._filtrar)
        # Enter en el buscador toma el primero de la lista; las flechas bajan a
        # ella sin sacar las manos del teclado.
        self.buscador.returnPressed.connect(self._usar_seleccionado)
        self.buscador.installEventFilter(self)
        main.addWidget(self.buscador)

        self.contador = QLabel('')
        self.contador.setFont(QFont('Segoe UI', 8))
        self.contador.setStyleSheet(f'color:{_TEXTO_SUAVE};')
        main.addWidget(self.contador)

    def _armar_lista(self, main):
        self.lista = QListWidget()
        self.lista.setItemDelegate(_FilaClienteDelegate(self.lista))
        self.lista.setFixedHeight(260)
        self.lista.setMouseTracking(True)
        self.lista.setFrameShape(QFrame.NoFrame)
        self.lista.setStyleSheet(f'''
            QListWidget {{
                border: 1.5px solid {_BORDE}; border-radius: 10px;
                background: white; outline: none;
            }}
            QScrollBar:vertical {{
                background: transparent; width: 10px; margin: 4px 2px;
            }}
            QScrollBar::handle:vertical {{
                background: #cfc8b8; border-radius: 5px; min-height: 28px;
            }}
            QScrollBar::handle:vertical:hover {{ background: #b8b0a0; }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
            QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}
        ''')
        self.lista.itemActivated.connect(lambda _i: self._usar_seleccionado())
        self.lista.itemDoubleClicked.connect(lambda _i: self._usar_seleccionado())
        main.addWidget(self.lista)

        self._llenar_lista(self._clientes)

    def _llenar_lista(self, clientes):
        self.lista.clear()
        for c in clientes:
            nombre = c.get('nombre') or '—'
            razon = (c.get('razon_social') or '').strip()
            cuit = (c.get('cuit') or '').strip()
            partes = []
            if razon and razon.upper() != nombre.upper():
                partes.append(razon)
            partes.append(f'CUIT {cuit}' if cuit else 'Sin CUIT')

            item = QListWidgetItem(nombre)
            item.setData(Qt.UserRole, c)
            item.setData(Qt.UserRole + 1, '  ·  '.join(partes))
            item.setData(Qt.UserRole + 2, c.get('condicion_iva') or '')
            self.lista.addItem(item)

        if self.lista.count():
            self.lista.setCurrentRow(0)

        total = len(self._clientes)
        vistos = len(clientes)
        self.contador.setText(
            f'{total} cliente{"s" if total != 1 else ""} guardado{"s" if total != 1 else ""}'
            if vistos == total else f'{vistos} de {total} clientes'
        )

    def _armar_formulario(self, main):
        # Plegado: la mayoría de las veces se factura a alguien ya guardado, y
        # el formulario abierto empujaba la lista fuera de la pantalla.
        self.nuevo_btn = QPushButton('+  Facturar a un cliente nuevo')
        self.nuevo_btn.setCheckable(True)
        self.nuevo_btn.setChecked(not self._clientes)
        self.nuevo_btn.setCursor(Qt.PointingHandCursor)
        self.nuevo_btn.setMinimumHeight(34)
        self.nuevo_btn.setFont(QFont('Segoe UI', 9, QFont.Bold))
        self.nuevo_btn.setStyleSheet(f'''
            QPushButton {{
                background: transparent; border: 1.5px dashed {_BORDE};
                border-radius: 8px; color: {_TEXTO_SUAVE}; text-align: left;
                padding: 0 12px;
            }}
            QPushButton:hover {{ background: #faf8f4; color: {_TEXTO}; }}
            QPushButton:checked {{
                background: {_TINTE}; border-style: solid;
                border-color: {_ACENTO}; color: {_ACENTO};
            }}
        ''')
        self.nuevo_btn.clicked.connect(self._toggle_nuevo)
        main.addWidget(self.nuevo_btn)

        self.form_wrap = QWidget()
        form = QFormLayout(self.form_wrap)
        form.setSpacing(8)
        form.setContentsMargins(0, 8, 0, 0)

        def _campo(placeholder):
            e = QLineEdit()
            e.setPlaceholderText(placeholder)
            e.setMinimumHeight(34)
            e.setFont(QFont('Segoe UI', 10))
            return e

        self.nombre_input = _campo('Nombre comercial *')
        form.addRow('Nombre:', self.nombre_input)

        self.razon_social_input = _campo('Razón Social legal (se autocompleta con Buscar AFIP)')
        form.addRow('Razón Social:', self.razon_social_input)

        cuit_row = QHBoxLayout()
        self.cuit_input = _campo('20123456789 (vacío = Consumidor Final)')
        cuit_row.addWidget(self.cuit_input)
        self._buscar_btn = QPushButton('Buscar AFIP')
        self._buscar_btn.setMinimumHeight(34)
        self._buscar_btn.setFont(QFont('Segoe UI', 9))
        self._buscar_btn.setStyleSheet(f'''
            QPushButton {{
                background: {_ACENTO}; color: white; border: none;
                border-radius: 6px; padding: 0 10px;
            }}
            QPushButton:hover {{ background: {_ACENTO_HOVER}; }}
            QPushButton:disabled {{ background: #9b958a; }}
        ''')
        self._buscar_btn.setCursor(Qt.PointingHandCursor)
        self._buscar_btn.clicked.connect(self._buscar_cuit_afip)
        cuit_row.addWidget(self._buscar_btn)
        form.addRow('CUIT:', cuit_row)

        self.domicilio_input = _campo('Dirección (opcional)')
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
        self.guardar_check.setChecked(True)
        self.guardar_check.setText('[X] Guardar para la próxima vez')
        self.guardar_check.setFont(QFont('Segoe UI', 9))
        self.guardar_check.setCursor(Qt.PointingHandCursor)
        self.guardar_check.setStyleSheet(f'''
            QPushButton {{
                background: transparent; border: 1px solid {_BORDE};
                border-radius: 6px; padding: 6px 10px; color: {_TEXTO_SUAVE};
                text-align: left;
            }}
            QPushButton:checked {{
                background: {_TINTE}; border-color: {_BORDE}; color: {_ACENTO};
            }}
        ''')
        self.guardar_check.clicked.connect(self._toggle_guardar_text)
        form.addRow('', self.guardar_check)

        self.form_wrap.setVisible(self.nuevo_btn.isChecked())
        main.addWidget(self.form_wrap)

    def _armar_botones(self, main):
        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet(f'background:{_BORDE}; max-height:1px;')
        main.addWidget(sep)

        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)

        cancel_btn = QPushButton('Cancelar')
        cancel_btn.setMinimumHeight(38)
        cancel_btn.setMinimumWidth(110)
        cancel_btn.setFont(QFont('Segoe UI', 10))
        cancel_btn.setCursor(Qt.PointingHandCursor)
        cancel_btn.setStyleSheet(f'''
            QPushButton {{
                background:transparent; border:1px solid {_BORDE};
                border-radius:8px; color:{_TEXTO_SUAVE};
            }}
            QPushButton:hover {{ background:#fafaf7; color:{_TEXTO}; }}
        ''')
        cancel_btn.clicked.connect(self.reject)
        btn_row.addWidget(cancel_btn)

        self.ok_btn = QPushButton('Usar este cliente')
        self.ok_btn.setMinimumHeight(40)
        self.ok_btn.setFont(QFont('Segoe UI', 11, QFont.Bold))
        self.ok_btn.setCursor(Qt.PointingHandCursor)
        self.ok_btn.setStyleSheet(f'''
            QPushButton {{
                background:{_ACENTO}; color:white;
                border:none; border-radius:8px;
            }}
            QPushButton:hover {{ background:{_ACENTO_HOVER}; }}
        ''')
        self.ok_btn.clicked.connect(self._confirmar)
        btn_row.addWidget(self.ok_btn, 2)

        main.addLayout(btn_row)

    # ── Interacción ─────────────────────────────────────────────────────────
    def eventFilter(self, obj, event):
        """Flecha abajo en el buscador salta a la lista sin soltar el teclado."""
        from PyQt5.QtCore import QEvent
        if (obj is getattr(self, 'buscador', None)
                and event.type() == QEvent.KeyPress
                and event.key() in (Qt.Key_Down, Qt.Key_Up)
                and self.lista.count()):
            self.lista.setFocus()
            fila = self.lista.currentRow()
            if event.key() == Qt.Key_Down:
                self.lista.setCurrentRow(min(fila + 1, self.lista.count() - 1))
            else:
                self.lista.setCurrentRow(max(fila - 1, 0))
            return True
        return super().eventFilter(obj, event)

    def _filtrar(self, texto):
        t = (texto or '').strip().lower()
        if not t:
            self._llenar_lista(self._clientes)
            return
        # El CUIT se busca sin guiones: nadie los tipea igual que como se guardan.
        t_num = t.replace('-', '').replace(' ', '')
        filtrados = []
        for c in self._clientes:
            campos = ' '.join(str(c.get(k) or '') for k in ('nombre', 'razon_social'))
            cuit = str(c.get('cuit') or '').replace('-', '')
            if t in campos.lower() or (t_num and t_num in cuit):
                filtrados.append(c)
        self._llenar_lista(filtrados)

    def _toggle_nuevo(self):
        abierto = self.nuevo_btn.isChecked()
        self.form_wrap.setVisible(abierto)
        self.nuevo_btn.setText('−  Facturar a un cliente nuevo' if abierto
                               else '+  Facturar a un cliente nuevo')
        # Con el formulario abierto la lista se achica en vez de empujar los
        # botones fuera de la pantalla, que es lo que pasaba antes.
        if hasattr(self, 'lista'):
            self.lista.setFixedHeight(150 if abierto else 260)
        if abierto:
            self.nombre_input.setFocus()
        self.adjustSize()

    def _confirmar(self):
        """El botón principal: cliente nuevo si el formulario está abierto y con
        datos, y si no, el que esté marcado en la lista."""
        if getattr(self, 'nuevo_btn', None) and self.nuevo_btn.isChecked() \
                and self.nombre_input.text().strip():
            self._use_new()
            return
        self._usar_seleccionado()

    def _usar_seleccionado(self):
        item = self.lista.currentItem() if hasattr(self, 'lista') else None
        if item is None:
            if hasattr(self, 'lista') and self.lista.count():
                item = self.lista.item(0)
            else:
                QMessageBox.information(
                    self, 'Elegí un cliente',
                    'No hay ningún cliente seleccionado. Buscá uno de la lista '
                    'o cargá los datos del cliente nuevo.'
                )
                return
        self._select(item.data(Qt.UserRole))

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
        if not cliente:
            return
        self.selected_cliente = {
            'nombre':       cliente.get('nombre', ''),
            'razon_social': cliente.get('razon_social', ''),
            'cuit':         cliente.get('cuit', ''),
            'domicilio':    cliente.get('domicilio', ''),
            'localidad':    cliente.get('localidad', ''),
            'condicion_iva': cliente.get('condicion_iva', 'Consumidor Final'),
        }
        self._marcar_uso(cliente.get('id'))
        self.accept()

    def _marcar_uso(self, cliente_id):
        """Deja la fecha de uso para que la próxima vez aparezca arriba."""
        if not cliente_id:
            return
        try:
            from datetime import datetime
            from pos_system.database.db_manager import DatabaseManager
            DatabaseManager().execute_update(
                "UPDATE clientes_facturacion SET ultimo_uso = ? WHERE id = ?",
                (datetime.now().isoformat(), cliente_id)
            )
        except Exception:
            pass   # que no falle facturar por no poder ordenar una lista

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
            from datetime import datetime
            from pos_system.database.db_manager import DatabaseManager
            db = DatabaseManager()
            new_id = db.execute_update(
                """INSERT INTO clientes_facturacion
                   (firebase_id, nombre, razon_social, cuit, domicilio, localidad,
                    condicion_iva, activo, ultimo_uso)
                   VALUES (NULL, ?, ?, ?, ?, ?, ?, 1, ?)""",
                (
                    self.selected_cliente['nombre'],
                    self.selected_cliente['razon_social'],
                    self.selected_cliente['cuit'],
                    self.selected_cliente['domicilio'],
                    self.selected_cliente['localidad'],
                    self.selected_cliente['condicion_iva'],
                    datetime.now().isoformat(),
                )
            )

            # Subir SOLO este cliente a Firebase (idempotente, doc_id por CUIT
            # cuando esta cargado → todas las PCs comparten el mismo registro).
            try:
                from pos_system.utils.firebase_sync import get_firebase_sync
                fb = get_firebase_sync()
                if fb and fb.enabled:
                    cliente_payload = dict(self.selected_cliente)
                    cliente_payload['id'] = new_id
                    fb.sync_cliente_individual(cliente_payload, db_manager=db)
            except Exception:
                pass

        except Exception as e:
            QMessageBox.warning(
                self, 'Aviso',
                f'El cliente se usará en la factura pero no pudo guardarse: {e}'
            )
