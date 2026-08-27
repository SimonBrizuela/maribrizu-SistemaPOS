"""
Vender un conjunto mueve los DOS contadores de stock, no uno solo.

    python -m pytest pos_system/tests/test_venta_conjunto_stock.py -q

Un producto conjunto guarda la misma mercaderia en dos lugares:

    conjunto_total = packs cerrados x contenido + sueltas    <- lo que mueve la venta
    stock                                                    <- el numero plano

El POS, la tienda y las alertas leen el primero, asi que la caja nunca estuvo
mal. Pero la venta directa de un conjunto movia solo ese y dejaba el `stock`
congelado en el numero del dia que se cargo el producto, y la brecha crecia con
cada venta: 453 de 1.198 conjuntos habian llegado a diferir en 17.630 unidades.
De yapa, `diag_movimientos.py --sospechosos` compara el ultimo movimiento
(que se anota contra `conjunto_total`) con el campo `stock`, y marcaba 418
productos como "cambiados por fuera del registro" sin que nadie los tocara.

La venta por vinculacion (una impresion que consume papel) ya los escribia
juntos -- eso lo cubre `test_venta_vinculada.py`. Lo que faltaba era la venta
directa, que es la de este archivo.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.sale import Sale


def _db(tmp_path):
    db = DatabaseManager(str(tmp_path / 'pos.db'))
    db.initialize_database()
    return db


def _alta_conjunto(db, *, contenido, unidades, restante, colores=None,
                   ilimitado=0, nombre='BOLIGRAFO BIC 1 MM TRAZO GRUESO'):
    """Da de alta un conjunto con el `stock` ya cuadrado con su total."""
    total = unidades * contenido + restante
    with db.get_connection() as conn:
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO products
               (name, price, stock, firebase_id, es_conjunto, conjunto_contenido,
                conjunto_unidades, conjunto_restante, conjunto_total,
                conjunto_colores, stock_ilimitado)
               VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)""",
            (nombre, 44200, total, 'BIC1MM', contenido, unidades, restante,
             total, json.dumps(colores) if colores else None, ilimitado))
        return cur.lastrowid


def _producto(db, pid):
    return db.execute_query("SELECT * FROM products WHERE id = ?", (pid,))[0]


def _vender_conjunto(db, pid, *, after_u, after_r, color='', cantidad=1,
                     nombre='BOLIGRAFO BIC 1 MM TRAZO GRUESO'):
    """Vende un conjunto como lo manda el dialogo: con el estado ya resuelto."""
    item = {
        'product_id': pid, 'product_name': nombre,
        'quantity': cantidad, 'unit_price': 1000,
        'is_conjunto': True,
        'conjunto_after_unidades': after_u,
        'conjunto_after_restante': after_r,
    }
    if color:
        item['conjunto_color'] = color
    return Sale(db).create({
        'items': [item], 'payment_type': 'cash',
        'total_amount': 1000 * cantidad, 'cash_received': 1000 * cantidad,
    })


# --------------------------------------------------------------------------
# Conjunto sin variedades
# --------------------------------------------------------------------------

def test_vender_un_conjunto_baja_los_dos_contadores(tmp_path):
    db = _db(tmp_path)
    # 6 packs de 50 y 9 sueltas = 309.
    pid = _alta_conjunto(db, contenido=50, unidades=6, restante=9)
    assert _producto(db, pid)['stock'] == 309

    # Se vende una unidad: quedan 6 packs y 8 sueltas = 308.
    _vender_conjunto(db, pid, after_u=6, after_r=8)

    p = _producto(db, pid)
    assert p['conjunto_total'] == 308
    assert p['stock'] == 308, 'el stock plano quedo con el numero viejo'


def test_abrir_un_pack_deja_los_dos_iguales(tmp_path):
    db = _db(tmp_path)
    # 2 packs de 50 y 3 sueltas = 103. Vender 4 abre un pack: 1 y 49 = 99.
    pid = _alta_conjunto(db, contenido=50, unidades=2, restante=3)
    _vender_conjunto(db, pid, after_u=1, after_r=49, cantidad=4)

    p = _producto(db, pid)
    assert (p['conjunto_unidades'], p['conjunto_restante']) == (1, 49)
    assert p['conjunto_total'] == 99
    assert p['stock'] == 99


def test_muchas_ventas_seguidas_no_abren_brecha(tmp_path):
    """El escenario que dejo 453 conjuntos descuadrados: venta tras venta."""
    db = _db(tmp_path)
    pid = _alta_conjunto(db, contenido=50, unidades=3, restante=10)

    unidades, restante = 3, 10
    for _ in range(30):
        if restante > 0:
            restante -= 1
        else:
            unidades -= 1
            restante = 49
        _vender_conjunto(db, pid, after_u=unidades, after_r=restante)
        p = _producto(db, pid)
        assert p['stock'] == p['conjunto_total'], 'los contadores se separaron'

    assert _producto(db, pid)['conjunto_total'] == 160 - 30


# --------------------------------------------------------------------------
# Conjunto con variedades (el caso de los boligrafos)
# --------------------------------------------------------------------------

COLORES = [
    {'color': 'Azul',  'unidades': 12, 'restante': 2},
    {'color': 'Roja',  'unidades': 2,  'restante': 15},
    {'color': 'Verde', 'unidades': 2,  'restante': 28},
    {'color': 'Negra', 'unidades': 8,  'restante': 20},
]


def test_vender_una_variedad_cuadra_el_stock_con_la_suma(tmp_path):
    db = _db(tmp_path)
    # 12x50+2 + 2x50+15 + 2x50+28 + 8x50+20 = 602+115+128+420 = 1265
    pid = _alta_conjunto(db, contenido=50, unidades=24, restante=65,
                         colores=[dict(c) for c in COLORES])
    assert _producto(db, pid)['stock'] == 1265

    # Se vende un Azul: 12 packs y 1 suelta.
    _vender_conjunto(db, pid, after_u=12, after_r=1, color='Azul')

    p = _producto(db, pid)
    assert p['conjunto_total'] == 1264
    assert p['stock'] == 1264
    colores = json.loads(p['conjunto_colores'])
    azul = next(c for c in colores if c['color'] == 'Azul')
    assert (azul['unidades'], azul['restante']) == (12, 1)
    # Las otras variedades quedan intactas.
    assert next(c for c in colores if c['color'] == 'Negra')['restante'] == 20


def test_el_stock_sigue_a_la_suma_de_todas_las_variedades(tmp_path):
    db = _db(tmp_path)
    pid = _alta_conjunto(db, contenido=50, unidades=24, restante=65,
                         colores=[dict(c) for c in COLORES])

    _vender_conjunto(db, pid, after_u=2, after_r=10, color='Roja')

    p = _producto(db, pid)
    suma = sum(c['unidades'] * 50 + c['restante']
               for c in json.loads(p['conjunto_colores']))
    assert p['conjunto_total'] == suma
    assert p['stock'] == suma


# --------------------------------------------------------------------------
# Lo que NO hay que tocar
# --------------------------------------------------------------------------

def test_un_conjunto_ilimitado_no_se_toca_el_stock(tmp_path):
    """Un servicio no lleva control de stock: lo dice la bandera, no el numero."""
    db = _db(tmp_path)
    pid = _alta_conjunto(db, contenido=50, unidades=6, restante=9, ilimitado=1,
                         nombre='IMPRESION A4 (COLOR)')
    antes = _producto(db, pid)['stock']

    _vender_conjunto(db, pid, after_u=6, after_r=8, nombre='IMPRESION A4 (COLOR)')

    assert _producto(db, pid)['stock'] == antes


def test_el_stock_nunca_queda_negativo(tmp_path):
    db = _db(tmp_path)
    pid = _alta_conjunto(db, contenido=50, unidades=0, restante=1)
    _vender_conjunto(db, pid, after_u=0, after_r=0)

    p = _producto(db, pid)
    assert p['stock'] == 0
    assert p['conjunto_total'] == 0


def test_el_ledger_sigue_anotando_el_movimiento(tmp_path):
    db = _db(tmp_path)
    pid = _alta_conjunto(db, contenido=50, unidades=6, restante=9)
    _vender_conjunto(db, pid, after_u=6, after_r=8)

    movs = db.execute_query(
        "SELECT motivo, cantidad, stock_antes, stock_despues "
        "FROM stock_movimientos WHERE producto_id = ?", (pid,))
    assert len(movs) == 1
    assert movs[0]['motivo'] == 'venta'
    assert movs[0]['cantidad'] == -1.0
    assert (movs[0]['stock_antes'], movs[0]['stock_despues']) == (309.0, 308.0)


def test_el_movimiento_del_ledger_coincide_con_el_stock_guardado(tmp_path):
    """La razon de ser del fix: `--sospechosos` compara estos dos numeros.

    Antes el ledger dejaba 308 y el campo `stock` seguia en 309, y el
    diagnostico lo leia como un cambio hecho por fuera del registro.
    """
    db = _db(tmp_path)
    pid = _alta_conjunto(db, contenido=50, unidades=6, restante=9)
    _vender_conjunto(db, pid, after_u=6, after_r=8)

    ultimo = db.execute_query(
        "SELECT stock_despues FROM stock_movimientos "
        "WHERE producto_id = ? ORDER BY id DESC LIMIT 1", (pid,))[0]
    assert _producto(db, pid)['stock'] == ultimo['stock_despues']


if __name__ == '__main__':
    import tempfile
    import pathlib
    fallos = 0
    for nombre, fn in sorted(globals().items()):
        if not nombre.startswith('test_') or not callable(fn):
            continue
        with tempfile.TemporaryDirectory() as d:
            try:
                fn(pathlib.Path(d))
                print(f'  ok   {nombre}')
            except AssertionError as e:
                fallos += 1
                print(f'  FALLA {nombre}: {e}')
    print(f'\n{fallos} fallas' if fallos else '\nTodo en verde')
    sys.exit(1 if fallos else 0)
