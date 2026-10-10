"""
Limpieza de duplicados del arranque: el mismo nombre no alcanza para decir que
es el mismo producto.

2026-10-10: COLLAR INFINITO son tres collares con codigo y precio propios
(987158, 987159, 987160). La limpieza dejaba uno y borraba los otros dos en
cada arranque, asi que en las cajas faltaba el 987160 aunque el panel lo
mostraba bien.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from pos_system.database.db_manager import DatabaseManager


@pytest.fixture
def db(tmp_path):
    database = DatabaseManager(str(tmp_path / 'pos.db'))
    database.initialize_database()
    return database


def _alta(db, nombre, firebase_id, precio=100.0):
    return db.execute_update(
        "INSERT INTO products (name, price, stock, barcode, firebase_id) "
        "VALUES (?, ?, 1, ?, ?)",
        (nombre, precio, firebase_id, firebase_id),
    )


def _codigos(db, nombre):
    rows = db.execute_query(
        "SELECT firebase_id FROM products WHERE name = ? ORDER BY firebase_id",
        (nombre,),
    ) or []
    return [r['firebase_id'] for r in rows]


def test_mismo_nombre_con_codigos_distintos_se_quedan_todos(db):
    for cod, precio in (('987158', 3600), ('987159', 4200), ('987160', 4600)):
        _alta(db, 'COLLAR INFINITO', cod, precio)

    res = db.cleanup_duplicate_products()

    assert res['borrados'] == 0 and res['soft_deleted'] == 0
    assert _codigos(db, 'COLLAR INFINITO') == ['987158', '987159', '987160']


def test_la_copia_sin_codigo_se_borra(db):
    _alta(db, 'COLLAR CHOKER', '987150')
    _alta(db, 'COLLAR CHOKER', '987152')
    db.execute_update(
        "INSERT INTO products (name, price, stock) VALUES ('collar choker', 1, 0)")

    res = db.cleanup_duplicate_products()

    assert res['borrados'] == 1
    assert _codigos(db, 'COLLAR CHOKER') == ['987150', '987152']
    assert not db.execute_query(
        "SELECT 1 FROM products WHERE firebase_id IS NULL AND name LIKE 'collar choker'")


def test_mismo_codigo_repetido_deja_uno(db):
    _alta(db, 'BOTON PERLA', '987676')
    db.execute_update(
        "INSERT INTO products (name, price, stock, firebase_id) "
        "VALUES ('BOTON PERLA', 1, 0, '987676')")

    res = db.cleanup_duplicate_products()

    assert res['borrados'] == 1
    assert _codigos(db, 'BOTON PERLA') == ['987676']


def test_sin_codigo_ninguno_deja_el_mas_nuevo_como_antes(db):
    a = db.execute_update("INSERT INTO products (name, price, stock) VALUES ('GOMA', 1, 0)")
    b = db.execute_update("INSERT INTO products (name, price, stock) VALUES ('GOMA', 1, 0)")

    res = db.cleanup_duplicate_products()

    assert res['borrados'] == 1
    quedan = db.execute_query("SELECT id FROM products WHERE name = 'GOMA'")
    assert [r['id'] for r in quedan] == [max(a, b)]
