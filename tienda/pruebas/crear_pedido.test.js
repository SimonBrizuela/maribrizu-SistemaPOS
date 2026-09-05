/**
 * El pedido se guarda con los precios de la base, no con los del navegador.
 *
 * El agujero que esto cierra: antes el pedido lo escribía el cliente directo en
 * Firestore y las reglas validaban la forma —que hubiera nombre, que el total
 * cerrara contra subtotal más envío— pero ningún precio. Abrir la consola,
 * cambiar `precio: 18000` por `precio: 1` y confirmar entraba un pedido
 * perfecto que el local descubría al ir a cobrarlo.
 *
 * Las reglas no lo pueden arreglar: comparar cien renglones contra el catálogo
 * necesitaría cien `get()` y el tope son diez.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { aCampos } from '../netlify/functions/lib/firestore.mjs';

/* ── Una cuenta de servicio de mentira, pero con una clave RSA de verdad ──── */

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const CUENTA = JSON.stringify({
  client_email: 'tienda@mari-d7c71.iam.gserviceaccount.com',
  private_key: privateKey,
});

/* ── El estado que ve la función ──────────────────────────────────────────── */

const base = () => ({
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
  metros: 2500,
  guardados: [],
  // Pedidos abiertos que ya estaban en la base antes de este, con su estado.
  abiertos: [],
  borrados: [],
  // Qué consultas hizo la función (`estado`, `codigo`), en orden.
  consultas: [],
  // Cuántas veces el código que se pregunta va a estar ocupado.
  codigoOcupadoVeces: 0,
  consultasFallan: false,
});

let mundo = base();

/** Firestore REST y las demás APIs, contestadas de memoria. */
function fetchFalso(url, opciones = {}) {
  const u = String(url);

  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    return respuesta({ access_token: 'token-de-prueba', expires_in: 3600 });
  }

  // Las consultas con la cuenta de servicio: los pedidos abiertos (por estado)
  // y si un código ya existe. Los pedidos guardados en esta prueba cuentan
  // como abiertos, que es lo que pasa en la base de verdad.
  if (u.endsWith(':runQuery')) {
    const consulta = JSON.parse(opciones.body).structuredQuery;
    const filtro = consulta.where?.fieldFilter;
    const campo = filtro?.field?.fieldPath;
    mundo.consultas.push(campo);
    if (mundo.consultasFallan) return respuesta({ error: 'sin índice' }, 400);

    let docs = [];
    if (campo === 'estado') {
      const estados = (filtro.value.arrayValue?.values || []).map(v => v.stringValue);
      docs = [...mundo.abiertos, ...mundo.guardados.map(g => ({ id: g.id, ...desplanar(g.cuerpo.fields) }))]
        .filter(d => estados.includes(d.estado))
        .map(d => ({ items: d.items }));
    } else if (campo === 'codigo' && mundo.codigoOcupadoVeces > 0) {
      mundo.codigoOcupadoVeces--;
      docs = [{ codigo: filtro.value.stringValue }];
    }
    // Sin resultados la API no devuelve una lista vacía: devuelve solo readTime.
    return respuesta(docs.length
      ? docs.map((d, i) => ({ document: { name: `projects/x/databases/(default)/documents/tienda_pedidos/abierto${i}`, fields: aCampos(d) } }))
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
}

function respuesta(cuerpo, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => cuerpo,
    text: async () => JSON.stringify(cuerpo),
  });
}

/** La función, recién importada: así las cachés de config y token nacen limpias. */
async function cargar() {
  vi.resetModules();
  const mod = await import('../netlify/functions/crear-pedido.mjs');
  return mod.default;
}

function pedir(cuerpo) {
  return new Request('https://beta.liceolibreria.com/.netlify/functions/crear-pedido', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
}

const CLIENTE = { nombre: 'Marta Gómez', telefono: '3515550001' };

/** Un pedido de retiro con lo que se le pase. */
const retiro = (items, extra = {}) => ({
  cliente: CLIENTE,
  entrega: { modo: 'retiro' },
  pago: { modo: 'efectivo' },
  items,
  nota: '',
  ...extra,
});

/** Lo que quedó guardado, ya desenvuelto de la forma de la API REST. */
function guardado(i = 0) {
  const campos = mundo.guardados[i].cuerpo.fields;
  return desplanar(campos);
}

function desplanar(campos) {
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

beforeEach(() => {
  mundo = base();
  process.env.FIREBASE_SERVICE_ACCOUNT = CUENTA;
  process.env.GOOGLE_ROUTES_KEY = 'clave-de-prueba';
  vi.stubGlobal('fetch', vi.fn(fetchFalso));
});

/* ── Lo que motiva todo esto ──────────────────────────────────────────────── */

describe('el precio lo pone la base', () => {
  it('un precio cambiado en el navegador no se cobra: se avisa', async () => {
    const crear = await cargar();
    const res = await crear(pedir(retiro([
      { id: 'resma', cantidad: 1, precio: 1 },   // vale 18.000
    ])));

    expect(res.status).toBe(409);
    const datos = await res.json();
    expect(datos.error).toBe('cambios');
    expect(datos.cambios).toContainEqual(
      expect.objectContaining({ tipo: 'precio', antes: 1, ahora: 18000 }));
    expect(mundo.guardados).toHaveLength(0);
  });

  it('sin mandar precio, el pedido entra con el de la base', async () => {
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }])));

    expect(res.status).toBe(200);
    const doc = guardado();
    expect(doc.items[0].precio).toBe(18000);
    expect(doc.subtotal).toBe(18000);
    expect(doc.total).toBe(18000);
  });

  it('el precio propio de una variedad le gana al del producto', async () => {
    const crear = await cargar();
    await crear(pedir(retiro([
      { id: 'cartulina', variedad: 'Celeste', cantidad: 2, precio: 950 },
      { id: 'cartulina', variedad: 'Rojo', cantidad: 10, precio: 800 },
    ])));

    const doc = guardado();
    expect(doc.items.map(i => i.precio)).toEqual([950, 800]);
    expect(doc.subtotal).toBe(950 * 2 + 800 * 10);
  });

  it('el total sale de los renglones, no del que manda el pedido', async () => {
    const crear = await cargar();
    await crear(pedir({
      ...retiro([{ id: 'resma', cantidad: 1 }]),
      subtotal: 1, envio: 0, total: 1,   // se ignoran
    }));

    expect(guardado().total).toBe(18000);
  });
});

describe('el stock y el mínimo de venta', () => {
  it('no deja pedir más de lo que hay', async () => {
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 40 }])));

    expect(res.status).toBe(409);
    expect((await res.json()).cambios).toContainEqual(
      expect.objectContaining({ tipo: 'menos_stock', antes: 40, ahora: 4 }));
  });

  it('la variedad manda sobre el stock del producto', async () => {
    // Hay 100 cartulinas y 2 celestes: prometer 10 celestes termina en una
    // llamada incómoda.
    const crear = await cargar();
    const res = await crear(pedir(retiro([
      { id: 'cartulina', variedad: 'Celeste', cantidad: 10 },
    ])));

    expect(res.status).toBe(409);
    expect((await res.json()).cambios).toContainEqual(
      expect.objectContaining({ tipo: 'menos_stock', ahora: 2 }));
  });

  it('un producto que ya no está se da de baja', async () => {
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'fantasma', cantidad: 1 }])));

    expect(res.status).toBe(409);
    expect((await res.json()).cambios).toContainEqual(
      expect.objectContaining({ tipo: 'baja' }));
  });

  it('una variedad que se dejó de publicar también', async () => {
    const crear = await cargar();
    const res = await crear(pedir(retiro([
      { id: 'cartulina', variedad: 'Fucsia', cantidad: 1 },
    ])));

    expect(res.status).toBe(409);
    expect((await res.json()).cambios[0].tipo).toBe('baja');
  });

  it('respeta el mínimo de venta que fijó el panel', async () => {
    mundo.productos.resma.minimo = 2;
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }])));

    expect(res.status).toBe(409);
    expect((await res.json()).cambios).toContainEqual(
      expect.objectContaining({ tipo: 'minimo', antes: 1, ahora: 2 }));
  });
});

describe('el envío', () => {
  const conEnvio = (extra = {}) => ({
    cliente: CLIENTE,
    entrega: {
      modo: 'delivery',
      direccion: 'Av. Colón 1234',
      coordenadas: { lat: -31.4, lng: -64.19 },
      ...extra,
    },
    pago: { modo: 'transferencia' },
    items: [{ id: 'resma', cantidad: 1 }],
    nota: '',
  });

  it('se mide de nuevo y sale del tramo, no de lo que diga el cliente', async () => {
    mundo.metros = 2500;   // 2,5 km, tramo de $1.500
    const crear = await cargar();
    await crear(pedir(conEnvio()));

    const doc = guardado();
    expect(doc.envio).toBe(1500);
    expect(doc.entrega.distancia_km).toBe(2.5);
    expect(doc.total).toBe(18000 + 1500);
  });

  it('una dirección lejos del radio no entra', async () => {
    mundo.metros = 30000;   // 30 km, con radio de 12
    const crear = await cargar();
    const res = await crear(pedir(conEnvio()));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('fuera_de_radio');
  });

  it('sin ruta el pedido entra igual, con el envío a confirmar', async () => {
    mundo.metros = null;
    const crear = await cargar();
    const res = await crear(pedir(conEnvio()));

    expect(res.status).toBe(200);
    const doc = guardado();
    expect(doc.envio).toBe(0);
    expect(doc.entrega.envio_a_confirmar).toBe(true);
  });

  it('con envío gratis configurado no se cobra ni se mide', async () => {
    mundo.config.entrega.envio_gratis_desde = 10000;
    const crear = await cargar();
    await crear(pedir(conEnvio()));

    expect(guardado().envio).toBe(0);
    expect(fetch.mock.calls.some(c => String(c[0]).includes('routes.googleapis')))
      .toBe(false);
  });
});

describe('lo que el panel puede apagar', () => {
  it('con la tienda cerrada no se toma el pedido', async () => {
    mundo.config.abierta = false;
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }])));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('cerrada');
  });

  // El efectivo se prende y se apaga desde el panel. Sin este control, quien
  // dejó el checkout abierto desde ayer confirma pagando de una forma que el
  // local ya no acepta.
  it('sin efectivo habilitado, un pedido en efectivo se rechaza', async () => {
    mundo.config.pago.efectivo_habilitado = false;
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }])));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('sin_efectivo');
  });

  it('el pedido mínimo se controla acá también, no solo en la pantalla', async () => {
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'cartulina', cantidad: 1 }])));

    expect(res.status).toBe(409);
    const datos = await res.json();
    expect(datos.error).toBe('minimo');
    expect(datos.falta).toBe(6500 - 800);
  });
});

describe('la forma del pedido', () => {
  it('sin cuenta de servicio contesta 501 y la tienda sigue como antes', async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }])));

    expect(res.status).toBe(501);
    expect((await res.json()).error).toBe('sin_credenciales');
  });

  it('un pedido sin nombre ni teléfono no llega a la base', async () => {
    const crear = await cargar();
    const res = await crear(pedir({
      cliente: { nombre: 'M', telefono: '1' },
      entrega: { modo: 'retiro' },
      items: [{ id: 'resma', cantidad: 1 }],
    }));

    expect(res.status).toBe(400);
    expect(mundo.guardados).toHaveLength(0);
  });

  it('el estado y los flags operativos nacen como tienen que nacer', async () => {
    const crear = await cargar();
    await crear(pedir({
      ...retiro([{ id: 'resma', cantidad: 1 }]),
      estado: 'entregado', impreso: true, visto: true,   // se ignoran
    }));

    const doc = guardado();
    expect(doc.estado).toBe('nuevo');
    expect(doc.impreso).toBe(false);
    expect(doc.visto).toBe(false);
    expect(doc.codigo).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
  });

  it('el mismo id dos veces no pisa el pedido que el local está preparando', async () => {
    const crear = await cargar();
    const id = 'aaaaaaaaaaaaaaaaaaaa';
    const primero = await crear(pedir({ ...retiro([{ id: 'resma', cantidad: 1 }]), id }));
    const segundo = await crear(pedir({ ...retiro([{ id: 'resma', cantidad: 1 }]), id }));

    expect(primero.status).toBe(200);
    expect(segundo.status).toBe(409);
    expect((await segundo.json()).error).toBe('ya_existe');
    expect(mundo.guardados).toHaveLength(1);
  });

  it('el uid sale del token verificado, no del que manda el cliente', async () => {
    const crear = await cargar();
    await crear(pedir({
      ...retiro([{ id: 'resma', cantidad: 1 }]),
      uid: 'uid-de-otro',
      idToken: 'token-cualquiera',
    }));

    expect(guardado().uid).toBe('uid-de-la-cuenta');
  });

  it('sin token el pedido entra sin firmar', async () => {
    const crear = await cargar();
    await crear(pedir({ ...retiro([{ id: 'resma', cantidad: 1 }]), uid: 'uid-de-otro' }));

    expect(guardado().uid).toBeUndefined();
  });
});

/* ── Lo que ya está prometido en otros pedidos ────────────────────────────── */

describe('lo que ya está prometido en otros pedidos', () => {
  it('un pedido abierto descuenta del stock que ve el siguiente', async () => {
    // Hay 4 resmas y un pedido nuevo se llevó 3: para el próximo queda una.
    const crear = await cargar();
    await crear(pedir(retiro([{ id: 'resma', cantidad: 3 }])));
    const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 2 }])));

    expect(res.status).toBe(409);
    expect((await res.json()).cambios).toContainEqual(
      expect.objectContaining({ tipo: 'menos_stock', antes: 2, ahora: 1, id: 'resma', es_pack: false }));
    expect(mundo.guardados).toHaveLength(1);
  });

  it('la última unidad no se vende dos veces, ni con minutos de diferencia', async () => {
    const crear = await cargar();
    mundo.productos.resma.stock = 1;
    const primero = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }])));
    const segundo = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }])));

    expect(primero.status).toBe(200);
    expect(segundo.status).toBe(409);
    expect((await segundo.json()).cambios[0]).toMatchObject({ tipo: 'sin_stock', id: 'resma' });
    expect(mundo.guardados).toHaveLength(1);
  });

  it('dos pedidos en el mismo instante por la última unidad: entra a lo sumo uno', async () => {
    const crear = await cargar();
    mundo.productos.resma.stock = 1;
    const respuestas = await Promise.all([
      crear(pedir(retiro([{ id: 'resma', cantidad: 1 }]))),
      crear(pedir(retiro([{ id: 'resma', cantidad: 1 }]))),
    ]);

    const aceptados = respuestas.filter(r => r.status === 200).length;
    expect(aceptados).toBeLessThanOrEqual(1);
    // El que se retiró no dejó rastro en la base.
    expect(mundo.guardados).toHaveLength(aceptados);
    for (const r of respuestas.filter(r => r.status !== 200)) {
      expect(r.status).toBe(409);
      expect((await r.json()).cambios[0]).toMatchObject({ tipo: 'sin_stock', id: 'resma' });
    }
  });

  it('el reintento del que se llevó la última unidad contesta "ya existe", no "sin stock"', async () => {
    // La respuesta del primer intento se perdió y el cliente repite el mismo
    // POST con el mismo id. Ese primer pedido ya cuenta como prometido: sin
    // mirar el id antes, el reintento vería la resma agotada y el cliente
    // sacaría del carrito algo que ya tiene pedido.
    const crear = await cargar();
    mundo.productos.resma.stock = 1;
    const id = 'bbbbbbbbbbbbbbbbbbbb';
    const primero = await crear(pedir({ ...retiro([{ id: 'resma', cantidad: 1 }]), id }));
    const reintento = await crear(pedir({ ...retiro([{ id: 'resma', cantidad: 1 }]), id }));

    expect(primero.status).toBe(200);
    expect(reintento.status).toBe(409);
    expect((await reintento.json()).error).toBe('ya_existe');
    expect(mundo.guardados).toHaveLength(1);
  });

  it('un pedido entregado o cancelado ya no aparta nada', async () => {
    const crear = await cargar();
    mundo.abiertos.push(
      { id: 'viejo1', estado: 'entregado', items: [{ id: 'resma', cantidad: 4 }] },
      { id: 'viejo2', estado: 'cancelado', items: [{ id: 'resma', cantidad: 4 }] },
    );
    const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 4 }])));
    expect(res.status).toBe(200);
  });

  it('un pack en otro pedido cuenta por su contenido', async () => {
    // 60 m de cinta; en un pedido en preparación van dos rollos de 25.
    const crear = await cargar();
    mundo.abiertos.push({
      id: 'p', estado: 'preparando',
      items: [{ id: 'cinta', cantidad: 2, es_pack: true, pack_contenido: 25 }],
    });
    const res = await crear(pedir(retiro([{ id: 'cinta', cantidad: 20 }])));

    expect(res.status).toBe(409);
    expect((await res.json()).cambios).toContainEqual(
      expect.objectContaining({ tipo: 'menos_stock', antes: 20, ahora: 10 }));
  });

  it('lo prometido de un color no toca a los otros colores', async () => {
    mundo.config.entrega.pedido_minimo = 0;
    const crear = await cargar();
    mundo.abiertos.push({
      id: 'p', estado: 'listo',
      items: [{ id: 'cartulina', variedad: 'Rojo', cantidad: 8 }],
    });
    const rojo = await crear(pedir(retiro([{ id: 'cartulina', variedad: 'Rojo', cantidad: 5 }])));
    const celeste = await crear(pedir(retiro([{ id: 'cartulina', variedad: 'Celeste', cantidad: 2 }])));

    expect(rojo.status).toBe(409);
    expect((await rojo.json()).cambios[0]).toMatchObject({ tipo: 'menos_stock', ahora: 2, variedad: 'Rojo' });
    expect(celeste.status).toBe(200);
  });

  it('si no se pueden leer los pedidos abiertos, el pedido entra igual', async () => {
    mundo.consultasFallan = true;
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }])));
    expect(res.status).toBe(200);
  });
});

/* ── Renglones repetidos ──────────────────────────────────────────────────── */

describe('el mismo producto más de una vez en el pedido', () => {
  it('se junta en un renglón y se controla contra el stock una sola vez', async () => {
    const crear = await cargar();
    const res = await crear(pedir(retiro([
      { id: 'resma', cantidad: 3 },
      { id: 'resma', cantidad: 3 },
    ])));

    expect(res.status).toBe(409);
    expect((await res.json()).cambios).toContainEqual(
      expect.objectContaining({ tipo: 'menos_stock', antes: 6, ahora: 4 }));
  });

  it('dentro del stock entra como un solo renglón con la suma', async () => {
    const crear = await cargar();
    const res = await crear(pedir(retiro([
      { id: 'resma', cantidad: 1 },
      { id: 'resma', cantidad: 2 },
    ])));

    expect(res.status).toBe(200);
    expect(guardado().items).toHaveLength(1);
    expect(guardado().items[0].cantidad).toBe(3);
    expect(guardado().total).toBe(18000 * 3);
  });

  it('el rollo entero y los metros sueltos salen del mismo stock', async () => {
    // 60 m: dos rollos de 25 son 50, y quedan 10 sueltos, no 20.
    const crear = await cargar();
    const res = await crear(pedir(retiro([
      { id: 'cinta', cantidad: 2, es_pack: true },
      { id: 'cinta', cantidad: 20 },
    ])));

    expect(res.status).toBe(409);
    expect((await res.json()).cambios).toContainEqual(
      expect.objectContaining({ tipo: 'menos_stock', antes: 20, ahora: 10, es_pack: false }));
  });

  it('cien renglones del mismo producto son una sola lectura de la base', async () => {
    const crear = await cargar();
    const res = await crear(pedir(retiro(
      Array.from({ length: 100 }, () => ({ id: 'cartulina', cantidad: 1 })))));

    expect(res.status).toBe(409);   // 100 pedidas, hay 100 pero el tope es 99
    const lecturas = vi.mocked(fetch).mock.calls
      .filter(c => String(c[0]).includes('/tienda_productos/'));
    expect(lecturas).toHaveLength(1);
  });
});

/* ── El código corto ──────────────────────────────────────────────────────── */

describe('el código corto', () => {
  it('no se repite: si ya existe se genera otro', async () => {
    mundo.codigoOcupadoVeces = 1;
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }])));

    expect(res.status).toBe(200);
    expect(mundo.consultas.filter(c => c === 'codigo')).toHaveLength(2);
    expect(guardado().codigo).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
  });

  it('si la comprobación falla, el pedido entra igual', async () => {
    mundo.consultasFallan = true;
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }])));
    expect(res.status).toBe(200);
    expect(guardado().codigo).toHaveLength(4);
  });
});

/* ── Cantidades y textos raros ────────────────────────────────────────────── */

describe('cantidades y textos raros', () => {
  it('una cantidad enorme se baja al tope y se avisa, no en silencio', async () => {
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'cartulina', cantidad: 1_000_000 }])));

    expect(res.status).toBe(409);
    expect((await res.json()).cambios).toContainEqual(
      expect.objectContaining({ tipo: 'menos_stock', antes: 1_000_000, ahora: 99 }));
  });

  it('el mínimo que fijó el panel le gana al tope de 99', async () => {
    mundo.productos.cartulina.minimo = 120;
    mundo.productos.cartulina.stock = 500;
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'cartulina', cantidad: 120 }])));

    expect(res.status).toBe(200);
    expect(guardado().items[0].cantidad).toBe(120);
  });

  it('un nombre que no es texto no entra', async () => {
    const crear = await cargar();
    for (const nombre of [{ a: 1 }, 12345678, ['Marta'], true]) {
      const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }],
        { cliente: { nombre, telefono: '3515550001' } })));
      expect(res.status, JSON.stringify(nombre)).toBe(400);
      expect((await res.json()).detalle).toBe('nombre');
    }
    expect(mundo.guardados).toHaveLength(0);
  });

  it('una cantidad que no es un número tampoco', async () => {
    const crear = await cargar();
    for (const cantidad of [[5], { n: 1 }, true, '1e400', 'dos']) {
      const res = await crear(pedir(retiro([{ id: 'resma', cantidad }])));
      expect(res.status, JSON.stringify(cantidad)).toBe(400);
    }
  });

  it('la nota, si viene, es texto', async () => {
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }], { nota: { x: 1 } })));
    expect(res.status).toBe(400);
    expect((await res.json()).detalle).toBe('nota');
  });

  it('la variedad se toma sin espacios alrededor', async () => {
    mundo.config.entrega.pedido_minimo = 0;
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'cartulina', variedad: ' Rojo ', cantidad: 1 }])));
    expect(res.status).toBe(200);
    expect(guardado().items[0].variedad).toBe('Rojo');
  });
});

/* ── El horario ───────────────────────────────────────────────────────────── */

describe('el horario del local', () => {
  const horario = () => Array.from({ length: 7 }, () => ({
    tramos: [{ desde: '09:00', hasta: '13:00' }, { desde: '17:00', hasta: '20:30' }],
  }));

  it('fuera de horario el servidor no toma el pedido, y dice cuándo abre', async () => {
    mundo.config.horarios = horario();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T02:00:00Z'));   // 23:00 en Argentina
    try {
      const crear = await cargar();
      const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }])));

      expect(res.status).toBe(409);
      const datos = await res.json();
      expect(datos.error).toBe('cerrada');
      expect(datos.motivo).toBe('fuera_de_horario');
      expect(datos.abre).toBeTruthy();
      expect(mundo.guardados).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dentro del horario entra', async () => {
    mundo.config.horarios = horario();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T14:00:00Z'));   // 11:00 en Argentina
    try {
      const crear = await cargar();
      const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }])));
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
