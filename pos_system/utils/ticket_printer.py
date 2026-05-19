"""
Impresión de tickets NO fiscales con vista previa nativa del POS.

Renderiza el HTML del ticket dentro de una QWebEngineView embebida en un
QDialog del POS, con un toolbar arriba que tiene "Imprimir" y "Guardar PDF".
El ticket se ve exactamente igual que el PDF original (logo, fuente, layout,
descuentos, ahorro, etc.) porque usa el mismo template Mustache, pero la
impresión va directo al diálogo nativo de Windows sin abrir un browser.

Esto reemplaza el flujo viejo `generate_non_fiscal_ticket → os.startfile(pdf)`
que dependía de qué visor PDF tuviera asociado el usuario (en algunas PCs
abría el PDF en Edge/Chrome y no permitía imprimir cómodamente).
"""
from __future__ import annotations

import logging
import os
import sys

from PyQt5.QtCore import Qt, QSize, QMarginsF, QUrl
from PyQt5.QtGui import QPageLayout, QPageSize
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QPushButton, QLabel, QFileDialog,
    QMessageBox, QApplication, QSizePolicy, QWidget
)
from PyQt5.QtPrintSupport import QPrinter, QPrintDialog, QPrinterInfo

logger = logging.getLogger(__name__)


def _qweb_available():
    """QWebEngineWidgets se importa lazy porque suma 60+MB al startup."""
    try:
        from PyQt5.QtWebEngineWidgets import QWebEngineView  # noqa: F401
        return True
    except ImportError as e:
        logger.error(f'QWebEngineWidgets no disponible: {e}')
        return False
    except Exception as e:
        logger.exception(f'Error inesperado importando QWebEngineWidgets: {e}')
        return False


class TicketPreviewDialog(QDialog):
    """
    Vista previa del ticket dentro del POS:
    - Toolbar arriba: Imprimir | Guardar PDF | Cerrar
    - QWebEngineView con el HTML renderizado (idéntico al PDF original)
    """

    def __init__(self, html, sale_id='', parent=None):
        super().__init__(parent)
        from PyQt5.QtWebEngineWidgets import QWebEngineView

        self.setWindowTitle(f'Ticket — Venta #{sale_id}')
        self.setWindowFlags(self.windowFlags() | Qt.Window)

        # Tamaño responsive: 80% del ancho de la pantalla actual hasta máx 900px,
        # 90% del alto. Mínimo 600x600 para que el toolbar quepa siempre.
        screen = QApplication.primaryScreen()
        if screen is not None:
            geo = screen.availableGeometry()
            w = min(900, int(geo.width() * 0.80))
            h = min(950, int(geo.height() * 0.90))
            self.resize(max(600, w), max(600, h))
            # Centrar en la pantalla
            self.move(
                geo.left() + (geo.width() - self.width()) // 2,
                geo.top() + (geo.height() - self.height()) // 2,
            )
        else:
            self.resize(800, 900)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # ── Toolbar ─────────────────────────────────────────────────────────
        # Container = QWidget (no QLabel — QLabel no muestra hijos de layout).
        tb_widget = QWidget()
        tb_widget.setStyleSheet(
            'QWidget#tbWidget { background:#fff; border-bottom:1px solid #e4e6eb; }'
        )
        tb_widget.setObjectName('tbWidget')
        tb_widget.setMinimumHeight(58)
        tb_widget.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)

        toolbar = QHBoxLayout(tb_widget)
        toolbar.setContentsMargins(14, 10, 14, 10)
        toolbar.setSpacing(10)

        title = QLabel(f'<b style="font-size:14px">Ticket — Venta #{sale_id}</b>')
        title.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        toolbar.addWidget(title)

        self.print_btn = QPushButton('🖨️  Imprimir')
        self.print_btn.setMinimumHeight(36)
        self.print_btn.setCursor(Qt.PointingHandCursor)
        self.print_btn.setStyleSheet(
            'QPushButton { background:#1877f2; color:#fff; border:none; '
            'padding:6px 18px; border-radius:8px; font-size:13px; font-weight:600 } '
            'QPushButton:hover { background:#155bb8 }'
        )
        self.print_btn.clicked.connect(self._imprimir)
        toolbar.addWidget(self.print_btn)

        self.save_pdf_btn = QPushButton('Guardar PDF')
        self.save_pdf_btn.setMinimumHeight(36)
        self.save_pdf_btn.setCursor(Qt.PointingHandCursor)
        self.save_pdf_btn.setStyleSheet(
            'QPushButton { background:#fff; color:#444; border:1.5px solid #d1d5db; '
            'padding:6px 14px; border-radius:8px; font-size:13px; font-weight:600 } '
            'QPushButton:hover { background:#f0f2f5 }'
        )
        self.save_pdf_btn.clicked.connect(self._guardar_pdf)
        toolbar.addWidget(self.save_pdf_btn)

        self.close_btn = QPushButton('Cerrar')
        self.close_btn.setMinimumHeight(36)
        self.close_btn.setCursor(Qt.PointingHandCursor)
        self.close_btn.setStyleSheet(
            'QPushButton { background:#fff; color:#65676b; border:1.5px solid #e4e6eb; '
            'padding:6px 14px; border-radius:8px; font-size:13px; font-weight:600 } '
            'QPushButton:hover { background:#f0f2f5 }'
        )
        self.close_btn.clicked.connect(self.accept)
        toolbar.addWidget(self.close_btn)

        layout.addWidget(tb_widget)

        # ── Vista web del ticket ───────────────────────────────────────────
        self.view = QWebEngineView(self)
        self.view.setHtml(html, baseUrl=QUrl('about:blank'))
        self.view.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        layout.addWidget(self.view)

        self._sale_id = sale_id
        self._html = html

    def _imprimir(self):
        """
        Configura QPrinter, muestra el diálogo nativo de Windows para elegir
        impresora, y renderiza la página web en ese printer.
        """
        logger.info('_imprimir: click en Imprimir')

        # Detectar si hay impresoras instaladas. Si no, QPrintDialog se
        # auto-rechaza sin avisar al usuario — es lo que pasaba en el flujo
        # anterior. Acá lo detectamos y avisamos en claro.
        printers = QPrinterInfo.availablePrinters()
        default = QPrinterInfo.defaultPrinter()
        logger.info(
            f'_imprimir: impresoras={len(printers)} default={default.printerName() or "(ninguna)"}'
        )
        if not printers:
            QMessageBox.warning(
                self, 'Sin impresoras',
                'No hay impresoras instaladas en esta PC.\n\n'
                'Instalá una impresora desde Configuración de Windows o usá '
                '"Guardar PDF" para guardar el ticket y mandarlo por otro medio.'
            )
            return

        # Crear QPrinter desde la impresora default (si hay), sino la primera.
        if not default.isNull() and default.printerName():
            printer = QPrinter(default, QPrinter.HighResolution)
        else:
            printer = QPrinter(printers[0], QPrinter.HighResolution)
        printer.setPageSize(QPrinter.A4)
        printer.setColorMode(QPrinter.GrayScale)
        printer.setPageMargins(6, 6, 6, 6, QPrinter.Millimeter)

        dialog = QPrintDialog(printer, self)
        dialog.setWindowTitle(f'Imprimir ticket — Venta #{self._sale_id}')
        logger.info('_imprimir: abriendo QPrintDialog…')
        result = dialog.exec_()
        logger.info(f'_imprimir: QPrintDialog.exec_() = {result} (Accepted={QPrintDialog.Accepted})')
        if result != QPrintDialog.Accepted:
            logger.info('_imprimir: usuario canceló QPrintDialog')
            return

        try:
            # QWebEnginePage.print() en PyQt5 es async: toma printer + callback.
            logger.info('_imprimir: enviando a QWebEnginePage.print…')
            self.view.page().print(printer, self._on_print_finished)
            self.print_btn.setEnabled(False)
            self.print_btn.setText('Imprimiendo...')
        except Exception as e:
            logger.exception('Error iniciando impresión')
            QMessageBox.critical(self, 'Error de impresión',
                                 f'No se pudo imprimir el ticket:\n{e}')

    def _on_print_finished(self, success):
        self.print_btn.setEnabled(True)
        self.print_btn.setText('🖨️  Imprimir')
        if success:
            logger.info(f'Ticket #{self._sale_id} impreso OK')
            self.accept()
        else:
            logger.warning(f'Impresión cancelada o fallida para ticket #{self._sale_id}')

    def _guardar_pdf(self):
        """
        Guarda el ticket como PDF usando QWebEnginePage.printToPdf.
        Útil para mandar por WhatsApp/email sin imprimir.
        """
        default_name = f'ticket_{self._sale_id}.pdf'
        path, _ = QFileDialog.getSaveFileName(
            self, 'Guardar ticket como PDF',
            os.path.join(os.path.expanduser('~'), 'Downloads', default_name),
            'PDF (*.pdf)'
        )
        if not path:
            return
        try:
            layout = QPageLayout(QPageSize(QPageSize.A4), QPageLayout.Portrait,
                                 QMarginsF(6, 6, 6, 6))
            # printToPdf es async — esperamos confirmación antes de mostrar
            # el diálogo de "abrir/mostrar" para no apuntar a un archivo aún
            # vacío que rompería el visor.
            self.view.page().pdfPrintingFinished.connect(
                lambda saved_path, success: self._on_pdf_saved(saved_path, success)
            )
            self.view.page().printToPdf(path, layout)
        except Exception as e:
            logger.exception('Error guardando PDF')
            QMessageBox.critical(self, 'Error', f'No se pudo guardar el PDF:\n{e}')

    def _on_pdf_saved(self, path, success):
        """Callback de printToPdf — mostrar diálogo con botón Abrir."""
        if not success or not path or not os.path.exists(path):
            QMessageBox.critical(self, 'Error',
                                 'No se pudo guardar el PDF (printToPdf falló).')
            return
        # Diálogo con 3 botones: Abrir | Mostrar en carpeta | Aceptar.
        msg = QMessageBox(self)
        msg.setIcon(QMessageBox.Information)
        msg.setWindowTitle('PDF guardado')
        msg.setText('Ticket guardado en:')
        msg.setInformativeText(path)
        abrir_btn  = msg.addButton('Abrir', QMessageBox.AcceptRole)
        carpeta_btn = msg.addButton('Mostrar en carpeta', QMessageBox.ActionRole)
        msg.addButton('Cerrar', QMessageBox.RejectRole)
        msg.setDefaultButton(abrir_btn)
        msg.exec_()
        clicked = msg.clickedButton()
        if clicked is abrir_btn:
            _abrir_archivo_con_fallback(path, parent=self)
        elif clicked is carpeta_btn:
            _mostrar_en_carpeta(path, parent=self)


def _abrir_archivo_con_fallback(path, parent=None):
    """Abrir archivo con el visor default. Si no hay handler, fallback a Explorer.
    Garantiza que SI O SI algo se abre (Explorer existe en todo Windows)."""
    import platform
    import subprocess
    try:
        if platform.system() == 'Windows':
            try:
                os.startfile(path)
                logger.info(f'_abrir_archivo_con_fallback: startfile OK ({path})')
                return True
            except OSError as e:
                logger.warning(f'startfile falló ({e}); abriendo en Explorer')
                _mostrar_en_carpeta(path, parent=parent)
                return True
        elif platform.system() == 'Darwin':
            subprocess.run(['open', path])
        else:
            subprocess.run(['xdg-open', path])
        return True
    except Exception as e:
        logger.exception('No se pudo abrir el archivo')
        if parent is not None:
            QMessageBox.warning(parent, 'No se pudo abrir',
                f'Windows no encontró programa para abrir el archivo.\n\n'
                f'Está guardado en:\n{path}')
        return False


def _mostrar_en_carpeta(path, parent=None):
    """Abrir Explorer con el archivo seleccionado. Funciona siempre en Windows."""
    import platform
    import subprocess
    try:
        if platform.system() == 'Windows':
            # /select,<path> marca el archivo dentro de la carpeta.
            subprocess.Popen(['explorer', f'/select,{os.path.normpath(path)}'])
        elif platform.system() == 'Darwin':
            subprocess.run(['open', '-R', path])
        else:
            subprocess.run(['xdg-open', os.path.dirname(path)])
        return True
    except Exception as e:
        logger.exception('No se pudo mostrar en carpeta')
        if parent is not None:
            QMessageBox.warning(parent, 'No se pudo abrir la carpeta',
                f'El archivo está guardado en:\n{path}')
        return False


def imprimir_ticket_no_fiscal(sale, parent=None,
                              cajero_name='', cliente_name='Consumidor Final',
                              with_preview=True):
    """
    Punto de entrada principal. Abre la vista previa del ticket dentro del
    POS con botones para imprimir o guardar PDF. Funciona en cualquier PC
    con PyQtWebEngine instalado (incluido en el deploy del POS).

    Args:
        sale: dict de la venta
        parent: QWidget parent
        cajero_name: nombre del cajero
        cliente_name: nombre del cliente
        with_preview: (compat) ignorado — siempre muestra preview.

    Returns:
        True si se mostró/imprimió, False si falló.
    """
    logger.info(f'imprimir_ticket_no_fiscal: arrancando para venta #{sale.get("id")}')
    try:
        if not _qweb_available():
            QMessageBox.warning(parent, 'Falta dependencia',
                'PyQtWebEngine no está instalado. Para imprimir tickets correr:\n\n'
                'pip install PyQtWebEngine')
            return False

        from pos_system.utils.pdf_generator import PDFGenerator
        html = PDFGenerator().render_non_fiscal_ticket_html(
            sale, cajero_name=cajero_name, cliente_name=cliente_name
        )
        logger.info(f'imprimir_ticket_no_fiscal: HTML generado, len={len(html)}')

        dlg = TicketPreviewDialog(html, sale_id=str(sale.get('id', '')),
                                  parent=parent)
        dlg.show()
        dlg.raise_()
        dlg.activateWindow()
        QApplication.processEvents()
        result = dlg.exec_()
        logger.info(f'imprimir_ticket_no_fiscal: dialog cerrado con {result}')
        return True
    except Exception as e:
        logger.exception('Error imprimiendo ticket no fiscal')
        try:
            QMessageBox.critical(parent, 'Error de impresión',
                                 f'No se pudo abrir el ticket:\n{e}')
        except Exception:
            pass
        return False
