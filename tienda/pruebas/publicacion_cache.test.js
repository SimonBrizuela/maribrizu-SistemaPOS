// @vitest-environment jsdom
/**
 * La lista de rubros recién guardada tiene que llegar a las otras pantallas.
 *
 * Configuración escribe `tienda_config/publicacion` por REST: no pasa por el
 * SDK, nadie escucha ese documento con `onSnapshot` y el cache local del SDK se
 * queda con la lista de antes. El caso real: en Configuración se prende
 * JUGUETERÍA y se pasa derecho a Tienda > Catálogo a cargarle fotos. La
 * pantalla arrancaba con la lista vieja, sus productos figuraban como "el rubro
 * no está habilitado" y cada foto que se subía terminaba borrando el producto
 * del espejo, así que desaparecía de la tienda hasta la corrida siguiente del
 * sync. Apagando un rubro pasaba al revés: los seguía mostrando publicados y
 * cualquier guardado los volvía a subir.
 *
 * Acá el cache local del SDK NUNCA se entera de las escrituras, a propósito: es
 * lo que pasa de verdad, y es lo que hace que estas pruebas fallen si se saca
 * la siembra del valor recién guardado.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { nube, cacheSdk, pedidosRest } = vi.hoisted(() => ({
  // Lo que hay en el servidor.
  nube: { tienda_config: {}, catalogo: {}, tienda_productos: {} },
  // El cache local del SDK, que es lo que devuelve `getDocFromCache`.
  cacheSdk: { tienda_config: {} },
  pedidosRest: [],
}));

vi.mock('firebase/firestore', () => {
  const instantanea = (datos, id) => ({
    exists: () => !!datos,
    data: () => datos,
    id,
    get: (campo) => datos?.[campo],
  });
  return {
    doc: (_db, col, id) => ({ _col: col, id }),
    collection: (_db, col) => ({ _col: col }),
    query: (col) => ({ _col: col?._col }),
    where: () => ({}),
    orderBy: () => ({}),
    limit: () => ({}),
    getDocs: async (q) => {
      const filas = Object.entries(nube[q?._col] || {});
      return {
        docs: filas.map(([id, d]) => ({
          id, ref: { id }, data: () => d, exists: () => true, get: (c) => d?.[c],
        })),
        empty: !filas.length, size: filas.length, docChanges: () => [],
        forEach(fn) { this.docs.forEach(fn); },
      };
    },
    getDoc: async (ref) => instantanea(nube[ref?._col]?.[ref?.id], ref?.id),
    getDocFromCache: async (ref) => {
      const datos = cacheSdk[ref?._col]?.[ref?.id];
      if (!datos) throw new Error('sin cache local');
      return instantanea(datos, ref?.id);
    },
    onSnapshot: () => () => {},
    setDoc: async () => {},
    updateDoc: async () => {},
    deleteDoc: async () => {},
    writeBatch: () => ({
      set: () => {}, update: () => {}, delete: () => {}, commit: async () => {},
    }),
    serverTimestamp: () => 'AHORA',
    deleteField: () => ({ _methodName: 'deleteField' }),
  };
});

vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {}, storage: {} }));
// Con sesión: las escrituras del panel salen por REST, que es el camino real y
// el que deja el cache del SDK sin enterarse.
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
// El aviso de "se van a revisar N productos" se acepta siempre: lo que se
// prueba es lo que pasa después de aceptarlo.
vi.mock('../../webapp/src/components/dialogs.js', async (original) => ({
  ...(await original()),
  confirmDialog: async () => true,
  alertDialog: vi.fn(),
}));

const { getCached, peekCacheValue, invalidateCacheByPrefix } =
  await import('../../webapp/src/cache.js');
const { leerPublicacion, olvidarPublicacion } =
  await import('../../webapp/src/tienda_espejo.js');
const { renderTiendaAjustes } = await import('../../webapp/src/pages/tienda_ajustes.js');
const { renderTiendaCatalogo } = await import('../../webapp/src/pages/tienda_catalogo.js');

/* ── El servidor por REST ─────────────────────────────────────────────────── */

const aValor = (v) => {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return Boolean(v.booleanValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue?.values || []).map(aValor);
  if ('mapValue' in v) return aCampos(v.mapValue?.fields);
  return null;
};

const aCampos = (fields) => Object.fromEntries(
  Object.entries(fields || {}).map(([k, v]) => [k, aValor(v)]));

const dondeVa = (nombre) => String(nombre).split('/').slice(-2);

function aplicarEscrituras(writes) {
  for (const w of writes || []) {
    if (w.delete) {
      const [col, id] = dondeVa(w.delete);
      if (nube[col]) delete nube[col][id];
      continue;
    }
    const [col, id] = dondeVa(w.update.name);
    const campos = aCampos(w.update.fields);
    nube[col] = nube[col] || {};
    if (w.updateMask) {
      const documento = { ...(nube[col][id] || {}) };
      // Un campo en la máscara pero sin valor es un campo que se borra.
      for (const ruta of w.updateMask.fieldPaths || []) delete documento[ruta];
      nube[col][id] = { ...documento, ...campos };
    } else {
      nube[col][id] = campos;
    }
  }
}

/**
 * La API REST de Firestore, de mentira. Acepta el commit (y lo aplica al
 * servidor) y contesta vacío a las lecturas: nada de esto cambia lo que se
 * está probando, pero sin el doble el código sale a la red de verdad.
 */
function restFalsa() {
  return vi.fn(async (url, opciones = {}) => {
    const u = String(url);
    pedidosRest.push(u);
    if (u.endsWith(':commit')) {
      aplicarEscrituras(JSON.parse(opciones.body || '{}').writes);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (u.endsWith(':runQuery') || u.endsWith(':batchGet')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

/* ── El catálogo de la prueba ─────────────────────────────────────────────── */

const base = {
  estado: 'activo', precio_venta: 1200, stock: 8, tienda_imagenes: ['foto.webp'],
};
const CATALOGO = {
  p1: { ...base, nombre: 'CUADERNO RIVADAVIA', rubro: 'LIBRERIA', sub_rubro: 'CUADERNOS' },
  p2: { ...base, nombre: 'PELOTA DE GOMA', rubro: 'JUGUETERIA', sub_rubro: 'PELOTAS' },
};

let contenedor;

beforeEach(() => {
  localStorage.clear();
  invalidateCacheByPrefix('');
  olvidarPublicacion();
  pedidosRest.length = 0;
  globalThis.fetch = restFalsa();

  nube.catalogo = Object.fromEntries(
    Object.entries(CATALOGO).map(([id, d]) => [id, { ...d }]));
  nube.tienda_productos = {};
  nube.tienda_config = {
    publicacion: { rubros: ['LIBRERIA'], subrubros_excluidos: {} },
    avisos: { rubros: { LIBRERIA: 'Los cuadernos no se cambian' }, subrubros: {} },
  };
  // El SDK arranca con lo mismo, y de acá en más se queda congelado: las
  // escrituras del panel van por REST y nadie escucha estos documentos.
  cacheSdk.tienda_config = {
    publicacion: { rubros: ['LIBRERIA'], subrubros_excluidos: {} },
    avisos: { rubros: { LIBRERIA: 'Los cuadernos no se cambian' }, subrubros: {} },
  };

  document.body.innerHTML = '<div id="app"></div><div id="page-title"></div>'
    + '<div id="sidebar"></div><div id="status"></div><div id="bottomNav"></div>';
  contenedor = document.createElement('div');
  contenedor.id = 'content';
  document.body.appendChild(contenedor);
});

afterEach(() => {
  document.querySelector('.avisos-overlay')?.remove();
});

// jsdom no trae `CSS.escape`, y la lista de rubros lo usa apenas se tilda uno.
// Alcanza con escapar lo que no es letra, número ni guión.
if (!globalThis.CSS) {
  globalThis.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, ch => '\\' + ch) };
}

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));

/** Deja correr el bucle hasta que se cumpla la condición (o se agote). */
async function hastaQue(condicion, vueltas = 200) {
  for (let i = 0; i < vueltas; i++) {
    if (condicion()) return true;
    await esperar(1);
  }
  return condicion();
}

async function montarAjustes() {
  await renderTiendaAjustes(contenedor, {});
  for (let i = 0; i < 10; i++) await esperar();
  return contenedor;
}

async function montarCatalogo() {
  await renderTiendaCatalogo(contenedor, {});
  for (let i = 0; i < 10; i++) await esperar();
  return contenedor;
}

/** Prende un rubro en Configuración y espera a que termine de guardar. */
async function prenderRubroYGuardar(rubro) {
  const check = contenedor.querySelector(`[data-rubro="${rubro}"]`);
  expect(check, `no está el rubro ${rubro} en la lista`).toBeTruthy();
  check.checked = true;
  check.dispatchEvent(new Event('change', { bubbles: true }));

  document.getElementById('cfgGuardar').click();
  const estado = document.getElementById('cfgEstado');
  await hastaQue(() => /Guardado|No se pudo/.test(estado.textContent));
  expect(estado.textContent).toMatch(/Guardado/);
}

describe('la lista de rubros recién guardada', () => {
  it('queda sembrada en la memoria compartida del panel', async () => {
    await montarAjustes();
    await prenderRubroYGuardar('JUGUETERIA');

    const sembrado = peekCacheValue('tienda:publicacion');
    expect(sembrado).toBeTruthy();
    expect(sembrado.rubros).toContain('JUGUETERIA');
    expect(sembrado.rubros).toContain('LIBRERIA');
    expect(sembrado.subrubrosExcluidos).toEqual({});
  });

  it('se lee sin volver a consultar, aunque el SDK siga con la de antes', async () => {
    await montarAjustes();
    await prenderRubroYGuardar('JUGUETERIA');

    // Lo mismo que hace `leerPublicacionDeLaTienda` del catálogo de la tienda:
    // si el valor sembrado no estuviera, acá se dispararía el fetcher y
    // volvería la lista vieja del cache del SDK.
    const consultar = vi.fn(async () => ({ rubros: ['LIBRERIA'], subrubrosExcluidos: {} }));
    const leido = await getCached('tienda:publicacion', consultar);

    expect(consultar).not.toHaveBeenCalled();
    expect(leido.rubros).toContain('JUGUETERIA');
  });

  it('tiene la misma forma que arma el catálogo de la tienda por su cuenta', async () => {
    // Sin esto la siembra podría guardar `subrubros_excluidos` (el nombre del
    // documento) donde la pantalla espera `subrubrosExcluidos`, y los subrubros
    // destildados dejarían de contar sin que nadie lo note.
    await montarCatalogo();
    const propio = peekCacheValue('tienda:publicacion');
    expect(propio).toBeTruthy();

    invalidateCacheByPrefix('tienda:');
    await montarAjustes();
    await prenderRubroYGuardar('JUGUETERIA');

    const sembrado = peekCacheValue('tienda:publicacion');
    expect(Object.keys(sembrado).sort()).toEqual(Object.keys(propio).sort());
    expect(Array.isArray(sembrado.rubros)).toBe(true);
    expect(sembrado.rubros.every(r => r === r.toUpperCase())).toBe(true);
    expect(typeof sembrado.subrubrosExcluidos).toBe('object');
  });

  it('el catálogo de la tienda ya no dice que el rubro no está habilitado', async () => {
    await montarAjustes();
    await prenderRubroYGuardar('JUGUETERIA');

    contenedor.innerHTML = '';
    await montarCatalogo();

    const fila = [...document.querySelectorAll('.tienda-fila')]
      .find(f => f.textContent.includes('Pelota'));
    expect(fila, 'la pelota no aparece en la lista').toBeTruthy();
    expect(fila.textContent).not.toContain('el rubro no está habilitado');
    expect(fila.querySelector('[data-accion="interruptor"]').getAttribute('aria-checked'))
      .toBe('true');
  });
});

describe('el minuto de memoria del espejo', () => {
  it('contesta lo de antes hasta que se le pide que lo olvide', async () => {
    expect((await leerPublicacion({})).rubros).toEqual(['LIBRERIA']);

    nube.tienda_config.publicacion = {
      rubros: ['LIBRERIA', 'JUGUETERIA'], subrubros_excluidos: {},
    };
    expect((await leerPublicacion({})).rubros).toEqual(['LIBRERIA']);

    olvidarPublicacion();
    expect((await leerPublicacion({})).rubros).toEqual(['LIBRERIA', 'JUGUETERIA']);
  });

  it('guardar en Configuración se lo hace olvidar', async () => {
    // El memo se llena antes de guardar, que es lo que pasa de verdad: la
    // pantalla de Configuración ya espejó algo, o se venía de la ficha de un
    // producto. Sin olvidarlo, el guardado siguiente de una ficha de
    // JUGUETERÍA la borraba del espejo por "el rubro no está habilitado".
    expect((await leerPublicacion({})).rubros).toEqual(['LIBRERIA']);

    await montarAjustes();
    await prenderRubroYGuardar('JUGUETERIA');

    expect((await leerPublicacion({})).rubros).toContain('JUGUETERIA');
  });
});

describe('los avisos que ve el cliente', () => {
  /** Abre el diálogo de Avisos y devuelve el overlay. */
  async function abrirAvisos() {
    document.getElementById('tiendaAvisos').click();
    await hastaQue(() => !!document.querySelector('.avisos-overlay'));
    const overlay = document.querySelector('.avisos-overlay');
    await hastaQue(() => !!overlay.querySelector('[data-aviso-rubro]'));
    return overlay;
  }

  it('la segunda vez que se abre muestra lo último guardado', async () => {
    await montarCatalogo();

    const primero = await abrirAvisos();
    const campo = primero.querySelector('[data-aviso-rubro="LIBRERIA"]');
    expect(campo.value).toBe('Los cuadernos no se cambian');

    campo.value = 'Las telas se cortan a pedido';
    primero.querySelector('.avisos-guardar').click();
    await hastaQue(() => !document.querySelector('.avisos-overlay'));

    const segundo = await abrirAvisos();
    // Sin sembrar lo recién guardado, acá volvía el aviso anterior (el cache
    // del SDK no se enteró de la escritura por REST) y, si se corregía otro
    // rubro y se guardaba, este volvía atrás.
    expect(segundo.querySelector('[data-aviso-rubro="LIBRERIA"]').value)
      .toBe('Las telas se cortan a pedido');
  });

  it('lo guardado llegó al servidor tal cual', async () => {
    await montarCatalogo();
    const overlay = await abrirAvisos();
    overlay.querySelector('[data-aviso-rubro="LIBRERIA"]').value = 'Se corta a pedido';
    overlay.querySelector('.avisos-guardar').click();
    await hastaQue(() => !document.querySelector('.avisos-overlay'));

    expect(nube.tienda_config.avisos.rubros).toEqual({ LIBRERIA: 'Se corta a pedido' });
  });
});
