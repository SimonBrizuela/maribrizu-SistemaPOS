/**
 * Google contestado de memoria para las funciones de avisos y reclamos:
 * Firestore por REST (documentos por ruta), Firebase Cloud Messaging y Storage.
 *
 * Va aparte de `rest_falso.js` a propósito: ese lo comparten crear-pedido,
 * validar-cupon y medir, y agregarle casos para esto era arriesgar que una
 * prueba vieja pase por el camino nuevo sin enterarse.
 */
import { aCampos } from '../netlify/functions/lib/firestore.mjs';
import { desplanar, respuesta } from './rest_falso.js';

export { CUENTA } from './rest_falso.js';

export function crearGoogle() {
  return {
    // 'coleccion/id' -> datos planos
    docs: {},
    // Lo que se escribió por :commit, ya desenvuelto: [{ruta, campos, mascara, precondicion}]
    escrituras: [],
    creados: [],
    // Cada notificación mandada: {token, data}
    mensajes: [],
    // token -> status con que contesta FCM (por defecto 200)
    fcm: {},
    fcmCaido: false,
    // Cada archivo subido a Storage: {nombre, tipo, llave, bytes}
    subidas: [],
    storageCaido: false,
    firestoreCaido: false,
    scopes: [],
  };
}

const RUTA_DOC = /\/documents\/([^/]+)\/([^/?:]+)$/;

export function fetchGoogle(g) {
  return async function (url, opciones = {}) {
    const u = String(url);

    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      const jwt = new URLSearchParams(opciones.body).get('assertion');
      g.scopes.push(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).scope);
      return respuesta({ access_token: 'token-de-prueba', expires_in: 3600 });
    }

    if (u.includes('fcm.googleapis.com')) {
      const { message } = JSON.parse(opciones.body);
      if (g.fcmCaido) throw new Error('sin red');
      const status = g.fcm[message.token] ?? 200;
      if (status === 200) {
        g.mensajes.push({ token: message.token, data: message.webpush?.data, headers: message.webpush?.headers });
        return respuesta({ name: 'projects/x/messages/1' });
      }
      return respuesta({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }, status);
    }

    if (u.startsWith('https://storage.googleapis.com/upload/')) {
      if (g.storageCaido) return respuesta({ error: { message: 'Forbidden' } }, 403);
      // Subida multipart: primero los datos del archivo en JSON, después el archivo.
      const crudo = Buffer.from(opciones.body);
      const texto = crudo.toString('latin1');
      const inicio = texto.indexOf('{');
      const finDatos = texto.indexOf('\r\n--', inicio);
      const meta = JSON.parse(texto.slice(inicio, finDatos));
      const cabeceraArchivo = texto.indexOf('\r\n\r\n', finDatos) + 4;
      const fin = texto.lastIndexOf('\r\n--');
      g.subidas.push({
        nombre: meta.name, tipo: meta.contentType, llave: meta.metadata?.firebaseStorageDownloadTokens,
        bytes: crudo.subarray(cabeceraArchivo, fin),
      });
      return respuesta({ name: meta.name, bucket: 'mari-d7c71.firebasestorage.app' });
    }

    if (u.endsWith(':commit')) {
      if (!opciones.headers?.Authorization) return respuesta({ error: 'PERMISSION_DENIED' }, 403);
      if (g.firestoreCaido) return respuesta({ error: 'UNAVAILABLE' }, 503);
      const writes = JSON.parse(opciones.body).writes.map(w => {
        const [, col, id] = w.update.name.match(/documents\/([^/]+)\/([^/]+)$/);
        return { w, ruta: `${col}/${id}` };
      });
      // Como la base: si una condición falla no se escribe ninguna.
      for (const { w, ruta } of writes) {
        if (w.currentDocument?.exists === true && !g.docs[ruta]) return respuesta({ error: 'NOT_FOUND' }, 404);
        if (w.currentDocument?.exists === false && g.docs[ruta]) return respuesta({ error: 'ALREADY_EXISTS' }, 409);
      }
      for (const { w, ruta } of writes) {
        const campos = desplanar(w.update.fields || {});
        g.escrituras.push({ ruta, campos, mascara: w.updateMask?.fieldPaths, precondicion: w.currentDocument });
        g.docs[ruta] = w.updateMask ? { ...(g.docs[ruta] || {}), ...campos } : campos;
      }
      return respuesta({ writeResults: writes.map(() => ({})) });
    }

    const creacion = u.match(/\/documents\/([^/?]+)\?documentId=([^&]+)/);
    if (creacion && opciones.method === 'POST') {
      const ruta = `${creacion[1]}/${decodeURIComponent(creacion[2])}`;
      if (g.docs[ruta]) return respuesta({}, 409);
      const campos = desplanar(JSON.parse(opciones.body).fields);
      g.docs[ruta] = campos;
      g.creados.push({ ruta, campos });
      return respuesta({ name: ruta });
    }

    const lectura = u.match(RUTA_DOC);
    if (lectura && (!opciones.method || opciones.method === 'GET')) {
      const ruta = `${lectura[1]}/${decodeURIComponent(lectura[2])}`;
      // Lo privado (avisos, reclamos) solo se lee con token, como en las reglas.
      const publico = ['tienda_pedidos', 'tienda_config', 'tienda_productos'].includes(lectura[1]);
      if (!publico && !opciones.headers?.Authorization) return respuesta({ error: 'PERMISSION_DENIED' }, 403);
      const datos = g.docs[ruta];
      return datos ? respuesta({ name: ruta, fields: aCampos(datos) }) : respuesta({}, 404);
    }

    throw new Error(`fetch sin mockear: ${opciones.method || 'GET'} ${u}`);
  };
}

export function pedir(nombre, cuerpo, { metodo = 'POST', origen = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origen) headers.Origin = origen;
  return new Request(`https://beta.liceolibreria.com/.netlify/functions/${nombre}`, {
    method: metodo,
    headers,
    ...(metodo === 'POST' ? { body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo) } : {}),
  });
}
