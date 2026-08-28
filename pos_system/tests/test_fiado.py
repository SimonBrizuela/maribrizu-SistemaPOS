"""
La cuenta corriente, mirada como la usa el local.

Un cliente se lleva mercadería y paga después. Lo que tiene que cerrar siempre:

  · el stock sale del local el día que se lleva las cosas, no el día que paga,
  · esa mercadería no se descuenta dos veces cuando después se cobra,
  · la plata que deja "a cuenta" queda a su favor y se aplica sola,
  · y la deuda es lo que debe, ni un peso más.

Es el módulo que más plata mueve sin pasar por una venta, y hasta acá no tenía
ninguna prueba.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.cash_register import CashRegister
from pos_system.models.fiado import Fiado, nuevo_entrega_id
from pos_system.models.product import Product
from pos_system.models.sale import Sale


@pytest.fixture
def db(tmp_path):
    # Una base por prueba: en Windows el archivo queda tomado un rato después
    # de cerrarlo, y reusar el mismo nombre hacía fallar a la prueba siguiente
    # por algo que no tenía que ver con lo que estaba probando.
    base = DatabaseManager(str(tmp_path / 'fiado.db'))
    base.initialize_database()
    yield base


@pytest.fixture
def local(db):
    caja = CashRegister(db)
    caja.open_register(initial_amount=10000.0)
    pid = Product(db).create({'name': 'CUADERNO', 'price': 3000.0, 'stock': 20})
    fiado = Fiado(db)
    cid = fiado.crear_cliente('Marta Gomez', telefono='351 704 6684')
    return {'db': db, 'caja': caja, 'ventas': Sale(db), 'productos': Product(db),
            'fiado': fiado, 'pid': pid, 'cid': cid}


def cliente(local):
    return local['fiado'].get_cliente(local['cid'])


def linea(local, cantidad=2, precio=3000.0):
    """Una línea de carrito como la arma el POS al fiar."""
    return {
        'product_id': local['pid'], 'product_name': 'CUADERNO',
        'quantity': cantidad, 'unit_price': precio,
        'subtotal': cantidad * precio, 'category': 'LIBRERIA',
    }


def fiar(local, cantidad=2, precio=3000.0):
    """Lo que hace el POS: descuenta stock y anota la deuda."""
    items = [linea(local, cantidad, precio)]
    local['ventas'].descontar_stock_items(items, usuario='Marta', motivo='fiado')
    for it in items:
        it['stock_descontado'] = True
    return local['fiado'].cargar_items(cliente(local), items,
                                       entrega_id=nuevo_entrega_id(), cajero='Marta')


# ── Llevarse mercadería ───────────────────────────────────────────────────

class TestLlevarse:
    def test_el_stock_sale_el_dia_que_se_lo_lleva(self, local):
        fiar(local, cantidad=3)
        assert local['productos'].get_by_id(local['pid'])['stock'] == 17

    def test_la_deuda_es_lo_que_se_llevo(self, local):
        fiar(local, cantidad=2, precio=3000.0)
        c = local['fiado'].get_clientes()[0]
        assert c['pendiente'] == 6000.0
        assert c['deuda'] == 6000.0
        assert c['items_count'] == 1
        assert c['saldo_favor'] == 0.0

    def test_el_resumen_global_ve_la_deuda(self, local):
        fiar(local, cantidad=2)
        res = local['fiado'].resumen()
        assert res['total'] == 6000.0
        assert res['clientes'] == 1

    def test_un_cliente_sin_deuda_no_cuenta(self, local):
        assert local['fiado'].resumen() == {'total': 0.0, 'clientes': 0}
        assert local['fiado'].get_clientes()[0]['deuda'] == 0.0

    def test_no_se_puede_crear_un_cliente_sin_nombre(self, local):
        with pytest.raises(ValueError):
            local['fiado'].crear_cliente('   ')


# ── Cobrar ────────────────────────────────────────────────────────────────

class TestCobrar:
    def test_cobrar_no_vuelve_a_descontar_el_stock(self, local):
        """El error caro: descontar dos veces lo mismo.

        La mercadería salió el día que se la llevó. Al cobrar, la línea viaja
        con `stock_descontado` y el motor de ventas la tiene que saltear.
        """
        ids = fiar(local, cantidad=3)
        antes = local['productos'].get_by_id(local['pid'])['stock']

        item = local['fiado'].get_item(ids[0])
        cart = dict(item['cart_item'])
        cart['stock_descontado'] = True
        venta = local['ventas'].create({
            'total_amount': 9000.0, 'payment_type': 'cash', 'cash_received': 9000.0,
            'items': [cart], 'es_fiado': True, 'fiado_tipo': 'productos',
            'fiado_cliente': 'Marta Gomez',
        })
        local['fiado'].marcar_items_pagados(ids, venta)

        assert local['productos'].get_by_id(local['pid'])['stock'] == antes
        assert local['fiado'].get_clientes()[0]['deuda'] == 0.0

    def test_la_plata_del_cobro_entra_a_la_caja(self, local):
        ids = fiar(local, cantidad=2)
        cart = dict(local['fiado'].get_item(ids[0])['cart_item'])
        cart['stock_descontado'] = True
        local['ventas'].create({
            'total_amount': 6000.0, 'payment_type': 'cash', 'cash_received': 6000.0,
            'items': [cart], 'es_fiado': True, 'fiado_tipo': 'productos'})

        caja = local['caja'].get_current()
        assert caja['cash_sales'] == 6000.0

    def test_cobrar_dos_veces_el_mismo_item_no_hace_nada(self, local):
        """Dos PCs cobrando lo mismo a la vez.

        `marcar_items_pagados` sólo toca lo que sigue pendiente: la segunda
        pasada no encuentra nada y no puede volver a saldar la deuda.
        """
        ids = fiar(local, cantidad=2)
        assert local['fiado'].marcar_items_pagados(ids, 1) == 1
        assert local['fiado'].marcar_items_pagados(ids, 2) == 0
        assert local['fiado'].get_item(ids[0])['venta_id'] == 1


# ── Saldo a favor ─────────────────────────────────────────────────────────

class TestSaldoAFavor:
    def test_la_plata_a_cuenta_queda_a_favor(self, local):
        local['fiado'].registrar_pago(cliente(local), tipo='a_cuenta', monto=5000.0,
                                      metodo_pago='Efectivo')
        c = local['fiado'].get_clientes()[0]
        assert c['credito'] == 5000.0
        assert c['saldo_favor'] == 5000.0
        assert c['deuda'] == 0.0

    def test_el_saldo_a_favor_baja_la_deuda(self, local):
        fiar(local, cantidad=2)                     # debe 6000
        local['fiado'].registrar_pago(cliente(local), tipo='a_cuenta', monto=2000.0)
        c = local['fiado'].get_clientes()[0]
        assert c['pendiente'] == 6000.0
        assert c['credito'] == 2000.0
        assert c['deuda'] == 4000.0

    def test_aplicar_el_saldo_lo_consume(self, local):
        ids = fiar(local, cantidad=2)               # debe 6000
        local['fiado'].registrar_pago(cliente(local), tipo='a_cuenta', monto=2000.0)

        # Cobro de los 4.000 que faltan, aplicando los 2.000 a favor.
        local['fiado'].marcar_items_pagados(ids, 1)
        local['fiado'].registrar_pago(cliente(local), tipo='productos', monto=4000.0,
                                      venta_id=1, item_ids=ids, credito_usado=2000.0)

        c = local['fiado'].get_clientes()[0]
        assert c['deuda'] == 0.0
        assert c['credito'] == 0.0
        assert c['saldo_favor'] == 0.0

    def test_todo_cubierto_con_saldo_no_deja_credito_dando_vueltas(self, local):
        ids = fiar(local, cantidad=1)               # debe 3000
        local['fiado'].registrar_pago(cliente(local), tipo='a_cuenta', monto=5000.0)

        local['fiado'].marcar_items_pagados(ids, None)
        local['fiado'].registrar_pago(cliente(local), tipo='credito_aplicado',
                                      monto=3000.0, item_ids=ids)

        c = local['fiado'].get_clientes()[0]
        assert c['deuda'] == 0.0
        assert c['saldo_favor'] == 2000.0

    def test_el_credito_nunca_queda_en_negativo(self, local):
        local['fiado'].registrar_pago(cliente(local), tipo='credito_aplicado', monto=999.0)
        assert local['fiado'].get_credito(cliente(local)) == 0.0

    def test_un_tipo_de_pago_inventado_se_rechaza(self, local):
        with pytest.raises(ValueError):
            local['fiado'].registrar_pago(cliente(local), tipo='trueque', monto=1.0)


# ── Corregir lo anotado ───────────────────────────────────────────────────

class TestCorregir:
    def test_anular_saca_el_item_de_la_deuda(self, local):
        ids = fiar(local, cantidad=2)
        local['fiado'].anular_item(ids[0], motivo='lo devolvio')
        c = local['fiado'].get_clientes()[0]
        assert c['deuda'] == 0.0
        assert c['items_count'] == 0

    def test_editar_recalcula_el_subtotal(self, local):
        ids = fiar(local, cantidad=2, precio=3000.0)
        local['fiado'].editar_item(ids[0], quantity=3, unit_price=2500.0)
        item = local['fiado'].get_item(ids[0])
        assert item['subtotal'] == 7500.0
        assert item['cart_item']['subtotal'] == 7500.0
        assert local['fiado'].get_clientes()[0]['deuda'] == 7500.0

    def test_un_precio_a_mano_borra_la_promo_de_la_linea(self, local):
        items = [dict(linea(local), promo_id='2x1', discount_amount=500.0,
                      discount_type='percentage', original_price=3500.0)]
        local['ventas'].descontar_stock_items(items, motivo='fiado')
        for it in items:
            it['stock_descontado'] = True
        ids = local['fiado'].cargar_items(cliente(local), items)

        local['fiado'].editar_item(ids[0], unit_price=2000.0)
        cart = local['fiado'].get_item(ids[0])['cart_item']
        assert cart['promo_id'] is None
        assert cart['discount_amount'] == 0
        assert cart['original_price'] == 2000.0

    def test_editar_un_item_ya_cobrado_no_hace_nada(self, local):
        ids = fiar(local, cantidad=2)
        local['fiado'].marcar_items_pagados(ids, 1)
        local['fiado'].editar_item(ids[0], unit_price=1.0)
        assert local['fiado'].get_item(ids[0])['subtotal'] == 6000.0

    def test_devolver_lo_fiado_repone_el_stock(self, local):
        """El cliente trae de vuelta algo que se había llevado."""
        items = [linea(local, cantidad=3)]
        local['ventas'].descontar_stock_items(items, motivo='fiado')
        assert local['productos'].get_by_id(local['pid'])['stock'] == 17

        local['ventas'].reponer_stock_items(items, motivo='fiado_quitado')
        assert local['productos'].get_by_id(local['pid'])['stock'] == 20


# ── Baja del cliente ──────────────────────────────────────────────────────

class TestBaja:
    def test_dar_de_baja_lo_saca_de_la_lista_sin_perder_el_historial(self, local):
        fiar(local, cantidad=2)
        local['fiado'].eliminar_cliente(local['cid'])
        assert local['fiado'].get_clientes() == []
        # El item sigue estando: el historial no se toca.
        assert local['fiado'].get_items(cliente(local))[0]['subtotal'] == 6000.0

    def test_buscar_por_nombre_y_por_telefono(self, local):
        fiar(local, cantidad=1)
        assert len(local['fiado'].get_clientes(buscar='marta')) == 1
        assert len(local['fiado'].get_clientes(buscar='7046684')) == 1
        assert local['fiado'].get_clientes(buscar='juan') == []
