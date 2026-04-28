"""
Integración AFIP WSFE (Web Service Facturación Electrónica) — REAL
===================================================================
Permite obtener CAE y Vto. CAE directamente desde los servidores de AFIP.

Requisitos:
  pip install zeep pyOpenSSL

Flujo:
  1. WSAA: Autenticarse con certificado .crt y clave .key → obtener TA (Ticket de Acceso)
  2. WSFE: Con el TA, llamar a FECAESolicitar para obtener el CAE

Configuración en la pestaña Fiscal > Configuración AFIP:
  - CUIT, Razón Social, Domicilio, etc.
  - Ruta al certificado (.crt) y clave privada (.key)
  - Punto de Venta
  - Entorno: HOMOLOGACION (prueba) o PRODUCCION
"""

import os
import ssl
import base64
import hashlib
import io
import logging
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)


def _make_afip_session():
    """
    Sesión requests con SECLEVEL=1. AFIP usa parámetros Diffie-Hellman de 1024 bits
    que OpenSSL 3.x rechaza por defecto ([SSL: DH_KEY_TOO_SMALL]).
    """
    from requests import Session
    from requests.adapters import HTTPAdapter
    from urllib3.util.ssl_ import create_urllib3_context

    class _AfipSSLAdapter(HTTPAdapter):
        def init_poolmanager(self, *args, **kwargs):
            ctx = create_urllib3_context(ciphers='DEFAULT:@SECLEVEL=1')
            ctx.check_hostname = True
            ctx.verify_mode = ssl.CERT_REQUIRED
            kwargs['ssl_context'] = ctx
            return super().init_poolmanager(*args, **kwargs)

        def proxy_manager_for(self, *args, **kwargs):
            ctx = create_urllib3_context(ciphers='DEFAULT:@SECLEVEL=1')
            ctx.check_hostname = True
            ctx.verify_mode = ssl.CERT_REQUIRED
            kwargs['ssl_context'] = ctx
            return super().proxy_manager_for(*args, **kwargs)

    s = Session()
    s.mount('https://', _AfipSSLAdapter())
    return s

# ── URLs AFIP ─────────────────────────────────────────────────────────────────
WSAA_URL_HOMO = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms?wsdl'
WSAA_URL_PROD = 'https://wsaa.afip.gov.ar/ws/services/LoginCms?wsdl'
WSFE_URL_HOMO = 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx?wsdl'
WSFE_URL_PROD = 'https://servicios1.afip.gov.ar/wsfev1/service.asmx?wsdl'

# Mapeo tipo comprobante string → código AFIP
TIPO_COMP_MAP = {
    'FAC. ELEC. A': 1,
    'FAC. ELEC. B': 6,
    'FAC. ELEC. C': 11,
    'NOTA DEB. A':  2,
    'NOTA DEB. B':  7,
    'NOTA DEB. C':  12,
    'NOTA CRED. A': 3,
    'NOTA CRED. B': 8,
    'NOTA CRED. C': 13,
}

# Mapeo condición IVA receptor → tipo documento receptor
COND_IVA_TIPO_DOC = {
    'Responsable Inscripto': 80,   # CUIT
    'Monotributista':        80,
    'Exento':                80,
    'Consumidor Final':      99,   # sin identificar
    'No Categorizado':       99,
}


class AFIPError(Exception):
    """Error en la comunicación con AFIP."""
    pass


class AFIPAuthError(AFIPError):
    """Error de autenticación AFIP (certificado inválido, expirado, etc.)."""
    pass


class AFIPWSFEError(AFIPError):
    """Error devuelto por el WebService WSFE."""
    pass


class AfipWsfe:
    """
    Cliente para el WebService WSFE de AFIP.

    Uso básico:
        afip = AfipWsfe(
            cuit='20123456789',
            cert_path='/ruta/a/cert.crt',
            key_path='/ruta/a/clave.key',
            produccion=False,   # True = producción, False = homologación
        )
        resultado = afip.solicitar_cae(
            tipo_comprobante='FAC. ELEC. B',
            punto_venta=1,
            nro_comprobante=1,          # None = auto (próximo disponible)
            importe_total=1000.0,
            importe_neto_gravado=826.45,
            importe_iva=173.55,
            fecha_comprobante='20260406',  # AAAAMMDD
            concepto=1,                    # 1=Productos, 2=Servicios, 3=P+S
            cuit_receptor=None,            # None = Consumidor Final
            condicion_iva_receptor='Consumidor Final',
        )
        # resultado = {'cae': '74...', 'vto_cae': '20260416', 'nro_comprobante': 1}
    """

    def __init__(self, cuit: str, cert_path: str, key_path: str, produccion: bool = False):
        self.cuit = str(cuit).replace('-', '').replace(' ', '')
        self.cert_path = cert_path
        self.key_path  = key_path
        self.produccion = produccion
        self._ta_token = None
        self._ta_sign  = None
        self._ta_expiry = None

        # Verificar dependencias
        try:
            import zeep
            self._zeep = zeep
        except ImportError:
            raise ImportError(
                'Falta el paquete "zeep". Instalalo con: pip install zeep'
            )
        try:
            from OpenSSL import crypto
            self._crypto = crypto
        except ImportError:
            raise ImportError(
                'Falta el paquete "pyOpenSSL". Instalalo con: pip install pyOpenSSL'
            )

    # ── WSAA ──────────────────────────────────────────────────────────────────

    def _get_ticket_acceso(self):
        """Obtiene (o reutiliza) el Ticket de Acceso del WSAA."""
        now = datetime.now(timezone.utc)

        # Reutilizar si aún vigente (con 5 min de margen)
        if self._ta_token and self._ta_expiry and now < self._ta_expiry - timedelta(minutes=5):
            return self._ta_token, self._ta_sign

        wsaa_url = WSAA_URL_PROD if self.produccion else WSAA_URL_HOMO

        # Generar TRA (Ticket de Requerimiento de Acceso)
        # uniqueId debe ser entero (xsd:long), generationTime/expirationTime en hora local AR
        _TZ_AR = timezone(timedelta(hours=-3))
        now_ar  = now.astimezone(_TZ_AR)
        gen_time  = (now_ar - timedelta(minutes=10)).strftime('%Y-%m-%dT%H:%M:%S-03:00')
        exp_time  = (now_ar + timedelta(hours=12)).strftime('%Y-%m-%dT%H:%M:%S-03:00')
        unique_id = int(now.timestamp())

        tra_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>{unique_id}</uniqueId>
    <generationTime>{gen_time}</generationTime>
    <expirationTime>{exp_time}</expirationTime>
  </header>
  <service>wsfe</service>
</loginTicketRequest>"""

        # Firmar TRA con la clave privada y el certificado
        try:
            with open(self.cert_path, 'rb') as f:
                cert_data = f.read()
            with open(self.key_path, 'rb') as f:
                key_data = f.read()

            smime_buf = self._sign_tra_smime(tra_xml, cert_data, key_data)

        except Exception as e:
            raise AFIPAuthError(f'Error al firmar TRA: {e}')

        # Llamar WSAA
        try:
            from zeep.transports import Transport
            transport = Transport(session=_make_afip_session(), timeout=30)
            client = self._zeep.Client(wsdl=wsaa_url, transport=transport)
            response = client.service.loginCms(in0=smime_buf)
        except Exception as e:
            raise AFIPAuthError(f'Error en WSAA: {e}')

        # Parsear respuesta XML
        import xml.etree.ElementTree as ET
        root = ET.fromstring(response)
        ns = {'ar': 'http://www.w3.org/2001/XMLSchema-instance'}
        token = root.find('.//token').text
        sign  = root.find('.//sign').text
        exp_str = root.find('.//expirationTime').text

        try:
            exp_dt = datetime.fromisoformat(exp_str.replace('Z', '+00:00'))
        except Exception:
            exp_dt = now + timedelta(hours=12)

        self._ta_token  = token
        self._ta_sign   = sign
        self._ta_expiry = exp_dt

        return token, sign

    def _sign_tra_smime(self, tra_xml: str, cert_pem: bytes, key_pem: bytes) -> str:
        """Firma el TRA usando PKCS#7 y devuelve el CMS en base64."""
        import base64
        from cryptography.hazmat.primitives.serialization import load_pem_private_key, Encoding
        from cryptography.hazmat.primitives.serialization.pkcs7 import PKCS7SignatureBuilder, PKCS7Options
        from cryptography.hazmat.primitives import hashes
        from cryptography.x509 import load_pem_x509_certificate

        cert = load_pem_x509_certificate(cert_pem)
        key  = load_pem_private_key(key_pem, password=None)
        data = tra_xml.encode('utf-8')

        signed_der = (
            PKCS7SignatureBuilder()
            .set_data(data)
            .add_signer(cert, key, hashes.SHA256())
            .sign(Encoding.DER, [PKCS7Options.Binary])
        )
        return base64.b64encode(signed_der).decode()

    # ── WSFE ──────────────────────────────────────────────────────────────────

    def _get_wsfe_client(self):
        from zeep.transports import Transport
        wsfe_url = WSFE_URL_PROD if self.produccion else WSFE_URL_HOMO
        transport = Transport(session=_make_afip_session(), timeout=30)
        return self._zeep.Client(wsdl=wsfe_url, transport=transport)

    def ultimo_comprobante(self, tipo_comprobante: str, punto_venta: int) -> int:
        """Devuelve el último número de comprobante emitido para este tipo y punto de venta."""
        token, sign = self._get_ticket_acceso()
        cod_tipo = TIPO_COMP_MAP.get(tipo_comprobante.upper(), 6)
        client = self._get_wsfe_client()
        auth = {'Token': token, 'Sign': sign, 'Cuit': int(self.cuit)}
        resp = client.service.FECompUltimoAutorizado(Auth=auth, PtoVta=punto_venta, CbteTipo=cod_tipo)
        if hasattr(resp, 'Errors') and resp.Errors:
            errs = resp.Errors.Err
            msg = '; '.join(f"[{e.Code}] {e.Msg}" for e in errs)
            raise AFIPWSFEError(f'WSFE Error: {msg}')
        return int(resp.CbteNro or 0)

    def tipos_comprobante_disponibles(self) -> list:
        """Devuelve la lista de tipos de comprobante que el emisor tiene habilitados.

        Llama a FEParamGetTiposCbte que retorna los tipos disponibles según la
        condición IVA del emisor. Útil para verificar si Nota de Crédito está
        habilitada antes de intentar emitir.

        Devuelve: [{'Id': 1, 'Desc': 'Factura A', 'FchDesde': '...', 'FchHasta': '...'}, ...]
        """
        token, sign = self._get_ticket_acceso()
        client = self._get_wsfe_client()
        auth = {'Token': token, 'Sign': sign, 'Cuit': int(self.cuit)}
        resp = client.service.FEParamGetTiposCbte(Auth=auth)
        if hasattr(resp, 'Errors') and resp.Errors and resp.Errors.Err:
            errs = resp.Errors.Err
            msg = '; '.join(f"[{e.Code}] {e.Msg}"
                            for e in (errs if hasattr(errs, '__iter__') else [errs]))
            raise AFIPWSFEError(f'WSFE Error tipos comprobante: {msg}')
        out = []
        try:
            for t in resp.ResultGet.CbteTipo:
                out.append({
                    'Id':    int(getattr(t, 'Id', 0) or 0),
                    'Desc':  str(getattr(t, 'Desc', '') or ''),
                    'FchDesde': str(getattr(t, 'FchDesde', '') or ''),
                    'FchHasta': str(getattr(t, 'FchHasta', '') or ''),
                })
        except Exception:
            pass
        return out

    def puntos_venta_disponibles(self) -> list:
        """Devuelve los puntos de venta habilitados para el emisor.

        Llama a FEParamGetPtosVenta. Devuelve: [{'Nro': 1, 'EmisionTipo': 'CAE', 'Bloqueado': 'N', 'FchBaja': ''}, ...]
        """
        token, sign = self._get_ticket_acceso()
        client = self._get_wsfe_client()
        auth = {'Token': token, 'Sign': sign, 'Cuit': int(self.cuit)}
        resp = client.service.FEParamGetPtosVenta(Auth=auth)
        if hasattr(resp, 'Errors') and resp.Errors and resp.Errors.Err:
            errs = resp.Errors.Err
            msg = '; '.join(f"[{e.Code}] {e.Msg}"
                            for e in (errs if hasattr(errs, '__iter__') else [errs]))
            raise AFIPWSFEError(f'WSFE Error PVs: {msg}')
        out = []
        try:
            for pv in resp.ResultGet.PtoVenta:
                out.append({
                    'Nro':         int(getattr(pv, 'Nro', 0) or 0),
                    'EmisionTipo': str(getattr(pv, 'EmisionTipo', '') or ''),
                    'Bloqueado':   str(getattr(pv, 'Bloqueado', 'N') or 'N'),
                    'FchBaja':     str(getattr(pv, 'FchBaja', '') or ''),
                })
        except Exception:
            pass
        return out

    def diagnosticar_permisos_nc(self, punto_venta: int) -> dict:
        """Test integral: ¿el emisor puede emitir Notas de Crédito?

        Verifica:
          1. Autenticación WSAA OK.
          2. PV está habilitado y no bloqueado.
          3. Tipos de comprobante disponibles incluyen NC A/B/C.
          4. ultimo_comprobante para cada tipo de NC responde sin error
             (lo que confirma habilitación efectiva en ese PV).

        Devuelve un dict con el resultado de cada chequeo:
          {
            'auth_ok': True,
            'pv': 1, 'pv_ok': True, 'pv_msg': '',
            'tipos_disponibles': [...],
            'nc_a': {'permitido': True/False, 'msg': '', 'codigo': 3, 'ultimo_nro': N},
            'nc_b': {...},
            'nc_c': {...},
            'puede_emitir_nc': True,
          }
        """
        result = {
            'auth_ok': False,
            'pv': punto_venta,
            'pv_ok': False, 'pv_msg': '',
            'tipos_disponibles': [],
            'nc_a': {}, 'nc_b': {}, 'nc_c': {},
            'puede_emitir_nc': False,
            'error': '',
        }
        # 1. Auth
        try:
            self._get_ticket_acceso()
            result['auth_ok'] = True
        except Exception as e:
            result['error'] = f'Auth WSAA falló: {e}'
            return result

        # 2. PVs — chequear que el PV pedido esté en la lista, sin marcarlo
        # como "dado de baja" salvo que FchBaja sea claramente una fecha real.
        try:
            pvs = self.puntos_venta_disponibles()
            result['pvs_raw'] = pvs   # data cruda para diagnóstico
            for pv in pvs:
                if int(pv['Nro']) == int(punto_venta):
                    bloq = (pv.get('Bloqueado') or '').strip().upper()
                    fch_baja_raw = (pv.get('FchBaja') or '').strip()
                    # Considerar "dado de baja" solo si FchBaja luce como fecha
                    # real (YYYY-MM-DD o similar). 'NULL', '', '0', etc no cuentan.
                    parece_fecha = (
                        len(fch_baja_raw) >= 8
                        and fch_baja_raw.upper() not in ('NULL', 'NONE', '0', '00000000')
                        and any(ch.isdigit() for ch in fch_baja_raw)
                        and '-' in fch_baja_raw
                    )
                    if bloq == 'S':
                        result['pv_msg'] = 'PV bloqueado por AFIP'
                    elif parece_fecha:
                        result['pv_msg'] = f'PV dado de baja el {fch_baja_raw}'
                    else:
                        result['pv_ok'] = True
                        result['pv_msg'] = f'OK ({pv.get("EmisionTipo", "CAE")})'
                    break
            else:
                if pvs:
                    nros = ', '.join(str(p['Nro']) for p in pvs)
                    result['pv_msg'] = f'PV {punto_venta} no figura. AFIP reporta: {nros}'
                else:
                    result['pv_msg'] = 'AFIP no devolvió PVs habilitados (perfil sin alta)'
        except Exception as e:
            result['pv_msg'] = f'No se pudo consultar PVs: {e}'

        # 3. Tipos disponibles
        try:
            result['tipos_disponibles'] = self.tipos_comprobante_disponibles()
        except Exception as e:
            result['error'] = f'No se pudieron consultar tipos: {e}'

        ids_disponibles = {t['Id'] for t in result['tipos_disponibles']}

        # 4. Probar cada NC
        for letra, tipo_str, codigo in [
            ('A', 'NOTA CRED. A', 3),
            ('B', 'NOTA CRED. B', 8),
            ('C', 'NOTA CRED. C', 13),
        ]:
            r = {'permitido': False, 'codigo': codigo, 'msg': '', 'ultimo_nro': None}
            if codigo not in ids_disponibles and ids_disponibles:
                r['msg'] = f'Tipo {codigo} no figura en habilitados (cond. IVA del emisor no lo permite)'
            else:
                try:
                    nro = self.ultimo_comprobante(tipo_str, punto_venta)
                    r['permitido'] = True
                    r['ultimo_nro'] = nro
                    r['msg'] = f'OK (último emitido: {nro})'
                except AFIPWSFEError as ex:
                    r['msg'] = str(ex)
                except Exception as ex:
                    r['msg'] = f'Error: {ex}'
            result[f'nc_{letra.lower()}'] = r

        result['puede_emitir_nc'] = (
            result['auth_ok'] and result['pv_ok'] and any(
                result[f'nc_{l}']['permitido'] for l in ('a', 'b', 'c')
            )
        )
        return result

    def solicitar_cae(
        self,
        tipo_comprobante: str,
        punto_venta: int,
        nro_comprobante: int,
        importe_total: float,
        importe_neto_gravado: float,
        importe_iva: float,
        fecha_comprobante: str = None,     # AAAAMMDD; None = hoy
        concepto: int = 1,                 # 1=Productos, 2=Servicios, 3=P+S
        cuit_receptor: str = None,         # None o '' = Consumidor Final
        condicion_iva_receptor: str = 'Consumidor Final',
        importe_otros: float = 0.0,
        importe_op_exentas: float = 0.0,
        importe_trib: float = 0.0,
        moneda: str = 'PES',
        cotizacion: float = 1.0,
        cbtes_asoc: list = None,            # Notas de Crédito/Débito: lista de
                                             # tuplas (tipo_str, pv, nro) referenciando
                                             # el/los comprobantes originales.
    ) -> dict:
        """
        Solicita CAE a AFIP para un comprobante.

        Devuelve:
          {
            'cae':             '74XXXXXXXXXXXX',
            'vto_cae':         '20260416',      # AAAAMMDD
            'nro_comprobante': 1,
            'resultado':       'A',             # A=Aprobado, R=Rechazado
          }

        Lanza AFIPWSFEError si AFIP rechaza el comprobante.
        """
        token, sign = self._get_ticket_acceso()
        cod_tipo = TIPO_COMP_MAP.get(tipo_comprobante.upper(), 6)

        if fecha_comprobante is None:
            fecha_comprobante = datetime.now().strftime('%Y%m%d')

        # Tipo y nro de doc receptor
        cuit_recep_clean = str(cuit_receptor or '').replace('-', '').replace(' ', '')
        if cuit_recep_clean and cuit_recep_clean != '0':
            tipo_doc_rec = COND_IVA_TIPO_DOC.get(condicion_iva_receptor, 80)
            nro_doc_rec  = int(cuit_recep_clean)
        else:
            tipo_doc_rec = 99
            nro_doc_rec  = 0

        client = self._get_wsfe_client()
        auth = {'Token': token, 'Sign': sign, 'Cuit': int(self.cuit)}

        detalle = {
            'Concepto':      concepto,
            'DocTipo':       tipo_doc_rec,
            'DocNro':        nro_doc_rec,
            'CbteDesde':     nro_comprobante,
            'CbteHasta':     nro_comprobante,
            'CbteFch':       fecha_comprobante,
            'ImpTotal':      round(importe_total, 2),
            'ImpTotConc':    round(importe_otros, 2),
            'ImpNeto':       round(importe_neto_gravado, 2),
            'ImpOpEx':       round(importe_op_exentas, 2),
            'ImpTrib':       round(importe_trib, 2),
            'ImpIVA':        round(importe_iva, 2),
            'FchServDesde':  None,
            'FchServHasta':  None,
            'FchVtoPago':    None,
            'MonId':         moneda,
            'MonCotiz':      cotizacion,
            'Iva': {
                'AlicIva': [{
                    'Id':     5,      # 5=21%, 4=10.5%, 6=27%
                    'BaseImp': round(importe_neto_gravado, 2),
                    'Importe': round(importe_iva, 2),
                }]
            } if importe_iva > 0 else None,
        }

        # Si concepto es Servicios o mixto, se requieren fechas de servicio
        if concepto in (2, 3):
            detalle['FchServDesde'] = fecha_comprobante
            detalle['FchServHasta'] = fecha_comprobante
            detalle['FchVtoPago']   = fecha_comprobante

        # Comprobantes asociados (Notas de Crédito / Débito).
        # AFIP exige este campo para todo tipo 3/8/13 (NC) y 2/7/12 (ND).
        if cbtes_asoc:
            cbtes_list = []
            for asoc in cbtes_asoc:
                if not asoc:
                    continue
                a_tipo, a_pv, a_nro = asoc
                cbtes_list.append({
                    'Tipo':  TIPO_COMP_MAP.get(str(a_tipo).upper(), 6),
                    'PtoVta': int(a_pv),
                    'Nro':    int(a_nro),
                    # Cuit y CbteFch son opcionales en WSFEv1
                })
            if cbtes_list:
                detalle['CbtesAsoc'] = {'CbteAsoc': cbtes_list}

        req = {
            'FeCabReq': {
                'CantReg':  1,
                'PtoVta':   punto_venta,
                'CbteTipo': cod_tipo,
            },
            'FeDetReq': {'FECAEDetRequest': [detalle]},
        }

        try:
            resp = client.service.FECAESolicitar(Auth=auth, FeCAEReq=req)
        except Exception as e:
            raise AFIPWSFEError(f'Error al llamar WSFE FECAESolicitar: {e}')

        # Verificar errores de cabecera
        if hasattr(resp, 'Errors') and resp.Errors:
            errs = resp.Errors.Err
            msg = '; '.join(f"[{e.Code}] {e.Msg}" for e in (errs if hasattr(errs, '__iter__') else [errs]))
            raise AFIPWSFEError(f'WSFE Error cabecera: {msg}')

        det = resp.FeDetResp.FECAEDetResponse[0]

        # Verificar observaciones / rechazos
        if det.Resultado == 'R':
            obs = ''
            if hasattr(det, 'Observaciones') and det.Observaciones:
                obs_list = det.Observaciones.Obs
                if not hasattr(obs_list, '__iter__'):
                    obs_list = [obs_list]
                obs = '; '.join(f"[{o.Code}] {o.Msg}" for o in obs_list)
            raise AFIPWSFEError(f'AFIP rechazó el comprobante: {obs}')

        return {
            'cae':             det.CAE,
            'vto_cae':         det.CAEFchVto,   # AAAAMMDD
            'nro_comprobante': int(det.CbteDesde),
            'resultado':       det.Resultado,
        }


# ── Función de conveniencia ───────────────────────────────────────────────────

def cargar_config_afip_desde_db() -> dict:
    """Lee la configuración AFIP guardada en la base de datos."""
    try:
        from pos_system.database.db_manager import DatabaseManager
        db = DatabaseManager()
        keys = [
            'afip_cuit', 'afip_razon_social', 'afip_domicilio', 'afip_localidad',
            'afip_telefono', 'afip_ing_brutos', 'afip_inicio_actividades',
            'afip_condicion_iva', 'afip_punto_venta',
            'afip_cert_path', 'afip_key_path', 'afip_produccion',
        ]
        config = {}
        for key in keys:
            res = db.execute_query("SELECT value FROM config WHERE key=?", (key,))
            config[key] = res[0]['value'] if res and res[0]['value'] else ''
        return config
    except Exception as e:
        logger.error(f'Error cargando config AFIP: {e}')
        return {}


def calcular_iva_neto(total: float, alicuota: float = 21.0) -> tuple:
    """
    Dado un total con IVA incluido, devuelve (neto_gravado, importe_iva).
    Ejemplo: calcular_iva_neto(1210.0, 21.0) → (1000.0, 210.0)
    """
    factor = alicuota / 100.0
    neto = round(total / (1 + factor), 2)
    iva  = round(total - neto, 2)
    return neto, iva


# ── WS Padron (Constancia de Inscripcion, via getPersona_v2) ──────────────────

PADRON_URL_HOMO = 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5?WSDL'
PADRON_URL_PROD = 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5?WSDL'


def _mapear_condicion_iva_constancia(data) -> str:
    """
    Deriva la condición frente al IVA desde la respuesta de getPersona_v2.
    Prioridad: monotributo activo > IVA (régimen general) > consumidor final.
    """
    try:
        monot = getattr(data, 'datosMonotributo', None)
        if monot:
            impuestos = getattr(monot, 'impuesto', None) or []
            for imp in impuestos:
                if int(getattr(imp, 'idImpuesto', 0) or 0) == 20 and \
                   str(getattr(imp, 'estadoImpuesto', '')).upper() == 'AC':
                    return 'Monotributista'
    except Exception:
        pass
    try:
        rg = getattr(data, 'datosRegimenGeneral', None)
        if rg:
            impuestos = getattr(rg, 'impuesto', None) or []
            codigos_ac = {
                int(getattr(i, 'idImpuesto', 0) or 0)
                for i in impuestos
                if str(getattr(i, 'estadoImpuesto', '')).upper() == 'AC'
            }
            if 30 in codigos_ac:   return 'Responsable Inscripto'
            if 32 in codigos_ac:   return 'Exento'
    except Exception:
        pass
    return 'Consumidor Final'


class AFIPPadron(AfipWsfe):
    """
    Consulta al padrón AFIP (servicio `ws_sr_constancia_inscripcion`) para
    obtener razón social, domicilio y condición frente al IVA desde un CUIT.

    Usa los mismos certificados que AfipWsfe. El cert tiene que estar
    autorizado al servicio `ws_sr_constancia_inscripcion` en el Administrador
    de Relaciones de AFIP. Si no, WSAA falla con AFIPAuthError.
    """

    def _get_ticket_acceso(self):
        """Override: pide TA para ws_sr_constancia_inscripcion."""
        now = datetime.now(timezone.utc)
        if self._ta_token and self._ta_expiry and now < self._ta_expiry - timedelta(minutes=5):
            return self._ta_token, self._ta_sign

        wsaa_url = WSAA_URL_PROD if self.produccion else WSAA_URL_HOMO
        _TZ_AR = timezone(timedelta(hours=-3))
        now_ar = now.astimezone(_TZ_AR)
        gen_time  = (now_ar - timedelta(minutes=10)).strftime('%Y-%m-%dT%H:%M:%S-03:00')
        exp_time  = (now_ar + timedelta(hours=12)).strftime('%Y-%m-%dT%H:%M:%S-03:00')
        unique_id = int(now.timestamp())

        tra_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>{unique_id}</uniqueId>
    <generationTime>{gen_time}</generationTime>
    <expirationTime>{exp_time}</expirationTime>
  </header>
  <service>ws_sr_constancia_inscripcion</service>
</loginTicketRequest>"""

        try:
            with open(self.cert_path, 'rb') as f: cert_data = f.read()
            with open(self.key_path,  'rb') as f: key_data  = f.read()
            smime_buf = self._sign_tra_smime(tra_xml, cert_data, key_data)
        except Exception as e:
            raise AFIPAuthError(f'Error al firmar TRA (padron): {e}')

        try:
            from zeep.transports import Transport
            transport = Transport(session=_make_afip_session(), timeout=30)
            client = self._zeep.Client(wsdl=wsaa_url, transport=transport)
            response = client.service.loginCms(in0=smime_buf)
        except Exception as e:
            raise AFIPAuthError(f'Error en WSAA (padron): {e}')

        import xml.etree.ElementTree as ET
        root = ET.fromstring(response)
        token = root.find('.//token').text
        sign  = root.find('.//sign').text
        exp_str = root.find('.//expirationTime').text
        try:
            exp_dt = datetime.fromisoformat(exp_str.replace('Z', '+00:00'))
        except Exception:
            exp_dt = now + timedelta(hours=12)

        self._ta_token, self._ta_sign, self._ta_expiry = token, sign, exp_dt
        return token, sign

    def consultar(self, cuit: str) -> dict:
        """
        Devuelve {'razon_social', 'domicilio', 'localidad', 'condicion_iva', 'activo'}
        o None si el CUIT no existe.
        """
        cuit = str(cuit).replace('-', '').replace(' ', '').strip()
        if not cuit.isdigit() or len(cuit) != 11:
            return None

        token, sign = self._get_ticket_acceso()
        url = PADRON_URL_PROD if self.produccion else PADRON_URL_HOMO

        from zeep.transports import Transport
        transport = Transport(session=_make_afip_session(), timeout=30)
        client = self._zeep.Client(wsdl=url, transport=transport)

        try:
            resp = client.service.getPersona_v2(
                token=token, sign=sign,
                cuitRepresentada=int(self.cuit),
                idPersona=int(cuit),
            )
        except Exception as e:
            msg = str(e)
            if 'No existe persona' in msg or 'no existe' in msg.lower():
                return None
            raise AFIPError(f'Error consultando padron: {e}')

        # Respuesta de getPersona_v2 (ws_sr_constancia_inscripcion):
        # { datosGenerales: {...}, datosMonotributo: {...}, datosRegimenGeneral: {...} }
        gen = getattr(resp, 'datosGenerales', None)
        if not gen:
            return None

        # Razón social: para jurídicas viene en razonSocial; para físicas se arma
        # con apellido + nombre.
        razon = (getattr(gen, 'razonSocial', None) or '').strip()
        if not razon:
            razon = ' '.join(filter(None, [
                (getattr(gen, 'apellido', '') or '').strip(),
                (getattr(gen, 'nombre', '')   or '').strip(),
            ])).strip()

        # Domicilio fiscal (unico objeto)
        dom = getattr(gen, 'domicilioFiscal', None)
        dom_str, localidad = '', ''
        if dom:
            dom_str = (getattr(dom, 'direccion', '') or '').strip()
            loc   = (getattr(dom, 'localidad', '') or '').strip()
            prov  = (getattr(dom, 'descripcionProvincia', '') or '').strip()
            if loc and prov and prov.upper() != loc.upper():
                localidad = f'{loc} - {prov}'
            else:
                localidad = loc or prov

        return {
            'razon_social':  razon,
            'domicilio':     dom_str,
            'localidad':     localidad,
            'condicion_iva': _mapear_condicion_iva_constancia(resp),
            'activo':        (getattr(gen, 'estadoClave', '') or '').upper() == 'ACTIVO',
        }
