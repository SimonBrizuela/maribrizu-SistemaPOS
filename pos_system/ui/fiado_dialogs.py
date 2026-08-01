"""Diálogos compartidos del módulo Fiado (cuenta corriente de clientes).

Los usan tanto la vista de Ventas (para elegir a nombre de quién se carga el
carrito) como la pestaña Fiados (alta y edición de clientes).

Paleta: violeta (#6a3d9a) para todo lo que sea fiado, así el cajero distingue
de un vistazo cuándo está operando sobre una cuenta corriente y no sobre una
venta normal.
"""
import logging

from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont
from PyQt5.QtWidgets import (QDialog, QVBoxLayout, QHBoxLayout, QLabel,
                             QLineEdit, QPushButton, QFrame, QScrollArea,
                             QWidget, QMessageBox, QTextEdit)

from pos_system.models.fiado import Fiado
from pos_system.ui.theme import COLORS as _T

logger = logging.getLogger(__name__)

# Acento del módulo
FIADO = '#6a3d9a'
FIADO_HOVER = '#54307a'
FIADO_SOFT = '#f3ecfa'
FIADO_BORDER = '#d9c8ee'


def fmt_money(n) -> str:
    """$ 12.345,67 con separadores AR."""
    try:
        v = float(n or 0)
    except (TypeError, ValueError):
        v = 0.0
    return f"{v:,.2f}".replace(',', '@').replace('.', ',').replace('@', '.')


def fmt_qty(q) -> str:
    """Cantidad sin decimales cuando es entera (3 en vez de 3.0)."""
    try:
        v = float(q or 0)
    except (TypeError, ValueError):
        return '0'
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    return f"{v:g}".replace('.', ',')


def campo(label_text: str, placeholder: str = '', valor: str = '') -> tuple:
    """Devuelve (contenedor, QLineEdit) con el label arriba."""
    cont = QWidget()
    v = QVBoxLayout(cont)
    v.setContentsMargins(0, 0, 0, 0)
    v.setSpacing(4)
    lbl = QLabel(label_text)
    lbl.setStyleSheet(
        f"color:{_T['text_muted']}; font-size:10px; font-weight:700;"
        f" letter-spacing:0.4px; background:transparent; border:none;"
    )
    v.addWidget(lbl)
    inp = QLineEdit(valor or '')
    inp.setPlaceholderText(placeholder)
    inp.setMinimumHeight(36)
    inp.setStyleSheet(
        f"QLineEdit {{ border:1px solid {_T['border']}; background:{_T['surface']};"
        f" border-radius:6px; padding:6px 10px; font-size:13px; color:{_T['text']}; }}"
        f"QLineEdit:focus {{ border-color:{FIADO}; }}"
    )
    v.addWidget(inp)
    return cont, inp


class FiadoClienteDialog(QDialog):
    """Alta / edición de un cliente de fiado.

    Solo el nombre es obligatorio: el resto de los datos son opcionales y se
    completan cuando se tienen (DNI, teléfono, dirección, notas).
    """

    def __init__(self, parent=None, cliente: dict = None, nombre_inicial: str = ''):
        super().__init__(parent)
        self.cliente = cliente or {}
        self.datos = None          # dict con los campos al aceptar
        editando = bool(self.cliente.get('id'))
        self.setWindowTitle('Editar cliente' if editando else 'Nuevo cliente de fiado')
        self.setMinimumWidth(460)
        self.setStyleSheet(f"QDialog {{ background:{_T['bg']}; }}")

        root = QVBoxLayout(self)
        root.setContentsMargins(18, 16, 18, 16)
        root.setSpacing(12)

        titulo = QLabel('Editar cliente' if editando else 'Nuevo cliente de fiado')
        titulo.setFont(QFont('Segoe UI', 14, QFont.Bold))
        titulo.setStyleSheet(f"color:{FIADO}; background:transparent;")
        root.addWidget(titulo)

        sub = QLabel('Solo el nombre es obligatorio. El resto lo podés completar después.')
        sub.setWordWrap(True)
        sub.setStyleSheet(f"color:{_T['text_muted']}; font-size:11px; background:transparent;")
        root.addWidget(sub)

        c1, self.in_nombre = campo('NOMBRE *', 'Ej: Juan Pérez',
                                   self.cliente.get('nombre') or nombre_inicial)
        root.addWidget(c1)

        fila = QHBoxLayout(); fila.setSpacing(10)
        c2, self.in_dni = campo('DNI', 'Opcional', self.cliente.get('dni'))
        c3, self.in_tel = campo('TELÉFONO', 'Opcional', self.cliente.get('telefono'))
        fila.addWidget(c2); fila.addWidget(c3)
        root.addLayout(fila)

        fila2 = QHBoxLayout(); fila2.setSpacing(10)
        c4, self.in_dir = campo('DIRECCIÓN', 'Opcional', self.cliente.get('direccion'))
        c5, self.in_mail = campo('EMAIL', 'Opcional', self.cliente.get('email'))
        fila2.addWidget(c4); fila2.addWidget(c5)
        root.addLayout(fila2)

        lbl_notas = QLabel('NOTAS')
        lbl_notas.setStyleSheet(
            f"color:{_T['text_muted']}; font-size:10px; font-weight:700;"
            f" letter-spacing:0.4px; background:transparent; border:none;"
        )
        root.addWidget(lbl_notas)
        self.in_notas = QTextEdit(self.cliente.get('notas') or '')
        self.in_notas.setPlaceholderText('Ej: paga los viernes, es el kiosco de la esquina…')
        self.in_notas.setMaximumHeight(70)
        self.in_notas.setStyleSheet(
            f"QTextEdit {{ border:1px solid {_T['border']}; background:{_T['surface']};"
            f" border-radius:6px; padding:6px 10px; font-size:13px; color:{_T['text']}; }}"
            f"QTextEdit:focus {{ border-color:{FIADO}; }}"
        )
        root.addWidget(self.in_notas)

        botones = QHBoxLayout(); botones.setSpacing(10)
        botones.addStretch(1)
        cancelar = QPushButton('Cancelar')
        cancelar.setMinimumHeight(40); cancelar.setMinimumWidth(110)
        cancelar.setCursor(Qt.PointingHandCursor)
        cancelar.setStyleSheet(
            f"QPushButton {{ background:{_T['surface']}; color:{_T['text_muted']};"
            f" border:1px solid {_T['border']}; border-radius:6px; font-weight:600; }}"
            f"QPushButton:hover {{ background:{_T['border_soft']}; color:{_T['text']}; }}"
        )
        cancelar.clicked.connect(self.reject)
        botones.addWidget(cancelar)

        guardar = QPushButton('Guardar')
        guardar.setMinimumHeight(40); guardar.setMinimumWidth(140)
        guardar.setCursor(Qt.PointingHandCursor)
        guardar.setFont(QFont('Segoe UI', 11, QFont.Bold))
        guardar.setStyleSheet(
            f"QPushButton {{ background:{FIADO}; color:white; border:none;"
            f" border-radius:6px; font-weight:700; }}"
            f"QPushButton:hover {{ background:{FIADO_HOVER}; }}"
        )
        guardar.setDefault(True)
        guardar.clicked.connect(self._aceptar)
        botones.addWidget(guardar)
        root.addLayout(botones)

        self.in_nombre.setFocus()

    def _aceptar(self):
        nombre = self.in_nombre.text().strip()
        if not nombre:
            QMessageBox.warning(self, 'Falta el nombre',
                                'Poné al menos el nombre del cliente.')
            self.in_nombre.setFocus()
            return
        self.datos = {
            'nombre':    nombre,
            'dni':       self.in_dni.text().strip(),
            'telefono':  self.in_tel.text().strip(),
            'direccion': self.in_dir.text().strip(),
            'email':     self.in_mail.text().strip(),
            'notas':     self.in_notas.toPlainText().strip(),
        }
        self.accept()


class FiadoClientePicker(QDialog):
    """Buscador de clientes para elegir a nombre de quién va el fiado.

    Muestra la deuda actual de cada uno para que el cajero vea al instante
    si a esa persona ya le viene fiando de antes.
    """

    def __init__(self, parent=None, db=None, pc_id: str = ''):
        super().__init__(parent)
        self.db = db
        self.pc_id = pc_id
        self.modelo = Fiado(db)
        self.cliente = None        # cliente elegido (dict) o None
        self.setWindowTitle('Elegir cliente')
        self.setMinimumSize(560, 520)
        self.setStyleSheet(f"QDialog {{ background:{_T['bg']}; }}")

        root = QVBoxLayout(self)
        root.setContentsMargins(16, 14, 16, 14)
        root.setSpacing(10)

        titulo = QLabel('¿A nombre de quién?')
        titulo.setFont(QFont('Segoe UI', 14, QFont.Bold))
        titulo.setStyleSheet(f"color:{FIADO}; background:transparent;")
        root.addWidget(titulo)

        barra = QHBoxLayout(); barra.setSpacing(8)
        self.buscar = QLineEdit()
        self.buscar.setPlaceholderText('Buscar por nombre, DNI o teléfono…')
        self.buscar.setMinimumHeight(40)
        self.buscar.setStyleSheet(
            f"QLineEdit {{ border:1px solid {_T['border']}; background:{_T['surface']};"
            f" border-radius:6px; padding:6px 12px; font-size:14px; color:{_T['text']}; }}"
            f"QLineEdit:focus {{ border-color:{FIADO}; }}"
        )
        self.buscar.textChanged.connect(self._refrescar)
        self.buscar.returnPressed.connect(self._elegir_primero)
        barra.addWidget(self.buscar, 1)

        nuevo = QPushButton('+ Nuevo')
        nuevo.setMinimumHeight(40); nuevo.setMinimumWidth(110)
        nuevo.setCursor(Qt.PointingHandCursor)
        nuevo.setFont(QFont('Segoe UI', 10, QFont.Bold))
        nuevo.setStyleSheet(
            f"QPushButton {{ background:{FIADO}; color:white; border:none;"
            f" border-radius:6px; font-weight:700; padding:0 14px; }}"
            f"QPushButton:hover {{ background:{FIADO_HOVER}; }}"
        )
        nuevo.clicked.connect(self._nuevo_cliente)
        barra.addWidget(nuevo)
        root.addLayout(barra)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setStyleSheet('QScrollArea { background:transparent; border:none; }')
        inner = QWidget()
        inner.setStyleSheet('background:transparent;')
        self.lista_v = QVBoxLayout(inner)
        self.lista_v.setContentsMargins(0, 0, 0, 0)
        self.lista_v.setSpacing(6)
        self.lista_v.addStretch(1)
        scroll.setWidget(inner)
        root.addWidget(scroll, 1)

        cerrar = QPushButton('Cancelar')
        cerrar.setMinimumHeight(38)
        cerrar.setCursor(Qt.PointingHandCursor)
        cerrar.setStyleSheet(
            f"QPushButton {{ background:{_T['surface']}; color:{_T['text_muted']};"
            f" border:1px solid {_T['border']}; border-radius:6px; font-weight:600; }}"
            f"QPushButton:hover {{ background:{_T['border_soft']}; color:{_T['text']}; }}"
        )
        cerrar.clicked.connect(self.reject)
        root.addWidget(cerrar)

        self._clientes = []
        self._refrescar()
        self.buscar.setFocus()

    def _refrescar(self):
        lay = self.lista_v
        while lay.count():
            item = lay.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()

        try:
            self._clientes = self.modelo.get_clientes(buscar=self.buscar.text())
        except Exception as e:
            logger.warning(f'Fiado: no se pudieron listar clientes: {e}')
            self._clientes = []

        if not self._clientes:
            vacio = QLabel('No hay clientes con ese nombre.\nCreá uno con "+ Nuevo".')
            vacio.setAlignment(Qt.AlignCenter)
            vacio.setStyleSheet(
                f"color:{_T['text_dim']}; font-size:12px; background:transparent;"
                f" border:1px dashed {_T['border']}; border-radius:8px; padding:28px 12px;"
            )
            lay.addWidget(vacio)
        else:
            for c in self._clientes:
                lay.addWidget(self._fila(c))
        lay.addStretch(1)

    def _fila(self, c: dict) -> QWidget:
        deuda = float(c.get('deuda') or 0)
        favor = float(c.get('saldo_favor') or 0)

        w = QFrame()
        w.setObjectName('cliRow')
        w.setCursor(Qt.PointingHandCursor)
        w.setStyleSheet(
            f"QFrame#cliRow {{ background:{_T['surface']}; border:1px solid {_T['border']};"
            f" border-radius:8px; }}"
            f"QFrame#cliRow:hover {{ border-color:{FIADO}; background:{FIADO_SOFT}; }}"
        )
        h = QHBoxLayout(w)
        h.setContentsMargins(12, 10, 12, 10)
        h.setSpacing(10)

        col = QVBoxLayout(); col.setSpacing(2)
        nombre = QLabel(str(c.get('nombre') or ''))
        nombre.setStyleSheet(
            f"color:{_T['text']}; font-size:13px; font-weight:700;"
            f" background:transparent; border:none;"
        )
        col.addWidget(nombre)
        extra = ' · '.join(x for x in [c.get('telefono'), c.get('dni')] if x)
        sub = QLabel(extra or 'Sin datos de contacto')
        sub.setStyleSheet(
            f"color:{_T['text_muted']}; font-size:11px; background:transparent; border:none;"
        )
        col.addWidget(sub)
        h.addLayout(col, 1)

        if deuda > 0:
            estado = QLabel(f"Debe ${fmt_money(deuda)}")
            estado.setStyleSheet(
                f"color:{FIADO}; background:{FIADO_SOFT}; border:1px solid {FIADO_BORDER};"
                f" border-radius:10px; padding:3px 10px; font-size:11px; font-weight:700;"
                f" font-family:'JetBrains Mono', Consolas, monospace;"
            )
        elif favor > 0:
            estado = QLabel(f"A favor ${fmt_money(favor)}")
            estado.setStyleSheet(
                f"color:{_T['success']}; background:{_T['success_bg']};"
                f" border:1px solid {_T['success']}; border-radius:10px; padding:3px 10px;"
                f" font-size:11px; font-weight:700;"
            )
        else:
            estado = QLabel('Al día')
            estado.setStyleSheet(
                f"color:{_T['text_dim']}; background:{_T['surface_alt']};"
                f" border:1px solid {_T['border']}; border-radius:10px; padding:3px 10px;"
                f" font-size:11px; font-weight:600;"
            )
        h.addWidget(estado)

        w.mousePressEvent = lambda e, cli=c: self._elegir(cli)
        return w

    def _elegir(self, cliente: dict):
        self.cliente = cliente
        self.accept()

    def _elegir_primero(self):
        if self._clientes:
            self._elegir(self._clientes[0])

    def _nuevo_cliente(self):
        dlg = FiadoClienteDialog(self, nombre_inicial=self.buscar.text().strip())
        if dlg.exec_() != QDialog.Accepted or not dlg.datos:
            return
        try:
            nuevo_id = self.modelo.crear_cliente(pc_id=self.pc_id, **dlg.datos)
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'No se pudo crear el cliente:\n{e}')
            return
        cliente = self.modelo.get_cliente(nuevo_id) or {}
        sincronizar_cliente(self.modelo, cliente)
        # Releer para tomar el firebase_id que acaba de asignarse
        self.cliente = self.modelo.get_cliente(nuevo_id) or cliente
        self.accept()


def sincronizar_cliente(modelo: Fiado, cliente: dict) -> None:
    """Empuja el cliente a Firestore y guarda el firebase_id devuelto.

    Best-effort: sin red la ficha queda solo local y el próximo push la sube
    (el firebase_id vacío es la señal de "todavía no sincronizado").
    """
    if not cliente:
        return
    try:
        from pos_system.utils.firebase_sync import get_firebase_sync
        fb = get_firebase_sync()
        if not fb or not getattr(fb, 'enabled', False):
            return
        fid = fb.upsert_fiado_cliente(cliente)
        if fid and not str(cliente.get('firebase_id') or '').strip():
            modelo.set_cliente_firebase_id(int(cliente['id']), fid)
            cliente['firebase_id'] = fid
            # Los items/pagos creados antes de tener fid quedan colgando del id
            # local: se los reasignamos para que todo cuelgue de la misma clave.
            modelo._reasignar_fid_local(int(cliente['id']), fid)
    except Exception as e:
        logger.warning(f'Fiado: no se pudo sincronizar el cliente: {e}')


def sincronizar_items(modelo: Fiado, item_ids) -> None:
    """Empuja al Firestore las líneas de fiado indicadas (por id local)."""
    try:
        from pos_system.utils.firebase_sync import get_firebase_sync
        fb = get_firebase_sync()
        if not fb or not getattr(fb, 'enabled', False):
            return
    except Exception:
        return
    for iid in (item_ids or []):
        try:
            item = modelo.get_item(int(iid))
            if not item:
                continue
            fid = fb.upsert_fiado_item(item)
            if fid and not str(item.get('firebase_id') or '').strip():
                modelo.set_item_firebase_id(int(iid), fid)
        except Exception as e:
            logger.warning(f'Fiado: no se pudo sincronizar el item {iid}: {e}')


def sincronizar_pago(modelo: Fiado, pago_id: int) -> None:
    """Empuja un cobro de fiado a Firestore."""
    try:
        from pos_system.utils.firebase_sync import get_firebase_sync
        fb = get_firebase_sync()
        if not fb or not getattr(fb, 'enabled', False):
            return
        pago = modelo.get_pago(int(pago_id))
        if not pago:
            return
        fid = fb.upsert_fiado_pago(pago)
        if fid and not str(pago.get('firebase_id') or '').strip():
            modelo.set_pago_firebase_id(int(pago_id), fid)
    except Exception as e:
        logger.warning(f'Fiado: no se pudo sincronizar el pago {pago_id}: {e}')
