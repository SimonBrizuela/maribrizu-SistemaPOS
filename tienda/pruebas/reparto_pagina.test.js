// @vitest-environment jsdom
/**
 * La pantalla del repartidor, abriéndola.
 *
 * Firebase, el GPS y la imagen del mapa entran de afuera: acá se prueba lo que
 * la pantalla decide con eso. Que recomiende el pedido más cercano a donde está,
 * que los botones hagan lo que dicen, que lo de la base aparezca solo y que un
 * link vencido o un error se expliquen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { iniciarReparto } from '../src/reparto/app.js';

const LOCAL = { lat: -31.354, lng: -64.173 };
const CLAVE = 'k'.repeat(40);

const pedido = (id, extra = {}) => ({
  id, codigo: id.toUpperCase().slice(0, 4), estado: 'listo', creado: '2026-09-15T15:00:00Z', total: 5000,
  cliente: { nombre: `Cliente ${id}`, telefono: '3515550001' },
  entrega: { modo: 'delivery', direccion: `Calle ${id} 100`, referencia: 'timbre B', coordenadas: { lat: -31.40, lng: -64.20 } },
  pago: { modo: 'efectivo', pagado: false },
  items: [{ id: 'p1', nombre: 'Resma A4', cantidad: 2 }],
  ...extra,
});

let mundo;

function dependencias() {
  mundo = {
    clave: CLAVE,
    abrir: { ok: true },
    escucha: null,
    movidos: [],
    respuestaMover: { ok: true },
    posicion: null,
    permiso: 'granted',
    mapas: [],
    cerrada: 0,
  };
  return {
    sesion: {
      tomarClave: () => mundo.clave,
      olvidarClave: () => { mundo.clave = null; },
      abrir: vi.fn(async () => {
        if (!mundo.abrir.ok) return mundo.abrir;
        return {
          ok: true,
          config: { origen: LOCAL, whatsapp: '5493517046684' },
          escuchar: (alCambiar) => { const mio = mundo; mio.escucha = alCambiar; return () => { mio.cerrada++; }; },
        };
      }),
    },
    mover: vi.fn(async (clave, id, estado, extra = {}) => {
      mundo.movidos.push({ clave, id, estado, ...extra });
      return mundo.respuestaMover;
    }),
    ubicacion: {
      permiso: async () => mundo.permiso,
      seguir: (alMover) => {
        mundo.alMover = alMover;
        if (mundo.posicion) alMover(mundo.posicion);
        return () => {};
      },
    },
    mapa: (contenedor) => {
      const m = { contenedor, opciones: null, actualizar(o) { this.opciones = o; }, soltar() {} };
      mundo.mapas.push(m);
      return m;
    },
    achicar: async () => ({ tipo: 'image/jpeg', datos: 'base64foto', bytes: 900, blob: new Blob(['x']) }),
  };
}

const respirar = async () => { for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 0)); };
let raiz;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function abrir(deps = dependencias()) {
  raiz = document.createElement('div');
  document.body.appendChild(raiz);
  await iniciarReparto(raiz, deps);
  await respirar();
  return deps;
}

function llegan({ enCurso = [], entregadosHoy = [] } = {}) {
  mundo.escucha({ enCurso, entregadosHoy });
}

beforeEach(() => {
  document.body.innerHTML = '';
  URL.createObjectURL = vi.fn(() => 'blob:vista');
  URL.revokeObjectURL = vi.fn();
});

describe('entrar', () => {
  it('sin el link en este celular explica que lo pida al local', async () => {
    const deps = dependencias();
    mundo.clave = null;
    await abrir(deps);
    expect(raiz.textContent).toMatch(/link del repartidor/i);
    expect(deps.sesion.abrir).not.toHaveBeenCalled();
  });

  it('con un link que ya no sirve lo dice y lo olvida', async () => {
    const deps = dependencias();
    mundo.abrir = { ok: false, motivo: 'link' };
    await abrir(deps);
    expect(raiz.textContent).toMatch(/ya no sirve/i);
    expect(mundo.clave).toBeNull();
  });

  it('sin conexión ofrece reintentar, y reintentar vuelve a probar', async () => {
    const deps = dependencias();
    mundo.abrir = { ok: false, motivo: 'red' };
    await abrir(deps);
    expect(raiz.textContent).toMatch(/No pudimos conectar/);
    mundo.abrir = { ok: true };
    $('[data-reintentar]').click();
    await respirar();
    expect(deps.sesion.abrir).toHaveBeenCalledTimes(2);
    expect($('[data-reintentar]')).toBeNull();
  });

  it('sin pedidos lo dice tranquilo', async () => {
    await abrir();
    llegan();
    await respirar();
    expect(raiz.textContent).toMatch(/No hay pedidos para llevar/);
  });
});

describe('la recomendación', () => {
  const cerca = pedido('cerca', { entrega: { modo: 'delivery', direccion: 'Cerca 1', referencia: 'timbre B', coordenadas: { lat: -31.356, lng: -64.175 } } });
  const lejos = pedido('lejos', { entrega: { modo: 'delivery', direccion: 'Lejos 9', coordenadas: { lat: -31.45, lng: -64.30 } } });

  it('la próxima parada es la que le queda más cerca a donde está', async () => {
    mundo = null;
    const deps = dependencias();
    mundo.posicion = { lat: -31.357, lng: -64.176 };
    await abrir(deps);
    llegan({ enCurso: [lejos, cerca] });
    await respirar();
    const proxima = $('[data-proxima]');
    expect(proxima.textContent).toContain('Cliente cerca');
    expect(proxima.textContent).toMatch(/\d+ m|km/);
    // Las paradas numeradas en ese orden.
    expect($$('[data-parada]').map(n => n.dataset.parada)).toEqual(['cerca', 'lejos']);
  });

  it('si se mueve y ahora le queda más cerca otro, cambia la recomendación', async () => {
    const deps = dependencias();
    mundo.posicion = { lat: -31.357, lng: -64.176 };
    await abrir(deps);
    llegan({ enCurso: [lejos, cerca] });
    await respirar();
    mundo.alMover({ lat: -31.449, lng: -64.299 });
    await respirar();
    expect($('[data-proxima]').textContent).toContain('Cliente lejos');
  });

  it('sin ubicación ofrece activarla y arranca desde el local', async () => {
    const deps = dependencias();
    mundo.permiso = 'prompt';
    await abrir(deps);
    llegan({ enCurso: [
      pedido('segundo', { creado: '2026-09-15T16:00:00Z' }),
      pedido('primero', { creado: '2026-09-15T14:00:00Z', entrega: { modo: 'delivery', direccion: 'X', coordenadas: { lat: -31.5, lng: -64.3 } } }),
    ] });
    await respirar();
    expect($('[data-activar-ubicacion]')).toBeTruthy();
    // "segundo" queda a unos 6 km del local y "primero" a más de 15: sin saber
    // dónde está el repartidor, el recorrido sale del local.
    expect($('[data-proxima]').textContent).toContain('Cliente segundo');
    expect($('[data-proxima]').textContent).toContain('Próxima parada');
  });

  it('navegar abre Google Maps con el viaje desde donde está; y hay ruta con todos', async () => {
    const deps = dependencias();
    mundo.posicion = { lat: -31.357, lng: -64.176 };
    await abrir(deps);
    llegan({ enCurso: [lejos, cerca] });
    await respirar();
    const navegar = new URL($('[data-proxima] a[data-navegar]').href);
    expect(navegar.hostname).toBe('www.google.com');
    expect(navegar.searchParams.get('destination')).toBe('-31.356,-64.175');
    expect($('[data-proxima] a[data-navegar]').target).toBe('_blank');
    const ruta = new URL($('a[data-ruta]').href);
    expect(ruta.searchParams.get('waypoints')).toBe('-31.356,-64.175');
    expect(ruta.searchParams.get('destination')).toBe('-31.45,-64.3');
  });

  it('llamar y WhatsApp al cliente, y cuánto cobrar', async () => {
    const deps = dependencias();
    await abrir(deps);
    llegan({ enCurso: [cerca] });
    await respirar();
    const p = $('[data-proxima]');
    expect(p.querySelector('a[href^="tel:"]').getAttribute('href')).toBe('tel:3515550001');
    expect(p.querySelector('a[href^="https://wa.me/"]').getAttribute('href')).toContain('wa.me/5493515550001');
    expect(p.textContent).toContain('Cobrar $5.000 en efectivo');
    expect(p.textContent).toContain('timbre B');
  });

  it('el mapa recibe el local, dónde está y las paradas en orden', async () => {
    const deps = dependencias();
    mundo.posicion = { lat: -31.357, lng: -64.176 };
    await abrir(deps);
    llegan({ enCurso: [lejos, cerca] });
    await respirar();
    const m = mundo.mapas.at(-1);
    expect(m.opciones.local).toEqual(LOCAL);
    expect(m.opciones.yo).toEqual({ lat: -31.357, lng: -64.176 });
    expect(m.opciones.paradas.map(p => p.id)).toEqual(['cerca', 'lejos']);
  });
});

describe('las listas', () => {
  it('separa lo que hay que llevar de lo que se está preparando, y resume el día', async () => {
    await abrir();
    llegan({
      enCurso: [pedido('a'), pedido('b', { estado: 'en_camino' }), pedido('c', { estado: 'nuevo' }), pedido('d', { estado: 'preparando' })],
      entregadosHoy: [
        pedido('e', { estado: 'entregado', total: 3000, pago: { modo: 'efectivo', pagado: true } }),
        pedido('f', { estado: 'entregado', total: 9000, pago: { modo: 'transferencia', pagado: true } }),
      ],
    });
    await respirar();
    expect($$('[data-parada]').map(n => n.dataset.parada).sort()).toEqual(['a', 'b']);
    expect($$('[data-preparando]').map(n => n.dataset.preparando).sort()).toEqual(['c', 'd']);
    expect($('[data-resumen]').textContent).toMatch(/2\s*entregados/);
    expect($('[data-resumen]').textContent).toContain('$3.000');
  });

  it('lo que llega de la base aparece solo, y un pedido abierto sigue abierto', async () => {
    await abrir();
    llegan({ enCurso: [pedido('a'), pedido('b')] });
    await respirar();
    $('[data-parada="b"] [data-abrir]').click();
    expect($('[data-parada="b"]').classList.contains('parada--abierta')).toBe(true);

    llegan({ enCurso: [pedido('a'), pedido('b'), pedido('z')] });
    await respirar();
    expect($$('[data-parada]')).toHaveLength(3);
    expect($('[data-parada="b"]').classList.contains('parada--abierta')).toBe(true);
    expect($('[data-parada="b"]').textContent).toContain('Resma A4');
  });

  it('al irse se cortan las escuchas', async () => {
    const deps = dependencias();
    await abrir(deps);
    window.dispatchEvent(new Event('pagehide'));
    expect(mundo.cerrada).toBe(1);
  });
});

describe('los botones', () => {
  it('"Salgo a entregarlo" mueve el pedido con la clave del link', async () => {
    const deps = dependencias();
    await abrir(deps);
    llegan({ enCurso: [pedido('a')] });
    await respirar();
    $('[data-proxima] [data-mover]').click();
    await respirar();
    expect(mundo.movidos).toEqual([{ clave: CLAVE, id: 'a', estado: 'en_camino' }]);
  });

  it('en preparación: "Empezar a preparar" y "Está listo"', async () => {
    await abrir();
    llegan({ enCurso: [pedido('c', { estado: 'nuevo' })] });
    await respirar();
    const boton = $('[data-preparando="c"] [data-mover]');
    expect(boton.textContent).toMatch(/Empezar a preparar/);
    boton.click();
    await respirar();
    expect(mundo.movidos[0]).toMatchObject({ id: 'c', estado: 'preparando' });
  });

  it('mientras manda el botón queda apagado y no manda dos veces', async () => {
    const deps = dependencias();
    let soltar;
    deps.mover.mockImplementationOnce((clave, id, estado) => new Promise(r => {
      mundo.movidos.push({ id, estado });
      soltar = () => r({ ok: true });
    }));
    await abrir(deps);
    llegan({ enCurso: [pedido('a')] });
    await respirar();
    $('[data-proxima] [data-mover]').click();
    await respirar();
    expect($('[data-proxima] [data-mover]').disabled).toBe(true);
    $('[data-proxima] [data-mover]').click();
    await respirar();
    expect(mundo.movidos).toHaveLength(1);
    soltar();
    await respirar();
    expect($('[data-proxima] [data-mover]').disabled).toBe(false);
  });

  it('si el local lo cambió en el medio lo avisa', async () => {
    await abrir();
    mundo.respuestaMover = { ok: false, error: 'cambio' };
    llegan({ enCurso: [pedido('a')] });
    await respirar();
    $('[data-proxima] [data-mover]').click();
    await respirar();
    expect(document.body.textContent).toMatch(/el local cambió este pedido/i);
  });

  it('si el link venció mientras trabajaba, lo dice', async () => {
    await abrir();
    mundo.respuestaMover = { ok: false, error: 'link' };
    llegan({ enCurso: [pedido('a')] });
    await respirar();
    $('[data-proxima] [data-mover]').click();
    await respirar();
    expect(raiz.textContent).toMatch(/ya no sirve/i);
  });
});

describe('entregar', () => {
  async function hastaLaHoja(extra = {}) {
    const deps = dependencias();
    await abrir(deps);
    llegan({ enCurso: [pedido('a', { estado: 'en_camino', ...extra })] });
    await respirar();
    $('[data-proxima] [data-mover]').click();
    await respirar();
    return deps;
  }

  it('"Lo entregué" abre la confirmación en vez de mandar directo', async () => {
    await hastaLaHoja();
    expect($('[data-hoja-entrega]')).toBeTruthy();
    expect(mundo.movidos).toEqual([]);
  });

  it('en efectivo pregunta si cobró antes de dejar confirmar', async () => {
    await hastaLaHoja();
    expect($('[data-confirmar-entrega]').disabled).toBe(true);
    $('[data-cobrado="si"]').click();
    expect($('[data-confirmar-entrega]').disabled).toBe(false);
    $('[data-confirmar-entrega]').click();
    await respirar();
    expect(mundo.movidos).toEqual([{ clave: CLAVE, id: 'a', estado: 'entregado', cobrado: true, foto: null }]);
    expect($('[data-hoja-entrega]')).toBeNull();
  });

  it('con la foto de la entrega', async () => {
    await hastaLaHoja({ pago: { modo: 'transferencia', pagado: true } });
    // Pagado por transferencia: no hay nada que preguntar.
    expect($('[data-cobrado="si"]')).toBeNull();
    const input = $('[data-foto-entrega]');
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'puerta.jpg', { type: 'image/jpeg' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await respirar();
    expect($('[data-hoja-entrega] img').getAttribute('src')).toBe('blob:vista');
    $('[data-confirmar-entrega]').click();
    await respirar();
    expect(mundo.movidos[0]).toMatchObject({ estado: 'entregado', cobrado: null, foto: { tipo: 'image/jpeg', datos: 'base64foto' } });
  });

  it('si no se pudo, la hoja queda abierta con el motivo', async () => {
    const deps = await hastaLaHoja({ pago: { modo: 'transferencia', pagado: true } });
    mundo.respuestaMover = { ok: false, error: 'red' };
    $('[data-confirmar-entrega]').click();
    await respirar();
    expect($('[data-hoja-entrega]')).toBeTruthy();
    expect($('[data-hoja-entrega]').textContent).toMatch(/No se pudo/);
    expect(deps.mover).toHaveBeenCalledTimes(1);
  });
});
