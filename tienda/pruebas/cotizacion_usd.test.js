/**
 * De dónde saca el panel a cuánto está el dólar.
 *
 * Lo que importa no es la cuenta (esa está en `precio_usd.test.js`), es la
 * disciplina: el panel y las cinco cajas comparten UN documento, y el que lo
 * encuentra al día no sale a internet. Sin eso, seis puntas consultando por su
 * cuenta dan seis valores distintos para el mismo producto según dónde se
 * cobre.
 *
 * También se prueba lo que pasa cuando algo falla, que es lo que de verdad
 * rompe una caja: la API caída, el documento con basura, el navegador sin
 * almacenamiento. En todos esos casos tiene que quedar el último valor bueno.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Firestore, reemplazado por un doble con memoria: así se puede ver qué se
// escribió y cuántas veces, que es la mitad de lo que hay que probar acá.
const nube = { doc: null, lecturas: 0, escrituras: 0, listeners: [] };
vi.mock('firebase/firestore', () => ({
  doc: (_db, col, id) => ({ col, id }),
  getDoc: async () => {
    nube.lecturas += 1;
    return { exists: () => nube.doc !== null, data: () => nube.doc };
  },
  setDoc: async (_ref, datos) => {
    nube.escrituras += 1;
    nube.doc = { ...(nube.doc || {}), ...datos };
    nube.listeners.forEach(fn => fn({ exists: () => true, data: () => nube.doc }));
  },
  onSnapshot: (_ref, alCambiar) => {
    nube.listeners.push(alCambiar);
    alCambiar({ exists: () => nube.doc !== null, data: () => nube.doc });
    return () => { nube.listeners = nube.listeners.filter(f => f !== alCambiar); };
  },
}));

const {
  leerDocumento, estaVencida, edadMinutos, msDeActualizado, valorActual,
  cotizacionEnMemoria, leerCotizacion, guardarCotizacion, asegurarCotizacion,
  fijarAMano, usarTipo, escucharCotizacion, pedirALaApi, _olvidarTodo,
} = await import('../../webapp/src/cotizacion_usd.js');

const DB = {};
const HACE = (minutos) => new Date(Date.now() - minutos * 60000).toISOString();

beforeEach(() => {
  nube.doc = null;
  nube.lecturas = 0;
  nube.escrituras = 0;
  nube.listeners = [];
  _olvidarTodo();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  _olvidarTodo();
});

/** Una API que contesta lo que se le diga, y cuenta cuántas veces la llamaron. */
function apiQueDevuelve(valor, { falla = false } = {}) {
  const llamadas = [];
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    llamadas.push(String(url));
    if (falla) throw new Error('sin internet');
    if (String(url).includes('bluelytics')) {
      return { ok: true, json: async () => ({ blue: { value_sell: valor } }) };
    }
    return { ok: true, json: async () => ({ venta: valor, casa: 'blue' }) };
  }));
  return llamadas;
}

describe('el documento compartido', () => {
  it('se lee con cuidado: un valor roto no multiplica los precios del local', () => {
    expect(leerDocumento(null)).toBe(null);
    expect(leerDocumento({})).toBe(null);
    expect(leerDocumento({ valor: 0 })).toBe(null);
    expect(leerDocumento({ valor: -1550 })).toBe(null);
    expect(leerDocumento({ valor: 'mil quinientos' })).toBe(null);
    expect(leerDocumento({ valor: 9999999 })).toBe(null);
  });

  it('lo que sí sirve se lee entero', () => {
    const cot = leerDocumento({
      valor: 1550, tipo: 'BLUE', fuente: 'dolarapi', manual: 'si',
      actualizado: '2026-09-21T16:56:00Z', refresco_minutos: 60,
    });
    expect(cot.valor).toBe(1550);
    expect(cot.tipo).toBe('blue');
    expect(cot.manual).toBe(false);          // solo el booleano true vale
    expect(cot.refrescoMinutos).toBe(60);
    expect(cot.ts).toBe(Date.parse('2026-09-21T16:56:00Z'));
  });

  it('un refresco absurdo se acota, nunca se acepta', () => {
    expect(leerDocumento({ valor: 1550, refresco_minutos: 0 }).refrescoMinutos).toBe(30);
    expect(leerDocumento({ valor: 1550, refresco_minutos: -5 }).refrescoMinutos).toBe(1);
    expect(leerDocumento({ valor: 1550, refresco_minutos: 99999 }).refrescoMinutos).toBe(1440);
    expect(leerDocumento({ valor: 1550, refresco_minutos: 'nada' }).refrescoMinutos).toBe(30);
  });

  it('la fecha se entiende venga como venga', () => {
    const t = Date.parse('2026-09-21T16:56:00Z');
    expect(msDeActualizado('2026-09-21T16:56:00.000Z')).toBe(t);
    expect(msDeActualizado(new Date(t))).toBe(t);
    expect(msDeActualizado({ toMillis: () => t })).toBe(t);   // Timestamp del SDK
    expect(msDeActualizado(t)).toBe(t);                       // milisegundos
    expect(msDeActualizado(t / 1000)).toBe(t);                // segundos
    expect(msDeActualizado('cualquier cosa')).toBe(0);
    expect(msDeActualizado(null)).toBe(0);
  });
});

describe('cuándo le toca a alguien salir a internet', () => {
  it('recién pasada la ventana acordada', () => {
    expect(estaVencida(leerDocumento({ valor: 1550, actualizado: HACE(5) }))).toBe(false);
    expect(estaVencida(leerDocumento({ valor: 1550, actualizado: HACE(29) }))).toBe(false);
    expect(estaVencida(leerDocumento({ valor: 1550, actualizado: HACE(31) }))).toBe(true);
  });

  it('con la ventana que diga el documento', () => {
    const cot = leerDocumento({ valor: 1550, actualizado: HACE(45), refresco_minutos: 60 });
    expect(estaVencida(cot)).toBe(false);
  });

  it('el valor cargado a mano no vence nunca', () => {
    const cot = leerDocumento({ valor: 1700, manual: true, actualizado: HACE(600) });
    expect(estaVencida(cot)).toBe(false);
  });

  it('sin documento, o sin fecha, le toca a cualquiera', () => {
    expect(estaVencida(null)).toBe(true);
    expect(estaVencida(leerDocumento({ valor: 1550 }))).toBe(true);
    expect(edadMinutos(null)).toBe(null);
  });
});

describe('conseguir la cotización', () => {
  it('si otra PC la trajo hace un rato, no se consulta nada', async () => {
    nube.doc = { valor: 1550, tipo: 'blue', fuente: 'dolarapi', actualizado: HACE(3) };
    const llamadas = apiQueDevuelve(1600);

    const cot = await asegurarCotizacion(DB, { desfasajeMs: 0 });

    expect(cot.valor).toBe(1550);
    expect(llamadas).toEqual([]);            // ni un pedido a internet
    expect(nube.escrituras).toBe(0);         // ni una escritura
  });

  it('si está vencida, se consulta y queda escrita para todos', async () => {
    nube.doc = { valor: 1400, tipo: 'blue', fuente: 'dolarapi', actualizado: HACE(120) };
    const llamadas = apiQueDevuelve(1550);

    const cot = await asegurarCotizacion(DB, { desfasajeMs: 0 });

    expect(cot.valor).toBe(1550);
    expect(llamadas.length).toBe(1);
    expect(nube.doc.valor).toBe(1550);
    expect(nube.doc.fuente).toBe('dolarapi');
    expect(nube.doc.manual).toBe(false);
  });

  it('dos pantallas pidiéndola a la vez consultan una sola vez', async () => {
    nube.doc = { valor: 1400, tipo: 'blue', actualizado: HACE(120) };
    const llamadas = apiQueDevuelve(1550);

    const [a, b, c] = await Promise.all([
      asegurarCotizacion(DB, { desfasajeMs: 0 }),
      asegurarCotizacion(DB, { desfasajeMs: 0 }),
      asegurarCotizacion(DB, { desfasajeMs: 0 }),
    ]);

    expect(llamadas.length).toBe(1);
    expect([a.valor, b.valor, c.valor]).toEqual([1550, 1550, 1550]);
  });

  it('durante la espera al azar, otra caja puede adelantarse y ya no se sale', async () => {
    // Las seis puntas ven el documento vencido en el mismo segundo. Cada una
    // espera un rato distinto; en ese rato, la primera escribe y las demás
    // tienen que darse cuenta al releer.
    //
    // La espera es `Math.random() * desfasajeMs`, así que se la fija: con un
    // setTimeout compitiendo contra el azar, el test fallaba una de cada tres
    // corridas cuando el azar salía más corto que la escritura de la otra caja
    // —y no por un error del código, que es lo peor que puede hacer un test.
    const azar = vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      nube.doc = { valor: 1400, tipo: 'blue', actualizado: HACE(120) };
      const llamadas = apiQueDevuelve(1600);
      setTimeout(() => {
        nube.doc = { valor: 1550, tipo: 'blue', fuente: 'dolarapi', actualizado: new Date().toISOString() };
      }, 5);

      // Espera entera (60 ms), con la otra caja escribiendo a los 5.
      const cot = await asegurarCotizacion(DB, { desfasajeMs: 60 });

      expect(cot.valor).toBe(1550);
      expect(llamadas).toEqual([]);
    } finally {
      azar.mockRestore();
    }
  });

  it('si la API no contesta, queda el último valor bueno', async () => {
    nube.doc = { valor: 1400, tipo: 'blue', actualizado: HACE(120) };
    apiQueDevuelve(0, { falla: true });

    const cot = await asegurarCotizacion(DB, { desfasajeMs: 0 });

    expect(cot.valor).toBe(1400);
    expect(nube.escrituras).toBe(0);
  });

  it('si no hay nada en ningún lado, devuelve null y no inventa un precio', async () => {
    nube.doc = null;
    apiQueDevuelve(0, { falla: true });
    expect(await asegurarCotizacion(DB, { desfasajeMs: 0 })).toBe(null);
    expect(valorActual()).toBe(0);
  });

  it('el valor a mano manda y no se sale a buscar otro', async () => {
    nube.doc = { valor: 1700, manual: true, fuente: 'a mano', actualizado: HACE(600) };
    const llamadas = apiQueDevuelve(1550);

    const cot = await asegurarCotizacion(DB, { desfasajeMs: 0 });

    expect(cot.valor).toBe(1700);
    expect(cot.manual).toBe(true);
    expect(llamadas).toEqual([]);
  });

  it('el botón Actualizar consulta aunque esté al día', async () => {
    nube.doc = { valor: 1550, tipo: 'blue', actualizado: HACE(1) };
    const llamadas = apiQueDevuelve(1560);

    const cot = await asegurarCotizacion(DB, { forzar: true });

    expect(cot.valor).toBe(1560);
    expect(llamadas.length).toBe(1);
  });

  it('si se cae la primera API se usa la segunda', async () => {
    const llamadas = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      llamadas.push(String(url));
      if (String(url).includes('dolarapi')) throw new Error('502');
      return { ok: true, json: async () => ({ blue: { value_sell: 1550 } }) };
    }));

    const traido = await pedirALaApi('blue');

    expect(traido.valor).toBe(1550);
    expect(llamadas.length).toBe(2);
    expect(llamadas[1]).toContain('bluelytics');
  });

  it('una API que contesta cualquier cosa no se toma por buena', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ venta: 'mil' }) })));
    expect(await pedirALaApi('blue')).toBe(null);

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await pedirALaApi('blue')).toBe(null);

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ venta: 0 }) })));
    expect(await pedirALaApi('blue')).toBe(null);
  });

  it('un tipo de dólar desconocido cae al blue', async () => {
    const llamadas = apiQueDevuelve(1550);
    await pedirALaApi('cripto');
    expect(llamadas[0]).toContain('blue');
  });
});

describe('cargarla a mano y cambiar de dólar', () => {
  it('fijar un valor a mano lo deja fijo para todos', async () => {
    const cot = await fijarAMano(DB, 1700);
    expect(cot.valor).toBe(1700);
    expect(nube.doc.manual).toBe(true);
    expect(nube.doc.fuente).toBe('a mano');
  });

  it('a mano no acepta cualquier cosa', async () => {
    for (const malo of [0, -5, 'mil', null, 9999999]) {
      expect(await fijarAMano(DB, malo)).toBe(null);
    }
    expect(nube.escrituras).toBe(0);
  });

  it('cambiar de tipo sale a buscar ese dólar y apaga el modo a mano', async () => {
    nube.doc = { valor: 1700, manual: true, fuente: 'a mano', actualizado: HACE(10) };
    const llamadas = apiQueDevuelve(1534);

    const cot = await usarTipo(DB, 'oficial');

    expect(cot.valor).toBe(1534);
    expect(cot.tipo).toBe('oficial');
    expect(nube.doc.manual).toBe(false);
    expect(llamadas[0]).toContain('oficial');
  });

  it('cambiar de tipo sin internet igual deja anotado cuál se quiere', async () => {
    await guardarCotizacion(DB, { valor: 1550, tipo: 'blue', fuente: 'dolarapi' });
    apiQueDevuelve(0, { falla: true });

    const cot = await usarTipo(DB, 'oficial');

    expect(cot.tipo).toBe('oficial');
    expect(cot.valor).toBe(1550);           // el que había, hasta que haya señal
  });
});

describe('que el panel abra con un valor aunque la base tarde', () => {
  it('lo último que se vio queda guardado en el navegador', async () => {
    await guardarCotizacion(DB, { valor: 1550, tipo: 'blue', fuente: 'dolarapi' });
    expect(valorActual()).toBe(1550);

    // Otra pestaña, sin nada en memoria: lo levanta del almacenamiento.
    _olvidarTodo();
    localStorage.setItem('cotizacion_usd', JSON.stringify({ valor: 1550, tipo: 'blue', ts: Date.now() }));
    expect(valorActual()).toBe(1550);
  });

  it('con el almacenamiento bloqueado no se rompe nada', async () => {
    const original = globalThis.localStorage;
    globalThis.localStorage = {
      getItem() { throw new Error('bloqueado'); },
      setItem() { throw new Error('bloqueado'); },
      removeItem() { throw new Error('bloqueado'); },
    };
    try {
      nube.doc = { valor: 1550, tipo: 'blue', actualizado: HACE(2) };
      const cot = await leerCotizacion(DB);
      expect(cot.valor).toBe(1550);
      expect(valorActual()).toBe(1550);     // memoria, sin almacenamiento
    } finally {
      globalThis.localStorage = original;
    }
  });

  it('basura en el almacenamiento no ensucia el precio', () => {
    localStorage.setItem('cotizacion_usd', 'esto no es JSON');
    expect(cotizacionEnMemoria()).toBe(null);
    localStorage.setItem('cotizacion_usd', JSON.stringify({ valor: 0 }));
    _olvidarTodo();
    localStorage.setItem('cotizacion_usd', JSON.stringify({ valor: 0 }));
    expect(cotizacionEnMemoria()).toBe(null);
  });
});

describe('enterarse de lo que consigue otra caja', () => {
  it('el listener avisa en el acto', async () => {
    const vistos = [];
    const dejar = escucharCotizacion(DB, cot => vistos.push(cot?.valor ?? null));

    expect(vistos).toEqual([null]);          // todavía no hay documento
    await guardarCotizacion(DB, { valor: 1550, tipo: 'blue', fuente: 'dolarapi' });
    expect(vistos).toEqual([null, 1550]);

    dejar();
    await guardarCotizacion(DB, { valor: 1600, tipo: 'blue', fuente: 'dolarapi' });
    expect(vistos).toEqual([null, 1550]);    // ya no escucha
  });

  it('un documento con basura no le llega a la pantalla como precio', () => {
    const vistos = [];
    nube.doc = { valor: 'cualquier cosa' };
    escucharCotizacion(DB, cot => vistos.push(cot));
    expect(vistos).toEqual([null]);
  });
});
