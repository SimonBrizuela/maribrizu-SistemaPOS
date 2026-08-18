"""
Que el sync no borre de la caja un producto vivo por una lápida vieja.

    python -m pytest pos_system/tests/test_sync_lapidas.py -q

Los códigos se reciclan, así que una lápida de `catalogo_deleted` puede quedar
apuntando a un producto que hoy es otro. Acá se prueban los dos caminos por los
que el POS borra productos: el listener de lápidas en vivo y la purga por lista
de códigos. Sin red: el catálogo y la base local son dobles.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from pos_system.utils.firebase_sync import FirebaseSync

LAPIDA = datetime(2026, 7, 23, 22, 28, tzinfo=timezone.utc)
DESPUES = LAPIDA + timedelta(days=4)
ANTES = LAPIDA - timedelta(days=4)

# El catálogo del día: Cebitas nació después de la lápida de su código.
CATALOGO = {
    'JUG545000': {'nombre': 'BLISTER DE CEBITAS', 'cod_barra': '987913',
                  'codigo': 'JUG545000', 'precio_venta': 2200,
                  'fecha_creacion': DESPUES, 'ultima_actualizacion': DESPUES},
    '190500000708': {'nombre': 'MEDIA PERLA BLANCA 4MM X METRO',
                     'cod_barra': '987867', 'codigo': '190500000708',
                     'precio_venta': 23800, 'ultima_actualizacion': DESPUES},
    'VIEJO-1': {'nombre': 'PRODUCTO BORRADO DE VERDAD', 'codigo': 'VIEJO-1',
                'precio_venta': 100, 'fecha_creacion': ANTES,
                'ultima_actualizacion': ANTES},
}


# ── Dobles ───────────────────────────────────────────────────────────────────
class _Snap:
    def __init__(self, doc_id, data):
        self.id = doc_id
        self._data = data
        self.exists = data is not None

    def to_dict(self):
        return dict(self._data) if self._data else None


class _Query:
    def __init__(self, docs):
        self._docs = docs

    def limit(self, n):
        return _Query(self._docs[:n])

    def stream(self):
        return iter(self._docs)


class _Coleccion:
    def __init__(self, datos):
        self._datos = datos

    def document(self, doc_id):
        return _Ref(self._datos, doc_id)

    def where(self, campo, _op, valor):
        return _Query([_Snap(k, v) for k, v in self._datos.items()
                       if str(v.get(campo, '')) == str(valor)])

    def stream(self):
        return iter([_Snap(k, v) for k, v in self._datos.items()])


class _Ref:
    def __init__(self, datos, doc_id):
        self._datos = datos
        self._id = doc_id

    def get(self):
        return _Snap(self._id, self._datos.get(self._id))


class _Firestore:
    def __init__(self, catalogo, lapidas=None):
        self._cols = {'catalogo': catalogo, 'catalogo_deleted': lapidas or {}}

    def collection(self, nombre):
        return _Coleccion(self._cols.get(nombre, {}))


class _BaseLocal:
    """Lo mínimo de DatabaseManager que usan los dos caminos."""

    def __init__(self, filas):
        self.filas = list(filas)
        self.borrados = []

    def execute_query(self, sql, params=()):
        if 'SELECT id, firebase_id, barcode FROM products' == sql.strip():
            return [dict(f) for f in self.filas]
        if 'SELECT id FROM products ' in sql and 'firebase_id IS NULL' in sql:
            return []
        if 'SELECT id, firebase_id, barcode FROM products' in sql:
            codigos = set(str(p) for p in params)
            return [f for f in self.filas
                    if str(f.get('firebase_id') or '') in codigos
                    or str(f.get('barcode') or '') in codigos]
        if 'SELECT id FROM products' in sql:
            codigo = str(params[0])
            return [{'id': f['id']} for f in self.filas
                    if str(f.get('firebase_id') or '') == codigo
                    or str(f.get('barcode') or '') == codigo]
        return []

    def hard_delete_products(self, ids):
        ids = list(ids or [])
        self.borrados.extend(ids)
        self.filas = [f for f in self.filas if f['id'] not in ids]
        return len(ids)


def _sync():
    fb = FirebaseSync.__new__(FirebaseSync)
    fb.db = _Firestore(dict(CATALOGO))
    fb.enabled = True
    fb._listeners = []
    return fb


# ── El producto vivo se queda ────────────────────────────────────────────────
def test_lapida_vieja_no_borra_el_producto_que_hoy_usa_ese_codigo():
    assert _sync()._lapida_vigente('JUG545000', LAPIDA) is False


def test_lapida_encuentra_al_producto_aunque_el_codigo_sea_el_de_barras():
    # La lápida es '987867' y el producto vive en el doc '190500000708'.
    assert _sync()._lapida_vigente('987867', LAPIDA) is False


def test_lapida_posterior_al_producto_si_borra():
    assert _sync()._lapida_vigente('VIEJO-1', DESPUES) is True


def test_codigo_que_ya_no_esta_en_el_catalogo_se_borra():
    assert _sync()._lapida_vigente('NO-EXISTE', LAPIDA) is True


def test_si_no_se_puede_consultar_el_catalogo_no_se_borra_nada():
    fb = _sync()

    class _Rota:
        def collection(self, _nombre):
            raise RuntimeError('sin red')

    fb.db = _Rota()
    assert fb._lapida_vigente('JUG545000', LAPIDA) is False


# ── La purga por lista de códigos ────────────────────────────────────────────
def test_la_purga_salva_al_producto_vivo_y_borra_al_fantasma():
    # La purga recibe códigos sueltos, sin fecha: manda el catálogo. Lo que
    # sigue en `catalogo` se queda; lo que no está es un fantasma local.
    fb = _sync()
    base = _BaseLocal([
        {'id': 1, 'firebase_id': 'JUG545000', 'barcode': '987913'},
        {'id': 2, 'firebase_id': 'FANTASMA-9', 'barcode': 'POS9'},
    ])

    out = fb.purge_products_by_codes(base, ['JUG545000', 'FANTASMA-9'])

    assert out['deleted'] == 1
    assert base.borrados == [2]
    assert [f['id'] for f in base.filas] == [1]


def test_la_purga_encuentra_al_producto_por_el_codigo_de_barras():
    # La lista trae '987913' (barras) y el producto vive en 'JUG545000'.
    fb = _sync()
    base = _BaseLocal([{'id': 1, 'firebase_id': 'JUG545000', 'barcode': '987913'}])

    out = fb.purge_products_by_codes(base, ['987913'])

    assert out['deleted'] == 0
    assert base.borrados == []


def test_la_purga_con_lista_larga_usa_una_sola_pasada_del_catalogo():
    fb = _sync()
    base = _BaseLocal([{'id': 1, 'firebase_id': 'JUG545000', 'barcode': '987913'}])
    codigos = ['JUG545000'] + [f'RELLENO-{i}' for i in range(200)]

    out = fb.purge_products_by_codes(base, codigos)

    assert out['deleted'] == 0
    assert base.borrados == []


def test_sin_poder_verificar_la_purga_no_borra():
    fb = _sync()

    class _Rota:
        def collection(self, _nombre):
            raise RuntimeError('sin red')

    fb.db = _Rota()
    base = _BaseLocal([{'id': 1, 'firebase_id': 'JUG545000', 'barcode': '987913'}])

    out = fb.purge_products_by_codes(base, ['JUG545000'])

    assert out['deleted'] == 0
    assert base.borrados == []


# ── Lo que falta en la caja ──────────────────────────────────────────────────
def test_reconcile_avisa_de_los_vendibles_que_no_estan_en_la_pc():
    # La PC tiene Cebitas y nada más: los otros dos del catálogo faltan.
    fb = _sync()
    base = _BaseLocal([{'id': 1, 'firebase_id': 'JUG545000', 'barcode': '987913'}])

    out = fb.reconcile_all_orphans(base)

    assert out['faltantes'] == 2
    assert sorted(out['faltantes_ids']) == ['190500000708', 'VIEJO-1']
    assert out['deleted'] == 0


def test_un_producto_con_lapida_vigente_no_cuenta_como_faltante():
    # VIEJO-1 está borrado de verdad: su doc quedó colgado en el catálogo.
    fb = _sync()
    fb.db = _Firestore(dict(CATALOGO), {'VIEJO-1': {'deleted_at': DESPUES}})
    base = _BaseLocal([{'id': 1, 'firebase_id': 'JUG545000', 'barcode': '987913'}])

    out = fb.reconcile_all_orphans(base)

    assert out['faltantes_ids'] == ['190500000708']


def test_el_producto_sin_precio_no_se_cuenta_como_faltante():
    # El sync los saltea a propósito, así que pedir su alta sería un bucle.
    catalogo = dict(CATALOGO)
    catalogo['SIN-PRECIO'] = {'nombre': 'PRODUCTO A COTIZAR', 'precio_venta': 0,
                              'estado': 'sin_precio',
                              'ultima_actualizacion': DESPUES}
    fb = _sync()
    fb.db = _Firestore(catalogo)
    base = _BaseLocal([{'id': 1, 'firebase_id': 'JUG545000', 'barcode': '987913'}])

    out = fb.reconcile_all_orphans(base)

    assert 'SIN-PRECIO' not in out['faltantes_ids']


def test_el_producto_que_esta_local_por_su_codigo_de_barras_no_es_faltante():
    fb = _sync()
    base = _BaseLocal([
        {'id': 1, 'firebase_id': None, 'barcode': '987913'},
        {'id': 2, 'firebase_id': None, 'barcode': '987867'},
        {'id': 3, 'firebase_id': 'VIEJO-1', 'barcode': None},
    ])

    out = fb.reconcile_all_orphans(base)

    assert out['faltantes'] == 0


# ── El filtro que comparten los tres caminos que borran ──────────────────────
def test_descartar_codigos_vivos_deja_pasar_solo_a_los_fantasmas():
    fb = _sync()

    a_borrar, salvados = fb.descartar_codigos_vivos([
        (1, 'JUG545000'),      # vivo: es Cebitas
        (2, '987867'),         # vivo: el producto vive en otro doc
        (3, 'FANTASMA-9'),     # ya no está en el catálogo
    ])

    assert a_borrar == [(3, 'FANTASMA-9')]
    assert salvados == 2


def test_descartar_codigos_vivos_sin_nada_que_filtrar():
    fb = _sync()
    assert fb.descartar_codigos_vivos([]) == ([], 0)
    assert fb.descartar_codigos_vivos(None) == ([], 0)


def test_descartar_codigos_vivos_sin_red_no_deja_borrar_nada():
    fb = _sync()

    class _Rota:
        def collection(self, _nombre):
            raise RuntimeError('sin red')

    fb.db = _Rota()

    a_borrar, salvados = fb.descartar_codigos_vivos([(1, 'JUG545000'), (2, 'X')])

    assert a_borrar == []
    assert salvados == 2


# ── Un solo delta sync a la vez ──────────────────────────────────────────────
def test_no_arrancan_dos_delta_sync_juntos():
    # Lo lanzan el arranque de la ventana, el reconcile y el sync manual.
    import threading
    from pos_system.utils.firebase_sync import FirebaseSync as FS

    fb = _sync()
    resultados = []
    FS._delta_lock.acquire()          # simula uno ya corriendo
    try:
        listo = threading.Event()
        fb.delta_sync_products_startup(
            _BaseLocal([]), on_done=lambda n: (resultados.append(n), listo.set()))
        assert listo.wait(timeout=5), 'el segundo delta sync se colgó'
    finally:
        FS._delta_lock.release()

    assert resultados == [0]
    # El candado queda libre para el siguiente.
    assert FS._delta_lock.acquire(blocking=False)
    FS._delta_lock.release()


if __name__ == '__main__':
    import pytest
    raise SystemExit(pytest.main([__file__, '-q']))
