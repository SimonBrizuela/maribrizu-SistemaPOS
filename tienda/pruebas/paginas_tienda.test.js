// @vitest-environment jsdom
/**
 * Las pantallas de la tienda, abriéndolas: la portada, el catálogo, la ficha de
 * un producto, el seguimiento de un pedido y la cuenta.
 *
 * Es el equivalente de `paginas_panel.test.js` para el lado del cliente. Cada
 * una se monta dos veces: con la tienda cargada de productos y con la tienda
 * vacía, que es como arranca una instalación nueva y como queda cuando una
 * consulta no devuelve nada. Ninguna puede romperse ahí ni mostrar un hueco.
 *
 * Además se prueba lo que cada una tiene que decir: la portada muestra
 * destacados, el catálogo filtra por rubro y busca, y el seguimiento encuentra
 * un pedido por su código.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { datos } = vi.hoisted(() => ({
  // `paginar`: traerProductos devuelve de a `cantidad`, con cursor, como la base.
  // `tandas` cuenta los pedidos y `fallarTanda` hace fallar el próximo con cursor.
  datos: { productos: [], rubros: [], config: null, avisos: [], pedidos: {}, vacio: false,
           paginar: false, tandas: [], fallarTanda: false,
           // Los avisos al celular: qué soporta el navegador y qué contesta activarlos.
           avisos: { soporte: 'ok', permiso: 'default', activos: [], resultado: 'activos', llamadas: [] },
           // Cada vez que la pantalla abre la hoja del reclamo.
           hojas: [] },
}));

vi.mock('firebase/firestore', async () =>
  (await import('./firestore_falso.js')).firestoreFalso());
vi.mock('../src/firebase.js', () => ({ db: {}, app: {} }));

vi.mock('../src/datos.js', async (original) => {
  const real = await original();
  const lista = () => (datos.vacio ? [] : datos.productos);
  return {
    ...real,
    cargarConfig: async () => datos.config,
    cargarAvisos: async () => datos.avisos,
    cargarRubros: async () => (datos.vacio ? [] : datos.rubros),
    subrubrosDe: async () => [],
    traerProductos: async ({ rubro = null, cursor = null, cantidad = 24, desde = 0 } = {}) => {
      datos.tandas.push({ rubro, cursor, cantidad, desde });
      const todos = lista().filter(p => !rubro || p.rubro === rubro);
      if (!datos.paginar) return { productos: todos, cursor: null };
      if (cursor && datos.fallarTanda) { datos.fallarTanda = false; throw new Error('sin red'); }
      const inicio = cursor ? Number(cursor[0]) : 0;
      const hayMas = inicio + cantidad < todos.length;
      return {
        productos: todos.slice(inicio, inicio + cantidad),
        cursor: hayMas ? [inicio + cantidad, 'id'] : null,
        hayMas,
      };
    },
    traerDestacados: async () => lista().slice(0, 4),
    traerMuestra: async () => lista().slice(0, 4),
    traerProducto: async (id) => lista().find(p => p.id === id) || null,
    traerGrupo: async () => [],
    buscar: async (texto) => {
      const q = String(texto || '').toLowerCase();
      return lista().filter(p => p.nombre.toLowerCase().includes(q));
    },
    sugerir: async () => [],
  };
});
vi.mock('../src/pedidos.js', async (original) => {
  const real = await original();
  return {
    ...real,
    traerPedido: async (id) => datos.pedidos[id] || null,
    seguirPedido: (id, alCambiar) => { alCambiar(datos.pedidos[id] || null); return () => {}; },
    pedidosDeLaCuenta: async () => [],
  };
});
vi.mock('../src/cuenta.js', () => ({
  iniciarCuenta: async () => null,
  sesion: () => null,
  alCambiarSesion: () => () => {},
  crearCuenta: async () => ({}),
  entrar: async () => ({}),
  entrarConGoogle: async () => ({}),
  recuperarClave: async () => {},
  salir: async () => {},
  guardarPerfil: async () => {},
  datosParaCompletar: () => null,
  recordarDelPedido: async () => {},
}));
vi.mock('../src/mapa.js', () => ({ montarMapa: () => {} }));
vi.mock('../src/avisos_push.js', () => ({
  soporteDeAvisos: () => datos.avisos.soporte,
  permisoDado: () => datos.avisos.permiso === 'granted',
  avisosActivos: (id) => datos.avisos.activos.includes(id),
  activarAvisos: async (id, opciones = {}) => {
    datos.avisos.llamadas.push({ id, preguntar: opciones.preguntar !== false });
    if (datos.avisos.resultado === 'activos') datos.avisos.activos.push(id);
    return datos.avisos.resultado;
  },
}));
vi.mock('../src/direcciones.js', () => ({ montarDirecciones: () => {} }));
// La hoja del reclamo tiene sus propias pruebas: acá importa que la pantalla la
// abra con el pedido y reaccione cuando se manda.
vi.mock('../src/hoja_reclamo.js', () => ({
  abrirHojaReclamo: (pedido, opciones) => { datos.hojas.push({ pedido, opciones }); },
}));

const CONFIG = {
  abierta: true,
  entrega: { retiro_habilitado: true, delivery_habilitado: true, pedido_minimo: 6500,
             demora_texto: 'Listo en 2 horas' },
  pago: { efectivo_habilitado: true, transferencia_habilitada: true, alias: 'liceo.libreria' },
  horarios: { lun: [['09:00', '20:30']], mar: [['09:00', '20:30']], mie: [['09:00', '20:30']],
              jue: [['09:00', '20:30']], vie: [['09:00', '20:30']], sab: [['09:00', '13:00']],
              dom: [] },
};

const PRODUCTOS = [
  { id: 'p1', nombre: 'Cuaderno Rivadavia 48 hojas', precio: 3500, stock: 12,
    rubro: 'LIBRERIA', categoria: 'Cuadernos', marca: 'RIVADAVIA', imagenes: ['a.webp'] },
  { id: 'p2', nombre: 'Lápiz Faber HB', precio: 900, stock: 60,
    rubro: 'LIBRERIA', categoria: 'Escritura', marca: 'FABER', imagenes: ['b.webp'] },
  { id: 'p3', nombre: 'Resma Pampa A4', precio: 18000, stock: 4,
    rubro: 'PAPELERIA', categoria: 'Resmas', marca: 'PAMPA', imagenes: ['c.webp'] },
];

const CARGAR = {
  inicio: () => import('../src/paginas/inicio.js'),
  catalogo: () => import('../src/paginas/catalogo.js'),
  producto: () => import('../src/paginas/producto.js'),
  seguimiento: () => import('../src/paginas/seguimiento.js'),
  cuenta: () => import('../src/paginas/cuenta.js'),
  pedido: () => import('../src/paginas/pedido.js'),
};

let raiz;

/** Monta una pantalla de la tienda y espera a que termine de completarse. */
async function abrir(clave, { params = {}, query = new URLSearchParams() } = {}) {
  const mod = await CARGAR[clave]();
  raiz = document.createElement('div');
  raiz.id = 'app';
  document.body.appendChild(raiz);
  await mod[clave]({ montar: (html) => { raiz.innerHTML = html; }, params, query });
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
  return raiz;
}

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));
const plano = () => document.body.textContent.replace(/\./g, '');

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  datos.productos = PRODUCTOS.map(p => ({ ...p }));
  datos.rubros = [{ nombre: 'LIBRERIA', cantidad: 2 }, { nombre: 'PAPELERIA', cantidad: 1 }];
  datos.config = JSON.parse(JSON.stringify(CONFIG));
  datos.avisos = [];
  datos.pedidos = {};
  datos.vacio = false;
  datos.paginar = false;
  datos.avisos = { soporte: 'ok', permiso: 'default', activos: [], resultado: 'activos', llamadas: [] };
  datos.hojas = [];
  datos.tandas = [];
  datos.fallarTanda = false;
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) }));
  window.history.replaceState({}, '', '/');
  globalThis.IntersectionObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
  Element.prototype.scrollIntoView = () => {};
});

describe('las pantallas de la tienda, con productos', () => {
  for (const [clave, params] of [
    ['inicio', {}], ['catalogo', {}], ['producto', { id: 'p1' }],
    ['seguimiento', {}], ['cuenta', {}],
  ]) {
    it(clave, async () => {
      const c = await abrir(clave, { params });
      expect(c.innerHTML.length, 'no pintó nada').toBeGreaterThan(0);
      const t = plano();
      expect(t, clave).not.toContain('NaN');
      expect(t, clave).not.toContain('undefined');
      expect(t, clave).not.toContain('[object Object]');
    });
  }
});

describe('las pantallas de la tienda, sin nada cargado', () => {
  // Es el arranque de una instalación nueva y el estado al que se cae cuando
  // una consulta devuelve vacío.
  for (const [clave, params] of [
    ['inicio', {}], ['catalogo', {}], ['producto', { id: 'no-existe' }],
    ['seguimiento', {}], ['cuenta', {}],
  ]) {
    it(clave, async () => {
      datos.vacio = true;
      const c = await abrir(clave, { params });
      expect(c.innerHTML.length, 'no pintó nada').toBeGreaterThan(0);
      const t = plano();
      expect(t, clave).not.toContain('NaN');
      expect(t, clave).not.toContain('undefined');
    });
  }
});

describe('la portada', () => {
  it('muestra productos y precios', async () => {
    const c = await abrir('inicio');
    const t = plano();
    expect(c.textContent).toContain('Cuaderno Rivadavia');
    expect(t).toContain('3500');
  });

  it('muestra los horarios del local', async () => {
    // El cartel de "cerrado" lo pone el encabezado, no la portada: acá lo que
    // tiene que estar es cuándo se puede ir.
    const c = await abrir('inicio');
    expect(c.textContent.toLowerCase()).toMatch(/horario|lunes|20:30|9 a/);
  });
});

describe('el catálogo', () => {
  it('lista todo cuando no se filtra nada', async () => {
    const c = await abrir('catalogo');
    const t = c.textContent;
    expect(t).toContain('Cuaderno Rivadavia');
    expect(t).toContain('Resma Pampa');
  });

  it('filtrado por rubro muestra sólo ese rubro', async () => {
    const c = await abrir('catalogo', { params: { rubro: 'PAPELERIA' } });
    const t = c.textContent;
    expect(t).toContain('Resma Pampa');
    expect(t).not.toContain('Cuaderno Rivadavia');
  });

  it('una búsqueda por la dirección muestra lo que coincide', async () => {
    const c = await abrir('catalogo', { query: new URLSearchParams('q=resma') });
    const t = c.textContent;
    expect(t).toContain('Resma Pampa');
    expect(t).not.toContain('Lápiz Faber');
  });

  it('una búsqueda sin resultados lo dice, no deja la pantalla en blanco', async () => {
    const c = await abrir('catalogo', { query: new URLSearchParams('q=zzzzz') });
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(c.textContent.toLowerCase()).toMatch(/no encontr|sin resultado|nada/);
  });
});

describe('el catálogo carga solo al bajar', () => {
  // Con 900 productos en Librería, apretar "Ver más" cada veinticuatro era la
  // forma de no llegar nunca a la Z. Ahora la tanda siguiente entra sola al
  // acercarse al final de la lista.
  let observadores;
  class ObservadorFalso {
    constructor(alCambiar, opciones) {
      Object.assign(this, { alCambiar, opciones, mirando: new Set(), desconectado: false });
      observadores.push(this);
    }
    observe(el) { this.mirando.add(el); }
    unobserve(el) { this.mirando.delete(el); }
    disconnect() { this.desconectado = true; this.mirando.clear(); }
    ver() { this.alCambiar([...this.mirando].map(target => ({ target, isIntersecting: true }))); }
  }
  const centinela = () => observadores.find(o => [...o.mirando].some(el => el.matches?.('[data-centinela]')));
  const cards = () => document.querySelectorAll('[data-lista] .card-producto').length;
  const respirar = async () => { for (let i = 0; i < 10; i++) await esperar(); };

  const muchos = Array.from({ length: 60 }, (_, i) => ({
    id: `c${i}`, nombre: `Cuaderno ${String(i).padStart(2, '0')}`, precio: 1000, stock: 5,
    rubro: 'LIBRERIA', categoria: 'Cuadernos', imagenes: ['c.webp'],
  }));

  beforeEach(() => {
    observadores = [];
    globalThis.IntersectionObserver = ObservadorFalso;
    datos.productos = muchos.map(p => ({ ...p }));
    datos.rubros = [{ clave: 'LIBRERIA', nombre: 'Librería', cantidad: 60 }];
    datos.paginar = true;
  });

  it('al acercarse al final entra la tanda siguiente, sin botón', async () => {
    await abrir('catalogo', { params: { rubro: 'LIBRERIA' } });
    expect(cards()).toBe(24);
    expect(document.querySelector('[data-cargar]')).toBeNull();

    centinela().ver();
    await respirar();
    expect(cards()).toBe(48);

    centinela().ver();
    await respirar();
    expect(cards()).toBe(60);
    // Ya no queda nada: nadie sigue mirando el final.
    expect(centinela()).toBeUndefined();
  });

  it('las tandas siguen el cursor de la base, sin repetir productos', async () => {
    await abrir('catalogo', { params: { rubro: 'LIBRERIA' } });
    centinela().ver();
    await respirar();
    const nombres = [...document.querySelectorAll('[data-lista] .card-producto')]
      .map(c => c.textContent.match(/Cuaderno \d+/)?.[0]);
    expect(new Set(nombres).size).toBe(nombres.length);
    expect(datos.tandas.map(t => t.cursor?.[0] ?? 0)).toEqual([0, 24]);
  });

  it('si falla la red lo dice y deja reintentar', async () => {
    await abrir('catalogo', { params: { rubro: 'LIBRERIA' } });
    datos.fallarTanda = true;
    centinela().ver();
    await respirar();

    const reintentar = document.querySelector('[data-reintentar]');
    expect(reintentar, 'falló en silencio').toBeTruthy();
    reintentar.click();
    await respirar();
    expect(cards()).toBe(48);
  });

  it('en un navegador sin IntersectionObserver queda el botón de siempre', async () => {
    delete globalThis.IntersectionObserver;
    await abrir('catalogo', { params: { rubro: 'LIBRERIA' } });
    const boton = document.querySelector('[data-cargar]');
    expect(boton).toBeTruthy();
    boton.click();
    await respirar();
    expect(cards()).toBe(48);
  });
});

describe('la ficha de un producto', () => {
  it('muestra nombre, precio y que hay stock', async () => {
    const c = await abrir('producto', { params: { id: 'p1' } });
    const t = plano();
    expect(c.textContent).toContain('Cuaderno Rivadavia');
    expect(t).toContain('3500');
  });

  it('un producto que no existe no deja la pantalla vacía', async () => {
    const c = await abrir('producto', { params: { id: 'no-existe' } });
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(c.textContent.toLowerCase()).toMatch(/no (lo )?encontr|no existe|no est/);
  });

  it('deja lo que Google necesita para mostrar el precio en el resultado', async () => {
    await abrir('producto', { params: { id: 'p1' } });
    expect(document.head.innerHTML).toContain('3500');
  });
});

describe('ampliar la foto de la ficha', () => {
  // En el celular la foto de la ficha es chica: una cartulina de 29 colores no
  // se distingue sin acercarse. Tocarla la abre a pantalla completa.
  const cartulina = {
    id: 'f1', nombre: 'Cartulina Luma Comun', precio: 600, stock: 30,
    rubro: 'LIBRERIA', categoria: 'Cartulina', marca: 'LUMA',
    imagenes: ['https://x/abanico.webp', 'https://x/rollos.webp'],
    variedades: [
      { nombre: 'Rojo', stock: 5, imagen: 'https://x/rojo.webp' },
      { nombre: 'Blanco', stock: 8 },
    ],
  };

  afterEach(async () => {
    const { cerrarVisorFotos } = await import('../src/visor_fotos.js');
    cerrarVisorFotos();
  });

  const cuenta = () => document.querySelector('.visor-fotos [data-visor-cuenta]')?.textContent.trim();
  const enGrande = () => document.querySelector('.visor-fotos [data-visor-imagen]')?.getAttribute('src');

  it('tocar la foto la abre a pantalla completa con todas las del producto', async () => {
    datos.productos = [cartulina];
    const c = await abrir('producto', { params: { id: 'f1' } });

    c.querySelector('[data-galeria-ampliar]').click();
    expect(document.querySelector('.visor-fotos')).not.toBeNull();
    expect(enGrande()).toBe('https://x/abanico.webp');
    expect(cuenta()).toBe('1 / 2');
  });

  it('abre en la miniatura que se estaba mirando', async () => {
    datos.productos = [cartulina];
    const c = await abrir('producto', { params: { id: 'f1' } });

    c.querySelector('[data-galeria-mini="https://x/rollos.webp"]').click();
    c.querySelector('[data-galeria-ampliar]').click();
    expect(enGrande()).toBe('https://x/rollos.webp');
    expect(cuenta()).toBe('2 / 2');
  });

  it('con un color elegido que tiene su foto, arranca en esa', async () => {
    datos.productos = [cartulina];
    const c = await abrir('producto', { params: { id: 'f1' } });

    c.querySelector('[data-variedad="Rojo"]').click();
    c.querySelector('[data-galeria-ampliar]').click();
    expect(enGrande()).toBe('https://x/rojo.webp');
    expect(cuenta()).toBe('1 / 3');
  });

  it('sin fotos no hay nada para ampliar', async () => {
    datos.productos = [{ ...cartulina, imagenes: [], variedades: [] }];
    const c = await abrir('producto', { params: { id: 'f1' } });
    expect(c.querySelector('[data-galeria-ampliar]')).toBeNull();
  });
});

describe('mis pedidos', () => {
  it('sin ninguno lo dice, no deja la pantalla en blanco', async () => {
    const c = await abrir('seguimiento');
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(c.textContent.toLowerCase()).toMatch(/pedido/);
  });

  // Con cero pedidos el primer pintado es el cartelito de "buscando los de tu
  // cuenta". Despues se lo sacaba y se cortaba antes de repintar, asi que el
  // estado vacio no llegaba a aparecer nunca: quedaba el titulo y una lista
  // vacia. Es lo que ve cualquiera que entra a "Mis pedidos" sin haber comprado.
  it('sin ninguno muestra el estado vacio de verdad, no el esqueleto', async () => {
    // La pantalla descarta lo que llega tarde comparando la ruta, asi que el
    // segundo pintado solo ocurre estando parado en ella.
    window.history.replaceState({}, '', '/seguimiento');
    const c = await abrir('seguimiento');
    expect(c.textContent).toContain('Todavía no hiciste ningún pedido');
    expect(c.querySelector('.vacio')).not.toBeNull();
    expect(c.querySelector('[data-buscando]')).toBeNull();
    // Y una salida: sin esto el estado vacio es un cartel y nada mas.
    expect(c.querySelector('a[href="/catalogo"]')).not.toBeNull();
  });

  it('lista los que hizo este teléfono', async () => {
    // Se guardan al confirmar: es lo que permite volver a mirar el estado sin
    // tener cuenta.
    localStorage.setItem('liceo.pedidos.v1', JSON.stringify([
      { id: 'k1', codigo: 'K7M2', total: 7000, cuando: Date.now(), modo: 'retiro' },
    ]));
    const c = await abrir('seguimiento');
    expect(c.textContent).toContain('K7M2');
    expect(plano()).toContain('7000');
  });
});

describe('el pedido confirmado', () => {
  beforeEach(() => {
    datos.pedidos.k1 = {
      id: 'k1', codigo: 'K7M2', estado: 'preparando',
      cliente: { nombre: 'Marta Gómez', telefono: '3515550001' },
      entrega: { modo: 'retiro' }, pago: { modo: 'efectivo', pagado: false },
      items: [{ id: 'p1', nombre: 'Cuaderno Rivadavia', cantidad: 2, precio: 3500,
                subtotal: 7000 }],
      subtotal: 7000, envio: 0, total: 7000,
      creado: { toMillis: () => Date.now(), toDate: () => new Date() },
    };
  });

  it('muestra el código, lo que se pidió y el total', async () => {
    const c = await abrir('pedido', { params: { id: 'k1' } });
    const t = plano();
    expect(t).toContain('K7M2');
    expect(c.textContent).toContain('Cuaderno Rivadavia');
    expect(t).toContain('7000');
  });

  it('muestra en qué paso está', async () => {
    const c = await abrir('pedido', { params: { id: 'k1' } });
    expect(c.textContent.toLowerCase()).toMatch(/prepar/);
  });

  it('un pedido que no existe lo dice', async () => {
    const c = await abrir('pedido', { params: { id: 'no-existe' } });
    expect(c.innerHTML.length).toBeGreaterThan(0);
    expect(c.textContent.toLowerCase()).toMatch(/no (lo )?encontr|no existe/);
  });

  describe('los avisos al celular', () => {
    // Que le llegue al celular cada vez que el local mueve el pedido, aunque
    // haya cerrado la página. El permiso se pide solo si toca el botón: si se
    // pide solo y dice que no, el navegador no deja volver a preguntar.
    const respirar = async () => { for (let i = 0; i < 10; i++) await esperar(); };
    const boton = () => document.querySelector('[data-activar-avisos]');

    it('en un pedido en curso ofrece activarlos, sin preguntar nada todavía', async () => {
      const c = await abrir('pedido', { params: { id: 'k1' } });
      expect(boton()).toBeTruthy();
      expect(c.querySelector('[data-avisos]').textContent).toMatch(/avis/i);
      expect(datos.avisos.llamadas).toEqual([]);
    });

    it('tocar el botón los activa y lo confirma', async () => {
      await abrir('pedido', { params: { id: 'k1' } });
      boton().click();
      await respirar();
      expect(datos.avisos.llamadas).toEqual([{ id: 'k1', preguntar: true }]);
      expect(boton()).toBeNull();
      expect(document.querySelector('[data-avisos]').textContent).toMatch(/Te avisamos en este celular/);
    });

    it('con el permiso ya dado en otro pedido se activan solos, sin preguntar', async () => {
      datos.avisos.permiso = 'granted';
      await abrir('pedido', { params: { id: 'k1' } });
      await respirar();
      expect(datos.avisos.llamadas).toEqual([{ id: 'k1', preguntar: false }]);
      expect(boton()).toBeNull();
    });

    it('si ya estaban activos no lo vuelve a anotar', async () => {
      datos.avisos.activos = ['k1'];
      datos.avisos.permiso = 'granted';
      await abrir('pedido', { params: { id: 'k1' } });
      await respirar();
      expect(datos.avisos.llamadas).toEqual([]);
      expect(document.querySelector('[data-avisos]').textContent).toMatch(/Te avisamos en este celular/);
    });

    it('en iPhone sin la tienda instalada explica cómo, sin un botón que no haría nada', async () => {
      datos.avisos.soporte = 'iphone_sin_instalar';
      await abrir('pedido', { params: { id: 'k1' } });
      expect(boton()).toBeNull();
      expect(document.querySelector('[data-avisos]').textContent).toMatch(/Agregar a inicio/);
    });

    it('sin soporte o con el permiso bloqueado no muestra nada', async () => {
      for (const soporte of ['sin_soporte', 'bloqueado']) {
        datos.avisos.soporte = soporte;
        await abrir('pedido', { params: { id: 'k1' } });
        expect(document.querySelector('[data-avisos]')).toBeNull();
        document.body.innerHTML = '';
      }
    });

    it('un pedido terminado no ofrece avisos', async () => {
      datos.pedidos.k1.estado = 'entregado';
      await abrir('pedido', { params: { id: 'k1' } });
      expect(document.querySelector('[data-avisos]')).toBeNull();
    });

    it('si falla lo dice y deja volver a probar', async () => {
      datos.avisos.resultado = 'error';
      await abrir('pedido', { params: { id: 'k1' } });
      boton().click();
      await respirar();
      expect(boton()).toBeTruthy();
      expect(document.querySelector('[data-avisos]').textContent).toMatch(/No se pudieron activar/);
    });

    it('si el cliente dice que no, no se le vuelve a insistir', async () => {
      datos.avisos.resultado = 'rechazado';
      await abrir('pedido', { params: { id: 'k1' } });
      boton().click();
      await respirar();
      expect(document.querySelector('[data-avisos]')).toBeNull();
    });

    it('con la función apagada desaparece sin dejar un botón muerto', async () => {
      datos.avisos.resultado = 'no_disponible';
      await abrir('pedido', { params: { id: 'k1' } });
      boton().click();
      await respirar();
      expect(document.querySelector('[data-avisos]')).toBeNull();
    });
  });

  describe('los reclamos', () => {
    const respirar = async () => { for (let i = 0; i < 10; i++) await esperar(); };
    const entrada = () => document.querySelector('[data-abrir-reclamo]');
    const tarjeta = () => document.querySelector('[data-reclamo]');
    const entregado = (extra = {}) => Object.assign(datos.pedidos.k1, {
      estado: 'entregado',
      entregado_en: { toDate: () => new Date(Date.now() - 86400000) },
      ...extra,
    });

    it('un pedido entregado ofrece contar un problema, junto a lo que se pidió', async () => {
      entregado();
      await abrir('pedido', { params: { id: 'k1' } });
      expect(entrada()).toBeTruthy();
      expect(entrada().closest('.pedido-seccion').textContent).toContain('Lo que pediste');
    });

    it('uno recién entrado o cancelado, no', async () => {
      datos.pedidos.k1.estado = 'nuevo';
      await abrir('pedido', { params: { id: 'k1' } });
      expect(entrada()).toBeNull();
      document.body.innerHTML = '';
      datos.pedidos.k1.estado = 'cancelado';
      await abrir('pedido', { params: { id: 'k1' } });
      expect(entrada()).toBeNull();
    });

    it('tocarlo abre la hoja con el pedido y el WhatsApp del local', async () => {
      entregado();
      datos.config.whatsapp = '5493517046684';
      await abrir('pedido', { params: { id: 'k1' } });
      entrada().click();
      await respirar();
      expect(datos.hojas).toHaveLength(1);
      expect(datos.hojas[0].pedido.id).toBe('k1');
      expect(datos.hojas[0].opciones.whatsapp).toBe('5493517046684');
    });

    it('con un reclamo en curso muestra en qué anda y no ofrece otro', async () => {
      entregado({ reclamo: { id: 'k1-1', estado: 'revisando', motivo: 'roto', respuesta: null } });
      await abrir('pedido', { params: { id: 'k1' } });
      expect(tarjeta().textContent).toContain('Lo estamos revisando');
      expect(tarjeta().textContent).toContain('Llegó roto');
      expect(entrada()).toBeNull();
    });

    it('resuelto muestra la respuesta del local', async () => {
      entregado({ reclamo: { id: 'k1-1', estado: 'resuelto', motivo: 'falta', respuesta: 'Te mandamos la cartulina que faltó.' } });
      await abrir('pedido', { params: { id: 'k1' } });
      expect(tarjeta().textContent).toContain('Resuelto');
      expect(tarjeta().textContent).toContain('Te mandamos la cartulina que faltó.');
    });

    it('con un reclamo abierto, un pedido entregado ofrece los avisos del reclamo', async () => {
      entregado({ reclamo: { id: 'k1-1', estado: 'nuevo', motivo: 'roto' } });
      await abrir('pedido', { params: { id: 'k1' } });
      expect(document.querySelector('[data-avisos]').textContent).toMatch(/reclamo/);
    });

    it('al mandarlo se ve al instante y, con el permiso ya dado, se anotan los avisos solos', async () => {
      entregado();
      datos.avisos.permiso = 'granted';
      await abrir('pedido', { params: { id: 'k1' } });
      await respirar();
      // Entregado y sin reclamo no se sigue: no se anotó nada.
      expect(datos.avisos.llamadas).toEqual([]);

      entrada().click();
      await respirar();
      datos.hojas[0].opciones.alEnviado({ id: 'k1-1', estado: 'nuevo', motivo: 'roto', respuesta: null });
      await respirar();
      expect(tarjeta().textContent).toContain('Recibido');
      expect(entrada()).toBeNull();
      expect(datos.avisos.llamadas).toEqual([{ id: 'k1', preguntar: false }]);
    });
  });
});

describe('la cuenta', () => {
  it('sin sesión ofrece entrar', async () => {
    const c = await abrir('cuenta');
    expect(c.textContent.toLowerCase()).toMatch(/entrar|ingres|correo|cuenta/);
  });
});

describe('las direcciones que no se indexan', () => {
  // Quién decide esto es el shell (`main.js`), no cada pantalla: la lista vive
  // en un solo lugar y tiene que cubrir todo lo que muestra datos de alguien.
  const PRIVADAS = ['/checkout', '/pedido', '/seguimiento', '/cuenta'];

  it('están las cuatro pantallas de una sola persona', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fuente = readFileSync(join(process.cwd(), 'src', 'main.js'), 'utf8');
    for (const camino of PRIVADAS) {
      expect(fuente, `${camino} tiene que estar en la lista de privadas`)
        .toContain(`'${camino}'`);
    }
  });

  it('marcada como privada, la pantalla queda fuera de Google', async () => {
    const { fijarPantalla } = await import('../src/seo.js');
    Object.defineProperty(window, 'location', {
      value: new URL('https://liceolibreria.com/pedido/k1'), configurable: true,
    });
    fijarPantalla({ privada: true });
    expect(document.head.querySelector('meta[name="robots"]').content)
      .toContain('noindex');
  });
});

describe('la portada', () => {
  // Las fichas de rubro son el menu, no la vidriera. Antes se les aplicaba el
  // mismo corte que a las tiras y la portada ofrecia seis rubros contra los
  // ocho del catalogo: Cotillon y Merceria no estaban por ningun lado.
  it('las fichas listan todos los rubros del catalogo', async () => {
    datos.rubros = [
      { clave: 'LIBRERIA', nombre: 'Libreria', cantidad: 880, con_stock: 880 },
      { clave: 'PAPELERIA', nombre: 'Papeleria', cantidad: 120, con_stock: 120 },
      { clave: 'MERCERIA', nombre: 'Merceria', cantidad: 30, con_stock: 2 },
      { clave: 'COTILLON', nombre: 'Cotillon', cantidad: 8, con_stock: 1 },
    ];
    const c = await abrir('inicio');
    const fichas = [...c.querySelectorAll('.rubro-ficha')];
    expect(fichas).toHaveLength(4);
    expect([...c.querySelectorAll('.rubro-ficha__nombre')].map(n => n.textContent))
      .toEqual(['Libreria', 'Papeleria', 'Merceria', 'Cotillon']);
  });

  // Sin contador, ninguno. Un numero al lado del nombre no ayuda a elegir a
  // donde entrar: "888" no dice nada y "6" avisa que ahi no hay nada, y con los
  // dos en la misma fila la tienda entera se lee flaca.
  it('las fichas no llevan contador', async () => {
    datos.rubros = [
      { clave: 'LIBRERIA', nombre: 'Libreria', cantidad: 880, con_stock: 880 },
      { clave: 'PERFUMERIA', nombre: 'Perfumeria', cantidad: 9, con_stock: 6 },
    ];
    const c = await abrir('inicio');
    expect(c.querySelectorAll('.rubro-ficha')).toHaveLength(2);
    expect(c.querySelector('.rubro-ficha__cuenta')).toBeNull();
    const fichas = c.querySelector('.rubros').textContent;
    expect(fichas).toContain('Libreria');
    expect(fichas).not.toMatch(/880|disponibles/);
  });
});

describe('las tiras de la portada', () => {
  // Cada tira traía seis productos y los tamaños de un mismo producto se
  // pliegan en una card: "Librería 914" salía con tres cards y la fila vacía.
  // Ahora se deslizan (flechas en la computadora, el dedo en el celular) y van
  // trayendo más de ese rubro a medida que se llega al final.
  let observadores;
  class ObservadorFalso {
    constructor(alCambiar, opciones) {
      Object.assign(this, { alCambiar, opciones, mirando: new Set(), desconectado: false });
      observadores.push(this);
    }
    observe(el) { this.mirando.add(el); }
    unobserve(el) { this.mirando.delete(el); }
    disconnect() { this.desconectado = true; this.mirando.clear(); }
    ver() { this.alCambiar([...this.mirando].map(target => ({ target, isIntersecting: true }))); }
  }
  const respirar = async () => { for (let i = 0; i < 10; i++) await esperar(); };
  const tira = (rubro) => document.querySelector(`.tira[data-rubro="${rubro}"]`);
  const pista = (rubro) => tira(rubro).querySelector('[data-tira-pista]');
  const cards = (rubro) => pista(rubro).querySelectorAll('.card-producto').length;
  const observadorDe = (rubro) => observadores.find(o => o.opciones?.root === pista(rubro) && !o.desconectado);

  const producto = (rubro, i) => ({
    id: `${rubro}${i}`, nombre: `${rubro} ${String(i).padStart(2, '0')}`, precio: 500, stock: 4,
    rubro, categoria: 'Varios', imagenes: ['x.webp'],
  });

  beforeEach(() => {
    observadores = [];
    globalThis.IntersectionObserver = ObservadorFalso;
    datos.paginar = true;
    datos.productos = [
      ...Array.from({ length: 40 }, (_, i) => producto('LIBRERIA', i)),
      ...Array.from({ length: 5 }, (_, i) => producto('PAPELERIA', i)),
    ];
    datos.rubros = [
      { clave: 'LIBRERIA', nombre: 'Librería', cantidad: 40, con_stock: 40 },
      { clave: 'PAPELERIA', nombre: 'Papelería', cantidad: 5, con_stock: 5 },
    ];
  });

  it('cada tira arranca en el principio de su rubro, que es lo que más se vende, y trae doce', async () => {
    await abrir('inicio');
    const pedidoLibreria = datos.tandas.find(t => t.rubro === 'LIBRERIA');
    expect(pedidoLibreria).toMatchObject({ cursor: null, cantidad: 12, desde: 0 });
    expect(cards('LIBRERIA')).toBe(12);
  });

  it('al llegar al final de la tira entran más de ese rubro, hasta que no queda nada', async () => {
    await abrir('inicio');
    expect(observadorDe('LIBRERIA').opciones.rootMargin).toMatch(/^0px \d+px 0px 0px$/);

    observadorDe('LIBRERIA').ver();
    await respirar();
    expect(cards('LIBRERIA')).toBe(24);

    observadorDe('LIBRERIA').ver();
    await respirar();
    observadorDe('LIBRERIA').ver();
    await respirar();
    expect(cards('LIBRERIA')).toBe(40);
    expect(observadorDe('LIBRERIA'), 'sigue mirando sin nada más para traer').toBeUndefined();
    // Nada se repite ni se pisa entre tandas.
    const nombres = [...pista('LIBRERIA').querySelectorAll('.card-producto')].map(c => c.textContent);
    expect(new Set(nombres).size).toBe(40);
  });

  it('una tira que ya trajo todo no se queda mirando el final', async () => {
    await abrir('inicio');
    expect(cards('PAPELERIA')).toBe(5);
    expect(observadorDe('PAPELERIA')).toBeUndefined();
  });

  it('las flechas corren la tira de a casi una pantalla', async () => {
    await abrir('inicio');
    const movidas = [];
    const p = pista('LIBRERIA');
    Object.defineProperty(p, 'clientWidth', { configurable: true, value: 1000 });
    p.scrollBy = (opciones) => movidas.push(opciones.left);

    tira('LIBRERIA').querySelector('[data-tira-siguiente]').click();
    tira('LIBRERIA').querySelector('[data-tira-anterior]').click();
    expect(movidas).toEqual([850, -850]);
  });

  it('las flechas se llaman como lo que hacen', async () => {
    await abrir('inicio');
    expect(tira('LIBRERIA').querySelector('[data-tira-siguiente]').getAttribute('aria-label'))
      .toContain('Librería');
  });
});

describe('la ficha, cuando falta elegir el color', () => {
  const conColores = {
    id: 'v1', nombre: 'Cartulina Luma', precio: 800, stock: 30,
    rubro: 'LIBRERIA', categoria: 'Papeles', marca: 'LUMA', imagenes: ['a.webp'],
    variedades: [
      { nombre: 'Rojo', stock: 10 },
      { nombre: 'Celeste', stock: 12 },
    ],
  };

  // Tocar "Agregar" sin color elegido no agrega nada. El aviso flotante dura
  // cuatro segundos y era la unica senal: quien no llegaba a leerlo veia un
  // boton que no hace nada, que se lee como que la pagina esta rota.
  it('el selector queda marcado y el motivo se queda a la vista', async () => {
    datos.productos = [conColores];
    const c = await abrir('producto', { params: { id: 'v1' } });

    const falta = c.querySelector('[data-falta-variedad]');
    expect(falta.hidden).toBe(true);

    c.querySelector('[data-agregar]').click();
    expect(falta.hidden).toBe(false);
    expect(c.querySelector('[data-variedades]').className).toContain('variedades--falta');
    expect(falta.textContent).toContain('Eleg');
  });

  it('elegir el color lo limpia', async () => {
    datos.productos = [conColores];
    const c = await abrir('producto', { params: { id: 'v1' } });

    c.querySelector('[data-agregar]').click();
    expect(c.querySelector('[data-falta-variedad]').hidden).toBe(false);

    c.querySelector('[data-variedad="Celeste"]').click();
    expect(c.querySelector('[data-falta-variedad]').hidden).toBe(true);
    expect(c.querySelector('[data-variedades]').className).not.toContain('variedades--falta');
  });

  it('sin variedades el boton agrega y no marca nada', async () => {
    const c = await abrir('producto', { params: { id: 'p1' } });
    expect(c.querySelector('[data-falta-variedad]')).toBeNull();
    c.querySelector('[data-agregar]').click();
    const carrito = await import('../src/carrito.js');
    expect(carrito.items().map(r => r.id)).toContain('p1');
    carrito.vaciar();
  });
});

describe('una busqueda sin resultados', () => {
  // Los nombres del catalogo salen del POS ("Abrojo 100MM X Mt"), asi que "no
  // tenemos nada con esas palabras" muchas veces quiere decir "lo tenemos con
  // otro nombre". El chat busca por lo que la cosa ES, y a esa altura el
  // cliente ya se estaba yendo.
  it('ofrece preguntarle al chat con lo que se busco', async () => {
    const c = await abrir('catalogo', { query: new URLSearchParams('q=zzzz') });
    const boton = c.querySelector('[data-preguntar]');
    expect(boton).not.toBeNull();
    expect(boton.dataset.preguntar).toBe('zzzz');
    expect(boton.textContent).toContain('zzzz');
  });

  it('el boton abre el chat con la pregunta ya escrita', async () => {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const c = await abrir('catalogo', { query: new URLSearchParams('q=zzzz') });
    c.querySelector('[data-preguntar]').click();

    const panel = document.querySelector('.asistente-panel');
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('zzzz');
    panel.remove();
    document.body.style.overflow = '';
  });

  it('el WhatsApp sigue estando', async () => {
    const c = await abrir('catalogo', { query: new URLSearchParams('q=zzzz') });
    expect(c.querySelector('a[href*="wa.me"]')).not.toBeNull();
  });
});

describe('el reparto de las fichas de rubro', () => {
  // Con ocho rubros entraban seis arriba y quedaban dos abajo, con medio bloque
  // vacio al lado. En el celular no se notaba porque entran de a una o dos.
  it('elige el ancho que deja la ultima fila llena', async () => {
    const { columnasParaRubros } = await import('../src/paginas/inicio.js');
    expect(columnasParaRubros(8)).toBe(4);    // dos filas de cuatro
    expect(columnasParaRubros(9)).toBe(3);    // tres filas de tres
    expect(columnasParaRubros(10)).toBe(5);
    expect(columnasParaRubros(12)).toBe(6);
  });

  it('con pocos rubros van todos en una fila', async () => {
    const { columnasParaRubros } = await import('../src/paginas/inicio.js');
    expect(columnasParaRubros(2)).toBe(2);
    expect(columnasParaRubros(5)).toBe(5);
    expect(columnasParaRubros(0)).toBe(1);
  });

  // Cuando no hay reparto exacto se elige el que menos lugares deja sueltos.
  it('sin reparto exacto deja el hueco mas chico', async () => {
    const { columnasParaRubros } = await import('../src/paginas/inicio.js');
    expect(columnasParaRubros(7)).toBe(4);    // 4+3, un lugar
    expect(columnasParaRubros(11)).toBe(6);   // 6+5, un lugar
  });

  it('la portada se lo pasa al CSS', async () => {
    datos.rubros = Array.from({ length: 8 }, (_, i) => ({
      clave: `R${i}`, nombre: `Rubro ${i}`, cantidad: 50, con_stock: 50,
    }));
    const c = await abrir('inicio');
    expect(c.querySelector('.rubros').style.getPropertyValue('--columnas-rubros')).toBe('4');
  });
});
