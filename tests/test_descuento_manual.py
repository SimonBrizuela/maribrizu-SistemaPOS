"""
El descuento con nombre sobre el carrito.

Lo que se prueba es la plata: que el reparto de un monto fijo entre varios
renglones sume exactamente lo descontado (sin centavos que se pierden en el
redondeo), que un porcentaje se aplique renglón por renglón, y que el carrito
que se manda a cobrar tenga el precio que se cobró de verdad.

    python -m pytest tests/test_descuento_manual.py -v
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from pos_system.ui.sales_view import SalesView


class _Carrito:
    """Lo mínimo que las cuentas del descuento le piden a la vista."""

    def __init__(self, cart, descuento=None):
        self.cart = cart
        self.descuento_manual = descuento

    filas_validas = SalesView._descuento_filas_validas
    montos = SalesView._descuento_montos
    total = SalesView._descuento_total
    con_descuento = SalesView._cart_con_descuento

    # los nombres reales que usan los métodos entre sí
    _descuento_filas_validas = SalesView._descuento_filas_validas
    _descuento_montos = SalesView._descuento_montos
    _descuento_total = SalesView._descuento_total


def _item(nombre, qty, subtotal):
    return {'product_name': nombre, 'quantity': qty,
            'unit_price': round(subtotal / qty, 2), 'subtotal': subtotal}


CARRITO = [
    _item('CUADERNO', 1, 1000.0),
    _item('LAPICERA', 2, 500.0),
    _item('MOCHILA', 1, 2500.0),
]


class TestPorcentaje:

    def test_sobre_todo_el_carrito(self):
        c = _Carrito(CARRITO, {'nombre': 'Jubilados', 'tipo': 'porcentaje',
                               'valor': 10, 'filas': None})
        assert c.montos() == {0: 100.0, 1: 50.0, 2: 250.0}
        assert c.total() == 400.0

    def test_sobre_los_renglones_elegidos(self):
        c = _Carrito(CARRITO, {'nombre': 'Docente', 'tipo': 'porcentaje',
                               'valor': 20, 'filas': [2]})
        assert c.montos() == {2: 500.0}
        assert c.total() == 500.0

    def test_no_pasa_del_cien_por_ciento(self):
        c = _Carrito(CARRITO, {'nombre': 'Regalo', 'tipo': 'porcentaje',
                               'valor': 150, 'filas': [0]})
        assert c.total() == 1000.0


class TestMontoFijo:

    def test_se_reparte_proporcional_y_cierra_exacto(self):
        c = _Carrito(CARRITO, {'nombre': 'Cliente de la casa', 'tipo': 'monto',
                               'valor': 1000, 'filas': None})
        montos = c.montos()
        assert sum(montos.values()) == 1000.0     # sin centavos perdidos
        assert montos[2] > montos[0] > montos[1]  # el más caro absorbe más

    def test_el_redondeo_no_se_pierde(self):
        # 100 entre tres renglones de 1/3 cada uno: 33,33 + 33,33 + 33,34
        carrito = [_item('A', 1, 100.0), _item('B', 1, 100.0), _item('C', 1, 100.0)]
        c = _Carrito(carrito, {'nombre': 'Redondeo', 'tipo': 'monto',
                               'valor': 100, 'filas': None})
        montos = c.montos()
        assert sum(montos.values()) == 100.0
        assert sorted(montos.values()) == [33.33, 33.33, 33.34]

    def test_nunca_descuenta_mas_que_el_total(self):
        c = _Carrito(CARRITO, {'nombre': 'Error de tipeo', 'tipo': 'monto',
                               'valor': 999999, 'filas': None})
        assert c.total() == 4000.0    # el total del carrito, ni un peso más


class TestCarritoParaCobrar:

    def test_las_lineas_llevan_el_precio_cobrado(self):
        c = _Carrito(CARRITO, {'nombre': 'Jubilados', 'tipo': 'porcentaje',
                               'valor': 10, 'filas': None})
        cobro = c.con_descuento()
        assert [l['subtotal'] for l in cobro] == [900.0, 450.0, 2250.0]
        assert sum(l['subtotal'] for l in cobro) == 3600.0
        assert cobro[0]['unit_price'] == 900.0
        assert cobro[1]['unit_price'] == 225.0     # 450 / 2 unidades

    def test_queda_el_nombre_para_el_ticket_y_la_factura(self):
        c = _Carrito(CARRITO, {'nombre': 'Docente', 'tipo': 'porcentaje',
                               'valor': 10, 'filas': [0]})
        cobro = c.con_descuento()
        assert cobro[0]['descuento_nombre'] == 'Docente'
        assert cobro[0]['discount_type'] == 'manual'
        assert cobro[0]['original_price'] == 1000.0
        # El renglón que no entra en el descuento queda intacto
        assert 'descuento_nombre' not in cobro[1]
        assert cobro[1]['subtotal'] == 500.0

    def test_sin_descuento_el_carrito_pasa_igual(self):
        c = _Carrito(CARRITO, None)
        assert c.con_descuento() == CARRITO
        assert c.total() == 0


class TestCarritoQueCambia:

    def test_un_renglon_borrado_no_arrastra_el_calculo(self):
        # El descuento se aplicó sobre 3 renglones y después se sacó uno.
        c = _Carrito(CARRITO[:2], {'nombre': 'Jubilados', 'tipo': 'porcentaje',
                                   'valor': 10, 'filas': [0, 1, 2]})
        assert c.filas_validas() == [0, 1]
        assert c.total() == 150.0

    def test_carrito_vacio_no_descuenta_nada(self):
        c = _Carrito([], {'nombre': 'Jubilados', 'tipo': 'porcentaje',
                          'valor': 10, 'filas': None})
        assert c.total() == 0
        assert c.con_descuento() == []


class TestRedondeo:
    """El redondeo saca la colita del total, no regala el ticket.

    Va siempre para abajo: es un descuento, subir el total sería cobrar de más.
    Y no puede pasar del 10% — sin ese freno, apretar un botón que promete
    acomodar el vuelto terminaba haciendo una oferta.
    """

    def test_baja_el_total_a_la_centena(self):
        from pos_system.ui.descuento_dialog import redondear_centena
        monto, ajuste = redondear_centena(9440.0, 0.0, tope=9440.0)
        assert (monto, ajuste) == (40.0, 40.0)
        assert 9440.0 - monto == 9400.0

    def test_nunca_redondea_para_arriba(self):
        from pos_system.ui.descuento_dialog import redondear_centena
        # 9.460 tiene la centena más cercana arriba (9.500), pero cobrar de más
        # no es un descuento: baja a 9.400.
        monto, _ajuste = redondear_centena(9460.0, 0.0, tope=9460.0)
        assert 9460.0 - monto == 9400.0

    def test_no_se_come_un_total_chico(self):
        from pos_system.ui.descuento_dialog import redondear_centena
        # $180 a la centena de abajo daría $100: un 44% de descuento. No.
        monto, ajuste = redondear_centena(180.0, 0.0, tope=180.0)
        assert (monto, ajuste) == (0.0, 0.0)

    def test_cuando_la_centena_no_entra_prueba_la_decena(self):
        from pos_system.ui.descuento_dialog import redondear_centena
        # $185: bajar a $100 es demasiado, pero a $180 son $5 y sí entra.
        monto, ajuste = redondear_centena(185.0, 0.0, tope=185.0)
        assert (monto, ajuste) == (5.0, 5.0)
        assert 185.0 - monto == 180.0

    def test_se_suma_al_descuento_que_ya_habia(self):
        from pos_system.ui.descuento_dialog import redondear_centena
        # 10% sobre 9.440 = 944 → quedan 8.496 → la centena de abajo es 8.400
        monto, ajuste = redondear_centena(9440.0, 944.0, tope=9440.0)
        assert monto == 1040.0
        assert ajuste == 96.0
        assert 9440.0 - monto == 8400.0

    def test_un_total_ya_redondo_no_se_toca(self):
        from pos_system.ui.descuento_dialog import redondear_centena
        assert redondear_centena(9400.0, 0.0, tope=9400.0) == (0.0, 0.0)

    def test_no_puede_descontar_mas_que_los_renglones_elegidos(self):
        from pos_system.ui.descuento_dialog import redondear_centena
        # El descuento aplica a un renglón de $20 dentro de un total de 9.440
        monto, ajuste = redondear_centena(9440.0, 0.0, tope=20.0)
        assert (monto, ajuste) == (0.0, 0.0)   # no alcanza para llegar a la centena

    def test_con_centavos_igual_cierra(self):
        from pos_system.ui.descuento_dialog import redondear_centena
        monto, _ = redondear_centena(9440.55, 0.0, tope=9440.55)
        assert round(9440.55 - monto, 2) == 9400.0
