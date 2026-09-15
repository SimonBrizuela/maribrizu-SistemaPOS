// @vitest-environment jsdom
/**
 * Los reclamos del lado del local: la bandeja del panel y el vigía que avisa
 * cuando entra uno.
 *
 * Lo que no puede pasar:
 *   · que el cliente vea en su pedido algo distinto de lo que el local marcó
 *     (el reclamo y el resumen del pedido se escriben juntos);
 *   · que responder un reclamo viejo pise el resumen de uno más nuevo;
 *   · que la respuesta a medio escribir se borre porque entró otro reclamo;
 *   · que un reclamo rechazado quede sin explicarle al cliente por qué.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { datos } = vi.hoisted(() => ({
  datos: { base: {}, lista: [], escrituras: [], fallar: false, escuchas: [], errorEscucha: null, toasts: [] },
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
    onSnapshot: (q, cb, alFallar) => {
      const nombre = q?._col;
      const escucha = {
        nombre, activa: true,
        avisar() {
          if (datos.errorEscucha) { alFallar?.(datos.errorEscucha); return; }
          const lista = nombre === 'tienda_reclamos' ? datos.lista : [];
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
vi.mock('../../webapp/src/components/toasts.js', () => ({
  mostrarToast: (opciones) => { datos.toasts.push(opciones); return { cerrar() {} }; },
}));

const ahora = new Date();
const RECLAMO = {
  __id: 'Ped1234567890abcdef-1', id: 'Ped1234567890abcdef-1', pedido_id: 'Ped1234567890abcdef',
  pedido_codigo: 'K7M2', estado: 'nuevo', motivo: 'roto', respuesta: null, visto: false,
  cliente: { nombre: 'Marta Gómez', telefono: '3515550001' }, entrega_modo: 'delivery',
  productos: [{ renglon: 1, id: 'p2', nombre: 'Cartulina', variedad: 'Azul', cantidad: 5 }],
  detalle: 'Dos cartulinas azules llegaron dobladas por la mitad.',
  fotos: [
    { url: 'https://firebasestorage.googleapis.com/v0/b/x/o/reclamos%2Fa.jpg?alt=media&token=t1', tipo: 'image/jpeg' },
    { url: 'https://firebasestorage.googleapis.com/v0/b/x/o/reclamos%2Fb.jpg?alt=media&token=t2', tipo: 'image/jpeg' },
  ],
  creado: ahora, actualizado: ahora,
};

function preparar(reclamos = [RECLAMO]) {
  datos.lista = reclamos.map(r => ({ ...r }));
  for (const r of datos.lista) {
    const { __id, ...enBase } = r;
    datos.base[`tienda_reclamos/${__id}`] = { ...enBase };
    datos.base[`tienda_pedidos/${r.pedido_id}`] ??= {
      codigo: r.pedido_codigo, estado: 'entregado',
      reclamo: { id: r.id, estado: r.estado, motivo: r.motivo, respuesta: null, creado: ahora, actualizado: ahora },
      reclamos_cantidad: 1,
    };
  }
}

let contenedor;
const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));
const respirar = async () => { for (let i = 0; i < 20; i++) await esperar(); };

async function montar() {
  const mod = await import('../../webapp/src/pages/tienda_reclamos.js');
  await mod.renderTiendaReclamos(contenedor, {});
  await respirar();
  return contenedor;
}

async function tocar(selector) {
  document.querySelector(selector).click();
  await respirar();
}

const tarjetas = () => [...document.querySelectorAll('[data-reclamo-id]')];
const avisos = () => fetch.mock.calls
  .filter(([url]) => String(url).endsWith('/.netlify/functions/avisar-estado'))
  .map(([, op]) => JSON.parse(op.body));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  datos.base = {};
  datos.lista = [];
  datos.escrituras.length = 0;
  datos.escuchas = [];
  datos.fallar = false;
  datos.errorEscucha = null;
  datos.toasts = [];
  window.__limpiarPagina = null;
  window.navigateToPage = vi.fn();
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
  document.body.innerHTML = '';
  contenedor = document.createElement('div');
  contenedor.id = 'content';
  document.body.appendChild(contenedor);
});

describe('la bandeja', () => {
  it('muestra el reclamo con el pedido, el cliente, qué pasó, con qué producto y las fotos', async () => {
    preparar();
    await montar();
    const [t] = tarjetas();
    expect(t.textContent).toContain('K7M2');
    expect(t.textContent).toContain('Marta Gómez');
    expect(t.textContent).toContain('Llegó roto o con fallas');
    expect(t.textContent).toContain('Cartulina');
    expect(t.textContent).toContain('Azul');
    expect(t.textContent).toContain('llegaron dobladas');
    expect(t.querySelectorAll('[data-act="foto"] img')).toHaveLength(2);
  });

  it('arranca en los abiertos; los resueltos y todos, con su cuenta', async () => {
    preparar([
      RECLAMO,
      { ...RECLAMO, __id: 'B-1', id: 'B-1', pedido_id: 'B', estado: 'revisando' },
      { ...RECLAMO, __id: 'C-1', id: 'C-1', pedido_id: 'C', estado: 'resuelto', respuesta: 'Listo.' },
    ]);
    await montar();
    expect(tarjetas()).toHaveLength(2);
    expect(document.querySelector('[data-filtro="abiertos"] .cuenta').textContent).toBe('2');
    expect(document.querySelector('[data-filtro="cerrados"] .cuenta').textContent).toBe('1');
    await tocar('[data-filtro="cerrados"]');
    expect(tarjetas().map(t => t.dataset.reclamoId)).toEqual(['C-1']);
    await tocar('[data-filtro="todos"]');
    expect(tarjetas()).toHaveLength(3);
  });

  it('una foto se abre en grande', async () => {
    preparar();
    await montar();
    await tocar('[data-act="foto"]');
    expect(document.querySelector('.tienda-foto-zoom img').getAttribute('src')).toBe(RECLAMO.fotos[0].url);
  });

  it('el WhatsApp del cliente va con el reclamo y el código', async () => {
    preparar();
    await montar();
    const enlace = tarjetas()[0].querySelector('a[href^="https://wa.me/"]');
    const href = decodeURIComponent(enlace.getAttribute('href'));
    expect(href).toContain('wa.me/5493515550001');
    expect(href).toContain('reclamo');
    expect(href).toContain('K7M2');
  });

  it('sin reclamos lo dice', async () => {
    preparar([]);
    await montar();
    expect(contenedor.textContent).toMatch(/No hay reclamos/);
  });

  it('si no se pueden leer (reglas sin publicar, sin red) lo dice en vez de quedar cargando', async () => {
    datos.errorEscucha = Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
    await montar();
    expect(contenedor.textContent).toMatch(/No se pudieron cargar los reclamos/);
    expect(contenedor.textContent).toMatch(/faltan publicar las reglas/);
  });

  it('al irse de la pantalla se corta la escucha', async () => {
    preparar();
    await montar();
    expect(typeof window.__limpiarPagina).toBe('function');
    window.__limpiarPagina();
    expect(datos.escuchas.filter(e => e.nombre === 'tienda_reclamos').every(e => !e.activa)).toBe(true);
  });
});

describe('mover un reclamo', () => {
  const reclamoEnBase = () => datos.base[`tienda_reclamos/${RECLAMO.id}`];
  const pedidoEnBase = () => datos.base[`tienda_pedidos/${RECLAMO.pedido_id}`];

  it('"Lo estoy revisando" lo marca en el reclamo y en el pedido, y le avisa al cliente', async () => {
    preparar();
    await montar();
    await tocar('[data-act="revisando"]');
    expect(reclamoEnBase().estado).toBe('revisando');
    expect(pedidoEnBase().reclamo.estado).toBe('revisando');
    expect(avisos()).toEqual([{ id: RECLAMO.pedido_id }]);
  });

  it('resolver pide la respuesta, la guarda en los dos lados y avisa', async () => {
    preparar();
    await montar();
    await tocar('[data-act="resolver"]');
    const campo = document.querySelector('[data-respuesta]');
    expect(campo).toBeTruthy();
    campo.value = 'Te mandamos las dos cartulinas mañana, sin cargo.';
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    await tocar('[data-act="guardar"]');

    expect(reclamoEnBase()).toMatchObject({ estado: 'resuelto', respuesta: 'Te mandamos las dos cartulinas mañana, sin cargo.' });
    expect(pedidoEnBase().reclamo).toMatchObject({ estado: 'resuelto', respuesta: 'Te mandamos las dos cartulinas mañana, sin cargo.' });
    expect(avisos()).toEqual([{ id: RECLAMO.pedido_id }]);
  });

  it('rechazar sin explicar por qué no se guarda', async () => {
    preparar();
    await montar();
    await tocar('[data-act="rechazar"]');
    await tocar('[data-act="guardar"]');
    expect(reclamoEnBase().estado).toBe('nuevo');
    expect(document.querySelector('[data-error-respuesta]').textContent).toMatch(/por qué/);
    expect(avisos()).toEqual([]);
  });

  it('responder un reclamo viejo no pisa el resumen del más nuevo en el pedido', async () => {
    preparar();
    datos.base[`tienda_pedidos/${RECLAMO.pedido_id}`].reclamo = { id: `${RECLAMO.pedido_id}-2`, estado: 'nuevo', motivo: 'falta' };
    await montar();
    await tocar('[data-act="revisando"]');
    expect(reclamoEnBase().estado).toBe('revisando');
    expect(pedidoEnBase().reclamo).toMatchObject({ id: `${RECLAMO.pedido_id}-2`, estado: 'nuevo' });
  });

  it('reabrir uno cerrado lo vuelve a revisión y el cliente deja de ver la respuesta vieja', async () => {
    preparar([{ ...RECLAMO, estado: 'resuelto', respuesta: 'Ya está.' }]);
    datos.base[`tienda_pedidos/${RECLAMO.pedido_id}`].reclamo.respuesta = 'Ya está.';
    await montar();
    await tocar('[data-filtro="cerrados"]');
    await tocar('[data-act="reabrir"]');
    expect(reclamoEnBase().estado).toBe('revisando');
    expect(pedidoEnBase().reclamo).toMatchObject({ estado: 'revisando', respuesta: null });
  });

  it('si no se pudo guardar lo dice y no le avisa a nadie', async () => {
    preparar();
    datos.fallar = true;
    await montar();
    await tocar('[data-act="revisando"]');
    expect(alert).toHaveBeenCalled();
    expect(avisos()).toEqual([]);
  });

  it('lo que se está escribiendo no se borra si entra otro reclamo', async () => {
    preparar();
    await montar();
    await tocar('[data-act="resolver"]');
    const campo = document.querySelector('[data-respuesta]');
    campo.value = 'Te las cambiamos';
    campo.dispatchEvent(new Event('input', { bubbles: true }));

    datos.lista.push({ ...RECLAMO, __id: 'Z-1', id: 'Z-1', pedido_id: 'Z', pedido_codigo: 'ZZ99' });
    datos.escuchas.filter(e => e.nombre === 'tienda_reclamos' && e.activa).forEach(e => e.avisar());
    await respirar();

    expect(tarjetas()).toHaveLength(2);
    expect(document.querySelector('[data-respuesta]').value).toBe('Te las cambiamos');
  });
});

describe('el vigía de reclamos', () => {
  async function vigia() {
    const mod = await import('../../webapp/src/reclamos_watcher.js');
    const cuentas = [];
    mod.onReclamosCambian(lista => cuentas.push(lista.length));
    mod.initReclamosWatcher({});
    await respirar();
    return { mod, cuentas };
  }

  it('al abrir el panel resume los que esperan, sin un aviso por cada uno', async () => {
    preparar([RECLAMO, { ...RECLAMO, __id: 'B-1', id: 'B-1', pedido_id: 'B' }]);
    const { cuentas } = await vigia();
    expect(datos.toasts).toHaveLength(1);
    expect(datos.toasts[0].titulo).toMatch(/2 reclamos/);
    expect(cuentas.at(-1)).toBe(2);
  });

  it('uno que entra después avisa con el cliente y lleva a la bandeja', async () => {
    preparar([]);
    const { cuentas } = await vigia();
    expect(datos.toasts).toHaveLength(0);

    datos.lista = [{ ...RECLAMO }];
    datos.escuchas.filter(e => e.nombre === 'tienda_reclamos').forEach(e => e.avisar());
    await respirar();

    expect(datos.toasts).toHaveLength(1);
    const toast = datos.toasts[0];
    expect(toast.titulo).toContain('Marta Gómez');
    expect(toast.titulo).toContain('K7M2');
    toast.onAccion('ver', { cerrar() {} });
    expect(window.navigateToPage).toHaveBeenCalledWith('tienda_reclamos');
    expect(cuentas.at(-1)).toBe(1);
  });

  it('los que ya se están revisando no cuentan como esperando', async () => {
    preparar([{ ...RECLAMO, estado: 'revisando' }]);
    const { cuentas } = await vigia();
    expect(cuentas.at(-1)).toBe(0);
    expect(datos.toasts).toHaveLength(0);
  });

  it('sin permiso para leerlos no rompe nada', async () => {
    datos.errorEscucha = Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
    const { cuentas } = await vigia();
    expect(datos.toasts).toHaveLength(0);
    expect(cuentas.at(-1)).toBe(0);
  });
});
