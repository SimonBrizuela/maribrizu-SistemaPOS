"""
El ticket que se lleva el cliente.

Es el único papel que sale del local en una venta no fiscal, y lo que dice ahí
es lo que el cliente puede reclamar después. Se arma con una plantilla y un
mini-Mustache propio, así que un campo que cambia de nombre no rompe nada:
sale un hueco en blanco donde iba el total.

Estas pruebas renderizan el ticket y miran que los números estén.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.utils.pdf_generator import PDFGenerator


def venta(**extra):
    base = {
        'id': 57,
        'created_at': '2026-08-28 15:15:56',
        'total_amount': 10000.0,
        'payment_type': 'cash',
        'cash_received': 12000.0,
        'change_given': 2000.0,
        'items': [
            {'product_name': 'CUADERNO RIVADAVIA', 'quantity': 2,
             'unit_price': 3000.0, 'subtotal': 6000.0, 'original_price': 3000.0,
             'discount_amount': 0, 'discount_type': ''},
            {'product_name': 'RESMA A4', 'quantity': 1,
             'unit_price': 4000.0, 'subtotal': 4000.0, 'original_price': 4000.0,
             'discount_amount': 0, 'discount_type': ''},
        ],
    }
    base.update(extra)
    return base


@pytest.fixture(scope='module')
def html():
    def render(v, **kw):
        return PDFGenerator().render_non_fiscal_ticket_html(v, **kw)
    return render


class TestLoQueDiceElTicket:
    def test_estan_los_productos_y_el_total(self, html):
        t = html(venta())
        assert 'CUADERNO RIVADAVIA' in t
        assert 'RESMA A4' in t
        assert '10,000.00' in t or '10.000,00' in t

    def test_el_numero_de_ticket_y_el_cajero(self, html):
        t = html(venta(), cajero_name='Marta', cliente_name='Escuela 25')
        assert '57' in t
        assert 'Marta' in t
        assert 'Escuela 25' in t

    def test_en_efectivo_muestra_lo_recibido_y_el_vuelto(self, html):
        t = html(venta())
        assert 'Efectivo' in t
        assert '12,000.00' in t or '12.000,00' in t   # recibido
        assert '2,000.00' in t or '2.000,00' in t     # vuelto

    def test_por_transferencia_no_hay_vuelto(self, html):
        t = html(venta(payment_type='transfer', cash_received=0, change_given=0))
        assert 'Transferencia' in t

    def test_una_venta_mixta_muestra_las_dos_partes(self, html):
        """El caso que el ticket escondía: decía "Transferencia" a secas y la
        plata que el cliente entregó en mano no figuraba en ningún lado."""
        t = html(venta(payment_type='mixed', total_amount=10000.0,
                       cash_received=4000.0, change_given=0.0,
                       transfer_amount=6000.0))
        assert 'Efectivo' in t and 'Transferencia' in t
        assert '4,000.00' in t or '4.000,00' in t
        assert '6,000.00' in t or '6.000,00' in t

    def test_el_descuento_se_ve_tachado_contra_el_precio_de_lista(self, html):
        v = venta()
        v['items'][0].update(unit_price=2400.0, subtotal=4800.0,
                             original_price=3000.0, discount_amount=1200.0,
                             discount_type='manual', descuento_nombre='Jubilados')
        v['total_amount'] = 8800.0
        t = html(v)
        assert 'JUBILADOS' in t.upper()
        assert '3,000.00' in t or '3.000,00' in t     # el precio de lista sigue visible

    def test_sin_cliente_sale_consumidor_final(self, html):
        assert 'Consumidor Final' in html(venta())

    def test_una_venta_sin_items_no_rompe_el_ticket(self, html):
        t = html(venta(items=[]))
        assert isinstance(t, str) and len(t) > 100

    def test_un_producto_sin_nombre_no_rompe_el_ticket(self, html):
        v = venta(items=[{'quantity': 1, 'unit_price': 100.0, 'subtotal': 100.0}])
        assert isinstance(html(v), str)
