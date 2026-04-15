"""
Diálogo post-pago para elegir en qué perfil ARCA facturar.
Cada perfil es un emisor (dueño/socio) con su propio CUIT y cuenta ARCA.
Diseño de 1 clic: los perfiles aparecen como botones grandes directamente.
"""
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QFrame, QScrollArea, QWidget, QSizePolicy
)
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QFont


class ArcoPerfilDialog(QDialog):
    """
    Resultado:
        - self.selected_profile: dict del perfil emisor seleccionado (o None)
        - self.facturar: True si debe emitirse factura
    """

    def __init__(self, parent=None, total: float = 0.0):
        super().__init__(parent)
        self.total = total
        self.selected_profile = None
        self.selected_cliente = None
        self.facturar = False
        self._profiles = []
        self._load_profiles()
        self._setup_ui()

    def _load_profiles(self):
        try:
            from pos_system.database.db_manager import DatabaseManager
            db = DatabaseManager()
            self._profiles = db.execute_query(
                "SELECT * FROM perfiles_facturacion WHERE activo=1 ORDER BY nombre ASC"
            )
            res = db.execute_query("SELECT value FROM config WHERE key='emisor_activo_id'")
            self._emisor_activo_id = (res[0]['value'] or '') if res else ''
        except Exception:
            self._profiles = []
            self._emisor_activo_id = ''

    def _setup_ui(self):
        self.setWindowTitle('Facturar al ARCA')
        self.setModal(True)
        self.setWindowFlags(self.windowFlags() & ~Qt.WindowContextHelpButtonHint)

        n = len(self._profiles)
        cols = min(max(n, 1), 4)
        self.setMinimumWidth(max(380, cols * 160 + 40))
        self.setMaximumWidth(900)

        main = QVBoxLayout(self)
        main.setSpacing(14)
        main.setContentsMargins(20, 18, 20, 18)

        # ── Total ─────────────────────────────────────────────────────────────
        header = QLabel(f'${self.total:,.2f}')
        header.setFont(QFont('Segoe UI', 22, QFont.Bold))
        header.setAlignment(Qt.AlignCenter)
        header.setStyleSheet('color: #212529;')
        main.addWidget(header)

        sub = QLabel('¿En qué perfil ARCA facturar?')
        sub.setFont(QFont('Segoe UI', 10))
        sub.setAlignment(Qt.AlignCenter)
        sub.setStyleSheet('color: #6c757d;')
        main.addWidget(sub)

        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet('background:#dee2e6; max-height:1px;')
        main.addWidget(sep)

        # ── Botones de perfiles ───────────────────────────────────────────────
        if not self._profiles:
            aviso = QLabel('No hay perfiles cargados.\nAgregá uno en Fiscal → Perfiles ARCA.')
            aviso.setAlignment(Qt.AlignCenter)
            aviso.setStyleSheet(
                'color:#856404; background:#fff3cd; border:1px solid #ffecb5;'
                'border-radius:8px; padding:12px; font-size:11px;'
            )
            aviso.setWordWrap(True)
            main.addWidget(aviso)
        else:
            scroll = QScrollArea()
            scroll.setWidgetResizable(True)
            scroll.setFrameShape(QFrame.NoFrame)
            scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
            scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)

            cards_widget = QWidget()
            cards_layout = QHBoxLayout(cards_widget)
            cards_layout.setSpacing(10)
            cards_layout.setContentsMargins(0, 0, 0, 0)

            colors = [
                ('#0d6efd', '#0b5ed7'),
                ('#6f42c1', '#5a32a3'),
                ('#d63384', '#ab296a'),
                ('#fd7e14', '#dc6502'),
                ('#20c997', '#1aa179'),
                ('#0dcaf0', '#0aadce'),
            ]

            hay_activo = any(
                self._emisor_activo_id and str(p.get('firebase_id', '')) == self._emisor_activo_id
                for p in self._profiles
            )

            for i, p in enumerate(self._profiles):
                color_bg, color_hover = colors[i % len(colors)]
                cuit_txt = p.get('cuit', '') or '—'
                es_activo = bool(
                    self._emisor_activo_id
                    and str(p.get('firebase_id', '')) == self._emisor_activo_id
                )
                btn = self._make_profile_btn(
                    nombre=p['nombre'],
                    subtexto=f'CUIT: {cuit_txt}',
                    color_bg=color_bg,
                    color_hover=color_hover,
                    es_activo=es_activo,
                )
                btn.clicked.connect(lambda _, perfil=p: self._facturar_perfil(perfil))
                cards_layout.addWidget(btn)

            cards_layout.addStretch()
            scroll.setWidget(cards_widget)
            scroll.setFixedHeight(155 if hay_activo else 120)
            main.addWidget(scroll)

        sep2 = QFrame()
        sep2.setFrameShape(QFrame.HLine)
        sep2.setStyleSheet('background:#dee2e6; max-height:1px;')
        main.addWidget(sep2)

        # ── Seleccionar cliente ───────────────────────────────────────────────
        self._cliente_btn = QPushButton('👤  Sin cliente seleccionado — clic para elegir')
        self._cliente_btn.setMinimumHeight(40)
        self._cliente_btn.setFont(QFont('Segoe UI', 10))
        self._cliente_btn.setCursor(Qt.PointingHandCursor)
        self._cliente_btn.setStyleSheet('''
            QPushButton {
                background: #f8f9fa; color: #495057;
                border: 1px dashed #adb5bd; border-radius: 8px;
                text-align: left; padding: 0 14px;
            }
            QPushButton:hover { background: #e9ecef; border-style: solid; }
        ''')
        self._cliente_btn.clicked.connect(self._abrir_selector_cliente)
        main.addWidget(self._cliente_btn)

        sep3 = QFrame()
        sep3.setFrameShape(QFrame.HLine)
        sep3.setStyleSheet('background:#dee2e6; max-height:1px;')
        main.addWidget(sep3)

        # ── No facturar ───────────────────────────────────────────────────────
        no_btn = QPushButton('No facturar — solo registrar')
        no_btn.setMinimumHeight(40)
        no_btn.setFont(QFont('Segoe UI', 10))
        no_btn.setCursor(Qt.PointingHandCursor)
        no_btn.setStyleSheet('''
            QPushButton {
                background: transparent;
                color: #6c757d;
                border: 1px solid #ced4da;
                border-radius: 8px;
            }
            QPushButton:hover {
                background: #f8f9fa;
                color: #343a40;
            }
        ''')
        no_btn.clicked.connect(self._solo_registrar)
        main.addWidget(no_btn)

    def _make_profile_btn(self, nombre, subtexto, color_bg, color_hover, es_activo=False):
        btn = QPushButton()
        btn.setFixedSize(175 if es_activo else 148, 138 if es_activo else 110)
        btn.setCursor(Qt.PointingHandCursor)
        btn.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)

        layout = QVBoxLayout(btn)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(5)
        layout.setAlignment(Qt.AlignCenter)

        if es_activo:
            activo_lbl = QLabel('▶  ACTIVO HOY')
            activo_lbl.setFont(QFont('Segoe UI', 8, QFont.Bold))
            activo_lbl.setAlignment(Qt.AlignCenter)
            activo_lbl.setStyleSheet(
                'color: #1a1a1a;'
                'background: #ffd600;'
                'border-radius: 4px;'
                'padding: 2px 8px;'
                'letter-spacing: 0.5px;'
            )
            layout.addWidget(activo_lbl)

        nombre_lbl = QLabel(nombre)
        nombre_lbl.setFont(QFont('Segoe UI', 12 if es_activo else 10, QFont.Bold))
        nombre_lbl.setAlignment(Qt.AlignCenter)
        nombre_lbl.setWordWrap(True)
        nombre_lbl.setStyleSheet('color: white; background: transparent;')
        layout.addWidget(nombre_lbl)

        sub_lbl = QLabel(subtexto)
        sub_lbl.setFont(QFont('Segoe UI', 8))
        sub_lbl.setAlignment(Qt.AlignCenter)
        sub_lbl.setStyleSheet('color: rgba(255,255,255,0.75); background: transparent;')
        layout.addWidget(sub_lbl)

        if es_activo:
            btn.setStyleSheet(f'''
                QPushButton {{
                    background: {color_bg};
                    border: 3px solid #ffd600;
                    border-radius: 12px;
                }}
                QPushButton:hover {{ background: {color_hover}; }}
                QPushButton:pressed {{ background: {color_hover}; }}
            ''')
        else:
            btn.setStyleSheet(f'''
                QPushButton {{
                    background: {color_bg};
                    border: none;
                    border-radius: 10px;
                    opacity: 0.85;
                }}
                QPushButton:hover {{ background: {color_hover}; }}
                QPushButton:pressed {{ background: {color_hover}; }}
            ''')
        return btn

    def _abrir_selector_cliente(self):
        from pos_system.ui.cliente_perfil_dialog import ClientePerfilDialog
        dlg = ClientePerfilDialog(self)
        if dlg.exec_() == QDialog.Accepted and dlg.selected_cliente:
            self.selected_cliente = dlg.selected_cliente
            nombre = dlg.selected_cliente.get('nombre', '')
            cuit = dlg.selected_cliente.get('cuit', '')
            txt = f'👤  {nombre}'
            if cuit:
                txt += f'  —  CUIT: {cuit}'
            self._cliente_btn.setText(txt)
            self._cliente_btn.setStyleSheet('''
                QPushButton {
                    background: #e7f3ff; color: #0d6efd;
                    border: 1px solid #b6d4fe; border-radius: 8px;
                    text-align: left; padding: 0 14px;
                }
                QPushButton:hover { background: #cfe2ff; }
            ''')

    def _facturar_perfil(self, perfil: dict):
        self.facturar = True
        self.selected_profile = perfil
        self.accept()

    def _solo_registrar(self):
        self.facturar = False
        self.selected_profile = None
        self.accept()
