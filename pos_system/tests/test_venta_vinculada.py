"""
Una impresión vendida descuenta el papel y deja el descuento en cola.

    python -m pytest pos_system/tests/test_venta_vinculada.py -q

De punta a punta contra una base SQLite de verdad: la venta entra por
`Sale.create`, el papel (un conjunto de 250 hojas por pack) baja en la misma
transacción, abre un pack solo cuando las sueltas no alcanzan, el stock propio
de la impresión no se toca, y `vinc_pendientes` queda con la fila que después
sube a Firestore. Sin red: Firebase no está inicializado y el push se saltea.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.sale import Sale
from pos_system.utils import vinculos_pendientes as vp


def _base(tmp_path):
    db = DatabaseManager(str(tmp_path / 'pos.db'))
    db.initialize_database()
    with db.get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO products
               (name, price, stock, firebase_id, es_conjunto, conjunto_contenido,
                conjunto_unidades, conjunto_restante, conjunto_total, stock_ilimitado)
               VALUES (?, ?, ?, ?, 1, 250, 2, 36, 536, 0)""",
            ('PAPEL ILUSTRACION A4 200 GR', 90000, 536, 'P250'))
        papel_id = cur.lastrowid
        cur.execute(
            """INSERT INTO products (name, price, stock, firebase_id, vinculaciones, stock_ilimitado)
               VALUES (?, ?, 0, ?, ?, 0)""",
            ('IMPRESION A4 ILUSTRACION 200 GR (COLOR)', 800, 'IMP',
             json.dumps([{'doc_id': 'P250', 'cantidad': 1, 'nombre': 'PAPEL'}])))
        imp_id = cur.lastrowid
    return db, papel_id, imp_id


def _producto(db, pid):
    return db.execute_query("SELECT * FROM products WHERE id = ?", (pid,))[0]


def _vender(db, imp_id, cantidad):
    return Sale(db).create({
        'items': [{'product_id': imp_id, 'product_name': 'IMPRESION A4 ILUSTRACION 200 GR (COLOR)',
                   'quantity': cantidad, 'unit_price': 800}],
        'payment_type': 'cash',
        'total_amount': 800 * cantidad,
        'cash_received': 800 * cantidad,
    })


def test_la_impresion_descuenta_el_papel_y_abre_un_pack(tmp_path):
    db, papel_id, imp_id = _base(tmp_path)
    sale_id = _vender(db, imp_id, 40)

    papel = _producto(db, papel_id)
    # 536 - 40 = 496: se fueron las 36 sueltas y se abrió un pack (1 cerrado + 246).
    assert papel['conjunto_total'] == 496
    assert (papel['conjunto_unidades'], papel['conjunto_restante']) == (1, 246)
    assert papel['stock'] == 496
    # El stock propio de la impresión no se toca: vive en el papel.
    assert _producto(db, imp_id)['stock'] == 0

    filas = vp.pendientes(db)
    assert len(filas) == 1
    f = filas[0]
    assert (f['sale_id'], f['item_idx'], f['target_fid']) == (sale_id, 0, 'P250')
    assert (f['is_conjunto'], f['delta'], f['solo_marcar']) == (1, 40.0, 0)
    assert f['target_local_id'] == papel_id
    assert f['contexto'] == 'IMPRESION A4 ILUSTRACION 200 GR (COLOR)'

    movs = db.execute_query(
        "SELECT motivo, cantidad, stock_antes, stock_despues FROM stock_movimientos "
        "WHERE firebase_id = 'P250'")
    assert movs == [{'motivo': 'vinculacion', 'cantidad': -40.0, 'stock_antes': 536.0, 'stock_despues': 496.0}]


def test_la_cola_se_aplica_sobre_el_numero_de_la_nube(tmp_path):
    db, papel_id, imp_id = _base(tmp_path)
    _vender(db, imp_id, 3)
    _vender(db, imp_id, 2)
    grupos = vp.agrupar(vp.pendientes(db))
    assert len(grupos) == 2
    # La nube ya tenía 30 menos (lo vendió otra PC): se descuenta de ahí, no
    # del 536 - 5 que cree esta PC.
    nube = {'P250': {'es_conjunto': True, 'conjunto_total': 506, 'conjunto_contenido': 250}}
    plan = vp.planear(grupos[0][1], nube)
    assert plan['conjuntos']['P250']['total'] == 503
    assert plan['items'] == {0: [{'contexto': 'IMPRESION A4 ILUSTRACION 200 GR (COLOR)',
                                 'target_id': 'P250', 'cantidad': 3.0}]}


def test_descontar_sin_venta_encola_sin_sale_id(tmp_path):
    db, papel_id, imp_id = _base(tmp_path)
    item = {'product_id': imp_id, 'product_name': 'IMPRESION A4 ILUSTRACION 200 GR (COLOR)',
            'quantity': 5, 'unit_price': 800}
    Sale(db).descontar_stock_items([item], usuario='Anita', motivo='fiado', referencia='Fiado #1')
    assert _producto(db, papel_id)['conjunto_total'] == 531
    filas = vp.pendientes(db)
    assert len(filas) == 1 and filas[0]['sale_id'] is None and filas[0]['delta'] == 5.0
    assert vp.agrupar(filas)[0][0] is None

    # Lo que se quita del fiado vuelve: delta negativo en la cola.
    Sale(db).reponer_stock_items([item], usuario='Anita')
    assert _producto(db, papel_id)['conjunto_total'] == 536
    filas = vp.pendientes(db)
    assert [f['delta'] for f in filas] == [5.0, -5.0]
    plan = vp.planear([filas[1]], {'P250': {'es_conjunto': True, 'conjunto_total': 531, 'conjunto_contenido': 250}})
    assert plan['conjuntos']['P250']['total'] == 536


def test_una_linea_ya_descontada_solo_se_marca(tmp_path):
    db, papel_id, imp_id = _base(tmp_path)
    sale_id = Sale(db).create({
        'items': [{'product_id': imp_id, 'product_name': 'IMPRESION A4 ILUSTRACION 200 GR (COLOR)',
                   'quantity': 4, 'unit_price': 800, 'stock_descontado': True}],
        'payment_type': 'cash', 'total_amount': 3200, 'cash_received': 3200,
    })
    # Ya había salido el día del fiado: el papel no se mueve otra vez.
    assert _producto(db, papel_id)['conjunto_total'] == 536
    filas = vp.pendientes(db)
    assert len(filas) == 1
    assert (filas[0]['sale_id'], filas[0]['solo_marcar'], filas[0]['target_fid']) == (sale_id, 1, None)
    plan = vp.planear(filas, {})
    assert plan['items'] == {0: []} and plan['conjuntos'] == {} and plan['planos'] == {}
