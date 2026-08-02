/**
 * provision — emisor de credenciales de corta duración para el POS.
 *
 * Antes cada PC llevaba `firebase_key.json` adentro del instalador, y el
 * instalador se publica en un GitHub Release público: cualquiera podía bajar
 * el ZIP, extraer la service account y tener Admin SDK sobre todo el proyecto.
 *
 * Ahora la service account vive únicamente acá, en una variable de entorno de
 * Netlify. El POS pide un access token, lo usa una hora y lo renueva solo.
 * Lo peor que se puede sacar de una PC es un token que ya venció.
 *
 * Variables de entorno requeridas:
 *   FIREBASE_SERVICE_ACCOUNT  JSON completo de la service account.
 *   POS_BOOTSTRAP_SECRET      Secreto compartido con el POS. Rotable sin
 *                             tocar las PCs: al rotarlo, las que quedaron con
 *                             el viejo dejan de renovar.
 *   POS_BLOCKED_DEVICES       (opcional) pc_ids separados por coma a rechazar.
 */

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// datastore = Firestore. No pedimos cloud-platform: si el token se filtra, no
// sirve para tocar ningún otro servicio del proyecto.
const SCOPE = 'https://www.googleapis.com/auth/datastore';

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** Comparación en tiempo constante: no filtra el secreto por timing. */
function secretMatches(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Firma el JWT y lo canjea por un access token de Google. */
async function mintAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss:   sa.client_email,
    scope: SCOPE,
    aud:   TOKEN_URL,
    exp:   now + 3600,
    iat:   now,
  }));

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = b64url(signer.sign(sa.private_key));

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  `${header}.${claims}.${signature}`,
    }),
  });

  if (!res.ok) {
    throw new Error(`Google rechazo el JWT: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

const FIRESTORE = 'https://firestore.googleapis.com/v1/projects';

/** ¿La PC ya venia sincronizando? Se mira su heartbeat en `pcs`. */
async function deviceIsKnown(projectId, accessToken, pcId) {
  const url = `${FIRESTORE}/${projectId}/databases/(default)/documents/pcs/${encodeURIComponent(pcId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) return false;
  if (!res.ok) {
    // Ante un error de Firestore no dejamos la libreria sin sincronizar:
    // preferimos emitir el token y que quede el registro en el log.
    console.error(`provision: no se pudo verificar pcs/${pcId}: HTTP ${res.status}`);
    return true;
  }
  return true;
}

/**
 * Ventana de alta para PCs nuevas: documento control_config/provisioning con
 * el campo `enrollment_open_until` (ISO 8601). Se abre con
 * `python scripts/provisioning.py abrir` y se cierra sola.
 */
async function enrollmentIsOpen(projectId, accessToken) {
  const url = `${FIRESTORE}/${projectId}/databases/(default)/documents/control_config/provisioning`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return false;

  const doc = await res.json();
  const hasta = doc?.fields?.enrollment_open_until?.stringValue
             || doc?.fields?.enrollment_open_until?.timestampValue;
  if (!hasta) return false;

  const vence = Date.parse(hasta);
  return Number.isFinite(vence) && Date.now() < vence;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  const rawSA = process.env.FIREBASE_SERVICE_ACCOUNT;
  const secret = process.env.POS_BOOTSTRAP_SECRET;
  if (!rawSA || !secret) {
    console.error('provision: faltan FIREBASE_SERVICE_ACCOUNT o POS_BOOTSTRAP_SECRET');
    return { statusCode: 500, body: JSON.stringify({ error: 'server_misconfigured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_json' }) };
  }

  const pcId     = String(body.pc_id || '').slice(0, 120);
  const hostname = String(body.hostname || '').slice(0, 120);
  const version  = String(body.app_version || '').slice(0, 40);

  if (!secretMatches(body.secret, secret)) {
    console.warn(`provision: secreto invalido desde pc_id=${pcId} host=${hostname}`);
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  // Corte de emergencia por PC, sin necesidad de rotar el secreto global.
  const blocked = (process.env.POS_BLOCKED_DEVICES || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (pcId && blocked.includes(pcId)) {
    console.warn(`provision: pc bloqueada pc_id=${pcId}`);
    return { statusCode: 403, body: JSON.stringify({ error: 'device_blocked' }) };
  }

  // Acepta el JSON crudo o en base64. El base64 evita que las comillas y los
  // saltos de linea de la private_key se rompan al cargarlo por consola.
  let sa;
  try {
    const texto = rawSA.trim().startsWith('{')
      ? rawSA
      : Buffer.from(rawSA, 'base64').toString('utf-8');
    sa = JSON.parse(texto);
  } catch (_) {
    console.error('provision: FIREBASE_SERVICE_ACCOUNT no es JSON ni base64 valido');
    return { statusCode: 500, body: JSON.stringify({ error: 'server_misconfigured' }) };
  }

  if (!sa.client_email || !sa.private_key) {
    console.error('provision: la service account no tiene client_email/private_key');
    return { statusCode: 500, body: JSON.stringify({ error: 'server_misconfigured' }) };
  }

  if (!pcId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'missing_pc_id' }) };
  }

  try {
    const token = await mintAccessToken(sa);

    // El secreto viaja dentro de un instalador publico, asi que por si solo no
    // puede ser la unica barrera: cualquiera que baje el Setup lo tiene. La
    // barrera real es el pc_id, que se genera una vez por maquina y queda en
    // %APPDATA% (sobrevive a las actualizaciones). Solo atendemos a PCs que ya
    // venian sincronizando, salvo que haya una ventana de alta abierta.
    const conocida = await deviceIsKnown(sa.project_id, token.access_token, pcId);

    if (!conocida) {
      const abierta = await enrollmentIsOpen(sa.project_id, token.access_token);
      if (!abierta) {
        console.warn(`provision: pc desconocida rechazada pc_id=${pcId} host=${hostname}`);
        return {
          statusCode: 403,
          body: JSON.stringify({ error: 'device_not_enrolled' }),
        };
      }
      console.log(`provision: alta de pc nueva pc_id=${pcId} host=${hostname}`);
    }

    console.log(`provision: token emitido pc_id=${pcId} host=${hostname} v=${version}`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        access_token: token.access_token,
        expires_in:   token.expires_in,
        project_id:   sa.project_id,
      }),
    };
  } catch (err) {
    console.error('provision: fallo al emitir token:', err.message);
    return { statusCode: 502, body: JSON.stringify({ error: 'token_mint_failed' }) };
  }
};
