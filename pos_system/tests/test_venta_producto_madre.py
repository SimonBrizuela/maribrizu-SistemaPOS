"""
Vender un Producto Madre: el stock que vive adentro de las presentaciones.

Un producto madre no lleva un número de stock plano. Su stock está repartido en
presentaciones (la caja, la unidad suelta, el rollo) y cada una guarda dos
cosas: cuántos envases cerrados quedan y cuántas unidades sueltas hay del envase
abierto. Vender tres bolígrafos saca de los sueltos; si no alcanzan, se abre una
caja y el resto queda suelto.

Es la parte del POS donde el stock se puede desalinear sin que nadie lo note, y
no tenía ninguna prueba.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.cash_register import CashRegister
from pos_system.models.sale import Sale

NODO = 'nodo-boligrafos'
PRES_CAJA = 'pres-caja'
PRES_SUELTO = 'pres-suelto'


@pytest.fixture
def db(tmp_path):
    # Una base por prueba: en Windows el archivo queda tomado un rato después
    # de cerrarlo y reusar el mismo nombre hace fallar a la prueba siguiente.
    base = DatabaseManager(str(tmp_path / 'producto_madre.db'))
    base.initialize_database()
    yield base


def armar_nodo(db, presentaciones):
    db.execute_update(
        "INSERT INTO mp_nodes (id, product_id, nombre, presentaciones) VALUES (?, ?, ?, ?)",
        (NODO, 'prod-madre', 'Bolígrafo Filgo', json.dumps(presentaciones, ensure_ascii=False))
    )


def presentaciones(db):
    fila = db.execute_query("SELECT presentaciones FROM mp_nodes WHERE id = ?", (NODO,))[0]
    return {p['id']: p for p in json.loads(fila['presentaciones'])}


def vender(db, cantidad, pres_id=PRES_SUELTO):
    """Una venta de producto madre, como la arma el POS."""
    CashRegister(db).get_current() or CashRegister(db).open_register(initial_amount=0.0)
    return Sale(db).create({
        'total_amount': max(0.01, abs(cantidad) * 1000.0),
        'payment_type': 'cash',
        'cash_received': abs(cantidad) * 1000.0,
        'items': [{
            'product_id': 0, 'product_name': 'Bolígrafo Filgo',
            'quantity': cantidad, 'unit_price': 1000.0,
            'is_mp': True, 'mp_product_id': 'prod-madre',
            'mp_node_id': NODO, 'mp_presentation_id': pres_id,
        }],
    })


# ── Sueltos primero, después se abre una caja ─────────────────────────────

class TestDescuento:
    def test_alcanza_con_los_sueltos(self, db):
        armar_nodo(db, [{'id': PRES_SUELTO, 'nombre': 'Unidad',
                         'stock': 5, 'stock_sueltos': 10, 'equivalencia_base': 12}])
        vender(db, 3)
        p = presentaciones(db)[PRES_SUELTO]
        assert p['stock_sueltos'] == 7
        assert p['stock'] == 5          # no se abrió ninguna caja

    def test_cuando_no_alcanzan_se_abre_una_caja(self, db):
        # Quedan 2 sueltos de una caja de 12 y se venden 5: se abre una caja,
        # salen los 3 que faltaban y los 9 restantes quedan sueltos.
        armar_nodo(db, [{'id': PRES_SUELTO, 'nombre': 'Unidad',
                         'stock': 4, 'stock_sueltos': 2, 'equivalencia_base': 12}])
        vender(db, 5)
        p = presentaciones(db)[PRES_SUELTO]
        assert p['stock'] == 3
        assert p['stock_sueltos'] == 9

    def test_se_abren_tantas_cajas_como_haga_falta(self, db):
        armar_nodo(db, [{'id': PRES_SUELTO, 'nombre': 'Unidad',
                         'stock': 10, 'stock_sueltos': 0, 'equivalencia_base': 12}])
        vender(db, 25)   # 3 cajas (36) menos 25 = 11 sueltos
        p = presentaciones(db)[PRES_SUELTO]
        assert p['stock'] == 7
        assert p['stock_sueltos'] == 11

    def test_el_stock_de_cajas_no_baja_de_cero(self, db):
        armar_nodo(db, [{'id': PRES_SUELTO, 'nombre': 'Unidad',
                         'stock': 1, 'stock_sueltos': 0, 'equivalencia_base': 12}])
        vender(db, 40)
        p = presentaciones(db)[PRES_SUELTO]
        assert p['stock'] == 0

    def test_sin_equivalencia_se_descuenta_del_stock_directo(self, db):
        armar_nodo(db, [{'id': PRES_CAJA, 'nombre': 'Caja',
                         'stock': 8, 'stock_sueltos': 0}])
        vender(db, 3, pres_id=PRES_CAJA)
        assert presentaciones(db)[PRES_CAJA]['stock'] == 5


# ── Presentación vinculada: el stock vive en la fuente ────────────────────

class TestVinculada:
    def test_vender_la_vinculada_descuenta_de_la_fuente(self, db):
        armar_nodo(db, [
            {'id': PRES_CAJA, 'nombre': 'Caja x12',
             'stock': 4, 'stock_sueltos': 6, 'equivalencia_base': 12},
            {'id': PRES_SUELTO, 'nombre': 'Unidad', 'stock': 0, 'stock_sueltos': 0,
             'stock_modo': 'vinculado', 'vinculada_a': PRES_CAJA},
        ])
        vender(db, 4, pres_id=PRES_SUELTO)

        p = presentaciones(db)
        assert p[PRES_CAJA]['stock_sueltos'] == 2    # salieron de la caja abierta
        assert p[PRES_CAJA]['stock'] == 4
        assert p[PRES_SUELTO]['stock_sueltos'] == 0  # la vinculada no guarda stock


# ── Devolver ──────────────────────────────────────────────────────────────

class TestDevolucion:
    def test_lo_devuelto_vuelve_como_suelto(self, db):
        """No se recompone la caja: no sabemos si se abrió para esa venta."""
        armar_nodo(db, [{'id': PRES_SUELTO, 'nombre': 'Unidad',
                         'stock': 3, 'stock_sueltos': 4, 'equivalencia_base': 12}])
        Sale(db).reponer_stock_items([{
            'product_id': 0, 'product_name': 'Bolígrafo Filgo', 'quantity': 2,
            'unit_price': 1000.0, 'is_mp': True, 'mp_product_id': 'prod-madre',
            'mp_node_id': NODO, 'mp_presentation_id': PRES_SUELTO,
        }])
        p = presentaciones(db)[PRES_SUELTO]
        assert p['stock_sueltos'] == 6
        assert p['stock'] == 3

    def test_vender_y_devolver_deja_el_mismo_total(self, db):
        armar_nodo(db, [{'id': PRES_SUELTO, 'nombre': 'Unidad',
                         'stock': 4, 'stock_sueltos': 2, 'equivalencia_base': 12}])
        total = lambda p: p['stock'] * 12 + p['stock_sueltos']
        antes = total(presentaciones(db)[PRES_SUELTO])

        vender(db, 5)
        Sale(db).reponer_stock_items([{
            'product_id': 0, 'product_name': 'Bolígrafo Filgo', 'quantity': 5,
            'unit_price': 1000.0, 'is_mp': True, 'mp_product_id': 'prod-madre',
            'mp_node_id': NODO, 'mp_presentation_id': PRES_SUELTO,
        }])
        assert total(presentaciones(db)[PRES_SUELTO]) == antes


# ── Lo que no puede romper la venta ───────────────────────────────────────

class TestNoRompe:
    def test_un_nodo_que_no_existe_no_tumba_la_venta(self, db):
        """La venta se cobra igual: el cliente está en el mostrador."""
        sale_id = vender(db, 2)
        assert sale_id is not None

    def test_una_presentacion_que_no_existe_no_tumba_la_venta(self, db):
        armar_nodo(db, [{'id': PRES_CAJA, 'nombre': 'Caja', 'stock': 5}])
        assert vender(db, 2, pres_id='pres-fantasma') is not None
        assert presentaciones(db)[PRES_CAJA]['stock'] == 5

    def test_el_producto_madre_no_toca_el_stock_plano(self, db):
        """Los mp_* usan product_id 0 en sale_items: no hay góndola que restar."""
        armar_nodo(db, [{'id': PRES_SUELTO, 'nombre': 'Unidad',
                         'stock': 3, 'stock_sueltos': 5, 'equivalencia_base': 12}])
        sale_id = vender(db, 2)
        item = Sale(db).get_by_id(sale_id)['items'][0]
        assert item['product_id'] == 0
        assert item['mp_node_id'] == NODO
        assert item['mp_presentation_id'] == PRES_SUELTO
