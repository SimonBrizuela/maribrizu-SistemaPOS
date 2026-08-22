"""
La cola local de vínculos y el plan que se aplica en la nube, sin Firestore.

    python -m pytest pos_system/tests/test_vinculos_pendientes.py -q
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from pos_system.utils import vinculos_pendientes as vp


class _DB:
    """Lo mínimo de DatabaseManager que usa la cola: una base en memoria."""

    def __init__(self):
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        vp.asegurar_tabla(self.conn.cursor())

    def execute_query(self, sql, params=()):
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def execute_update(self, sql, params=()):
        cur = self.conn.execute(sql, params)
        self.conn.commit()
        return cur.rowcount


def _entradas():
    return [
        {'item_idx': 0, 'target_fid': 'LI6487', 'target_local_id': 12, 'is_conjunto': True,
         'delta': 2.0, 'contexto': 'IMPRESION / FOTOCOPIA A4 (COLOR)'},
        {'item_idx': 1, 'target_fid': '306515', 'target_local_id': 13, 'is_conjunto': True,
         'delta': 1.0, 'contexto': 'IMPRESION / FOTOCOPIA A4 (B/N)'},
        {'item_idx': 2, 'solo_marcar': True, 'contexto': 'LAPIZ'},
    ]


def test_encolar_y_leer_en_orden():
    db = _DB()
    n = vp.encolar(db.conn.cursor(), 40, _entradas())
    db.conn.commit()
    assert n == 3
    filas = vp.pendientes(db)
    assert [f['item_idx'] for f in filas] == [0, 1, 2]
    assert filas[0]['sale_id'] == 40
    assert filas[0]['target_fid'] == 'LI6487'
    assert filas[0]['is_conjunto'] == 1
    assert filas[2]['solo_marcar'] == 1
    assert filas[2]['target_fid'] is None


def test_sin_target_y_sin_marca_no_se_anota():
    db = _DB()
    n = vp.encolar(db.conn.cursor(), 1, [{'item_idx': 0, 'delta': 3}, 'basura', None])
    assert n == 0
    assert vp.pendientes(db) == []


def test_agrupar_por_venta_y_sueltas_por_separado():
    db = _DB()
    cur = db.conn.cursor()
    vp.encolar(cur, 40, _entradas()[:2])
    vp.encolar(cur, None, [{'target_fid': 'X', 'delta': 1, 'is_conjunto': False}])
    vp.encolar(cur, None, [{'target_fid': 'Y', 'delta': 1, 'is_conjunto': False}])
    vp.encolar(cur, 41, _entradas()[:1])
    db.conn.commit()
    grupos = vp.agrupar(vp.pendientes(db))
    assert [(sid, len(g)) for sid, g in grupos] == [(40, 2), (None, 1), (None, 1), (41, 1)]


def test_marcar_subidas_las_saca_de_la_cola():
    db = _DB()
    vp.encolar(db.conn.cursor(), 40, _entradas())
    db.conn.commit()
    ids = [f['id'] for f in vp.pendientes(db)]
    vp.marcar_subidos(db, ids[:2])
    assert [f['id'] for f in vp.pendientes(db)] == ids[2:]


def test_tras_muchos_fallos_la_fila_se_aparta():
    db = _DB()
    vp.encolar(db.conn.cursor(), 40, _entradas()[:1])
    db.conn.commit()
    ids = [f['id'] for f in vp.pendientes(db)]
    for _ in range(vp.MAX_INTENTOS - 1):
        vp.marcar_fallo(db, ids)
    assert len(vp.pendientes(db)) == 1
    vp.marcar_fallo(db, ids)
    assert vp.pendientes(db) == []
    apartadas = db.execute_query("SELECT fb_synced, intentos FROM vinc_pendientes")
    assert apartadas == [{'fb_synced': -1, 'intentos': vp.MAX_INTENTOS}]


def test_planear_descuenta_el_conjunto_del_total_de_la_nube():
    grupo = [
        {'item_idx': 0, 'target_fid': 'P', 'delta': 3.0},
        {'item_idx': 1, 'target_fid': 'P', 'delta': 2.0},   # mismo papel, otra línea
        {'item_idx': 2, 'solo_marcar': 1},
    ]
    # La PC creía otra cosa: manda el número que tiene la nube (536).
    nube = {'P': {'es_conjunto': True, 'conjunto_total': 536, 'conjunto_contenido': 250}}
    plan = vp.planear(grupo, nube)
    assert plan['conjuntos']['P'] == {
        'total': 531.0, 'unidades': 2.0, 'restante': 31.0, 'stock': 531, 'delta': 5.0,
    }
    assert plan['planos'] == {}
    assert plan['saltados'] == []
    # Cada item lleva su propio descuento, y el de sólo-marcar queda vacío.
    assert plan['items'] == {
        0: [{'contexto': '', 'target_id': 'P', 'cantidad': 3.0}],
        1: [{'contexto': '', 'target_id': 'P', 'cantidad': 2.0}],
        2: [],
    }


def test_planear_abre_un_pack_cuando_no_alcanzan_los_sueltos():
    plan = vp.planear([{'item_idx': 0, 'target_fid': 'P', 'delta': 40.0}],
                      {'P': {'es_conjunto': True, 'conjunto_total': 786, 'conjunto_contenido': 250}})
    assert plan['conjuntos']['P']['total'] == 746
    assert (plan['conjuntos']['P']['unidades'], plan['conjuntos']['P']['restante']) == (2.0, 246.0)


def test_planear_plano_servicio_y_faltantes():
    grupo = [
        {'item_idx': 0, 'target_fid': 'PLANO', 'delta': 1.0},
        {'item_idx': 0, 'target_fid': 'SERV', 'delta': 1.0},
        {'item_idx': 0, 'target_fid': 'NADIE', 'delta': 1.0},
        {'item_idx': 0, 'target_fid': 'VAR', 'delta': 1.0},
    ]
    nube = {
        'PLANO': {'stock': 10},
        'SERV':  {'stock': -1, 'stock_ilimitado': True},
        'NADIE': None,
        'VAR':   {'es_conjunto': True, 'conjunto_total': 50, 'conjunto_contenido': 10,
                  'conjunto_colores': [{'color': 'Rojo', 'unidades': 5}]},
    }
    plan = vp.planear(grupo, nube)
    assert plan['planos'] == {'PLANO': 1.0}
    assert plan['conjuntos'] == {}
    assert sorted(plan['saltados']) == [
        ('NADIE', 'no existe en la nube'), ('SERV', 'servicio'), ('VAR', 'tiene variedades'),
    ]
    # El item igual se marca: el descuento local ya pasó.
    assert len(plan['items'][0]) == 4


def test_planear_devolucion_suma():
    plan = vp.planear([{'item_idx': 0, 'target_fid': 'P', 'delta': -10.0}],
                      {'P': {'es_conjunto': True, 'conjunto_total': 536, 'conjunto_contenido': 250}})
    assert plan['conjuntos']['P']['total'] == 546
