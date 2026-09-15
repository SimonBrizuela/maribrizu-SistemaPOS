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

/**
 * Los permisos que puede pedir una función, cada uno en su propio token. Sin
 * `cloud-platform`: si un token se filtra sirve para una sola cosa. La base es
 * el de siempre; los avisos al celular y las fotos de los reclamos piden el
 * suyo recién cuando los usan.
 */
export const PERMISOS = {
  base: 'https://www.googleapis.com/auth/datastore',
  mensajes: 'https://www.googleapis.com/auth/firebase.messaging',
  archivos: 'https://www.googleapis.com/auth/devstorage.read_write',
};

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
// en que el cliente está esperando la confirmación. Uno por permiso.
const _tokens = new Map();      // permiso -> { token, vence }
// Varias lecturas arrancan a la vez dentro de un mismo pedido (los pedidos
// abiertos, el código libre): sin esto cada una pedía su propio token.
const _tokensEnCurso = new Map();

/** Un access token de Google para ese permiso, reusado mientras dure. */
export async function tokenPara(permiso = PERMISOS.base) {
  const guardado = _tokens.get(permiso);
  if (guardado && Date.now() < guardado.vence - 60_000) return guardado.token;
  if (!_tokensEnCurso.has(permiso)) {
    _tokensEnCurso.set(permiso,
      pedirToken(permiso).finally(() => { _tokensEnCurso.delete(permiso); }));
  }
  return _tokensEnCurso.get(permiso);
}

const accessToken = () => tokenPara(PERMISOS.base);

async function pedirToken(permiso) {
  const crudo = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!crudo) throw new Error('falta FIREBASE_SERVICE_ACCOUNT');

  // Se acepta el JSON crudo o en base64, igual que `provision.js` del panel: el
  // base64 evita que las comillas y los saltos de línea de la private_key se
  // rompan al pegarlo por consola. Las dos formas están en uso.
  let cuenta;
  try {
    const texto = crudo.trim().startsWith('{')
      ? crudo
      : Buffer.from(crudo, 'base64').toString('utf-8');
    cuenta = JSON.parse(texto);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT no es un JSON ni un base64 válido');
  }

  if (!cuenta.client_email || !cuenta.private_key) {
    throw new Error('la cuenta de servicio no tiene client_email/private_key');
  }

  const ahora = Math.floor(Date.now() / 1000);
  const cabecera = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const cuerpo = b64url(JSON.stringify({
    iss: cuenta.client_email,
    scope: permiso,
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
  _tokens.set(permiso, {
    token: datos.access_token,
    vence: Date.now() + (Number(datos.expires_in) || 3600) * 1000,
  });
  return datos.access_token;
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
 * Escribe algunos campos de un documento sin tocar el resto.
 *
 * La máscara nombra exactamente lo que se escribe: el reclamo se anota en el
 * pedido sin pisar el estado, el total ni lo que el local marcó mientras tanto.
 * Por defecto el documento tiene que existir (un pedido no nace de un reclamo);
 * con `crear` nace si falta.
 */
export async function escribirCampos(coleccion, id, valores, { crear = false } = {}) {
  return escribirJuntos([{ coleccion, id, valores, condicion: crear ? 'cualquiera' : 'existe' }]);
}

/**
 * Varias escrituras en un solo commit: entran todas o ninguna.
 *
 * Cada una lleva su condición:
 *   · 'existe' (la de siempre): escribe esos campos en un documento que ya está.
 *   · 'nuevo': crea el documento entero y falla si ya existe. Dos reclamos que
 *     llegan a la vez piden el mismo número; con esto entra uno solo, y el
 *     resumen que va al pedido no queda escrito por el que perdió.
 *   · 'cualquiera': escribe esos campos exista o no.
 *
 * @param {Array<{coleccion: string, id: string, valores: object, condicion?: 'existe'|'nuevo'|'cualquiera'}>} escrituras
 * @throws {Error & {status: number, yaExiste?: boolean}}
 */
export async function escribirJuntos(escrituras) {
  const token = await accessToken();
  const writes = escrituras.map(({ coleccion, id, valores, condicion = 'existe' }) => ({
    update: {
      name: `projects/${PROYECTO}/databases/(default)/documents/${coleccion}/${id}`,
      fields: aCampos(valores),
    },
    ...(condicion === 'nuevo' ? {} : { updateMask: { fieldPaths: Object.keys(valores).map(c => rutaDeCampo([c])) } }),
    ...(condicion === 'existe' ? { currentDocument: { exists: true } } : {}),
    ...(condicion === 'nuevo' ? { currentDocument: { exists: false } } : {}),
  }));

  const respuesta = await fetch(`${BASE}:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes }),
  });
  if (!respuesta.ok) {
    const destino = escrituras.map(e => `${e.coleccion}/${e.id}`).join(', ');
    const err = new Error(`Firestore devolvió ${respuesta.status} escribiendo ${destino}: ${(await respuesta.text()).slice(0, 300)}`);
    err.status = respuesta.status;
    if (respuesta.status === 409) err.yaExiste = true;
    throw err;
  }
  return respuesta.json();
}

/* ── Archivos ─────────────────────────────────────────────────────────────── */

export const BUCKET = `${PROYECTO}.firebasestorage.app`;

/**
 * Sube un archivo a Storage y devuelve un enlace para verlo.
 *
 * El enlace es el mismo que arma Firebase: lleva un token largo que no se
 * adivina y abre sin sesión. Así el panel muestra la foto con un `<img>` sin
 * que haga falta publicar reglas nuevas de Storage, y quien no tiene el enlace
 * (que solo está en `tienda_reclamos`, cerrada al público) no llega al archivo.
 *
 * @param {string} ruta  dentro del bucket, p. ej. `reclamos/{id}/1.webp`
 * @param {Uint8Array} bytes
 * @param {string} tipo  el Content-Type
 * @returns {Promise<{ruta: string, url: string}>}
 */
export async function subirArchivo(ruta, bytes, tipo) {
  const token = await tokenPara(PERMISOS.archivos);
  const llave = crypto.randomUUID();
  const limite = `liceo-${crypto.randomBytes(12).toString('hex')}`;
  const datos = JSON.stringify({
    name: ruta,
    contentType: tipo,
    metadata: { firebaseStorageDownloadTokens: llave },
  });
  const cuerpo = Buffer.concat([
    Buffer.from(`--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${datos}\r\n`),
    Buffer.from(`--${limite}\r\nContent-Type: ${tipo}\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${limite}--`),
  ]);

  const respuesta = await fetch(
    `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=multipart`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${limite}` },
      body: cuerpo,
    });
  if (!respuesta.ok) {
    throw new Error(`Storage devolvió ${respuesta.status} subiendo ${ruta}: ${(await respuesta.text()).slice(0, 300)}`);
  }
  return {
    ruta,
    url: `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(ruta)}?alt=media&token=${llave}`,
  };
}

/**
 * Un documento de una colección cerrada al público, con la cuenta de
 * servicio. Los cupones viven así: si cualquiera pudiera leer la colección,
 * podría listar los códigos vigentes.
 *
 * @returns {Promise<object|null>}
 */
export async function leerDocPrivado(coleccion, id) {
  const token = await accessToken();
  const respuesta = await fetch(`${BASE}/${coleccion}/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (respuesta.status === 404) return null;
  if (!respuesta.ok) throw new Error(`Firestore devolvió ${respuesta.status} leyendo ${coleccion}/${id}`);
  const crudo = await respuesta.json();
  return aplanar(crudo.fields || {});
}

/**
 * Borra un documento. Lo usa el pedido que se retira solo al descubrir, ya
 * escrito, que otro entró en el mismo instante por la misma última unidad.
 */
export async function borrarDoc(coleccion, id) {
  const token = await accessToken();
  const respuesta = await fetch(`${BASE}/${coleccion}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!respuesta.ok && respuesta.status !== 404) {
    throw new Error(`Firestore devolvió ${respuesta.status} borrando ${coleccion}/${id}`);
  }
}

/**
 * Una consulta sobre una colección cerrada al público, con la cuenta de
 * servicio.
 *
 * `tienda_pedidos` no se puede listar sin sesión —es lo que impide que un
 * cliente vea los pedidos de otro—, así que "los pedidos abiertos" o "un
 * pedido con este código" solo se pueden buscar desde acá.
 *
 * Los filtros van como ternas `[campo, operador, valor]` con los operadores de
 * la API (`EQUAL`, `IN`, ...). Con `campos` se piden solo esos, que para
 * contar lo prometido en cien pedidos evita bajar cien pedidos enteros.
 *
 * @returns {Promise<Array<{id: string} & Record<string, any>>>}
 */
export async function consultar(coleccion, { where = [], limite = 100, campos = null } = {}) {
  const token = await accessToken();

  const filtros = where.map(([campo, op, valor]) => ({
    fieldFilter: { field: { fieldPath: campo }, op, value: aValor(valor) },
  }));
  const structuredQuery = {
    from: [{ collectionId: coleccion }],
    limit: limite,
    ...(filtros.length === 1 ? { where: filtros[0] } : {}),
    ...(filtros.length > 1 ? { where: { compositeFilter: { op: 'AND', filters: filtros } } } : {}),
    ...(campos ? { select: { fields: campos.map(c => ({ fieldPath: c })) } } : {}),
  };

  const respuesta = await fetch(`${BASE}:runQuery`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
  });

  if (!respuesta.ok) {
    throw new Error(`Firestore devolvió ${respuesta.status} consultando ${coleccion}: ${(await respuesta.text()).slice(0, 300)}`);
  }

  // Una consulta sin resultados no devuelve una lista vacía: devuelve una fila
  // con solo `readTime`.
  const filas = await respuesta.json();
  return (Array.isArray(filas) ? filas : [])
    .filter(f => f.document)
    .map(f => ({ id: f.document.name.split('/').pop(), ...aplanar(f.document.fields || {}) }));
}

/* ── Sumar contadores ─────────────────────────────────────────────────────── */

const RE_SEGMENTO_SIMPLE = /^[A-Za-z_][A-Za-z_0-9]*$/;

/**
 * Una ruta de campo como la espera la API: los tramos que no son un
 * identificador simple van entre acentos graves (`productos.\`1035115\`.vistas`).
 */
export function rutaDeCampo(segmentos) {
  return segmentos.map(s => {
    const texto = String(s);
    if (RE_SEGMENTO_SIMPLE.test(texto)) return texto;
    return '`' + texto.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
  }).join('.');
}

function hojasDe(objeto, fn, ruta = []) {
  for (const [clave, valor] of Object.entries(objeto || {})) {
    if (valor && typeof valor === 'object' && !(valor instanceof Date)) hojasDe(valor, fn, [...ruta, clave]);
    else fn([...ruta, clave], valor);
  }
}

/**
 * Le suma contadores a un documento y le deja escritos algunos valores, en
 * una sola operación y sin leerlo antes.
 *
 * Los `contadores` son un objeto anidado de números: cada hoja se convierte
 * en un incremento atómico, así dos tandas que llegan en el mismo instante
 * suman las dos en vez de pisarse. Los `valores` son hojas que se dejan como
 * están (el nombre de un producto). Si el documento no existe, nace con esta
 * escritura; los campos que ya tenía y no se nombran acá quedan intactos.
 *
 * Lo usan las estadísticas de la tienda: un documento por día, y cada visita
 * le suma lo suyo sin importar cuántas lleguen a la vez.
 */
export async function sumarAlDoc(coleccion, id, { contadores = {}, valores = {} } = {}) {
  const token = await accessToken();
  const nombre = `projects/${PROYECTO}/databases/(default)/documents/${coleccion}/${id}`;

  const transformaciones = [];
  hojasDe(contadores, (ruta, cuanto) => {
    const entero = Math.round(Number(cuanto));
    if (!Number.isFinite(entero) || entero === 0) return;
    transformaciones.push({ fieldPath: rutaDeCampo(ruta), increment: { integerValue: String(entero) } });
  });
  transformaciones.push({ fieldPath: 'actualizado', setToServerValue: 'REQUEST_TIME' });

  // La máscara nombra exactamente lo que se escribe: sin ella `update`
  // reemplaza el documento entero y se pierde todo lo sumado hasta ahora.
  const rutas = [];
  hojasDe(valores, ruta => rutas.push(rutaDeCampo(ruta)));

  const escritura = {
    update: { name: nombre, fields: aCampos(valores) },
    updateMask: { fieldPaths: rutas },
    updateTransforms: transformaciones,
  };

  const respuesta = await fetch(`${BASE}:commit`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ writes: [escritura] }),
  });

  if (!respuesta.ok) {
    throw new Error(`Firestore devolvió ${respuesta.status} sumando en ${coleccion}/${id}: ${(await respuesta.text()).slice(0, 300)}`);
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
