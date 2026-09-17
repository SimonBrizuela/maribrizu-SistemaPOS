"""
Una PC del local con la base de antes de los pedidos web se actualiza sola.

Las PCs no arrancan de cero: tienen meses de ventas en SQLite con el esquema
viejo. Al abrir la versión nueva, `initialize_database` agrega columnas e
índices. Esta prueba arma una base con el `db_manager.py` tal como estaba
antes del cambio (commit c3fe144), le carga ventas, y la abre con el actual:
las ventas viejas siguen ahí, las nuevas columnas existen y se puede vender y
cobrar pedidos como en una base nueva.
"""
import importlib.util
import os
import subprocess
import sys

import pytest

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, RAIZ)

COMMIT_VIEJO = 'c3fe144'


def modulo_viejo(tmp_path):
    try:
        codigo = subprocess.run(['git', 'show', f'{COMMIT_VIEJO}:pos_system/database/db_manager.py'],
                                cwd=RAIZ, capture_output=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        pytest.skip('sin git o sin el commit viejo')
    ruta = tmp_path / 'db_manager_viejo.py'
    ruta.write_bytes(codigo)
    spec = importlib.util.spec_from_file_location('db_manager_viejo', ruta)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def base_vieja(tmp_path):
    viejo = modulo_viejo(tmp_path)
    ruta = str(tmp_path / 'pos_viejo.db')
    db = viejo.DatabaseManager(ruta)
    db.initialize_database()
    with db.get_connection() as conn:
        conn.execute("INSERT INTO products (name, price, stock) VALUES ('CUADERNO', 3000, 20)")
        pid = conn.execute("SELECT id FROM products WHERE name='CUADERNO'").fetchone()[0]
        for i in range(3):
            conn.execute("INSERT INTO sales (total_amount, payment_type, cash_received) VALUES (3000, 'cash', 3000)")
            sid = conn.execute("SELECT MAX(id) FROM sales").fetchone()[0]
            conn.execute("INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, "
                         "original_price, subtotal) VALUES (?, ?, 'CUADERNO', 1, 3000, 3000, 3000)", (sid, pid))
    return ruta, pid


def columnas(db, tabla):
    return {c['name'] for c in db.execute_query(f"PRAGMA table_info({tabla})")}


def test_la_base_vieja_se_actualiza_sin_perder_ventas(base_vieja):
    from pos_system.database.db_manager import DatabaseManager
    ruta, _pid = base_vieja
    db = DatabaseManager(ruta)
    db.initialize_database()
    db.initialize_database()     # abrir dos veces no rompe nada

    assert {'pedido_tienda_id', 'pedido_tienda_codigo', 'pedido_tienda_intento'} <= columnas(db, 'sales')
    assert {'tienda_json', 'stock_descontado'} <= columnas(db, 'sale_items')
    ventas = db.execute_query("SELECT * FROM sales")
    assert len(ventas) == 3
    assert all(v['pedido_tienda_id'] == '' and v['pedido_tienda_intento'] == '' for v in ventas)
    items = db.execute_query("SELECT * FROM sale_items")
    assert all(i['stock_descontado'] == 0 for i in items)
    indices = {i['name'] for i in db.execute_query("PRAGMA index_list(sales)")}
    assert 'idx_sales_pedido_cobro' in indices and 'idx_sales_pedido_tienda' not in indices


def test_en_la_base_actualizada_se_vende_y_se_cobra_un_pedido(base_vieja):
    from pos_system.database.db_manager import DatabaseManager
    from pos_system.models import pedido_tienda as pt
    from pos_system.models.cash_register import CashRegister
    from pos_system.models.sale import Sale, VentaDePedidoRepetida
    ruta, pid = base_vieja
    db = DatabaseManager(ruta)
    db.initialize_database()
    CashRegister(db).open_register(initial_amount=0)
    ventas = Sale(db)

    comun = ventas.create({'total_amount': 3000, 'payment_type': 'cash', 'cash_received': 3000,
                           'items': [{'product_id': pid, 'product_name': 'CUADERNO', 'quantity': 1, 'unit_price': 3000}]})
    assert db.execute_query("SELECT stock FROM products WHERE id=?", (pid,))[0]['stock'] == 19

    pedido = {'codigo': 'AB12', 'total': 3000, 'items': [{'id': 'X', 'nombre': 'Cuaderno', 'cantidad': 1,
                                                          'precio': 3000, 'subtotal': 3000}]}
    datos = {'total_amount': 3000, 'payment_type': 'transfer', 'items': pt.renglones_de_cobro(pedido, 'p1'),
             'pedido_tienda_id': 'p1', 'pedido_tienda_codigo': 'AB12', 'pedido_tienda_intento': 'i1'}
    cobro = ventas.create(dict(datos))
    with pytest.raises(VentaDePedidoRepetida):
        ventas.create(dict(datos))
    assert cobro != comun
    # Dos ventas comunes sin pedido no chocan con el índice (pedido_tienda_id vacío).
    ventas.create({'total_amount': 3000, 'payment_type': 'cash', 'cash_received': 3000,
                   'items': [{'product_id': pid, 'product_name': 'CUADERNO', 'quantity': 1, 'unit_price': 3000}]})
    assert len(db.execute_query("SELECT id FROM sales")) == 6


def test_el_registro_de_cobros_a_medias_se_crea_en_la_base_vieja(base_vieja):
    from pos_system.database.db_manager import DatabaseManager
    from pos_system.models import cobros_pedido
    ruta, _pid = base_vieja
    db = DatabaseManager(ruta)
    db.initialize_database()
    assert cobros_pedido.pendientes(db) == []
    cobros_pedido.anotar(db, intento='i1', pedido_id='p1', codigo='AB12', pedido={'total': 1},
                         pago={'payment_type': 'cash'}, lineas=[])
    assert len(cobros_pedido.pendientes(db)) == 1
