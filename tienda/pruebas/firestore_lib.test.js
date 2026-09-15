/**
 * La biblioteca con la que las funciones de Netlify hablan con Google.
 *
 * Hasta ahora solo escribía en Firestore. Los avisos al celular (Firebase Cloud
 * Messaging) y las fotos de los reclamos (Storage) necesitan tokens con otros
 * permisos. Cada permiso va en su token: pedirlos todos juntos le daría a una
 * función que solo escribe en la base un token que también manda notificaciones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CUENTA } from './rest_falso.js';

let pedidos;

function respuesta(cuerpo, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300, status,
    json: async () => cuerpo, text: async () => JSON.stringify(cuerpo),
  });
}

/** El scope que pidió un canje de JWT, leído del JWT mismo. */
function scopeDe(peticion) {
  const jwt = new URLSearchParams(peticion.opciones.body).get('assertion');
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).scope;
}

async function cargar() {
  vi.resetModules();
  return import('../netlify/functions/lib/firestore.mjs');
}

beforeEach(() => {
  pedidos = [];
  process.env.FIREBASE_SERVICE_ACCOUNT = CUENTA;
  vi.stubGlobal('fetch', vi.fn((url, opciones = {}) => {
    pedidos.push({ url: String(url), opciones });
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      return respuesta({ access_token: `token-${pedidos.length}`, expires_in: 3600 });
    }
    return respuesta({ writeResults: [{}] });
  }));
});

describe('tokens por permiso', () => {
  it('cada permiso pide su propio token y lo reusa', async () => {
    const lib = await cargar();
    const a = await lib.tokenPara(lib.PERMISOS.mensajes);
    const b = await lib.tokenPara(lib.PERMISOS.mensajes);
    const c = await lib.tokenPara(lib.PERMISOS.archivos);

    const canjes = pedidos.filter(p => p.url.startsWith('https://oauth2'));
    expect(canjes.map(scopeDe)).toEqual([
      'https://www.googleapis.com/auth/firebase.messaging',
      'https://www.googleapis.com/auth/devstorage.read_write',
    ]);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it('la base sigue con el permiso de siempre y sin nada más', async () => {
    const lib = await cargar();
    await lib.escribirCampos('tienda_avisos', 'p1', { tokens: ['t'] });
    const canje = pedidos.find(p => p.url.startsWith('https://oauth2'));
    expect(scopeDe(canje)).toBe('https://www.googleapis.com/auth/datastore');
  });
});

describe('escribirCampos', () => {
  const commit = () => JSON.parse(pedidos.find(p => p.url.endsWith(':commit')).opciones.body);

  it('escribe solo los campos que se nombran: el resto del documento no se toca', async () => {
    const lib = await cargar();
    await lib.escribirCampos('tienda_pedidos', 'abc', { reclamo: { estado: 'nuevo' }, reclamos_cantidad: 1 });

    const [escritura] = commit().writes;
    expect(escritura.update.name).toMatch(/documents\/tienda_pedidos\/abc$/);
    expect(escritura.updateMask.fieldPaths.sort()).toEqual(['reclamo', 'reclamos_cantidad']);
    expect(Object.keys(escritura.update.fields).sort()).toEqual(['reclamo', 'reclamos_cantidad']);
  });

  it('por defecto el documento tiene que existir: no se inventa un pedido', async () => {
    const lib = await cargar();
    await lib.escribirCampos('tienda_pedidos', 'abc', { reclamo: null });
    expect(commit().writes[0].currentDocument).toEqual({ exists: true });
  });

  it('con crear, nace si no existía', async () => {
    const lib = await cargar();
    await lib.escribirCampos('tienda_avisos', 'abc', { tokens: [] }, { crear: true });
    expect(commit().writes[0].currentDocument).toBeUndefined();
  });

  it('si la base lo rechaza, tira con el motivo', async () => {
    const lib = await cargar();
    fetch.mockImplementation((url) => (String(url).startsWith('https://oauth2')
      ? respuesta({ access_token: 't', expires_in: 3600 })
      : respuesta({ error: { message: 'NOT_FOUND' } }, 404)));
    await expect(lib.escribirCampos('tienda_pedidos', 'x', { a: 1 })).rejects.toThrow(/404/);
  });
});
