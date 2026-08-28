"""
Presupuestos: la cotización que se le pasa al cliente antes de vender.

Lo que tiene que cerrar: la numeración no se repite ni saltea (el número va
impreso y el cliente lo dicta por teléfono), no toca stock, vence solo cuando
se pasa la fecha, y al convertirse en venta queda atado a esa venta.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.cash_register import CashRegister
from pos_system.models.presupuesto import Presupuesto
from pos_system.models.product import Product
from pos_system.models.sale import Sale

_TZ_AR = timezone(timedelta(hours=-3))


@pytest.fixture
def db(tmp_path):
    # Una base por prueba: en Windows el archivo queda tomado un rato después
    # de cerrar y reusar el mismo nombre hacía fallar a la prueba siguiente por
    # algo que no tenía que ver con lo que estaba probando.
    base = DatabaseManager(str(tmp_path / 'presupuestos.db'))
    base.initialize_database()
    yield base


@pytest.fixture
def modelo(db):
    return Presupuesto(db)


ITEMS = [
    {'product_name': 'RESMA A4', 'quantity': 10, 'unit_price': 12000.0},
    {'product_name': 'BIROME AZUL', 'quantity': 24, 'unit_price': 800.0},
]


class TestCrear:
    def test_arranca_en_uno_y_sigue_correlativo(self, modelo):
        assert modelo.peek_next_numero() == 1
        assert modelo.create(ITEMS, cliente_nombre='Escuela 25')['numero'] == 1
        assert modelo.create(ITEMS, cliente_nombre='Escuela 25')['numero'] == 2
        assert modelo.peek_next_numero() == 3

    def test_mirar_el_proximo_numero_no_lo_gasta(self, modelo):
        modelo.peek_next_numero()
        modelo.peek_next_numero()
        assert modelo.create(ITEMS)['numero'] == 1

    def test_suma_los_renglones(self, modelo):
        p = modelo.create(ITEMS)
        assert p['subtotal'] == 139200.0     # 120.000 + 19.200
        assert p['total'] == 139200.0
        assert len(p['items']) == 2

    def test_el_descuento_baja_el_total_sin_tocar_el_subtotal(self, modelo):
        p = modelo.create(ITEMS, descuento=9200.0)
        assert p['subtotal'] == 139200.0
        assert p['total'] == 130000.0

    def test_un_presupuesto_vacio_no_se_puede_hacer(self, modelo):
        with pytest.raises(ValueError):
            modelo.create([])

    def test_nace_pendiente(self, modelo):
        assert modelo.create(ITEMS)['estado'] == 'pendiente'

    def test_no_toca_el_stock(self, db, modelo):
        pid = Product(db).create({'name': 'RESMA A4', 'price': 12000.0, 'stock': 30})
        modelo.create([{'product_id': pid, 'product_name': 'RESMA A4',
                        'quantity': 10, 'unit_price': 12000.0}])
        assert Product(db).get_by_id(pid)['stock'] == 30

    def test_la_validez_se_cuenta_en_dias(self, modelo):
        p = modelo.create(ITEMS, validez_dias=15)
        esperado = (datetime.now(_TZ_AR) + timedelta(days=15)).strftime('%Y-%m-%d')
        assert p['fecha_validez'] == esperado


class TestBuscar:
    def test_por_numero(self, modelo):
        modelo.create(ITEMS, cliente_nombre='Uno')
        p2 = modelo.create(ITEMS, cliente_nombre='Dos')
        assert modelo.get_by_numero(p2['numero'])['cliente_nombre'] == 'Dos'

    def test_por_nombre_del_cliente(self, modelo):
        modelo.create(ITEMS, cliente_nombre='Escuela 25')
        modelo.create(ITEMS, cliente_nombre='Kiosco Marta')
        assert len(modelo.list_all(search='Marta')) == 1
        assert len(modelo.list_all(search='Escuela')) == 1

    def test_por_estado(self, modelo):
        a = modelo.create(ITEMS)
        modelo.create(ITEMS)
        modelo.set_estado(a['id'], 'anulado')
        assert len(modelo.list_all(estado='pendiente')) == 1
        assert len(modelo.list_all(estado='anulado')) == 1
        assert len(modelo.list_all()) == 2

    def test_el_borrado_sale_de_la_lista_pero_no_de_la_base(self, modelo):
        p = modelo.create(ITEMS)
        modelo.soft_delete(p['id'])
        assert modelo.list_all() == []
        assert len(modelo.list_all(include_deleted=True)) == 1
        assert modelo.get_by_numero(p['numero']) is None


class TestEstados:
    def test_convertir_lo_deja_atado_a_la_venta(self, db, modelo):
        pid = Product(db).create({'name': 'RESMA A4', 'price': 12000.0, 'stock': 30})
        CashRegister(db).open_register(initial_amount=0.0)
        venta = Sale(db).create({
            'total_amount': 12000.0, 'payment_type': 'cash', 'cash_received': 12000.0,
            'items': [{'product_id': pid, 'product_name': 'RESMA A4',
                       'quantity': 1, 'unit_price': 12000.0}]})

        p = modelo.create(ITEMS)
        modelo.set_estado(p['id'], 'convertido', venta_id=venta)
        actualizado = modelo.get_by_id(p['id'])
        assert actualizado['estado'] == 'convertido'
        assert actualizado['venta_id'] == venta

    def test_no_se_puede_atar_a_una_venta_que_no_existe(self, modelo):
        """La FK contra `sales` es a propósito: cada PC numera sus ventas por su
        cuenta, y un presupuesto no puede apuntar a una venta de otra máquina.
        Por eso el sync entrante traduce el id antes de guardarlo."""
        import sqlite3
        p = modelo.create(ITEMS)
        with pytest.raises(sqlite3.IntegrityError):
            modelo.set_estado(p['id'], 'convertido', venta_id=99999)

    def test_un_estado_inventado_se_rechaza(self, modelo):
        p = modelo.create(ITEMS)
        with pytest.raises(ValueError):
            modelo.set_estado(p['id'], 'facturado')

    def test_vence_solo_cuando_se_paso_la_fecha(self, db, modelo):
        vigente = modelo.create(ITEMS, validez_dias=7)
        vencido = modelo.create(ITEMS, validez_dias=7)
        # Se le corre la fecha de validez a ayer, como si hubiera pasado la semana.
        ayer = (datetime.now(_TZ_AR) - timedelta(days=1)).strftime('%Y-%m-%d')
        db.execute_update("UPDATE presupuestos SET fecha_validez = ? WHERE id = ?",
                          (ayer, vencido['id']))

        assert modelo.expire_overdue() == 1
        assert modelo.get_by_id(vencido['id'])['estado'] == 'vencido'
        assert modelo.get_by_id(vigente['id'])['estado'] == 'pendiente'

    def test_uno_ya_convertido_no_se_vence(self, db, modelo):
        """El cliente ya compró: que el presupuesto venza después no cambia nada."""
        p = modelo.create(ITEMS, validez_dias=1)
        modelo.set_estado(p['id'], 'convertido')
        ayer = (datetime.now(_TZ_AR) - timedelta(days=1)).strftime('%Y-%m-%d')
        db.execute_update("UPDATE presupuestos SET fecha_validez = ? WHERE id = ?",
                          (ayer, p['id']))

        assert modelo.expire_overdue() == 0
        assert modelo.get_by_id(p['id'])['estado'] == 'convertido'
