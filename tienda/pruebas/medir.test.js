/**
 * La función que recibe las mediciones de la tienda y las suma en la base.
 *
 * Lo que importa acá es que sea una puerta angosta: solo entra lo que tiene
 * forma de evento, se escribe con incrementos y con la máscara justa (sin
 * ella se pisaría el documento del día), y lo que viene de desarrollo no se
 * mezcla con lo que mira el local.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CUENTA, crearMundo, fetchFalso } from './rest_falso.js';
import { rutaDeCampo } from '../netlify/functions/lib/firestore.mjs';

let mundo = crearMundo();

async function cargar() {
  vi.resetModules();
  const mod = await import('../netlify/functions/medir.mjs');
  return mod.default;
}

function pedir(cuerpo, { metodo = 'POST', origen = 'https://beta.liceolibreria.com', cabeceras = {} } = {}) {
  return new Request('https://beta.liceolibreria.com/.netlify/functions/medir', {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(origen ? { Origin: origen } : {}), ...cabeceras },
    body: metodo === 'POST' ? (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)) : undefined,
  });
}

const TANDA = {
  v: 1,
  eventos: [
    { tipo: 'visita', nueva: true, dispositivo: 'movil', origen: 'instagram' },
    { tipo: 'pagina', pantalla: 'catalogo', rubro: 'LIBRERIA' },
    { tipo: 'busqueda', texto: 'Cuaderno Rivadavia', resultados: 8 },
    { tipo: 'busqueda', texto: 'mochila', resultados: 0 },
    { tipo: 'ficha', id: '1035115', nombre: 'Goma Borrar Keyroad', rubro: 'LIBRERIA' },
    { tipo: 'carrito', id: '1035115', nombre: 'Goma Borrar Keyroad', rubro: 'LIBRERIA' },
    { tipo: 'checkout' },
    { tipo: 'chat' },
  ],
};

beforeEach(() => {
  mundo = crearMundo();
  process.env.FIREBASE_SERVICE_ACCOUNT = CUENTA;
  vi.stubGlobal('fetch', vi.fn(fetchFalso(mundo)));
});

/** Los incrementos de la única escritura, como `{ruta: cuanto}`. */
function incrementosDe(commit) {
  const salida = {};
  for (const t of commit.writes[0].updateTransforms) {
    if (t.increment) salida[t.fieldPath] = Number(t.increment.integerValue);
  }
  return salida;
}

describe('la puerta', () => {
  it('solo acepta POST', async () => {
    const medir = await cargar();
    expect((await medir(pedir(null, { metodo: 'GET' }))).status).toBe(405);
  });

  it('sin cuenta de servicio se declara apagada', async () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    const medir = await cargar();
    expect((await medir(pedir(TANDA))).status).toBe(501);
    expect(mundo.commits).toHaveLength(0);
  });

  it('rechaza una tanda que viene de otro sitio', async () => {
    const medir = await cargar();
    expect((await medir(pedir(TANDA, { origen: 'https://otro-sitio.com' }))).status).toBe(403);
    expect(mundo.commits).toHaveLength(0);
  });

  it('acepta el dominio de la tienda, el de beta y el de Netlify', async () => {
    const medir = await cargar();
    for (const origen of ['https://liceolibreria.com', 'https://beta.liceolibreria.com', 'https://liceo-tienda.netlify.app']) {
      mundo.commits = [];
      expect((await medir(pedir(TANDA, { origen }))).status).toBe(204);
      expect(mundo.commits).toHaveLength(1);
    }
  });

  it('un cuerpo ilegible o sin lista de eventos es 400', async () => {
    const medir = await cargar();
    expect((await medir(pedir('{no es json'))).status).toBe(400);
    expect((await medir(pedir({ v: 1 }))).status).toBe(400);
    expect((await medir(pedir({ eventos: 'x' }))).status).toBe(400);
    expect(mundo.commits).toHaveLength(0);
  });

  it('demasiado grande es 413, antes de leerlo', async () => {
    const medir = await cargar();
    const res = await medir(pedir(TANDA, { cabeceras: { 'content-length': String(200_000) } }));
    expect(res.status).toBe(413);
    const gordo = { eventos: [{ tipo: 'chat', relleno: 'x'.repeat(30_000) }] };
    expect((await medir(pedir(gordo))).status).toBe(413);
  });

  it('el warmup contesta sin escribir', async () => {
    const medir = await cargar();
    expect((await medir(pedir({ warmup: 1 }))).status).toBe(204);
    expect(mundo.commits).toHaveLength(0);
  });

  it('una tanda sin nada válido tampoco escribe', async () => {
    const medir = await cargar();
    const res = await medir(pedir({ eventos: [{ tipo: 'hackeo' }, { tipo: 'ficha', id: 'con espacio' }, 5] }));
    expect(res.status).toBe(204);
    expect(mundo.commits).toHaveLength(0);
  });
});

describe('lo que escribe', () => {
  it('suma cada evento como un incremento sobre el documento del día', async () => {
    const medir = await cargar();
    vi.setSystemTime(new Date('2026-09-06T15:00:00Z'));   // 12:00 en Córdoba
    expect((await medir(pedir(TANDA))).status).toBe(204);

    expect(mundo.commits).toHaveLength(1);
    const escritura = mundo.commits[0].writes[0];
    expect(escritura.update.name).toMatch(/\/documents\/tienda_estadisticas\/2026-09-06$/);

    expect(incrementosDe(mundo.commits[0])).toEqual({
      visitas: 1,
      visitantes_nuevos: 1,
      'dispositivos.movil': 1,
      'origenes.instagram': 1,
      paginas: 1,
      'horas.`12`': 1,
      'rubros.LIBRERIA.vistas': 1,
      busquedas: 2,
      busquedas_sin_resultado: 1,
      'terminos.`cuaderno rivadavia`.n': 1,
      'terminos.mochila.n': 1,
      'terminos.mochila.sin': 1,
      fichas: 1,
      'productos.`1035115`.vistas': 1,
      carrito: 1,
      'productos.`1035115`.carrito': 1,
      checkouts: 1,
      chat: 1,
    });
    vi.useRealTimers();
  });

  it('deja el nombre del producto y el día, con la máscara justa', async () => {
    const medir = await cargar();
    vi.setSystemTime(new Date('2026-09-06T15:00:00Z'));
    await medir(pedir(TANDA));
    const escritura = mundo.commits[0].writes[0];

    expect(escritura.updateMask.fieldPaths.sort()).toEqual([
      'dia', 'productos.`1035115`.nombre', 'productos.`1035115`.rubro',
    ]);
    expect(escritura.update.fields.dia).toEqual({ stringValue: '2026-09-06' });
    expect(escritura.update.fields.productos.mapValue.fields['1035115'].mapValue.fields.nombre)
      .toEqual({ stringValue: 'Goma Borrar Keyroad' });
    // La marca de "actualizado" la pone el servidor, no el reloj de la función.
    expect(escritura.updateTransforms.find(t => t.fieldPath === 'actualizado'))
      .toEqual({ fieldPath: 'actualizado', setToServerValue: 'REQUEST_TIME' });
    vi.useRealTimers();
  });

  it('ningún incremento y ningún valor pisan la misma ruta', async () => {
    const medir = await cargar();
    await medir(pedir(TANDA));
    const escritura = mundo.commits[0].writes[0];
    const rutasSumadas = new Set(escritura.updateTransforms.map(t => t.fieldPath));
    for (const ruta of escritura.updateMask.fieldPaths) expect(rutasSumadas.has(ruta)).toBe(false);
  });

  it('lo que llega desde localhost va a la colección de pruebas', async () => {
    const medir = await cargar();
    expect((await medir(pedir(TANDA, { origen: 'http://localhost:5180' }))).status).toBe(204);
    expect(mundo.commits[0].writes[0].update.name).toMatch(/\/tienda_estadisticas_pruebas\//);
  });

  it('una tanda que cruza la medianoche escribe dos días', async () => {
    const medir = await cargar();
    const noche = Date.parse('2026-09-07T02:50:00Z');   // 23:50 del 6 en Córdoba
    vi.setSystemTime(new Date(noche + 20 * 60 * 1000));
    await medir(pedir({ eventos: [{ tipo: 'chat', t: noche }, { tipo: 'chat', t: noche + 15 * 60 * 1000 }] }));
    const nombres = mundo.commits.map(c => c.writes[0].update.name.split('/').pop()).sort();
    expect(nombres).toEqual(['2026-09-06', '2026-09-07']);
    vi.useRealTimers();
  });

  it('no toma más de la tanda máxima', async () => {
    const medir = await cargar();
    await medir(pedir({ eventos: Array(80).fill({ tipo: 'chat' }) }));
    expect(incrementosDe(mundo.commits[0]).chat).toBe(40);
  });

  it('si la base no responde contesta 502 y no revienta', async () => {
    mundo.commitsFallan = true;
    const medir = await cargar();
    const silencio = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await medir(pedir(TANDA))).status).toBe(502);
    silencio.mockRestore();
  });
});

describe('las rutas de campo', () => {
  it('entrecomilla lo que no es un identificador simple', () => {
    expect(rutaDeCampo(['visitas'])).toBe('visitas');
    expect(rutaDeCampo(['productos', '1035115', 'vistas'])).toBe('productos.`1035115`.vistas');
    expect(rutaDeCampo(['terminos', 'cuaderno rivadavia', 'n'])).toBe('terminos.`cuaderno rivadavia`.n');
    expect(rutaDeCampo(['horas', '9'])).toBe('horas.`9`');
  });

  it('escapa los acentos graves y las barras', () => {
    expect(rutaDeCampo(['a`b'])).toBe('`a\\`b`');
    expect(rutaDeCampo(['a\\b'])).toBe('`a\\\\b`');
  });
});
