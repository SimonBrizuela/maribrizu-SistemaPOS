"""
Pago Mixto: la venta que cobra una parte en mano y otra por transferencia.

Es el caso que rompía la caja. El sistema la trataba como si fuera de un solo
medio de pago y eso salía por todos lados a la vez:

  · el cierre no la contaba (dos ventas figuraban como una),
  · la parte transferida se sumaba al efectivo esperado, así que el cajón
    aparecía debiendo una plata que había entrado por el banco,
  · y editarla desde el Historial la convertía en transferencia sin avisar,
    dejando la caja con efectivo de una venta que ya no lo tenía.

Estas pruebas son la venta mixta mirada desde el mostrador: se cobra, se cierra
la caja, se corrige un precio, y los números tienen que seguir cerrando.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.database.db_manager import DatabaseManager
from pos_system.models.cash_register import CashRegister
from pos_system.models.product import Product
from pos_system.models.sale import Sale
from pos_system.utils import medios_de_pago


@pytest.fixture
def db(tmp_path):
    # Una base por prueba: en Windows el archivo queda tomado un rato después
    # de cerrarlo y reusar el mismo nombre hace fallar a la prueba siguiente.
    base = DatabaseManager(str(tmp_path / 'pago_mixto.db'))
    base.initialize_database()
    yield base


@pytest.fixture
def local(db):
    """Un local con la caja abierta y algo para vender."""
    caja = CashRegister(db)
    reg = caja.open_register(initial_amount=1000.0)
    pid = Product(db).create({'name': 'Cuaderno', 'price': 5000.0, 'stock': 100})
    return {'db': db, 'caja': caja, 'ventas': Sale(db), 'productos': Product(db),
            'reg': reg, 'pid': pid}


def vender_mixto(local, total=10000.0, efectivo=4000.0, transferencia=6000.0,
                 cantidad=2, precio=5000.0):
    return local['ventas'].create({
        'total_amount': total, 'payment_type': 'mixed',
        'cash_received': efectivo, 'change_given': 0.0,
        'transfer_amount': transferencia,
        'items': [{'product_id': local['pid'], 'product_name': 'Cuaderno',
                   'quantity': cantidad, 'unit_price': precio}],
    })


# ── El reparto ────────────────────────────────────────────────────────────

class TestReparto:
    def test_la_parte_transferida_no_es_efectivo(self):
        ef, tr = medios_de_pago.partes_de_venta({
            'payment_type': 'mixed', 'total_amount': 10000,
            'cash_received': 4000, 'change_given': 0, 'transfer_amount': 6000,
        })
        assert (ef, tr) == (4000.0, 6000.0)

    def test_el_vuelto_sale_del_cajon(self):
        # Entregó 5.000 y se llevó 1.000 de vuelto: en la caja quedaron 4.000.
        ef, tr = medios_de_pago.partes_de_venta({
            'payment_type': 'mixed', 'total_amount': 10000,
            'cash_received': 5000, 'change_given': 1000, 'transfer_amount': 6000,
        })
        assert (ef, tr) == (4000.0, 6000.0)

    def test_una_mixta_sin_desglose_no_inventa_efectivo(self):
        ef, tr = medios_de_pago.partes_de_venta({
            'payment_type': 'mixed', 'total_amount': 2000,
        })
        assert (ef, tr) == (0.0, 2000.0)

    def test_el_prorrateo_no_pierde_un_centavo(self):
        partes = medios_de_pago.repartir_subtotales([1, 1, 1], 1.0, 2.0)
        assert sum(ef for ef, _ in partes) == pytest.approx(1.0)
        assert sum(tr for _, tr in partes) == pytest.approx(2.0)

    def test_un_renglon_viejo_sin_reparto_sigue_contando_como_antes(self):
        # No se toca el pasado: los cierres ya firmados tienen que seguir dando
        # lo mismo que dieron.
        assert medios_de_pago.reparto_de_item({'subtotal': 800}) == (800.0, 0.0)
        assert medios_de_pago.reparto_de_item(
            {'tipo_pago': 'Transferencia', 'subtotal': 800}) == (0.0, 800.0)


# ── El cierre de caja ─────────────────────────────────────────────────────

class TestCierreDeCaja:
    def test_la_caja_separa_las_dos_partes_al_vender(self, local):
        vender_mixto(local)
        caja = local['caja'].get_by_id(local['reg'])
        assert caja['cash_sales'] == 4000.0
        assert caja['transfer_sales'] == 6000.0
        assert caja['total_sales'] == 10000.0

    def test_el_cierre_no_pierde_la_venta_mixta(self, local):
        local['ventas'].create({
            'total_amount': 5000.0, 'payment_type': 'cash', 'cash_received': 5000.0,
            'items': [{'product_id': local['pid'], 'product_name': 'Cuaderno',
                       'quantity': 1, 'unit_price': 5000.0}]})
        vender_mixto(local)

        reporte = local['caja'].get_closing_report(local['reg'])
        # Hubo dos ventas. Antes el cierre decía una: la mixta no entraba en
        # ninguna de las dos columnas y desaparecía del total.
        assert reporte['total_sales_count'] == 2
        assert reporte['num_mixed_sales'] == 1
        # La mixta dejó plata de los dos lados, así que cuenta en las dos.
        assert reporte['num_cash_sales'] == 2
        assert reporte['num_transfer_sales'] == 1

    def test_el_resumen_del_dia_reparte_la_mixta(self, local):
        """Las tarjetas EFECTIVO y VIRTUAL del panel del POS.

        La mixta no entraba en ninguna de las dos consultas, así que las dos
        tarjetas juntas no llegaban al total del día.
        """
        vender_mixto(local)
        res = local['ventas'].get_sales_summary()
        assert res['cash_amount'] == 4000.0
        assert res['transfer_amount'] == 6000.0
        assert res['cash_amount'] + res['transfer_amount'] == pytest.approx(res['total_amount'])

    def test_el_efectivo_esperado_es_el_que_hay_en_el_cajon(self, local):
        vender_mixto(local)
        reporte = local['caja'].get_closing_report(local['reg'])
        # 1.000 de apertura + 4.000 cobrados en mano. Los 6.000 transferidos
        # no están en el cajón.
        assert reporte['expected_amount'] == 5000.0


# ── Editar una venta mixta desde el Historial ─────────────────────────────

class TestEditarVentaMixta:
    def test_corregir_un_precio_deja_la_caja_cuadrada(self, local):
        sid = vender_mixto(local)
        item_id = local['ventas'].get_by_id(sid)['items'][0]['id']

        # El cajero se equivocó de precio: eran 3.500 cada uno, no 5.000.
        local['ventas'].update(sale_id=sid, payment_type='mixed',
                               items_updates=[{'id': item_id, 'unit_price': 3500.0}])

        caja = local['caja'].get_by_id(local['reg'])
        venta = local['ventas'].get_by_id(sid)
        assert venta['total_amount'] == 7000.0
        assert venta['payment_type'] == 'mixed'
        # Los 4.000 en mano ya están contados en el cajón: no se tocan. Lo que
        # se ajusta es la transferencia, que se verifica contra el banco.
        assert caja['cash_sales'] == 4000.0
        assert caja['transfer_sales'] == 3000.0
        assert caja['cash_sales'] + caja['transfer_sales'] == pytest.approx(caja['total_sales'])

    def test_si_el_total_nuevo_no_cubre_el_efectivo_la_venta_pasa_a_efectivo(self, local):
        """Una venta de $2.000 no puede tener $4.000 cobrados en mano.

        Cuando la corrección deja el total por debajo del efectivo cobrado, la
        venta queda entera en efectivo: el número imposible es la parte
        transferida, no la plata que se contó.
        """
        sid = vender_mixto(local)
        item_id = local['ventas'].get_by_id(sid)['items'][0]['id']
        local['ventas'].update(sale_id=sid, payment_type='mixed',
                               items_updates=[{'id': item_id, 'unit_price': 1000.0}])

        caja = local['caja'].get_by_id(local['reg'])
        assert local['ventas'].get_by_id(sid)['total_amount'] == 2000.0
        assert caja['cash_sales'] == 2000.0
        assert caja['transfer_sales'] == 0.0
        assert caja['cash_sales'] + caja['transfer_sales'] == pytest.approx(caja['total_sales'])

    def test_pasarla_a_transferencia_le_saca_el_efectivo_a_la_caja(self, local):
        sid = vender_mixto(local)
        local['ventas'].update(sale_id=sid, payment_type='transfer')

        caja = local['caja'].get_by_id(local['reg'])
        # La venta ya no tiene parte en efectivo: la caja tampoco.
        assert caja['cash_sales'] == 0.0
        assert caja['transfer_sales'] == 10000.0
        assert caja['total_sales'] == 10000.0

    def test_pasarla_a_efectivo_pone_todo_en_el_cajon(self, local):
        sid = vender_mixto(local)
        local['ventas'].update(sale_id=sid, payment_type='cash')

        caja = local['caja'].get_by_id(local['reg'])
        assert caja['cash_sales'] == 10000.0
        assert caja['transfer_sales'] == 0.0

    def test_editar_una_venta_comun_sigue_funcionando_igual(self, local):
        sid = local['ventas'].create({
            'total_amount': 5000.0, 'payment_type': 'cash', 'cash_received': 5000.0,
            'items': [{'product_id': local['pid'], 'product_name': 'Cuaderno',
                       'quantity': 1, 'unit_price': 5000.0}]})
        item_id = local['ventas'].get_by_id(sid)['items'][0]['id']

        local['ventas'].update(sale_id=sid, payment_type='transfer',
                               items_updates=[{'id': item_id, 'unit_price': 4000.0}])

        caja = local['caja'].get_by_id(local['reg'])
        assert caja['cash_sales'] == 0.0
        assert caja['transfer_sales'] == 4000.0
        assert caja['total_sales'] == 4000.0

    def test_la_caja_nunca_queda_en_negativo(self, local):
        """El síntoma que delataba el problema.

        Editar una venta mixta bajándole el total dejaba `transfer_sales` en
        menos: se le restaba el total entero a la transferencia cuando ahí solo
        había entrado una parte.
        """
        sid = vender_mixto(local)
        item_id = local['ventas'].get_by_id(sid)['items'][0]['id']
        local['ventas'].update(sale_id=sid, payment_type='transfer',
                               items_updates=[{'id': item_id, 'unit_price': 100.0}])

        caja = local['caja'].get_by_id(local['reg'])
        assert caja['cash_sales'] >= 0
        assert caja['transfer_sales'] >= 0
        assert caja['cash_sales'] + caja['transfer_sales'] == pytest.approx(caja['total_sales'])
