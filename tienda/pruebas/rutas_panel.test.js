// @vitest-environment jsdom
/**
 * La tabla de pantallas del panel, contra la realidad.
 *
 * `main.js` tiene una fila por pantalla: qué archivo cargar, qué función
 * dibujarla y qué colecciones necesita. Las tres cosas son texto, y un texto
 * mal escrito no da error en ningún lado:
 *
 *   · una función mal nombrada → la pantalla queda en blanco;
 *   · una colección mal escrita → la pantalla abre SIN el listener que
 *     necesita. Peor que un error: muestra datos viejos y parece funcionar.
 *
 * Esta prueba lee la tabla de `main.js` tal cual está escrita y verifica cada
 * fila contra los módulos y contra el store de verdad. Una pantalla nueva queda
 * cubierta sola, sin acordarse de agregarla acá.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// El código de `main.js` como texto: lo que se verifica es la tabla tal como
// está escrita, no una copia hecha a mano acá. Se lee del disco porque el
// empaquetador no sirve archivos de afuera de `tienda/`.
const fuenteMain = readFileSync(join(process.cwd(), '..', 'webapp', 'src', 'main.js'), 'utf8');

const { estado } = vi.hoisted(() => ({ estado: { abiertas: [] } }));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  return {
    ...firestoreFalso(),
    collection: (_db, nombre) => ({ _col: nombre }),
    query: (col, ...partes) => ({ _col: col?._col, partes }),
    onSnapshot: (q) => { estado.abiertas.push(q?._col); return () => {}; },
    getDocs: async () => ({ docs: [] }),
  };
});
vi.mock('firebase/auth', () => ({
  getAuth: () => ({ currentUser: null }),
  setPersistence: async () => {}, browserLocalPersistence: 'local',
  GoogleAuthProvider: class { setCustomParameters() {} },
  signInWithPopup: async () => ({ user: null }),
  sendSignInLinkToEmail: async () => {},
  isSignInWithEmailLink: () => false,
  signInWithEmailLink: async () => ({ user: null }),
  signOut: async () => {},
  onAuthStateChanged: () => () => {},
}));
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {} }));
vi.mock('../../webapp/src/snapshot_cache.js', () => ({
  loadSnapshots: async () => ({}), schedulePersist: () => {}, clearSnapshots: async () => {},
}));

const store = await import('../../webapp/src/store.js');

// Los módulos de pantalla, resueltos de antemano: un import con la ruta armada
// en una variable no lo puede resolver el empaquetador.
const modulos = import.meta.glob('../../webapp/src/pages/*.js');

/** Lee la tabla de pantallas de `main.js` tal como está escrita. */
function leerTabla() {
  const bloque = fuenteMain.slice(fuenteMain.indexOf('const pages = {'));
  const filas = [];
  const re = /^\s{2}([a-z_]+):\s*\{\s*title:\s*'([^']*)'[\s\S]*?loader:\s*\(\)\s*=>\s*import\('\.\/pages\/([^']+)'\)[\s\S]*?render:\s*'([^']+)'[\s\S]*?needs:\s*\[([^\]]*)\]/gm;
  let m;
  while ((m = re.exec(bloque))) {
    filas.push({
      clave: m[1], titulo: m[2], archivo: m[3], render: m[4],
      necesita: m[5].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean),
    });
  }
  return filas;
}

const TABLA = leerTabla();

/** Las pantallas que aparecen en el menú, leídas del `index.html` del panel. */
function leerMenu() {
  const html = readFileSync(join(process.cwd(), '..', 'webapp', 'index.html'), 'utf8');
  return [...new Set([...html.matchAll(/data-page="([a-z_]+)"/g)].map(m => m[1]))];
}

const MENU = leerMenu();

/**
 * Enciende las colecciones y espera. Las acotadas por fecha resuelven primero
 * desde cuándo escuchar, así que el listener no queda abierto en el acto.
 */
async function encender(nombres) {
  store.prewarmStore({});
  store.ensureCollections(nombres);
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}

beforeEach(() => { estado.abiertas.length = 0; });
afterEach(() => { store.teardownStore(); });

describe('la tabla de pantallas', () => {
  it('se pudo leer y tiene todas las pantallas', () => {
    // Si esto falla, cambió el formato de la tabla y el resto de la prueba
    // estaría verificando el aire.
    expect(TABLA.length).toBeGreaterThanOrEqual(25);
  });

  it('no hay dos pantallas con la misma clave', () => {
    const claves = TABLA.map(f => f.clave);
    expect(new Set(claves).size).toBe(claves.length);
  });

  it('ninguna se quedó sin título', () => {
    for (const f of TABLA) expect(f.titulo.length, f.clave).toBeGreaterThan(0);
  });
});

describe('el menú del costado', () => {
  // Los enlaces del menú viven en `index.html` y las pantallas en `main.js`:
  // son dos archivos distintos que tienen que decir lo mismo. Un enlace que
  // apunta a una pantalla que no existe no da error: se toca y no pasa nada.
  it('se pudo leer el menú', () => {
    expect(MENU.length).toBeGreaterThanOrEqual(20);
  });

  for (const clave of MENU) {
    it(`"${clave}" existe como pantalla`, () => {
      expect(TABLA.map(f => f.clave), `el menú apunta a "${clave}" y no existe`)
        .toContain(clave);
    });
  }

  it('no hay dos enlaces a la misma pantalla', () => {
    expect(new Set(MENU).size).toBe(MENU.length);
  });
});

describe('cada pantalla existe y sabe dibujarse', () => {
  for (const fila of TABLA) {
    it(`${fila.titulo} → ${fila.render}()`, async () => {
      const clave = `../../webapp/src/pages/${fila.archivo}`;
      expect(modulos[clave], `no existe el archivo pages/${fila.archivo}`).toBeTypeOf('function');
      const mod = await modulos[clave]();
      expect(mod[fila.render], `pages/${fila.archivo} no exporta ${fila.render}`).toBeTypeOf('function');
    });
  }
});

describe('las colecciones que pide cada pantalla existen de verdad', () => {
  // Una colección mal escrita no da error: la pantalla abre sin su listener y
  // muestra lo que había, como si estuviera al día.
  const pedidas = [...new Set(TABLA.flatMap(f => f.necesita))];

  it('hay pantallas que piden colecciones', () => {
    expect(pedidas.length).toBeGreaterThan(0);
  });

  for (const nombre of pedidas) {
    it(`"${nombre}" es una colección del store`, async () => {
      await encender([nombre]);
      expect(estado.abiertas, `nadie escucha "${nombre}"`).toContain(nombre);
      store.teardownStore();
    });
  }
});

describe('navegar a una pantalla enciende lo que necesita', () => {
  for (const fila of TABLA.filter(f => f.necesita.length)) {
    it(fila.titulo, async () => {
      await encender(fila.necesita);
      for (const n of fila.necesita) {
        expect(estado.abiertas, `${fila.clave} pide "${n}" y no se abrió`).toContain(n);
      }
      store.teardownStore();
    });
  }
});
