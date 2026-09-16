"""
Varias cajas sobre el mismo pedido, contra un Firestore de verdad (el emulador).

Las reglas ya están probadas solas en `test_pedido_tienda.py`. Esto prueba lo
que las reglas no pueden: que la transacción relea, que dos PCs que aprietan
el mismo botón al mismo tiempo no dupliquen nada, y que un panel con la versión
vieja no descuente dos veces lo que ya descontó una caja.

Necesita el emulador (Java + firebase-tools). Sin él, se saltea:

    firebase emulators:exec --config pos_system/tests/emulador/firebase.json ^
        --only firestore --project demo-pos-pedidos ^
        "python -m pytest pos_system/tests/test_pedidos_tienda_nube.py -q"

El proyecto `demo-*` no existe en Google: aunque algo saliera mal, no hay forma
de que estas pruebas escriban en la base del local.
"""
import os
import random
import sys
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

EMULADOR = os.environ.get('FIRESTORE_EMULATOR_HOST')
PROYECTO = 'demo-pos-pedidos'

pytestmark = pytest.mark.skipif(not EMULADOR, reason='sin emulador de Firestore')

if EMULADOR:
    from google.auth.credentials import AnonymousCredentials
    from google.cloud import firestore
    from google.cloud.firestore_v1.transaction import transactional

    from pos_system.models import pedido_tienda as reglas
    from pos_system.utils.pedidos_tienda_nube import NubePedidos, EVENTOS, MOVIMIENTOS

TZ = timezone(timedelta(hours=-3))
CAJAS = [{'pc_id': f'CAJA{i}-{i:04d}', 'pc_nombre': f'CAJA{i}', 'cajero': f'Cajero {i}'} for i in range(1, 7)]
SIMULTANEAS = 6


def cliente():
    return firestore.Client(project=PROYECTO, credentials=AnonymousCredentials())


def caja(i, reloj=None):
    """Una PC: su propio cliente de Firestore, su nombre y su reloj."""
    return NubePedidos(cliente(), quien=lambda q=CAJAS[i]: dict(q), reloj=reloj, avisar_cliente=False)


@pytest.fixture(autouse=True)
def base_vacia():
    req = urllib.request.Request(
        f'http://{EMULADOR}/emulator/v1/projects/{PROYECTO}/databases/(default)/documents',
        method='DELETE')
    urllib.request.urlopen(req).close()
    yield


def sembrar(pedido_id, pedido, catalogo):
    db = cliente()
    for pid, datos in catalogo.items():
        db.collection('catalogo').document(pid).set(datos)
    db.collection('tienda_pedidos').document(pedido_id).set(pedido)
    return db


def pedido_base(**extra):
    p = {
        'codigo': 'AB12', 'estado': 'nuevo', 'visto': False, 'impreso': False,
        'entrega': {'modo': 'delivery'}, 'pago': {'modo': 'transferencia'},
        'cliente': {'nombre': 'Ana', 'telefono': '3511234567'},
        'items': [
            {'id': 'GOMA', 'nombre': 'Goma', 'cantidad': 3, 'precio': 500, 'subtotal': 1500},
            {'id': 'CART', 'nombre': 'Cartulina', 'cantidad': 1, 'precio': 9000, 'subtotal': 9000,
             'variedad': 'Rojo', 'es_pack': True, 'pack_contenido': 50},
        ],
        'subtotal': 10500, 'envio': 1500, 'descuento': 0, 'total': 12000,
    }
    p.update(extra)
    return p


CATALOGO = {
    'GOMA': {'nombre': 'GOMA', 'stock': 40},
    'CART': {'nombre': 'CARTULINA', 'es_conjunto': True, 'conjunto_contenido': 50, 'stock': 160,
             'conjunto_colores': [{'color': 'ROJO', 'unidades': 2, 'restante': 10},
                                  {'color': 'AZUL', 'unidades': 1, 'restante': 0}],
             'conjunto_total': 160},
}


def a_la_vez(funciones):
    """Arranca todo junto detrás de una barrera y junta los resultados."""
    barrera = threading.Barrier(len(funciones))
    resultados = [None] * len(funciones)
    errores = []

    def correr(i, fn):
        try:
            barrera.wait()
            resultados[i] = fn()
        except Exception as e:      # noqa: BLE001 - se informa abajo
            errores.append(e)

    hilos = [threading.Thread(target=correr, args=(i, fn)) for i, fn in enumerate(funciones)]
    for h in hilos:
        h.start()
    for h in hilos:
        h.join(60)
    assert not errores, errores
    return resultados


def stock(db):
    goma = db.collection('catalogo').document('GOMA').get().to_dict()
    cart = db.collection('catalogo').document('CART').get().to_dict()
    return goma['stock'], cart['conjunto_total']


def eventos(db, pedido_id, accion=None, resultado='hecho'):
    q = db.collection(EVENTOS).where('pedido_id', '==', pedido_id)
    salida = [d.to_dict() for d in q.stream()]
    return [e for e in salida if (accion is None or e['accion'] == accion)
            and (resultado is None or e.get('resultado') == resultado)]


# ── Aceptar y mover ─────────────────────────────────────────────────────────

def test_seis_cajas_aceptan_el_mismo_pedido_y_gana_una():
    db = sembrar('P1', pedido_base(), CATALOGO)
    r = a_la_vez([lambda i=i: caja(i).mover('P1', 'nuevo', 'preparando') for i in range(SIMULTANEAS)])
    ganadores = [x for x in r if x.ok]
    assert len(ganadores) == 1
    perdedores = [x for x in r if not x.ok]
    assert all('Preparando' in x.rechazo for x in perdedores)
    doc = db.collection('tienda_pedidos').document('P1').get().to_dict()
    assert doc['estado'] == 'preparando'
    assert doc['tomado_por']['pc_id'] in {c['pc_id'] for c in CAJAS}
    assert len(eventos(db, 'P1', 'mover')) == 1
    assert len(eventos(db, 'P1', 'mover', 'rechazado')) == SIMULTANEAS - 1


def test_boton_viejo_no_hace_retroceder():
    db = sembrar('P2', pedido_base(estado='listo'), CATALOGO)
    r = caja(0).mover('P2', 'preparando', 'listo')
    assert not r.ok
    assert db.collection('tienda_pedidos').document('P2').get().to_dict()['estado'] == 'listo'


# ── Entregar: el stock sale una vez ─────────────────────────────────────────

def test_seis_cajas_descuentan_lo_que_entrego_el_repartidor_y_sale_una_vez():
    db = sembrar('P3', pedido_base(estado='entregado', venta_pendiente=True, entregado_por='reparto'), CATALOGO)
    r = a_la_vez([lambda i=i: caja(i).entregar('P3') for i in range(SIMULTANEAS)])
    assert all(x.ok for x in r)
    assert sum(1 for x in r if x.plan is not None) == 1
    goma, cart = stock(db)
    assert goma == 37
    assert cart == 110
    doc = db.collection('tienda_pedidos').document('P3').get().to_dict()
    assert doc['venta_pendiente'] is False and doc['stock_descontado'] is True
    assert doc['cobro_pendiente'] is True and doc['venta_registrada'] is True
    movs = [d.to_dict() for d in db.collection(MOVIMIENTOS).where('pedido_id', '==', 'P3').stream()]
    assert len(movs) == 2
    assert len(eventos(db, 'P3', 'entregar')) == 1


def test_panel_viejo_y_cajas_a_la_vez_no_descuentan_dos_veces():
    """El panel desplegado hoy registra la venta TIENDA mirando solo
    `venta_registrada`. Se reproduce su transacción tal cual para que corra
    contra las cajas nuevas: si alguna vez el stock sale dos veces, es acá."""
    db = sembrar('P4', pedido_base(estado='entregado', venta_pendiente=True), CATALOGO)

    def panel_viejo():
        base = cliente()
        ref = base.collection('tienda_pedidos').document('P4')

        @transactional
        def tx(t):
            pedido = ref.get(transaction=t).to_dict()
            if pedido.get('estado') == 'cancelado':
                return 'cancelado'
            if pedido.get('venta_registrada'):
                t.update(ref, {'estado': 'entregado', 'visto': True, 'venta_pendiente': False})
                return 'ya_estaba'
            cat = {pid: base.collection('catalogo').document(pid).get(transaction=t).to_dict()
                   for pid in ('GOMA', 'CART')}
            plan = reglas.plan_descuento(pedido['items'], cat)
            for p in plan['productos']:
                t.set(base.collection('catalogo').document(p['id']), p['campos'], merge=True)
            t.set(base.collection('ventas').document('TIENDA_AB12'), {'total_amount': 12000})
            t.update(ref, {'venta_registrada': True, 'venta_id': 'TIENDA_AB12', 'stock_descontado': True,
                           'venta_pendiente': False})
            return 'registro'

        # El SDK web reintenta con espera creciente; se imita eso.
        for vuelta in range(6):
            try:
                return tx(base.transaction())
            except ValueError:
                time.sleep(random.uniform(0.05, 0.25) * (2 ** vuelta))
        raise AssertionError('el panel simulado no pudo escribir')

    resultados = a_la_vez([panel_viejo] + [lambda i=i: caja(i).entregar('P4') for i in range(4)])
    goma, cart = stock(db)
    assert goma == 37 and cart == 110
    descuentos = (1 if resultados[0] == 'registro' else 0) + sum(1 for x in resultados[1:] if x.plan is not None)
    assert descuentos == 1


def test_cancelar_y_entregar_a_la_vez_nunca_quedan_los_dos():
    for vuelta in range(4):
        pid = f'P5_{vuelta}'
        db = sembrar(pid, pedido_base(estado='listo'), CATALOGO)
        funciones = [lambda i=i: caja(i).cancelar(pid) if i % 2 else caja(i).entregar(pid) for i in range(SIMULTANEAS)]
        random.shuffle(funciones)
        a_la_vez(funciones)
        doc = db.collection('tienda_pedidos').document(pid).get().to_dict()
        goma, cart = stock(db)
        if doc['estado'] == 'cancelado':
            assert (goma, cart) == (40, 160)
            assert not doc.get('stock_descontado')
        else:
            assert doc['estado'] == 'entregado'
            assert (goma, cart) == (37, 110)
        for p, d in CATALOGO.items():
            db.collection('catalogo').document(p).set(d)


# ── Cobrar: la venta nace una vez ───────────────────────────────────────────

def test_seis_cajas_abren_el_cobro_y_solo_una_puede_cobrar():
    db = sembrar('P6', pedido_base(estado='entregado', stock_descontado=True, venta_registrada=True,
                                   cobro_pendiente=True), CATALOGO)
    cajas = [caja(i) for i in range(SIMULTANEAS)]
    tomas = a_la_vez([lambda c=c: c.tomar_cobro('P6') for c in cajas])
    con_marca = [(c, t) for c, t in zip(cajas, tomas) if t.ok]
    assert len(con_marca) == 1
    assert all(t.motivo == 'ocupado' for t in tomas if not t.ok)

    # Los que no tienen la marca aprietan COBRAR igual (pantalla vieja).
    cobros = a_la_vez([lambda c=c, t=t: c.cobrar('P6', t.intento or 'sin-marca', {'payment_type': 'transfer'})
                       for c, t in zip(cajas, tomas)])
    assert sum(1 for x in cobros if x.ok) == 1
    doc = db.collection('tienda_pedidos').document('P6').get().to_dict()
    assert doc['cobro']['estado'] == 'hecho'
    assert doc['cobro']['pc_id'] == con_marca[0][0]._quien()['pc_id']
    assert doc['cobro_pendiente'] is False
    assert len(eventos(db, 'P6', 'cobrar')) == 1


def test_marca_vencida_tomada_por_otra_caja_la_primera_ya_no_cobra():
    db = sembrar('P7', pedido_base(estado='entregado', stock_descontado=True, venta_registrada=True,
                                   cobro_pendiente=True), CATALOGO)
    ahora = datetime(2026, 9, 16, 18, 0, tzinfo=TZ)
    colgada = caja(0, reloj=lambda: ahora)
    t1 = colgada.tomar_cobro('P7')
    assert t1.ok

    despues = caja(1, reloj=lambda: ahora + timedelta(minutes=reglas.MINUTOS_MARCA + 3))
    sin_preguntar = despues.tomar_cobro('P7')
    assert not sin_preguntar.ok and sin_preguntar.motivo == 'vencida'
    t2 = despues.tomar_cobro('P7', forzar=True)
    assert t2.ok

    assert not colgada.cobrar('P7', t1.intento, {'payment_type': 'cash'}).ok
    assert despues.cobrar('P7', t2.intento, {'payment_type': 'cash'}).ok
    assert not despues.cobrar('P7', t2.intento, {'payment_type': 'cash'}).ok
    assert len(eventos(db, 'P7', 'cobrar')) == 1
    robos = [e for e in eventos(db, 'P7', 'tomar_cobro') if e.get('marca_anterior')]
    assert len(robos) == 1


def test_entregar_y_cobrar_en_el_mostrador_descuenta_y_cobra_juntos():
    db = sembrar('P8', pedido_base(estado='listo', entrega={'modo': 'retiro'}), CATALOGO)
    c = caja(0)
    t = c.tomar_cobro('P8')
    r = c.cobrar('P8', t.intento, {'payment_type': 'cash', 'cash_received': 12000})
    assert r.ok and r.plan is not None
    assert stock(db) == (37, 110)
    doc = db.collection('tienda_pedidos').document('P8').get().to_dict()
    assert doc['estado'] == 'entregado' and doc['cobro']['estado'] == 'hecho'
    assert doc['entregado_por'] == 'pos'
    assert isinstance(doc['entregado_en'], datetime)
    assert c.anotar_venta('P8', t.intento, 321).ok
    assert c.anotar_venta('P8', t.intento, 321).ok
    doc = db.collection('tienda_pedidos').document('P8').get().to_dict()
    assert doc['venta_id'] == f"{CAJAS[0]['pc_id']}_321" and doc['cobro']['venta_local'] == 321
    assert len(eventos(db, 'P8', 'venta_local')) == 1


def test_soltar_el_cobro_lo_deja_libre_para_otra_caja():
    db = sembrar('P9', pedido_base(estado='entregado', stock_descontado=True, venta_registrada=True,
                                   cobro_pendiente=True), CATALOGO)
    t = caja(0).tomar_cobro('P9')
    assert not caja(1).tomar_cobro('P9').ok
    caja(0).soltar_cobro('P9', t.intento)
    assert 'cobro' not in db.collection('tienda_pedidos').document('P9').get().to_dict()
    assert caja(1).tomar_cobro('P9').ok


def test_no_se_cancela_mientras_se_cobra_ni_despues():
    db = sembrar('P10', pedido_base(estado='listo'), CATALOGO)
    t = caja(0).tomar_cobro('P10')
    assert not caja(1).cancelar('P10').ok
    caja(0).cobrar('P10', t.intento, {'payment_type': 'transfer'})
    assert not caja(1).cancelar('P10').ok
    assert db.collection('tienda_pedidos').document('P10').get().to_dict()['estado'] == 'entregado'


# ── Facturar una vez ────────────────────────────────────────────────────────

def test_seis_cajas_facturan_el_mismo_pedido_y_solo_una_puede():
    db = sembrar('P11', pedido_base(estado='entregado', cobro={'estado': 'hecho', **CAJAS[0]}), CATALOGO)
    cajas = [caja(i) for i in range(SIMULTANEAS)]
    tomas = a_la_vez([lambda c=c: c.tomar_factura('P11') for c in cajas])
    assert sum(1 for t in tomas if t.ok) == 1
    ganadora, toma = next((c, t) for c, t in zip(cajas, tomas) if t.ok)
    datos = {'tipo_comprobante': 'FAC. ELEC. C', 'punto_venta': 2, 'nro_comprobante': 77, 'cae': '123', 'total': 12000}
    assert ganadora.anotar_factura('P11', toma.intento, datos).ok
    assert not caja(3).tomar_factura('P11').ok
    doc = db.collection('tienda_pedidos').document('P11').get().to_dict()
    assert doc['factura']['estado'] == 'emitida' and doc['factura']['numero'] == 77
    assert len(eventos(db, 'P11', 'facturar')) == 1


# ── Muchas cajas, muchos pedidos, todo mezclado ─────────────────────────────

def test_mezcla_al_azar_mantiene_las_cuentas():
    """Diez pedidos, seis cajas, cada una haciendo cualquier cosa sobre
    cualquier pedido en cualquier orden. Al final: cada pedido descontó stock a
    lo sumo una vez, se cobró a lo sumo una vez, y nada cancelado tiene stock
    afuera."""
    db = cliente()
    catalogo = {'GOMA': {'nombre': 'GOMA', 'stock': 1000}}
    db.collection('catalogo').document('GOMA').set(catalogo['GOMA'])
    ids = [f'M{i}' for i in range(10)]
    for pid in ids:
        db.collection('tienda_pedidos').document(pid).set(pedido_base(
            codigo=pid, estado=random.choice(['nuevo', 'preparando', 'listo', 'en_camino']),
            items=[{'id': 'GOMA', 'nombre': 'Goma', 'cantidad': 1, 'precio': 100, 'subtotal': 100}],
            subtotal=100, envio=0, total=100))

    def trabajo(i):
        c = caja(i)
        rnd = random.Random(i)
        for _ in range(12):
            pid = rnd.choice(ids)
            accion = rnd.choice(['mover', 'entregar', 'cobrar', 'cancelar'])
            p = c.leer(pid) or {}
            if accion == 'mover' and reglas.siguientes(p):
                destino = reglas.siguientes(p)[0]
                if destino != 'entregado':
                    c.mover(pid, p.get('estado'), destino)
            elif accion == 'entregar':
                c.entregar(pid)
            elif accion == 'cobrar':
                t = c.tomar_cobro(pid)
                if t.ok:
                    c.cobrar(pid, t.intento, {'payment_type': 'cash'})
            else:
                c.cancelar(pid)
        return True

    a_la_vez([lambda i=i: trabajo(i) for i in range(SIMULTANEAS)])

    descontados = 0
    for pid in ids:
        doc = db.collection('tienda_pedidos').document(pid).get().to_dict()
        entregas = eventos(db, pid, 'entregar')
        con_stock = [e for e in entregas if e.get('stock')]
        assert len(con_stock) <= 1, pid
        assert len(eventos(db, pid, 'cobrar')) <= 1, pid
        if doc['estado'] == 'cancelado':
            assert not doc.get('stock_descontado'), pid
            assert not con_stock, pid
        if doc.get('stock_descontado'):
            assert len(con_stock) == 1, pid
            descontados += 1
        movs = [m for m in db.collection(MOVIMIENTOS).where('pedido_id', '==', pid).stream()]
        assert len(movs) == len(con_stock), pid
    goma = db.collection('catalogo').document('GOMA').get().to_dict()['stock']
    assert goma == 1000 - descontados


# ── El vigía: lo que ve la pantalla ─────────────────────────────────────────

_APP = []


def _app():
    """La aplicación de Qt queda guardada: si el recolector la suelta, se lleva
    puestos los timers del vigía."""
    from PyQt5.QtCore import QCoreApplication
    if not _APP:
        _APP.append(QCoreApplication.instance() or QCoreApplication([]))
    return _APP[0]


def esperar(condicion, segundos=20):
    app = _app()
    fin = time.time() + segundos
    while time.time() < fin:
        app.processEvents()
        if condicion():
            return True
        time.sleep(0.05)
    return False


def vigia(i=0, descontar=True):
    from pos_system.utils.pedidos_tienda_watcher import VigiaPedidos
    _app()
    c = caja(i)
    v = VigiaPedidos(c.db, c, descontar_reparto=descontar)
    vistos = {}
    v.cambiaron.connect(lambda pedidos: vistos.update(ultimo=pedidos))
    v.iniciar()
    return v, vistos


def test_el_vigia_junta_lo_que_hace_falta_y_nada_mas():
    db = cliente()
    hoy = reglas.dia_argentina(datetime.now(TZ))
    viejo = reglas.dia_argentina(datetime.now(TZ) - timedelta(days=40))
    pedidos = {
        'N1': pedido_base(estado='nuevo'),
        'L1': pedido_base(estado='listo'),
        'C1': pedido_base(estado='entregado', entregado_dia=viejo, cobro_pendiente=True),
        'H1': pedido_base(estado='entregado', entregado_dia=hoy, cobro={'estado': 'hecho'}),
        'X1': pedido_base(estado='cancelado'),
        'V1': pedido_base(estado='entregado', entregado_dia=viejo, cobro={'estado': 'hecho'}),
    }
    for pid, p in pedidos.items():
        db.collection('tienda_pedidos').document(pid).set(p)
    v, vistos = vigia(descontar=False)
    try:
        esperar(lambda: set((vistos.get('ultimo') or {})) == {'N1', 'L1', 'C1', 'H1'})
        assert set(vistos.get('ultimo') or {}) == {'N1', 'L1', 'C1', 'H1'}
        caja(1).mover('N1', 'nuevo', 'preparando')
        assert esperar(lambda: (vistos['ultimo'].get('N1') or {}).get('estado') == 'preparando')
        caja(1).cancelar('L1')
        assert esperar(lambda: 'L1' not in vistos['ultimo'])
    finally:
        v.detener()


def test_tres_pcs_abiertas_descuentan_lo_del_repartidor_una_sola_vez():
    db = sembrar('R1', pedido_base(estado='listo'), CATALOGO)
    vigias = [vigia(i) for i in range(3)]
    try:
        # El repartidor lo entrega: lo que escribe reparto-mover.
        db.collection('tienda_pedidos').document('R1').update({
            'estado': 'entregado', 'venta_pendiente': True, 'entregado_por': 'reparto',
            'entregado_dia': reglas.dia_argentina(datetime.now(TZ)),
        })
        assert esperar(lambda: db.collection('tienda_pedidos').document('R1').get().to_dict()
                       .get('venta_pendiente') is False, 40)
        assert stock(db) == (37, 110)
        assert all(esperar(lambda vs=vs: (vs.get('ultimo', {}).get('R1') or {}).get('cobro_pendiente') is True)
                   for _v, vs in vigias)
        assert len([e for e in eventos(db, 'R1', 'entregar') if e.get('stock')]) == 1
    finally:
        for v, _ in vigias:
            v.detener()


def test_una_escucha_que_se_cae_vuelve_sola():
    db = sembrar('W1', pedido_base(estado='nuevo'), CATALOGO)
    v, vistos = vigia(descontar=False)
    try:
        assert esperar(lambda: 'W1' in (vistos.get('ultimo') or {}))
        v._escuchas['en_curso'].close()
        v.revisar()
        caja(1).mover('W1', 'nuevo', 'preparando')
        assert esperar(lambda: (vistos['ultimo'].get('W1') or {}).get('estado') == 'preparando')
    finally:
        v.detener()
