// @vitest-environment jsdom
/**
 * El timbre de los pedidos de la tienda.
 *
 * Un pedido que entra por la web no lo ve nadie hasta que alguien se acuerda de
 * mirar. Este módulo lo avisa solo, en el momento, con tres capas: sonido
 * (lo único que funciona con la pestaña de fondo), un toast que queda hasta que
 * lo cierran, y la notificación del navegador.
 *
 * La regla que más importa: **la primera carga no avisa uno por uno**. Si había
 * cuatro pedidos sin ver, cuatro sonidos seguidos al abrir la página son ruido
 * y la persona los apaga. Sale un solo resumen, y desde ahí sí, cada pedido
 * nuevo avisa solo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { estado } = vi.hoisted(() => ({
  estado: { emitir: null, escrituras: [] },
}));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  return {
    ...firestoreFalso({ registro: estado.escrituras }),
    onSnapshot: (_q, cb) => {
      // Se guarda el callback para poder disparar snapshots a mano.
      estado.emitir = (pedidos) => cb({
        docs: pedidos.map(p => ({ id: p.id, data: () => p })),
      });
      return () => { estado.emitir = null; };
    },
    updateDoc: async (ref, datos) => { estado.escrituras.push({ ref, datos }); },
  };
});
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {} }));

const {
  initPedidosWatcher, detenerPedidosWatcher, pedidosPendientes,
  onPedidosCambian, sonidoActivo, setSonido, marcarVisto,
} = await import('../../webapp/src/pedidos_watcher.js');

const pedido = (id, extra = {}) => ({
  id, codigo: id.toUpperCase(), estado: 'nuevo', visto: false,
  cliente: { nombre: 'Marta' }, total: 1000, entrega: { modo: 'retiro' }, ...extra,
});

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  estado.escrituras.length = 0;
  detenerPedidosWatcher();
  // El sonido usa AudioContext, que jsdom no tiene.
  window.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0;
                    this.destination = {}; }
    resume() {}
    createOscillator() { return { connect() {}, start() {}, stop() {},
                                  frequency: { value: 0 }, type: '' }; }
    createGain() { return { connect() {}, gain: { value: 0,
      setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } }; }
  };
  // Y las notificaciones del navegador tampoco.
  window.Notification = class { constructor() {} close() {} static permission = 'denied'; };
});

afterEach(() => { detenerPedidosWatcher(); });

describe('el sonido se puede apagar', () => {
  it('viene prendido', () => {
    expect(sonidoActivo()).toBe(true);
  });

  it('apagarlo se recuerda; prenderlo lo vuelve al default', () => {
    setSonido(false);
    expect(sonidoActivo()).toBe(false);
    setSonido(true);
    expect(sonidoActivo()).toBe(true);
  });
});

describe('qué cuenta como pendiente', () => {
  it('los que nadie vio', () => {
    initPedidosWatcher({});
    estado.emitir([pedido('a'), pedido('b')]);
    expect(pedidosPendientes().map(p => p.id)).toEqual(['a', 'b']);
  });

  it('uno ya visto no molesta más', () => {
    initPedidosWatcher({});
    estado.emitir([pedido('a', { visto: true }), pedido('b')]);
    expect(pedidosPendientes().map(p => p.id)).toEqual(['b']);
  });

  it('un pedido cancelado tampoco', () => {
    initPedidosWatcher({});
    estado.emitir([pedido('a', { estado: 'cancelado' }), pedido('b')]);
    expect(pedidosPendientes().map(p => p.id)).toEqual(['b']);
  });
});

describe('la primera carga no avisa de a uno', () => {
  it('cuatro pedidos viejos son UN resumen, no cuatro avisos', () => {
    initPedidosWatcher({});
    estado.emitir([pedido('a'), pedido('b'), pedido('c'), pedido('d')]);
    // Los avisos viven en una sola pila compartida con los de stock.
    const avisos = document.querySelectorAll('#llToastStack > .ll-toast');
    expect(avisos.length).toBeLessThanOrEqual(1);
    expect(document.body.textContent).toMatch(/4/);
  });

  it('sin pedidos pendientes no aparece nada', () => {
    initPedidosWatcher({});
    estado.emitir([]);
    expect(document.body.textContent.trim()).toBe('');
  });
});

describe('después de la primera carga, cada pedido nuevo avisa', () => {
  it('el que llega después sí saca su aviso', () => {
    initPedidosWatcher({});
    estado.emitir([pedido('a')]);          // línea de base
    document.body.innerHTML = '';
    estado.emitir([pedido('b'), pedido('a')]);
    expect(document.body.textContent).toContain('Marta');
  });

  it('el mismo pedido no avisa dos veces', () => {
    // El listener re-emite el snapshot cada vez que algo cambia: sin recordar
    // a quién ya se avisó, sonaría en cada cambio ajeno.
    initPedidosWatcher({});
    estado.emitir([pedido('a')]);
    estado.emitir([pedido('b'), pedido('a')]);
    document.body.innerHTML = '';
    estado.emitir([pedido('b'), pedido('a')]);
    expect(document.body.textContent.trim()).toBe('');
  });
});

describe('avisar a la pantalla', () => {
  it('quien se suscribe recibe el estado actual al toque', () => {
    initPedidosWatcher({});
    estado.emitir([pedido('a')]);
    let visto = null;
    const soltar = onPedidosCambian(p => { visto = p; });
    expect(visto.map(p => p.id)).toEqual(['a']);
    soltar();
  });

  it('y los cambios que vengan después', () => {
    initPedidosWatcher({});
    const recibidos = [];
    const soltar = onPedidosCambian(p => recibidos.push(p.length));
    estado.emitir([pedido('a')]);
    estado.emitir([pedido('a'), pedido('b')]);
    soltar();
    estado.emitir([]);
    expect(recibidos).toEqual([0, 1, 2]);
  });
});

describe('marcar como visto', () => {
  it('escribe la marca en el pedido', async () => {
    initPedidosWatcher({});
    await marcarVisto('k1');
    expect(estado.escrituras.at(-1).datos).toEqual({ visto: true });
  });
});

describe('parar la escucha', () => {
  it('deja de recibir y se puede volver a arrancar', () => {
    initPedidosWatcher({});
    estado.emitir([pedido('a')]);
    detenerPedidosWatcher();
    expect(estado.emitir).toBeNull();

    initPedidosWatcher({});
    expect(estado.emitir).toBeTypeOf('function');
  });

  it('el badge no se queda con los pedidos del que salió', () => {
    // Es el estado tras cerrar sesión: ya no hay nadie escuchando la
    // colección, así que el número no puede seguir ahí como si fuera de ahora.
    initPedidosWatcher({});
    estado.emitir([pedido('a'), pedido('b')]);
    expect(pedidosPendientes().length).toBe(2);

    const recibidos = [];
    const soltar = onPedidosCambian(p => recibidos.push(p.length));
    detenerPedidosWatcher();

    expect(pedidosPendientes()).toEqual([]);
    expect(recibidos.at(-1)).toBe(0);   // y se avisó
    soltar();
  });
});
