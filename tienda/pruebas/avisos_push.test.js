/**
 * Activar los avisos en el celular del cliente.
 *
 * Lo delicado no es el camino feliz sino lo que lo rodea:
 *   · en iPhone solo andan si la tienda se agregó a la pantalla de inicio, y
 *     ahí hay que explicarlo en vez de ofrecer un botón que no hace nada;
 *   · el permiso se pide UNA vez y solo cuando el cliente toca el botón (si lo
 *     rechaza, el navegador no deja volver a preguntar);
 *   · si ya lo había dado en otro pedido, se activa solo, sin preguntar;
 *   · si la función no está disponible, la pantalla sigue igual.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { soporteDeAvisos, activarAvisos, avisosActivos, olvidarAvisos } from '../src/avisos_push.js';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1';

function entorno({ ua = ANDROID, permiso = 'default', push = true, instalada = false, respuesta = 200, darPermiso = 'granted' } = {}) {
  const registros = [];
  const pedidos = [];
  const Notification = { permission: permiso, requestPermission: vi.fn(async () => { Notification.permission = darPermiso; return darPermiso; }) };
  return {
    registros, pedidos, Notification,
    navegador: {
      userAgent: ua, maxTouchPoints: 5,
      ...(push ? { serviceWorker: { register: vi.fn(async (url, op) => { registros.push({ url, op }); return { scope: '/' }; }) } } : {}),
    },
    ventana: {
      ...(push ? { PushManager: function () {}, Notification } : {}),
      matchMedia: () => ({ matches: instalada }),
    },
    obtenerToken: vi.fn(async () => 'token-del-celular:' + 'x'.repeat(140)),
    fetch: vi.fn(async (url, opciones) => {
      pedidos.push({ url, cuerpo: JSON.parse(opciones.body) });
      return { ok: respuesta === 200, status: respuesta, json: async () => ({}) };
    }),
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('soporteDeAvisos', () => {
  it('Android con Chrome: sí', () => {
    const e = entorno();
    expect(soporteDeAvisos(e)).toBe('ok');
  });

  it('iPhone sin la tienda en la pantalla de inicio: hay que explicarlo', () => {
    const e = entorno({ ua: IPHONE, push: false });
    expect(soporteDeAvisos(e)).toBe('iphone_sin_instalar');
  });

  it('iPhone con la tienda instalada: sí', () => {
    const e = entorno({ ua: IPHONE, instalada: true });
    expect(soporteDeAvisos(e)).toBe('ok');
  });

  it('un navegador que no sabe de avisos: no se ofrece nada', () => {
    expect(soporteDeAvisos(entorno({ push: false }))).toBe('sin_soporte');
  });

  it('con el permiso bloqueado no se insiste', () => {
    expect(soporteDeAvisos(entorno({ permiso: 'denied' }))).toBe('bloqueado');
  });
});

describe('activarAvisos', () => {
  it('pide permiso, registra el service worker y anota el celular para ese pedido', async () => {
    const e = entorno();
    const resultado = await activarAvisos('pedido123abcdefghij', e);

    expect(resultado).toBe('activos');
    expect(e.Notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(e.registros[0].url).toBe('/avisos-sw.js');
    expect(e.pedidos[0].url).toBe('/.netlify/functions/suscribir-avisos');
    expect(e.pedidos[0].cuerpo).toEqual({ pedido: 'pedido123abcdefghij', token: expect.stringMatching(/^token-del-celular/) });
    expect(avisosActivos('pedido123abcdefghij')).toBe(true);
  });

  it('si lo rechaza, no se anota nada', async () => {
    const e = entorno({ darPermiso: 'denied' });
    expect(await activarAvisos('pedido123abcdefghij', e)).toBe('rechazado');
    expect(e.pedidos).toHaveLength(0);
    expect(avisosActivos('pedido123abcdefghij')).toBe(false);
  });

  it('sin permiso dado y sin poder preguntar (activación sola) no pregunta', async () => {
    const e = entorno();
    expect(await activarAvisos('pedido123abcdefghij', { ...e, preguntar: false })).toBe('rechazado');
    expect(e.Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('con el permiso ya dado se activa sin preguntar', async () => {
    const e = entorno({ permiso: 'granted' });
    expect(await activarAvisos('pedido123abcdefghij', { ...e, preguntar: false })).toBe('activos');
    expect(e.Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('con la función apagada lo dice como no disponible, sin romper', async () => {
    const e = entorno({ respuesta: 501 });
    expect(await activarAvisos('pedido123abcdefghij', e)).toBe('no_disponible');
    expect(avisosActivos('pedido123abcdefghij')).toBe(false);
  });

  it('si algo del medio falla, devuelve error y la pantalla sigue', async () => {
    const e = entorno();
    e.obtenerToken.mockRejectedValue(new Error('messaging/token-subscribe-failed'));
    expect(await activarAvisos('pedido123abcdefghij', e)).toBe('error');
  });

  it('en un navegador sin soporte ni lo intenta', async () => {
    const e = entorno({ push: false });
    expect(await activarAvisos('pedido123abcdefghij', e)).toBe('sin_soporte');
    expect(e.pedidos).toHaveLength(0);
  });

  it('recuerda cada pedido por separado y se puede olvidar', async () => {
    const e = entorno({ permiso: 'granted' });
    await activarAvisos('pedidoAAAAAAAAAAAAAAA', e);
    expect(avisosActivos('pedidoAAAAAAAAAAAAAAA')).toBe(true);
    expect(avisosActivos('pedidoBBBBBBBBBBBBBBB')).toBe(false);
    olvidarAvisos('pedidoAAAAAAAAAAAAAAA');
    expect(avisosActivos('pedidoAAAAAAAAAAAAAAA')).toBe(false);
  });
});
