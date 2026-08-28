"""
Ventas Pendientes: el carrito que queda en espera.

El cliente fue a buscar plata al cajero automático y atrás hay cola. El cajero
guarda el carrito, atiende a los que siguen, y cuando el otro vuelve lo
restaura tal cual estaba. Lo que tiene que salir bien es esa restauración: si
el carrito vuelve distinto del que se guardó, se cobra otra cosa.

Es 100% local, no sincroniza a Firebase.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.pending_cart import PendingCart


@pytest.fixture
def db(tmp_path):
    base = DatabaseManager(str(tmp_path / 'pendientes.db'))
    base.initialize_database()
    yield base


@pytest.fixture
def modelo(db):
    return PendingCart(db)


CARRITO = [
    {'product_id': 1, 'product_name': 'CUADERNO', 'quantity': 2,
     'unit_price': 3000.0, 'subtotal': 6000.0},
    {'product_id': 2, 'product_name': 'BIROME', 'quantity': 3,
     'unit_price': 800.0, 'subtotal': 2400.0},
]


class TestGuardar:
    def test_guarda_el_total_y_la_cantidad(self, modelo):
        pid = modelo.create(CARRITO, cajero_nombre='Marta')
        p = modelo.get_by_id(pid)
        assert p['total'] == 8400.0
        assert p['items_count'] == 5      # 2 + 3 unidades
        assert p['cajero_nombre'] == 'Marta'

    def test_el_carrito_vuelve_igual_que_como_entro(self, modelo):
        pid = modelo.create(CARRITO)
        assert modelo.get_by_id(pid)['items'] == CARRITO

    def test_sobrevive_a_un_conjunto_con_todos_sus_datos(self, modelo):
        """Un renglón de rollo/pack lleva el estado post-venta calculado. Si se
        pierde en el viaje, al cobrarlo el stock queda cualquier cosa."""
        linea = {
            'product_id': 7, 'product_name': '[Verde]  GOMA EVA  ·  2 u',
            'quantity': 1, 'unit_price': 1500.0, 'subtotal': 1500.0,
            'is_conjunto': True, 'conjunto_color': 'Verde',
            'conjunto_after_unidades': 3, 'conjunto_after_restante': 8.5,
        }
        pid = modelo.create([linea])
        assert modelo.get_by_id(pid)['items'][0] == linea

    def test_un_carrito_vacio_se_puede_guardar_pero_no_suma_nada(self, modelo):
        pid = modelo.create([])
        p = modelo.get_by_id(pid)
        assert p['total'] == 0
        assert p['items'] == []

    def test_lo_que_no_es_serializable_no_tumba_el_guardado(self, modelo):
        from decimal import Decimal
        pid = modelo.create([{'product_name': 'RARO', 'quantity': 1,
                              'unit_price': Decimal('10.5'), 'subtotal': 10.5}])
        assert modelo.get_by_id(pid) is not None


class TestLista:
    def test_los_mas_nuevos_primero(self, modelo):
        modelo.create(CARRITO, nota='primero')
        modelo.create(CARRITO, nota='segundo')
        assert [p['nota'] for p in modelo.get_all()] == ['segundo', 'primero']

    def test_el_contador_del_boton(self, modelo):
        assert modelo.count() == 0
        modelo.create(CARRITO)
        modelo.create(CARRITO)
        assert modelo.count() == 2


class TestSacarDeLaLista:
    def test_borrar_lo_saca(self, modelo):
        pid = modelo.create(CARRITO)
        assert modelo.delete(pid) == 1
        assert modelo.count() == 0
        assert modelo.get_by_id(pid) is None

    def test_borrar_dos_veces_no_hace_nada(self, modelo):
        pid = modelo.create(CARRITO)
        modelo.delete(pid)
        assert modelo.delete(pid) == 0


class TestCorrupcion:
    def test_un_carrito_corrupto_no_rompe_la_lista(self, db, modelo):
        """Si el JSON se rompió, el pendiente aparece vacío en vez de tirar
        abajo toda la pestaña con los demás pendientes adentro."""
        bueno = modelo.create(CARRITO)
        malo = modelo.create(CARRITO)
        db.execute_update("UPDATE pending_carts SET items_json = ? WHERE id = ?",
                          ('{no es json', malo))

        todos = modelo.get_all()
        assert len(todos) == 2
        assert modelo.get_by_id(malo)['items'] == []
        assert modelo.get_by_id(bueno)['items'] == CARRITO
