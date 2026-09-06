/**
 * La vista previa del cupón: lo que el checkout le muestra al cliente antes de
 * confirmar tiene que ser exactamente lo que después le cobra el pedido.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CUENTA, crearMundo, fetchFalso } from './rest_falso.js';

let mundo = crearMundo();

async function cargar(nombre = 'validar-cupon') {
  vi.resetModules();
  const mod = await import(`../netlify/functions/${nombre}.mjs`);
  return mod.default;
}

function pedir(cuerpo, metodo = 'POST') {
  return new Request('https://beta.liceolibreria.com/.netlify/functions/validar-cupon', {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: metodo === 'POST' ? JSON.stringify(cuerpo) : undefined,
  });
}

const BIENVENIDA = {
  codigo: 'BIENVENIDA', nombre: 'Cupón de bienvenida', tipo: 'porcentaje', valor: 10,
  aplica: { modo: 'todo' }, activo: true,
};

const consulta = (extra = {}) => ({
  codigo: 'BIENVENIDA',
  items: [{ id: 'resma', cantidad: 1 }],
  entrega: { modo: 'retiro' },
  telefono: '3515550001',
  ...extra,
});

beforeEach(() => {
  mundo = crearMundo();
  mundo.cupones.BIENVENIDA = { ...BIENVENIDA };
  process.env.FIREBASE_SERVICE_ACCOUNT = CUENTA;
  vi.stubGlobal('fetch', vi.fn(fetchFalso(mundo)));
});

afterEach(() => { vi.useRealTimers(); });

describe('la vista previa', () => {
  it('con un cupón válido dice cuánto descuenta y cómo se llama', async () => {
    const validar = await cargar();
    const res = await validar(pedir(consulta()));

    expect(res.status).toBe(200);
    const datos = await res.json();
    expect(datos).toMatchObject({ ok: true, descuento: 1800, aplicable: 18000, envio_gratis: false });
    expect(datos.cupon).toMatchObject({ codigo: 'BIENVENIDA', nombre: 'Cupón de bienvenida', tipo: 'porcentaje', valor: 10 });
    expect(datos.renglones).toEqual([{ id: 'resma', variedad: null, es_pack: false, descuento: 1800 }]);
  });

  it('el código se normaliza como lo tipea la gente', async () => {
    const validar = await cargar();
    const res = await validar(pedir(consulta({ codigo: '  bienvenida ' })));
    expect(res.status).toBe(200);
  });

  it('el precio sale de la base, no del que mande el cliente', async () => {
    const validar = await cargar();
    const res = await validar(pedir(consulta({ items: [{ id: 'resma', cantidad: 1, precio: 1, subtotal: 1 }] })));
    expect((await res.json()).descuento).toBe(1800);
  });

  it('lo que no tiene stock queda afuera de la cuenta', async () => {
    mundo.productos.resma.stock = 0;
    const validar = await cargar();
    const res = await validar(pedir(consulta({
      items: [{ id: 'resma', cantidad: 1 }, { id: 'cartulina', variedad: 'Rojo', cantidad: 5 }],
    })));
    expect((await res.json()).descuento).toBe(400);
  });

  it('da lo mismo que el pedido: misma cuenta, mismo número', async () => {
    const validar = await cargar();
    const preview = await (await validar(pedir(consulta({
      items: [{ id: 'resma', cantidad: 1 }, { id: 'cinta', cantidad: 2, es_pack: true }],
    })))).json();

    const crear = await cargar('crear-pedido');
    const pedido = await (await crear(new Request('https://x/.netlify/functions/crear-pedido', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente: { nombre: 'Marta Gómez', telefono: '3515550001' },
        entrega: { modo: 'retiro' }, pago: { modo: 'efectivo' }, nota: '',
        items: [{ id: 'resma', cantidad: 1 }, { id: 'cinta', cantidad: 2, es_pack: true }],
        cupon: 'BIENVENIDA',
      }),
    }))).json();

    expect(pedido.descuento).toBe(preview.descuento);
    expect(preview.descuento).toBe(2700);   // 10 % de 18.000 + 9.000
  });
});

describe('cuando no vale', () => {
  it('un código que no existe contesta 409 y se toma medio segundo', async () => {
    vi.useFakeTimers();
    const validar = await cargar();
    let listo = false;
    const promesa = validar(pedir(consulta({ codigo: 'NOEXISTE' }))).then(r => { listo = true; return r; });

    await vi.advanceTimersByTimeAsync(100);
    expect(listo).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(listo).toBe(true);

    const res = await promesa;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'cupon', motivo: 'no_existe' });
  });

  it('un código con forma inválida ni se busca en la base', async () => {
    vi.useFakeTimers();
    const validar = await cargar();
    const promesa = validar(pedir(consulta({ codigo: 'a' })));
    await vi.advanceTimersByTimeAsync(600);
    const res = await promesa;
    expect(res.status).toBe(409);
    expect(vi.mocked(fetch).mock.calls.some(c => String(c[0]).includes('/tienda_cupones/'))).toBe(false);
  });

  it('con mínimo de compra dice cuánto falta', async () => {
    mundo.cupones.BIENVENIDA.minimo_compra = 25000;
    const validar = await cargar();
    const res = await validar(pedir(consulta()));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'cupon', motivo: 'minimo', falta: 7000, minimo: 25000 });
  });

  it('ya lo usó esta persona, aunque escriba el teléfono distinto', async () => {
    mundo.cupones.BIENVENIDA.usos_por_persona = 1;
    mundo.abiertos.push({
      id: 'anterior', estado: 'entregado', cliente: { telefono: '+54 9 351 555 0001' },
      cupon: { codigo: 'BIENVENIDA' }, items: [],
    });
    const validar = await cargar();
    const res = await validar(pedir(consulta()));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ motivo: 'ya_usado', veces: 1 });
  });

  it('sin teléfono todavía, el cupón se muestra igual: el pedido lo controla después', async () => {
    mundo.cupones.BIENVENIDA.usos_por_persona = 1;
    const validar = await cargar();
    const res = await validar(pedir(consulta({ telefono: '' })));
    expect(res.status).toBe(200);
  });

  it('apagado desde el panel', async () => {
    mundo.cupones.BIENVENIDA.activo = false;
    const validar = await cargar();
    const res = await validar(pedir(consulta()));
    expect((await res.json()).motivo).toBe('inactivo');
  });
});

describe('el envío gratis', () => {
  beforeEach(() => {
    mundo.cupones.ENVIO = { codigo: 'ENVIO', nombre: 'Envío sin cargo', tipo: 'envio_gratis', aplica: { modo: 'todo' }, activo: true };
  });

  it('usa el envío cotizado que manda el checkout', async () => {
    const validar = await cargar();
    const res = await validar(pedir(consulta({ codigo: 'ENVIO', entrega: { modo: 'delivery' }, envio: 2500 })));
    expect(await res.json()).toMatchObject({ ok: true, descuento: 2500, envio_gratis: true });
  });

  it('con retiro no vale', async () => {
    const validar = await cargar();
    const res = await validar(pedir(consulta({ codigo: 'ENVIO' })));
    expect((await res.json()).motivo).toBe('solo_delivery');
  });

  it('un envío negativo o inventado no descuenta plata', async () => {
    const validar = await cargar();
    const res = await validar(pedir(consulta({ codigo: 'ENVIO', entrega: { modo: 'delivery' }, envio: -9000 })));
    expect((await res.json()).descuento).toBe(0);
    const res2 = await validar(pedir(consulta({ codigo: 'ENVIO', entrega: { modo: 'delivery' }, envio: 'mucho' })));
    expect(res2.status).toBe(400);
  });
});

describe('la forma', () => {
  it('sin cuenta de servicio contesta 501', async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    const validar = await cargar();
    expect((await validar(pedir(consulta()))).status).toBe(501);
  });

  it('GET no', async () => {
    const validar = await cargar();
    expect((await validar(pedir(null, 'GET'))).status).toBe(405);
  });

  it('el warmup no toca nada', async () => {
    const validar = await cargar();
    expect((await validar(pedir({ warmup: 1 }))).status).toBe(204);
  });

  it('sin items, sin código o con una cantidad rara: 400', async () => {
    const validar = await cargar();
    expect((await validar(pedir(consulta({ items: [] })))).status).toBe(400);
    expect((await validar(pedir(consulta({ codigo: '' })))).status).toBe(400);
    expect((await validar(pedir(consulta({ codigo: 5 })))).status).toBe(400);
    expect((await validar(pedir(consulta({ items: [{ id: 'resma', cantidad: 'dos' }] })))).status).toBe(400);
    expect((await validar(pedir(consulta({ entrega: { modo: 'drone' } })))).status).toBe(400);
  });
});
