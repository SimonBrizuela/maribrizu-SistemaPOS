from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch, mm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image as RLImage
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT, TA_LEFT, TA_JUSTIFY
from reportlab.pdfgen import canvas
from datetime import datetime, timezone, timedelta
import os

_TZ_AR = timezone(timedelta(hours=-3))

def _parse_ar(s):
    try:
        dt = datetime.fromisoformat(str(s))
    except (ValueError, TypeError):
        return datetime.now(_TZ_AR).replace(tzinfo=None)
    if dt.tzinfo is not None:
        return dt.astimezone(_TZ_AR).replace(tzinfo=None)
    return dt
import io
import json
import base64
try:
    import qrcode
    _QRCODE_AVAILABLE = True
except ImportError:
    _QRCODE_AVAILABLE = False

class PDFGenerator:
    def __init__(self, output_dir=None):
        if output_dir is None:
            from pos_system.config import REPORTS_DIR
            output_dir = str(REPORTS_DIR)
        self.output_dir = output_dir
        os.makedirs(output_dir, exist_ok=True)
        self.styles = getSampleStyleSheet()
        
        # Información de la empresa (temporal - se puede configurar después)
        self.company_info = {
            'name': 'Tu Empresa',
            'address': 'Dirección de tu negocio',
            'phone': 'Tel: (000) 000-0000',
            'email': 'info@tuempresa.com',
            'website': 'www.tuempresa.com'
        }
        
    def set_company_info(self, name, address, phone, email, website):
        """Configura la información de la empresa"""
        self.company_info = {
            'name': name,
            'address': address,
            'phone': phone,
            'email': email,
            'website': website
        }
    
    def draw_header(self, canvas_obj, doc):
        """Dibuja el header del PDF"""
        canvas_obj.saveState()
        
        # Logo o nombre de empresa
        canvas_obj.setFont('Helvetica-Bold', 16)
        canvas_obj.setFillColor(colors.HexColor('#1877f2'))
        canvas_obj.drawString(doc.leftMargin, doc.height + doc.topMargin - 20, self.company_info['name'])
        
        # Información de contacto
        canvas_obj.setFont('Helvetica', 9)
        canvas_obj.setFillColor(colors.black)
        y_position = doc.height + doc.topMargin - 35
        canvas_obj.drawString(doc.leftMargin, y_position, self.company_info['address'])
        y_position -= 12
        canvas_obj.drawString(doc.leftMargin, y_position, f"{self.company_info['phone']} | {self.company_info['email']}")
        
        # Línea separadora
        canvas_obj.setStrokeColor(colors.HexColor('#e4e6eb'))
        canvas_obj.setLineWidth(2)
        canvas_obj.line(doc.leftMargin, doc.height + doc.topMargin - 55, 
                       doc.width + doc.leftMargin, doc.height + doc.topMargin - 55)
        
        canvas_obj.restoreState()
    
    def draw_footer(self, canvas_obj, doc):
        """Dibuja el footer del PDF"""
        canvas_obj.saveState()
        
        canvas_obj.setFont('Helvetica', 8)
        canvas_obj.setFillColor(colors.HexColor('#65676b'))
        
        # Línea separadora
        canvas_obj.setStrokeColor(colors.HexColor('#e4e6eb'))
        canvas_obj.setLineWidth(1)
        canvas_obj.line(doc.leftMargin, 40, doc.width + doc.leftMargin, 40)
        
        # Texto del footer
        footer_text = f"Documento generado el {datetime.now().strftime('%d/%m/%Y %H:%M')} | {self.company_info['website']}"
        canvas_obj.drawCentredString(doc.width/2 + doc.leftMargin, 25, footer_text)
        
        canvas_obj.restoreState()
        
    def generate_sale_ticket(self, sale):
        """Generar ticket de venta profesional estilo termico"""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f'ticket_venta_{sale["id"]}_{timestamp}.pdf'
        filepath = os.path.join(self.output_dir, filename)

        # Calcular altura dinamica segun items
        n_items = len(sale.get('items', []))
        base_height = 180
        extra_per_item = 14
        page_height = max(base_height, base_height + (n_items - 3) * extra_per_item)

        doc = SimpleDocTemplate(
            filepath,
            pagesize=(80*mm, page_height*mm),
            topMargin=6*mm,
            bottomMargin=6*mm,
            leftMargin=4*mm,
            rightMargin=4*mm
        )
        story = []

        # ── Estilos ──────────────────────────────────────────────────────────
        def S(name, **kw):
            return ParagraphStyle(name, parent=self.styles['Normal'], **kw)

        sty_empresa  = S('E', fontSize=11, fontName='Helvetica-Bold', alignment=TA_CENTER, textColor=colors.black, spaceAfter=1)
        sty_sub      = S('Su', fontSize=7, alignment=TA_CENTER, textColor=colors.HexColor('#555555'), spaceAfter=1)
        sty_titulo   = S('T', fontSize=9, fontName='Helvetica-Bold', alignment=TA_CENTER, textColor=colors.black, spaceAfter=2, spaceBefore=2)
        sty_dato     = S('D', fontSize=8, textColor=colors.black, spaceAfter=1)
        sty_dato_r   = S('DR', fontSize=8, textColor=colors.black, alignment=TA_RIGHT, spaceAfter=1)
        sty_sep      = S('Sep', fontSize=7, textColor=colors.HexColor('#aaaaaa'), alignment=TA_CENTER, spaceAfter=1)
        sty_total    = S('Tot', fontSize=13, fontName='Helvetica-Bold', alignment=TA_RIGHT, textColor=colors.black, spaceBefore=2, spaceAfter=2)
        sty_ahorro   = S('Aho', fontSize=8, fontName='Helvetica-Bold', alignment=TA_RIGHT, textColor=colors.HexColor('#cc0000'), spaceAfter=1)
        sty_footer   = S('F', fontSize=7, alignment=TA_CENTER, textColor=colors.HexColor('#777777'), spaceAfter=1)
        sty_pago     = S('P', fontSize=8, fontName='Helvetica-Bold', alignment=TA_CENTER, textColor=colors.black, spaceAfter=1)

        # ── Encabezado ───────────────────────────────────────────────────────
        story.append(Paragraph(self.company_info['name'].upper(), sty_empresa))
        if self.company_info.get('address'):
            story.append(Paragraph(self.company_info['address'], sty_sub))
        if self.company_info.get('phone'):
            story.append(Paragraph(self.company_info['phone'], sty_sub))
        story.append(Spacer(1, 2*mm))
        story.append(Paragraph('* * * * * * * * * * * * * * * * * * *', sty_sep))
        story.append(Paragraph('COMPROBANTE DE VENTA', sty_titulo))
        story.append(Paragraph('* * * * * * * * * * * * * * * * * * *', sty_sep))
        story.append(Spacer(1, 2*mm))

        # ── Datos de la venta ────────────────────────────────────────────────
        sale_date = _parse_ar(sale['created_at'])
        payment_text = 'Efectivo' if sale['payment_type'] == 'cash' else 'Transferencia'

        info_data = [
            ['N° Ticket:', f'#{sale["id"]}'],
            ['Fecha:', sale_date.strftime('%d/%m/%Y')],
            ['Hora:', sale_date.strftime('%H:%M')],
        ]
        info_tbl = Table(info_data, colWidths=[22*mm, 46*mm])
        info_tbl.setStyle(TableStyle([
            ('FONTNAME',    (0, 0), (0, -1), 'Helvetica-Bold'),
            ('FONTNAME',    (1, 0), (1, -1), 'Helvetica'),
            ('FONTSIZE',    (0, 0), (-1, -1), 8),
            ('TEXTCOLOR',   (0, 0), (-1, -1), colors.black),
            ('TOPPADDING',  (0, 0), (-1, -1), 1),
            ('BOTTOMPADDING',(0,0), (-1, -1), 1),
            ('VALIGN',      (0, 0), (-1, -1), 'MIDDLE'),
        ]))
        story.append(info_tbl)
        story.append(Spacer(1, 2*mm))
        story.append(Paragraph('- - - - - - - - - - - - - - - - - - -', sty_sep))
        story.append(Spacer(1, 1*mm))

        # ── Tabla de items ───────────────────────────────────────────────────
        items_data = [['CANT', 'DESCRIPCION', 'P.UNIT', 'TOTAL']]
        discount_rows = []
        promo_notes   = []

        for idx, item in enumerate(sale.get('items', [])):
            prod_name   = item.get('product_name', '-')
            prod_name   = (prod_name[:16] + '..') if len(prod_name) > 16 else prod_name
            disc_amount = float(item.get('discount_amount', 0) or 0)
            orig_price  = float(item.get('original_price') or item.get('unit_price', 0))
            unit_price  = float(item.get('unit_price', 0))
            disc_type   = item.get('discount_type', '')

            if disc_amount > 0:
                price_cell = f'${orig_price:.2f}\n${unit_price:.2f}*'
                discount_rows.append(idx + 1)
                # Nota de promo
                if disc_type == 'percentage':
                    promo_notes.append(f'* {prod_name[:12]}: {int(item.get("discount_value",0))}% OFF  -${disc_amount:.2f}')
                elif disc_type == '2x1':
                    promo_notes.append(f'* {prod_name[:12]}: Promo 2x1  -${disc_amount:.2f}')
                elif disc_type in ('nxm', 'bundle'):
                    promo_notes.append(f'* {prod_name[:12]}: Promo especial  -${disc_amount:.2f}')
                else:
                    promo_notes.append(f'* {prod_name[:12]}: Desc.  -${disc_amount:.2f}')
            else:
                price_cell = f'${unit_price:.2f}'

            items_data.append([
                str(item.get('quantity', 1)),
                prod_name,
                price_cell,
                f'${float(item.get("subtotal", 0)):.2f}'
            ])

        items_tbl = Table(items_data, colWidths=[8*mm, 34*mm, 16*mm, 14*mm])
        ts = TableStyle([
            # Header
            ('FONTNAME',     (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE',     (0, 0), (-1, 0), 7),
            ('BACKGROUND',   (0, 0), (-1, 0), colors.black),
            ('TEXTCOLOR',    (0, 0), (-1, 0), colors.white),
            ('ALIGN',        (0, 0), (-1, 0), 'CENTER'),
            # Filas
            ('FONTNAME',     (0, 1), (-1, -1), 'Helvetica'),
            ('FONTSIZE',     (0, 1), (-1, -1), 8),
            ('TEXTCOLOR',    (0, 1), (-1, -1), colors.black),
            ('ALIGN',        (0, 1), (-1, -1), 'LEFT'),
            ('ALIGN',        (0, 0), (0, -1), 'CENTER'),
            ('ALIGN',        (2, 0), (-1, -1), 'RIGHT'),
            ('VALIGN',       (0, 0), (-1, -1), 'MIDDLE'),
            # Separadores
            ('LINEBELOW',    (0, 0), (-1, 0), 0.5, colors.black),
            ('LINEBELOW',    (0, 1), (-1, -2), 0.3, colors.HexColor('#dddddd')),
            ('TOPPADDING',   (0, 0), (-1, -1), 2),
            ('BOTTOMPADDING',(0, 0), (-1, -1), 2),
            # Filas alternas
            *[('BACKGROUND', (0, i), (-1, i), colors.HexColor('#f7f7f7'))
              for i in range(2, len(items_data), 2)],
        ])
        # Filas con descuento en rojo
        for dr in discount_rows:
            ts.add('TEXTCOLOR', (2, dr), (2, dr), colors.HexColor('#cc0000'))
            ts.add('FONTNAME',  (2, dr), (2, dr), 'Helvetica-Bold')
        items_tbl.setStyle(ts)
        story.append(items_tbl)
        story.append(Spacer(1, 1*mm))

        # ── Notas de descuento ───────────────────────────────────────────────
        if promo_notes:
            sty_promo = S('Pn', fontSize=7, textColor=colors.HexColor('#cc0000'), spaceAfter=1)
            for note in promo_notes:
                story.append(Paragraph(note, sty_promo))

        # ── Ahorro total ─────────────────────────────────────────────────────
        total_discount = sum(float(it.get('discount_amount', 0) or 0) for it in sale.get('items', []))
        if total_discount > 0:
            story.append(Spacer(1, 1*mm))
            story.append(Paragraph(f'AHORRO TOTAL:  -${total_discount:.2f}', sty_ahorro))

        story.append(Spacer(1, 2*mm))
        story.append(Paragraph('- - - - - - - - - - - - - - - - - - -', sty_sep))

        # ── Subtotales y total ───────────────────────────────────────────────
        subtotales = [
            ['SUBTOTAL:', f'${sale["total_amount"]:.2f}'],
        ]
        if sale['payment_type'] == 'cash':
            cash_recv = float(sale.get('cash_received', 0) or 0)
            change    = float(sale.get('change_given', 0) or 0)
            if cash_recv > 0:
                subtotales.append(['RECIBIDO:', f'${cash_recv:.2f}'])
            if change > 0:
                subtotales.append(['VUELTO:', f'${change:.2f}'])

        sub_tbl = Table(subtotales, colWidths=[42*mm, 30*mm])
        sub_tbl.setStyle(TableStyle([
            ('FONTNAME',     (0, 0), (-1, -1), 'Helvetica'),
            ('FONTSIZE',     (0, 0), (-1, -1), 8),
            ('TEXTCOLOR',    (0, 0), (-1, -1), colors.black),
            ('ALIGN',        (0, 0), (0, -1), 'LEFT'),
            ('ALIGN',        (1, 0), (1, -1), 'RIGHT'),
            ('TOPPADDING',   (0, 0), (-1, -1), 1),
            ('BOTTOMPADDING',(0, 0), (-1, -1), 1),
        ]))
        story.append(sub_tbl)

        story.append(Spacer(1, 1*mm))
        story.append(Paragraph('= = = = = = = = = = = = = = = = = = =', sty_sep))
        story.append(Paragraph(f'TOTAL  ${sale["total_amount"]:.2f}', sty_total))
        story.append(Paragraph('= = = = = = = = = = = = = = = = = = =', sty_sep))
        story.append(Spacer(1, 1*mm))

        # ── Forma de pago ────────────────────────────────────────────────────
        story.append(Paragraph(f'Forma de pago: {payment_text}', sty_pago))
        story.append(Spacer(1, 3*mm))

        # ── Footer ───────────────────────────────────────────────────────────
        story.append(Paragraph('- - - - - - - - - - - - - - - - - - -', sty_sep))
        story.append(Paragraph('¡Gracias por su compra!', sty_footer))
        if self.company_info.get('website'):
            story.append(Paragraph(self.company_info['website'], sty_footer))
        story.append(Paragraph(sale_date.strftime('%d/%m/%Y %H:%M'), sty_footer))

        doc.build(story)
        return filepath
    
    def generate_withdrawal_ticket(self, withdrawal):
        """Generar ticket de retiro profesional"""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f'retiro_{timestamp}.pdf'
        filepath = os.path.join(self.output_dir, filename)
        
        doc = SimpleDocTemplate(
            filepath, 
            pagesize=(80*mm, 150*mm),
            topMargin=10*mm,
            bottomMargin=10*mm,
            leftMargin=5*mm,
            rightMargin=5*mm
        )
        story = []
        
        # Estilos
        title_style = ParagraphStyle(
            'TicketTitle',
            parent=self.styles['Heading1'],
            fontSize=14,
            textColor=colors.HexColor('#ff9500'),
            spaceAfter=6,
            alignment=TA_CENTER,
            fontName='Helvetica-Bold'
        )
        
        company_style = ParagraphStyle(
            'Company',
            parent=self.styles['Normal'],
            fontSize=10,
            textColor=colors.HexColor('#050505'),
            alignment=TA_CENTER,
            fontName='Helvetica-Bold'
        )
        
        info_style = ParagraphStyle(
            'Info',
            parent=self.styles['Normal'],
            fontSize=8,
            textColor=colors.HexColor('#65676b'),
            alignment=TA_CENTER
        )
        
        normal_style = ParagraphStyle(
            'Normal',
            parent=self.styles['Normal'],
            fontSize=9,
            textColor=colors.HexColor('#050505')
        )
        
        # Encabezado
        story.append(Paragraph(self.company_info['name'], company_style))
        story.append(Paragraph(self.company_info['address'], info_style))
        story.append(Spacer(1, 4*mm))
        
        story.append(Paragraph('─' * 35, info_style))
        story.append(Spacer(1, 2*mm))
        
        # Título
        story.append(Paragraph('RETIRO DE EFECTIVO', title_style))
        story.append(Spacer(1, 3*mm))
        
        # Información
        withdrawal_date = _parse_ar(withdrawal['created_at'])
        story.append(Paragraph(f'<b>Fecha:</b> {withdrawal_date.strftime("%d/%m/%Y %H:%M")}', normal_style))
        story.append(Spacer(1, 3*mm))
        
        # Monto destacado
        amount_style = ParagraphStyle(
            'Amount',
            parent=self.styles['Normal'],
            fontSize=16,
            textColor=colors.HexColor('#ff9500'),
            alignment=TA_CENTER,
            fontName='Helvetica-Bold'
        )
        story.append(Paragraph(f'MONTO: ${withdrawal["amount"]:.2f}', amount_style))
        story.append(Spacer(1, 4*mm))
        
        story.append(Paragraph('─' * 35, info_style))
        story.append(Spacer(1, 2*mm))
        
        # Motivo
        story.append(Paragraph('<b>Motivo:</b>', normal_style))
        story.append(Spacer(1, 1*mm))
        reason_style = ParagraphStyle(
            'Reason',
            parent=self.styles['Normal'],
            fontSize=9,
            textColor=colors.HexColor('#050505'),
            alignment=TA_JUSTIFY
        )
        story.append(Paragraph(withdrawal['reason'], reason_style))
        story.append(Spacer(1, 6*mm))
        
        # Firma
        story.append(Paragraph('_' * 25, info_style))
        story.append(Paragraph('Firma Autorizada', info_style))
        
        doc.build(story)
        return filepath
    
    def generate_cash_closing_report(self, report):
        """Generar reporte de cierre de caja profesional"""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f'cierre_caja_{report["id"]}_{timestamp}.pdf'
        filepath = os.path.join(self.output_dir, filename)
        
        doc = SimpleDocTemplate(
            filepath, 
            pagesize=letter,
            topMargin=80,
            bottomMargin=60
        )
        
        story = []
        
        # Título
        title_style = ParagraphStyle(
            'CustomTitle',
            parent=self.styles['Heading1'],
            fontSize=20,
            textColor=colors.HexColor('#1877f2'),
            spaceAfter=20,
            alignment=TA_CENTER,
            fontName='Helvetica-Bold'
        )
        story.append(Paragraph('REPORTE DE CIERRE DE CAJA', title_style))
        story.append(Spacer(1, 10))
        
        # Información general
        opening_date = _parse_ar(report['opening_date'])
        closing_date = _parse_ar(report['closing_date']) if report['closing_date'] else datetime.now(_TZ_AR).replace(tzinfo=None)
        
        info_data = [
            ['Caja #:', str(report['id'])],
            ['Apertura:', opening_date.strftime('%d/%m/%Y %H:%M:%S')],
            ['Cierre:', closing_date.strftime('%d/%m/%Y %H:%M:%S')],
        ]
        
        info_table = Table(info_data, colWidths=[2*inch, 4*inch])
        info_table.setStyle(TableStyle([
            ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
            ('FONTNAME', (1, 0), (1, -1), 'Helvetica'),
            ('FONTSIZE', (0, 0), (-1, -1), 11),
            ('TEXTCOLOR', (0, 0), (-1, -1), colors.HexColor('#050505')),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ]))
        story.append(info_table)
        story.append(Spacer(1, 20))
        
        # Resumen financiero
        section_style = ParagraphStyle(
            'Section',
            parent=self.styles['Heading2'],
            fontSize=14,
            textColor=colors.HexColor('#1877f2'),
            spaceAfter=12,
            fontName='Helvetica-Bold'
        )
        story.append(Paragraph('RESUMEN FINANCIERO', section_style))
        
        financial_data = [
            ['Concepto', 'Monto'],
            ['Monto Inicial', f"${report['initial_amount']:.2f}"],
            ['Ventas en Efectivo', f"+${report['cash_sales']:.2f}"],
            ['Ventas por Transferencia', f"${report['transfer_sales']:.2f}"],
            ['Total Ventas', f"${report['total_sales']:.2f}"],
            ['Retiros', f"-${report['withdrawals']:.2f}"],
            ['', ''],
            ['Efectivo Esperado', f"${report['expected_amount']:.2f}"],
            ['Efectivo Real Contado', f"${report['final_amount']:.2f}"],
        ]
        
        # Calcular diferencia
        difference = report['final_amount'] - report['expected_amount']
        if difference != 0:
            diff_text = f"${abs(difference):.2f} {'(Sobrante)' if difference > 0 else '(Faltante)'}"
            financial_data.append(['Diferencia', diff_text])
        
        financial_table = Table(financial_data, colWidths=[4*inch, 2*inch])
        financial_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1877f2')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('ALIGN', (1, 0), (1, -1), 'RIGHT'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, 0), 12),
            ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
            ('FONTSIZE', (0, 1), (-1, -1), 11),
            ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#e4e6eb')),
            ('BACKGROUND', (0, 7), (-1, -1), colors.HexColor('#f0f2f5')),
            ('FONTNAME', (0, 7), (-1, -1), 'Helvetica-Bold'),
            ('TOPPADDING', (0, 0), (-1, -1), 8),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
        ]))
        
        # Color especial para diferencia
        if difference < 0:
            financial_table.setStyle(TableStyle([
                ('BACKGROUND', (0, -1), (-1, -1), colors.HexColor('#fee')),
                ('TEXTCOLOR', (0, -1), (-1, -1), colors.HexColor('#c00')),
            ]))
        elif difference > 0:
            financial_table.setStyle(TableStyle([
                ('BACKGROUND', (0, -1), (-1, -1), colors.HexColor('#e7f3ff')),
                ('TEXTCOLOR', (0, -1), (-1, -1), colors.HexColor('#1877f2')),
            ]))
        
        story.append(financial_table)
        story.append(Spacer(1, 20))
        
        # Detalle de ventas
        story.append(Paragraph('DETALLE DE VENTAS', section_style))
        
        sales_data = [
            ['Tipo de Pago', 'Cantidad', 'Total'],
            ['Efectivo', str(report['num_cash_sales']), f"${report['cash_sales']:.2f}"],
            ['Transferencia', str(report['num_transfer_sales']), f"${report['transfer_sales']:.2f}"],
            ['TOTAL', str(report['total_sales_count']), f"${report['total_sales']:.2f}"],
        ]
        
        sales_table = Table(sales_data, colWidths=[3*inch, 1.5*inch, 1.5*inch])
        sales_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#42b72a')),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, 0), 12),
            ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
            ('FONTSIZE', (0, 1), (-1, -1), 11),
            ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#e4e6eb')),
            ('BACKGROUND', (0, -1), (-1, -1), colors.HexColor('#f0f2f5')),
            ('FONTNAME', (0, -1), (-1, -1), 'Helvetica-Bold'),
            ('TOPPADDING', (0, 0), (-1, -1), 8),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
        ]))
        story.append(sales_table)

        # Productos vendidos
        if report.get('products') and len(report['products']) > 0:
            story.append(Spacer(1, 20))
            story.append(Paragraph('PRODUCTOS VENDIDOS', section_style))
            
            products_data = [['Producto', 'Cantidad', 'Total']]
            for product in report['products']:
                products_data.append([
                    product['product_name'],
                    str(product['total_quantity']),
                    f"${product['total_amount']:.2f}"
                ])
            
            products_table = Table(products_data, colWidths=[3.5*inch, 1.25*inch, 1.25*inch])
            products_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1877f2')),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
                ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                ('ALIGN', (1, 0), (-1, -1), 'CENTER'),
                ('ALIGN', (2, 0), (-1, -1), 'RIGHT'),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, 0), 11),
                ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
                ('FONTSIZE', (0, 1), (-1, -1), 10),
                ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#e4e6eb')),
                ('TOPPADDING', (0, 0), (-1, -1), 6),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f9f9fb')]),
            ]))
            story.append(products_table)
        
        # Notas
        if report.get('notes'):
            story.append(Spacer(1, 20))
            story.append(Paragraph('NOTAS', section_style))
            notes_style = ParagraphStyle(
                'Notes',
                parent=self.styles['Normal'],
                fontSize=10,
                textColor=colors.HexColor('#050505'),
                alignment=TA_JUSTIFY
            )
            story.append(Paragraph(report['notes'], notes_style))
        
        # Construir PDF con header y footer
        doc.build(story, onFirstPage=self.draw_header, onLaterPages=self.draw_header)
        
        return filepath
        
    
    def generate_cash_closing_ticket(self, report):
        """Generar ticket de cierre de caja estilo térmico"""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f'cierre_caja_{report["id"]}_{timestamp}.pdf'
        filepath = os.path.join(self.output_dir, filename)
        
        doc = SimpleDocTemplate(
            filepath, 
            pagesize=(80*mm, 280*mm),
            topMargin=10*mm,
            bottomMargin=10*mm,
            leftMargin=5*mm,
            rightMargin=5*mm
        )
        story = []
        
        # Estilos
        title_style = ParagraphStyle(
            'TicketTitle',
            parent=self.styles['Heading1'],
            fontSize=13,
            textColor=colors.black,
            spaceAfter=4,
            alignment=TA_CENTER,
            fontName='Helvetica-Bold'
        )
        
        company_style = ParagraphStyle(
            'Company',
            parent=self.styles['Normal'],
            fontSize=10,
            textColor=colors.black,
            alignment=TA_CENTER,
            fontName='Helvetica-Bold'
        )
        
        info_style = ParagraphStyle(
            'Info',
            parent=self.styles['Normal'],
            fontSize=8,
            textColor=colors.black,
            alignment=TA_CENTER,
            spaceAfter=2
        )
        
        normal_style = ParagraphStyle(
            'Normal',
            parent=self.styles['Normal'],
            fontSize=8,
            textColor=colors.black,
            spaceAfter=3
        )
        
        bold_style = ParagraphStyle(
            'Bold',
            parent=self.styles['Normal'],
            fontSize=9,
            textColor=colors.black,
            fontName='Helvetica-Bold',
            spaceAfter=2
        )
        
        # Encabezado
        story.append(Paragraph(self.company_info['name'], company_style))
        story.append(Paragraph(self.company_info['address'], info_style))
        story.append(Spacer(1, 3*mm))
        
        story.append(Paragraph('=' * 40, info_style))
        story.append(Spacer(1, 2*mm))
        
        # Título
        story.append(Paragraph('CIERRE DE CAJA', title_style))
        story.append(Spacer(1, 3*mm))
        
        # Información de caja
        opening_date = _parse_ar(report['opening_date'])
        closing_date = _parse_ar(report['closing_date']) if report['closing_date'] else datetime.now(_TZ_AR).replace(tzinfo=None)
        
        story.append(Paragraph(f'<b>Caja #:</b> {report["id"]}', normal_style))
        story.append(Paragraph(f'<b>Apertura:</b> {opening_date.strftime("%d/%m/%Y %H:%M")}', normal_style))
        story.append(Paragraph(f'<b>Cierre:</b> {closing_date.strftime("%d/%m/%Y %H:%M")}', normal_style))
        
        story.append(Spacer(1, 3*mm))
        story.append(Paragraph('=' * 40, info_style))
        story.append(Spacer(1, 2*mm))
        
        # Resumen de ventas
        story.append(Paragraph('RESUMEN DE VENTAS', bold_style))
        story.append(Spacer(1, 1*mm))
        
        story.append(Paragraph(f'Efectivo: {report["num_cash_sales"]} ventas - ${report["cash_sales"]:.2f}', normal_style))
        story.append(Paragraph(f'Transferencia: {report["num_transfer_sales"]} ventas - ${report["transfer_sales"]:.2f}', normal_style))
        story.append(Paragraph(f'<b>Total Ventas: {report["total_sales_count"]} - ${report["total_sales"]:.2f}</b>', bold_style))
        
        story.append(Spacer(1, 3*mm))
        story.append(Paragraph('-' * 40, info_style))
        story.append(Spacer(1, 2*mm))
        
        # Productos vendidos
        if report.get('products') and len(report['products']) > 0:
            story.append(Paragraph('PRODUCTOS VENDIDOS', bold_style))
            story.append(Spacer(1, 1*mm))
            
            for product in report['products']:
                prod_name = product['product_name'][:25] + '...' if len(product['product_name']) > 25 else product['product_name']
                story.append(Paragraph(f'{prod_name}', normal_style))
                story.append(Paragraph(f'  {product["total_quantity"]} x ${product["total_amount"]/product["total_quantity"]:.2f} = ${product["total_amount"]:.2f}', normal_style))
                story.append(Spacer(1, 1*mm))
            
            story.append(Spacer(1, 2*mm))
            story.append(Paragraph('-' * 40, info_style))
            story.append(Spacer(1, 2*mm))
        
        # Resumen de efectivo
        story.append(Paragraph('RESUMEN DE EFECTIVO', bold_style))
        story.append(Spacer(1, 1*mm))
        
        story.append(Paragraph(f'Monto Inicial: ${report["initial_amount"]:.2f}', normal_style))
        story.append(Paragraph(f'+ Ventas Efectivo: ${report["cash_sales"]:.2f}', normal_style))
        story.append(Paragraph(f'- Retiros: ${report["withdrawals"]:.2f}', normal_style))
        story.append(Paragraph(f'= Efectivo Esperado: ${report["expected_amount"]:.2f}', bold_style))
        story.append(Spacer(1, 2*mm))
        story.append(Paragraph(f'Efectivo Contado: ${report["final_amount"]:.2f}', bold_style))
        
        # Diferencia
        difference = report['final_amount'] - report['expected_amount']
        if difference != 0:
            story.append(Spacer(1, 2*mm))
            if difference > 0:
                story.append(Paragraph(f'SOBRANTE: ${difference:.2f}', bold_style))
            else:
                story.append(Paragraph(f'FALTANTE: ${abs(difference):.2f}', bold_style))
        
        story.append(Spacer(1, 3*mm))
        story.append(Paragraph('=' * 40, info_style))
        story.append(Spacer(1, 2*mm))
        
        # Totales
        total_style = ParagraphStyle(
            'Total',
            parent=self.styles['Normal'],
            fontSize=10,
            textColor=colors.black,
            fontName='Helvetica-Bold',
            alignment=TA_CENTER
        )
        story.append(Paragraph(f'TOTAL GENERAL: ${report["total_sales"]:.2f}', total_style))
        story.append(Spacer(1, 4*mm))
        
        # Footer
        footer_style = ParagraphStyle(
            'Footer',
            parent=self.styles['Normal'],
            fontSize=7,
            textColor=colors.black,
            alignment=TA_CENTER
        )
        story.append(Paragraph(f'Documento generado: {datetime.now().strftime("%d/%m/%Y %H:%M")}', footer_style))
        story.append(Spacer(1, 3*mm))
        story.append(Paragraph('_' * 25, footer_style))
        story.append(Paragraph('Firma', footer_style))
        
        doc.build(story)
        return filepath

    def generate_factura_afip(self, factura):
        """
        Genera una Factura Electrónica tipo A, B o C estilo ticket térmico AFIP.

        Parámetro 'factura' (dict):
        {
            'cuit':               '20123456789',
            'ing_brutos':         '123456789',
            'razon_social':       'Mi Empresa SRL',
            'domicilio':          'Av. Siempre Viva 123',
            'localidad':          'CÓRDOBA (5000) - CÓRDOBA',
            'telefono':           '3511234567',
            'inicio_actividades': '01/01/2020',
            'condicion_iva':      'Resp. Inscripto',

            'tipo_comprobante':   'FAC. ELEC. B',   # FAC. ELEC. A / B / C
            'punto_venta':        1,
            'nro_comprobante':    1,
            'fecha':              '02/04/2026 10:00:00 AM',
            'turno':              '00001',
            'pago':               'Efectivo',
            'modalidad':          'LOCAL',

            'cliente':            'CONSUMIDOR FINAL',

            'items': [
                {
                    'cantidad':    1.0,
                    'descripcion': 'Producto',
                    'iva':         21.0,
                    'precio':      1000.0,
                    'importe':     1000.0,
                },
            ],

            'total':            1000.0,
            'iva_contenido':    173.55,
            'otros_impuestos':  0.0,

            # Datos AFIP recibidos del WSFE:
            'cae':              '12345678901234',
            'vto_cae':          '20260412',   # formato AAAAMMDD
        }
        """
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        nro = str(factura.get('nro_comprobante', 0)).zfill(8)
        filename = f'factura_{nro}_{timestamp}.pdf'
        filepath = os.path.join(self.output_dir, filename)

        # Altura estimada generosa; luego recortamos con _build_story
        _PAGE_W = 80*mm
        _MARGIN = 4*mm

        story = []

        # ── Helpers de estilo ────────────────────────────────────────────────
        styles = getSampleStyleSheet()
        def Saf(name, **kw):
            return ParagraphStyle(name, parent=styles['Normal'], **kw)

        sty_empresa   = Saf('AFE',   fontSize=12, fontName='Helvetica-Bold', alignment=TA_CENTER, spaceAfter=1)
        sty_sep       = Saf('AFS',   fontSize=7,  textColor=colors.HexColor('#aaaaaa'), alignment=TA_CENTER, spaceAfter=1)
        sty_titulo    = Saf('AFT',   fontSize=9,  fontName='Helvetica-Bold', alignment=TA_CENTER, spaceAfter=2, spaceBefore=2)
        sty_sub_label = Saf('AFSL',  fontSize=7.5, textColor=colors.HexColor('#555555'), spaceAfter=1)
        sty_total     = Saf('AFTot', fontSize=12, fontName='Helvetica-Bold', alignment=TA_RIGHT, textColor=colors.black, spaceBefore=2, spaceAfter=2)
        sty_footer    = Saf('AFF',   fontSize=7,  alignment=TA_CENTER, textColor=colors.HexColor('#777777'), spaceAfter=1)
        sty_cae       = Saf('AFC',   fontSize=7,  fontName='Helvetica-Bold', alignment=TA_CENTER, spaceAfter=1)

        # ── Encabezado empresa ───────────────────────────────────────────────
        story.append(Paragraph(factura.get('razon_social', self.company_info['name']).upper(), sty_empresa))
        story.append(Spacer(1, 1*mm))

        # Datos fiscales
        fiscal_data = [
            ['CUIT:',          factura.get('cuit', '')],
            ['Ing. Brutos:',   factura.get('ing_brutos', '')],
            ['Dir:',           factura.get('domicilio', self.company_info.get('address', ''))],
            [factura.get('localidad', ''), ''],
            ['Tel:',           factura.get('telefono', self.company_info.get('phone', ''))],
            ['Inicio Act.:',   factura.get('inicio_actividades', '')],
            [factura.get('condicion_iva', ''), ''],
        ]
        fiscal_tbl = Table(fiscal_data, colWidths=[20*mm, 48*mm])
        fiscal_tbl.setStyle(TableStyle([
            ('FONTNAME',      (0, 0), (0, -1), 'Helvetica-Bold'),
            ('FONTNAME',      (1, 0), (1, -1), 'Helvetica'),
            ('FONTSIZE',      (0, 0), (-1, -1), 7),
            ('TEXTCOLOR',     (0, 0), (-1, -1), colors.black),
            ('TOPPADDING',    (0, 0), (-1, -1), 0.5),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 0.5),
            ('VALIGN',        (0, 0), (-1, -1), 'TOP'),
            ('SPAN',          (0, 3), (1, 3)),
            ('SPAN',          (0, 6), (1, 6)),
            ('FONTNAME',      (0, 6), (1, 6), 'Helvetica-Bold'),
        ]))
        story.append(fiscal_tbl)
        story.append(Spacer(1, 2*mm))

        # ── Tipo de comprobante ──────────────────────────────────────────────
        story.append(Paragraph('─' * 40, sty_sep))
        pto     = str(factura.get('punto_venta', 0)).zfill(5)
        nro_str = str(factura.get('nro_comprobante', 0)).zfill(9)
        story.append(Paragraph(
            f'<b>{factura.get("tipo_comprobante", "FAC. ELEC. B")}  Nro.: {pto} {nro_str}</b>',
            sty_titulo
        ))
        story.append(Paragraph('─' * 40, sty_sep))
        story.append(Spacer(1, 1*mm))

        # ── Datos del comprobante ────────────────────────────────────────────
        comp_data = [
            ['Fecha:', f'{factura.get("fecha", "")}  Turno: {factura.get("turno", "")}'],
            ['Pago:',  factura.get('pago', '')],
            [factura.get('modalidad', ''), ''],
        ]
        comp_tbl = Table(comp_data, colWidths=[12*mm, 56*mm])
        comp_tbl.setStyle(TableStyle([
            ('FONTNAME',      (0, 0), (0, -1), 'Helvetica-Bold'),
            ('FONTNAME',      (1, 0), (1, -1), 'Helvetica'),
            ('FONTSIZE',      (0, 0), (-1, -1), 7.5),
            ('TEXTCOLOR',     (0, 0), (-1, -1), colors.black),
            ('TOPPADDING',    (0, 0), (-1, -1), 1),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 1),
            ('SPAN',          (0, 2), (1, 2)),
            ('FONTNAME',      (0, 2), (1, 2), 'Helvetica-Bold'),
        ]))
        story.append(comp_tbl)
        story.append(Spacer(1, 1*mm))

        # ── Cliente ──────────────────────────────────────────────────────────
        story.append(Paragraph('─' * 40, sty_sep))
        story.append(Paragraph('Cliente:', sty_sub_label))
        story.append(Paragraph(
            f'<b>{factura.get("cliente", "CONSUMIDOR FINAL")}</b>',
            Saf('AFCli', fontSize=8, fontName='Helvetica-Bold', alignment=TA_CENTER, spaceAfter=1)
        ))
        story.append(Spacer(1, 1*mm))

        # ── Tabla de items ───────────────────────────────────────────────────
        story.append(Paragraph('─' * 40, sty_sep))
        all_items = [['UNDS.', 'DESCRIPCION', 'IVA', 'PRECIO', 'IMPORTE']]
        for item in factura.get('items', []):
            all_items.append([
                f'{float(item["cantidad"]):.2f}',
                item['descripcion'][:18],
                f'{float(item["iva"]):.0f}%',
                f'{float(item["precio"]):,.2f}',
                f'{float(item["importe"]):,.2f}',
            ])

        items_tbl = Table(all_items, colWidths=[9*mm, 25*mm, 10*mm, 14*mm, 14*mm])
        ts = TableStyle([
            ('FONTNAME',      (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE',      (0, 0), (-1, 0), 6.5),
            ('TEXTCOLOR',     (0, 0), (-1, 0), colors.black),
            ('ALIGN',         (0, 0), (-1, 0), 'CENTER'),
            ('LINEBELOW',     (0, 0), (-1, 0), 0.5, colors.black),
            ('FONTNAME',      (0, 1), (-1, -1), 'Helvetica'),
            ('FONTSIZE',      (0, 1), (-1, -1), 7.5),
            ('TEXTCOLOR',     (0, 1), (-1, -1), colors.black),
            ('ALIGN',         (0, 1), (0, -1), 'CENTER'),
            ('ALIGN',         (1, 1), (1, -1), 'LEFT'),
            ('ALIGN',         (2, 1), (-1, -1), 'RIGHT'),
            ('LINEBELOW',     (0, 1), (-1, -2), 0.3, colors.HexColor('#dddddd')),
            ('TOPPADDING',    (0, 0), (-1, -1), 1.5),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 1.5),
            ('VALIGN',        (0, 0), (-1, -1), 'MIDDLE'),
        ])
        # Descuentos (importes negativos) en rojo
        for i, item in enumerate(factura.get('items', []), start=1):
            if float(item.get('importe', 0)) < 0:
                ts.add('TEXTCOLOR', (3, i), (-1, i), colors.HexColor('#cc0000'))
        items_tbl.setStyle(ts)
        story.append(items_tbl)
        story.append(Spacer(1, 1*mm))

        # ── Total ────────────────────────────────────────────────────────────
        story.append(Paragraph('= = = = = = = = = = = = = = = = = = =', sty_sep))
        story.append(Paragraph(f'TOTAL  ${factura["total"]:,.2f}', sty_total))
        story.append(Paragraph('= = = = = = = = = = = = = = = = = = =', sty_sep))
        story.append(Spacer(1, 1*mm))

        # ── Transparencia Fiscal (ley 27.743) ────────────────────────────────
        story.append(Paragraph('Régimen de Transparencia Fiscal', sty_footer))
        story.append(Paragraph('al Consumidor (ley 27.743)', sty_footer))
        story.append(Paragraph(f'IVA Contenido:  ${factura.get("iva_contenido", 0):,.2f}', sty_footer))
        story.append(Paragraph(f'Otros Imp. Nac. Indirectos:  ${factura.get("otros_impuestos", 0):,.2f}', sty_footer))
        story.append(Spacer(1, 2*mm))

        # ── QR AFIP ──────────────────────────────────────────────────────────
        if _QRCODE_AVAILABLE:
            qr_data = {
                "ver":        1,
                "fecha":      datetime.now().strftime('%Y-%m-%d'),
                "cuit":       int(str(factura.get('cuit', '0') or '0').replace('-', '').strip() or '0'),
                "ptoVta":     int(factura.get('punto_venta', 0)),
                "tipoCmp":    6,   # 6=Fact.B  1=Fact.A  11=Ticket
                "nroCmp":     int(factura.get('nro_comprobante', 0)),
                "importe":    float(factura.get('total', 0)),
                "moneda":     "PES",
                "ctz":        1,
                "tipoDocRec": 99,
                "nroDocRec":  0,
                "tipoCodAut": "E",
                "codAut":     int(factura.get('cae', '0') or '0')
            }
            qr_b64 = base64.b64encode(json.dumps(qr_data, separators=(',', ':')).encode()).decode()
            qr_url = f"https://www.afip.gob.ar/fe/qr/?p={qr_b64}"
            qr_img = qrcode.make(qr_url)
            qr_buf = io.BytesIO()
            qr_img.save(qr_buf, format='PNG')
            qr_buf.seek(0)
            story.append(RLImage(qr_buf, width=28*mm, height=28*mm))
            story.append(Spacer(1, 2*mm))

        # ── CAE y vencimiento ────────────────────────────────────────────────
        story.append(Paragraph('─' * 40, sty_sep))
        vto_raw = factura.get('vto_cae', '')
        vto_fmt = f'{vto_raw[6:8]}/{vto_raw[4:6]}/{vto_raw[0:4]}' if len(vto_raw) == 8 else vto_raw
        story.append(Paragraph(f'CAE: {factura.get("cae", "")}', sty_cae))
        story.append(Paragraph(f'Vto.: {vto_fmt}', sty_cae))
        story.append(Spacer(1, 2*mm))

        # ── Footer ───────────────────────────────────────────────────────────
        story.append(Paragraph('─' * 40, sty_sep))
        story.append(Paragraph('*** Documento válido como factura ***', sty_footer))
        story.append(Paragraph(datetime.now().strftime('%d/%m/%Y %H:%M'), sty_footer))

        # ── Calcular altura real del contenido y generar en 1 sola página ────
        # 1) Medir en un canvas temporal con altura grande
        from reportlab.platypus import Frame
        _tmp_buf = io.BytesIO()
        _avail_w = _PAGE_W - 2 * _MARGIN
        _big_h   = 2000 * mm
        _tmp_c   = canvas.Canvas(_tmp_buf, pagesize=(_PAGE_W, _big_h))
        _frame   = Frame(_MARGIN, _MARGIN, _avail_w, _big_h - 2 * _MARGIN,
                         leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        _story_copy = list(story)  # shallow copy — los flowables son reutilizables
        _frame.addFromList(_story_copy, _tmp_c)
        # altura usada = big_h - y restante en el frame
        _used_h = _big_h - 2 * _MARGIN - _frame._y + _MARGIN
        _page_h  = max(_used_h + 12 * mm, 80 * mm)   # +12mm de margen inferior

        # 2) Generar el PDF real con la altura exacta
        doc = SimpleDocTemplate(
            filepath,
            pagesize=(_PAGE_W, _page_h),
            topMargin=5*mm,
            bottomMargin=7*mm,
            leftMargin=_MARGIN,
            rightMargin=_MARGIN,
        )
        doc.build(story)
        return filepath

    def generate_factura_afip_a4(self, factura):
        """
        Genera comprobante A4 con diseno OFICIAL AFIP identico al modelo real:
        - Header 3 columnas: [logo+datos emisor] | [letra grande+cod] | [titulo+nro+fecha]
        - Fila: datos emisor (razon social, domicilio, CUIT, IVA) | | datos comprobante
        - Seccion receptor (Senor/es, domicilio, condicion IVA, CUIT)
        - Tabla de items estilo AFIP
        - Totales (importe total en recuadro)
        - Transparencia fiscal ley 27.743
        - Pie: QR AFIP | logo AFIP | CAE + Vto + 'Comprobante Autorizado'
        """
        from reportlab.lib.pagesizes import A4
        from reportlab.platypus import HRFlowable

        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        nro_zfill = str(factura.get('nro_comprobante', 0)).zfill(8)
        filename = f'factura_{nro_zfill}_{timestamp}.pdf'
        filepath = os.path.join(self.output_dir, filename)

        PAGE_W, PAGE_H = A4
        ML = MR = 15 * mm
        MT = 15 * mm
        MB = 20 * mm
        CONTENT_W = PAGE_W - ML - MR

        styles = getSampleStyleSheet()

        # ── Helper estilos ───────────────────────────────────────────────────
        _sty_cache = {}
        def S(name, **kw):
            key = name + str(sorted(kw.items()))
            if key not in _sty_cache:
                _sty_cache[key] = ParagraphStyle(name, parent=styles['Normal'], **kw)
            return _sty_cache[key]

        # ── Determinar tipo, letra, codigo ───────────────────────────────────
        tipo_str = factura.get('tipo_comprobante', 'FAC. ELEC. B').upper()
        if ' A' in tipo_str and ('ELEC. A' in tipo_str or tipo_str.endswith(' A')):
            letra = 'A'; cod_tipo = 1; cod_afip = 'COD. 01'
        elif ' C' in tipo_str and ('ELEC. C' in tipo_str or tipo_str.endswith(' C')):
            letra = 'C'; cod_tipo = 11; cod_afip = 'COD. 11'
        else:
            letra = 'B'; cod_tipo = 6; cod_afip = 'COD. 06'

        # Nombre largo del comprobante (ej: FACTURA, NOTA DE CREDITO, etc.)
        nombre_comp = factura.get('tipo_comprobante_nombre', 'FACTURA').upper()
        condicion_iva_emisor = factura.get('condicion_iva', 'Responsable Inscripto')

        pto_str = str(factura.get('punto_venta', 1)).zfill(5)
        nro_str = str(factura.get('nro_comprobante', 1)).zfill(8)
        comp_nro_full = f'{pto_str}-{nro_str}'

        fecha_comp = factura.get('fecha', datetime.now().strftime('%d/%m/%Y'))
        # Normalizar fecha a solo dia/mes/anio
        if len(fecha_comp) > 10:
            fecha_comp = fecha_comp[:10]

        # ── HEADER ───────────────────────────────────────────────────────────
        # Medidas columnas header
        col_emisor = 85 * mm
        col_letra  = 30 * mm
        col_datos  = CONTENT_W - col_emisor - col_letra

        # -- Columna izquierda: logo + razon social + datos emisor --
        razon = factura.get('razon_social', '').upper()
        domicilio_emisor = factura.get('domicilio', '')
        localidad_emisor = factura.get('localidad', '')
        cuit_emisor      = factura.get('cuit', '')
        ing_brutos       = factura.get('ing_brutos', '')
        inicio_act       = factura.get('inicio_actividades', '')

        sE_name = S('EN', fontSize=11, fontName='Helvetica-Bold', alignment=TA_LEFT, spaceAfter=2, leading=13)
        sE_lbl  = S('EL', fontSize=7.5, fontName='Helvetica-Bold', alignment=TA_LEFT, spaceAfter=0, leading=10)
        sE_val  = S('EV', fontSize=7.5, fontName='Helvetica', alignment=TA_LEFT, spaceAfter=1, leading=10)
        sE_iva  = S('EI', fontSize=7.5, fontName='Helvetica-Bold', alignment=TA_LEFT, spaceAfter=0, leading=10)

        emisor_content = [
            Paragraph(razon, sE_name),
            Paragraph(f'<b>Razon Social:</b> {razon}', sE_val),
            Paragraph(f'<b>Domicilio Comercial:</b> {domicilio_emisor}', sE_val),
            Paragraph(localidad_emisor, sE_val),
            Paragraph(f'Condicion frente al IVA: {condicion_iva_emisor}', sE_iva),
        ]

        # -- Columna central: letra grande + COD --
        sL_letra = S('LL', fontSize=36, fontName='Helvetica-Bold', alignment=TA_CENTER, spaceAfter=0, leading=40)
        sL_cod   = S('LC', fontSize=7, fontName='Helvetica-Bold', alignment=TA_CENTER, spaceAfter=0, leading=9)

        letra_content = Table(
            [[Paragraph(letra, sL_letra)], [Paragraph(cod_afip, sL_cod)]],
            colWidths=[col_letra - 2*mm],
        )
        letra_content.setStyle(TableStyle([
            ('ALIGN',         (0, 0), (-1, -1), 'CENTER'),
            ('VALIGN',        (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING',    (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('BOX',           (0, 0), (-1, -1), 1.5, colors.black),
        ]))

        # -- Columna derecha: nombre comprobante + nro + fecha + CUIT + otros --
        sD_title = S('DT', fontSize=11, fontName='Helvetica-Bold', alignment=TA_LEFT, spaceAfter=3, leading=13)
        sD_lbl   = S('DL', fontSize=7.5, fontName='Helvetica-Bold', alignment=TA_LEFT, spaceAfter=1, leading=10)
        sD_val   = S('DV', fontSize=7.5, fontName='Helvetica', alignment=TA_LEFT, spaceAfter=1, leading=10)

        datos_content = [
            Paragraph(nombre_comp, sD_title),
            Paragraph(f'<b>Compr. Nro:</b> {comp_nro_full}', sD_lbl),
            Paragraph(f'<b>Fecha de Emision:</b> {fecha_comp}', sD_lbl),
            Spacer(1, 2*mm),
            Paragraph(f'<b>CUIT:</b> {cuit_emisor}', sD_val),
            Paragraph(f'<b>Ingresos Brutos:</b> {ing_brutos}', sD_val),
            Paragraph(f'<b>Fecha de Inicio de Actividades:</b> {inicio_act}', sD_val),
        ]

        header_tbl = Table(
            [[emisor_content, [letra_content], datos_content]],
            colWidths=[col_emisor, col_letra, col_datos],
        )
        header_tbl.setStyle(TableStyle([
            ('VALIGN',        (0, 0), (-1, -1), 'TOP'),
            ('BOX',           (0, 0), (-1, -1), 1.0, colors.black),
            ('LINEAFTER',     (0, 0), (0, 0),   0.8, colors.black),
            ('LINEAFTER',     (1, 0), (1, 0),   0.8, colors.black),
            ('LEFTPADDING',   (0, 0), (-1, -1), 6),
            ('RIGHTPADDING',  (0, 0), (-1, -1), 6),
            ('TOPPADDING',    (0, 0), (-1, -1), 6),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('ALIGN',         (1, 0), (1, 0),   'CENTER'),
            ('VALIGN',        (1, 0), (1, 0),   'MIDDLE'),
        ]))

        story = [header_tbl, Spacer(1, 3*mm)]

        # ── SECCION RECEPTOR ─────────────────────────────────────────────────
        cliente_txt      = factura.get('cliente', 'CONSUMIDOR FINAL')
        cuit_receptor    = factura.get('cuit_receptor', '')
        dom_receptor     = factura.get('domicilio_receptor', '')
        cond_iva_recep   = factura.get('condicion_iva_receptor', 'Consumidor Final')

        sR_lbl = S('RL', fontSize=8, fontName='Helvetica-Bold', alignment=TA_LEFT, spaceAfter=0, leading=11)
        sR_val = S('RV', fontSize=8, fontName='Helvetica',      alignment=TA_LEFT, spaceAfter=0, leading=11)

        receptor_row1_data = [
            [Paragraph(f'<b>Senor(es):</b> {cliente_txt}', sR_val),
             Paragraph(f'<b>Domicilio:</b> {dom_receptor}', sR_val)],
        ]
        receptor_row1 = Table(receptor_row1_data, colWidths=[CONTENT_W * 0.55, CONTENT_W * 0.45])
        receptor_row1.setStyle(TableStyle([
            ('LEFTPADDING',   (0,0),(-1,-1), 4),
            ('RIGHTPADDING',  (0,0),(-1,-1), 4),
            ('TOPPADDING',    (0,0),(-1,-1), 3),
            ('BOTTOMPADDING', (0,0),(-1,-1), 3),
        ]))

        cuit_recep_txt = cuit_receptor if cuit_receptor else '—'
        receptor_row2_data = [
            [Paragraph(f'<b>Condicion frente al IVA:</b> {cond_iva_recep}', sR_val),
             Paragraph(f'<b>CUIT:</b> {cuit_recep_txt}', sR_val)],
        ]
        receptor_row2 = Table(receptor_row2_data, colWidths=[CONTENT_W * 0.55, CONTENT_W * 0.45])
        receptor_row2.setStyle(TableStyle([
            ('LEFTPADDING',   (0,0),(-1,-1), 4),
            ('RIGHTPADDING',  (0,0),(-1,-1), 4),
            ('TOPPADDING',    (0,0),(-1,-1), 3),
            ('BOTTOMPADDING', (0,0),(-1,-1), 3),
        ]))

        receptor_outer = Table(
            [[receptor_row1], [receptor_row2]],
            colWidths=[CONTENT_W],
        )
        receptor_outer.setStyle(TableStyle([
            ('BOX',           (0,0),(-1,-1), 0.8, colors.black),
            ('LINEBELOW',     (0,0),(-1,0),  0.4, colors.HexColor('#aaaaaa')),
            ('TOPPADDING',    (0,0),(-1,-1), 0),
            ('BOTTOMPADDING', (0,0),(-1,-1), 0),
            ('LEFTPADDING',   (0,0),(-1,-1), 0),
            ('RIGHTPADDING',  (0,0),(-1,-1), 0),
        ]))

        story.append(receptor_outer)
        story.append(Spacer(1, 3*mm))

        # Forma de pago
        pago_txt = factura.get('pago', 'Contado')
        sP = S('PG', fontSize=8, fontName='Helvetica', alignment=TA_LEFT, spaceAfter=0, leading=11)
        pago_tbl = Table(
            [[Paragraph(f'<b>Forma de Pago:</b> {pago_txt}', sP)]],
            colWidths=[CONTENT_W],
        )
        pago_tbl.setStyle(TableStyle([
            ('BOX',          (0,0),(-1,-1), 0.5, colors.black),
            ('LEFTPADDING',  (0,0),(-1,-1), 6),
            ('TOPPADDING',   (0,0),(-1,-1), 3),
            ('BOTTOMPADDING',(0,0),(-1,-1), 3),
            ('BACKGROUND',   (0,0),(-1,-1), colors.HexColor('#f9f9f9')),
        ]))
        story.append(pago_tbl)
        story.append(Spacer(1, 3*mm))

        # ── TABLA DE ITEMS ────────────────────────────────────────────────────
        col_item = 12*mm
        col_cant = 22*mm
        col_pu   = 35*mm
        col_imp  = 35*mm
        col_desc = CONTENT_W - col_item - col_cant - col_pu - col_imp

        sI_hdr = S('IH', fontSize=7.5, fontName='Helvetica-Bold', alignment=TA_CENTER, textColor=colors.black, leading=10)
        sI_ctr = S('IC', fontSize=7.5, fontName='Helvetica',      alignment=TA_CENTER, leading=10)
        sI_lft = S('IL', fontSize=7.5, fontName='Helvetica',      alignment=TA_LEFT,   leading=10)
        sI_rgt = S('IR', fontSize=7.5, fontName='Helvetica',      alignment=TA_RIGHT,  leading=10)

        items_data = [[
            Paragraph('Item', sI_hdr),
            Paragraph('Descripcion', sI_hdr),
            Paragraph('Cantidad', sI_hdr),
            Paragraph('Precio Unit. ($)', sI_hdr),
            Paragraph('Total por Item ($)', sI_hdr),
        ]]
        for idx, item in enumerate(factura.get('items', []), start=1):
            imp = float(item.get('importe', 0))
            imp_color = colors.HexColor('#cc0000') if imp < 0 else colors.black
            sI_rgt_col = S(f'IRc{idx}', fontSize=7.5, fontName='Helvetica', alignment=TA_RIGHT, leading=10, textColor=imp_color)
            cant_val = float(item.get('cantidad', 1))
            precio_val = float(item.get('precio', 0))
            items_data.append([
                Paragraph(str(idx).zfill(4), sI_ctr),
                Paragraph(str(item.get('descripcion', '')), sI_lft),
                Paragraph(f'{cant_val:,.6f}', sI_ctr),
                Paragraph(f'{precio_val:,.6f}', sI_rgt),
                Paragraph(f'{imp:,.2f}', sI_rgt_col),
            ])
            # Unidad de medida
            um = item.get('unidad', '')
            if um:
                items_data.append([
                    '', Paragraph(f'U. Medida: {um}', S(f'UM{idx}', fontSize=6.5, fontName='Helvetica', alignment=TA_LEFT, leading=9, textColor=colors.HexColor('#555555'))),
                    '', '', ''
                ])

        items_tbl = Table(
            items_data,
            colWidths=[col_item, col_desc, col_cant, col_pu, col_imp],
            repeatRows=1,
        )
        ts_items = TableStyle([
            # Header
            ('FONTNAME',      (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE',      (0, 0), (-1, 0), 7.5),
            ('ALIGN',         (0, 0), (-1, 0), 'CENTER'),
            ('VALIGN',        (0, 0), (-1, 0), 'MIDDLE'),
            ('LINEBELOW',     (0, 0), (-1, 0), 0.8, colors.black),
            ('LINEABOVE',     (0, 0), (-1, 0), 0.8, colors.black),
            # Body
            ('FONTNAME',      (0, 1), (-1, -1), 'Helvetica'),
            ('FONTSIZE',      (0, 1), (-1, -1), 7.5),
            ('VALIGN',        (0, 1), (-1, -1), 'MIDDLE'),
            ('LINEBELOW',     (0, 1), (-1, -1), 0.3, colors.HexColor('#dddddd')),
            # Padding
            ('TOPPADDING',    (0, 0), (-1, -1), 3),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
            ('LEFTPADDING',   (0, 0), (-1, -1), 4),
            ('RIGHTPADDING',  (0, 0), (-1, -1), 4),
            # Outer box
            ('BOX',           (0, 0), (-1, -1), 0.8, colors.black),
        ])
        items_tbl.setStyle(ts_items)
        story.append(items_tbl)
        story.append(Spacer(1, 4*mm))

        # ── TOTALES ───────────────────────────────────────────────────────────
        total    = float(factura.get('total', 0))
        iva_cont = float(factura.get('iva_contenido', 0))
        otros    = float(factura.get('otros_impuestos', 0))

        sT_lbl = S('TL', fontSize=8,  fontName='Helvetica',      alignment=TA_LEFT,  leading=11)
        sT_val = S('TV', fontSize=8,  fontName='Helvetica',      alignment=TA_RIGHT, leading=11)
        sT_tot = S('TT', fontSize=11, fontName='Helvetica-Bold', alignment=TA_RIGHT, leading=14)
        sT_tl2 = S('TL2',fontSize=11, fontName='Helvetica-Bold', alignment=TA_LEFT,  leading=14)

        # Fila de tipo de cambio (si aplica)
        tipo_cambio = factura.get('tipo_cambio', '')
        moneda = factura.get('moneda', 'Pesos')

        tot_w_l = CONTENT_W * 0.60
        tot_w_r = CONTENT_W * 0.40

        # Caja total con borde (lado derecho)
        total_box_data = [
            [Paragraph(f'Importe Total:', sT_tl2), Paragraph(f'${total:,.2f}', sT_tot)],
        ]
        total_box = Table(total_box_data, colWidths=[tot_w_r * 0.55, tot_w_r * 0.45], hAlign='RIGHT')
        total_box.setStyle(TableStyle([
            ('BOX',          (0,0),(-1,-1), 1.0, colors.black),
            ('LINEABOVE',    (0,0),(-1,0),  0.5, colors.black),
            ('TOPPADDING',   (0,0),(-1,-1), 5),
            ('BOTTOMPADDING',(0,0),(-1,-1), 5),
            ('LEFTPADDING',  (0,0),(-1,-1), 8),
            ('RIGHTPADDING', (0,0),(-1,-1), 8),
            ('VALIGN',       (0,0),(-1,-1), 'MIDDLE'),
        ]))

        # Tabla 2 columnas: izq=tipo cambio/moneda, der=total
        tipo_cambio_content = []
        if tipo_cambio:
            sTc = S('TC2', fontSize=7.5, fontName='Helvetica', alignment=TA_LEFT, leading=10)
            tipo_cambio_content.append(Paragraph(f'<b>Tipo de Cambio:</b> {tipo_cambio}', sTc))
        if moneda and moneda != 'Pesos':
            sTc2 = S('TC3', fontSize=7.5, fontName='Helvetica', alignment=TA_LEFT, leading=10)
            tipo_cambio_content.append(Paragraph(f'<b>Divisa:</b> {moneda}', sTc2))

        if not tipo_cambio_content:
            tipo_cambio_content = [Paragraph('', S('TCe', fontSize=7))]

        totales_outer = Table(
            [[tipo_cambio_content, [total_box]]],
            colWidths=[tot_w_l, tot_w_r],
        )
        totales_outer.setStyle(TableStyle([
            ('VALIGN',       (0,0),(-1,-1), 'MIDDLE'),
            ('LEFTPADDING',  (0,0),(-1,-1), 0),
            ('RIGHTPADDING', (0,0),(-1,-1), 0),
            ('TOPPADDING',   (0,0),(-1,-1), 0),
            ('BOTTOMPADDING',(0,0),(-1,-1), 0),
            ('BOX',          (0,0),(-1,-1), 0.8, colors.black),
            ('LINEAFTER',    (0,0),(0,0),   0.5, colors.HexColor('#aaaaaa')),
            ('LEFTPADDING',  (0,0),(0,0),   6),
            ('TOPPADDING',   (0,0),(0,0),   5),
            ('BOTTOMPADDING',(0,0),(0,0),   5),
        ]))
        story.append(totales_outer)
        story.append(Spacer(1, 4*mm))

        # ── TRANSPARENCIA FISCAL (Ley 27.743) ────────────────────────────────
        sTr = S('TrF', fontSize=7, fontName='Helvetica', alignment=TA_LEFT, leading=10)
        transp_txt = (
            f'Regimen de Transparencia Fiscal al Consumidor (Ley 27.743) — '
            f'IVA Contenido: <b>${iva_cont:,.2f}</b> — '
            f'Otros Imp. Nac. Indirectos: <b>${otros:,.2f}</b>'
        )
        transp_tbl = Table([[Paragraph(transp_txt, sTr)]], colWidths=[CONTENT_W])
        transp_tbl.setStyle(TableStyle([
            ('BOX',          (0,0),(-1,-1), 0.5, colors.HexColor('#aaaaaa')),
            ('BACKGROUND',   (0,0),(-1,-1), colors.HexColor('#f9f9f9')),
            ('TOPPADDING',   (0,0),(-1,-1), 4),
            ('BOTTOMPADDING',(0,0),(-1,-1), 4),
            ('LEFTPADDING',  (0,0),(-1,-1), 6),
        ]))
        story.append(transp_tbl)
        story.append(Spacer(1, 4*mm))

        # ── OBSERVACIONES (si las hay) ────────────────────────────────────────
        notas_txt = factura.get('notas', '').strip()
        if notas_txt:
            sN = S('NO', fontSize=7.5, fontName='Helvetica', alignment=TA_LEFT, leading=10)
            notas_tbl = Table(
                [[Paragraph(f'<b>Observaciones:</b> {notas_txt}', sN)]],
                colWidths=[CONTENT_W],
            )
            notas_tbl.setStyle(TableStyle([
                ('BOX',          (0,0),(-1,-1), 0.5, colors.HexColor('#aaaaaa')),
                ('BACKGROUND',   (0,0),(-1,-1), colors.HexColor('#fffef5')),
                ('TOPPADDING',   (0,0),(-1,-1), 5),
                ('BOTTOMPADDING',(0,0),(-1,-1), 5),
                ('LEFTPADDING',  (0,0),(-1,-1), 6),
                ('RIGHTPADDING', (0,0),(-1,-1), 6),
            ]))
            story.append(notas_tbl)
            story.append(Spacer(1, 4*mm))

        # ── PIE: QR + LOGO AFIP + CAE ────────────────────────────────────────
        vto_raw = factura.get('vto_cae', '')
        vto_fmt = f'{vto_raw[6:8]}/{vto_raw[4:6]}/{vto_raw[0:4]}' if len(str(vto_raw)) == 8 else str(vto_raw)
        cae_val = factura.get('cae', '')

        # QR AFIP
        if _QRCODE_AVAILABLE and cae_val:
            try:
                cuit_int = int(str(cuit_emisor or '0').replace('-','').replace(' ','') or '0')
            except Exception:
                cuit_int = 0
            qr_data = {
                'ver': 1,
                'fecha': fecha_comp.replace('/', '-') if '/' in fecha_comp else fecha_comp,
                'cuit': cuit_int,
                'ptoVta': int(factura.get('punto_venta', 1)),
                'tipoCmp': cod_tipo,
                'nroCmp': int(factura.get('nro_comprobante', 1)),
                'importe': round(total, 2),
                'moneda': 'PES',
                'ctz': 1,
                'tipoDocRec': 96 if factura.get('cuit_receptor', '') else 99,
                'nroDocRec': int(str(factura.get('cuit_receptor', '0') or '0').replace('-','') or '0'),
                'tipoCodAut': 'E',
                'codAut': int(str(cae_val or '0').strip() or '0'),
            }
            qr_b64 = base64.b64encode(json.dumps(qr_data, separators=(',',':')).encode()).decode()
            qr_url = f'https://www.afip.gob.ar/fe/qr/?p={qr_b64}'
            qr_img_obj = qrcode.make(qr_url)
            qr_buf = io.BytesIO()
            qr_img_obj.save(qr_buf, format='PNG')
            qr_buf.seek(0)
            qr_elem = RLImage(qr_buf, width=28*mm, height=28*mm)
        else:
            qr_elem = Paragraph('', S('QRE', fontSize=7))

        # Logo AFIP (texto estilo AFIP si no hay imagen)
        sAFIP = S('AF', fontSize=16, fontName='Helvetica-Bold', alignment=TA_CENTER, textColor=colors.HexColor('#1a3a6b'), leading=20)
        sAFIP_sub = S('AFS2', fontSize=7, fontName='Helvetica', alignment=TA_CENTER, leading=9)

        afip_logo_cell = [
            Paragraph('<b>AFIP</b>', sAFIP),
            Paragraph('Comprobante Autorizado', sAFIP_sub),
        ]

        # Textos CAE
        sCAE_n = S('CN', fontSize=8,  fontName='Helvetica-Bold', alignment=TA_LEFT, leading=11)
        sCAE_v = S('CV', fontSize=7.5, fontName='Helvetica',     alignment=TA_LEFT, leading=11)
        sCAE_d = S('CD', fontSize=6.5, fontName='Helvetica',     alignment=TA_LEFT, leading=9, textColor=colors.HexColor('#555555'))

        cae_cell_content = [
            Paragraph(f'CAE N\u00ba: {cae_val}', sCAE_n),
            Paragraph(f'Fecha de Vto. de CAE: {vto_fmt}', sCAE_v),
            Spacer(1, 2*mm),
            Paragraph(
                'Esta Administracion Federal no se responsabiliza por la veracidad de los datos '
                'ingresados en el detalle de la operacion.',
                sCAE_d
            ),
        ]

        col_qr   = 32*mm
        col_afip = 40*mm
        col_cae  = CONTENT_W - col_qr - col_afip

        footer_tbl = Table(
            [[qr_elem, afip_logo_cell, cae_cell_content]],
            colWidths=[col_qr, col_afip, col_cae],
        )
        footer_tbl.setStyle(TableStyle([
            ('BOX',           (0,0),(-1,-1), 0.8, colors.black),
            ('LINEAFTER',     (0,0),(0,0),   0.5, colors.HexColor('#aaaaaa')),
            ('LINEAFTER',     (1,0),(1,0),   0.5, colors.HexColor('#aaaaaa')),
            ('VALIGN',        (0,0),(-1,-1), 'MIDDLE'),
            ('ALIGN',         (0,0),(0,0),   'CENTER'),
            ('ALIGN',         (1,0),(1,0),   'CENTER'),
            ('LEFTPADDING',   (0,0),(-1,-1), 6),
            ('RIGHTPADDING',  (0,0),(-1,-1), 6),
            ('TOPPADDING',    (0,0),(-1,-1), 6),
            ('BOTTOMPADDING', (0,0),(-1,-1), 6),
        ]))
        story.append(footer_tbl)

        # ── BUILD PDF ─────────────────────────────────────────────────────────
        doc = SimpleDocTemplate(
            filepath, pagesize=A4,
            topMargin=MT, bottomMargin=MB,
            leftMargin=ML, rightMargin=MR,
        )
        doc.build(story)
        return filepath

