// @vitest-environment jsdom
/**
 * Fotos pedidas y el conteo de la portada de la tienda.
 *
 * Esta es la pantalla por la que MÁS productos entran a la tienda. Al que ya
 * tenía stock, precio y el rubro prendido lo único que le faltaba era la foto:
 * cargársela lo publica en el momento. El número por rubro y subrubro que
 * dibuja los filtros de la portada (`tienda_config/rubros`) lo rehacía solo el
 * sync, cada seis horas, así que entre medio el filtro mostraba un producto de
 * menos, o uno de más si en vez de cargar una foto se sacaron todas. Es el
 * mismo "Aros 1 y adentro nada" que se arregló en el resto del panel, entrando
 * por la puerta que había quedado afuera.
 *
 * Se prueba la pantalla de verdad, a botonazos, con el conteo de producción:
 * lo único reemplazado son las cuatro escrituras (catálogo, espejo, subir y
 * borrar foto). El recuento que cuenta y escribe es el mismo que corre en la
 * webapp, y lo que mira la prueba es qué quedó en `tienda_config/rubros` y
 * cuándo se escribió.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { nube, espia } = vi.hoisted(() => ({
  // Lo que hay en el servidor.
  nube: { catalogo: [], pedidas: [], publicacion: {}, rubros: null },
  espia: { espejo: vi.fn(), borradas: [], subidas: 0, falla: { espejo: false } },
}));

// Sin sesión no hay token: la escritura por REST se saltea sola y el conteo
// termina en el lote del SDK, que es donde lo mira la prueba.
vi.mock('../../webapp/src/auth.js', () => ({ auth: { currentUser: null } }));

const lote = vi.hoisted(() => ({
  set: vi.fn(), update: vi.fn(), delete: vi.fn(), commit: vi.fn(async () => {}),
}));

vi.mock('firebase/firestore', () => {
  const instantanea = (lista) => ({
    docs: lista.map(d => ({ id: d.doc_id, ref: { id: d.doc_id }, data: () => d,
                            exists: () => true })),
    empty: lista.length === 0,
    size: lista.length,
    forEach(fn) { this.docs.forEach(fn); },
  });
  const deColeccion = (nombre) => (nombre === 'catalogo' ? nube.catalogo
    : nombre === 'tienda_fotos_pedidas' ? nube.pedidas : []);
  const unDoc = (ref, datos) => ({
    exists: () => !!datos, data: () => datos, get: (campo) => datos?.[campo], id: ref?.id,
  });

  return {
    collection: (_db, nombre) => ({ col: nombre }),
    doc: (_db, col, id) => ({ col, id, path: `${col}/${id}` }),
    query: (col, ...partes) => ({ col: col?.col, partes }),
    orderBy: (campo) => ({ campo }),
    limit: (n) => ({ limit: n }),
    where: (campo, op, valor) => ({ campo, op, valor }),
    getDocs: async (q) => instantanea(deColeccion(q?.col)),
    getDoc: async (ref) => {
      if (ref?.col === 'tienda_config') {
        return unDoc(ref, ref.id === 'rubros' ? nube.rubros : nube.publicacion);
      }
      if (ref?.col === 'catalogo') {
        return unDoc(ref, nube.catalogo.find(d => d.doc_id === ref?.id));
      }
      return unDoc(ref, null);
    },
    // Nada en el cache local del SDK: las lecturas van al servidor, que acá es
    // `nube`.
    getDocFromCache: async () => { throw new Error('sin cache local'); },
    onSnapshot: (q, alLlegar) => {
      try { alLlegar?.(instantanea(deColeccion(q?.col))); } catch (_) { /* nada */ }
      return () => {};
    },
    setDoc: async () => {},
    updateDoc: async () => {},
    deleteDoc: async () => {},
    writeBatch: () => lote,
    serverTimestamp: () => 'AHORA',
    deleteField: () => ({ _metodo: 'deleteField' }),
  };
});

// El recuento (`programarRecuentoDeRubros`, `usarCatalogoParaRecontar`) queda
// SIN reemplazar a propósito: es lo que se está probando.
vi.mock('../../webapp/src/tienda_espejo.js', async (original) => {
  const real = await original();
  return {
    ...real,
    actualizarDoc: async (_db, col, id, cambios) => {
      const producto = col === 'catalogo' && nube.catalogo.find(d => d.doc_id === id);
      if (producto) Object.assign(producto, cambios);
    },
    // Decide con la regla de producción: "publicado" es de verdad lo que
    // saldría a la tienda con esos datos.
    espejar: async (_db, id, datos, rubros, subExcluidos) => {
      if (espia.falla.espejo) throw new Error('el espejo no respondió');
      const motivo = real.motivoDeNoPublicar(datos, rubros, subExcluidos);
      espia.espejo({ id, motivo });
      return { publicado: motivo === null, motivo };
    },
    subirFoto: async () => `https://x/subida-${++espia.subidas}.webp`,
    borrarFoto: (url) => { espia.borradas.push(url); },
    borrarDoc: async (_db, col, id) => {
      if (col === 'tienda_fotos_pedidas') {
        nube.pedidas = nube.pedidas.filter(d => d.doc_id !== id);
      }
    },
  };
});

// Los diálogos taparían la pantalla y no aportan nada acá.
vi.mock('../../webapp/src/components/dialogs.js', async (original) => ({
  ...(await original()),
  alertDialog: vi.fn(async () => {}),
  confirmDialog: vi.fn(async () => true),
}));

const { invalidateCacheByPrefix } = await import('../../webapp/src/cache.js');
const { programarRecuentoDeRubros, esperarRecuento } =
  await import('../../webapp/src/tienda_espejo.js');
const { renderTiendaFotos } = await import('../../webapp/src/pages/tienda_fotos.js');

/* ── El catálogo de la prueba ─────────────────────────────────────────────── */

const base = { estado: 'activo', precio_venta: 1500, stock: 10 };

const CATALOGO = [
  // Le falta la foto y nada más. Es el único de su subrubro: hasta que no se le
  // cargue una, ese filtro no tiene que existir en la portada.
  { ...base, doc_id: 'p1', nombre: 'AROS DE METAL', rubro: 'LIBRERIA',
    sub_rubro: 'AROS CARPETA' },
  // Ya publicado, con una foto: el rubro existe en la portada antes y después.
  { ...base, doc_id: 'p2', nombre: 'CUADERNO RIVADAVIA', rubro: 'LIBRERIA',
    sub_rubro: 'CUADERNOS', tienda_imagenes: ['https://x/cuaderno.webp'] },
  // Publicado con dos fotos: sirve para reordenarlas y para sacarlas todas.
  { ...base, doc_id: 'p3', nombre: 'BLOCK EL NENE', rubro: 'LIBRERIA',
    sub_rubro: 'PAPELES',
    tienda_imagenes: ['https://x/block-1.webp', 'https://x/block-2.webp'] },
];

const db = {};
const ESPERA_RECUENTO = 3000;

let contenedor;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  invalidateCacheByPrefix('');
  espia.espejo.mockClear();
  espia.borradas.length = 0;
  espia.subidas = 0;
  espia.falla.espejo = false;
  lote.set.mockClear(); lote.update.mockClear(); lote.delete.mockClear();
  lote.commit.mockClear();

  // Sin red: las lecturas y escrituras por REST no responden y todo cae al SDK.
  globalThis.fetch = vi.fn(async () => { throw new Error('sin red'); });

  nube.catalogo = CATALOGO.map(d => structuredClone(d));
  // Lo pedido a mano: el block ya tiene fotos, así que solo entra a la lista
  // por acá (los automáticos son los que no tienen ninguna).
  nube.pedidas = [{ doc_id: 'p3', nombre: 'BLOCK EL NENE', rubro: 'LIBRERIA' }];
  nube.publicacion = { rubros: ['LIBRERIA'], subrubros_excluidos: {} };
  nube.rubros = null;

  // Lo que el navegador aporta y jsdom no.
  URL.createObjectURL = () => 'blob:vista-previa';
  URL.revokeObjectURL = () => {};
  globalThis.CSS = { escape: (t) => String(t) };

  document.body.innerHTML = '';
  contenedor = document.createElement('div');
  contenedor.id = 'content';
  document.body.appendChild(contenedor);
});

afterEach(() => {
  document.querySelector('.tienda-overlay[data-panel-fotos]')?.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

/* ── Manejo de la pantalla ────────────────────────────────────────────────── */

// El reloj es falso para poder saltar los tres segundos del recuento sin
// esperarlos de verdad, así que las esperas de la pantalla también se corren a
// mano: cada vuelta le da al navegador una pasada de la cola de promesas.
const respirar = async (vueltas = 12) => {
  for (let i = 0; i < vueltas; i++) await vi.advanceTimersByTimeAsync(1);
};

async function montar() {
  await renderTiendaFotos(contenedor, db);
  await respirar();
}

/** Deja pasar la espera del recuento y aguanta hasta que termine de escribir. */
async function dejarPasarElRecuento() {
  await vi.advanceTimersByTimeAsync(ESPERA_RECUENTO);
  await esperarRecuento();
}

/** Los conteos de la portada que se escribieron, del más viejo al más nuevo. */
const recuentos = () => lote.set.mock.calls
  .filter(([ref]) => ref.col === 'tienda_config' && ref.id === 'rubros')
  .map(([, datos]) => datos.lista);

const rubroContado = (clave = 'LIBRERIA') =>
  (recuentos().at(-1) || []).find(r => r.clave === clave);

const subrubrosContados = (clave = 'LIBRERIA') =>
  (rubroContado(clave)?.subrubros || []).map(s => [s.clave, s.cantidad]);

/** Abre el panel de fotos del producto, como el botón "Cambiar". */
async function abrirPanel(id) {
  contenedor.querySelector(`[data-cargar="${id}"]`).click();
  await respirar();
}

/** Elige un archivo para ese producto, como el botón "Cargar". */
async function cargarFoto(id) {
  contenedor.querySelector(`[data-cargar="${id}"]`).click();
  await respirar();
  const input = document.getElementById('fotosArchivo');
  Object.defineProperty(input, 'files', {
    configurable: true, value: [{ name: 'foto.jpg', type: 'image/jpeg' }],
  });
  input.dispatchEvent(new Event('change'));
  await respirar();
}

const panel = () => document.querySelector('.tienda-overlay[data-panel-fotos]');

async function quitarFoto(i) {
  panel().querySelector(`[data-accion="quitar"][data-i="${i}"]`).click();
  await respirar();
}

async function guardarPanel() {
  panel().querySelector('[data-accion="guardar"]').click();
  await respirar();
}

/* ── Las pruebas ──────────────────────────────────────────────────────────── */

describe('el catálogo que presta la pantalla', () => {
  it('cuenta el catálogo entero, no solo lo que está esperando foto', async () => {
    await montar();

    // Lo pide cualquier otra parte del panel: si esta pantalla prestó mal el
    // catálogo (una lista vacía, o el Map en vez de los productos) el recuento
    // se saltea sin decir nada y la portada queda con el número de antes.
    programarRecuentoDeRubros(db);
    await dejarPasarElRecuento();

    expect(recuentos()).toHaveLength(1);
    // El cuaderno y el block, que son los dos que están publicados. Los aros
    // todavía no tienen foto.
    expect(rubroContado().cantidad).toBe(2);
    expect(subrubrosContados()).toEqual(
      expect.arrayContaining([['CUADERNOS', 1], ['PAPELES', 1]]));
    expect(subrubrosContados().map(([clave]) => clave)).not.toContain('AROS CARPETA');
  });
});

describe('cuando el producto entra o sale de la tienda', () => {
  it('cargarle la foto lo publica y el filtro de la portada aparece con él', async () => {
    await montar();
    await cargarFoto('p1');
    await guardarPanel();

    expect(espia.espejo.mock.calls.at(-1)[0].motivo).toBe(null);
    // Antes del 2026-09-08 acá no se escribía nada: el filtro "Aros Carpeta"
    // no existía en la portada hasta la corrida siguiente del sync.
    await dejarPasarElRecuento();

    expect(recuentos()).toHaveLength(1);
    expect(rubroContado().cantidad).toBe(3);
    expect(subrubrosContados()).toContainEqual(['AROS CARPETA', 1]);
  });

  it('sacarle todas las fotos lo baja de la vidriera y el filtro se va con él', async () => {
    await montar();
    await abrirPanel('p3');
    await quitarFoto(1);
    await quitarFoto(0);
    await guardarPanel();

    expect(espia.espejo.mock.calls.at(-1)[0].motivo).toBe('sin foto');
    await dejarPasarElRecuento();

    expect(recuentos()).toHaveLength(1);
    // Queda solo el cuaderno: los aros nunca tuvieron foto y el block acaba de
    // quedarse sin ninguna.
    expect(rubroContado().cantidad).toBe(1);
    expect(subrubrosContados()).toEqual([['CUADERNOS', 1]]);
  });

  it('acomodar las fotos no mueve ningún número: no se recuenta', async () => {
    await montar();
    await abrirPanel('p3');
    // Cambiar la portada es el guardado más común de esta pantalla y no cambia
    // nada de lo que cuenta la portada. Recontar en cada guardado sería una
    // escritura del documento más leído de la tienda por cada click.
    panel().querySelector('[data-accion="portada"][data-i="1"]').click();
    await respirar();
    await guardarPanel();

    expect(espia.espejo.mock.calls.at(-1)[0].motivo).toBe(null);
    await dejarPasarElRecuento();

    expect(recuentos()).toHaveLength(0);
  });

  it('sacar una de dos fotos tampoco: el producto sigue en la tienda', async () => {
    await montar();
    await abrirPanel('p3');
    await quitarFoto(1);
    await guardarPanel();

    expect(espia.espejo.mock.calls.at(-1)[0].motivo).toBe(null);
    await dejarPasarElRecuento();

    expect(recuentos()).toHaveLength(0);
  });

  it('un guardado que no llegó a la tienda no toca la portada', async () => {
    await montar();
    espia.falla.espejo = true;
    await cargarFoto('p1');
    await guardarPanel();

    await dejarPasarElRecuento();

    // El espejo falló: el producto no entró a la tienda y la portada no tiene
    // por qué contarlo.
    expect(recuentos()).toHaveLength(0);
  });
});
