"""
Traer la venta de otra caja: las reglas.

El cajero arranca en la Compu 1, sigue en la Compu 3 y a lo mejor vuelve. La
3 PIDE la venta y la 1 la ENTREGA: nadie se la saca a otra caja. Lo que no
puede pasar nunca: que la venta quede en dos cajas a la vez (se cobra dos
veces), que se pierda en el camino, que una solicitud sin respuesta se cumpla
tarde, que una publicación vieja de la caja que entregó la reviva, o que en la
otra caja el renglón descuente stock de otro producto porque los ids locales no
coinciden.

Primero las reglas sueltas; después las mismas reglas corriendo sobre el doble
de la nube (transacciones optimistas, como Firestore), con carreras metidas a
propósito entre la lectura y la escritura.
"""
import json
import os
import sys
import threading
from datetime import datetime, timedelta, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.models import carrito_vivo as cv  # noqa: E402
from pos_system.tests.doble_carritos import NubeCarritosMemoria  # noqa: E402

AHORA = datetime(2026, 10, 30, 15, 0, tzinfo=timezone.utc)

RENGLON_SIMPLE = {'product_id': 12, 'product_name': 'CUADERNO RIVADAVIA', 'quantity': 2,
                  'unit_price': 3500.0, 'original_price': 3500.0, 'subtotal': 7000.0,
                  'discount_type': None, 'discount_amount': 0, 'promo_id': None}
RENGLON_ROLLO = {'product_id': 40, 'product_name': '[Rojo]  CINTA RASO  ·  3.5 m', 'quantity': 1,
                 'unit_price': 2100.0, 'subtotal': 2100.0, 'is_conjunto': True,
                 'conjunto_tipo': 'rollo', 'conjunto_unidad_base': 'metros',
                 'conjunto_cantidad': 3.5, 'conjunto_vender_por': 'fraccion',
                 'conjunto_after_unidades': 4, 'conjunto_after_restante': 21.5,
                 'conjunto_color': 'Rojo', 'usd_cotizacion': 1550.0}
RENGLON_VARIOS = {'product_id': 0, 'product_name': 'Fotocopias', 'quantity': 10,
                  'unit_price': 100.0, 'subtotal': 1000.0, 'is_varios': True}
RENGLON_MP = {'product_id': None, 'product_name': 'Cartulina 50x70 Verde', 'quantity': 3,
              'unit_price': 900.0, 'subtotal': 2700.0, 'is_mp': True,
              'mp_product_id': 'mpX', 'mp_node_id': 'n1', 'mp_presentation_id': 'p1'}

# Catálogo de la Compu 1: id local → referencia global.
CATALOGO_1 = {12: {'firebase_id': 'fb-cuaderno', 'barcode': '7790001'},
              40: {'firebase_id': 'fb-cinta', 'barcode': ''}}
# La Compu 3 tiene los mismos productos con OTROS ids locales.
CATALOGO_3 = {'fb-cuaderno': 7, 'fb-cinta': 51}


def buscar_en_3(ref):
    return CATALOGO_3.get(ref.get('firebase_id'))


def estado(pc, epoch, items, cajero='Ana', **extra):
    return cv.armar_estado(pc, pc.replace('pc', 'Compu '), epoch, cv.serializar_items(items, CATALOGO_1.get),
                           items, cajero, **extra)


# ════════════════════════════════════════════════════════════════════════════
class TestCarritoEnTexto:
    def test_el_carrito_vuelve_igual_que_como_salio(self):
        items = [RENGLON_SIMPLE, RENGLON_ROLLO, RENGLON_VARIOS, RENGLON_MP]
        vuelto = cv.leer_items(cv.serializar_items(items))
        assert vuelto == items

    def test_los_numeros_no_cambian_de_tipo(self):
        """Firestore devuelve 2.0 como 2 y al revés; por eso el carrito viaja
        en texto: una cantidad 3.5 m o un after_unidades entero vuelven igual."""
        vuelto = cv.leer_items(cv.serializar_items([RENGLON_ROLLO]))[0]
        assert vuelto['conjunto_cantidad'] == 3.5 and isinstance(vuelto['conjunto_cantidad'], float)
        assert vuelto['conjunto_after_unidades'] == 4 and isinstance(vuelto['conjunto_after_unidades'], int)
        assert vuelto['is_conjunto'] is True

    def test_cada_renglon_de_catalogo_lleva_su_referencia_global(self):
        vuelto = cv.leer_items(cv.serializar_items([RENGLON_SIMPLE, RENGLON_VARIOS, RENGLON_MP],
                                                   CATALOGO_1.get))
        assert vuelto[0]['_ref'] == {'firebase_id': 'fb-cuaderno', 'barcode': '7790001'}
        assert '_ref' not in vuelto[1] and '_ref' not in vuelto[2]

    def test_serializar_no_toca_el_carrito_de_la_caja(self):
        items = [dict(RENGLON_SIMPLE)]
        cv.serializar_items(items, CATALOGO_1.get)
        assert '_ref' not in items[0]

    def test_texto_roto_no_tumba_nada(self):
        assert cv.leer_items('{no es json') == []
        assert cv.leer_items(None) == []
        assert cv.leer_items(json.dumps({'no': 'lista'})) == []


class TestIdsDeOtraCaja:
    def test_el_renglon_pasa_al_id_de_esta_caja(self):
        llegado = cv.leer_items(cv.serializar_items([RENGLON_SIMPLE, RENGLON_ROLLO], CATALOGO_1.get))
        items, faltan = cv.adaptar_items(llegado, buscar_en_3)
        assert faltan == []
        assert [it['product_id'] for it in items] == [7, 51]
        assert all('_ref' not in it for it in items)
        # Todo lo demás del rollo viaja intacto: el cobro lo recalcula con eso.
        assert items[1]['conjunto_color'] == 'Rojo' and items[1]['conjunto_cantidad'] == 3.5

    def test_si_no_hay_firebase_id_busca_por_codigo_de_barras(self):
        llegado = [{**RENGLON_SIMPLE, '_ref': {'firebase_id': '', 'barcode': '7790001'}}]
        items, faltan = cv.adaptar_items(
            llegado, lambda ref: 99 if ref.get('barcode') == '7790001' and not ref.get('firebase_id') else None)
        assert items[0]['product_id'] == 99 and faltan == []

    def test_lo_que_esta_caja_no_tiene_se_avisa_y_no_se_queda_con_el_id_ajeno(self):
        llegado = cv.leer_items(cv.serializar_items([RENGLON_SIMPLE], CATALOGO_1.get))
        items, faltan = cv.adaptar_items(llegado, lambda ref: None, convertir=True)
        assert faltan == ['CUADERNO RIVADAVIA']
        # Con el id 12 de la otra caja descontaría stock de cualquier producto.
        assert items[0]['product_id'] == 0 and items[0]['is_varios'] is True
        assert items[0]['subtotal'] == 7000.0

    def test_un_rollo_que_no_existe_aca_pierde_los_datos_de_conjunto(self):
        llegado = cv.leer_items(cv.serializar_items([RENGLON_ROLLO], CATALOGO_1.get))
        items, _ = cv.adaptar_items(llegado, lambda ref: None, convertir=True)
        assert not any(k.startswith('conjunto_') for k in items[0])
        assert items[0]['is_conjunto'] is False

    def test_varios_y_productos_madre_pasan_sin_tocar(self):
        items, faltan = cv.adaptar_items([RENGLON_VARIOS, RENGLON_MP], lambda ref: None, convertir=True)
        assert items == [RENGLON_VARIOS, RENGLON_MP] and faltan == []


class TestResumen:
    def test_total_cantidad_y_renglones_con_descuento(self):
        r = cv.resumen([RENGLON_SIMPLE, RENGLON_VARIOS], descuento_monto=800)
        assert r == {'renglones': 2, 'cantidad': 12, 'total': 7200.0}

    def test_el_estado_lleva_el_cajero_y_los_extras(self):
        e = estado('pc1', 'E1', [RENGLON_SIMPLE], cajero='Ana',
                   descuento={'nombre': 'Jubilados', 'tipo': 'porcentaje', 'valor': 10, 'filas': None},
                   descuento_monto=700, fiado={'firebase_id': 'cli1', 'nombre': 'Marta'})
        assert e['cajero'] == 'Ana' and e['total'] == 6300.0
        assert e['descuento']['nombre'] == 'Jubilados' and e['fiado']['nombre'] == 'Marta'
        assert e['entregada_epoch'] == '' and e['cobrando'] is False and e['pendiente_de_cargar'] is False


class TestNombreDeCaja:
    def test_el_nombre_que_le_puso_el_admin(self):
        assert cv.nombre_de_caja({'nombre_caja': 'Compu 3', 'hostname': 'DESKTOP-A'}) == 'Compu 3'

    def test_sin_nombre_el_de_windows_y_nunca_el_codigo(self):
        assert cv.nombre_de_caja({}, 'DESKTOPAB-1f3c9a2b') == 'DESKTOPAB'
        assert cv.nombre_de_caja({'hostname': 'MERCERIA-PC'}) == 'MERCERIA-PC'
        assert cv.nombre_de_caja(None, '') == 'Otra caja'


QUIEN_3 = {'pc_id': 'pc3', 'pc_nombre': 'Compu 3', 'cajero': 'Beto'}
QUIEN_1 = {'pc_id': 'pc1', 'pc_nombre': 'Compu 1', 'cajero': 'Ana'}


# ════════════════════════════════════════════════════════════════════════════
class TestPublicar:
    def test_escribe_su_carrito(self):
        assert cv.decidir_publicacion(None, 'E1', {'x': 1})['accion'] == 'escribir'

    def test_una_venta_ya_entregada_no_se_revive(self):
        """Una publicación que quedó en la fila de la caja que entregó no vuelve
        a escribir esa venta: estaría en dos cajas."""
        doc = cv.doc_origen_entregado({'pc_id': 'pc1', 'epoch': 'E1'}, cv.solicitud_nueva('s', 'E1', QUIEN_3))
        assert cv.decidir_publicacion(doc, 'E1', {'x': 1}) == {'accion': 'nada', 'motivo': 'entregada'}

    def test_una_venta_nueva_despues_de_entregar_se_publica(self):
        doc = cv.doc_origen_entregado({'pc_id': 'pc1', 'epoch': 'E1'}, cv.solicitud_nueva('s', 'E1', QUIEN_3))
        assert cv.decidir_publicacion(doc, 'E2', {'x': 1})['accion'] == 'escribir'

    def test_una_venta_que_llego_y_no_se_cargo_no_se_pisa(self):
        llegada = cv.doc_entregado(estado('pc1', 'E1', [RENGLON_SIMPLE]), cv.solicitud_nueva('s', 'E1', QUIEN_3))
        assert cv.decidir_publicacion(llegada, 'E9', {'x': 1})['accion'] == 'adoptar'
        assert cv.decidir_publicacion(llegada, None, None, forzar_vacio=True)['accion'] == 'adoptar'
        # Ya cargada (mismo epoch): se publica normal y la marca se va.
        assert cv.decidir_publicacion(llegada, 'E1', {'x': 1})['accion'] == 'escribir'

    def test_vaciar_solo_la_venta_propia(self):
        mio = estado('pc1', 'E1', [RENGLON_SIMPLE])
        assert cv.decidir_publicacion(mio, 'E1', None)['accion'] == 'vaciar'
        assert cv.decidir_publicacion({**mio, 'epoch': 'E9'}, 'E1', None)['accion'] == 'nada'

    def test_vaciar_algo_ya_vacio_no_escribe(self):
        assert cv.decidir_publicacion(cv.estado_vacio('pc1', 'Compu 1'), 'E1', None)['accion'] == 'nada'
        assert cv.decidir_publicacion(None, None, None)['accion'] == 'nada'

    def test_al_arrancar_se_vacia_lo_que_quedo_de_la_sesion_anterior(self):
        viejo = estado('pc1', 'E0', [RENGLON_SIMPLE])
        assert cv.decidir_publicacion(viejo, None, None, forzar_vacio=True)['accion'] == 'vaciar'


class TestPedir:
    def _origen(self, **cambios):
        doc = {**estado('pc1', 'E1', [RENGLON_SIMPLE]), 'actualizado': AHORA - timedelta(seconds=10)}
        doc.update(cambios)
        return doc

    def test_se_puede(self):
        assert cv.decidir_pedido(self._origen(), None, 'E1', 'pc3', AHORA) == {'ok': True}

    def test_ya_no_esta(self):
        assert cv.decidir_pedido(None, None, 'E1', 'pc3', AHORA)['motivo'] == 'no_esta'

    def test_cambio_mientras_la_miraba(self):
        assert cv.decidir_pedido(self._origen(epoch='E2'), None, 'E1', 'pc3', AHORA)['motivo'] == 'cambio'

    def test_la_estan_cobrando(self):
        r = cv.decidir_pedido(self._origen(cobrando=True), None, 'E1', 'pc3', AHORA)
        assert r['motivo'] == 'cobrando' and 'Compu 1' in r['rechazo']

    def test_caja_sin_senales(self):
        viejo = self._origen(actualizado=AHORA - timedelta(seconds=cv.VIGENCIA_SEG + 5))
        assert cv.decidir_pedido(viejo, None, 'E1', 'pc3', AHORA)['motivo'] == 'sin_senal'

    def test_otra_caja_ya_la_esta_pidiendo(self):
        sol = {**cv.solicitud_nueva('s2', 'E1', {'pc_id': 'pc2', 'pc_nombre': 'Compu 2'}),
               'pedida_en': AHORA - timedelta(seconds=1)}
        r = cv.decidir_pedido(self._origen(), sol, 'E1', 'pc3', AHORA)
        assert r['motivo'] == 'pedida_por_otra' and 'Compu 2' in r['rechazo']
        # Vencida, ya no cuenta.
        vieja = {**sol, 'pedida_en': AHORA - timedelta(seconds=cv.VALIDEZ_SOLICITUD_SEG + 1)}
        assert cv.decidir_pedido(self._origen(), vieja, 'E1', 'pc3', AHORA) == {'ok': True}


class TestEntregar:
    def _sol(self, **cambios):
        sol = {**cv.solicitud_nueva('s1', 'E1', QUIEN_3), 'pedida_en': AHORA - timedelta(seconds=1)}
        sol.update(cambios)
        return sol

    def test_se_entrega(self):
        assert cv.decidir_entrega(self._sol(), 's1', 'E1', None, AHORA) == {'ok': True}

    def test_una_solicitud_vencida_no_se_cumple_tarde(self):
        sol = self._sol(pedida_en=AHORA - timedelta(seconds=cv.VALIDEZ_SOLICITUD_SEG + 1))
        assert cv.decidir_entrega(sol, 's1', 'E1', None, AHORA)['motivo'] == 'vencida'

    def test_cancelada_o_de_otra_vez(self):
        assert cv.decidir_entrega(self._sol(estado='cancelada'), 's1', 'E1', None, AHORA)['motivo'] == 'cancelada'
        assert cv.decidir_entrega(self._sol(), 'otra', 'E1', None, AHORA)['motivo'] == 'otra_solicitud'

    def test_la_venta_ya_no_esta_en_el_carrito(self):
        assert cv.decidir_entrega(self._sol(), 's1', 'E7', None, AHORA)['motivo'] == 'no_esta'
        assert cv.decidir_entrega(self._sol(), 's1', None, None, AHORA)['motivo'] == 'no_esta'

    def test_el_destino_ya_tiene_una_venta(self):
        ocupado = estado('pc3', 'E5', [RENGLON_SIMPLE])
        assert cv.decidir_entrega(self._sol(), 's1', 'E1', ocupado, AHORA)['motivo'] == 'destino_ocupado'

    def test_lo_que_recibe_el_destino(self):
        origen = estado('pc1', 'E1', [RENGLON_SIMPLE],
                        descuento={'nombre': 'Docente', 'tipo': 'monto', 'valor': 500, 'filas': None})
        nuevo = cv.doc_entregado(origen, self._sol())
        assert nuevo['epoch'] == 'E1' and nuevo['cajero'] == 'Ana' and nuevo['pc_id'] == 'pc3'
        assert nuevo['traida_de'] == {'pc_id': 'pc1', 'pc_nombre': 'Compu 1'}
        assert nuevo['pendiente_de_cargar'] is True and nuevo['solicitud_id'] == 's1'
        assert nuevo['descuento']['nombre'] == 'Docente' and nuevo['items_json'] == origen['items_json']
        vacio = cv.doc_origen_entregado(origen, self._sol())
        assert not cv.tiene_venta(vacio) and vacio['entregada_epoch'] == 'E1'
        assert vacio['entregada_a']['pc_nombre'] == 'Compu 3'

    def test_cancelar(self):
        assert cv.decidir_cancelacion(self._sol(), 's1') == {'accion': 'cancelar'}
        assert cv.decidir_cancelacion(self._sol(estado='entregada'), 's1') == {'accion': 'llego'}
        assert cv.decidir_cancelacion(self._sol(), 'otra') == {'accion': 'nada'}


class TestListaDeOtrasCajas:
    def test_solo_otras_con_algo_y_con_senales(self):
        docs = {
            'pc1': {**estado('pc1', 'E1', [RENGLON_SIMPLE]), 'actualizado': AHORA},
            'pc2': {**cv.estado_vacio('pc2', 'Compu 2'), 'actualizado': AHORA},
            'pc3': {**estado('pc3', 'E3', [RENGLON_SIMPLE]), 'actualizado': AHORA},
            'pc4': {**estado('pc4', 'E4', [RENGLON_SIMPLE]),
                    'actualizado': AHORA - timedelta(seconds=cv.VIGENCIA_SEG + 1)},
        }
        lista = cv.carritos_de_otras_cajas(docs, 'pc3', AHORA)
        assert [c['pc_id'] for c in lista] == ['pc1']
        assert lista[0]['nombre'] == 'Compu 1'

    def test_compu_2_va_antes_que_compu_10(self):
        docs = {p: {**estado(p, 'E', [RENGLON_SIMPLE]), 'pc_nombre': n, 'actualizado': AHORA}
                for p, n in (('a', 'Compu 10'), ('b', 'Compu 2'), ('c', 'Mercería'))}
        assert [c['nombre'] for c in cv.carritos_de_otras_cajas(docs, 'x', AHORA)] == \
            ['Compu 2', 'Compu 10', 'Mercería']


# ════════════════════════════════════════════════════════════════════════════
# Las mismas reglas corriendo sobre la nube en memoria, paso a paso.
# ════════════════════════════════════════════════════════════════════════════
@pytest.fixture
def nube():
    return NubeCarritosMemoria()


def pedir_y_entregar(nube, origen_pc, epoch, quien, estado_origen, sol_id='s'):
    """Lo que hacen las dos cajas, sin pantalla: una pide, la otra entrega."""
    r = nube.pedir(origen_pc, epoch, quien, sol_id)
    if not r.ok:
        return r
    return nube.entregar(origen_pc, estado_origen['pc_nombre'], sol_id, epoch, estado_origen)


class TestIdaYVuelta:
    def test_la_venta_va_y_vuelve_con_lo_que_se_agrego(self, nube):
        e1 = estado('pc1', 'E1', [RENGLON_SIMPLE], cajero='Ana')
        nube.publicar('pc1', 'Compu 1', 'E1', e1)
        assert pedir_y_entregar(nube, 'pc1', 'E1', QUIEN_3, e1, 's1').ok
        assert not cv.tiene_venta(nube.docs['pc1'])
        assert nube.docs['pc3']['epoch'] == 'E1' and nube.docs['pc3']['cajero'] == 'Ana'
        assert nube.solicitudes['pc1']['estado'] == 'entregada'

        # En la 3 se carga y se agrega mercería; publica (mismo epoch).
        e3 = estado('pc3', 'E1', [RENGLON_SIMPLE, RENGLON_ROLLO], cajero='Ana')
        assert nube.publicar('pc3', 'Compu 3', 'E1', e3).accion == 'escribir'
        assert not nube.docs['pc3']['pendiente_de_cargar']

        # La 1 la pide de vuelta y la 3 se la entrega con el rollo.
        assert pedir_y_entregar(nube, 'pc3', 'E1', QUIEN_1, e3, 's2').ok
        assert len(cv.leer_items(nube.docs['pc1']['items_json'])) == 2
        assert nube.docs['pc1']['cajero'] == 'Ana' and nube.docs['pc1']['pendiente_de_cargar']
        assert not cv.tiene_venta(nube.docs['pc3'])
        # Una publicación vieja de la 3 no la revive.
        assert nube.publicar('pc3', 'Compu 3', 'E1', e3).accion == 'nada'

    def test_nunca_queda_en_dos_cajas(self, nube):
        e = estado('pc1', 'E1', [RENGLON_SIMPLE])
        nube.publicar('pc1', 'Compu 1', 'E1', e)
        for n, (desde, quien) in enumerate((('pc1', QUIEN_3), ('pc3', QUIEN_1), ('pc1', QUIEN_3))):
            assert pedir_y_entregar(nube, desde, 'E1', quien, {**e, 'pc_id': desde}, f's{n}').ok
            nube.publicar(quien['pc_id'], quien['pc_nombre'], 'E1', {**e, 'pc_id': quien['pc_id']})
            assert [p for p, d in nube.docs.items() if cv.tiene_venta(d)] == [quien['pc_id']]

    def test_cobrada_desaparece_de_todos_lados(self, nube):
        e = estado('pc1', 'E1', [RENGLON_SIMPLE])
        nube.publicar('pc1', 'Compu 1', 'E1', e)
        pedir_y_entregar(nube, 'pc1', 'E1', QUIEN_3, e)
        assert nube.publicar('pc3', 'Compu 3', 'E1', None).accion == 'vaciar'
        assert cv.carritos_de_otras_cajas(nube.docs, 'pcX', nube.ahora()) == []


class TestLaOrigenDecide:
    def test_sin_respuesta_no_se_mueve_nada_y_vence(self, nube):
        """La Compu 1 no contesta (sin internet): la 3 cancela y la venta
        sigue en la 1. Aunque la 1 vuelva y vea la solicitud, ya no la cumple."""
        e = estado('pc1', 'E1', [RENGLON_SIMPLE])
        nube.publicar('pc1', 'Compu 1', 'E1', e)
        assert nube.pedir('pc1', 'E1', QUIEN_3, 's1').ok
        assert nube.cancelar('pc1', 's1', _pc='pc3').accion == 'cancelar'
        r = nube.entregar('pc1', 'Compu 1', 's1', 'E1', e)
        assert not r.ok and r.motivo == 'cancelada'
        assert cv.tiene_venta(nube.docs['pc1']) and 'pc3' not in nube.docs

    def test_una_solicitud_vieja_no_se_cumple(self, nube):
        e = estado('pc1', 'E1', [RENGLON_SIMPLE])
        nube.publicar('pc1', 'Compu 1', 'E1', e)
        assert nube.pedir('pc1', 'E1', QUIEN_3, 's1').ok
        nube.adelantar(cv.VALIDEZ_SOLICITUD_SEG + 2)
        r = nube.entregar('pc1', 'Compu 1', 's1', 'E1', e)
        assert not r.ok and r.motivo == 'vencida'
        assert cv.tiene_venta(nube.docs['pc1'])

    def test_rechazo_porque_esta_cobrando(self, nube):
        e = estado('pc1', 'E1', [RENGLON_SIMPLE])
        nube.publicar('pc1', 'Compu 1', 'E1', e)
        assert nube.pedir('pc1', 'E1', QUIEN_3, 's1').ok
        assert nube.rechazar('pc1', 's1', 'La están cobrando en la Compu 1.').accion == 'rechazada'
        assert nube.solicitudes['pc1']['motivo'] == 'La están cobrando en la Compu 1.'
        assert not nube.entregar('pc1', 'Compu 1', 's1', 'E1', e).ok

    def test_la_origen_entrega_su_carrito_mas_nuevo(self, nube):
        """La 3 vio un renglón; la 1 ya tenía dos cuando entregó: llegan dos."""
        nube.publicar('pc1', 'Compu 1', 'E1', estado('pc1', 'E1', [RENGLON_SIMPLE]))
        assert nube.pedir('pc1', 'E1', QUIEN_3, 's1').ok
        mas_nuevo = estado('pc1', 'E1', [RENGLON_SIMPLE, RENGLON_VARIOS])
        assert nube.entregar('pc1', 'Compu 1', 's1', 'E1', mas_nuevo).ok
        assert len(cv.leer_items(nube.docs['pc3']['items_json'])) == 2

    def test_cancelar_justo_cuando_entrega(self, nube):
        """La 3 se cansa de esperar justo cuando la 1 entrega: o se cancela
        (y la 1 no entrega) o llegó (y la 3 la carga). Nunca las dos."""
        e = estado('pc1', 'E1', [RENGLON_SIMPLE])
        nube.publicar('pc1', 'Compu 1', 'E1', e)
        assert nube.pedir('pc1', 'E1', QUIEN_3, 's1').ok
        nube.entre_lectura_y_escritura = lambda _a: nube.entregar('pc1', 'Compu 1', 's1', 'E1', e)
        c = nube.cancelar('pc1', 's1', _pc='pc3')
        assert c.accion == 'llego'
        assert [p for p, d in nube.docs.items() if cv.tiene_venta(d)] == ['pc3']


class TestCarreras:
    def test_dos_cajas_la_piden_a_la_vez(self, nube):
        e = estado('pc1', 'E1', [RENGLON_SIMPLE])
        nube.publicar('pc1', 'Compu 1', 'E1', e)
        r2 = nube.pedir('pc1', 'E1', {'pc_id': 'pc2', 'pc_nombre': 'Compu 2', 'cajero': 'Caro'}, 's2')
        r3 = nube.pedir('pc1', 'E1', QUIEN_3, 's3')
        assert r2.ok and not r3.ok and r3.motivo == 'pedida_por_otra'

    def test_muchas_cajas_pidiendo_a_la_vez_una_sola_queda(self, nube):
        e = estado('pc1', 'E1', [RENGLON_SIMPLE])
        nube.publicar('pc1', 'Compu 1', 'E1', e)
        resultados = {}

        def intentar(pc):
            resultados[pc] = nube.pedir('pc1', 'E1', {'pc_id': pc, 'pc_nombre': pc, 'cajero': 'x'}, pc)

        hilos = [threading.Thread(target=intentar, args=(f'pc{n}',)) for n in range(2, 7)]
        for h in hilos:
            h.start()
        for h in hilos:
            h.join()
        ganadores = [pc for pc, r in resultados.items() if r.ok]
        assert len(ganadores) == 1
        assert nube.solicitudes['pc1']['de']['pc_id'] == ganadores[0]
        assert nube.entregar('pc1', 'Compu 1', ganadores[0], 'E1', e).ok
        assert [p for p, d in nube.docs.items() if cv.tiene_venta(d)] == ganadores

    def test_la_origen_publica_mientras_entrega(self, nube):
        """La publicación de la origen que estaba en la fila llega después de
        entregar: no escribe nada."""
        e = estado('pc1', 'E1', [RENGLON_SIMPLE])
        nube.publicar('pc1', 'Compu 1', 'E1', e)
        nube.pedir('pc1', 'E1', QUIEN_3, 's1')
        nube.entre_lectura_y_escritura = lambda _a: nube.publicar(
            'pc1', 'Compu 1', 'E1', estado('pc1', 'E1', [RENGLON_SIMPLE, RENGLON_VARIOS]))
        assert nube.entregar('pc1', 'Compu 1', 's1', 'E1', e).ok
        assert nube.publicar('pc1', 'Compu 1', 'E1', e).accion == 'nada'
        assert [p for p, d in nube.docs.items() if cv.tiene_venta(d)] == ['pc3']
