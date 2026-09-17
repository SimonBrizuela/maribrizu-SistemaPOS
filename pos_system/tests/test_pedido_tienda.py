"""
Las reglas de los pedidos de la tienda en la caja, sin Firebase.

Lo que está en juego: varias PCs mirando el mismo pedido. Cada decisión se toma
sobre el pedido RELEÍDO dentro de una transacción, así que estas pruebas son
las de "el botón que se tocó estaba viejo": otra caja ya lo aceptó, lo cobró,
lo canceló o lo está cobrando.
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.models import pedido_tienda as pt  # noqa: E402

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
AHORA = datetime(2026, 9, 16, 18, 30, tzinfo=timezone(timedelta(hours=-3)))
CAJA1 = {'pc_id': 'CAJA1-aaaa', 'pc_nombre': 'CAJA1', 'cajero': 'Mari'}
CAJA2 = {'pc_id': 'CAJA2-bbbb', 'pc_nombre': 'CAJA2', 'cajero': 'Juan'}


def pedido(**extra):
    base = {
        'codigo': 'AB12', 'estado': 'nuevo', 'visto': False,
        'entrega': {'modo': 'retiro'}, 'pago': {'modo': 'transferencia'},
        'items': [{'id': 'A', 'nombre': 'Goma', 'cantidad': 2, 'precio': 500, 'subtotal': 1000}],
        'subtotal': 1000, 'envio': 0, 'total': 1000,
    }
    base.update(extra)
    return base


CATALOGO = {'A': {'nombre': 'GOMA', 'stock': 10}}


# ── La regla del stock, con los casos que comparte con el panel ─────────────

class TestPlanDescuento:

    def casos(self):
        with open(os.path.join(RAIZ, 'tienda', 'pruebas', 'casos_pedido_venta.json'), encoding='utf-8') as f:
            return json.load(f)['plan']

    def test_los_casos_compartidos_corren(self):
        for caso in self.casos():
            plan = pt.plan_descuento(caso['items'], caso['catalogo'])
            assert set(plan) == {'productos', 'saltados'}

    def test_comun_negativo(self):
        plan = pt.plan_descuento([{'id': 'A', 'cantidad': 3}], {'A': {'nombre': 'GOMA', 'stock': 2}})
        assert plan['productos'][0]['campos'] == {'stock': -1}
        assert plan['saltados'] == []

    def test_variedad_recalcula_agregados(self):
        cat = {'C': {'nombre': 'CARTULINA', 'es_conjunto': True, 'conjunto_contenido': 50,
                     'conjunto_colores': [{'color': 'ROJO', 'unidades': 1, 'restante': 10},
                                          {'color': 'AZUL', 'unidades': 2, 'restante': 0}],
                     'conjunto_total': 160}}
        p = pt.plan_descuento([{'id': 'C', 'cantidad': 15, 'variedad': 'Rojo'}], cat)['productos'][0]
        assert p['campos']['conjunto_colores'][0] == {'color': 'ROJO', 'unidades': 0, 'restante': 45}
        assert p['campos']['conjunto_total'] == 145
        assert p['campos']['stock'] == 145
        assert p['movimientos'][0]['detalle'] == 'Variedad ROJO'

    def test_no_toca_lo_que_recibe(self):
        cat = {'A': {'nombre': 'GOMA', 'stock': 2,
                     'conjunto_colores': []}}
        antes = json.dumps(cat, sort_keys=True)
        pt.plan_descuento([{'id': 'A', 'cantidad': 3}], cat)
        assert json.dumps(cat, sort_keys=True) == antes

    def test_escribe_enteros_y_no_dobles(self):
        plan = pt.plan_descuento([{'id': 'A', 'cantidad': 3}], {'A': {'stock': 10}})
        assert isinstance(plan['productos'][0]['campos']['stock'], int)

    def test_devolver_deja_el_total_como_estaba(self):
        """Descontar y devolver el mismo pedido vuelve al total de antes en todos
        los casos compartidos (los packs se pueden re-partir distinto, el total
        no)."""
        for caso in self.casos():
            cat = json.loads(json.dumps(caso['catalogo']))
            ida = pt.plan_descuento(caso['items'], cat)
            despues = json.loads(json.dumps(cat))
            for p in ida['productos']:
                if p['campos']:
                    despues[p['id']] = {**despues[p['id']], **p['campos']}
            vuelta = pt.plan_descuento(caso['items'], despues, devolver=True)
            for p in vuelta['productos']:
                if not p['campos']:
                    continue
                original = caso['catalogo'][p['id']]
                if 'conjunto_total' in p['campos']:
                    esperado = (pt.total_conjunto(original.get('conjunto_colores'), original.get('conjunto_contenido'))
                                if original.get('conjunto_colores') else pt.num(original.get('conjunto_total')))
                    # Un conjunto no baja de cero: si el pedido pedía más de lo
                    # que había, devolver repone lo pedido, no lo que había.
                    pedido = sum(pt.unidades_base(i) for i in caso['items'] if i.get('id') == p['id'])
                    assert p['campos']['conjunto_total'] >= esperado or esperado - pedido < 0, caso['que_prueba']
                    if esperado >= pedido:
                        assert p['campos']['conjunto_total'] == pytest.approx(esperado), caso['que_prueba']
                else:
                    assert p['campos']['stock'] == pytest.approx(pt.num(original.get('stock'))), caso['que_prueba']
            assert all(m['cantidad'] >= 0 for p in vuelta['productos'] for m in p['movimientos'])

    def test_cambios_para_la_vidriera(self):
        cat = {'C': {'nombre': 'CARTULINA', 'es_conjunto': True, 'conjunto_contenido': 50,
                     'conjunto_colores': [{'color': 'ROJO', 'unidades': 1, 'restante': 10}],
                     'tienda_variedades': {'rojo': {'nombre': 'Rojo'}}, 'conjunto_total': 60},
               'A': {'nombre': 'GOMA', 'stock': 5}, 'S': {'stock_ilimitado': True}}
        plan = pt.plan_descuento([{'id': 'C', 'cantidad': 1, 'variedad': 'ROJO'},
                                  {'id': 'A', 'cantidad': 1}, {'id': 'S', 'cantidad': 1}], cat)
        cambios = pt.cambios_para_la_tienda(plan, cat)
        assert cambios[0][0] == 'C' and cambios[0][1] == 59.0 and cambios[0][3] == 50
        assert cambios[0][4] == {'rojo': {'nombre': 'Rojo'}}
        assert cambios[1] == ('A', 4.0)
        assert len(cambios) == 2


# ── Mover de estado ─────────────────────────────────────────────────────────

class TestMover:

    def test_aceptar_un_nuevo_deja_quien_lo_tomo(self):
        r = pt.decidir_mover(pedido(), 'nuevo', 'preparando', CAJA1, AHORA)
        assert r['campos']['estado'] == 'preparando'
        assert r['campos']['visto'] is True
        assert r['campos']['tomado_por']['pc_id'] == CAJA1['pc_id']

    def test_otra_caja_ya_lo_acepto(self):
        ya = pedido(estado='preparando', movido_por={**CAJA2, 'estado': 'preparando', 'en': AHORA})
        r = pt.decidir_mover(ya, 'nuevo', 'preparando', CAJA1, AHORA)
        assert 'rechazo' in r
        assert 'Preparando' in r['rechazo'] and 'CAJA2 (Juan)' in r['rechazo']

    def test_no_saltea_pasos_ni_vuelve(self):
        assert 'rechazo' in pt.decidir_mover(pedido(), 'nuevo', 'listo', CAJA1, AHORA)
        assert 'rechazo' in pt.decidir_mover(pedido(estado='listo'), 'listo', 'preparando', CAJA1, AHORA)

    def test_en_camino_solo_para_envios(self):
        retiro = pedido(estado='listo')
        envio = pedido(estado='listo', entrega={'modo': 'delivery'})
        assert 'rechazo' in pt.decidir_mover(retiro, 'listo', 'en_camino', CAJA1, AHORA)
        assert 'campos' in pt.decidir_mover(envio, 'listo', 'en_camino', CAJA1, AHORA)

    def test_entregar_no_pasa_por_aca(self):
        assert 'rechazo' in pt.decidir_mover(pedido(estado='listo'), 'listo', 'entregado', CAJA1, AHORA)

    def test_cancelado_o_entregado_no_se_mueven(self):
        assert pt.decidir_mover(pedido(estado='cancelado'), 'cancelado', 'preparando', CAJA1, AHORA)['rechazo'] == 'lo cancelaron'
        assert pt.decidir_mover(pedido(estado='listo', stock_descontado=True), 'listo', 'en_camino', CAJA1, AHORA)['rechazo'] == 'ya se entregó'
        assert pt.decidir_mover(None, 'nuevo', 'preparando', CAJA1, AHORA)['rechazo'] == 'el pedido ya no existe'


# ── Entregar: el stock sale una sola vez ────────────────────────────────────

class TestEntregar:

    def test_entregar_descuenta_y_deja_a_cobrar(self):
        r = pt.decidir_entrega(pedido(estado='listo'), CATALOGO, CAJA1, AHORA)
        c = r['campos']
        assert c['estado'] == 'entregado'
        assert c['entregado_dia'] == '2026-09-16'
        assert c['stock_descontado'] is True
        assert c['venta_registrada'] is True
        assert c['cobro_pendiente'] is True
        assert c['venta_pendiente'] is False
        assert r['plan']['productos'][0]['campos'] == {'stock': 8}

    def test_lo_del_repartidor_se_descuenta_sin_pisar_la_hora_de_la_entrega(self):
        del_reparto = pedido(estado='entregado', venta_pendiente=True, entregado_en='x', entregado_por='reparto')
        r = pt.decidir_entrega(del_reparto, CATALOGO, CAJA1, AHORA)
        assert 'entregado_en' not in r['campos'] and 'estado' not in r['campos']
        assert r['plan'] is not None

    def test_segunda_vez_no_descuenta(self):
        """Dos PCs ven el mismo `venta_pendiente`: la segunda relee el pedido ya
        descontado por la primera y no vuelve a tocar el stock."""
        ya = pedido(estado='entregado', stock_descontado=True, venta_registrada=True, venta_pendiente=True)
        r = pt.decidir_entrega(ya, CATALOGO, CAJA2, AHORA)
        assert r['plan'] is None
        assert r['campos'] == {'venta_pendiente': False}

    def test_venta_tienda_del_panel_viejo_no_descuenta(self):
        viejo = pedido(estado='entregado', venta_registrada=True, venta_id='TIENDA_AB12')
        assert pt.decidir_entrega(viejo, CATALOGO, CAJA1, AHORA)['plan'] is None

    def test_no_se_entrega_lo_cancelado_ni_lo_nuevo(self):
        assert pt.decidir_entrega(pedido(estado='cancelado'), CATALOGO, CAJA1, AHORA)['rechazo'] == 'lo cancelaron'
        assert 'rechazo' in pt.decidir_entrega(pedido(estado='nuevo'), CATALOGO, CAJA1, AHORA)


# ── Cobrar: la venta nace una sola vez ──────────────────────────────────────

class TestCobro:

    def entregado(self, **extra):
        return pedido(estado='entregado', stock_descontado=True, venta_registrada=True,
                      cobro_pendiente=True, **extra)

    def test_tomar_libre(self):
        r = pt.decidir_tomar_cobro(self.entregado(), CAJA1, AHORA, 'i1')
        assert r['campos']['cobro']['estado'] == 'en_curso'
        assert r['campos']['cobro']['intento'] == 'i1'

    def test_otra_caja_lo_esta_cobrando(self):
        ocupado = self.entregado(cobro={'estado': 'en_curso', **CAJA2, 'desde': AHORA - timedelta(minutes=1), 'intento': 'x'})
        r = pt.decidir_tomar_cobro(ocupado, CAJA1, AHORA, 'i1')
        assert r['motivo'] == 'ocupado'
        assert 'CAJA2 (Juan)' in r['rechazo']

    def test_marca_vencida_se_toma_solo_preguntando(self):
        vieja = self.entregado(cobro={'estado': 'en_curso', **CAJA2, 'desde': AHORA - timedelta(minutes=20), 'intento': 'x'})
        assert pt.decidir_tomar_cobro(vieja, CAJA1, AHORA, 'i1')['motivo'] == 'vencida'
        assert 'campos' in pt.decidir_tomar_cobro(vieja, CAJA1, AHORA, 'i1', forzar=True)

    def test_la_misma_caja_retoma_su_marca(self):
        mia = self.entregado(cobro={'estado': 'en_curso', **CAJA1, 'desde': AHORA, 'intento': 'viejo'})
        assert pt.decidir_tomar_cobro(mia, CAJA1, AHORA, 'nuevo')['campos']['cobro']['intento'] == 'nuevo'

    def test_ya_cobrado_o_del_panel_no_se_toma(self):
        cobrado = self.entregado(cobro={'estado': 'hecho', **CAJA2})
        assert pt.decidir_tomar_cobro(cobrado, CAJA1, AHORA, 'i1')['motivo'] == 'cobrado'
        viejo = pedido(estado='entregado', venta_registrada=True, venta_id='TIENDA_AB12')
        assert pt.decidir_tomar_cobro(viejo, CAJA1, AHORA, 'i1')['motivo'] == 'panel'

    def test_cobrar_exige_la_marca_propia(self):
        """Dos cajas con la pantalla de cobro abierta: la que perdió la marca
        no puede registrar la venta aunque apriete COBRAR."""
        de_otra = self.entregado(cobro={'estado': 'en_curso', **CAJA2, 'desde': AHORA, 'intento': 'suyo'})
        r = pt.decidir_cobro(de_otra, CATALOGO, CAJA1, AHORA, 'mio', {'payment_type': 'cash'})
        assert 'rechazo' in r and 'CAJA2' in r['rechazo']

    def test_cobrar_con_la_marca(self):
        mio = self.entregado(cobro={'estado': 'en_curso', **CAJA1, 'desde': AHORA, 'intento': 'i1'})
        r = pt.decidir_cobro(mio, CATALOGO, CAJA1, AHORA, 'i1', {'payment_type': 'transfer'})
        assert r['campos']['cobro']['estado'] == 'hecho'
        assert r['campos']['cobro']['pago'] == {'payment_type': 'transfer'}
        assert r['campos']['cobro_pendiente'] is False
        assert r['plan'] is None     # el stock ya había salido

    def test_entregar_y_cobrar_en_el_mostrador_va_junto(self):
        listo = pedido(estado='listo', cobro={'estado': 'en_curso', **CAJA1, 'desde': AHORA, 'intento': 'i1'})
        r = pt.decidir_cobro(listo, CATALOGO, CAJA1, AHORA, 'i1', {'payment_type': 'cash'})
        assert r['campos']['estado'] == 'entregado'
        assert r['campos']['stock_descontado'] is True
        assert r['campos']['cobro_pendiente'] is False
        assert r['plan']['productos'][0]['campos'] == {'stock': 8}

    def test_segundo_cobro_rechazado(self):
        hecho = self.entregado(cobro={'estado': 'hecho', **CAJA1, 'intento': 'i1'})
        assert 'rechazo' in pt.decidir_cobro(hecho, CATALOGO, CAJA1, AHORA, 'i1', {})

    def test_soltar_solo_la_propia(self):
        p = self.entregado(cobro={'estado': 'en_curso', **CAJA1, 'intento': 'i1'})
        assert pt.decidir_soltar_cobro(p, 'i1')['soltar'] is True
        assert pt.decidir_soltar_cobro(p, 'otro')['soltar'] is False

    def test_anotar_venta_local(self):
        p = self.entregado(cobro={'estado': 'hecho', **CAJA1, 'intento': 'i1'})
        r = pt.decidir_anotar_venta(p, 'i1', CAJA1['pc_id'], 57)
        assert r['campos'] == {'venta_id': 'CAJA1-aaaa_57', 'cobro.venta_local': 57}
        assert 'rechazo' in pt.decidir_anotar_venta(p, 'i1', CAJA2['pc_id'], 57)


# ── Cancelar y facturar ─────────────────────────────────────────────────────

class TestCancelarYFacturar:

    def test_cancelar_en_curso(self):
        r = pt.decidir_cancelar(pedido(estado='listo'), CAJA1, AHORA)
        assert r['campos']['estado'] == 'cancelado'

    def test_no_se_cancela_lo_entregado_ni_lo_que_se_esta_cobrando(self):
        assert pt.decidir_cancelar(pedido(estado='entregado'), CAJA1, AHORA)['rechazo'] == 'ya se entregó'
        cobrando = pedido(estado='listo', cobro={'estado': 'en_curso', **CAJA2, 'desde': AHORA})
        assert 'CAJA2' in pt.decidir_cancelar(cobrando, CAJA1, AHORA)['rechazo']
        assert pt.decidir_cancelar(pedido(estado='cancelado'), CAJA1, AHORA)['rechazo'] == 'ya estaba cancelado'

    def test_facturar_una_sola_vez(self):
        cobrado = pedido(estado='entregado', cobro={'estado': 'hecho', **CAJA1})
        assert 'campos' in pt.decidir_tomar_factura(cobrado, CAJA1, AHORA, 'f1')
        emitida = dict(cobrado, factura={'estado': 'emitida', 'tipo': 'FAC. ELEC. C', 'numero': 88, **CAJA2})
        r = pt.decidir_tomar_factura(emitida, CAJA1, AHORA, 'f2')
        assert r['motivo'] == 'emitida' and '88' in r['rechazo']
        facturando = dict(cobrado, factura={'estado': 'en_curso', **CAJA2, 'desde': AHORA})
        assert pt.decidir_tomar_factura(facturando, CAJA1, AHORA, 'f2')['motivo'] == 'ocupado'

    def test_factura_a_medias_de_esta_misma_caja_tambien_pregunta(self):
        cobrado = pedido(estado='entregado', cobro={'estado': 'hecho', **CAJA1},
                         factura={'estado': 'en_curso', **CAJA1, 'desde': AHORA, 'intento': 'f0'})
        r = pt.decidir_tomar_factura(cobrado, CAJA1, AHORA, 'f1')
        assert r['motivo'] == 'vencida' and 'esta caja' in r['rechazo']
        assert 'campos' in pt.decidir_tomar_factura(cobrado, CAJA1, AHORA, 'f1', forzar=True)

    def test_no_se_factura_sin_cobrar(self):
        assert pt.decidir_tomar_factura(pedido(estado='entregado'), CAJA1, AHORA, 'f1')['motivo'] == 'estado'

    def test_anotar_factura(self):
        datos = {'tipo_comprobante': 'FAC. ELEC. C', 'punto_venta': 3, 'nro_comprobante': 120,
                 'cae': '7412', 'total': 1000.0}
        p = pedido(estado='entregado', cobro={'estado': 'hecho'}, factura={'estado': 'en_curso', 'intento': 'f1'})
        f = pt.decidir_anotar_factura(p, 'f1', datos, CAJA1, AHORA)['campos']['factura']
        assert f['estado'] == 'emitida' and f['numero'] == 120 and f['punto_venta'] == 3 and f['total'] == 1000
        otra = dict(p, factura={'estado': 'emitida', 'intento': 'otro'})
        assert pt.decidir_anotar_factura(otra, 'f1', datos, CAJA1, AHORA)['duplicada'] is True


# ── Los renglones del cobro ─────────────────────────────────────────────────

class TestRenglones:

    def test_cupon_adentro_de_las_lineas_y_cierra_con_el_total(self):
        p = {
            'codigo': 'CU01', 'subtotal': 20400, 'envio': 1500, 'descuento': 2040, 'total': 19860,
            'pago': {'modo': 'transferencia'},
            'cupon': {'codigo': 'BIENVENIDA', 'valor': 10, 'descuento': 2040, 'envio_gratis': False,
                      'renglones': [{'id': 'R', 'variedad': None, 'es_pack': False, 'descuento': 1800},
                                    {'id': 'L', 'variedad': None, 'es_pack': False, 'descuento': 240}]},
            'items': [{'id': 'R', 'nombre': 'Resma', 'cantidad': 1, 'precio': 18000, 'subtotal': 18000},
                      {'id': 'L', 'nombre': 'Lápiz', 'cantidad': 3, 'precio': 800, 'subtotal': 2400}],
        }
        lineas = pt.renglones_de_cobro(p, 'doc2', {'R': 11})
        resma, lapiz, envio = lineas
        assert resma['product_id'] == 11 and lapiz['product_id'] == 0
        assert resma['subtotal'] == 16200 and resma['discount_amount'] == 1800
        assert resma['original_price'] == 18000 and resma['discount_type'] == 'cupon'
        assert lapiz['unit_price'] == 720
        assert envio['product_name'] == 'ENVIO A DOMICILIO' and envio['subtotal'] == 1500
        assert all(l['stock_descontado'] for l in lineas)
        assert sum(l['subtotal'] for l in lineas) == pytest.approx(19860)
        assert lapiz['tienda'] == {'origen': 'tienda', 'pedido_id': 'doc2', 'producto_id': 'L',
                                   'es_pack': False, 'pack_contenido': None, 'unidad': 'unidad', 'cantidad': 3}

    def test_envio_gratis_por_cupon(self):
        p = {'envio': 2000, 'descuento': 2000, 'total': 5000,
             'cupon': {'codigo': 'ENVIOGRATIS', 'envio_gratis': True, 'descuento': 2000},
             'entrega': {'modo': 'delivery', 'envio_gratis': True},
             'items': [{'id': 'A', 'nombre': 'Goma', 'cantidad': 1, 'precio': 5000, 'subtotal': 5000}]}
        envio = pt.renglones_de_cobro(p, 'x')[-1]
        assert envio['subtotal'] == 0 and envio['discount_amount'] == 2000

    def test_sin_producto_local_queda_el_nombre_del_pedido(self):
        p = {'items': [{'id': 'C', 'nombre': 'Cartulina', 'cantidad': 2, 'precio': 900, 'subtotal': 1800,
                        'variedad': 'Rojo', 'es_pack': True, 'pack_contenido': 10, 'pack_nombre': 'paquete'}]}
        linea = pt.renglones_de_cobro(p, 'x')[0]
        assert linea['product_name'] == 'CARTULINA  ·  Rojo  ·  paquete x10'
        assert linea['product_id'] == 0
        assert linea['tienda']['es_pack'] is True and linea['tienda']['pack_contenido'] == 10

    def test_conjunto_como_lo_escribe_el_carrito_del_pos(self):
        """El panel busca el costo y la velocidad de venta por el nombre: tiene
        que ser el del catálogo con la presentación como la escribe el POS."""
        locales = {'C': {'id': 7, 'name': 'CARTULINA ESCOLAR 50X65', 'es_conjunto': 1, 'conjunto_tipo': 'pack',
                         'conjunto_colores': '[{"color": "ROJO"}, {"color": "AZUL FRANCIA"}]'}}
        pack = pt.renglones_de_cobro({'items': [{'id': 'C', 'nombre': 'Cartulina', 'cantidad': 2, 'precio': 900,
                                                 'subtotal': 1800, 'variedad': 'Rojo', 'es_pack': True,
                                                 'pack_contenido': 10}]}, 'x', locales)[0]
        assert pack['product_name'] == '[ROJO]  CARTULINA ESCOLAR 50X65  ·  2 pack(s)'
        assert (pack['product_id'], pack['quantity'], pack['unit_price'], pack['conjunto_color']) == (7, 2, 900, 'ROJO')
        suelta = pt.renglones_de_cobro({'items': [{'id': 'C', 'nombre': 'Cartulina', 'cantidad': 3, 'precio': 100,
                                                   'subtotal': 300, 'variedad': 'azul francia'}]}, 'x', locales)[0]
        assert suelta['product_name'] == '[AZUL FRANCIA]  CARTULINA ESCOLAR 50X65  ·  3 u'

    def test_metros_con_decimales_van_uno_por_el_total(self):
        locales = {'M': {'id': 9, 'name': 'CINTA RASO 6MM', 'es_conjunto': 1, 'conjunto_tipo': 'rollo'}}
        linea = pt.renglones_de_cobro({'items': [{'id': 'M', 'nombre': 'Cinta', 'cantidad': 2.5, 'precio': 400,
                                                  'subtotal': 1000, 'unidad': 'metro'}]}, 'x', locales)[0]
        assert linea['product_name'] == 'CINTA RASO 6MM  ·  2.5 m'
        assert (linea['quantity'], linea['unit_price'], linea['subtotal']) == (1, 1000, 1000)
        assert linea['tienda']['cantidad'] == 2.5

    def test_producto_comun_por_pack_va_en_unidades(self):
        locales = {'L': {'id': 3, 'name': 'LAPIZ NEGRO HB', 'es_conjunto': 0}}
        linea = pt.renglones_de_cobro({'items': [{'id': 'L', 'nombre': 'Lápiz', 'cantidad': 2, 'precio': 1200,
                                                  'subtotal': 2400, 'es_pack': True, 'pack_contenido': 12}]},
                                      'x', locales)[0]
        assert linea['product_name'] == 'LAPIZ NEGRO HB'
        assert (linea['quantity'], linea['unit_price'], linea['subtotal']) == (24, 100, 2400)

    def test_envio_a_confirmar_se_cobra_con_el_costo_real(self):
        p = {'subtotal': 5000, 'envio': 1500, 'descuento': 0, 'total': 6500,
             'entrega': {'modo': 'delivery', 'envio_a_confirmar': True},
             'items': [{'id': 'A', 'nombre': 'Goma', 'cantidad': 1, 'precio': 5000, 'subtotal': 5000}]}
        nuevo = pt.con_envio(p, 2300)
        assert nuevo['total'] == 7300 and nuevo['envio'] == 2300
        assert nuevo['entrega']['envio_a_confirmar'] is False
        assert p['total'] == 6500
        gratis = pt.con_envio(dict(p, entrega={'modo': 'delivery', 'envio_gratis': True, 'envio_a_confirmar': True},
                                   descuento=1500), 2300)
        assert gratis['total'] == 5000
        lineas = pt.renglones_de_cobro(nuevo, 'x')
        assert sum(l['subtotal'] for l in lineas) == 7300

    def test_pago_sugerido_y_total(self):
        assert pt.pago_sugerido({'pago': {'modo': 'efectivo'}}) == 'cash'
        assert pt.pago_sugerido({'pago': {'modo': 'transferencia'}}) == 'transfer'
        assert pt.pago_sugerido({}) == 'transfer'
        assert pt.total_a_cobrar({'total': 1234.5}) == 1234.5


# ── La pestaña ──────────────────────────────────────────────────────────────

class TestPestana:

    def test_grupos(self):
        assert pt.grupo(pedido()) == 'hacer'
        assert pt.grupo(pedido(estado='entregado', venta_pendiente=True)) == 'cobrar'
        assert pt.grupo(pedido(estado='entregado', cobro={'estado': 'hecho'})) == 'hechos'
        assert pt.grupo(pedido(estado='entregado', venta_registrada=True, venta_id='TIENDA_X')) == 'hechos'
        assert pt.grupo(pedido(estado='cancelado')) == 'otros'

    def test_titulo(self):
        lista = [pedido(), pedido(visto=True), pedido(estado='entregado', cobro_pendiente=True)]
        assert pt.titulo_pestana(lista) == 'Pedidos web (1 nuevo · 1 a cobrar)'
        assert pt.titulo_pestana([]) == 'Pedidos web'


# ── Lo que queda público en el pedido y la anulación de una entrega ─────────

class TestPublicoYAnular:

    def test_en_el_pedido_no_quedan_mails_ni_nombres_completos(self):
        assert pt.marca_publica({'pc_id': 'P1', 'pc_nombre': 'CAJA1', 'cajero': 'María José Pérez'})['cajero'] == 'María'
        assert pt.marca_publica({'cajero': 'mari@liceo.com'})['cajero'] == ''
        r = pt.decidir_cobro(pedido(estado='entregado', stock_descontado=True, cobro_pendiente=True,
                                    cobro={'estado': 'en_curso', **CAJA1, 'intento': 'i1', 'desde': AHORA}),
                             CATALOGO, dict(CAJA1, cajero='Mari Gómez'), AHORA, 'i1',
                             {'payment_type': 'cash', 'cash_received': 5000, 'change_given': 4000, 'total': 1000})
        cobro = r['campos']['cobro']
        assert cobro['cajero'] == 'Mari'
        assert cobro['pago'] == {'payment_type': 'cash'}
        assert cobro['total'] == 1000

    def test_lo_que_no_se_pudo_descontar_queda_anotado(self):
        p = pedido(estado='listo', items=[{'id': 'A', 'nombre': 'Goma', 'cantidad': 1},
                                          {'id': 'NADIE', 'nombre': 'Borrado', 'cantidad': 1}])
        c = pt.decidir_entrega(p, CATALOGO, CAJA1, AHORA)['campos']
        assert c['stock_saltados'] == [{'renglon': 1, 'producto_id': 'NADIE', 'motivo': 'no está en el catálogo',
                                        'nombre': 'Borrado'}]
        assert pt.decidir_entrega(pedido(estado='listo'), CATALOGO, CAJA1, AHORA)['campos']['stock_saltados'] == []

    def test_anular_una_entrega_devuelve_el_stock_y_cancela(self):
        entregado = pedido(estado='entregado', stock_descontado=True, venta_registrada=True, cobro_pendiente=True)
        r = pt.decidir_anular_entrega(entregado, {'A': {'nombre': 'GOMA', 'stock': 8}}, CAJA1, AHORA, 'lo devolvió')
        assert r['campos']['estado'] == 'cancelado' and r['campos']['stock_descontado'] is False
        assert r['campos']['anulado']['motivo'] == 'lo devolvió'
        assert r['plan']['productos'][0]['campos'] == {'stock': 10}

    def test_anular_pide_motivo_y_no_toca_lo_que_no_corresponde(self):
        entregado = pedido(estado='entregado', stock_descontado=True)
        assert 'motivo' in pt.decidir_anular_entrega(entregado, CATALOGO, CAJA1, AHORA, '  ')['rechazo']
        assert 'rechazo' in pt.decidir_anular_entrega(pedido(estado='listo'), CATALOGO, CAJA1, AHORA, 'x')
        viejo = pedido(estado='entregado', venta_registrada=True, venta_id='TIENDA_AB12', stock_descontado=True)
        assert 'panel' in pt.decidir_anular_entrega(viejo, CATALOGO, CAJA1, AHORA, 'x')['rechazo']
        cobrando = dict(entregado, cobro={'estado': 'en_curso', **CAJA2, 'desde': AHORA})
        assert 'CAJA2' in pt.decidir_anular_entrega(cobrando, CATALOGO, CAJA1, AHORA, 'x')['rechazo']
        sin_stock = pedido(estado='entregado', venta_pendiente=True)
        assert pt.decidir_anular_entrega(sin_stock, CATALOGO, CAJA1, AHORA, 'x')['plan'] is None

    def test_anular_un_cobrado_avisa_que_la_venta_sigue(self):
        cobrado = pedido(estado='entregado', stock_descontado=True, cobro={'estado': 'hecho', **CAJA1})
        r = pt.decidir_anular_entrega(cobrado, CATALOGO, CAJA1, AHORA, 'devolución')
        assert r['campos']['anulado']['estaba_cobrado'] is True

    def test_la_devolucion_se_compara_con_lo_que_salio(self):
        salio = [{'firebase_id': 'A', 'detalle': '', 'cantidad': -2}]
        igual = pt.plan_descuento([{'id': 'A', 'cantidad': 2}], {'A': {'nombre': 'GOMA', 'stock': 8}}, devolver=True)
        assert pt.diferencias_de_devolucion(igual, salio) == []
        # Al entregar el renglón B se salteó (no estaba en el catálogo); hoy está.
        de_mas = pt.plan_descuento([{'id': 'A', 'cantidad': 2}, {'id': 'B', 'cantidad': 1}],
                                   {'A': {'stock': 8}, 'B': {'stock': 3}}, devolver=True)
        assert pt.diferencias_de_devolucion(de_mas, salio) == [
            {'producto_id': 'B', 'detalle': '', 'salio': 0.0, 'devolveria': 1.0}]
        assert pt.diferencias_de_devolucion(igual, salio + salio)[0]['salio'] == 4.0


class TestWhatsapp:

    def test_el_numero_como_lo_quiere_whatsapp(self):
        assert pt.whatsapp_de_telefono('0351 15 619-4411') == '5493516194411'
        assert pt.whatsapp_de_telefono('+54 351 619 4411') == '5493516194411'
        assert pt.whatsapp_de_telefono('4234567') is None
        assert pt.whatsapp_de_telefono(None) is None

    def test_el_mensaje_del_estado(self):
        p = {'codigo': 'K7M2', 'estado': 'listo', 'cliente': {'nombre': 'María Fernanda'},
             'entrega': {'modo': 'retiro'}}
        assert pt.mensaje_whatsapp(p, pt.DIRECCION_LOCAL) == (
            'Hola María, tu pedido K7M2 ya está listo para que lo retires. Te esperamos en Av. Alfonsina Storni 168.')
        assert pt.mensaje_whatsapp(dict(p, estado='nuevo')) is None


class TestRenglonesExactos:

    def test_cantidad_entera_y_precio_que_vuelve_al_centavo(self):
        p = {'items': [{'id': 'A', 'nombre': 'Goma', 'cantidad': 3.0, 'precio': 333.34, 'subtotal': 1000}],
             'subtotal': 1000, 'envio': 0, 'total': 1000}
        linea = pt.renglones_de_cobro(p, 'p1', {'A': {'id': 7, 'name': 'GOMA'}})[0]
        assert linea['quantity'] == 3 and isinstance(linea['quantity'], int)
        assert round(linea['quantity'] * linea['unit_price'], 2) == 1000
