"""
El stock que el cajero ve en pantalla, y los códigos que el POS inventa solo.

Un producto vinculado no tiene stock propio: "Impresión A3" sale del "Papel
Obra A3", y lo que hay que mostrar es cuántas impresiones se pueden hacer con
el papel que queda. Si ese número miente, se promete un trabajo que no se puede
entregar.

El otro caso delicado es el servicio: no lleva control de stock y lo dice su
bandera, NO el número. Cualquier producto vendido estando en cero llega a -1
solo, y antes eso lo convertía en servicio para siempre — media góndola dejó de
descontar.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.product import Product
from pos_system.utils import stock_links
from pos_system.utils.code_generator import generate_unique_codes, is_valid_barcode


@pytest.fixture
def db(tmp_path):
    base = DatabaseManager(str(tmp_path / 'stock.db'))
    base.initialize_database()
    yield base


def vinculado(**extra):
    """Un producto que consume de otro, como lo guarda el catálogo."""
    base = {'stock': 0, 'vinculaciones': '[{"doc_id": "papel-a3", "cantidad": 1}]'}
    base.update(extra)
    return base


class TestLeerLosVinculos:
    def test_formato_nuevo(self):
        p = {'vinculaciones': '[{"doc_id": "papel", "cantidad": 2, "nombre": "Papel"}]'}
        assert stock_links.parse_links(p) == [{'doc_id': 'papel', 'cantidad': 2.0}]

    def test_formato_viejo(self):
        p = {'vinculaciones': None, 'vinculado_a': 'papel', 'vinculado_cantidad': 3}
        assert stock_links.parse_links(p) == [{'doc_id': 'papel', 'cantidad': 3.0}]

    def test_el_formato_nuevo_le_gana_al_viejo(self):
        p = {'vinculaciones': '[{"doc_id": "nuevo", "cantidad": 1}]',
             'vinculado_a': 'viejo', 'vinculado_cantidad': 9}
        assert stock_links.parse_links(p) == [{'doc_id': 'nuevo', 'cantidad': 1.0}]

    def test_un_json_roto_no_rompe_la_venta(self):
        assert stock_links.parse_links({'vinculaciones': '{roto'}) == []

    def test_un_vinculo_sin_cantidad_se_descarta(self):
        p = {'vinculaciones': '[{"doc_id": "papel", "cantidad": 0}, {"cantidad": 2}]'}
        assert stock_links.parse_links(p) == []

    def test_un_producto_sin_vinculos(self):
        assert stock_links.has_links({'vinculaciones': None}) is False
        assert stock_links.has_links(None) is False


class TestStockEfectivo:
    def test_cuantas_impresiones_salen_del_papel_que_queda(self, db):
        Product(db).create({'name': 'PAPEL OBRA A3', 'price': 100.0, 'stock': 500,
                            'firebase_id': 'papel-a3'})
        assert stock_links.effective_stock(vinculado(), db) == 500.0

    def test_si_cada_impresion_gasta_dos_hojas_salen_la_mitad(self, db):
        Product(db).create({'name': 'PAPEL OBRA A3', 'price': 100.0, 'stock': 501,
                            'firebase_id': 'papel-a3'})
        p = vinculado(vinculaciones='[{"doc_id": "papel-a3", "cantidad": 2}]')
        assert stock_links.effective_stock(p, db) == 250.0   # no se hace media impresión

    def test_manda_el_insumo_que_primero_se_acaba(self, db):
        Product(db).create({'name': 'PAPEL', 'price': 1.0, 'stock': 500, 'firebase_id': 'papel-a3'})
        Product(db).create({'name': 'TONER', 'price': 1.0, 'stock': 7, 'firebase_id': 'toner'})
        p = vinculado(vinculaciones='[{"doc_id": "papel-a3", "cantidad": 1},'
                                    ' {"doc_id": "toner", "cantidad": 1}]')
        assert stock_links.effective_stock(p, db) == 7.0

    def test_un_insumo_que_no_esta_en_el_catalogo_deja_todo_en_cero(self, db):
        """Antes que prometer un trabajo que no se puede hacer, se muestra cero."""
        assert stock_links.effective_stock(vinculado(), db) == 0.0

    def test_el_insumo_conjunto_cuenta_por_su_total(self, db):
        pid = Product(db).create({'name': 'ROLLO PAPEL', 'price': 1.0, 'stock': 2,
                                  'firebase_id': 'papel-a3'})
        db.execute_update("UPDATE products SET es_conjunto = 1, conjunto_total = 80 "
                          "WHERE id = ?", (pid,))
        # El `stock` plano dice 2 (rollos); lo que se puede imprimir son 80.
        assert stock_links.effective_stock(vinculado(), db) == 80.0

    def test_si_todos_los_insumos_son_servicio_no_hay_tope(self, db):
        pid = Product(db).create({'name': 'SERVICIO', 'price': 1.0, 'stock': 0,
                                  'firebase_id': 'papel-a3'})
        db.execute_update("UPDATE products SET stock = -1 WHERE id = ?", (pid,))
        assert stock_links.effective_stock(vinculado(), db) == -1.0

    def test_un_producto_sin_vinculos_devuelve_su_propio_stock(self):
        assert stock_links.effective_stock({'stock': 12}) == 12.0

    def test_el_indice_evita_una_consulta_por_insumo(self, db):
        Product(db).create({'name': 'PAPEL', 'price': 1.0, 'stock': 300, 'firebase_id': 'papel-a3'})
        productos = [vinculado(), vinculado()]
        idx = stock_links.build_target_index(productos, db)
        assert 'papel-a3' in idx
        assert stock_links.effective_stock(productos[0], None, targets_index=idx) == 300.0


class TestLoQueSeVeEnPantalla:
    def test_un_producto_comun(self):
        assert stock_links.shown_stock({'stock': 12}) == ('12', 12.0)

    def test_sobrevendido_se_muestra_en_cero_y_no_en_negativo(self):
        """El -3 dice cuánto falta reponer, pero en góndola no hay -3: hay 0."""
        assert stock_links.shown_stock({'stock': -3}) == ('0', 0.0)

    def test_un_servicio_se_muestra_infinito_por_su_bandera(self):
        texto, num = stock_links.shown_stock({'stock': 0, 'stock_ilimitado': 1})
        assert texto == '∞' and num == float('inf')

    def test_estar_en_menos_uno_ya_no_convierte_en_servicio(self):
        """El bug que congelaba productos: llegar a -1 vendiendo no es ser
        servicio. Quien decide es la bandera, y el -1 solo ya no alcanza."""
        assert stock_links.es_ilimitado({'stock': -1}) is False
        assert stock_links.es_ilimitado({'stock': 0, 'stock_ilimitado': 1}) is True

    def test_el_menos_uno_suelto_todavia_se_muestra_infinito(self):
        """Fallback a propósito, para las bases que aún no se migraron.

        Mientras queden productos en -1 sin bandera, el cajero los ve como "∞"
        aunque estén agotados. Se limpia corriendo `fix_stock_menos_uno.py
        --aplicar`, que separa los servicios de verdad de los que quedaron
        congelados; el día que no quede ninguno, este fallback se puede sacar.
        """
        assert stock_links.shown_stock({'stock': -1, 'stock_ilimitado': 0}) == ('∞', float('inf'))
        # Con la bandera puesta la respuesta es la misma, pero por el motivo correcto.
        assert stock_links.shown_stock({'stock': -1, 'stock_ilimitado': 1})[0] == '∞'

    def test_un_vinculado_muestra_lo_que_puede_hacer(self, db):
        Product(db).create({'name': 'PAPEL', 'price': 1.0, 'stock': 40, 'firebase_id': 'papel-a3'})
        assert stock_links.shown_stock(vinculado(), db) == ('40', 40.0)

    def test_las_fracciones_se_muestran_sin_ceros_de_relleno(self):
        assert stock_links.shown_stock({'stock': 2.5}) == ('2.5', 2.5)


class TestCodigosAutomaticos:
    def test_el_primero_arranca_en_uno(self, db):
        assert generate_unique_codes(db) == ('AUTO-1', 'POS1')

    def test_sigue_desde_el_mas_alto_que_haya(self, db):
        Product(db).create({'name': 'UNO', 'price': 1.0, 'stock': 1,
                            'barcode': 'POS7', 'firebase_id': 'AUTO-3'})
        assert generate_unique_codes(db) == ('AUTO-4', 'POS8')

    def test_los_codigos_de_barras_reales_no_lo_confunden(self, db):
        Product(db).create({'name': 'UNO', 'price': 1.0, 'stock': 1, 'barcode': '7790001'})
        assert generate_unique_codes(db)[1] == 'POS1'

    def test_valida_la_forma_del_codigo_de_barras(self):
        assert is_valid_barcode('7790001') is True
        assert is_valid_barcode('ABC-123_x') is True
        assert is_valid_barcode('AB') is False          # muy corto
        assert is_valid_barcode('ABC$%^') is False      # símbolos
        assert is_valid_barcode('') is False
