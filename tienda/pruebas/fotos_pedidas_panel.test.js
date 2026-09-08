// @vitest-environment jsdom
/**
 * Fotos pedidas: con qué lista de rubros trabaja y qué productos muestra.
 *
 * Dos cosas que se pagaban caro y que no se ven mirando el código de a una:
 *
 * 1. La pantalla espeja con la lista de rubros que tiene en memoria. Si arranca
 *    con la de antes, cargar una foto BORRA el producto del espejo público: la
 *    dueña prende JUGUETERÍA en Configuración, pasa derecho acá a fotografiar
 *    uno de esos productos y lo saca de la tienda justo después de sacarle la
 *    foto, hasta la corrida siguiente del sync (seis horas). Configuración
 *    escribe el documento por REST y siembra el valor recién guardado en la
 *    memoria compartida del panel; el cache del SDK, en cambio, no se entera
 *    nunca — y acá se lo deja congelado a propósito, que es lo que pasa de
 *    verdad y lo que hace fallar la prueba si se vuelve a leer de ahí.
 *
 * 2. Lo marcado "publicar siempre" sale a la vidriera sin foto (el interruptor
 *    le gana al control de la foto). Esos son los que el cliente está viendo
 *    AHORA con el cuadrito gris, Tienda > Catálogo los cuenta en rojo, y sin
 *    embargo no figuraban en ninguna de las dos tablas de esta pantalla: se los
 *    venía a buscar acá y no estaban en ningún lado.
 *
 * Lo único que se reemplaza son las escrituras (catálogo, espejo, subir y
 * borrar foto): las reglas de qué se publica son las de producción.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { nube, cacheSdk, espia } = vi.hoisted(() => ({
  // Lo que hay en el servidor.
  nube: { catalogo: [], pedidas: [], publicacion: {}, tienda_productos: {} },
  // El cache local del SDK: la lista de rubros de antes, congelada.
  cacheSdk: { publicacion: null },
  espia: { espejo: vi.fn(), catalogo: vi.fn(), borradas: [], subidas: 0 },
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
  const unDoc = (ref, datos) => ({ exists: () => !!datos, data: () => datos, id: ref?.id });

  return {
    collection: (_db, nombre) => ({ _col: nombre }),
    doc: (_db, col, id) => ({ _col: col, id, path: `${col}/${id}` }),
    query: (col, ...partes) => ({ _col: col?._col, partes }),
    orderBy: (campo) => ({ campo }),
    limit: (n) => ({ limit: n }),
    where: (campo, op, valor) => ({ campo, op, valor }),
    getDocs: async (q) => instantanea(deColeccion(q?._col)),
    getDoc: async (ref) => (ref?._col === 'tienda_config'
      ? unDoc(ref, nube.publicacion)
      : unDoc(ref, nube.catalogo.find(d => d.doc_id === ref?.id))),
    getDocFromCache: async (ref) => {
      if (ref?._col === 'tienda_config' && cacheSdk.publicacion) {
        return unDoc(ref, cacheSdk.publicacion);
      }
      throw new Error('sin cache local');
    },
    onSnapshot: (q, alLlegar) => {
      try { alLlegar?.(instantanea(deColeccion(q?._col))); } catch (_) { /* nada */ }
      return () => {};
    },
    setDoc: async () => {},
    updateDoc: async () => {},
    deleteDoc: async () => {},
    writeBatch: () => ({ set: () => {}, update: () => {}, delete: () => {},
                         commit: async () => {} }),
    serverTimestamp: () => 'AHORA',
    deleteField: () => ({ _metodo: 'deleteField' }),
  };
});

vi.mock('../../webapp/src/tienda_espejo.js', async (original) => {
  const real = await original();
  return {
    ...real,
    actualizarDoc: async (_db, col, id, cambios) => {
      espia.catalogo(col, id, cambios);
      const producto = nube.catalogo.find(d => d.doc_id === id);
      if (producto) Object.assign(producto, cambios);
    },
    // El espejo de verdad: la misma regla de producción decide, y lo que queda
    // en `tienda_productos` es lo que vería el cliente.
    espejar: async (_db, id, datos, rubros, subExcluidos) => {
      const motivo = real.motivoDeNoPublicar(datos, rubros, subExcluidos);
      espia.espejo({ id, rubros: [...(rubros || [])], motivo });
      if (motivo) {
        delete nube.tienda_productos[id];
        return { publicado: false, motivo };
      }
      nube.tienda_productos[id] = {
        nombre: datos.nombre, imagenes: [...(datos.tienda_imagenes || [])],
      };
      return { publicado: true, motivo: null };
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

const { setCacheValue, invalidateCacheByPrefix } =
  await import('../../webapp/src/cache.js');
const { renderTiendaFotos } = await import('../../webapp/src/pages/tienda_fotos.js');

/* ── El catálogo de la prueba ─────────────────────────────────────────────── */

const base = { estado: 'activo', precio_venta: 1500, stock: 10 };

const CATALOGO = [
  // Le falta la foto y nada más: sale a la vidriera en cuanto se le cargue una.
  { ...base, doc_id: 'p1', nombre: 'TIJERA ESCOLAR', rubro: 'LIBRERIA',
    sub_rubro: 'ESCOLAR' },
  // De un rubro que se acaba de prender en Configuración.
  { ...base, doc_id: 'p2', nombre: 'PELOTA DE GOMA', rubro: 'JUGUETERIA',
    sub_rubro: 'PELOTAS' },
  // Marcado "publicar siempre": ya se está mostrando, con el cuadrito gris.
  { ...base, doc_id: 'p3', nombre: 'MOCHILA CHICA', rubro: 'LIBRERIA',
    sub_rubro: 'MOCHILAS', tienda_publicar: true },
  // Sin stock: no se publica ni con foto, así que no tiene nada que hacer acá.
  { ...base, doc_id: 'p4', nombre: 'REGLA 30 CM', rubro: 'LIBRERIA', stock: 0 },
  // Ya tiene foto.
  { ...base, doc_id: 'p5', nombre: 'CUADERNO RIVADAVIA', rubro: 'LIBRERIA',
    tienda_imagenes: ['https://x/vieja.webp'] },
];

let contenedor;

beforeEach(() => {
  localStorage.clear();
  invalidateCacheByPrefix('');
  espia.espejo.mockClear();
  espia.catalogo.mockClear();
  espia.borradas.length = 0;
  espia.subidas = 0;

  nube.catalogo = CATALOGO.map(d => structuredClone(d));
  nube.pedidas = [];
  nube.tienda_productos = {};
  // En el servidor JUGUETERÍA ya está prendida; el SDK sigue con la de antes.
  nube.publicacion = { rubros: ['LIBRERIA', 'JUGUETERIA'], subrubros_excluidos: {} };
  cacheSdk.publicacion = { rubros: ['LIBRERIA'], subrubros_excluidos: {} };

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
});

const respirar = async (vueltas = 12) => {
  for (let i = 0; i < vueltas; i++) await new Promise(r => setTimeout(r, 0));
};

async function montar() {
  await renderTiendaFotos(contenedor, {});
  await respirar();
}

/** Lo que hace Configuración al guardar: sembrar la lista recién escrita. */
function configuracionGuarda(rubros, subrubrosExcluidos = {}) {
  setCacheValue('tienda:publicacion', { rubros, subrubrosExcluidos });
}

const fila = (id) => contenedor.querySelector(`[data-fila="${id}"]`);

const dato = (texto) => [...contenedor.querySelectorAll('.tienda-dato')]
  .find(d => d.textContent.includes(texto));

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

async function guardarPanel() {
  document.querySelector('.tienda-overlay[data-panel-fotos] [data-accion="guardar"]').click();
  await respirar();
}

/* ── Las pruebas ──────────────────────────────────────────────────────────── */

describe('con qué lista de rubros trabaja la pantalla', () => {
  it('sin nada sembrado lee el documento y respeta lo que dice', async () => {
    // El SDK contesta primero (cache-first) con la lista de antes: JUGUETERÍA
    // no está, así que la pelota no espera foto, espera que la prendan.
    await montar();

    expect(fila('p1')).toBeTruthy();
    expect(fila('p2')).toBeFalsy();
  });

  it('usa la que acaba de guardar Configuración, no la que quedó en el SDK', async () => {
    configuracionGuarda(['LIBRERIA', 'JUGUETERIA']);
    await montar();

    expect(fila('p2'), 'la pelota no entró a la lista con el rubro ya prendido')
      .toBeTruthy();
  });

  it('cargarle la foto a un rubro recién prendido no lo saca de la tienda', async () => {
    // Marcada a mano desde la tienda, que es como se llega a esta fila.
    nube.pedidas = [{ doc_id: 'p2', nombre: 'PELOTA DE GOMA', rubro: 'JUGUETERIA' }];
    configuracionGuarda(['LIBRERIA', 'JUGUETERIA']);
    await montar();

    await cargarFoto('p2');
    await guardarPanel();

    const espejado = espia.espejo.mock.calls.at(-1)[0];
    expect(espejado.rubros).toContain('JUGUETERIA');
    expect(espejado.motivo).toBe(null);
    // Con la lista vieja, esto quedaba borrado del espejo y el producto
    // desaparecía de la tienda justo después de sacarle la foto.
    expect(nube.tienda_productos.p2).toBeTruthy();
    expect(nube.tienda_productos.p2.imagenes).toEqual(['https://x/subida-1.webp']);
  });

  it('apagar un rubro tampoco se pierde: deja de publicarse al guardar', async () => {
    nube.pedidas = [{ doc_id: 'p1', nombre: 'TIJERA ESCOLAR', rubro: 'LIBRERIA' }];
    configuracionGuarda([]);              // se destildaron todos los rubros
    await montar();

    await cargarFoto('p1');
    await guardarPanel();

    const espejado = espia.espejo.mock.calls.at(-1)[0];
    expect(espejado.motivo).toBe('el rubro no está habilitado');
    expect(nube.tienda_productos.p1).toBeFalsy();
  });
});

describe('lo que ya está en la vidriera sin foto', () => {
  it('entra a la lista aunque esté forzado a publicarse', async () => {
    await montar();

    const renglon = fila('p3');
    expect(renglon, 'el forzado a publicar no aparece en ninguna tabla').toBeTruthy();
    expect(renglon.textContent).toContain('En la vidriera');
  });

  it('se cuenta aparte de los que todavía no salieron', async () => {
    await montar();

    expect(dato('en la vidriera sin foto').querySelector('b').textContent).toBe('1');
    // La tijera es la única que espera foto para salir: la pelota está en un
    // rubro apagado y las otras dos ni entran.
    expect(dato('esperando foto para salir').querySelector('b').textContent).toBe('1');
  });

  it('va primero: es el que el cliente está viendo con el cuadrito gris', async () => {
    await montar();

    const filas = [...contenedor.querySelectorAll('#fotosTablaEsperando tbody tr')];
    expect(filas.map(f => f.dataset.fila)).toEqual(['p3', 'p1']);
  });

  it('cargarle la foto lo saca de la lista y la tienda queda con ella', async () => {
    await montar();
    await cargarFoto('p3');
    await guardarPanel();

    expect(fila('p3')).toBeFalsy();
    expect(nube.tienda_productos.p3.imagenes).toEqual(['https://x/subida-1.webp']);
    expect(espia.borradas).toEqual([]);
  });

  it('lo frenado por otra cosa no entra: una foto no lo va a publicar', async () => {
    await montar();

    expect(fila('p4'), 'sin stock no tiene nada que hacer en esta lista').toBeFalsy();
    expect(fila('p5'), 'ya tiene foto').toBeFalsy();
  });

  it('el que todavía no sale lo dice, y no se hace pasar por publicado', async () => {
    await montar();

    expect(fila('p1').textContent).toContain('Todavía no sale');
    expect(fila('p1').textContent).not.toContain('En la vidriera');
  });
});
