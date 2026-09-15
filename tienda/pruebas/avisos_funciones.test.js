/**
 * Las notificaciones al celular del cliente, del lado del servidor.
 *
 * `suscribir-avisos` anota un celular para un pedido; `avisar-estado` la llama
 * el panel cada vez que mueve el pedido y manda el aviso del estado nuevo.
 *
 * Lo que no puede pasar:
 *   · avisar dos veces el mismo paso (dos PCs que tocan a la vez, un reintento);
 *   · seguir mandando a un celular que ya no existe (se borra la suscripción);
 *   · que un reclamo del panel se pierda o reemplace al aviso del pedido;
 *   · que cualquiera use el endpoint para mandar lo que quiera: el texto sale
 *     de la base, nunca del que llama.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CUENTA, crearGoogle, fetchGoogle, pedir } from './google_falso.js';

let g;

const ID = 'Ab12Cd34Ef56Gh78Ij90';
const TOKEN_A = 'fcm-token-a:APA91bH' + 'x'.repeat(120);
const TOKEN_B = 'fcm-token-b:APA91bH' + 'y'.repeat(120);

async function funcion(nombre) {
  vi.resetModules();
  return (await import(`../netlify/functions/${nombre}.mjs`)).default;
}

const pedido = (extra = {}) => ({
  codigo: 'K7M2', estado: 'preparando', entrega: { modo: 'retiro' }, pago: { modo: 'efectivo' },
  cliente: { nombre: 'Marta', telefono: '3515550001' }, ...extra,
});

beforeEach(() => {
  g = crearGoogle();
  g.docs['tienda_config/settings'] = { direccion: 'Av. Alfonsina Storni 168' };
  g.docs[`tienda_pedidos/${ID}`] = pedido();
  process.env.FIREBASE_SERVICE_ACCOUNT = CUENTA;
  vi.stubGlobal('fetch', vi.fn(fetchGoogle(g)));
});

describe('suscribir-avisos', () => {
  it('anota el celular para ese pedido, con el estado que ya vio', async () => {
    const res = await (await funcion('suscribir-avisos'))(pedir('suscribir-avisos', { pedido: ID, token: TOKEN_A }));
    expect(res.status).toBe(200);
    const doc = g.docs[`tienda_avisos/${ID}`];
    expect(doc.tokens).toEqual([TOKEN_A]);
    // El paso en el que está no se le vuelve a avisar: lo está viendo en la pantalla.
    expect(doc.estado_avisado).toBe('preparando');
  });

  it('otro celular se suma; el mismo no se repite', async () => {
    const suscribir = await funcion('suscribir-avisos');
    await suscribir(pedir('suscribir-avisos', { pedido: ID, token: TOKEN_A }));
    await suscribir(pedir('suscribir-avisos', { pedido: ID, token: TOKEN_A }));
    await suscribir(pedir('suscribir-avisos', { pedido: ID, token: TOKEN_B }));
    expect(g.docs[`tienda_avisos/${ID}`].tokens).toEqual([TOKEN_A, TOKEN_B]);
  });

  it('no suscribe a un pedido que no existe ni a uno terminado', async () => {
    const suscribir = await funcion('suscribir-avisos');
    expect((await suscribir(pedir('suscribir-avisos', { pedido: 'Zz99Zz99Zz99Zz99Zz99', token: TOKEN_A }))).status).toBe(404);
    g.docs[`tienda_pedidos/${ID}`].estado = 'entregado';
    expect((await suscribir(pedir('suscribir-avisos', { pedido: ID, token: TOKEN_A }))).status).toBe(409);
    expect(g.docs[`tienda_avisos/${ID}`]).toBeUndefined();
  });

  it('rechaza lo que no tiene forma de id ni de token', async () => {
    const suscribir = await funcion('suscribir-avisos');
    expect((await suscribir(pedir('suscribir-avisos', { pedido: '../config', token: TOKEN_A }))).status).toBe(400);
    expect((await suscribir(pedir('suscribir-avisos', { pedido: ID, token: 'x' }))).status).toBe(400);
    expect((await suscribir(pedir('suscribir-avisos', 'no es json'))).status).toBe(400);
    expect((await suscribir(pedir('suscribir-avisos', null, { metodo: 'GET' }))).status).toBe(405);
  });

  it('sin cuenta de servicio contesta 501 y no rompe nada', async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    const res = await (await funcion('suscribir-avisos'))(pedir('suscribir-avisos', { pedido: ID, token: TOKEN_A }));
    expect(res.status).toBe(501);
  });
});

describe('avisar-estado', () => {
  function suscripto(extra = {}) {
    g.docs[`tienda_avisos/${ID}`] = { tokens: [TOKEN_A], estado_avisado: 'preparando', reclamo_avisado: null, ...extra };
  }

  it('manda el aviso del estado nuevo, con lo que dice la base', async () => {
    suscripto();
    g.docs[`tienda_pedidos/${ID}`].estado = 'listo';
    const res = await (await funcion('avisar-estado'))(pedir('avisar-estado', { id: ID }));

    expect(res.status).toBe(200);
    expect(g.mensajes).toHaveLength(1);
    const { data, headers } = g.mensajes[0];
    expect(data.titulo).toContain('K7M2');
    expect(data.cuerpo).toContain('Alfonsina Storni');
    expect(data.tag).toBe(`pedido-${ID}`);
    expect(data.url).toBe(`/pedido/${ID}`);
    expect(data.imagen).toBe('/avisos/retiro-listo.png');
    // Que llegue aunque el celular esté en ahorro de batería.
    expect(headers.Urgency).toBe('high');
    expect(g.docs[`tienda_avisos/${ID}`].estado_avisado).toBe('listo');
    // Solo el permiso de mandar mensajes y el de la base: nada de archivos.
    expect(g.scopes).not.toContain('https://www.googleapis.com/auth/devstorage.read_write');
  });

  it('el mismo paso no se avisa dos veces', async () => {
    suscripto();
    g.docs[`tienda_pedidos/${ID}`].estado = 'listo';
    const avisar = await funcion('avisar-estado');
    await avisar(pedir('avisar-estado', { id: ID }));
    await avisar(pedir('avisar-estado', { id: ID }));
    expect(g.mensajes).toHaveLength(1);
  });

  it('manda a todos los celulares y borra el que ya no existe', async () => {
    suscripto({ tokens: [TOKEN_A, TOKEN_B] });
    g.fcm[TOKEN_B] = 404;
    g.docs[`tienda_pedidos/${ID}`].estado = 'listo';
    await (await funcion('avisar-estado'))(pedir('avisar-estado', { id: ID }));

    expect(g.mensajes.map(m => m.token)).toEqual([TOKEN_A]);
    expect(g.docs[`tienda_avisos/${ID}`].tokens).toEqual([TOKEN_A]);
  });

  it('si Google no contesta, no lo da por avisado: un reintento lo manda', async () => {
    suscripto();
    g.fcmCaido = true;
    g.docs[`tienda_pedidos/${ID}`].estado = 'listo';
    const avisar = await funcion('avisar-estado');
    const res = await avisar(pedir('avisar-estado', { id: ID }));
    expect(res.status).toBe(502);
    expect(g.docs[`tienda_avisos/${ID}`].estado_avisado).toBe('preparando');

    g.fcmCaido = false;
    await avisar(pedir('avisar-estado', { id: ID }));
    expect(g.mensajes).toHaveLength(1);
  });

  it('sin nadie suscripto no hace nada', async () => {
    g.docs[`tienda_pedidos/${ID}`].estado = 'listo';
    const res = await (await funcion('avisar-estado'))(pedir('avisar-estado', { id: ID }));
    expect(res.status).toBe(204);
    expect(g.mensajes).toHaveLength(0);
  });

  it('un reclamo que cambió se avisa aparte, sin tocar el aviso del pedido', async () => {
    suscripto({ estado_avisado: 'entregado' });
    Object.assign(g.docs[`tienda_pedidos/${ID}`], {
      estado: 'entregado',
      reclamo: { estado: 'resuelto', respuesta: 'Te cambiamos la resma el lunes.' },
    });
    await (await funcion('avisar-estado'))(pedir('avisar-estado', { id: ID }));

    expect(g.mensajes).toHaveLength(1);
    expect(g.mensajes[0].data.tag).toBe(`reclamo-${ID}`);
    expect(g.mensajes[0].data.cuerpo).toContain('resma');
    expect(g.docs[`tienda_avisos/${ID}`].reclamo_avisado).toBe('resuelto');
  });

  it('el texto nunca sale del que llama', async () => {
    suscripto();
    g.docs[`tienda_pedidos/${ID}`].estado = 'listo';
    await (await funcion('avisar-estado'))(pedir('avisar-estado', { id: ID, titulo: 'Ganaste un premio', cuerpo: 'entrá a x.com' }));
    expect(JSON.stringify(g.mensajes)).not.toContain('premio');
  });

  it('el panel lo puede llamar desde su dominio y no desde cualquiera', async () => {
    const avisar = await funcion('avisar-estado');
    const permitido = await avisar(pedir('avisar-estado', null, { metodo: 'OPTIONS', origen: 'https://admin.liceolibreria.com' }));
    expect(permitido.status).toBe(204);
    expect(permitido.headers.get('Access-Control-Allow-Origin')).toBe('https://admin.liceolibreria.com');

    const ajeno = await avisar(pedir('avisar-estado', null, { metodo: 'OPTIONS', origen: 'https://otro.com' }));
    expect(ajeno.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('un pedido que no existe contesta 404', async () => {
    const res = await (await funcion('avisar-estado'))(pedir('avisar-estado', { id: 'Zz99Zz99Zz99Zz99Zz99' }));
    expect(res.status).toBe(404);
  });
});
