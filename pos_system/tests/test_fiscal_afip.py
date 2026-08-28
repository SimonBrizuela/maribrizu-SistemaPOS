"""
La parte de la facturación electrónica que se puede probar sin AFIP enfrente.

Pedir el CAE necesita red, certificado y el servicio de ARCA arriba, así que
eso no se prueba acá. Lo que sí se prueba es la cuenta que viaja adentro del
comprobante: si el neto más el IVA no dan exactamente el total, AFIP rechaza la
factura, y el cliente queda esperando en el mostrador con una que no salió.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from pos_system.utils.afip_wsfe import (
    calcular_iva_neto, _mapear_condicion_iva_constancia,
)


class TestIva:
    def test_el_caso_de_manual(self):
        assert calcular_iva_neto(1210.0, 21.0) == (1000.0, 210.0)

    def test_alicuota_reducida(self):
        neto, iva = calcular_iva_neto(1105.0, 10.5)
        assert (neto, iva) == (1000.0, 105.0)

    def test_sin_iva_el_total_es_todo_neto(self):
        assert calcular_iva_neto(1000.0, 0.0) == (1000.0, 0.0)

    def test_el_neto_mas_el_iva_da_el_total_exacto(self):
        """La condición que hace que AFIP acepte el comprobante.

        Se recorren importes con centavos feos a propósito: son los que caen
        justo en el medio del redondeo y descuadran la factura por un peso.
        """
        problemas = []
        for centavos in range(1, 20000, 7):        # ~2.850 importes distintos
            total = round(centavos / 100.0, 2)
            for alicuota in (21.0, 10.5, 27.0):
                neto, iva = calcular_iva_neto(total, alicuota)
                if round(neto + iva, 2) != total:
                    problemas.append(f'${total} al {alicuota}%: {neto} + {iva}')
                if neto < 0 or iva < 0:
                    problemas.append(f'negativo en ${total} al {alicuota}%')
        assert not problemas, f'{len(problemas)} importes no cierran. Primeros: {problemas[:5]}'

    def test_un_total_en_cero_no_rompe(self):
        assert calcular_iva_neto(0.0, 21.0) == (0.0, 0.0)


class Impuesto:
    """Lo que devuelve el padrón de AFIP, con lo justo para decidir."""
    def __init__(self, id_impuesto, estado='AC'):
        self.idImpuesto = id_impuesto
        self.estadoImpuesto = estado


class Persona:
    def __init__(self, monotributo=None, regimen=None):
        self.datosMonotributo = monotributo
        self.datosRegimenGeneral = regimen


class Bloque:
    def __init__(self, impuestos):
        self.impuesto = impuestos


class TestCondicionFrenteAlIva:
    """De acá sale qué tipo de comprobante corresponde emitirle al cliente."""

    def test_monotributista(self):
        p = Persona(monotributo=Bloque([Impuesto(20)]))
        assert _mapear_condicion_iva_constancia(p) == 'Monotributista'

    def test_responsable_inscripto(self):
        p = Persona(regimen=Bloque([Impuesto(30)]))
        assert _mapear_condicion_iva_constancia(p) == 'Responsable Inscripto'

    def test_exento(self):
        p = Persona(regimen=Bloque([Impuesto(32)]))
        assert _mapear_condicion_iva_constancia(p) == 'Exento'

    def test_el_monotributo_le_gana_al_regimen_general(self):
        p = Persona(monotributo=Bloque([Impuesto(20)]), regimen=Bloque([Impuesto(30)]))
        assert _mapear_condicion_iva_constancia(p) == 'Monotributista'

    def test_un_impuesto_dado_de_baja_no_cuenta(self):
        p = Persona(monotributo=Bloque([Impuesto(20, estado='BA')]))
        assert _mapear_condicion_iva_constancia(p) == 'Consumidor Final'

    def test_sin_datos_es_consumidor_final(self):
        assert _mapear_condicion_iva_constancia(Persona()) == 'Consumidor Final'
        assert _mapear_condicion_iva_constancia(None) == 'Consumidor Final'

    def test_una_respuesta_rara_no_tumba_la_facturacion(self):
        """El padrón cambió de forma alguna vez. Antes que reventar en medio de
        una factura, se cae a Consumidor Final."""
        class Rara:
            datosMonotributo = 'no es un objeto'
            datosRegimenGeneral = 12345
        assert _mapear_condicion_iva_constancia(Rara()) == 'Consumidor Final'
