// @vitest-environment jsdom
/**
 * Los botones de la tarjeta de un pedido contra una base que no es la que la
 * tarjeta muestra.
 *
 * Con dos PCs en el mostrador la tarjeta puede estar vieja: una cancela el
 * pedido y la otra, que todavía lo ve "listo", toca "Entregado". Eso
 * registraba la venta y descontaba stock de un pedido cancelado. Al revés,
 * cancelar desde la tarjeta vieja un pedido ya entregado lo dejaba
 * "cancelado" con la venta hecha, y el cupón recuperaba un uso.
 *
 * El doble de Firestore separa las dos cosas: `datos.lista` es lo que ve la
 * pantalla (el snapshot) y `datos.base` es lo que hay de verdad, que es lo
 * que releen las transacciones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { datos } = vi.hoisted(() => ({
  // `escuchas`: cada onSnapshot abierto, para avisarle de nuevo o ver si se cortó.
  datos: { base: {}, lista: [], escrituras: [], fallar: false, escuchas: [] },
}));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  const base = firestoreFalso({ registro: datos.escrituras });
  const clave = ref => `${ref?._col}/${ref?.id}`;
  const leer = ref => {
    const d = datos.base[clave(ref)];
    return { exists: () => d != null, data: () => d, id: ref?.id };
  };
  const escribir = (tipo, ref, cambios) => {
    datos.escrituras.push({ tipo, ref, datos: cambios });
    datos.base[clave(ref)] = { ...(datos.base[clave(ref)] || {}), ...cambios };
  };
  const vacio = { docs: [], empty: true, size: 0, docChanges: () => [], forEach() {} };
  return {
    ...base,
    collection: (_db, nombre) => ({ _col: nombre }),
    query: (col, ...partes) => ({ _col: col?._col, partes }),
    getDoc: async (ref) => leer(ref),
    getDocs: async () => vacio,
    getDocFromCache: async () => { throw new Error('sin cache local'); },
    // Lo que la pantalla ve. Se emite una sola vez: la tarjeta queda como
    // estaba aunque la base cambie, que es justo el caso que se prueba.
    onSnapshot: (q, cb) => {
      const nombre = q?._col || q?.col?._col;
      const escucha = {
        nombre, activa: true,
        avisar() {
          const lista = nombre === 'tienda_pedidos' ? datos.lista
            : nombre === 'tienda_entregas' ? (datos.entregas || []) : [];
          cb({
            ...vacio, empty: !lista.length, size: lista.length,
            docs: lista.map(d => ({ id: d.__id, data: () => d, exists: () => true })),
          });
        },
      };
      datos.escuchas.push(escucha);
      escucha.avisar();
      return () => { escucha.activa = false; };
    },
    updateDoc: async (ref, cambios) => escribir('update', ref, cambios),
    runTransaction: async (_db, fn) => {
      if (datos.fallar) throw new Error('sin red');
      return fn({
        get: async (ref) => leer(ref),
        set: (ref, cambios) => escribir('tx-set', ref, cambios),
        update: (ref, cambios) => escribir('tx-update', ref, cambios),
      });
    },
  };
});
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {}, storage: {} }));
vi.mock('../../webapp/src/auth.js', () => ({
  auth: { currentUser: { uid: 'u1', displayName: 'Mari', getIdToken: async () => 'T' } },
  getSession: () => ({ uid: 'u1', display: 'Mari', role: 'admin' }),
  isLoggedIn: () => true, onAuthReady: async () => ({ role: 'admin' }),
  hasSessionHint: () => true, logout: async () => {},
}));
vi.mock('../../webapp/src/store.js', () => ({
  ensureCollections: () => {}, onStoreChange: () => () => {},
  initStore: async () => {}, storeListo: async () => {},
}));

const PEDIDO = {
  __id: 'k1', codigo: 'K7M2', estado: 'listo', creado: new Date(), visto: true,
  cliente: { nombre: 'Marta Gómez', telefono: '3515550001' },
  entrega: { modo: 'retiro' }, pago: { modo: 'efectivo' },
  items: [{ id: 'p1', nombre: 'Cuaderno Rivadavia', cantidad: 2, precio: 3500, subtotal: 7000 }],
  subtotal: 7000, envio: 0, total: 7000,
};

/** La tarjeta con una cosa y la base con otra. */
function preparar({ tarjeta = {}, base = {} } = {}) {
  datos.lista = [{ ...PEDIDO, ...tarjeta }];
  const { __id, ...enBase } = { ...PEDIDO, ...base };
  datos.base['tienda_pedidos/k1'] = enBase;
  datos.base['catalogo/p1'] = {
    nombre: 'CUADERNO RIVADAVIA', rubro: 'LIBRERIA', stock: 12, precio_venta: 3500,
    estado: 'activo', unidad: 'unidad',
  };
}

let contenedor;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  datos.base = {};
  datos.lista = [];
  datos.escrituras.length = 0;
  datos.escuchas = [];
  datos.entregas = [];
  datos.fallar = false;
  window.__limpiarPagina = null;
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('confirm', vi.fn(() => true));
  document.body.innerHTML = '';
  contenedor = document.createElement('div');
  contenedor.id = 'content';
  document.body.appendChild(contenedor);
});

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));

async function montar() {
  const mod = await import('../../webapp/src/pages/pedidos_tienda.js');
  await mod.renderPedidosTienda(contenedor, {});
  for (let i = 0; i < 10; i++) await esperar();
  return contenedor;
}

async function tocar(selector) {
  document.querySelector(selector).click();
  for (let i = 0; i < 20; i++) await esperar();
}

const escritas = (tipo, col) =>
  datos.escrituras.filter(e => e.tipo === tipo && e.ref?._col === col);

const contador = (filtro) =>
  document.querySelector(`[data-filtro="${filtro}"] .cuenta`).textContent;

describe('cancelar desde una tarjeta vieja', () => {
  it('un pedido ya entregado no se cancela, y la tarjeta se va a donde está de verdad', async () => {
    preparar({
      tarjeta: { estado: 'listo' },
      base: { estado: 'entregado', venta_registrada: true, venta_id: 'TIENDA_K7M2', stock_descontado: true },
    });
    const c = await montar();
    expect(c.querySelector('[data-act="cancelar"]')).toBeTruthy();
    await tocar('[data-act="cancelar"]');

    expect(datos.base['tienda_pedidos/k1'].estado).toBe('entregado');
    expect(datos.escrituras.some(e => e.datos?.estado === 'cancelado')).toBe(false);
    expect(alert).toHaveBeenCalledWith(expect.stringMatching(/venta está registrada/));
    // "Pendientes" ya no lo lista: pasó a Entregados sin esperar al snapshot.
    expect(c.querySelector('[data-id="k1"]')).toBeNull();
    expect(contador('entregado')).toBe('1');
  });

  it('con la base al día, cancelar cancela', async () => {
    preparar({ tarjeta: { estado: 'nuevo' }, base: { estado: 'nuevo' } });
    await montar();
    await tocar('[data-act="cancelar"]');

    expect(datos.base['tienda_pedidos/k1'].estado).toBe('cancelado');
    expect(alert).not.toHaveBeenCalled();
  });
});

describe('entregar desde una tarjeta vieja', () => {
  it('un pedido cancelado no se vende: ni venta ni stock', async () => {
    preparar({ tarjeta: { estado: 'listo' }, base: { estado: 'cancelado' } });
    const c = await montar();
    expect(c.querySelector('[data-act="avanzar"]').dataset.estado).toBe('entregado');
    await tocar('[data-act="avanzar"]');

    expect(escritas('tx-set', 'ventas')).toHaveLength(0);
    expect(escritas('tx-set', 'ventas_por_dia')).toHaveLength(0);
    expect(datos.base['catalogo/p1'].stock).toBe(12);
    expect(datos.base['tienda_pedidos/k1'].estado).toBe('cancelado');
    expect(datos.base['tienda_pedidos/k1'].venta_registrada).toBeUndefined();
    expect(alert).toHaveBeenCalledWith(expect.stringMatching(/cancelado/));
    expect(c.querySelector('[data-id="k1"]')).toBeNull();
  });

  it('un pedido cancelado tampoco vuelve a la fila desde "Empezar a preparar"', async () => {
    preparar({ tarjeta: { estado: 'nuevo' }, base: { estado: 'cancelado' } });
    await montar();
    await tocar('[data-act="avanzar"]');

    expect(datos.base['tienda_pedidos/k1'].estado).toBe('cancelado');
    expect(alert).toHaveBeenCalledWith(expect.stringMatching(/cancelado/));
  });

  it('con la base al día, entregar registra la venta y baja el stock', async () => {
    preparar({ tarjeta: { estado: 'listo' }, base: { estado: 'listo' } });
    await montar();
    await tocar('[data-act="avanzar"]');

    expect(datos.base['tienda_pedidos/k1']).toMatchObject({
      estado: 'entregado', venta_registrada: true, venta_id: 'TIENDA_K7M2',
    });
    expect(datos.base['catalogo/p1'].stock).toBe(10);
    expect(escritas('tx-set', 'ventas').map(e => e.ref.id)).toEqual(['TIENDA_K7M2']);
    expect(alert).not.toHaveBeenCalled();
  });
});

describe('si la escritura falla', () => {
  it('el botón vuelve a prenderse para poder reintentar', async () => {
    // El snapshot solo repinta cuando algo cambió en la base; con un fallo de
    // red no cambió nada y el botón quedaba apagado hasta recargar.
    preparar({ tarjeta: { estado: 'nuevo' }, base: { estado: 'nuevo' } });
    datos.fallar = true;
    const c = await montar();
    await tocar('[data-act="avanzar"]');

    expect(c.querySelector('[data-act="avanzar"]').disabled).toBe(false);
    expect(datos.base['tienda_pedidos/k1'].estado).toBe('nuevo');
  });
});

describe('lo que entregó el repartidor', () => {
  it('la tarjeta dice que lo entregó él, si cobró, que la venta se está registrando y tiene la foto', async () => {
    preparar({
      tarjeta: { estado: 'entregado', entrega: { modo: 'delivery', direccion: 'Colón 1200' },
                 entregado_por: 'reparto', venta_pendiente: true, entregado_en: new Date() },
    });
    datos.entregas = [{ __id: 'k1', cobrado: true, foto: { url: 'https://firebasestorage.googleapis.com/v0/b/x/o/entregas%2Fk1.jpg?alt=media&token=t' } }];
    const c = await montar();
    await tocar('[data-filtro="entregado"]');
    const ficha = c.querySelector('[data-id="k1"]');
    expect(ficha.textContent).toContain('Lo entregó el repartidor');
    expect(ficha.textContent).toContain('cobró en efectivo');
    expect(ficha.textContent).toContain('Registrando la venta');
    await tocar('[data-act="foto-entrega"]');
    expect(document.querySelector('.tienda-foto-zoom img').getAttribute('src')).toContain('entregas%2Fk1.jpg');
  });

  it('si no cobró el efectivo, se ve', async () => {
    preparar({ tarjeta: { estado: 'entregado', entregado_por: 'reparto', venta_registrada: true } });
    datos.entregas = [{ __id: 'k1', cobrado: false, foto: null }];
    const c = await montar();
    await tocar('[data-filtro="entregado"]');
    expect(c.querySelector('[data-id="k1"]').textContent).toContain('no cobró el efectivo');
  });

  it('un pedido entregado desde el panel no muestra nada de esto', async () => {
    preparar({ tarjeta: { estado: 'entregado', venta_registrada: true } });
    const c = await montar();
    await tocar('[data-filtro="entregado"]');
    expect(c.querySelector('[data-id="k1"]').textContent).not.toContain('repartidor');
  });
});

describe('el teléfono en la tarjeta', () => {
  // Un fijo de Córdoba tiene siete dígitos y `whatsappDe` devuelve null abajo de
  // ocho. Como el número se pintaba adentro del enlace de WhatsApp, la tarjeta
  // salía con el nombre y nada más: el mostrador no tenía cómo llamar a alguien
  // que ya había hecho el pedido. El checkout acepta desde seis dígitos, así que
  // el pedido entra sin problema.
  it('un fijo corto se ve igual, aunque no sirva para WhatsApp', async () => {
    preparar({ tarjeta: { cliente: { nombre: 'Marta Gómez', telefono: '4234567' } } });
    const c = await montar();
    const ficha = c.querySelector('[data-id="k1"]');

    expect(ficha.textContent).toContain('4234567');
    expect(ficha.querySelector('a[href*="wa.me"]')).toBeNull();
  });

  it('un celular sigue llevando al chat', async () => {
    preparar({ tarjeta: { cliente: { nombre: 'Marta Gómez', telefono: '+54 351 619 4411' } } });
    const c = await montar();
    const enlace = c.querySelector('[data-id="k1"] a[href*="wa.me"]');

    expect(enlace).toBeTruthy();
    expect(enlace.getAttribute('href')).toContain('wa.me/5493516194411');
    expect(enlace.textContent).toContain('+54 351 619 4411');
  });

  it('sin teléfono no aparece un renglón vacío', async () => {
    preparar({ tarjeta: { cliente: { nombre: 'Marta Gómez' } } });
    const c = await montar();
    const ficha = c.querySelector('[data-id="k1"]');

    expect(ficha.textContent).toContain('Marta Gómez');
    expect(ficha.textContent).not.toContain('call');
  });
});

describe('al irse de la pantalla', () => {
  // Las escuchas de pedidos y comprobantes seguían abiertas después de pasar
  // a otra pantalla, y la de pedidos marca "visto" todo lo que llega: un pedido
  // nuevo entraba mientras se miraba el Catálogo y el aviso rojo se apagaba
  // solo, sin que nadie lo hubiera visto.
  const nuevo = { ...PEDIDO, __id: 'k2', codigo: 'Z9Q1', estado: 'nuevo', visto: false };
  const marcadosVistos = () => escritas('update', 'tienda_pedidos')
    .filter(e => e.datos?.visto === true).map(e => e.ref.id);

  it('deja de escuchar los pedidos y los comprobantes', async () => {
    preparar();
    await montar();
    expect(datos.escuchas.map(e => e.nombre).sort())
      .toEqual(['tienda_comprobantes', 'tienda_entregas', 'tienda_pedidos']);

    expect(typeof window.__limpiarPagina).toBe('function');
    window.__limpiarPagina();

    expect(datos.escuchas.every(e => !e.activa), 'quedó una escucha abierta').toBe(true);
  });

  it('un pedido que llega con la pantalla cerrada no se marca visto', async () => {
    preparar();
    await montar();
    const pedidos = datos.escuchas.find(e => e.nombre === 'tienda_pedidos');

    // Se pasó a otra pantalla, y el aviso del pedido ya venía en camino.
    contenedor.remove();
    datos.lista = [nuevo, ...datos.lista];
    pedidos.avisar();
    for (let i = 0; i < 10; i++) await esperar();

    expect(marcadosVistos()).toEqual([]);
  });

  it('con la pantalla abierta, lo que entra sí se marca visto', async () => {
    preparar();
    await montar();
    datos.lista = [nuevo, ...datos.lista];
    datos.escuchas.find(e => e.nombre === 'tienda_pedidos').avisar();
    for (let i = 0; i < 10; i++) await esperar();

    expect(marcadosVistos()).toEqual(['k2']);
  });
});

describe('el aviso al celular del cliente', () => {
  // Cada vez que el local mueve el pedido, el panel le pide a la tienda que
  // mande la notificación. Va sin esperar respuesta: si la tienda no contesta,
  // el cambio de estado ya está hecho y el local sigue trabajando.
  const avisos = () => fetch.mock.calls
    .filter(([url]) => String(url).endsWith('/.netlify/functions/avisar-estado'))
    .map(([url, op]) => ({ url: String(url), cuerpo: JSON.parse(op.body) }));

  it('al avanzar un pedido se le avisa a la tienda, con el id y nada más', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    preparar({ tarjeta: { estado: 'nuevo' }, base: { estado: 'nuevo' } });
    await montar();
    await tocar('[data-act="avanzar"]');

    expect(datos.base['tienda_pedidos/k1'].estado).toBe('preparando');
    expect(avisos()).toEqual([{ url: expect.stringMatching(/^https?:\/\//), cuerpo: { id: 'k1' } }]);
  });

  it('entregar también avisa', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    preparar({ tarjeta: { estado: 'listo' }, base: { estado: 'listo' } });
    await montar();
    await tocar('[data-act="avanzar"]');
    expect(avisos().map(a => a.cuerpo.id)).toEqual(['k1']);
  });

  it('si la tienda no contesta, el pedido queda movido y no salta ningún error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sin red'); }));
    preparar({ tarjeta: { estado: 'nuevo' }, base: { estado: 'nuevo' } });
    await montar();
    await tocar('[data-act="avanzar"]');
    expect(datos.base['tienda_pedidos/k1'].estado).toBe('preparando');
    expect(alert).not.toHaveBeenCalled();
  });

  it('un cambio que no se hizo no avisa', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    preparar({ tarjeta: { estado: 'nuevo' }, base: { estado: 'cancelado' } });
    await montar();
    await tocar('[data-act="avanzar"]');
    expect(avisos()).toEqual([]);
  });
});

