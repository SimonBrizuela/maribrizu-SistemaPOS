"""
Lo que detecta `scripts/revisar_pedidos_tienda.py`, sin Firebase.

Cada caso arma a mano el rastro que dejaría un problema real (un stock que
salió dos veces, dos ventas del mismo pedido, un cobro colgado) y verifica que
la revisión lo encuentre y proponga el arreglo; y que un pedido sano no dispare
nada.
"""
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.models import pedido_tienda as reglas  # noqa: E402
from scripts import revisar_pedidos_tienda as rev  # noqa: E402

AHORA = datetime(2026, 9, 16, 20, 0, tzinfo=reglas.TZ_AR)
HACE = lambda **kw: AHORA - timedelta(**kw)  # noqa: E731
CAJA1 = {'pc_id': 'CAJA1-a', 'pc_nombre': 'CAJA1', 'cajero': 'Mari'}


def pedido(**extra):
    p = {'codigo': 'AB12', 'estado': 'entregado', 'creado': HACE(hours=3), 'entregado_en': HACE(hours=2),
         'stock_descontado': True, 'venta_registrada': True, 'cobro_pendiente': False,
         'cobro': {'estado': 'hecho', **CAJA1, 'en': HACE(hours=1), 'intento': 'c1'},
         'venta_id': 'CAJA1-a_57', 'items': [{'id': 'A', 'cantidad': 2}], 'total': 1000,
         'entrega': {'modo': 'retiro'}, 'pago': {'modo': 'transferencia'}, 'cliente': {'nombre': 'Ana'}}
    p.update(extra)
    return p


def mov(intento, **extra):
    m = {'id': f'tienda_p1_{intento}_0', 'pedido_id': 'p1', 'intento': intento, 'origen': 'pos',
         'pc_id': 'CAJA1-a', 'motivo': 'venta', 'cantidad': -2, 'producto_nombre': 'GOMA', 'ts': HACE(hours=2)}
    m.update(extra)
    return m


VENTA = {'id': 'CAJA1-a_57', 'pedido_id': 'p1', 'pc_id': 'CAJA1-a', 'total_amount': 1000, 'created_at': HACE(minutes=59)}


def tipos(problemas):
    return sorted(p['tipo'] for p in problemas)


def test_un_pedido_sano_no_dispara_nada():
    r = rev.revisar({'p1': pedido()}, [], [mov('i1')], [VENTA], [{'pedido_id': 'p1', 'tipo_comprobante': 'FAC. ELEC. C'}], AHORA)
    assert r == []


def test_stock_que_salio_dos_veces():
    r = rev.revisar({'p1': pedido()}, [], [mov('i1'), mov('i2', origen='webapp', pc_id='webapp')], [VENTA], [], AHORA)
    assert tipos(r) == ['stock_duplicado']
    assert r[0]['gravedad'] == 'grave'
    assert '--devolver-stock AB12' in r[0]['arreglo']


def test_un_descuento_devuelto_ya_no_cuenta():
    devolucion = mov('i3', motivo='anulacion', revierte_intento='i2', cantidad=2)
    r = rev.revisar({'p1': pedido()}, [], [mov('i1'), mov('i2'), devolucion], [VENTA], [], AHORA)
    assert r == []
    grupos = rev.grupos_de_stock('p1', [mov('i1'), mov('i2'), devolucion])
    assert grupos['i2']['revertido'] is True and grupos['i1']['revertido'] is False


def test_dos_ventas_para_el_mismo_pedido():
    otra = dict(VENTA, id='CAJA2-b_9', pc_id='CAJA2-b')
    r = rev.revisar({'p1': pedido()}, [], [mov('i1')], [VENTA, otra], [], AHORA)
    assert 'venta_duplicada' in tipos(r)
    assert 'venta_sin_anotar' in tipos(r)


def test_una_venta_borrada_no_cuenta():
    otra = dict(VENTA, id='CAJA2-b_9', pc_id='CAJA2-b', deleted=True)
    assert rev.revisar({'p1': pedido()}, [], [mov('i1')], [VENTA, otra], [], AHORA) == []


def test_dos_facturas_pero_la_nota_de_credito_no_suma():
    f1 = {'pedido_id': 'p1', 'tipo_comprobante': 'FAC. ELEC. C', 'nro_comprobante': 10, 'cae': '1'}
    f2 = {'pedido_id': 'p1', 'tipo_comprobante': 'FAC. ELEC. C', 'nro_comprobante': 11, 'cae': '2'}
    nc = {'pedido_id': 'p1', 'tipo_comprobante': 'NOTA CRED. C', 'nro_comprobante': 1, 'cae': '3'}
    sin_cae = {'pedido_id': 'p1', 'tipo_comprobante': 'FAC. ELEC. C', 'nro_comprobante': 9, 'cae': ''}
    assert tipos(rev.revisar({'p1': pedido()}, [], [mov('i1')], [VENTA], [f1, f2], AHORA)) == ['factura_duplicada']
    assert rev.revisar({'p1': pedido()}, [], [mov('i1')], [VENTA], [f1, nc], AHORA) == []
    assert rev.revisar({'p1': pedido()}, [], [mov('i1')], [VENTA], [f1, sin_cae], AHORA) == []


def test_cobro_sin_venta_y_venta_que_no_subio():
    sin_venta = pedido(venta_id=None)
    assert tipos(rev.revisar({'p1': sin_venta}, [], [mov('i1')], [], [], AHORA)) == ['cobro_sin_venta']
    assert tipos(rev.revisar({'p1': pedido()}, [], [mov('i1')], [], [], AHORA)) == ['venta_sin_subir']
    # Recién cobrado: todavía no es un problema.
    reciente = pedido(venta_id=None, cobro={'estado': 'hecho', **CAJA1, 'en': HACE(minutes=2)})
    assert rev.revisar({'p1': reciente}, [], [mov('i1')], [], [], AHORA) == []


def test_marcas_trabadas():
    cobrando = pedido(cobro={'estado': 'en_curso', **CAJA1, 'desde': HACE(minutes=40)}, venta_id=None,
                      cobro_pendiente=True, entregado_en=HACE(minutes=50))
    r = rev.revisar({'p1': cobrando}, [], [mov('i1')], [], [], AHORA)
    assert 'cobro_trabado' in tipos(r)
    facturando = pedido(factura={'estado': 'en_curso', **CAJA1, 'desde': HACE(hours=1)})
    r = rev.revisar({'p1': facturando}, [], [mov('i1')], [VENTA], [], AHORA)
    assert tipos(r) == ['factura_trabada']
    assert 'ARCA' in r[0]['arreglo']


def test_lo_del_repartidor_sin_descontar_y_entregado_sin_stock():
    trabado = pedido(stock_descontado=False, venta_registrada=False, venta_pendiente=True, cobro=None,
                     venta_id=None, entregado_en=HACE(hours=1))
    assert 'reparto_sin_descontar' in tipos(rev.revisar({'p1': trabado}, [], [], [], [], AHORA))
    raro = pedido(stock_descontado=False, venta_registrada=False, venta_pendiente=False, cobro=None, venta_id=None)
    assert 'entregado_sin_descontar' in tipos(rev.revisar({'p1': raro}, [], [], [], [], AHORA))


def test_cancelado_con_stock_afuera():
    r = rev.revisar({'p1': pedido(estado='cancelado', cobro=None, venta_id=None)}, [], [mov('i1')], [], [], AHORA)
    assert 'cancelado_con_stock' in tipos(r)


def test_errores_y_rechazos():
    eventos = [
        {'pedido_id': 'p1', 'accion': 'cobrar', 'resultado': 'error', 'detalle': 'sin red', **CAJA1},
        {'pedido_id': 'p1', 'accion': 'mover', 'resultado': 'rechazado', 'detalle': 'ya lo pasaron', **CAJA1},
        {'pedido_id': 'p1', 'accion': 'mover', 'resultado': 'rechazado', 'detalle': 'ya lo pasaron', **CAJA1},
    ]
    r = rev.revisar({'p1': pedido()}, eventos, [mov('i1')], [VENTA], [], AHORA)
    assert tipos(r) == ['error']
    assert rev.rechazos_por_caja(eventos) == [(('CAJA1 (Mari)', 'mover', 'ya lo pasaron'), 2)]


def test_sin_cobrar_de_mas_de_un_dia_es_informativo():
    viejo = pedido(cobro=None, venta_id=None, cobro_pendiente=True, entregado_en=HACE(days=2))
    r = rev.revisar({'p1': viejo}, [], [mov('i1')], [], [], AHORA)
    assert [(p['tipo'], p['gravedad']) for p in r] == [('sin_cobrar', 'info')]


def test_los_graves_van_primero():
    viejo = pedido(cobro=None, venta_id=None, cobro_pendiente=True, entregado_en=HACE(days=2))
    duplicado = pedido(codigo='ZZ99')
    r = rev.revisar({'p1': viejo, 'p2': duplicado}, [],
                    [mov('i1'), dict(mov('x1'), pedido_id='p2'), dict(mov('x2'), pedido_id='p2')], [], [], AHORA)
    assert r[0]['gravedad'] == 'grave'


def test_la_historia_sale_en_orden():
    eventos = [
        {'pedido_id': 'p1', 'accion': 'cobrar', 'resultado': 'hecho', 'detalle': 'cobrado', 'en': HACE(hours=1), 'origen': 'pos', **CAJA1},
        {'pedido_id': 'p1', 'accion': 'mover', 'resultado': 'hecho', 'detalle': 'nuevo → preparando', 'en': HACE(hours=2, minutes=50), 'origen': 'pos', **CAJA1},
    ]
    lineas = rev.historia('p1', pedido(), eventos, [mov('i1')], [VENTA], [])
    assert [t for _f, t, _x in lineas] == ['pedido', 'mover', 'stock', 'cobrar', 'venta']
