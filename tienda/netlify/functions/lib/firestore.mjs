/**
 * Firestore desde las funciones de la tienda, por REST.
 *
 * Dos modos, y la diferencia importa:
 *
 *   · Leer va sin credenciales. `tienda_productos` y `tienda_config` son
 *     públicos por reglas: es exactamente lo mismo que ve el navegador de
 *     cualquiera que entra a la tienda, así que meter una cuenta de servicio
 *     para eso sería darle a la función un permiso que no necesita.
 *
 *   · Escribir va con la cuenta de servicio, que vive únicamente en la variable
 *     de entorno `FIREBASE_SERVICE_ACCOUNT` de Netlify. Es lo que permite que
 *     las reglas cierren la creación de pedidos del lado del cliente: si el
 *     precio lo pone el navegador, el precio lo pone el que paga.
 *
 * El JWT se firma con `node:crypto` y se canjea por un access token de Google,
 * igual que `webapp/netlify/functions/provision.js`. Sin dependencias nuevas: el
 * paquete de firebase-admin son 40 MB de lambda para hacer esto mismo.
 *
 * Va en `lib/` y no como archivo suelto porque cada `.mjs` de
 * `netlify/functions/` se despliega como una función propia.
 */
import crypto from 'node:crypto';

export const PROYECTO = 'mari-d7c71';

const BASE = `https://firestore.googleapis.com/v1/projects/${PROYECTO}` +
             '/databases/(default)/documents';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// datastore = Firestore. Sin `cloud-platform`: si el token se filtra no sirve
// para tocar ningún otro servicio del proyecto.
const SCOPE = 'https://www.googleapis.com/auth/datastore';

/* ── Leer ─────────────────────────────────────────────────────────────────── */

/**
 * Un documento público, o null si no existe.
 * @returns {Promise<object|null>}
 */
export async function leerDoc(coleccion, id) {
  const respuesta = await fetch(`${BASE}/${coleccion}/${encodeURIComponent(id)}`);
  if (respuesta.status === 404 || respuesta.status === 403) return null;
  if (!respuesta.ok) throw new Error(`Firestore devolvió ${respuesta.status} leyendo ${coleccion}/${id}`);
  const crudo = await respuesta.json();
  return aplanar(crudo.fields || {});
}

/**
 * La API REST devuelve cada valor envuelto en su tipo (`{stringValue: "..."}`),
 * así que hay que desenvolverlo para poder usarlo.
 */
export function aplanar(campos) {
  const salida = {};
  for (const [clave, valor] of Object.entries(campos)) salida[clave] = valorDe(valor);
  return salida;
}

export function valorDe(v) {
  if (v == null) return null;
  if ('stringValue'    in v) return v.stringValue;
  if ('integerValue'   in v) return Number(v.integerValue);
  if ('doubleValue'    in v) return Number(v.doubleValue);
  if ('booleanValue'   in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue'      in v) return null;
  if ('mapValue'       in v) return aplanar(v.mapValue.fields || {});
  if ('arrayValue'     in v) return (v.arrayValue.values || []).map(valorDe);
  return null;
}

// La configuración cambia poco y estas funciones pueden ejecutarse muchas veces
// seguidas. La instancia se reusa entre invocaciones mientras siga caliente.
let _config = null;
let _configAt = 0;
const CONFIG_TTL_MS = 5 * 60_000;

/** `tienda_config/settings`, con caché corta. */
export async function leerConfigTienda() {
  if (_config && Date.now() - _configAt < CONFIG_TTL_MS) return _config;
  const datos = await leerDoc('tienda_config', 'settings');
  if (!datos) throw new Error('no existe tienda_config/settings');
  _config = datos;
  _configAt = Date.now();
  return _config;
}

/* ── Escribir ─────────────────────────────────────────────────────────────── */

/** El camino de vuelta: JS a la forma que espera la API. */
export function aCampos(objeto) {
  const campos = {};
  for (const [clave, valor] of Object.entries(objeto)) {
    if (valor === undefined) continue;
    campos[clave] = aValor(valor);
  }
  return campos;
}

export function aValor(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    // Firestore distingue entero de doble. Los precios de la tienda son enteros
    // (pesos) y las cantidades pueden ser 2,5 metros: mandar todo como doble
    // haría que el POS y el panel leyeran 3.0 donde antes había un 3.
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(aValor) } };
  if (typeof v === 'object') return { mapValue: { fields: aCampos(v) } };
  return { stringValue: String(v) };
}

/** Si hay cuenta de servicio configurada. Sin ella la función se declara apagada. */
export function hayCredenciales() {
  return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT);
}

// El token dura una hora y la instancia se reusa entre invocaciones mientras
// siga caliente: pedir uno nuevo por pedido sería un viaje de más en el momento
// en que el cliente está esperando la confirmación.
let _token = null;
let _tokenVence = 0;

async function accessToken() {
  if (_token && Date.now() < _tokenVence - 60_000) return _token;

  const crudo = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!crudo) throw new Error('falta FIREBASE_SERVICE_ACCOUNT');

  let cuenta;
  try {
    cuenta = JSON.parse(crudo);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT no es un JSON válido');
  }

  const ahora = Math.floor(Date.now() / 1000);
  const cabecera = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const cuerpo = b64url(JSON.stringify({
    iss: cuenta.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    exp: ahora + 3600,
    iat: ahora,
  }));

  const firma = crypto.createSign('RSA-SHA256');
  firma.update(`${cabecera}.${cuerpo}`);
  const jwt = `${cabecera}.${cuerpo}.${b64url(firma.sign(cuenta.private_key))}`;

  const respuesta = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!respuesta.ok) {
    throw new Error(`Google rechazó el JWT: ${respuesta.status} ${await respuesta.text()}`);
  }

  const datos = await respuesta.json();
  _token = datos.access_token;
  _tokenVence = Date.now() + (Number(datos.expires_in) || 3600) * 1000;
  return _token;
}

function b64url(entrada) {
  return Buffer.from(entrada).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Crea un documento con un id elegido. Falla si ya existe.
 *
 * Que falle es la gracia: con transferencia el id se reserva antes de subir el
 * comprobante, y sin este control un segundo POST con el mismo id pisaría el
 * pedido que el local ya está preparando.
 *
 * @throws {Error & {yaExiste?: boolean}}
 */
export async function crearDoc(coleccion, id, datos) {
  const token = await accessToken();
  const url = `${BASE}/${coleccion}?documentId=${encodeURIComponent(id)}`;

  const respuesta = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: aCampos(datos) }),
  });

  if (respuesta.status === 409) {
    const err = new Error('El pedido ya existe');
    err.yaExiste = true;
    throw err;
  }
  if (!respuesta.ok) {
    throw new Error(`Firestore devolvió ${respuesta.status}: ${(await respuesta.text()).slice(0, 300)}`);
  }

  return respuesta.json();
}

/**
 * Quién es el dueño de un token de sesión, o null.
 *
 * Firma el pedido con la cuenta para que después aparezca en "Mis pedidos"
 * desde cualquier teléfono. Se verifica contra Google y no se cree lo que
 * manda el cliente: aceptar un `uid` a secas dejaría meterle pedidos al
 * historial de cualquier otro.
 *
 * La apiKey es la pública de la tienda, la misma que viaja en el bundle.
 */
export async function uidDelToken(idToken, apiKey) {
  if (!idToken || !apiKey) return null;
  try {
    const respuesta = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
    if (!respuesta.ok) return null;
    const datos = await respuesta.json();
    return datos?.users?.[0]?.localId || null;
  } catch (err) {
    // Sin cuenta el pedido entra igual: firmar es un extra, no un requisito.
    console.warn('[firestore] no se pudo verificar la sesión:', err);
    return null;
  }
}
