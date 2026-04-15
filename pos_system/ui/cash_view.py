from PyQt5.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QTableWidget,
                             QTableWidgetItem, QPushButton, QLabel, QMessageBox,
                             QDialog, QFormLayout, QTextEdit,
                             QGroupBox, QGridLayout, QSplitter, QScrollArea, QFrame)
from pos_system.ui.components import PriceInput
from PyQt5.QtCore import Qt, QUrl
from PyQt5.QtGui import QFont, QDesktopServices
from datetime import datetime, timezone, timedelta
from pos_system.utils.firebase_sync import now_ar

_TZ_AR = timezone(timedelta(hours=-3))

def _parse_ar(s: str) -> datetime:
    """Parsea un string de fecha de SQLite y lo devuelve como datetime naive en hora AR."""
    try:
        dt = datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return datetime.now(_TZ_AR).replace(tzinfo=None)
    if dt.tzinfo is not None:
        return dt.astimezone(_TZ_AR).replace(tzinfo=None)
    return dt
import os
import subprocess
import platform

from pos_system.models.cash_register import CashRegister
from pos_system.utils.pdf_generator import PDFGenerator

class CashView(QWidget):
    def __init__(self, parent=None, current_user: dict = None):
        super().__init__(parent)
        from pos_system.database.db_manager import DatabaseManager
        self.db = DatabaseManager()
        self.cash_register_model = CashRegister(self.db)
        self.pdf_generator = PDFGenerator()
        self.current_user = current_user or {}
        self.init_ui()
    
    def get_main_window(self):
        """Obtiene la ventana principal"""
        widget = self
        while widget:
            if hasattr(widget, 'refresh_all_views'):
                return widget
            widget = widget.parent()
        return None
    
    def open_pdf(self, pdf_path):
        """Abre un PDF con el visor predeterminado del sistema"""
        try:
            if platform.system() == 'Windows':
                os.startfile(pdf_path)
            elif platform.system() == 'Darwin':  # macOS
                subprocess.run(['open', pdf_path])
            else:  # Linux
                subprocess.run(['xdg-open', pdf_path])
            return True
        except Exception as e:
            print(f"Error abriendo PDF: {e}")
            return False
        
    def init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(12)
        
        # Layout principal con splitter responsivo
        splitter = QSplitter(Qt.Horizontal)
        splitter.setHandleWidth(6)
        
        # ===== PANEL IZQUIERDO =====
        left_panel = QWidget()
        left_column = QVBoxLayout(left_panel)
        left_column.setContentsMargins(0, 0, 0, 0)
        left_column.setSpacing(12)
        
        # Estado de la caja (Card grande)
        status_card = QWidget()
        status_card.setStyleSheet('''
            QWidget {
                background-color: #ffffff;
                border: 1.5px solid #e2e8f0;
                border-top: 4px solid #0d6efd;
                border-radius: 12px;
            }
        ''')
        status_card_layout = QVBoxLayout(status_card)
        status_card_layout.setContentsMargins(16, 14, 16, 14)
        status_card_layout.setSpacing(8)

        status_header = QHBoxLayout()
        status_title = QLabel('Estado de Caja')
        status_title.setFont(QFont('Segoe UI', 14, QFont.Bold))
        status_title.setStyleSheet('color: #1e293b; background: transparent; border: none;')
        status_header.addWidget(status_title, 1)
        status_card_layout.addLayout(status_header)

        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet('color: #e9ecef;')
        status_card_layout.addWidget(sep)
        
        self.status_label = QLabel()
        self.status_label.setFont(QFont('Segoe UI', 11))
        self.status_label.setWordWrap(True)
        self.status_label.setStyleSheet('background: transparent; border: none;')
        status_card_layout.addWidget(self.status_label)
        
        left_column.addWidget(status_card)
        
        # Botones de acción
        self.open_btn = QPushButton('ABRIR CAJA')
        self.open_btn.setObjectName('btnSuccess')
        self.open_btn.setMinimumHeight(50)
        self.open_btn.setFont(QFont('Segoe UI', 12, QFont.Bold))
        self.open_btn.setCursor(Qt.PointingHandCursor)
        self.open_btn.clicked.connect(self.open_cash_register)
        left_column.addWidget(self.open_btn)
        
        self.withdrawal_btn = QPushButton('RETIRO DE EFECTIVO')
        self.withdrawal_btn.setObjectName('btnWarning')
        self.withdrawal_btn.setMinimumHeight(50)
        self.withdrawal_btn.setFont(QFont('Segoe UI', 12, QFont.Bold))
        self.withdrawal_btn.setCursor(Qt.PointingHandCursor)
        self.withdrawal_btn.clicked.connect(self.add_withdrawal)
        left_column.addWidget(self.withdrawal_btn)
        
        self.close_btn = QPushButton('CERRAR CAJA')
        self.close_btn.setObjectName('btnDanger')
        self.close_btn.setMinimumHeight(50)
        self.close_btn.setFont(QFont('Segoe UI', 12, QFont.Bold))
        self.close_btn.setCursor(Qt.PointingHandCursor)
        self.close_btn.clicked.connect(self.close_cash_register)
        left_column.addWidget(self.close_btn)
        
        # Resumen de efectivo
        summary_card = QWidget()
        summary_card.setStyleSheet('''
            QWidget {
                background-color: #ffffff;
                border: 1.5px solid #e2e8f0;
                border-top: 4px solid #198754;
                border-radius: 12px;
            }
        ''')
        summary_card_layout = QVBoxLayout(summary_card)
        summary_card_layout.setContentsMargins(16, 14, 16, 14)
        summary_card_layout.setSpacing(8)

        summary_header = QHBoxLayout()
        summary_title = QLabel('Resumen Financiero')
        summary_title.setFont(QFont('Segoe UI', 13, QFont.Bold))
        summary_title.setStyleSheet('color: #1e293b; background: transparent; border: none;')
        summary_header.addWidget(summary_title, 1)
        summary_card_layout.addLayout(summary_header)

        sep2 = QFrame()
        sep2.setFrameShape(QFrame.HLine)
        sep2.setStyleSheet('color: #e9ecef;')
        summary_card_layout.addWidget(sep2)
        
        self.summary_label = QLabel()
        self.summary_label.setFont(QFont('Segoe UI', 11))
        self.summary_label.setWordWrap(True)
        self.summary_label.setStyleSheet('background: transparent; border: none; line-height: 1.6;')
        summary_card_layout.addWidget(self.summary_label)
        
        left_column.addWidget(summary_card)
        left_column.addStretch()
        splitter.addWidget(left_panel)
        
        # ===== PANEL DERECHO =====
        right_panel = QWidget()
        right_column = QVBoxLayout(right_panel)
        right_column.setContentsMargins(0, 0, 0, 0)
        right_column.setSpacing(12)
        
        # Retiros del día
        retiros_header = QHBoxLayout()
        retiros_label = QLabel('Retiros del Día')
        retiros_label.setFont(QFont('Segoe UI', 13, QFont.Bold))
        retiros_label.setStyleSheet('color: #1e293b;')
        retiros_header.addWidget(retiros_label)
        retiros_header.addStretch()
        
        right_column.addLayout(retiros_header)
        
        self.withdrawals_table = QTableWidget()
        self.withdrawals_table.setColumnCount(3)
        self.withdrawals_table.setHorizontalHeaderLabels(['Hora', 'Monto', 'Motivo'])
        self.withdrawals_table.verticalHeader().setVisible(False)
        self.withdrawals_table.setMaximumHeight(220)
        from PyQt5.QtWidgets import QHeaderView as QHV2
        self.withdrawals_table.horizontalHeader().setSectionResizeMode(0, QHV2.ResizeToContents)
        self.withdrawals_table.horizontalHeader().setSectionResizeMode(1, QHV2.ResizeToContents)
        self.withdrawals_table.horizontalHeader().setSectionResizeMode(2, QHV2.Stretch)
        right_column.addWidget(self.withdrawals_table)
        
        # Historial de cajas
        history_header = QHBoxLayout()
        history_label = QLabel('Historial de Cajas')
        history_label.setFont(QFont('Segoe UI', 13, QFont.Bold))
        history_label.setStyleSheet('color: #1e293b;')
        history_header.addWidget(history_label)
        history_header.addStretch()
        
        right_column.addLayout(history_header)
        
        self.history_table = QTableWidget()
        self.history_table.setColumnCount(6)
        self.history_table.setHorizontalHeaderLabels([
            'Fecha Apertura', 'Fecha Cierre', 'Inicial', 'Ventas', 'Retiros', 'Final'
        ])
        self.history_table.verticalHeader().setVisible(False)
        self.history_table.setAlternatingRowColors(True)
        from PyQt5.QtWidgets import QHeaderView as QHV3
        self.history_table.horizontalHeader().setSectionResizeMode(0, QHV3.Stretch)
        self.history_table.horizontalHeader().setSectionResizeMode(1, QHV3.Stretch)
        self.history_table.horizontalHeader().setSectionResizeMode(2, QHV3.ResizeToContents)
        self.history_table.horizontalHeader().setSectionResizeMode(3, QHV3.ResizeToContents)
        self.history_table.horizontalHeader().setSectionResizeMode(4, QHV3.ResizeToContents)
        self.history_table.horizontalHeader().setSectionResizeMode(5, QHV3.ResizeToContents)
        right_column.addWidget(self.history_table)
        splitter.addWidget(right_panel)
        
        splitter.setStretchFactor(0, 35)
        splitter.setStretchFactor(1, 65)
        layout.addWidget(splitter)
        
        # Cargar datos iniciales
        self.refresh_data()
        
    def refresh_data(self):
        current_register = self.cash_register_model.get_current()
        
        if current_register:
            # Caja abierta
            self.open_btn.setEnabled(False)
            self.withdrawal_btn.setEnabled(True)
            self.close_btn.setEnabled(True)
            
            opening_date = _parse_ar(current_register['opening_date'])
            self.status_label.setText(
                f"<b>Estado:</b> <span style='color: #27ae60;'>CAJA ABIERTA</span><br>"
                f"<b>Fecha de Apertura:</b> {opening_date.strftime('%d/%m/%Y %H:%M:%S')}<br>"
                f"<b>Monto Inicial:</b> ${current_register['initial_amount']:.2f}"
            )
            
            # Resumen de efectivo
            cash_summary = self.cash_register_model.get_cash_summary()
            self.summary_label.setText(
                f"<b>Monto Inicial:</b> ${cash_summary['initial_amount']:.2f}<br>"
                f"<b>Ventas en Efectivo:</b> +${cash_summary['cash_sales']:.2f}<br>"
                f"<b>Ventas por Transferencia:</b> ${cash_summary['transfer_sales']:.2f}<br>"
                f"<b>Retiros:</b> -${cash_summary['withdrawals']:.2f}<br>"
                f"<b style='font-size: 14pt; color: #27ae60;'>Efectivo en Caja:</b> "
                f"<b style='font-size: 14pt; color: #27ae60;'>${cash_summary['cash_in_drawer']:.2f}</b>"
            )
            
            # Retiros
            withdrawals = self.cash_register_model.get_withdrawals(current_register['id'])
            self.withdrawals_table.setRowCount(len(withdrawals))
            
            for row, withdrawal in enumerate(withdrawals):
                created_at = _parse_ar(withdrawal['created_at'])
                self.withdrawals_table.setItem(row, 0, 
                    QTableWidgetItem(created_at.strftime('%H:%M:%S')))
                self.withdrawals_table.setItem(row, 1, 
                    QTableWidgetItem(f"${withdrawal['amount']:.2f}"))
                self.withdrawals_table.setItem(row, 2, 
                    QTableWidgetItem(withdrawal['reason']))
        else:
            # Caja cerrada
            self.open_btn.setEnabled(True)
            self.withdrawal_btn.setEnabled(False)
            self.close_btn.setEnabled(False)
            
            self.status_label.setText(
                "<b>Estado:</b> <span style='color: #e74c3c;'>CAJA CERRADA</span><br>"
                "<i>Debe abrir la caja para comenzar a realizar operaciones</i>"
            )
            
            self.summary_label.setText("<i>No hay información disponible</i>")
            self.withdrawals_table.setRowCount(0)
            
        # Historial de cajas
        history = self.cash_register_model.get_all(limit=10)
        self.history_table.setRowCount(len(history))
        
        for row, register in enumerate(history):
            opening_date = _parse_ar(register['opening_date'])
            self.history_table.setItem(row, 0, 
                QTableWidgetItem(opening_date.strftime('%d/%m/%Y %H:%M')))
            
            if register['closing_date']:
                closing_date = _parse_ar(register['closing_date'])
                self.history_table.setItem(row, 1, 
                    QTableWidgetItem(closing_date.strftime('%d/%m/%Y %H:%M')))
            else:
                self.history_table.setItem(row, 1, QTableWidgetItem('En curso'))
                
            self.history_table.setItem(row, 2, 
                QTableWidgetItem(f"${register['initial_amount']:.2f}"))
            self.history_table.setItem(row, 3, 
                QTableWidgetItem(f"${register['total_sales']:.2f}"))
            self.history_table.setItem(row, 4, 
                QTableWidgetItem(f"${register['withdrawals']:.2f}"))
            
            if register['final_amount'] is not None:
                self.history_table.setItem(row, 5, 
                    QTableWidgetItem(f"${register['final_amount']:.2f}"))
            else:
                self.history_table.setItem(row, 5, QTableWidgetItem('-'))
                
    def open_cash_register(self):
        dialog = OpenCashDialog(self)
        if dialog.exec_() == QDialog.Accepted:
            initial_amount = dialog.amount_input.value()
            notes = dialog.notes_input.toPlainText()
            
            register_id = self.cash_register_model.open_register(initial_amount, notes)
            
            if register_id:
                # Subir caja a Firebase para que todas las PCs la vean
                try:
                    from pos_system.utils.firebase_sync import get_firebase_sync
                    fb = get_firebase_sync()
                    if fb:
                        register = self.cash_register_model.get_current()
                        if register:
                            register_with_cajero = dict(register)
                            register_with_cajero['cajero'] = (
                                self.current_user.get('turno_nombre')
                                or self.current_user.get('full_name')
                                or self.current_user.get('username', '')
                            )
                            fb.sync_open_register(register_with_cajero)
                except Exception as e:
                    pass  # No bloquear si Firebase falla

                QMessageBox.information(self, 'Éxito', 
                    f'Caja abierta correctamente\n\nMonto inicial: ${initial_amount:.2f}')
                self.refresh_data()
                main_window = self.get_main_window()
                if main_window:
                    main_window.refresh_all_views()
            else:
                QMessageBox.critical(self, 'Error', 'No se pudo abrir la caja')
                
    def add_withdrawal(self):
        dialog = WithdrawalDialog(self)
        if dialog.exec_() == QDialog.Accepted:
            amount = dialog.amount_input.value()
            reason = dialog.reason_input.toPlainText()
            
            current_register = self.cash_register_model.get_current()
            
            if current_register:
                success = self.cash_register_model.add_withdrawal(
                    current_register['id'], amount, reason
                )
                
                if success:
                    # Generar ticket de retiro
                    withdrawal = {
                        'amount': amount,
                        'reason': reason,
                        'created_at': now_ar().isoformat()
                    }
                    pdf_path = self.pdf_generator.generate_withdrawal_ticket(withdrawal)

                    # ── Sincronizar con Google Sheets ──
                    try:
                        from pos_system.utils.google_sheets_sync import get_sync
                        sync = get_sync()
                        if sync and sync.enabled:
                            sync.sync_withdrawal(withdrawal, register_id=current_register['id'])
                    except Exception as gs_err:
                        import logging
                        logging.getLogger(__name__).warning(f"Google Sheets sync error (retiro): {gs_err}")

                    # Preguntar si desea imprimir
                    reply = QMessageBox.question(
                        self, 
                        'Retiro Registrado',
                        f'Retiro registrado correctamente\n\nMonto: ${amount:.2f}\n\n¿Desea abrir el ticket para imprimir?',
                        QMessageBox.Yes | QMessageBox.No,
                        QMessageBox.Yes
                    )
                    
                    if reply == QMessageBox.Yes:
                        self.open_pdf(pdf_path)
                    
                    self.refresh_data()
                    main_window = self.get_main_window()
                    if main_window:
                        main_window.refresh_all_views()
                else:
                    QMessageBox.critical(self, 'Error', 'No se pudo registrar el retiro')
                    
    def close_cash_register(self):
        current_register = self.cash_register_model.get_current()
        if not current_register:
            return
            
        # Obtener reporte de cierre
        closing_report = self.cash_register_model.get_closing_report(current_register['id'])
        
        # Mostrar diálogo de cierre
        dialog = CloseCashDialog(self, closing_report)
        if dialog.exec_() == QDialog.Accepted:
            final_amount = dialog.final_amount_input.value()
            notes = dialog.notes_input.toPlainText()
            
            # Cerrar caja
            success = self.cash_register_model.close_register(
                current_register['id'], final_amount, notes
            )
            
            if success:
                # Actualizar monto final en el reporte antes de sincronizar
                closing_report['final_amount'] = final_amount
                closing_report['notes'] = notes

                # Marcar caja como cerrada en Firebase (broadcast a todas las PCs)
                try:
                    from pos_system.utils.firebase_sync import get_firebase_sync, now_ar
                    fb = get_firebase_sync()
                    if fb:
                        session_id = now_ar().strftime('%Y-%m-%d')
                        closing_report['session_id'] = session_id
                        fb.sync_close_register(session_id=session_id)
                        fb.sync_cash_closing(closing_report, session_id=session_id)
                except Exception:
                    pass

                # Generar reporte PDF tipo ticket
                pdf_path = None
                try:
                    pdf_path = self.pdf_generator.generate_cash_closing_ticket(closing_report)
                except Exception as e:
                    import logging
                    logging.getLogger(__name__).error(f"Error generando PDF de cierre: {e}")

                # ── Sincronizar con Google Sheets ──
                try:
                    from pos_system.utils.google_sheets_sync import get_sync
                    sync = get_sync()
                    if sync and sync.enabled:
                        sync.sync_cash_closing(closing_report)
                except Exception as gs_err:
                    import logging
                    logging.getLogger(__name__).warning(f"Google Sheets sync error (cierre): {gs_err}")

                difference = final_amount - closing_report['expected_amount']
                diff_text = ''
                if difference > 0:
                    diff_text = f'\n\nSobrante: ${difference:.2f}'
                elif difference < 0:
                    diff_text = f'\n\nFaltante: ${abs(difference):.2f}'
                else:
                    diff_text = '\n\nCierre exacto'
                
                # Preguntar si desea imprimir
                if pdf_path:
                    reply = QMessageBox.question(
                        self,
                        'Caja Cerrada',
                        f'Caja cerrada correctamente{diff_text}\n\n¿Desea abrir el reporte para imprimir?',
                        QMessageBox.Yes | QMessageBox.No,
                        QMessageBox.Yes
                    )
                    
                    if reply == QMessageBox.Yes:
                        self.open_pdf(pdf_path)
                else:
                    QMessageBox.information(
                        self,
                        'Caja Cerrada',
                        f'Caja cerrada correctamente{diff_text}'
                    )
                    
                self.refresh_data()
                main_window = self.get_main_window()
                if main_window:
                    main_window.refresh_all_views()
            else:
                QMessageBox.critical(self, 'Error', 'No se pudo cerrar la caja')

class OpenCashDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.init_ui()
        
    def init_ui(self):
        self.setWindowTitle('Abrir Caja')
        self.setMinimumWidth(400)
        
        layout = QFormLayout(self)
        
        self.amount_input = PriceInput(placeholder='0.00')
        self.amount_input.setFont(QFont('Arial', 10))
        layout.addRow('Monto Inicial ($):', self.amount_input)
        
        self.notes_input = QTextEdit()
        self.notes_input.setMaximumHeight(80)
        self.notes_input.setFont(QFont('Arial', 10))
        layout.addRow('Notas (opcional):', self.notes_input)
        
        buttons_layout = QHBoxLayout()
        
        ok_btn = QPushButton('Abrir Caja')
        ok_btn.setObjectName('btnSuccess')
        ok_btn.clicked.connect(self.accept)
        buttons_layout.addWidget(ok_btn)
        
        cancel_btn = QPushButton('Cancelar')
        cancel_btn.setObjectName('btnSecondary')
        cancel_btn.clicked.connect(self.reject)
        buttons_layout.addWidget(cancel_btn)
        
        layout.addRow('', buttons_layout)

class WithdrawalDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.init_ui()
        
    def init_ui(self):
        self.setWindowTitle('Retiro de Efectivo')
        self.setMinimumWidth(400)
        
        layout = QFormLayout(self)
        
        self.amount_input = PriceInput(placeholder='0.00')
        self.amount_input.setFont(QFont('Arial', 10))
        layout.addRow('Monto a Retirar ($):', self.amount_input)
        
        self.reason_input = QTextEdit()
        self.reason_input.setMaximumHeight(80)
        self.reason_input.setFont(QFont('Arial', 10))
        layout.addRow('Motivo del Retiro:', self.reason_input)
        
        buttons_layout = QHBoxLayout()
        
        ok_btn = QPushButton('Registrar Retiro')
        ok_btn.setObjectName('btnSuccess')
        ok_btn.clicked.connect(self.validate_and_accept)
        buttons_layout.addWidget(ok_btn)
        
        cancel_btn = QPushButton('Cancelar')
        cancel_btn.setObjectName('btnSecondary')
        cancel_btn.clicked.connect(self.reject)
        buttons_layout.addWidget(cancel_btn)
        
        layout.addRow('', buttons_layout)
        
    def validate_and_accept(self):
        if self.amount_input.value() <= 0:
            QMessageBox.warning(self, 'Error', 'El monto debe ser mayor a 0')
            return
        if not self.reason_input.toPlainText():
            QMessageBox.warning(self, 'Error', 'Debe indicar el motivo del retiro')
            return
        self.accept()

class CloseCashDialog(QDialog):
    def __init__(self, parent=None, closing_report=None):
        super().__init__(parent)
        self.closing_report = closing_report
        self.init_ui()
        
    def init_ui(self):
        self.setWindowTitle('Cerrar Caja')
        self.setMinimumWidth(500)
        
        layout = QVBoxLayout(self)
        
        # Resumen
        summary_group = QGroupBox('Resumen del Día')
        summary_layout = QFormLayout()
        
        if self.closing_report:
            summary_layout.addRow('Monto Inicial:', 
                QLabel(f"${self.closing_report['initial_amount']:.2f}"))
            summary_layout.addRow('Ventas en Efectivo:', 
                QLabel(f"${self.closing_report['cash_sales']:.2f}"))
            summary_layout.addRow('Ventas por Transferencia:', 
                QLabel(f"${self.closing_report['transfer_sales']:.2f}"))
            summary_layout.addRow('Total Ventas:', 
                QLabel(f"${self.closing_report['total_sales']:.2f}"))
            summary_layout.addRow('Retiros:', 
                QLabel(f"${self.closing_report['withdrawals']:.2f}"))
            
            expected_label = QLabel(f"${self.closing_report['expected_amount']:.2f}")
            expected_label.setFont(QFont('Arial', 12, QFont.Bold))
            expected_label.setStyleSheet('color: #27ae60;')
            summary_layout.addRow('Efectivo Esperado en Caja:', expected_label)
            
        summary_group.setLayout(summary_layout)
        layout.addWidget(summary_group)
        
        # Monto final
        form_layout = QFormLayout()
        
        self.final_amount_input = PriceInput(placeholder='0.00')
        self.final_amount_input.setFont(QFont('Arial', 10))
        if self.closing_report:
            self.final_amount_input.setValue(self.closing_report['expected_amount'])
        form_layout.addRow('Efectivo Real Contado ($):', self.final_amount_input)
        
        self.notes_input = QTextEdit()
        self.notes_input.setMaximumHeight(80)
        self.notes_input.setFont(QFont('Arial', 10))
        form_layout.addRow('Notas (opcional):', self.notes_input)
        
        layout.addLayout(form_layout)
        
        # Botones
        buttons_layout = QHBoxLayout()
        
        ok_btn = QPushButton('Cerrar Caja')
        ok_btn.setObjectName('btnDanger')
        ok_btn.setFont(QFont('Arial', 10, QFont.Bold))
        ok_btn.clicked.connect(self.accept)
        buttons_layout.addWidget(ok_btn)
        
        cancel_btn = QPushButton('Cancelar')
        cancel_btn.setObjectName('btnSecondary')
        cancel_btn.clicked.connect(self.reject)
        buttons_layout.addWidget(cancel_btn)
        
        layout.addLayout(buttons_layout)
