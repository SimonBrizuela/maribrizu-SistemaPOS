/**
 * El servidor del repartidor: `reparto-sesion` le abre la sesión con su link y
 * `reparto-mover` cambia el estado de un pedido.
 *
 * Lo que no puede pasar:
 *   · que entre alguien sin el link vigente (o con uno que el local ya anuló);
 *   · que el repartidor mueva un pedido que no es de envío, lo lleve para atrás
 *     o pise un cambio que el local hizo en el medio (lo canceló);
 *   · que "Entregado" registre la venta dos veces: acá solo queda pendiente, la
 *     registra el panel con la cuenta de siempre.
 */
import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CUENTA, crearGoogle, fetchGoogle, pedir } from './google_falso.js';

let g;

const CLAVE = 'k'.repeat(40);
const ID = 'Ab12Cd34Ef56Gh78Ij90';
const RUTA = `tienda_pedidos/${ID}`;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9)]);

const pedido = (extra = {}) => ({
  codigo: 'K7M2', estado: 'listo', creado: '2026-09-15T15:00:00Z', total: 12500, visto: true,
  cliente: { nombre: 'Marta', telefono: '3515550001' },
  entrega: { modo: 'delivery', direccion: 'Colón 1200', coordenadas: { lat: -31.4, lng: -64.2 } },
  pago: { modo: 'efectivo', pagado: false },
  items: [{ id: 'p1', nombre: 'Resma', cantidad: 1, precio: 12500, subtotal: 12500 }],
  ...extra,
});

async function funcion(nombre) {
  vi.resetModules();
  return (await import(`../netlify/functions/${nombre}.mjs`)).default;
}
const mover = async (cuerpo) => (await funcion('reparto-mover'))(pedir('reparto-mover', { clave: CLAVE, pedido: ID, ...cuerpo }));

beforeEach(() => {
  g = crearGoogle();
  g.docs['tienda_reparto/acceso'] = { clave: CLAVE, version: 2, creado: '2026-09-15T10:00:00Z' };
  g.docs['tienda_config/settings'] = { direccion: 'Av. Alfonsina Storni 168' };
  g.docs[RUTA] = pedido();
  process.env.FIREBASE_SERVICE_ACCOUNT = CUENTA;
  vi.stubGlobal('fetch', vi.fn(fetchGoogle(g)));
});

describe('reparto-sesion', () => {
  const sesion = async (cuerpo) => (await funcion('reparto-sesion'))(pedir('reparto-sesion', cuerpo));

  it('con el link vigente devuelve el token para entrar, con el permiso de repartidor', async () => {
    const res = await sesion({ clave: CLAVE });
    expect(res.status).toBe(200);
    const { token } = await res.json();
    const datos = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(datos.uid).toBe('repartidor');
    expect(datos.claims).toEqual({ reparto: true, reparto_version: 2 });
    const publica = crypto.createPublicKey(JSON.parse(CUENTA).private_key);
    const [c, b, f] = token.split('.');
    expect(crypto.createVerify('RSA-SHA256').update(`${c}.${b}`).verify(publica, Buffer.from(f, 'base64url'))).toBe(true);
  });

  it('con otro link, o sin link generado, no', async () => {
    expect((await sesion({ clave: 'x'.repeat(40) })).status).toBe(401);
    delete g.docs['tienda_reparto/acceso'];
    expect((await sesion({ clave: CLAVE })).status).toBe(401);
  });

  it('un link anulado desde el panel deja de servir', async () => {
    g.docs['tienda_reparto/acceso'] = { clave: CLAVE, version: 2, anulado: true };
    expect((await sesion({ clave: CLAVE })).status).toBe(401);
  });

  it('rechaza lo que no tiene forma, y sin cuenta de servicio contesta 501', async () => {
    expect((await sesion({ clave: 'corta' })).status).toBe(400);
    expect((await sesion('no es json')).status).toBe(400);
    expect((await (await funcion('reparto-sesion'))(pedir('reparto-sesion', null, { metodo: 'GET' }))).status).toBe(405);
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    expect((await sesion({ clave: CLAVE })).status).toBe(501);
  });
});

describe('reparto-mover', () => {
  it('pasa el pedido al estado siguiente y le avisa al cliente', async () => {
    g.docs[`tienda_avisos/${ID}`] = { tokens: ['fcm-token-a:APA91bH' + 'x'.repeat(120)], estado_avisado: 'listo', reclamo_avisado: null };
    const res = await mover({ estado: 'en_camino' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, estado: 'en_camino' });
    expect(g.docs[RUTA].estado).toBe('en_camino');
    expect(g.mensajes).toHaveLength(1);
    expect(g.mensajes[0].data.titulo).toMatch(/camino/i);
  });

  it('escribe atado a la versión que leyó: no pisa nada del resto del pedido', async () => {
    await mover({ estado: 'en_camino' });
    const escritura = g.escrituras.find(e => e.ruta === RUTA);
    expect(escritura.precondicion.updateTime).toBeTruthy();
    expect(escritura.mascara).toEqual(['estado']);
    expect(g.docs[RUTA].total).toBe(12500);
  });

  it('entregado: queda la venta pendiente para el panel, el día y quién lo entregó', async () => {
    const res = await mover({ estado: 'entregado', cobrado: true });
    expect(res.status).toBe(200);
    const p = g.docs[RUTA];
    expect(p).toMatchObject({ estado: 'entregado', entregado_por: 'reparto', venta_pendiente: true });
    expect(p.entregado_dia).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.entregado_en).toBeTruthy();
    // Cobró en efectivo: el pago queda hecho, sin tocar cómo se pagaba.
    expect(p.pago).toEqual({ modo: 'efectivo', pagado: true });
    // No se registra la venta acá: eso es del panel.
    expect(p.venta_registrada).toBeUndefined();
    expect(Object.keys(g.docs).some(r => r.startsWith('ventas'))).toBe(false);
  });

  it('entregado sin cobrar: el pago queda como estaba, para que el local lo vea', async () => {
    await mover({ estado: 'entregado', cobrado: false });
    expect(g.docs[RUTA].pago).toEqual({ modo: 'efectivo', pagado: false });
    expect(g.docs[`tienda_entregas/${ID}`]).toMatchObject({ cobrado: false, monto: 12500 });
  });

  it('la foto de la entrega se guarda aparte, en una colección que solo lee el local', async () => {
    const res = await mover({ estado: 'entregado', cobrado: true, foto: { tipo: 'image/jpeg', datos: JPEG.toString('base64') } });
    expect(res.status).toBe(200);
    expect(g.subidas).toHaveLength(1);
    expect(g.subidas[0].nombre).toMatch(new RegExp(`^entregas/${ID}/[a-f0-9]{8}\\.jpg$`));
    const entrega = g.docs[`tienda_entregas/${ID}`];
    expect(entrega).toMatchObject({ pedido_id: ID, pedido_codigo: 'K7M2', cobrado: true, monto: 12500 });
    expect(entrega.foto.url).toContain('firebasestorage.googleapis.com');
    // En el pedido, que abre cualquiera con el enlace, la foto no aparece.
    expect(JSON.stringify(g.docs[RUTA])).not.toContain('firebasestorage');
  });

  it('una foto que no es foto no entra, y el pedido no se mueve', async () => {
    const res = await mover({ estado: 'entregado', foto: { tipo: 'image/jpeg', datos: Buffer.from('<html>').toString('base64') } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('foto');
    expect(g.docs[RUTA].estado).toBe('listo');
  });

  it('un pedido que ya tenía la venta registrada no la deja pendiente de nuevo', async () => {
    g.docs[RUTA] = pedido({ estado: 'en_camino', venta_registrada: true });
    await mover({ estado: 'entregado', cobrado: true });
    expect(g.docs[RUTA].venta_pendiente).toBeUndefined();
  });

  it('no mueve para atrás, ni pedidos de retiro, ni terminados', async () => {
    g.docs[RUTA] = pedido({ estado: 'en_camino' });
    let res = await mover({ estado: 'listo' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('hacia_atras');

    g.docs[RUTA] = pedido({ entrega: { modo: 'retiro' } });
    expect((await (await mover({ estado: 'preparando' })).json()).error).toBe('no_es_envio');

    g.docs[RUTA] = pedido({ estado: 'cancelado' });
    expect((await (await mover({ estado: 'entregado' })).json()).error).toBe('terminado');
    expect(g.docs[RUTA].estado).toBe('cancelado');
  });

  it('si el local lo cambió mientras tanto, no lo pisa', async () => {
    // El local lo cancela justo entre que la función lee y escribe.
    const original = fetchGoogle(g);
    let leido = false;
    vi.stubGlobal('fetch', vi.fn(async (url, opciones = {}) => {
      const r = await original(url, opciones);
      if (!leido && String(url).includes(`/documents/tienda_pedidos/${ID}`) && (!opciones.method || opciones.method === 'GET')) {
        leido = true;
        g.docs[RUTA] = { ...g.docs[RUTA], estado: 'cancelado' };
      }
      return r;
    }));
    const res = await mover({ estado: 'entregado', cobrado: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('cambio');
    expect(g.docs[RUTA].estado).toBe('cancelado');
  });

  it('sin el link vigente no hace nada', async () => {
    const res = await (await funcion('reparto-mover'))(pedir('reparto-mover', { clave: 'z'.repeat(40), pedido: ID, estado: 'en_camino' }));
    expect(res.status).toBe(401);
    expect(g.docs[RUTA].estado).toBe('listo');
  });

  it('si el aviso al celular falla, el pedido igual queda movido', async () => {
    g.docs[`tienda_avisos/${ID}`] = { tokens: ['fcm-token-a:APA91bH' + 'x'.repeat(120)], estado_avisado: 'listo' };
    g.fcmCaido = true;
    const res = await mover({ estado: 'en_camino' });
    expect(res.status).toBe(200);
    expect(g.docs[RUTA].estado).toBe('en_camino');
  });

  it('rechaza lo que no tiene forma', async () => {
    expect((await mover({ pedido: '../x', estado: 'listo' })).status).toBe(400);
    expect((await mover({ estado: 'volando' })).status).toBe(409);
    g.docs = {};
    g.docs['tienda_reparto/acceso'] = { clave: CLAVE, version: 2 };
    expect((await mover({ estado: 'en_camino' })).status).toBe(404);
  });
});
