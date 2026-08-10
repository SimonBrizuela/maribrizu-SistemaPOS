/**
 * Cotizacion del envio.
 *
 * Lo que se prueba acá es que el precio nunca se invente: o sale de la tabla de
 * tramos, o sale del servidor, o queda "a confirmar". Un envio mal cobrado se
 * discute en la puerta con el cliente.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  rangoDeTramos, precioPorDistancia, llegaAEnvioGratis, cotizar,
} from '../src/envio.js';

const ENTREGA = {
  radio_max_km: 12,
  tramos: [
    { hasta_km: 3, precio: 1500 },
    { hasta_km: 6, precio: 2500 },
    { hasta_km: 12, precio: 3500 },
  ],
  envio_gratis_desde: null,
};

const CERCA = { lat: -31.3450, lng: -64.2000 };

afterEach(() => { vi.unstubAllGlobals(); });

function respondiendo(datos, { ok = true, status = 200 } = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok, status, json: async () => datos,
  })));
}

describe('tabla de tramos', () => {
  it('cobra el tramo que le toca a la distancia', () => {
    expect(precioPorDistancia(1.2, ENTREGA)).toBe(1500);
    expect(precioPorDistancia(3, ENTREGA)).toBe(1500);
    expect(precioPorDistancia(3.1, ENTREGA)).toBe(2500);
    expect(precioPorDistancia(7.46, ENTREGA)).toBe(3500);
  });

  it('devuelve null fuera de la tabla, que es fuera de radio', () => {
    expect(precioPorDistancia(14.83, ENTREGA)).toBeNull();
  });

  it('ordena los tramos aunque vengan desordenados del panel', () => {
    const desordenada = { tramos: [{ hasta_km: 12, precio: 3500 }, { hasta_km: 3, precio: 1500 }] };
    expect(precioPorDistancia(2, desordenada)).toBe(1500);
  });

  it('ignora los tramos incompletos en vez de cobrar cualquier cosa', () => {
    const rota = { tramos: [{ hasta_km: 0, precio: 900 }, { hasta_km: null, precio: 800 },
                            { hasta_km: 5, precio: 2000 }] };
    expect(precioPorDistancia(1, rota)).toBe(2000);
  });

  it('el rango es el piso y el techo de la tabla', () => {
    expect(rangoDeTramos(ENTREGA)).toEqual({ min: 1500, max: 3500 });
    expect(rangoDeTramos({ tramos: [] })).toBeNull();
  });
});

describe('envio gratis', () => {
  it('solo cuando esta configurado y el pedido llega', () => {
    const con = { ...ENTREGA, envio_gratis_desde: 20000 };
    expect(llegaAEnvioGratis(19999, con)).toBe(false);
    expect(llegaAEnvioGratis(20000, con)).toBe(true);
    expect(llegaAEnvioGratis(999999, ENTREGA)).toBe(false);
  });

  it('no consulta al servidor si ya es gratis', async () => {
    const espia = vi.fn();
    vi.stubGlobal('fetch', espia);
    const r = await cotizar(CERCA, { ...ENTREGA, envio_gratis_desde: 10000 }, 15000);
    expect(r).toEqual({ estado: 'gratis', precio: 0, km: null });
    expect(espia).not.toHaveBeenCalled();
  });
});

describe('cotizar contra el servidor', () => {
  it('toma el precio que manda el servidor', async () => {
    respondiendo({ km: 7.46, precio: 3500 });
    expect(await cotizar(CERCA, ENTREGA)).toEqual({ estado: 'ok', precio: 3500, km: 7.46 });
  });

  it('marca fuera de radio y no cobra nada', async () => {
    respondiendo({ km: 14.83, fuera_de_radio: true });
    expect(await cotizar(CERCA, ENTREGA)).toEqual({ estado: 'fuera_de_radio', precio: 0, km: 14.83 });
  });

  it('sin coordenadas queda a confirmar, no en cero', async () => {
    const r = await cotizar(null, ENTREGA);
    expect(r.estado).toBe('a_confirmar');
    expect(r.motivo).toBe('sin_coordenadas');
  });

  it('con la funcion caida el pedido tiene que poder entrar igual', async () => {
    respondiendo({}, { ok: false, status: 502 });
    expect((await cotizar(CERCA, ENTREGA)).estado).toBe('a_confirmar');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sin internet'); }));
    expect((await cotizar(CERCA, ENTREGA)).estado).toBe('a_confirmar');
  });

  it('si el servidor no manda precio, lo saca de la tabla', async () => {
    respondiendo({ km: 4.43 });
    expect(await cotizar(CERCA, ENTREGA)).toEqual({ estado: 'ok', precio: 2500, km: 4.43 });
  });

  it('si el servidor manda una distancia que no es numero, no inventa', async () => {
    respondiendo({ km: 'lejos' });
    expect((await cotizar(CERCA, ENTREGA)).estado).toBe('a_confirmar');
  });
});
