"""
Productos Madre: cómo sale el precio de lo que se vende cortado o fraccionado.

Es lo que hay detrás del diálogo violeta de la caja. Un producto madre tiene un
árbol de nodos (marca → línea → artículo) y cada hoja tiene presentaciones: el
rollo entero, el metro suelto, la caja. Elegir mal el precio se cobra distinto
en cada venta y nadie se entera hasta que no cierra el margen del mes.

Las dos reglas que deciden todo:

  · el descuento es un **override puro**: gana el más específico —presentación,
    después el nodo, después sus padres, y último el producto madre—. El primero
    que coincide cierra; no se suman;
  · el corte a medida sin precio propio se calcula desde el contenedor, con un
    margen del 15%: media docena suelta no puede salir a precio de docena.
"""
import os
import sys
from datetime import datetime

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.models.mother_product import (
    Discount, FRACCION_MARGIN, aplicar_descuento, descuento_efectivo,
    node_precio_venta, precio_efectivo_presentacion,
)


def desc(scope_type, scope_id, valor=10, tipo='porcentaje', prioridad=0,
         activo=True, **extra):
    return {'id': f'd-{scope_type}-{scope_id}-{valor}', 'scope_type': scope_type,
            'scope_id': scope_id, 'tipo': tipo, 'valor': valor,
            'prioridad': prioridad, 'activo': activo, **extra}


PRODUCTO = {'id': 'mp1', 'nombre': 'CINTA DE RASO'}
# path = [producto, ancestro, ..., hoja]
NODO = {'id': 'n-hoja', 'path': ['mp1', 'n-marca', 'n-hoja'], 'precio_venta': 1000}
PRESENTACION = {'id': 'p-metro', 'nombre': 'Metro'}


# ── Cuál descuento gana ──────────────────────────────────────────────────────

class TestQueDescuentoGana:

    def test_sin_descuentos_no_hay_ninguno(self):
        assert descuento_efectivo(PRODUCTO, NODO, PRESENTACION, [], []) is None

    def test_el_de_la_presentacion_le_gana_a_todo(self):
        # Es el más específico: el precio del metro suelto no lo decide una
        # promoción de toda la marca.
        d = descuento_efectivo(PRODUCTO, NODO, PRESENTACION, [], [
            desc('product', 'mp1', 50),
            desc('node', 'n-hoja', 30),
            desc('presentation', 'p-metro', 10),
        ])
        assert d['valor'] == 10

    def test_sin_uno_de_presentacion_manda_el_del_nodo(self):
        d = descuento_efectivo(PRODUCTO, NODO, PRESENTACION, [], [
            desc('product', 'mp1', 50),
            desc('node', 'n-hoja', 30),
        ])
        assert d['valor'] == 30

    def test_la_hoja_le_gana_a_su_marca(self):
        # Los ancestros se recorren de la hoja hacia arriba.
        d = descuento_efectivo(PRODUCTO, NODO, PRESENTACION, [], [
            desc('node', 'n-marca', 40),
            desc('node', 'n-hoja', 15),
        ])
        assert d['valor'] == 15

    def test_si_la_hoja_no_tiene_hereda_el_de_la_marca(self):
        d = descuento_efectivo(PRODUCTO, NODO, PRESENTACION, [], [
            desc('node', 'n-marca', 40),
        ])
        assert d['valor'] == 40

    def test_el_del_producto_madre_es_el_ultimo_recurso(self):
        d = descuento_efectivo(PRODUCTO, NODO, PRESENTACION, [], [
            desc('product', 'mp1', 5),
        ])
        assert d['valor'] == 5

    def test_no_se_suman_dos_descuentos(self):
        # Override puro: el primero que coincide cierra.
        d = descuento_efectivo(PRODUCTO, NODO, PRESENTACION, [], [
            desc('presentation', 'p-metro', 10),
            desc('node', 'n-hoja', 30),
            desc('product', 'mp1', 50),
        ])
        assert d['valor'] == 10

    def test_empatados_en_el_mismo_nivel_gana_el_de_mas_prioridad(self):
        d = descuento_efectivo(PRODUCTO, NODO, PRESENTACION, [], [
            desc('node', 'n-hoja', 10, prioridad=1),
            desc('node', 'n-hoja', 25, prioridad=9),
        ])
        assert d['valor'] == 25

    def test_uno_apagado_no_cuenta_y_deja_pasar_al_de_abajo(self):
        d = descuento_efectivo(PRODUCTO, NODO, PRESENTACION, [], [
            desc('presentation', 'p-metro', 10, activo=False),
            desc('node', 'n-hoja', 30),
        ])
        assert d['valor'] == 30

    def test_un_descuento_de_otro_producto_no_se_cuela(self):
        assert descuento_efectivo(PRODUCTO, NODO, PRESENTACION, [], [
            desc('node', 'n-de-otro', 90),
            desc('product', 'mp-otro', 90),
        ]) is None

    def test_sin_presentacion_elegida_arranca_por_el_nodo(self):
        d = descuento_efectivo(PRODUCTO, NODO, None, [], [
            desc('presentation', 'p-metro', 10),
            desc('node', 'n-hoja', 30),
        ])
        assert d['valor'] == 30


class TestDescuentoPorCantidad:

    def test_no_aplica_si_no_se_llega_al_minimo(self):
        # "Llevando 10 o más": con 3 no corresponde.
        d = descuento_efectivo(PRODUCTO, NODO, PRESENTACION, [], [
            desc('node', 'n-hoja', 20, tipo='por_cantidad', cantidad_min=10),
        ], cantidad=3)
        assert d is None

    def test_aplica_justo_en_el_minimo(self):
        d = descuento_efectivo(PRODUCTO, NODO, PRESENTACION, [], [
            desc('node', 'n-hoja', 20, tipo='por_cantidad', cantidad_min=10),
        ], cantidad=10)
        assert d['valor'] == 20

    def test_sin_llegar_al_minimo_cae_al_de_mas_arriba(self):
        d = descuento_efectivo(PRODUCTO, NODO, PRESENTACION, [], [
            desc('node', 'n-hoja', 20, tipo='por_cantidad', cantidad_min=10),
            desc('product', 'mp1', 5),
        ], cantidad=2)
        assert d['valor'] == 5


class TestVigencia:

    def test_uno_apagado_nunca_vale(self):
        assert Discount.vigente_hoy(desc('node', 'x', activo=False)) is False

    def test_sin_fechas_vale_siempre(self):
        assert Discount.vigente_hoy(desc('node', 'x')) is True

    def test_todavia_no_empezo(self):
        d = desc('node', 'x', desde='2030-01-01')
        assert Discount.vigente_hoy(d, hoy=datetime(2026, 8, 28)) is False

    def test_ya_termino(self):
        d = desc('node', 'x', hasta='2026-08-27')
        assert Discount.vigente_hoy(d, hoy=datetime(2026, 8, 28, 10, 0)) is False

    def test_el_ultimo_dia_vale_entero(self):
        # Termina el 28: a las 23:00 del 28 todavía corresponde.
        d = desc('node', 'x', hasta='2026-08-28')
        assert Discount.vigente_hoy(d, hoy=datetime(2026, 8, 28, 23, 0)) is True

    def test_adentro_del_rango(self):
        d = desc('node', 'x', desde='2026-08-01', hasta='2026-08-31')
        assert Discount.vigente_hoy(d, hoy=datetime(2026, 8, 28)) is True

    def test_una_fecha_mal_escrita_no_apaga_el_descuento(self):
        # Ante un dato roto se deja pasar: cobrar de más por un campo mal
        # cargado se lo lleva el cliente.
        d = desc('node', 'x', desde='ayer')
        assert Discount.vigente_hoy(d, hoy=datetime(2026, 8, 28)) is True


# ── Cuánto sale ──────────────────────────────────────────────────────────────

class TestPrecioDelNodo:

    def test_del_espejo_local_plano(self):
        assert node_precio_venta({'precio_venta': 1200}) == 1200.0

    def test_del_documento_de_firestore_anidado(self):
        assert node_precio_venta({'precio': {'venta': 1200, 'costo': 900}}) == 1200.0

    def test_el_plano_le_gana_al_anidado(self):
        assert node_precio_venta({'precio_venta': 1500,
                                  'precio': {'venta': 1200}}) == 1500.0

    def test_sin_precio_es_cero_y_no_revienta(self):
        assert node_precio_venta({}) == 0.0
        assert node_precio_venta({'precio_venta': ''}) == 0.0
        assert node_precio_venta({'precio_venta': 'mil'}) == 0.0


class TestPrecioDeUnaPresentacion:

    def test_el_precio_propio_manda(self):
        nodo = {'precio_venta': 1000, 'presentaciones': []}
        p = {'id': 'p1', 'precio_venta': 250}
        assert precio_efectivo_presentacion(nodo, p) == 250.0

    def test_el_corte_a_medida_se_calcula_del_rollo_con_su_margen(self):
        # Un rollo de 50 m a $10.000 son $200 el metro; suelto sale con el 15%
        # extra, que es lo que cuesta cortarlo y venderlo de a uno.
        nodo = {
            'precio_venta': 0,
            'presentaciones': [
                {'id': 'rollo', 'precio_venta': 10000, 'equivalencia_base': 50},
                {'id': 'metro', 'stock_modo': 'vinculado', 'vinculada_a': 'rollo'},
            ],
        }
        metro = nodo['presentaciones'][1]
        assert precio_efectivo_presentacion(nodo, metro) == pytest.approx(
            10000 / 50 * FRACCION_MARGIN)

    def test_con_precio_propio_no_se_calcula_nada(self):
        nodo = {
            'precio_venta': 0,
            'presentaciones': [
                {'id': 'rollo', 'precio_venta': 10000, 'equivalencia_base': 50},
                {'id': 'metro', 'stock_modo': 'vinculado', 'vinculada_a': 'rollo',
                 'precio_venta': 300},
            ],
        }
        assert precio_efectivo_presentacion(nodo, nodo['presentaciones'][1]) == 300.0

    def test_si_el_contenedor_no_esta_cae_al_precio_del_nodo(self):
        # Sin esto la presentación saldría a cero y se regalaría el producto.
        nodo = {'precio_venta': 900, 'presentaciones': [
            {'id': 'metro', 'stock_modo': 'vinculado', 'vinculada_a': 'no-existe'},
        ]}
        assert precio_efectivo_presentacion(nodo, nodo['presentaciones'][0]) == 900.0

    def test_un_contenedor_sin_equivalencia_tampoco_deja_precio_cero(self):
        nodo = {'precio_venta': 900, 'presentaciones': [
            {'id': 'rollo', 'precio_venta': 10000},
            {'id': 'metro', 'stock_modo': 'vinculado', 'vinculada_a': 'rollo'},
        ]}
        assert precio_efectivo_presentacion(nodo, nodo['presentaciones'][1]) == 900.0

    def test_una_presentacion_comun_usa_el_precio_del_nodo(self):
        nodo = {'precio_venta': 1000, 'presentaciones': [{'id': 'unidad'}]}
        assert precio_efectivo_presentacion(nodo, {'id': 'unidad'}) == 1000.0


class TestAplicarElDescuento:

    def test_sin_descuento_el_precio_queda_igual(self):
        assert aplicar_descuento(1000, None) == (1000.0, 0.0, '')

    def test_un_porcentaje_baja_lo_que_dice(self):
        final, monto, etiqueta = aplicar_descuento(1000, {'tipo': 'porcentaje', 'valor': 20})
        assert final == pytest.approx(800.0)
        assert monto == pytest.approx(200.0)
        assert '20' in etiqueta

    def test_un_monto_fijo_resta_los_pesos(self):
        final, monto, etiqueta = aplicar_descuento(1000, {'tipo': 'monto_fijo', 'valor': 150})
        assert final == pytest.approx(850.0)
        assert monto == pytest.approx(150.0)
        assert '150' in etiqueta

    def test_un_monto_fijo_mayor_al_precio_no_lo_deja_en_negativo(self):
        # Regalarlo ya es malo; devolver plata es peor.
        final, monto, _ = aplicar_descuento(100, {'tipo': 'monto_fijo', 'valor': 500})
        assert final == 0.0
        assert monto == 100.0

    def test_el_por_cantidad_y_el_por_fecha_son_porcentajes(self):
        for tipo in ('por_cantidad', 'por_fecha'):
            final, _, _ = aplicar_descuento(1000, {'tipo': tipo, 'valor': 10})
            assert final == pytest.approx(900.0)

    def test_un_tipo_desconocido_no_toca_el_precio(self):
        assert aplicar_descuento(1000, {'tipo': 'inventado', 'valor': 50}) == (1000.0, 0.0, '')

    def test_sobre_un_precio_cero_no_hace_nada(self):
        assert aplicar_descuento(0, {'tipo': 'porcentaje', 'valor': 20}) == (0.0, 0.0, '')

    def test_la_etiqueta_no_muestra_decimales_de_mas(self):
        # Sale en pantalla al lado del precio: "−10%" y no "−10.0%".
        _, _, etiqueta = aplicar_descuento(1000, {'tipo': 'porcentaje', 'valor': 10.0})
        assert etiqueta == '−10%'
