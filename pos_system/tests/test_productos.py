"""
La pestaña Productos: el catálogo como lo toca el local.

Lo que importa acá es lo que después se cobra o se repone: que un código de
barras no quede repetido (el scanner traería el producto equivocado), que las
validaciones no dejen pasar un precio o un stock imposible, y sobre todo que la
alerta de stock bajo agarre los tres tipos de producto que maneja el sistema —
incluido el conjunto por variedad, donde "el rojo casi vacío" no se ve en
ningún número plano.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.product import Product
from pos_system.utils.validators import ValidationError


@pytest.fixture
def db(tmp_path):
    base = DatabaseManager(str(tmp_path / 'productos.db'))
    base.initialize_database()
    yield base


@pytest.fixture
def productos(db):
    return Product(db)


class TestAlta:
    def test_un_producto_normal(self, productos):
        pid = productos.create({'name': 'CUADERNO RIVADAVIA', 'price': 3000.0,
                                'cost': 1800.0, 'stock': 20, 'category': 'LIBRERIA',
                                'barcode': '7790001'})
        p = productos.get_by_id(pid)
        assert p['name'] == 'CUADERNO RIVADAVIA'
        assert p['price'] == 3000.0
        assert p['stock'] == 20

    def test_el_codigo_de_barras_no_se_repite(self, productos):
        """Repetido, el scanner trae el producto equivocado y se cobra otra cosa."""
        productos.create({'name': 'CUADERNO', 'price': 3000.0, 'stock': 5,
                          'barcode': '7790001'})
        with pytest.raises(ValidationError):
            productos.create({'name': 'BIROME', 'price': 800.0, 'stock': 5,
                              'barcode': '7790001'})

    def test_se_puede_no_tener_codigo_de_barras(self, productos):
        """El 99% del catálogo no tiene EAN: no puede ser obligatorio."""
        assert productos.create({'name': 'CARTULINA SUELTA', 'price': 900.0, 'stock': 3})
        assert productos.create({'name': 'OTRA CARTULINA', 'price': 900.0, 'stock': 3})

    def test_un_precio_en_cero_se_rechaza(self, productos):
        with pytest.raises(ValidationError):
            productos.create({'name': 'REGALO', 'price': 0, 'stock': 1})

    def test_el_costo_si_puede_ser_cero(self, productos):
        assert productos.create({'name': 'MUESTRA', 'price': 100.0, 'cost': 0, 'stock': 1})

    def test_un_nombre_de_una_letra_se_rechaza(self, productos):
        with pytest.raises(ValidationError):
            productos.create({'name': 'X', 'price': 100.0, 'stock': 1})

    def test_un_stock_negativo_no_se_puede_cargar(self, productos):
        """Vendiendo se llega a negativo (falta reponer), pero cargarlo a mano no."""
        with pytest.raises(ValidationError):
            productos.create({'name': 'ALGO', 'price': 100.0, 'stock': -5})

    def test_los_espacios_de_los_bordes_se_van(self, productos):
        pid = productos.create({'name': '  CUADERNO  ', 'price': 100.0, 'stock': 1})
        assert productos.get_by_id(pid)['name'] == 'CUADERNO'


class TestBuscar:
    @pytest.fixture(autouse=True)
    def catalogo(self, productos):
        productos.create({'name': 'CUADERNO RIVADAVIA', 'price': 3000.0, 'stock': 10,
                          'category': 'LIBRERIA', 'barcode': '7790001'})
        productos.create({'name': 'BIROME BIC AZUL', 'price': 800.0, 'stock': 50,
                          'category': 'LIBRERIA'})
        productos.create({'name': 'HILO DE ALGODON', 'price': 1200.0, 'stock': 8,
                          'category': 'MERCERIA'})

    def test_por_codigo_de_barras(self, productos):
        assert productos.get_by_barcode('7790001')['name'] == 'CUADERNO RIVADAVIA'
        assert productos.get_by_barcode('nada') is None

    def test_por_pedazo_del_nombre(self, productos):
        assert len(productos.get_all(search='BIROME')) == 1
        assert len(productos.get_all(search='ALGODON')) == 1

    def test_por_rubro(self, productos):
        assert len(productos.get_all(category='LIBRERIA')) == 2
        assert len(productos.get_all(category='MERCERIA')) == 1

    def test_la_lista_de_rubros(self, productos):
        assert productos.get_categories() == ['LIBRERIA', 'MERCERIA']

    def test_el_producto_varios_no_esta_en_el_catalogo(self, db, productos):
        """El id 0 es el centinela de los ítems libres: no es un producto."""
        assert all(p['id'] != 0 for p in productos.get_all())

    def test_los_favoritos(self, productos):
        pid = productos.get_all(search='BIROME')[0]['id']
        productos.toggle_favorite(pid)
        assert [p['name'] for p in productos.get_favorites()] == ['BIROME BIC AZUL']
        productos.toggle_favorite(pid)
        assert productos.get_favorites() == []


class TestEditar:
    def test_cambiar_el_precio(self, productos):
        pid = productos.create({'name': 'CUADERNO', 'price': 3000.0, 'stock': 10})
        productos.update(pid, price=3500.0)
        assert productos.get_by_id(pid)['price'] == 3500.0

    def test_no_se_puede_robar_un_codigo_de_barras_ajeno(self, productos):
        productos.create({'name': 'CUADERNO', 'price': 100.0, 'stock': 1, 'barcode': '111'})
        otro = productos.create({'name': 'BIROME', 'price': 100.0, 'stock': 1, 'barcode': '222'})
        with pytest.raises(ValidationError):
            productos.update(otro, barcode='111')

    def test_guardarse_su_propio_codigo_de_barras_no_molesta(self, productos):
        pid = productos.create({'name': 'CUADERNO', 'price': 100.0, 'stock': 1, 'barcode': '111'})
        assert productos.update(pid, barcode='111', price=200.0)

    def test_un_campo_que_no_existe_se_ignora(self, productos):
        pid = productos.create({'name': 'CUADERNO', 'price': 100.0, 'stock': 1})
        assert productos.update(pid, inventado='x') is False

    def test_sumar_y_restar_stock(self, productos):
        pid = productos.create({'name': 'CUADERNO', 'price': 100.0, 'stock': 10})
        productos.update_stock(pid, 5)
        assert productos.get_by_id(pid)['stock'] == 15
        productos.update_stock(pid, -12)
        assert productos.get_by_id(pid)['stock'] == 3


class TestStockBajo:
    def test_agarra_lo_que_esta_por_debajo_del_umbral(self, productos):
        productos.create({'name': 'POCO', 'price': 100.0, 'stock': 2})
        productos.create({'name': 'MUCHO', 'price': 100.0, 'stock': 80})
        assert [p['name'] for p in productos.get_low_stock(threshold=5)] == ['POCO']

    def test_el_minimo_propio_le_gana_al_umbral_general(self, productos):
        """Una resma con mínimo 20 avisa en 20 aunque el umbral general sea 5."""
        productos.create({'name': 'RESMA', 'price': 100.0, 'stock': 15, 'stock_min': 20})
        assert [p['name'] for p in productos.get_low_stock(threshold=5)] == ['RESMA']

    def test_un_servicio_no_avisa_nunca(self, db, productos):
        pid = productos.create({'name': 'FOTOCOPIA', 'price': 100.0, 'stock': 0})
        db.execute_update("UPDATE products SET stock = -1, stock_ilimitado = 1 WHERE id = ?", (pid,))
        assert productos.get_low_stock(threshold=5) == []

    def test_un_conjunto_avisa_por_su_total_y_no_por_el_stock_plano(self, db, productos):
        pid = productos.create({'name': 'CINTA RASO', 'price': 100.0, 'stock': 0})
        db.execute_update(
            "UPDATE products SET es_conjunto = 1, conjunto_contenido = 25, "
            "conjunto_total = 3 WHERE id = ?", (pid,))
        assert [p['name'] for p in productos.get_low_stock(threshold=5)] == ['CINTA RASO']

    def test_un_conjunto_cargado_no_aparece(self, db, productos):
        pid = productos.create({'name': 'CINTA RASO', 'price': 100.0, 'stock': 0})
        db.execute_update(
            "UPDATE products SET es_conjunto = 1, conjunto_contenido = 25, "
            "conjunto_total = 200 WHERE id = ?", (pid,))
        assert productos.get_low_stock(threshold=5) == []

    def test_avisa_por_el_color_que_se_esta_acabando(self, db, productos):
        """Con 4 rojos y 300 azules el total está sobrado, pero el rojo no.

        Es el caso que ningún número plano muestra: quien mira el total ve 304
        y repone cuando ya se quedó sin rojo.
        """
        pid = productos.create({'name': 'CARTULINA', 'price': 100.0, 'stock': 0})
        colores = [{'color': 'Rojo', 'unidades': 0, 'restante': 4},
                   {'color': 'Azul', 'unidades': 6, 'restante': 0}]
        db.execute_update(
            "UPDATE products SET es_conjunto = 1, conjunto_contenido = 50, "
            "conjunto_total = 304, conjunto_colores = ? WHERE id = ?",
            (json.dumps(colores), pid))

        bajos = productos.get_low_stock(threshold=5)
        assert len(bajos) == 1
        assert [c['color'] for c in bajos[0]['_colores_bajos']] == ['Rojo']

    def test_una_variedad_puede_venir_en_otra_presentacion(self, db, productos):
        """Los azules por caja de 50 y los violetas por caja de 12: cada
        variedad cuenta con SU contenido, no con el del producto."""
        pid = productos.create({'name': 'BOLIGRAFO', 'price': 100.0, 'stock': 0})
        colores = [{'color': 'Azul', 'unidades': 2, 'restante': 0},
                   {'color': 'Violeta', 'unidades': 0, 'restante': 3, 'contenido': 12}]
        db.execute_update(
            "UPDATE products SET es_conjunto = 1, conjunto_contenido = 50, "
            "conjunto_total = 103, conjunto_colores = ? WHERE id = ?",
            (json.dumps(colores), pid))

        bajos = productos.get_low_stock(threshold=5)
        assert [c['color'] for c in bajos[0]['_colores_bajos']] == ['Violeta']

    def test_un_json_de_colores_roto_no_tumba_la_alerta(self, db, productos):
        productos.create({'name': 'POCO', 'price': 100.0, 'stock': 1})
        pid = productos.create({'name': 'ROTO', 'price': 100.0, 'stock': 0})
        db.execute_update(
            "UPDATE products SET es_conjunto = 1, conjunto_contenido = 50, "
            "conjunto_total = 900, conjunto_colores = ? WHERE id = ?",
            ('{no es json', pid))
        # El de al lado sigue avisando; el roto cae al total agregado.
        assert 'POCO' in [p['name'] for p in productos.get_low_stock(threshold=5)]
