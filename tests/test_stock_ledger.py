"""
El historial de movimientos de stock.

Lo que se prueba acá es que cada movimiento quede anotado con el antes y el
después reales — que es lo único que sirve cuando un stock no cierra contra la
góndola y hay que reconstruir de dónde salió cada unidad.

    python -m pytest tests/test_stock_ledger.py -v
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.product import Product
from pos_system.models.sale import Sale
from pos_system.models.cash_register import CashRegister
from pos_system.utils import stock_ledger

TEST_DB = 'tmp_test_stock_ledger.db'


@pytest.fixture(scope='function')
def db():
    database = DatabaseManager(TEST_DB)
    database.initialize_database()
    yield database
    if os.path.exists(TEST_DB):
        os.remove(TEST_DB)


@pytest.fixture
def caja(db):
    return CashRegister(db).open_register(initial_amount=500.0)


def movimientos(db, firebase_id=None):
    if firebase_id:
        return db.execute_query(
            "SELECT * FROM stock_movimientos WHERE firebase_id = ? ORDER BY id",
            (firebase_id,)
        ) or []
    return db.execute_query("SELECT * FROM stock_movimientos ORDER BY id") or []


def _vender(db, pid, nombre, cantidad, precio=100.0, caja_id=None):
    return Sale(db).create({
        'items': [{
            'product_id': pid, 'product_name': nombre,
            'quantity': cantidad, 'unit_price': precio,
        }],
        'payment_type': 'cash',
        'total_amount': precio * cantidad,
        'cash_received': precio * cantidad,
        'turno_nombre': 'Anita',
    })


class TestRegistroDeVentas:

    def test_la_tabla_se_crea_al_inicializar(self, db):
        assert movimientos(db) == []

    def test_una_venta_deja_el_antes_y_el_despues(self, db, caja):
        pid = Product(db).create({'name': 'CUADERNO', 'price': 100.0, 'stock': 12})
        _vender(db, pid, 'CUADERNO', 2)

        movs = movimientos(db)
        assert len(movs) == 1
        m = movs[0]
        assert m['motivo'] == 'venta'
        assert m['cantidad'] == -2
        assert m['stock_antes'] == 12
        assert m['stock_despues'] == 10
        assert m['usuario'] == 'Anita'
        assert 'Venta #' in (m['referencia'] or '')
        assert m['fb_synced'] == 0

    def test_el_movimiento_apunta_al_producto_del_catalogo(self, db, caja):
        pid = Product(db).create({'name': 'REGLA', 'price': 100.0, 'stock': 4})
        db.execute_update("UPDATE products SET firebase_id = ? WHERE id = ?", ('987025', pid))

        _vender(db, pid, 'REGLA', 1)

        movs = movimientos(db, '987025')
        assert len(movs) == 1
        assert movs[0]['producto_id'] == pid
        assert movs[0]['producto_nombre'] == 'REGLA'

    def test_dos_ventas_dejan_dos_filas_encadenadas(self, db, caja):
        pid = Product(db).create({'name': 'GOMA', 'price': 100.0, 'stock': 5})
        _vender(db, pid, 'GOMA', 1)
        _vender(db, pid, 'GOMA', 3)

        movs = movimientos(db)
        assert [(m['stock_antes'], m['stock_despues']) for m in movs] == [(5, 4), (4, 1)]

    def test_un_servicio_ilimitado_no_genera_movimiento(self, db, caja):
        # stock = -1 es la bandera de servicio: no se descuenta nada, así que
        # tampoco hay movimiento que anotar.
        pid = Product(db).create({'name': 'FOTOCOPIA', 'price': 100.0, 'stock': 0})
        db.execute_update("UPDATE products SET stock = -1 WHERE id = ?", (pid,))

        _vender(db, pid, 'FOTOCOPIA', 3)

        assert movimientos(db) == []

    def test_vender_sin_stock_lo_deja_registrado_en_negativo(self, db, caja):
        # El POS permite vender sin stock. El movimiento tiene que quedar igual:
        # es justo el caso que después no cierra y hay que poder mirarlo.
        pid = Product(db).create({'name': 'ESCASO', 'price': 100.0, 'stock': 1})
        _vender(db, pid, 'ESCASO', 3)

        m = movimientos(db)[0]
        assert m['stock_antes'] == 1
        assert m['stock_despues'] == -2


class TestFiadoYReposicion:

    def test_cargar_a_fiado_descuenta_y_queda_anotado(self, db):
        pid = Product(db).create({'name': 'CARPETA', 'price': 100.0, 'stock': 8})
        Sale(db).descontar_stock_items(
            [{'product_id': pid, 'product_name': 'CARPETA', 'quantity': 2}],
            usuario='Agus',
        )

        m = movimientos(db)[0]
        assert m['motivo'] == 'fiado'
        assert (m['stock_antes'], m['stock_despues']) == (8, 6)
        assert m['usuario'] == 'Agus'

    def test_quitar_del_fiado_devuelve_y_lo_anota_en_positivo(self, db):
        pid = Product(db).create({'name': 'TIJERA', 'price': 100.0, 'stock': 8})
        item = {'product_id': pid, 'product_name': 'TIJERA', 'quantity': 2}
        Sale(db).descontar_stock_items([dict(item)], usuario='Agus')
        Sale(db).reponer_stock_items([dict(item)], usuario='Agus')

        movs = movimientos(db)
        assert len(movs) == 2
        assert movs[1]['motivo'] == 'fiado_quitado'
        assert movs[1]['cantidad'] == 2
        assert (movs[1]['stock_antes'], movs[1]['stock_despues']) == (6, 8)


class TestColaDeSubida:

    def test_los_pendientes_salen_del_mas_viejo_al_mas_nuevo(self, db, caja):
        pid = Product(db).create({'name': 'LAPIZ', 'price': 100.0, 'stock': 9})
        _vender(db, pid, 'LAPIZ', 1)
        _vender(db, pid, 'LAPIZ', 1)

        pend = stock_ledger.pendientes(db)
        assert [p['id'] for p in pend] == sorted(p['id'] for p in pend)
        assert len(pend) == 2

    def test_marcar_subidos_los_saca_de_la_cola(self, db, caja):
        pid = Product(db).create({'name': 'BORRADOR', 'price': 100.0, 'stock': 3})
        _vender(db, pid, 'BORRADOR', 1)

        pend = stock_ledger.pendientes(db)
        stock_ledger.marcar_subidos(db, [p['id'] for p in pend])

        assert stock_ledger.pendientes(db) == []
        assert movimientos(db)[0]['fb_synced'] == 1

    def test_una_venta_que_falla_no_deja_movimiento(self, db, caja):
        # El movimiento va en la misma transacción que la venta: si la venta se
        # cae, no puede quedar registrado un movimiento que nunca pasó.
        pid = Product(db).create({'name': 'ANOTADOR', 'price': 100.0, 'stock': 5})
        with pytest.raises(ValueError):
            Sale(db).create({
                'items': [{'product_id': pid, 'product_name': 'ANOTADOR',
                           'quantity': 1, 'unit_price': 100.0}],
                'payment_type': 'cash',
                'total_amount': 0,          # inválido: corta antes de tocar nada
            })

        assert movimientos(db) == []
