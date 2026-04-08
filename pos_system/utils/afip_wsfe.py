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
import base64
import hashlib
import io
import logging
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)

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
        gen_time  = (now - timedelta(minutes=10)).strftime('%Y-%m-%dT%H:%M:%S+00:00')
        exp_time  = (now + timedelta(hours=12)).strftime('%Y-%m-%dT%H:%M:%S+00:00')
        unique_id = hashlib.md5(f'{now.timestamp()}'.encode()).hexdigest()[:8]

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

            cert = self._crypto.load_certificate(self._crypto.FILETYPE_PEM, cert_data)
            key  = self._crypto.load_privatekey(self._crypto.FILETYPE_PEM, key_data)

            pkcs7 = self._crypto.PKCS7Type
            bio_in = self._crypto.X509.from_cryptography  # just checking availability

            # Usar sign method
            from OpenSSL.crypto import sign, PKCS12, dump_certificate, FILETYPE_ASN1
            from OpenSSL.crypto import load_pkcs12

            # Firmar TRA → CMS/PKCS#7 en base64
            signed = self._crypto.sign(key, tra_xml.encode('utf-8'), 'sha256')
            # AFIP espera un CMS firmado — usar SMIME
            from OpenSSL.crypto import X509, load_certificate, FILETYPE_PEM
            smime_buf = self._sign_tra_smime(tra_xml, cert_data, key_data)

        except Exception as e:
            raise AFIPAuthError(f'Error al firmar TRA: {e}')

        # Llamar WSAA
        try:
            client = self._zeep.Client(wsdl=wsaa_url)
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
        """Firma el TRA usando S/MIME (PKCS#7) y devuelve el CMS en base64."""
        try:
            from cryptography.hazmat.primitives.serialization import (
                load_pem_private_key, Encoding, NoEncryption
            )
            from cryptography.hazmat.primitives import hashes
            from cryptography.x509 import load_pem_x509_certificate
            from cryptography.hazmat.primitives.asymmetric import padding as asym_padding
            from cryptography.hazmat.backends import default_backend
            import email.mime.text
            import smime  # pip install smime — fallback below
        except ImportError:
            pass

        # Método simple con OpenSSL via subprocess si zeep/cryptography no alcanza
        # Usamos la librería M2Crypto si disponible, sino subprocess openssl
        try:
            import M2Crypto
            from M2Crypto import SMIME, BIO, X509, EVP
            signer = SMIME.SMIME()
            # Cargar cert y key
            bio_cert = BIO.MemoryBuffer(cert_pem)
            bio_key  = BIO.MemoryBuffer(key_pem)
            signer.load_key_bio(bio_key, bio_cert)
            bio_data = BIO.MemoryBuffer(tra_xml.encode('utf-8'))
            pkcs7 = signer.sign(bio_data, flags=SMIME.PKCS7_DETACHED)
            bio_out = BIO.MemoryBuffer()
            signer.write(bio_out, pkcs7)
            cms_raw = bio_out.read()
            # Extraer solo el contenido base64 entre los delimitadores
            lines = cms_raw.decode('utf-8', errors='ignore').splitlines()
            b64_lines = []
            in_body = False
            for line in lines:
                if line.strip() == '':
                    in_body = True
                    continue
                if in_body and not line.startswith('--') and not line.startswith('Content'):
                    b64_lines.append(line)
            return ''.join(b64_lines)
        except ImportError:
            pass

        # Fallback: subprocess openssl smime
        import subprocess, tempfile
        with tempfile.NamedTemporaryFile(delete=False, suffix='.xml') as f:
            f.write(tra_xml.encode('utf-8'))
            tra_path = f.name
        with tempfile.NamedTemporaryFile(delete=False, suffix='.pem') as f:
            f.write(cert_pem)
            cert_tmp = f.name
        with tempfile.NamedTemporaryFile(delete=False, suffix='.pem') as f:
            f.write(key_pem)
            key_tmp = f.name
        try:
            result = subprocess.run(
                ['openssl', 'smime', '-sign', '-signer', cert_tmp,
                 '-inkey', key_tmp, '-in', tra_path, '-nodetach', '-outform', 'PEM'],
                capture_output=True, check=True
            )
            cms_pem = result.stdout.decode()
            # Extraer base64
            lines = cms_pem.splitlines()
            b64 = ''.join(l for l in lines if not l.startswith('-----'))
            return b64
        finally:
            for p in [tra_path, cert_tmp, key_tmp]:
                try: os.unlink(p)
                except: pass

    # ── WSFE ──────────────────────────────────────────────────────────────────

    def _get_wsfe_client(self):
        wsfe_url = WSFE_URL_PROD if self.produccion else WSFE_URL_HOMO
        return self._zeep.Client(wsdl=wsfe_url)

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
            'ImpTotConc':    0,
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
