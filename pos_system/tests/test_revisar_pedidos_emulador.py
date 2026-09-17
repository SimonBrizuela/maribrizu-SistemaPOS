"""
Los arreglos de `scripts/revisar_pedidos_tienda.py` contra un Firestore de
verdad (el emulador). Mismo requisito y mismo comando que
`test_pedidos_tienda_nube.py`; sin emulador se saltea.

Lo que se exige de cada arreglo: que el simulacro no escriba nada, que con
--aplicar deje copia antes, que quede anotado en el registro, y que después la
revisión ya no encuentre el problema.
"""
import os
import sys
import urllib.request
from datetime import datetime, timedelta

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

EMULADOR = os.environ.get('FIRESTORE_EMULATOR_HOST')
PROYECTO = 'demo-pos-pedidos'
pytestmark = pytest.mark.skipif(not EMULADOR, reason='sin emulador de Firestore')

if EMULADOR:
    from google.auth.credentials import AnonymousCredentials
    from google.cloud import firestore

    from pos_system.models import pedido_tienda as reglas
    from pos_system.utils.pedidos_tienda_nube import NubePedidos
    from scripts import revisar_pedidos_tienda as rev

CAJA = {'pc_id': 'CAJA1-0001', 'pc_nombre': 'CAJA1', 'cajero': 'Mari'}


def cliente():
    return firestore.Client(project=PROYECTO, credentials=AnonymousCredentials())


@pytest.fixture(autouse=True)
def base_vacia():
    req = urllib.request.Request(
        f'http://{EMULADOR}/emulator/v1/projects/{PROYECTO}/databases/(default)/documents', method='DELETE')
    urllib.request.urlopen(req).close()
    yield


@pytest.fixture
def db():
    base = cliente()
    base.collection('catalogo').document('GOMA').set({'nombre': 'GOMA', 'stock': 40})
    return base


def sembrar(db, pid='P1', **extra):
    p = {'codigo': 'AB12', 'estado': 'listo', 'creado': datetime.now(reglas.TZ_AR),
         'entrega': {'modo': 'retiro'}, 'pago': {'modo': 'transferencia'}, 'cliente': {'nombre': 'Ana'},
         'items': [{'id': 'GOMA', 'nombre': 'Goma', 'cantidad': 3, 'precio': 500, 'subtotal': 1500}],
         'subtotal': 1500, 'envio': 0, 'total': 1500}
    p.update(extra)
    db.collection('tienda_pedidos').document(pid).set(p)
    return pid


def stock(db):
    return db.collection('catalogo').document('GOMA').get().to_dict()['stock']


def pedido(db, pid='P1'):
    return db.collection('tienda_pedidos').document(pid).get().to_dict()


def problemas(db):
    datos = rev.leer(db, datetime.now(reglas.TZ_AR) - timedelta(days=7))
    return [p['tipo'] for p in rev.revisar(*datos, datetime.now(reglas.TZ_AR))]


def duplicar_descuento(db, pid='P1', intento='dup0000000000001'):
    """Lo que dejaría un descuento repetido: stock abajo otra vez y sus
    movimientos con otro intento."""
    db.collection('catalogo').document('GOMA').update({'stock': firestore.Increment(-3)})
    db.collection('stock_movimientos').document(f'tienda_{pid}_{intento}_0').set({
        'pedido_id': pid, 'intento': intento, 'motivo': 'venta', 'origen': 'webapp', 'pc_id': 'webapp',
        'cantidad': -3, 'firebase_id': 'GOMA', 'producto_nombre': 'GOMA',
        'ts': datetime.now(reglas.TZ_AR), 'referencia': 'Pedido tienda AB12'})
    return intento


def test_devolver_un_descuento_repetido(db, tmp_path):
    pid = sembrar(db)
    NubePedidos(db, quien=lambda: dict(CAJA), avisar_cliente=False).entregar(pid)
    assert stock(db) == 37
    dup = duplicar_descuento(db)
    assert stock(db) == 34
    assert 'stock_duplicado' in problemas(db)

    texto = rev.arreglar(db, 'devolver-stock', 'AB12', aplicar=False, intento_a_revertir=dup,
                         carpeta_copias=str(tmp_path))
    assert texto.startswith('(simulacro)') and 'GOMA +3' in texto
    assert stock(db) == 34
    assert not list(tmp_path.iterdir())

    rev.arreglar(db, 'devolver-stock', 'AB12', aplicar=True, intento_a_revertir=dup, carpeta_copias=str(tmp_path))
    assert stock(db) == 37
    assert 'stock_duplicado' not in problemas(db)
    assert len(list(tmp_path.iterdir())) == 1
    ev = [d.to_dict() for d in db.collection('tienda_pedidos_eventos').stream()
          if d.to_dict().get('accion') == 'devolver_stock']
    assert ev and ev[0]['revierte_intento'] == dup and ev[0]['origen'] == 'script'
    # Dos veces no devuelve dos veces.
    assert 'ya se devolvió' in rev.arreglar(db, 'devolver-stock', 'AB12', aplicar=True, intento_a_revertir=dup,
                                           carpeta_copias=str(tmp_path))
    assert stock(db) == 37


def test_el_unico_descuento_solo_se_devuelve_reabriendo_la_entrega(db, tmp_path):
    pid = sembrar(db)
    r = NubePedidos(db, quien=lambda: dict(CAJA), avisar_cliente=False).entregar(pid)
    intento = r.intento
    texto = rev.arreglar(db, 'devolver-stock', 'AB12', aplicar=True, intento_a_revertir=intento,
                         carpeta_copias=str(tmp_path))
    assert '--reabrir-entrega' in texto
    assert stock(db) == 37
    rev.arreglar(db, 'devolver-stock', 'AB12', aplicar=True, intento_a_revertir=intento,
                 reabrir_entrega=True, carpeta_copias=str(tmp_path))
    assert stock(db) == 40
    p = pedido(db)
    assert p['estado'] == 'listo' and p['stock_descontado'] is False and p['cobro_pendiente'] is False
    assert 'entregado_en' not in p


def test_soltar_un_cobro_trabado(db, tmp_path):
    sembrar(db, estado='entregado', stock_descontado=True, venta_registrada=True, cobro_pendiente=True,
            cobro={'estado': 'en_curso', **CAJA, 'desde': datetime.now(reglas.TZ_AR) - timedelta(hours=1)})
    assert 'cobro_trabado' in problemas(db)
    rev.arreglar(db, 'soltar-cobro', 'AB12', aplicar=False, carpeta_copias=str(tmp_path))
    assert 'cobro' in pedido(db)
    rev.arreglar(db, 'soltar-cobro', 'AB12', aplicar=True, carpeta_copias=str(tmp_path))
    assert 'cobro' not in pedido(db)
    assert 'cobro_trabado' not in problemas(db)


def test_reabrir_un_cobro_y_anular_su_venta(db, tmp_path):
    pid = sembrar(db, estado='entregado', stock_descontado=True, venta_registrada=True, cobro_pendiente=False,
                  venta_id='CAJA1-0001_57', cobro={'estado': 'hecho', **CAJA, 'en': datetime.now(reglas.TZ_AR)})
    db.collection('ventas').document('CAJA1-0001_57').set({'pedido_id': pid, 'pc_id': 'CAJA1-0001', 'sale_id': 57, 'total_amount': 1500})
    db.collection('ventas_por_dia').document('CAJA1-0001_57_0').set({'num_venta': 57, 'subtotal': 1500})
    db.collection('ventas_por_dia').document('OTRAPC_57_0').set({'num_venta': 57, 'subtotal': 900})
    texto = rev.arreglar(db, 'reabrir-cobro', 'AB12', aplicar=True, anular_venta='CAJA1-0001_57',
                         carpeta_copias=str(tmp_path))
    assert 'base local' in texto
    p = pedido(db)
    assert p['cobro_pendiente'] is True and 'cobro' not in p and 'venta_id' not in p
    assert db.collection('ventas').document('CAJA1-0001_57').get().to_dict()['deleted'] is True
    # Los renglones salen de los cierres; los de otra PC con el mismo número, no.
    assert db.collection('ventas_por_dia').document('CAJA1-0001_57_0').get().to_dict()['deleted'] is True
    assert 'deleted' not in db.collection('ventas_por_dia').document('OTRAPC_57_0').get().to_dict()
    assert stock(db) == 40


def test_no_anula_una_venta_de_otro_pedido(db, tmp_path):
    sembrar(db, estado='entregado', cobro={'estado': 'hecho', **CAJA}, venta_id='CAJA1-0001_57')
    db.collection('ventas').document('OTRA_1').set({'pedido_id': 'OTRO'})
    texto = rev.arreglar(db, 'reabrir-cobro', 'AB12', aplicar=True, anular_venta='OTRA_1', carpeta_copias=str(tmp_path))
    assert 'no es de este pedido' in texto
    assert reglas.cobrado(pedido(db))


def test_descontar_lo_del_repartidor_sin_cajas_prendidas(db, tmp_path):
    sembrar(db, estado='entregado', venta_pendiente=True, entregado_por='reparto',
            entregado_en=datetime.now(reglas.TZ_AR) - timedelta(hours=2))
    assert 'reparto_sin_descontar' in problemas(db)
    rev.arreglar(db, 'descontar-pendiente', 'AB12', aplicar=True, carpeta_copias=str(tmp_path))
    assert stock(db) == 37
    assert pedido(db)['cobro_pendiente'] is True
    assert problemas(db) == []


def test_leer_encuentra_lo_viejo_del_panel(db):
    pid = sembrar(db, estado='entregado', venta_registrada=True, venta_id='TIENDA_AB12', stock_descontado=True)
    db.collection('ventas').document('TIENDA_AB12').set({'pc_id': 'TIENDA', 'total_amount': 1500})
    db.collection('stock_movimientos').document('viejo1').set({
        'referencia': 'Pedido tienda AB12', 'motivo': 'venta', 'cantidad': -3, 'origen': 'webapp'})
    pedidos, _ev, movs, ventas, _f = rev.leer(db, datetime.now(reglas.TZ_AR) - timedelta(days=1))
    assert pid in pedidos
    assert any(m['id'] == 'viejo1' and m['pedido_id'] == pid for m in movs)
    assert any(v['id'] == 'TIENDA_AB12' for v in ventas)


def test_reabrir_la_entrega_con_un_descuento_repetido_vivo_se_niega(db, tmp_path):
    pid = sembrar(db)
    r = NubePedidos(db, quien=lambda: dict(CAJA), avisar_cliente=False).entregar(pid)
    dup = duplicar_descuento(db)
    texto = rev.arreglar(db, 'devolver-stock', 'AB12', aplicar=True, intento_a_revertir=r.intento,
                         reabrir_entrega=True, carpeta_copias=str(tmp_path))
    assert 'descuentos activos' in texto
    assert stock(db) == 34 and pedido(db)['estado'] == 'entregado'
    # Primero el repetido, después la entrega.
    rev.arreglar(db, 'devolver-stock', 'AB12', aplicar=True, intento_a_revertir=dup, carpeta_copias=str(tmp_path))
    rev.arreglar(db, 'devolver-stock', 'AB12', aplicar=True, intento_a_revertir=r.intento,
                 reabrir_entrega=True, carpeta_copias=str(tmp_path))
    assert stock(db) == 40 and pedido(db)['estado'] == 'listo'


def test_un_cancelado_con_stock_se_devuelve_y_sigue_cancelado(db, tmp_path):
    pid = sembrar(db)
    r = NubePedidos(db, quien=lambda: dict(CAJA), avisar_cliente=False).entregar(pid)
    db.collection('tienda_pedidos').document(pid).update({'estado': 'cancelado'})
    assert 'cancelado_con_stock' in problemas(db)
    rev.arreglar(db, 'devolver-stock', 'AB12', aplicar=True, intento_a_revertir=r.intento, carpeta_copias=str(tmp_path))
    p = pedido(db)
    assert stock(db) == 40 and p['estado'] == 'cancelado' and p['stock_descontado'] is False
    assert 'cancelado_con_stock' not in problemas(db)


def test_no_devuelve_si_el_catalogo_cambio_desde_el_descuento(db, tmp_path):
    """Un conjunto que al entregar tenía la variedad con otro nombre: el
    descuento la salteó y hoy la devolución la sumaría."""
    pid = sembrar(db, items=[{'id': 'GOMA', 'nombre': 'Goma', 'cantidad': 3, 'precio': 500, 'subtotal': 1500},
                             {'id': 'NUEVO', 'nombre': 'Lápiz', 'cantidad': 1, 'precio': 100, 'subtotal': 100}])
    NubePedidos(db, quien=lambda: dict(CAJA), avisar_cliente=False).entregar(pid)
    assert pedido(db)['stock_saltados'][0]['producto_id'] == 'NUEVO'
    dup = duplicar_descuento(db)
    db.collection('catalogo').document('NUEVO').set({'nombre': 'LAPIZ', 'stock': 10})
    texto = rev.arreglar(db, 'devolver-stock', 'AB12', aplicar=True, intento_a_revertir=dup,
                         carpeta_copias=str(tmp_path))
    assert texto.startswith('No se devuelve') and 'NUEVO' in texto
    assert stock(db) == 34
    assert db.collection('catalogo').document('NUEVO').get().to_dict()['stock'] == 10
    assert 'stock_sin_descontar' in problemas(db)


def test_se_busca_por_id_cuando_dos_pedidos_comparten_codigo(db, tmp_path):
    sembrar(db, 'P1', estado='entregado', cobro={'estado': 'en_curso', **CAJA, 'desde': datetime.now(reglas.TZ_AR)})
    sembrar(db, 'P2')
    with pytest.raises(SystemExit) as err:
        rev.arreglar(db, 'soltar-cobro', 'AB12', aplicar=False, carpeta_copias=str(tmp_path))
    assert 'P1' in str(err.value) and 'P2' in str(err.value)
    texto = rev.arreglar(db, 'soltar-cobro', 'P1', aplicar=True, carpeta_copias=str(tmp_path))
    assert 'Libera el cobro' in texto and 'cobro' not in pedido(db, 'P1')
