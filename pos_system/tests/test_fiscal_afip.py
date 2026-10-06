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


# ── Lo que viaja a ARCA en cada comprobante (06-10) ─────────────────────────

from types import SimpleNamespace

from pos_system.utils.afip_wsfe import (
    AfipWsfe, AFIPError, AFIPSinRespuesta, condicion_iva_receptor_id,
    documento_receptor, iva_contenido_de,
)


class TestDocumentoDelCliente:
    def test_sin_documento_es_consumidor_final_sin_identificar(self):
        assert documento_receptor(None) == (99, 0)
        assert documento_receptor('') == (99, 0)
        assert documento_receptor('0') == (99, 0)

    def test_cuit_con_guiones(self):
        assert documento_receptor('20-12345678-9') == (80, 20123456789)

    def test_dni(self):
        assert documento_receptor('35108063') == (96, 35108063)
        assert documento_receptor('1234567') == (96, 1234567)

    def test_consumidor_final_con_cuit_va_como_cuit(self):
        """El caso del error 10015: lo decide el número, no el combo."""
        assert documento_receptor('30710106319') == (80, 30710106319)

    def test_numero_que_no_es_cuit_ni_dni_avisa(self):
        with pytest.raises(AFIPError):
            documento_receptor('12345')


class TestCondicionIvaReceptor:
    def test_codigos_de_arca(self):
        assert condicion_iva_receptor_id('Consumidor Final') == 5
        assert condicion_iva_receptor_id('Responsable Inscripto') == 1
        assert condicion_iva_receptor_id('Monotributista') == 6
        assert condicion_iva_receptor_id('Exento') == 4

    def test_lo_desconocido_es_consumidor_final(self):
        assert condicion_iva_receptor_id('CF') == 5
        assert condicion_iva_receptor_id(None) == 5


class TestIvaContenido:
    def test_factura_c_siempre_cero(self):
        assert iva_contenido_de('FAC. ELEC. C', 5519.01) == 0.0
        assert iva_contenido_de('NOTA CRED. C', 100) == 0.0

    def test_factura_b_conserva_el_iva(self):
        assert iva_contenido_de('FAC. ELEC. B', 173.55) == 173.55


class _Wsfe:
    """Cliente WSFE falso: guarda el pedido y contesta lo que se le diga."""
    def __init__(self, falla=None):
        self.pedidos = []
        self.falla = falla
        self.service = self

    def FECAESolicitar(self, Auth, FeCAEReq):
        self.pedidos.append(FeCAEReq)
        if self.falla:
            raise self.falla
        det = FeCAEReq['FeDetReq']['FECAEDetRequest'][0]
        return SimpleNamespace(Errors=None, FeDetResp=SimpleNamespace(FECAEDetResponse=[SimpleNamespace(
            Resultado='A', CAE='86400000000001', CAEFchVto='20261016', CbteDesde=det['CbteDesde'])]))


def _afip(wsfe):
    a = AfipWsfe(cuit='20149210408', cert_path='x', key_path='y', produccion=False)
    a._get_ticket_acceso = lambda: ('t', 's')
    a._get_wsfe_client = lambda: wsfe
    return a


class TestPedidoDeCae:
    def test_manda_la_condicion_iva_y_el_documento(self):
        wsfe = _Wsfe()
        _afip(wsfe).solicitar_cae('FAC. ELEC. C', 1990, 197, 4800.0, 4800.0, 0.0,
                                  cuit_receptor='30717003477', condicion_iva_receptor='Consumidor Final')
        det = wsfe.pedidos[0]['FeDetReq']['FECAEDetRequest'][0]
        assert det['CondicionIVAReceptorId'] == 5
        assert (det['DocTipo'], det['DocNro']) == (80, 30717003477)
        assert det['Iva'] is None

    def test_consumidor_final_sin_documento(self):
        wsfe = _Wsfe()
        _afip(wsfe).solicitar_cae('FAC. ELEC. C', 2, 252, 1000.0, 1000.0, 0.0)
        det = wsfe.pedidos[0]['FeDetReq']['FECAEDetRequest'][0]
        assert (det['DocTipo'], det['DocNro'], det['CondicionIVAReceptorId']) == (99, 0, 5)

    def test_corte_sin_respuesta_avisa_con_el_numero(self):
        wsfe = _Wsfe(falla=TimeoutError('Read timed out'))
        with pytest.raises(AFIPSinRespuesta) as e:
            _afip(wsfe).solicitar_cae('FAC. ELEC. C', 2, 252, 1000.0, 1000.0, 0.0)
        assert e.value.nro_comprobante == 252
        assert 'Error al llamar WSFE FECAESolicitar' in str(e.value)


def test_el_pedido_es_valido_para_el_wsdl_de_arca():
    """Arma el XML real contra el WSDL de producción (sin mandarlo): si un
    campo no existiera, zeep lo rechaza acá y no en el mostrador."""
    try:
        import zeep
        from zeep.transports import Transport
        from pos_system.utils.afip_wsfe import WSFE_URL_PROD, _make_afip_session
        cliente = zeep.Client(WSFE_URL_PROD, transport=Transport(session=_make_afip_session(), timeout=20))
    except Exception as e:
        pytest.skip(f'sin acceso al WSDL de ARCA: {e}')
    capturado = {}

    class _Capturador:
        def __init__(self):
            self.service = self

        def FECAESolicitar(self, Auth, FeCAEReq):
            capturado['xml'] = cliente.create_message(cliente.service, 'FECAESolicitar', Auth=Auth, FeCAEReq=FeCAEReq)
            raise RuntimeError('no se manda')

    with pytest.raises(AFIPSinRespuesta):
        _afip(_Capturador()).solicitar_cae('FAC. ELEC. C', 2, 252, 1000.0, 1000.0, 0.0,
                                           cuit_receptor='35108063', condicion_iva_receptor='Consumidor Final')
    from lxml import etree
    xml = etree.tostring(capturado['xml']).decode()
    assert 'CondicionIVAReceptorId>5<' in xml
    assert 'DocTipo>96<' in xml
