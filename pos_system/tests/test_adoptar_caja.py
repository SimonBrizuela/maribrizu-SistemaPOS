"""
La PC que quedó prendida de noche toma sola la caja nueva.

Reproduce el 23/09/2026: la 141 se cerró a las 20:31, la 142 se abrió desde el
panel a las 20:32, y tres PCs que quedaron prendidas siguieron con la 141. A la
mañana la primera venta de cada una cayó en la caja vieja; recién al reiniciar
el POS tomaron la 142.

Lo que cuidan estas pruebas:
  · la caja nueva se toma sola, sin reiniciar;
  · al tomarla se cierra la vieja: dos abiertas a la vez dejan que la próxima
    venta vaya a parar a cualquiera de las dos;
  · nunca hacia atrás: una caja local más nueva que la de Firebase es de esta
    PC y todavía no subió, y no se toca.
"""
import pytest

from pos_system.database.db_manager import DatabaseManager
from pos_system.utils.caja_guard import caja_a_adoptar, estado_de_caja
from pos_system.utils.firebase_sync import FirebaseSync


def abierta(id_):
    return {'id': id_, 'status': 'open', 'opening_date': '2026-09-22T20:32:06-03:00',
            'initial_amount': 30000}


# ── La decisión ──────────────────────────────────────────────────────────────
def test_la_pc_con_la_caja_de_ayer_toma_la_nueva():
    assert caja_a_adoptar({'id': 141}, abierta(142)) == 142


def test_la_pc_sin_caja_toma_la_abierta():
    assert caja_a_adoptar(None, abierta(142)) == 142


def test_con_la_misma_caja_no_hay_nada_que_tomar():
    assert caja_a_adoptar({'id': 142}, abierta(142)) is None


def test_nunca_hacia_atras_una_remota_atrasada_no_pisa_la_local():
    assert caja_a_adoptar({'id': 143}, abierta(142)) is None


def test_sin_caja_abierta_en_firebase_no_toma_nada():
    assert caja_a_adoptar({'id': 141}, {'id': 141, 'status': 'closed'}) is None
    assert caja_a_adoptar({'id': 141}, None) is None


# ── Contra la SQLite de verdad ───────────────────────────────────────────────
@pytest.fixture
def db(tmp_path):
    base = DatabaseManager(str(tmp_path / 'caja.db'))
    base.initialize_database()
    # La 141 abierta desde ayer, con el formato que deja el listener.
    base.execute_update(
        "INSERT INTO cash_register (id, initial_amount, opening_date, status, notes) "
        "VALUES (141, 30000, '2026-09-22T09:02:09', 'open', '')"
    )
    return base


def _sync():
    fb = FirebaseSync.__new__(FirebaseSync)
    fb.enabled = True
    fb._listeners = []
    return fb


def _abiertas(db):
    return [r['id'] for r in db.execute_query(
        "SELECT id FROM cash_register WHERE status = 'open' ORDER BY id")]


def test_al_tomar_la_nueva_se_cierra_la_vieja(db):
    assert _sync()._create_local_register_from_data(db, abierta(142)) == 142
    assert _abiertas(db) == [142]
    assert db.get_current_cash_register()['id'] == 142


def test_si_ya_estaban_las_dos_abiertas_queda_solo_la_nueva(db):
    # El listener de la versión anterior creaba la nueva sin cerrar la vieja.
    db.execute_update(
        "INSERT INTO cash_register (id, initial_amount, opening_date, status, notes) "
        "VALUES (142, 30000, '2026-09-22 20:32:06', 'open', '')"
    )
    assert _sync()._create_local_register_from_data(db, abierta(142)) == 142
    assert _abiertas(db) == [142]


def test_una_caja_local_mas_nueva_no_se_cierra(db):
    db.execute_update(
        "INSERT INTO cash_register (id, initial_amount, opening_date, status, notes) "
        "VALUES (143, 30000, '2026-09-23T08:00:00', 'open', '')"
    )
    _sync()._create_local_register_from_data(db, abierta(142))
    assert 143 in _abiertas(db)


def test_despues_de_tomarla_el_cartel_se_baja(db):
    fb = _sync()
    remoto = abierta(142)
    assert estado_de_caja(db.get_current_cash_register(), remoto)['tipo'] == 'caja_ajena'
    assert caja_a_adoptar(db.get_current_cash_register(), remoto) == 142
    fb._create_local_register_from_data(db, remoto)
    assert estado_de_caja(db.get_current_cash_register(), remoto) is None
