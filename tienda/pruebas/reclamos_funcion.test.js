/**
 * `crear-reclamo`: el cliente cuenta qué pasó con su pedido, con fotos si
 * quiere.
 *
 * Lo que no puede pasar:
 *   · dos reclamos abiertos en el mismo pedido (dos toques, dos pestañas);
 *   · que el resumen del pedido diga una cosa y el reclamo otra: entran juntos;
 *   · que suba cualquier archivo con nombre de foto;
 *   · que cualquiera lea el detalle o las fotos desde el pedido, que es público.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CUENTA, crearGoogle, fetchGoogle, pedir } from './google_falso.js';
import { LIMITES } from '../src/reclamos.js';

let g;

const ID = 'Ab12Cd34Ef56Gh78Ij90';
const RUTA = `tienda_pedidos/${ID}`;
const hace = (dias) => new Date(Date.now() - dias * 86400000).toISOString();

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(200, 3)]);
const foto = (bytes, tipo) => ({ tipo, datos: bytes.toString('base64') });

const pedido = (extra = {}) => ({
  codigo: 'K7M2', estado: 'entregado', creado: hace(3), entregado_en: hace(2),
  cliente: { nombre: 'Marta Gómez', telefono: '3515550001', telefono_clave: '3515550001' },
  entrega: { modo: 'delivery', direccion: 'Colón 100' }, pago: { modo: 'efectivo' },
  items: [
    { id: 'p1', nombre: 'Resma A4', cantidad: 2, precio: 9000, subtotal: 18000 },
    { id: 'p2', nombre: 'Cartulina', variedad: 'Rojo', cantidad: 5, precio: 600, subtotal: 3000 },
    { id: 'p2', nombre: 'Cartulina', variedad: 'Azul', cantidad: 5, precio: 600, subtotal: 3000 },
  ],
  total: 24000,
  ...extra,
});

const reclamo = (extra = {}) => ({
  pedido: ID, motivo: 'roto', renglones: [2],
  detalle: '  Dos cartulinas azules llegaron dobladas por la mitad.  ',
  fotos: [foto(JPEG, 'image/jpeg'), foto(PNG, 'image/png')],
  ...extra,
});

async function crear(cuerpo = reclamo(), opciones) {
  vi.resetModules();
  const funcion = (await import('../netlify/functions/crear-reclamo.mjs')).default;
  return funcion(pedir('crear-reclamo', cuerpo, opciones));
}

beforeEach(() => {
  g = crearGoogle();
  g.docs[RUTA] = pedido();
  process.env.FIREBASE_SERVICE_ACCOUNT = CUENTA;
  vi.stubGlobal('fetch', vi.fn(fetchGoogle(g)));
});

describe('crear-reclamo: lo que queda escrito', () => {
  it('crea el reclamo con sus fotos y deja el resumen en el pedido', async () => {
    const res = await crear();
    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.reclamo).toMatchObject({ id: `${ID}-1`, estado: 'nuevo', motivo: 'roto' });

    const doc = g.docs[`tienda_reclamos/${ID}-1`];
    expect(doc).toMatchObject({
      id: `${ID}-1`, pedido_id: ID, pedido_codigo: 'K7M2', motivo: 'roto', estado: 'nuevo',
      detalle: 'Dos cartulinas azules llegaron dobladas por la mitad.', respuesta: null, visto: false,
    });
    expect(doc.fotos).toHaveLength(2);
    expect(g.subidas.map(s => s.tipo)).toEqual(['image/jpeg', 'image/png']);
    g.subidas.forEach((s, i) => {
      expect(s.nombre).toMatch(new RegExp(`^reclamos/${ID}-1/${i + 1}-[a-f0-9]{8}\\.(jpg|png)$`));
      expect(doc.fotos[i].url).toContain(encodeURIComponent(s.nombre));
      expect(doc.fotos[i].url).toContain(`token=${s.llave}`);
    });
    // Sube lo que mandó el cliente, byte por byte.
    expect(Buffer.compare(g.subidas[0].bytes, JPEG)).toBe(0);

    expect(g.docs[RUTA].reclamos_cantidad).toBe(1);
    expect(g.docs[RUTA].reclamo).toMatchObject({ id: `${ID}-1`, estado: 'nuevo', motivo: 'roto', respuesta: null });
    // El pedido sigue como estaba.
    expect(g.docs[RUTA].estado).toBe('entregado');
    expect(g.docs[RUTA].total).toBe(24000);
  });

  it('el reclamo y el resumen del pedido entran en la misma escritura', async () => {
    await crear();
    const rutas = g.escrituras.map(e => e.ruta);
    expect(rutas).toEqual([`tienda_reclamos/${ID}-1`, RUTA]);
    expect(g.escrituras[0].precondicion).toEqual({ exists: false });
  });

  it('en el pedido, que es público, no queda ni el detalle ni las fotos', async () => {
    await crear();
    const resumen = g.docs[RUTA].reclamo;
    expect(Object.keys(resumen).sort()).toEqual(['actualizado', 'creado', 'estado', 'id', 'motivo', 'respuesta']);
    expect(JSON.stringify(g.docs[RUTA])).not.toContain('dobladas');
    expect(JSON.stringify(g.docs[RUTA])).not.toContain('firebasestorage');
  });

  it('copia los renglones elegidos con su color y al cliente: el local no tiene que ir a buscar el pedido', async () => {
    await crear();
    const doc = g.docs[`tienda_reclamos/${ID}-1`];
    expect(doc.productos).toEqual([{ renglon: 2, id: 'p2', nombre: 'Cartulina', variedad: 'Azul', cantidad: 5 }]);
    expect(doc.cliente).toEqual({ nombre: 'Marta Gómez', telefono: '3515550001' });
    expect(doc.entrega_modo).toBe('delivery');
  });

  it('sin fotos entra igual', async () => {
    const res = await crear(reclamo({ fotos: [] }));
    expect(res.status).toBe(200);
    expect(g.subidas).toHaveLength(0);
    expect(g.docs[`tienda_reclamos/${ID}-1`].fotos).toEqual([]);
  });

  it('WebP también es una foto', async () => {
    const res = await crear(reclamo({ fotos: [foto(WEBP, 'image/webp')] }));
    expect(res.status).toBe(200);
    expect(g.subidas[0].nombre).toMatch(/\.webp$/);
  });

  it('las fotos piden su propio permiso, no el de la base', async () => {
    await crear();
    expect(g.scopes).toContain('https://www.googleapis.com/auth/devstorage.read_write');
  });

  it('un segundo reclamo, con el primero ya resuelto, lleva el número siguiente', async () => {
    Object.assign(g.docs[RUTA], { reclamos_cantidad: 1, reclamo: { id: `${ID}-1`, estado: 'resuelto' } });
    g.docs[`tienda_reclamos/${ID}-1`] = { estado: 'resuelto' };
    const res = await crear(reclamo({ fotos: [] }));
    expect(res.status).toBe(200);
    expect(g.docs[`tienda_reclamos/${ID}-2`]).toBeDefined();
    expect(g.docs[RUTA].reclamo.id).toBe(`${ID}-2`);
    expect(g.docs[RUTA].reclamos_cantidad).toBe(2);
  });
});

describe('crear-reclamo: cuándo no', () => {
  it('con un reclamo abierto no se abre otro', async () => {
    Object.assign(g.docs[RUTA], { reclamos_cantidad: 1, reclamo: { id: `${ID}-1`, estado: 'revisando' } });
    const res = await crear();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('abierto');
    expect(g.subidas).toHaveLength(0);
  });

  it('un pedido recién entrado o fuera de plazo, no', async () => {
    g.docs[RUTA].estado = 'nuevo';
    expect((await (await crear()).json()).error).toBe('estado');
    Object.assign(g.docs[RUTA], { estado: 'entregado', entregado_en: hace(LIMITES.diasParaReclamar + 2) });
    expect((await (await crear()).json()).error).toBe('plazo');
    expect(g.escrituras).toHaveLength(0);
  });

  it(`pasados ${LIMITES.reclamosPorPedido} reclamos en el mismo pedido, no`, async () => {
    Object.assign(g.docs[RUTA], {
      reclamos_cantidad: LIMITES.reclamosPorPedido, reclamo: { id: `${ID}-3`, estado: 'resuelto' },
    });
    const res = await crear();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('limite');
  });

  it('lo incompleto vuelve con el campo y el mensaje para mostrar, y no sube nada', async () => {
    const res = await crear(reclamo({ renglones: [] }));
    expect(res.status).toBe(400);
    const cuerpo = await res.json();
    expect(cuerpo).toMatchObject({ error: 'invalido', campo: 'renglones' });
    expect(cuerpo.mensaje).toMatch(/producto/);
    expect(g.subidas).toHaveLength(0);
  });

  it('un archivo que dice ser foto y no lo es, no entra', async () => {
    const res = await crear(reclamo({ fotos: [foto(Buffer.from('<script>alert(1)</script>'), 'image/jpeg')] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('foto');
    expect(g.subidas).toHaveLength(0);
  });

  it('un tipo que no es foto, tampoco', async () => {
    const res = await crear(reclamo({ fotos: [foto(JPEG, 'application/pdf')] }));
    expect((await res.json()).error).toBe('foto');
  });

  it('una foto demasiado pesada, tampoco', async () => {
    const grande = Buffer.concat([JPEG, Buffer.alloc(LIMITES.bytesFoto)]);
    const res = await crear(reclamo({ fotos: [foto(grande, 'image/jpeg')] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('foto');
  });

  it(`más de ${LIMITES.fotos} fotos, no`, async () => {
    const fotos = Array.from({ length: LIMITES.fotos + 1 }, () => foto(JPEG, 'image/jpeg'));
    const res = await crear(reclamo({ fotos }));
    expect((await res.json())).toMatchObject({ error: 'invalido', campo: 'fotos' });
  });

  it('dos envíos a la vez: entra uno solo', async () => {
    vi.resetModules();
    const funcion = (await import('../netlify/functions/crear-reclamo.mjs')).default;
    const [a, b] = await Promise.all([
      funcion(pedir('crear-reclamo', reclamo({ fotos: [] }))),
      funcion(pedir('crear-reclamo', reclamo({ fotos: [], motivo: 'falta', detalle: 'Faltó una resma entera.' }))),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const perdedor = a.status === 409 ? a : b;
    expect((await perdedor.json()).error).toBe('abierto');
    expect(g.docs[RUTA].reclamos_cantidad).toBe(1);
    expect(g.docs[RUTA].reclamo.motivo).toBe(g.docs[`tienda_reclamos/${ID}-1`].motivo);
  });

  it('si Storage no contesta, no queda un reclamo a medias', async () => {
    g.storageCaido = true;
    const res = await crear();
    expect(res.status).toBe(502);
    expect(g.docs[`tienda_reclamos/${ID}-1`]).toBeUndefined();
    expect(g.docs[RUTA].reclamo).toBeUndefined();
  });

  it('si la base no contesta, avisa que falló', async () => {
    g.firestoreCaido = true;
    expect((await crear()).status).toBe(502);
  });
});

describe('crear-reclamo: la puerta', () => {
  it('sin cuenta de servicio contesta 501', async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    expect((await crear()).status).toBe(501);
  });

  it('un pedido que no existe, 404', async () => {
    expect((await crear(reclamo({ pedido: 'Zz99Zz99Zz99Zz99Zz99' }))).status).toBe(404);
  });

  it('rechaza lo que no tiene forma', async () => {
    expect((await crear(reclamo({ pedido: '../tienda_config' }))).status).toBe(400);
    expect((await crear('no es json')).status).toBe(400);
    expect((await crear(null, { metodo: 'GET' })).status).toBe(405);
  });
});
