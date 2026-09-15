/**
 * Lo que la pantalla del repartidor le pide a la función `reparto-mover`, y
 * cómo traduce cada respuesta a lo que la pantalla sabe explicar.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mover, ESPERA_MAXIMA_MS } from '../src/reparto/servicios.js';

const respuesta = (status, cuerpo = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => cuerpo });

afterEach(() => { vi.unstubAllGlobals(); });

describe('mover', () => {
  it('manda la clave, el pedido, el estado, el cobro y la foto', async () => {
    const fetch = vi.fn(async () => respuesta(200, { ok: true }));
    vi.stubGlobal('fetch', fetch);
    const r = await mover('clave', 'pedido1', 'entregado', { cobrado: true, foto: { tipo: 'image/jpeg', datos: 'b64' } });
    expect(r).toEqual({ ok: true });
    const [url, opciones] = fetch.mock.calls[0];
    expect(url).toBe('/.netlify/functions/reparto-mover');
    expect(JSON.parse(opciones.body)).toEqual({
      clave: 'clave', pedido: 'pedido1', estado: 'entregado', cobrado: true, foto: { tipo: 'image/jpeg', datos: 'b64' },
    });
  });

  it('no espera para siempre: el pedido lleva un tiempo máximo', async () => {
    const fetch = vi.fn(async () => respuesta(200));
    vi.stubGlobal('fetch', fetch);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await mover('clave', 'pedido1', 'en_camino');
    expect(timeout).toHaveBeenCalledWith(ESPERA_MAXIMA_MS);
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    timeout.mockRestore();
  });

  it('pasado el tiempo, o sin conexión, es un error de red', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('se venció', 'TimeoutError'); }));
    expect(await mover('clave', 'pedido1', 'en_camino')).toEqual({ ok: false, error: 'red' });
  });

  it('link vencido y los motivos de la función', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respuesta(401, { error: 'link' })));
    expect(await mover('clave', 'pedido1', 'en_camino')).toEqual({ ok: false, error: 'link' });

    vi.stubGlobal('fetch', vi.fn(async () => respuesta(409, { error: 'cambio' })));
    expect(await mover('clave', 'pedido1', 'en_camino')).toEqual({ ok: false, error: 'cambio' });

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('no es json'); } })));
    expect(await mover('clave', 'pedido1', 'en_camino')).toEqual({ ok: false, error: 'red' });
  });
});
