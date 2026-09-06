/**
 * Firestore REST y las demás APIs de Google, contestadas de memoria.
 *
 * Lo comparten las pruebas de las funciones de Netlify (`crear-pedido`,
 * `validar-cupon`): las dos hablan con la base por REST y con la cuenta de
 * servicio, y mockear eso dos veces era la forma más segura de que un día
 * contestaran distinto.
 *
 * `crearMundo()` da el estado inicial; `fetchFalso(mundo)` devuelve el fetch
 * que lo lee y lo escribe.
 */
import crypto from 'node:crypto';
import { aCampos } from '../netlify/functions/lib/firestore.mjs';

/* ── Una cuenta de servicio de mentira, pero con una clave RSA de verdad ──── */

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export const CUENTA = JSON.stringify({
  client_email: 'tienda@mari-d7c71.iam.gserviceaccount.com',
  private_key: privateKey,
});

/* ── El estado que ven las funciones ──────────────────────────────────────── */

export const crearMundo = () => ({
  config: {
    abierta: true,
    origen: { lat: -31.354, lng: -64.173 },
    entrega: {
      retiro_habilitado: true, delivery_habilitado: true,
      radio_max_km: 12, pedido_minimo: 6500, demora_texto: '24 a 48 hs',
      tramos: [{ hasta_km: 3, precio: 1500 }, { hasta_km: 12, precio: 3500 }],
    },
    pago: { efectivo_habilitado: true },
  },
  productos: {
    resma: {
      nombre: 'Resma Pampa A4', precio: 18000, stock: 4, unidad: 'unidad',
      rubro: 'PAPELERIA', imagenes: ['c.webp'], variedades: [],
    },
    cartulina: {
      nombre: 'Cartulina Luma', precio: 800, stock: 100, unidad: 'unidad',
      rubro: 'LIBRERIA', imagenes: ['a.webp'],
      variedades: [
        { nombre: 'Rojo', stock: 10 },
        { nombre: 'Celeste', stock: 2, precio: 950 },
      ],
    },
    cinta: {
      nombre: 'Cinta Raso 10mm', precio: 300, stock: 60, unidad: 'metro',
      precio_pack: 4500, pack_tipo: 'rollo', pack_contenido: 25,
      rubro: 'MERCERIA', imagenes: [], variedades: [],
    },
  },
  // Los cupones, por código. La colección es privada: solo se lee con token.
  cupones: {},
  metros: 2500,
  guardados: [],
  // Pedidos abiertos que ya estaban en la base antes de este, con su estado.
  abiertos: [],
  borrados: [],
  // Qué consultas hizo la función (`estado`, `codigo`, `cupon.codigo`…), en orden.
  consultas: [],
  // Cuántas veces el código corto que se pregunta va a estar ocupado.
  codigoOcupadoVeces: 0,
  consultasFallan: false,
});

/** Todos los pedidos que la base "tiene": los previos y los guardados en la prueba. */
function todosLosPedidos(mundo) {
  return [...mundo.abiertos, ...mundo.guardados.map(g => ({ id: g.id, ...desplanar(g.cuerpo.fields) }))];
}

/** Un campo anidado ("cupon.codigo") de un documento aplanado. */
function campoDe(doc, ruta) {
  return ruta.split('.').reduce((acc, parte) => (acc == null ? undefined : acc[parte]), doc);
}

export function fetchFalso(mundo) {
  return function (url, opciones = {}) {
    const u = String(url);

    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      return respuesta({ access_token: 'token-de-prueba', expires_in: 3600 });
    }

    // Las consultas con la cuenta de servicio.
    if (u.endsWith(':runQuery')) {
      const consulta = JSON.parse(opciones.body).structuredQuery;
      const filtro = consulta.where?.fieldFilter;
      const campo = filtro?.field?.fieldPath;
      const campos = (consulta.select?.fields || []).map(f => f.fieldPath);
      mundo.consultas.push(campo);
      if (mundo.consultasFallan) return respuesta({ error: 'sin índice' }, 400);

      let docs = [];
      if (campo === 'estado') {
        const estados = (filtro.value.arrayValue?.values || []).map(v => v.stringValue);
        docs = todosLosPedidos(mundo).filter(d => estados.includes(d.estado));
      } else if (campo === 'codigo') {
        if (mundo.codigoOcupadoVeces > 0) {
          mundo.codigoOcupadoVeces--;
          docs = [{ codigo: filtro.value.stringValue }];
        }
      } else if (campo) {
        const valor = filtro.value.stringValue;
        docs = todosLosPedidos(mundo).filter(d => campoDe(d, campo) === valor);
      }
      // Solo los campos pedidos, como hace la API con `select`.
      const proyectados = docs.map(d => {
        if (!campos.length) return d;
        const salida = {};
        for (const c of campos) if (d[c] !== undefined) salida[c] = d[c];
        return salida;
      });
      // Sin resultados la API no devuelve una lista vacía: devuelve solo readTime.
      return respuesta(proyectados.length
        ? proyectados.map((d, i) => ({ document: { name: `projects/x/databases/(default)/documents/tienda_pedidos/doc${i}`, fields: aCampos(d) } }))
        : [{ readTime: '2026-09-05T00:00:00Z' }]);
    }

    if (opciones.method === 'DELETE') {
      const id = u.split('/').pop();
      mundo.borrados.push(id);
      mundo.guardados = mundo.guardados.filter(g => g.id !== id);
      return respuesta({});
    }

    if (u.includes('/tienda_config/settings')) {
      return respuesta({ fields: aCampos(mundo.config) });
    }

    const producto = u.match(/\/tienda_productos\/([^/?]+)/);
    if (producto) {
      const dato = mundo.productos[decodeURIComponent(producto[1])];
      if (!dato) return respuesta({}, 404);
      return respuesta({ fields: aCampos(dato) });
    }

    // Los cupones solo se leen con token: sin él, la regla los deja afuera.
    const cupon = u.match(/\/tienda_cupones\/([^/?]+)/);
    if (cupon) {
      if (!opciones.headers?.Authorization) return respuesta({ error: 'PERMISSION_DENIED' }, 403);
      const dato = mundo.cupones[decodeURIComponent(cupon[1])];
      if (!dato) return respuesta({}, 404);
      return respuesta({ fields: aCampos(dato) });
    }

    if (u.includes('/tienda_pedidos?documentId=')) {
      const id = new URL(u).searchParams.get('documentId');
      if (mundo.guardados.some(g => g.id === id)) return respuesta({}, 409);
      mundo.guardados.push({ id, cuerpo: JSON.parse(opciones.body) });
      return respuesta({ name: `.../${id}` });
    }

    // La lectura pública de un pedido por id, que es lo que hace un reintento.
    const pedidoPorId = u.match(/\/tienda_pedidos\/([^/?]+)$/);
    if (pedidoPorId && !opciones.method) {
      const g = mundo.guardados.find(x => x.id === pedidoPorId[1]);
      return g ? respuesta({ name: u, fields: g.cuerpo.fields }) : respuesta({}, 404);
    }

    if (u.startsWith('https://routes.googleapis.com')) {
      return respuesta(mundo.metros === null
        ? { routes: [] }
        : { routes: [{ distanceMeters: mundo.metros }] });
    }

    if (u.includes('identitytoolkit')) {
      return respuesta({ users: [{ localId: 'uid-de-la-cuenta' }] });
    }

    throw new Error(`fetch sin mockear: ${u}`);
  };
}

export function respuesta(cuerpo, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => cuerpo,
    text: async () => JSON.stringify(cuerpo),
  });
}

/** De la forma de la API REST a JS. */
export function desplanar(campos) {
  const salida = {};
  for (const [k, v] of Object.entries(campos)) salida[k] = valor(v);
  return salida;
}

function valor(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return desplanar(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(valor);
  return null;
}
