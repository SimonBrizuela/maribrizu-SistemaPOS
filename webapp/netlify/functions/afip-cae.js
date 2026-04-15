/**
 * Netlify Function: afip-cae
 * POST /api/afip-cae
 *
 * Obtiene CAE de AFIP mediante WSAA (autenticación con certificado X.509)
 * y WSFE (FECAESolicitar).
 *
 * Variables de entorno requeridas (configurar en Netlify dashboard):
 *   AFIP_CUIT          — CUIT del emisor sin guiones (ej: 20123456789)
 *   AFIP_CERT_PEM      — Contenido del .crt en formato PEM (con \n reales o escapados como \n)
 *   AFIP_KEY_PEM       — Contenido del .key en formato PEM
 *   AFIP_PRODUCCION    — "1" para producción, "0" o vacío para homologación
 */

'use strict';

const forge = require('node-forge');
const soap  = require('soap');

// ── URLs AFIP ──────────────────────────────────────────────────────────────────
const WSAA_URL_HOMO = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms?wsdl';
const WSAA_URL_PROD = 'https://wsaa.afip.gov.ar/ws/services/LoginCms?wsdl';
const WSFE_URL_HOMO = 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx?wsdl';
const WSFE_URL_PROD = 'https://servicios1.afip.gov.ar/wsfev1/service.asmx?wsdl';

const TIPO_COMP = {
  'FAC. ELEC. A':  1,  'FAC. ELEC. B':  6,  'FAC. ELEC. C': 11,
  'NOTA DEB. A':   2,  'NOTA DEB. B':   7,  'NOTA DEB. C':  12,
  'NOTA CRED. A':  3,  'NOTA CRED. B':  8,  'NOTA CRED. C': 13,
};

// Cache de token por instancia (serverless = cold start cada cierto tiempo, está bien)
let _token = null, _sign = null, _tokenExp = null;

// ── WSAA ───────────────────────────────────────────────────────────────────────

function buildTRA() {
  const now  = new Date();
  const gen  = new Date(now - 10 * 60000).toISOString().replace('Z', '+00:00');
  const exp  = new Date(now.getTime() + 12 * 3600000).toISOString().replace('Z', '+00:00');
  const uid  = (Math.random() * 0xffffffff >>> 0).toString();
  return `<?xml version="1.0" encoding="UTF-8"?>\n<loginTicketRequest version="1.0">\n  <header>\n    <uniqueId>${uid}</uniqueId>\n    <generationTime>${gen}</generationTime>\n    <expirationTime>${exp}</expirationTime>\n  </header>\n  <service>wsfe</service>\n</loginTicketRequest>`;
}

function signTRA(traXml, certPem, keyPem) {
  const cert       = forge.pki.certificateFromPem(certPem);
  const privateKey = forge.pki.privateKeyFromPem(keyPem);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key: privateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [],   // sin atributos autenticados — necesario para AFIP
  });
  p7.sign({ detached: false });

  // DER → base64
  const der = forge.asn1.toDer(p7.toAsn1()).bytes();
  return forge.util.encode64(der);
}

async function getTicketAcceso(certPem, keyPem, produccion) {
  const now = new Date();
  if (_token && _sign && _tokenExp && now < new Date(_tokenExp.getTime() - 5 * 60000)) {
    return { token: _token, sign: _sign };
  }

  const wsaaUrl = produccion ? WSAA_URL_PROD : WSAA_URL_HOMO;
  const tra = buildTRA();
  const cms = signTRA(tra, certPem, keyPem);

  const client = await soap.createClientAsync(wsaaUrl);
  const result = await new Promise((resolve, reject) => {
    client.loginCms({ in0: cms }, (err, res) => {
      if (err) reject(new Error('WSAA error: ' + err.message));
      else resolve(res);
    });
  });

  const xml = result.loginCmsReturn;
  const token = (xml.match(/<token>([\s\S]*?)<\/token>/) || [])[1]?.trim();
  const sign  = (xml.match(/<sign>([\s\S]*?)<\/sign>/)   || [])[1]?.trim();
  const expRaw = (xml.match(/<expirationTime>([\s\S]*?)<\/expirationTime>/) || [])[1]?.trim();

  if (!token || !sign) throw new Error('WSAA: respuesta inválida — no se encontró token/sign');

  _token    = token;
  _sign     = sign;
  _tokenExp = expRaw ? new Date(expRaw) : new Date(now.getTime() + 12 * 3600000);

  return { token, sign };
}

// ── WSFE ───────────────────────────────────────────────────────────────────────

async function solicitarCAE({ token, sign, cuit, ptoVenta, tipoComp, datos, produccion }) {
  const wsfeUrl = produccion ? WSFE_URL_PROD : WSFE_URL_HOMO;
  const client  = await soap.createClientAsync(wsfeUrl);

  const auth = { Token: token, Sign: sign, Cuit: parseInt(cuit) };
  const req = {
    FeCabReq: {
      CantReg:  1,
      PtoVta:   ptoVenta,
      CbteTipo: tipoComp,
    },
    FeDetReq: { FECAEDetRequest: [datos] },
  };

  const result = await new Promise((resolve, reject) => {
    client.FECAESolicitar({ Auth: auth, FeCAEReq: req }, (err, res) => {
      if (err) reject(new Error('WSFE error: ' + err.message));
      else resolve(res);
    });
  });

  // La clave de resultado varía según versión del cliente SOAP
  const r = result.FECAESolicitarResult || result;

  // Verificar errores de cabecera
  const cabErr = r.Errors?.Err;
  if (cabErr) {
    const errs = Array.isArray(cabErr) ? cabErr : [cabErr];
    throw new Error('WSFE: ' + errs.map(e => `[${e.Code}] ${e.Msg}`).join('; '));
  }

  // Obtener detalle de respuesta
  const detResp = r.FeDetResp?.FECAEDetResponse;
  const det = Array.isArray(detResp) ? detResp[0] : (detResp?.FECAEDetResponse || detResp);

  if (!det) throw new Error('WSFE: respuesta sin detalle');

  if (det.Resultado === 'R') {
    const obs = det.Observaciones?.Obs;
    const obsArr = obs ? (Array.isArray(obs) ? obs : [obs]) : [];
    throw new Error('AFIP rechazó: ' + (obsArr.map(o => `[${o.Code}] ${o.Msg}`).join('; ') || 'sin observaciones'));
  }

  return {
    cae:             String(det.CAE || ''),
    vto_cae:         String(det.CAEFchVto || ''),
    nro_comprobante: parseInt(det.CbteDesde || 0),
    resultado:       det.Resultado,
  };
}

// ── Handler ────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const {
      tipo_comprobante  = 'FAC. ELEC. B',
      punto_venta,
      nro_comprobante,
      importe_total,
      importe_neto_gravado,
      importe_iva,
      importe_otros     = 0,
      importe_op_exentas = 0,
      fecha_comprobante,
      concepto          = 1,
      cuit_receptor,
    } = body;

    // Credenciales desde env vars de Netlify
    const cuit      = (process.env.AFIP_CUIT || '').replace(/[-\s]/g, '');
    const certPem   = (process.env.AFIP_CERT_PEM  || '').replace(/\\n/g, '\n');
    const keyPem    = (process.env.AFIP_KEY_PEM   || '').replace(/\\n/g, '\n');
    const produccion = process.env.AFIP_PRODUCCION === '1';
    const ptoVenta  = punto_venta ?? parseInt(process.env.AFIP_PUNTO_VENTA || '1');

    if (!cuit)    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'AFIP_CUIT no configurado' }) };
    if (!certPem) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'AFIP_CERT_PEM no configurado' }) };
    if (!keyPem)  return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'AFIP_KEY_PEM no configurado' }) };

    const tipoComp = TIPO_COMP[(tipo_comprobante || '').toUpperCase()] ?? 6;

    const fechaComp = fecha_comprobante
      ? String(fecha_comprobante).replace(/-/g, '')
      : new Date().toISOString().slice(0, 10).replace(/-/g, '');

    const cuitRecep = String(cuit_receptor || '').replace(/[-\s]/g, '');
    const tipoDocRec = (cuitRecep && cuitRecep !== '0') ? 80 : 99;
    const nroDocRec  = (cuitRecep && cuitRecep !== '0') ? parseInt(cuitRecep) : 0;

    const r2 = (n) => Math.round(Number(n) * 100) / 100;

    const datos = {
      Concepto:     concepto,
      DocTipo:      tipoDocRec,
      DocNro:       nroDocRec,
      CbteDesde:    nro_comprobante,
      CbteHasta:    nro_comprobante,
      CbteFch:      fechaComp,
      ImpTotal:     r2(importe_total),
      ImpTotConc:   0,
      ImpNeto:      r2(importe_neto_gravado),
      ImpOpEx:      r2(importe_op_exentas),
      ImpTrib:      r2(importe_otros),
      ImpIVA:       r2(importe_iva),
      FchServDesde: concepto >= 2 ? fechaComp : null,
      FchServHasta: concepto >= 2 ? fechaComp : null,
      FchVtoPago:   concepto >= 2 ? fechaComp : null,
      MonId:        'PES',
      MonCotiz:     1,
      Iva: r2(importe_iva) > 0 ? {
        AlicIva: [{ Id: 5, BaseImp: r2(importe_neto_gravado), Importe: r2(importe_iva) }],
      } : null,
    };

    const { token, sign } = await getTicketAcceso(certPem, keyPem, produccion);
    const caeResult = await solicitarCAE({ token, sign, cuit, ptoVenta, tipoComp, datos, produccion });

    return { statusCode: 200, headers: CORS, body: JSON.stringify(caeResult) };

  } catch (err) {
    console.error('[afip-cae]', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
