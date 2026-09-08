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
import { CUENTA, crearMundo, fetchFalso, desplanar } from './rest_falso.js';

/* ── El estado que ve la función ──────────────────────────────────────────── */

let mundo = crearMundo();

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

beforeEach(() => {
  mundo = crearMundo();
  process.env.FIREBASE_SERVICE_ACCOUNT = CUENTA;
  process.env.GOOGLE_ROUTES_KEY = 'clave-de-prueba';
  vi.stubGlobal('fetch', vi.fn(fetchFalso(mundo)));
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

/* ── Cupones ──────────────────────────────────────────────────────────────── */

describe('con cupón', () => {
  const BIENVENIDA = {
    codigo: 'BIENVENIDA', nombre: 'Cupón de bienvenida', tipo: 'porcentaje', valor: 10,
    aplica: { modo: 'todo' }, activo: true,
  };
  const conCupon = (items, extra = {}) => retiro(items, { cupon: 'BIENVENIDA', ...extra });

  beforeEach(() => { mundo.cupones.BIENVENIDA = { ...BIENVENIDA }; });

  it('el descuento lo pone la base, y queda anotado en el pedido', async () => {
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }], { cupon: ' bienvenida ' })));

    expect(res.status).toBe(200);
    const datos = await res.json();
    expect(datos.descuento).toBe(1800);
    expect(datos.total).toBe(16200);

    const doc = guardado();
    expect(doc.cupon).toMatchObject({
      codigo: 'BIENVENIDA', nombre: 'Cupón de bienvenida', tipo: 'porcentaje', valor: 10, descuento: 1800,
    });
    expect(doc.cupon.renglones).toEqual([{ id: 'resma', variedad: null, es_pack: false, descuento: 1800 }]);
    expect(doc.descuento).toBe(1800);
    expect(doc.total).toBe(16200);
    expect(doc.subtotal).toBe(18000);
    expect(doc.cliente.telefono_clave).toBe('3515550001');
  });

  it('sin cupón el pedido sale como siempre', async () => {
    const crear = await cargar();
    await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }])));
    expect(guardado().cupon).toBeNull();
    expect(guardado().descuento).toBe(0);
  });

  it('un cupón que no existe no entra, y no se guarda nada', async () => {
    const crear = await cargar();
    const res = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }], { cupon: 'NADA' })));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'cupon', motivo: 'no_existe' });
    expect(mundo.guardados).toHaveLength(0);
  });

  it('un descuento mandado a mano se ignora: manda el cupón', async () => {
    const crear = await cargar();
    await crear(pedir({ ...conCupon([{ id: 'resma', cantidad: 1 }]), descuento: 17000, total: 1000 }));
    expect(guardado().total).toBe(16200);
  });

  it('una sola vez por persona: el mismo teléfono, escrito distinto, no lo usa dos veces', async () => {
    mundo.cupones.BIENVENIDA.usos_por_persona = 1;
    const crear = await cargar();
    const a = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }])));
    const b = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }],
      { cliente: { nombre: 'Marta', telefono: '+54 9 351 555-0001' } })));
    const c = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }],
      { cliente: { nombre: 'Otra persona', telefono: '3519999999' } })));

    expect(a.status).toBe(200);
    expect(b.status).toBe(409);
    expect(await b.json()).toMatchObject({ error: 'cupon', motivo: 'ya_usado', veces: 1 });
    expect(c.status).toBe(200);
    expect(mundo.guardados).toHaveLength(2);
  });

  it('con cuenta, cambiar el teléfono no alcanza: la cuenta es la misma', async () => {
    mundo.cupones.BIENVENIDA.usos_por_persona = 1;
    const crear = await cargar();
    const a = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }], { idToken: 'tok' })));
    const b = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }],
      { idToken: 'tok', cliente: { nombre: 'Marta', telefono: '3517777777' } })));

    expect(a.status).toBe(200);
    expect(b.status).toBe(409);
    expect((await b.json()).motivo).toBe('ya_usado');
  });

  it('un pedido cancelado devuelve el uso', async () => {
    mundo.cupones.BIENVENIDA.usos_por_persona = 1;
    mundo.abiertos.push({
      id: 'viejo', estado: 'cancelado', cliente: { telefono: '3515550001' },
      cupon: { codigo: 'BIENVENIDA' }, items: [],
    });
    const crear = await cargar();
    const res = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }])));
    expect(res.status).toBe(200);
  });

  it('los usos totales se agotan', async () => {
    mundo.cupones.BIENVENIDA.usos_totales = 2;
    mundo.abiertos.push(
      { id: 'u1', estado: 'entregado', cliente: { telefono: '3510000001' }, cupon: { codigo: 'BIENVENIDA' }, items: [] },
      { id: 'u2', estado: 'nuevo', cliente: { telefono: '3510000002' }, cupon: { codigo: 'BIENVENIDA' }, items: [] },
    );
    const crear = await cargar();
    const res = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }])));
    expect(res.status).toBe(409);
    expect((await res.json()).motivo).toBe('agotado');
  });

  it('dos pedidos en el mismo instante por el último uso: entra a lo sumo uno', async () => {
    mundo.cupones.BIENVENIDA.usos_totales = 1;
    const crear = await cargar();
    const respuestas = await Promise.all([
      crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }]))),
      crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }], { cliente: { nombre: 'Otra', telefono: '3519999999' } }))),
    ]);
    const aceptados = respuestas.filter(r => r.status === 200).length;
    expect(aceptados).toBeLessThanOrEqual(1);
    expect(mundo.guardados).toHaveLength(aceptados);
    for (const r of respuestas.filter(r => r.status !== 200)) {
      expect((await r.json())).toMatchObject({ error: 'cupon', motivo: 'agotado' });
    }
  });

  it('la misma persona dos veces en el mismo instante: el que se retira dice cuántas veces valía', async () => {
    // Los dos pasan la primera mirada con cero usos; es la segunda, ya con el
    // pedido escrito, la que los retira. Esa respuesta mandaba `veces: null`
    // —lo buscaba en lo que se guarda en el pedido, que no trae ese campo— y
    // el cliente leía "ya lo usaste null veces".
    mundo.cupones.BIENVENIDA.usos_por_persona = 1;
    const crear = await cargar();
    const respuestas = await Promise.all([
      crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }]))),
      crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }]))),
    ]);

    expect(mundo.borrados.length).toBeGreaterThan(0);
    const rechazados = respuestas.filter(r => r.status !== 200);
    expect(rechazados.length).toBeGreaterThan(0);
    for (const r of rechazados) {
      expect(await r.json()).toMatchObject({ error: 'cupon', motivo: 'ya_usado', veces: 1 });
    }
  });

  it('con mínimo de compra dice cuánto falta, y el pedido no se guarda', async () => {
    mundo.cupones.BIENVENIDA.minimo_compra = 20000;
    const crear = await cargar();
    const res = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }])));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'cupon', motivo: 'minimo', falta: 2000, minimo: 20000 });
    expect(mundo.guardados).toHaveLength(0);
  });

  it('solo para unos productos: el descuento cae en esos y en nada más', async () => {
    mundo.cupones.BIENVENIDA.aplica = { modo: 'productos', productos: ['cartulina'], etiqueta: 'Cartulina Luma' };
    const crear = await cargar();
    const res = await crear(pedir(conCupon([
      { id: 'resma', cantidad: 1 },
      { id: 'cartulina', variedad: 'Rojo', cantidad: 5 },
    ])));

    expect(res.status).toBe(200);
    const doc = guardado();
    expect(doc.descuento).toBe(400);   // 10 % de 4.000, no de 22.000
    expect(doc.cupon.renglones).toEqual([{ id: 'cartulina', variedad: 'Rojo', es_pack: false, descuento: 400 }]);
    expect(doc.total).toBe(22000 - 400);
  });

  it('sin nada de lo que cubre, avisa para qué es', async () => {
    mundo.cupones.BIENVENIDA.aplica = { modo: 'rubros', rubros: ['MERCERIA'] };
    const crear = await cargar();
    const res = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }])));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ motivo: 'sin_productos', alcance: 'Merceria' });
  });

  it('el rubro se toma del producto de la base, no del que mande el cliente', async () => {
    mundo.cupones.BIENVENIDA.aplica = { modo: 'rubros', rubros: ['MERCERIA'] };
    const crear = await cargar();
    const res = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1, rubro: 'MERCERIA' }])));
    expect(res.status).toBe(409);
  });

  it('envío gratis: el envío queda descontado y el pedido marcado', async () => {
    mundo.cupones.ENVIO = { codigo: 'ENVIO', nombre: 'Envío sin cargo', tipo: 'envio_gratis', aplica: { modo: 'todo' }, activo: true };
    mundo.metros = 2500;
    const crear = await cargar();
    const res = await crear(pedir({
      cliente: CLIENTE,
      entrega: { modo: 'delivery', direccion: 'Av. Colón 1234', coordenadas: { lat: -31.4, lng: -64.19 } },
      pago: { modo: 'transferencia' },
      items: [{ id: 'resma', cantidad: 1 }],
      nota: '',
      cupon: 'envio',
    }));

    expect(res.status).toBe(200);
    const doc = guardado();
    expect(doc.envio).toBe(1500);
    expect(doc.descuento).toBe(1500);
    expect(doc.total).toBe(18000);
    expect(doc.entrega.envio_gratis).toBe(true);
    expect(doc.cupon.envio_gratis).toBe(true);
  });

  it('envío gratis retirando por el local no tiene sentido', async () => {
    mundo.cupones.ENVIO = { codigo: 'ENVIO', tipo: 'envio_gratis', aplica: { modo: 'todo' }, activo: true };
    const crear = await cargar();
    const res = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }], { cupon: 'ENVIO' })));
    expect(res.status).toBe(409);
    expect((await res.json()).motivo).toBe('solo_delivery');
  });

  it('el mínimo del pedido se mide antes del cupón', async () => {
    // 8.000 de cartulinas pasan el mínimo de 6.500; con 5.000 de cupón el
    // total queda en 3.000 y entra igual: compró lo que había que comprar.
    mundo.cupones.BIENVENIDA.tipo = 'monto';
    mundo.cupones.BIENVENIDA.valor = 5000;
    const crear = await cargar();
    const res = await crear(pedir(conCupon([{ id: 'cartulina', variedad: 'Rojo', cantidad: 10 }])));
    expect(res.status).toBe(200);
    expect(guardado().total).toBe(3000);
  });

  it('un monto mayor a lo elegible no deja el total en negativo', async () => {
    mundo.cupones.BIENVENIDA.tipo = 'monto';
    mundo.cupones.BIENVENIDA.valor = 50000;
    mundo.config.entrega.pedido_minimo = 0;
    const crear = await cargar();
    const res = await crear(pedir(conCupon([{ id: 'cartulina', variedad: 'Rojo', cantidad: 5 }])));
    expect(res.status).toBe(200);
    expect(guardado().descuento).toBe(4000);
    expect(guardado().total).toBe(0);
  });

  it('vencido no entra', async () => {
    mundo.cupones.BIENVENIDA.hasta = '2020-01-01';
    const crear = await cargar();
    const res = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }])));
    expect(res.status).toBe(409);
    expect((await res.json()).motivo).toBe('vencido');
  });

  it('solo primera compra: quien ya compró no lo puede usar', async () => {
    mundo.cupones.BIENVENIDA.solo_primera_compra = true;
    const crear = await cargar();
    const primero = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }])));
    const segundo = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }])));
    expect(primero.status).toBe(200);
    expect(segundo.status).toBe(409);
    expect((await segundo.json()).motivo).toBe('primera_compra');
  });

  it('un cupón que no es texto: 400', async () => {
    const crear = await cargar();
    const res = await crear(pedir(retiro([{ id: 'resma', cantidad: 1 }], { cupon: { a: 1 } })));
    expect(res.status).toBe(400);
    expect((await res.json()).detalle).toBe('cupon');
  });

  it('si no se pueden contar los usos, el cupón no se aplica', async () => {
    mundo.cupones.BIENVENIDA.usos_por_persona = 1;
    mundo.consultasFallan = true;
    const crear = await cargar();
    const res = await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }])));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'cupon', motivo: 'error' });
    expect(mundo.guardados).toHaveLength(0);
  });

  it('el cupón se lee con la cuenta de servicio, nunca a la vista de cualquiera', async () => {
    const crear = await cargar();
    await crear(pedir(conCupon([{ id: 'resma', cantidad: 1 }])));
    const lecturas = vi.mocked(fetch).mock.calls.filter(c => String(c[0]).includes('/tienda_cupones/'));
    expect(lecturas.length).toBeGreaterThan(0);
    for (const [, opciones] of lecturas) expect(opciones.headers.Authorization).toMatch(/^Bearer /);
  });
});
