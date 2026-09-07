"""
El cartel de "esta PC no está guardando las ventas donde va".

Reproduce el sábado 05/09/2026: caja cerrada el viernes, ninguna abierta el
sábado, y cada PC con una caja vieja marcada como abierta en su SQLite. Ninguna
avisó nada y el día quedó repartido entre tres cierres de otra semana.

Los dos errores del cartel son opuestos: si no sale, se repite el sábado; si
sale de más —todas las noches hay unos segundos entre un cierre y la apertura
siguiente— nadie lo va a mirar cuando importe.
"""
from datetime import datetime, timedelta, timezone

from pos_system.utils.caja_guard import estado_de_caja

AR = timezone(timedelta(hours=-3))


def dt(iso):
    return datetime.fromisoformat(iso)


VIERNES_CIERRE = '2026-09-04T20:29:00-03:00'
SABADO_MANANA = dt('2026-09-05T09:30:00-03:00')


def cerrada(cuando=VIERNES_CIERRE, id_=126):
    return {'id': id_, 'status': 'closed', 'updated_at': cuando}


def abierta(id_=127, cuando='2026-09-07T08:57:00-03:00'):
    return {'id': id_, 'status': 'open', 'opening_date': cuando, 'updated_at': cuando}


def local(id_):
    return {'id': id_, 'status': 'open', 'initial_amount': 30000}


# ── El sábado ────────────────────────────────────────────────────────────────

def test_la_caja_fantasma_del_sabado_avisa():
    e = estado_de_caja(local(123), cerrada(), ahora=SABADO_MANANA)
    assert e is not None
    assert e['tipo'] == 'fantasma'
    assert '123' in e['detalle']
    assert 'Abrí la caja' in e['detalle']


def test_sin_caja_en_ningun_lado_avisa_que_las_ventas_no_suben():
    e = estado_de_caja(None, cerrada(), ahora=SABADO_MANANA)
    assert e['tipo'] == 'sin_caja'
    assert 'no se suben' in e['detalle']


def test_sin_doc_remoto_tambien_avisa():
    e = estado_de_caja(local(123), None, ahora=SABADO_MANANA)
    assert e['tipo'] == 'fantasma'


# ── El cajero no puede abrir una caja ───────────────────────────────────────

def test_al_cajero_se_le_avisa_pero_no_se_le_pide_que_abra():
    e = estado_de_caja(local(123), cerrada(), ahora=SABADO_MANANA, puede_abrir=False)
    assert e['tipo'] == 'fantasma'
    assert 'Avisale al encargado' in e['detalle']
    assert 'Abrí la caja' not in e['detalle']


def test_al_cajero_sin_ninguna_caja_tampoco():
    e = estado_de_caja(None, cerrada(), ahora=SABADO_MANANA, puede_abrir=False)
    assert e['tipo'] == 'sin_caja'
    assert 'Avisale al encargado' in e['detalle']
    assert 'Abrí la caja' not in e['detalle']


def test_reiniciar_el_programa_lo_puede_hacer_cualquiera():
    # Estos dos casos no se arreglan abriendo una caja, así que el texto es el
    # mismo para el cajero y para el admin.
    for puede in (True, False):
        assert 'volvé a abrir el programa' in estado_de_caja(
            local(123), abierta(127), puede_abrir=puede)['detalle']
        assert 'volvé a abrir el programa' in estado_de_caja(
            None, abierta(127), puede_abrir=puede)['detalle']


# ── La rotación de todas las noches ─────────────────────────────────────────

def test_los_segundos_entre_cierre_y_apertura_no_disparan_nada():
    justo = dt('2026-09-04T20:29:20-03:00')
    assert estado_de_caja(local(126), cerrada(), ahora=justo) is None


def test_a_los_quince_minutos_sin_abrir_si_avisa():
    despues = dt('2026-09-04T20:44:00-03:00')
    assert estado_de_caja(local(126), cerrada(), ahora=despues)['tipo'] == 'fantasma'


# ── Con caja abierta ────────────────────────────────────────────────────────

def test_con_la_caja_del_dia_no_dice_nada():
    assert estado_de_caja(local(127), abierta(127)) is None


def test_la_pc_colgada_de_una_caja_vieja():
    e = estado_de_caja(local(123), abierta(127))
    assert e['tipo'] == 'caja_ajena'
    assert e['caja'] == 127
    assert '123' in e['titulo']


def test_la_pc_que_no_tomo_la_caja_abierta():
    e = estado_de_caja(None, abierta(127))
    assert e['tipo'] == 'sin_local'
    assert e['caja'] == 127


# ── Formas en que llegan los datos ──────────────────────────────────────────

def test_acepta_register_id_en_vez_de_id():
    assert estado_de_caja(local(127), {'register_id': '127', 'status': 'open'}) is None


def test_acepta_updated_at_como_datetime():
    e = estado_de_caja(local(126), {'id': 126, 'status': 'closed',
                                    'updated_at': dt(VIERNES_CIERRE)},
                       ahora=SABADO_MANANA)
    assert e['tipo'] == 'fantasma'


def test_una_fecha_ilegible_no_rompe_ni_calla_el_aviso():
    e = estado_de_caja(local(126), {'id': 126, 'status': 'closed', 'updated_at': 'ayer'},
                       ahora=SABADO_MANANA)
    assert e['tipo'] == 'fantasma'


def test_ahora_sin_zona_se_toma_como_hora_argentina():
    e = estado_de_caja(local(123), cerrada(), ahora=datetime(2026, 9, 5, 9, 30))
    assert e['tipo'] == 'fantasma'
