"""
El motor de promociones, contra cualquier cosa que le llegue.

`Promotion.calculate_promo_for_cart_item` lo llaman tres puertas distintas: el
carrito del POS, las promos cargadas en la base local y las que bajan del panel
por Firestore. Basta con que una deje pasar un número raro para que la caja
cobre de más o el carrito reviente en el mostrador, así que el saneo vive en el
motor y esta prueba lo recorre entero.

La regla que no se puede romper nunca: **la plata no se crea ni se pierde**. Lo
que paga el cliente más lo que se le descontó tiene que dar exactamente lo que
salía la línea sin promo.
"""
import itertools
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.models.promotion import Promotion

aplicar = Promotion.calculate_promo_for_cart_item


def promo(tipo, valor=0, req=1, free=0, maximo=0):
    return {'promo_type': tipo, 'discount_value': valor, 'required_quantity': req,
            'free_quantity': free, 'max_quantity': maximo, 'name': 'Promo'}


# ── Lo que tiene que dar ──────────────────────────────────────────────────

class TestCuentas:
    def test_porcentaje(self):
        eff, disc, _ = aplicar(promo('percentage', valor=20), 2, 1000.0)
        assert (eff, disc) == (800.0, 400.0)

    def test_descuento_fijo_por_unidad(self):
        eff, disc, _ = aplicar(promo('fixed', valor=150), 3, 1000.0)
        assert (eff, disc) == (850.0, 450.0)

    def test_2x1(self):
        eff, disc, _ = aplicar(promo('2x1'), 4, 1000.0)
        assert disc == 2000.0
        assert eff == 500.0

    def test_2x1_con_una_suelta_que_sobra(self):
        # Lleva 3: paga 2 del par + 1 suelta.
        _eff, disc, _ = aplicar(promo('2x1'), 3, 1000.0)
        assert disc == 1000.0

    def test_lleva_3_paga_2(self):
        _eff, disc, _ = aplicar(promo('nxm', req=3, free=1), 6, 1000.0)
        assert disc == 2000.0

    def test_combo_a_precio_fijo(self):
        # Pack de 2 a $1.500 sobre un producto de $1.000: se ahorran $500.
        _eff, disc, _ = aplicar(promo('bundle', valor=1500, req=2), 2, 1000.0)
        assert disc == 500.0

    def test_el_tope_limita_las_unidades_con_descuento(self):
        _eff, disc, _ = aplicar(promo('percentage', valor=50, maximo=2), 10, 1000.0)
        assert disc == 1000.0     # sólo 2 unidades al 50%

    def test_el_tope_limita_los_packs(self):
        _eff, disc, _ = aplicar(promo('2x1', maximo=1), 6, 1000.0)
        assert disc == 1000.0     # un solo par gratis


# ── Lo que no puede pasar nunca ───────────────────────────────────────────

class TestBlindaje:
    def test_un_combo_sin_cantidad_requerida_no_rompe_la_venta(self):
        """Dividía por cero y se caía el carrito con el cliente enfrente."""
        assert aplicar(promo('bundle', valor=500, req=0), 3, 1000.0) == (1000.0, 0.0, "")

    def test_un_descuento_negativo_no_encarece_el_producto(self):
        """`min(-5, 100)` daba -5% y el cliente pagaba 5% MÁS que la lista."""
        assert aplicar(promo('percentage', valor=-5), 2, 1000.0) == (1000.0, 0.0, "")
        assert aplicar(promo('fixed', valor=-50), 2, 1000.0) == (1000.0, 0.0, "")

    def test_un_combo_mas_caro_que_lo_suelto_se_ignora(self):
        # Pack de 2 a $3.000 cuando sueltos salen $2.000: no se cobra el pack.
        assert aplicar(promo('bundle', valor=3000, req=2), 2, 1000.0) == (1000.0, 0.0, "")

    def test_llevar_menos_que_lo_pedido_no_descuenta(self):
        assert aplicar(promo('bundle', valor=1500, req=5), 2, 1000.0) == (1000.0, 0.0, "")
        assert aplicar(promo('2x1'), 1, 1000.0)[1] == 0.0

    def test_un_nxm_que_regala_todo_no_aplica(self):
        assert aplicar(promo('nxm', req=2, free=2), 4, 1000.0) == (1000.0, 0.0, "")

    def test_un_tipo_desconocido_deja_el_precio_de_lista(self):
        assert aplicar(promo('trueque', valor=50), 2, 1000.0) == (1000.0, 0.0, "")

    def test_el_porcentaje_no_pasa_de_cien(self):
        eff, disc, _ = aplicar(promo('percentage', valor=500), 1, 1000.0)
        assert (eff, disc) == (0.0, 1000.0)


# ── La propiedad, sobre todas las combinaciones ───────────────────────────

TIPOS   = ['percentage', 'fixed', '2x1', 'nxm', 'bundle']
VALORES = [0, 1, 10, 50, 100, 150, 999999, -5]
REQS    = [0, 1, 2, 3, 5]
FREES   = [0, 1, 2, 5]
MAXS    = [0, 1, 2, 10]
CANTS   = [1, 2, 3, 6, 7, 100]
PRECIOS = [1000.0, 3333.33]


def test_la_plata_nunca_se_crea_ni_se_pierde():
    """Recorre las 38.400 formas de cargar una promo.

    Sobre cada una: el descuento no puede ser negativo ni mayor que la línea,
    el precio efectivo no puede superar al de lista, y lo pagado más lo
    descontado tiene que dar lo que salía sin promo.
    """
    problemas = []
    for tipo, val, req, free, mx, qty, precio in itertools.product(
            TIPOS, VALORES, REQS, FREES, MAXS, CANTS, PRECIOS):
        p = promo(tipo, val, req, free, mx)
        caso = f"{tipo} val={val} req={req} free={free} max={mx} qty={qty} precio={precio}"
        try:
            eff, disc, _label = aplicar(p, qty, precio)
        except Exception as e:
            problemas.append(f"{type(e).__name__}: {e} · {caso}")
            continue
        bruto = qty * precio
        if disc < -0.005:
            problemas.append(f"descuento negativo ({disc}) · {caso}")
        elif disc > bruto + 0.005:
            problemas.append(f"descuento mayor que la línea ({disc} > {bruto}) · {caso}")
        elif eff < 0:
            problemas.append(f"precio efectivo negativo ({eff}) · {caso}")
        elif eff > precio + 0.005:
            problemas.append(f"la promo encarece el producto ({eff} > {precio}) · {caso}")
        elif abs(eff * qty + disc - bruto) > 0.05:
            problemas.append(f"no cierra: {eff * qty:.2f} + {disc:.2f} != {bruto:.2f} · {caso}")

    assert not problemas, (
        f"{len(problemas)} combinaciones rompen la cuenta. Primeras:\n  "
        + '\n  '.join(problemas[:5])
    )
