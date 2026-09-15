/**
 * A qué tienda le pide el panel que avise al cliente.
 *
 * El panel y la tienda son dos sitios. En producción el panel le habla a la
 * tienda publicada; en local, a la tienda local: probar el panel en la
 * computadora no puede mandarle notificaciones a clientes de verdad.
 */
import { describe, it, expect, vi } from 'vitest';
import { urlDeLaTienda, avisarAlCliente } from '../../webapp/src/avisos_cliente.js';

describe('urlDeLaTienda', () => {
  it('el panel publicado le habla a la tienda publicada', () => {
    expect(urlDeLaTienda('https://admin.liceolibreria.com')).toBe('https://beta.liceolibreria.com');
  });

  it('el panel en local le habla a la tienda local', () => {
    expect(urlDeLaTienda('http://localhost:3000')).toBe('http://localhost:5180');
    expect(urlDeLaTienda('http://127.0.0.1:3000')).toBe('http://localhost:5180');
  });
});

describe('avisarAlCliente', () => {
  it('manda solo el id, sin esperar a que se entregue el aviso', async () => {
    const pedir = vi.fn(async () => ({ ok: true }));
    await avisarAlCliente('k1', { pedir, origen: 'https://admin.liceolibreria.com' });
    const [url, opciones] = pedir.mock.calls[0];
    expect(url).toBe('https://beta.liceolibreria.com/.netlify/functions/avisar-estado');
    expect(JSON.parse(opciones.body)).toEqual({ id: 'k1' });
    expect(opciones.keepalive).toBe(true);
  });

  it('si no contesta devuelve false y no tira', async () => {
    const pedir = vi.fn(async () => { throw new Error('sin red'); });
    await expect(avisarAlCliente('k1', { pedir, origen: 'https://admin.liceolibreria.com' })).resolves.toBe(false);
  });

  it('sin id no llama a nadie', async () => {
    const pedir = vi.fn();
    await avisarAlCliente('', { pedir });
    expect(pedir).not.toHaveBeenCalled();
  });
});
