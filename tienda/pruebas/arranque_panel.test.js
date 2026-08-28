// @vitest-environment jsdom
/**
 * El armado del panel: `webapp/src/main.js` con el `index.html` de verdad.
 *
 * Es el marco de las treinta pantallas: el menú del costado, los accesos
 * rápidos, el tema, el título de arriba y el botón de salir. Nada de esto
 * pertenece a una pantalla — si se rompe, se rompe en todas a la vez y sin un
 * error que lo diga.
 *
 * Se levanta el HTML real del panel y se dispara el `DOMContentLoaded`, que es
 * exactamente lo que pasa al abrirlo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { estado } = vi.hoisted(() => ({
  estado: { sesion: { uid: 'u1', display: 'Mari', role: 'admin' }, hayPista: true,
            salidas: 0, pintadas: [] },
}));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  return {
    ...firestoreFalso(),
    collection: (_db, nombre) => ({ _col: nombre }),
    query: (col, ...partes) => ({ _col: col?._col, partes }),
    getDocs: async () => ({ docs: [], empty: true, size: 0, forEach() {} }),
    getDoc: async () => ({ exists: () => false, data: () => ({}) }),
    getDocFromCache: async () => { throw new Error('sin cache local'); },
    onSnapshot: () => () => {},
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
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {}, storage: {} }));
vi.mock('../../webapp/src/auth.js', () => ({
  auth: { currentUser: { uid: 'u1', displayName: 'Mari', getIdToken: async () => 'T' } },
  getSession: () => estado.sesion,
  isLoggedIn: () => !!estado.sesion,
  onAuthReady: async () => estado.sesion,
  hasSessionHint: () => estado.hayPista,
  logout: async () => { estado.salidas++; },
  loginWithGoogle: async () => ({ ok: true, session: estado.sesion }),
  sendLoginLink: async () => ({ ok: true }),
  isLoginLink: () => false,
  completeLinkSignIn: async () => ({ ok: true, session: estado.sesion }),
}));
vi.mock('../../webapp/src/store.js', () => ({
  prewarmStore: () => {}, ensureCollections: () => {}, prewarmRest: () => {},
  teardownStore: () => {}, onStoreChange: () => () => {}, hydrateStore: async () => {},
  initStore: async () => {}, storeListo: async () => {},
}));
vi.mock('../../webapp/src/snapshot_cache.js', () => ({
  loadSnapshots: async () => ({}), schedulePersist: () => {}, clearSnapshots: async () => {},
}));
vi.mock('../../webapp/src/pages/login.js', () => ({
  renderLogin: (alEntrar) => { estado.pintadas.push('login'); estado.entrar = alEntrar; },
}));

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));

/** El shell del panel tal como está en el HTML que se publica. */
const HTML = readFileSync(join(process.cwd(), '..', 'webapp', 'index.html'), 'utf8');
const CUERPO = HTML.slice(HTML.indexOf('<body>') + 6, HTML.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

/** Levanta el panel: pone el HTML real y dispara el arranque. */
async function arrancar() {
  document.body.innerHTML = CUERPO;
  vi.resetModules();
  estado.pintadas = [];
  await import('../../webapp/src/main.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  for (let i = 0; i < 16; i++) await esperar();
  return document.getElementById('app');
}

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = '';
  estado.sesion = { uid: 'u1', display: 'Mari', role: 'admin' };
  estado.hayPista = true;
  estado.salidas = 0;
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) }));
  class ChartFalso {
    constructor() { this.data = { datasets: [] }; this.options = {}; }
    destroy() {} update() {} resize() {} reset() {} render() {}
  }
  ChartFalso.register = () => {};
  ChartFalso.defaults = { font: {}, color: '', plugins: { legend: { labels: {} }, tooltip: {} },
                          scale: { grid: {} }, elements: {}, datasets: {} };
  window.Chart = ChartFalso;
});

describe('el arranque', () => {
  it('con sesión muestra el panel', async () => {
    const app = await arrancar();
    expect(app.style.display).toBe('flex');
    expect(estado.pintadas).not.toContain('login');
  });

  it('sin sesión muestra la pantalla de ingreso y esconde el panel', async () => {
    estado.sesion = null;
    estado.hayPista = false;
    const app = await arrancar();
    expect(estado.pintadas).toContain('login');
    expect(app.style.display).toBe('none');
  });

  it('con la pista puesta pero la sesión caída, el panel no queda a la vista', async () => {
    // La pista es una apuesta para no esperar a Firebase antes de pintar. Si
    // sale mal hay que esconder el shell antes de que se vea.
    estado.hayPista = true;
    estado.sesion = null;
    const app = await arrancar();
    expect(estado.pintadas).toContain('login');
    expect(app.style.display).toBe('none');
  });

  it('se puede saber con qué cuenta se está adentro', async () => {
    // No va en el cartel de la conexión: ese lo pisa "Conectado" un instante
    // después. Va donde alguien lo busca, en el botón de salir.
    await arrancar();
    expect(document.getElementById('logoutBtn').title).toContain('Mari');
  });

  it('el cartel de la conexión dice el estado de la conexión', async () => {
    await arrancar();
    expect(document.getElementById('statusText').textContent)
      .toMatch(/Conectado|Sin conexión|Conectando/);
  });

  it('pone el botón de salir y el de tema', async () => {
    await arrancar();
    expect(document.getElementById('logoutBtn')).toBeTruthy();
    expect(document.getElementById('themeToggleBtn')).toBeTruthy();
  });

  it('arrancar dos veces no duplica los botones del pie', async () => {
    await arrancar();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    for (let i = 0; i < 10; i++) await esperar();
    expect(document.querySelectorAll('#logoutBtn')).toHaveLength(1);
    expect(document.querySelectorAll('#themeToggleBtn')).toHaveLength(1);
  });
});

describe('navegar por el menú', () => {
  it('tocar una pantalla la abre y la marca como activa', async () => {
    await arrancar();
    const enlace = document.querySelector('.nav-link[data-page="catalogo"]');
    expect(enlace).toBeTruthy();
    enlace.click();
    for (let i = 0; i < 10; i++) await esperar();

    expect(enlace.classList.contains('active')).toBe(true);
    expect(document.getElementById('pageTitle').textContent).toBe('Catálogo de Productos');
  });

  it('cambiar de pantalla desmarca la anterior', async () => {
    await arrancar();
    document.querySelector('.nav-link[data-page="catalogo"]').click();
    for (let i = 0; i < 8; i++) await esperar();
    document.querySelector('.nav-link[data-page="ventas"]').click();
    for (let i = 0; i < 8; i++) await esperar();

    // Se cuenta sólo el menú: los accesos rápidos son copias y también se
    // marcan, que es lo que corresponde.
    const activos = document.querySelectorAll('.nav-group .nav-link.active');
    expect(activos).toHaveLength(1);
    expect(activos[0].dataset.page).toBe('ventas');
  });

  it('la última pantalla se recuerda para la próxima vez', async () => {
    await arrancar();
    document.querySelector('.nav-link[data-page="cierres"]').click();
    for (let i = 0; i < 8; i++) await esperar();
    expect(localStorage.getItem('lastPage')).toBe('cierres');
  });

  it('al volver, se abre donde había quedado', async () => {
    localStorage.setItem('lastPage', 'catalogo');
    await arrancar();
    expect(document.getElementById('pageTitle').textContent).toBe('Catálogo de Productos');
  });

  it('una pantalla guardada que ya no existe no deja el panel en blanco', async () => {
    // Pasa al sacar una pantalla: quien la tenía como última abriría la nada.
    localStorage.setItem('lastPage', 'pantalla_que_ya_no_existe');
    const app = await arrancar();
    expect(app.style.display).toBe('flex');
    expect(document.getElementById('pageTitle').textContent.length).toBeGreaterThan(0);
  });
});

describe('los accesos rápidos', () => {
  it('la primera vez vienen sembrados: si arrancaran vacíos no se verían', async () => {
    await arrancar();
    const rapidos = document.querySelectorAll('#navPinnedItems .nav-link-pin');
    expect(rapidos.length).toBeGreaterThan(0);
  });

  it('cada uno apunta a una pantalla que existe', async () => {
    await arrancar();
    const claves = [...document.querySelectorAll('#navPinnedItems .nav-link-pin')]
      .map(a => a.dataset.page);
    const delMenu = [...document.querySelectorAll('.nav-group .nav-link')]
      .map(a => a.dataset.page);
    for (const c of claves) expect(delMenu, c).toContain(c);
  });

  it('no repiten ids del menú, que romperían getElementById', async () => {
    await arrancar();
    const ids = [...document.querySelectorAll('[id]')].map(e => e.id).filter(Boolean);
    const repetidos = ids.filter((v, i) => ids.indexOf(v) !== i);
    expect(repetidos, `ids repetidos: ${[...new Set(repetidos)]}`).toHaveLength(0);
  });

  it('tocar uno abre su pantalla', async () => {
    await arrancar();
    const rapido = document.querySelector('#navPinnedItems .nav-link-pin');
    const pagina = rapido.dataset.page;
    rapido.click();
    for (let i = 0; i < 10; i++) await esperar();
    expect(localStorage.getItem('lastPage')).toBe(pagina);
  });
});

describe('el tema', () => {
  it('el interruptor va y vuelve', async () => {
    await arrancar();
    const boton = document.getElementById('themeToggleBtn');
    const tema = () => document.documentElement.getAttribute('data-theme');
    expect(tema()).not.toBe('dark');       // arranca en claro

    boton.click();
    await esperar();
    expect(tema()).toBe('dark');

    boton.click();
    await esperar();
    expect(tema()).not.toBe('dark');
  });

  it('la elección queda guardada', async () => {
    await arrancar();
    document.getElementById('themeToggleBtn').click();
    await esperar();
    expect(localStorage.getItem('ll-theme')).toBeTruthy();
  });
});

describe('salir', () => {
  it('el botón cierra la sesión', async () => {
    await arrancar();
    // `location.reload` no existe en jsdom; lo que importa es que cierre.
    Object.defineProperty(window, 'location',
      { value: { ...window.location, reload: () => {} }, configurable: true });
    document.getElementById('logoutBtn').click();
    for (let i = 0; i < 6; i++) await esperar();
    expect(estado.salidas).toBe(1);
  });
});
