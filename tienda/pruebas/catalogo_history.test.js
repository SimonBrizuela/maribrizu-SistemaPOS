// @vitest-environment jsdom
/**
 * Deshacer y rehacer en el Catálogo.
 *
 * Es lo más peligroso del panel: cada deshacer ESCRIBE en Firestore. Si guarda
 * mal el "antes", deshacer no vuelve al valor viejo — pisa el producto con otra
 * cosa, y encima con la tranquilidad de quien cree que lo dejó como estaba.
 *
 * Los tres casos que tienen que salir bien sí o sí:
 *   · un cambio de precio: deshacer escribe el precio anterior, no cualquier otro;
 *   · deshacer un borrado: recrea el producto Y levanta la lápida — si la lápida
 *     queda, el producto existe en el panel y el POS no lo ve nunca
 *     (es el bug de los códigos reciclados, ya vivido);
 *   · deshacer un alta: borra el producto Y deja la lápida puesta.
 *
 * El historial vive en localStorage, así que sobrevive al F5. Eso también se
 * prueba: se levanta una instancia nueva y tiene que poder deshacer lo de antes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { escrituras } = vi.hoisted(() => ({ escrituras: [] }));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  return firestoreFalso({ registro: escrituras });
});
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {} }));

const { initCatalogoHistory, fieldLabel } =
  await import('../../webapp/src/catalogo_history.js');

/** El catálogo vivo en memoria, como lo tiene la página. */
let catalogo;

/** Arma un gestor de historial con el catálogo de arriba. */
function armar(extra = {}) {
  return initCatalogoHistory({
    db: {},
    getProducto: id => catalogo[id],
    applyToMemory: (id, op) => {
      if (op.remove) delete catalogo[id];
      else if (op.recreate) catalogo[id] = { ...op.recreate };
      else Object.assign(catalogo[id] ||= {}, op.fields);
    },
    refreshUI: () => {},
    registerDeleted: async () => { escrituras.push({ tipo: 'lapida', ref: null, datos: null }); },
    touchMeta: async () => {},
    ...extra,
  });
}

/** Filtra el registro por colección. */
const enColeccion = (col) => escrituras.filter(e => e.ref?._col === col);

beforeEach(() => {
  localStorage.clear();
  escrituras.length = 0;
  document.body.innerHTML = '';
  catalogo = {
    p1: { doc_id: 'p1', id: 501, nombre: 'CUADERNO RIVADAVIA', precio_venta: 1000, stock: 8, costo: 600 },
    p2: { doc_id: 'p2', id: 502, nombre: 'LAPIZ FABER', precio_venta: 300, stock: 40 },
  };
});

describe('el nombre que se le muestra a cada campo', () => {
  it('los conocidos salen en castellano', () => {
    expect(fieldLabel('precio_venta')).toBe('Precio');
    expect(fieldLabel('sub_rubro')).toBe('Sub-rubro');
    expect(fieldLabel('conjunto_total')).toBe('Total conjunto');
  });

  it('uno que no está en la lista se muestra tal cual, no vacío', () => {
    expect(fieldLabel('campo_nuevo')).toBe('campo_nuevo');
  });
});

describe('cambiar un precio y deshacerlo', () => {
  it('el cambio escribe sólo el campo tocado', async () => {
    const h = armar();
    await h.commitFields(catalogo.p1, { precio_venta: 1500 }, { label: 'Precio' });

    const w = enColeccion('catalogo').at(-1);
    expect(w.tipo).toBe('update');
    expect(w.ref.id).toBe('p1');
    expect(w.datos.precio_venta).toBe(1500);
    expect(w.datos.stock).toBeUndefined();       // no se pisa lo que nadie tocó
    expect(catalogo.p1.precio_venta).toBe(1500);
  });

  it('deshacer escribe el precio que había antes', async () => {
    const h = armar();
    await h.commitFields(catalogo.p1, { precio_venta: 1500 }, { label: 'Precio' });
    escrituras.length = 0;

    await h.undo();

    const w = enColeccion('catalogo').at(-1);
    expect(w.datos.precio_venta).toBe(1000);
    expect(catalogo.p1.precio_venta).toBe(1000);
  });

  it('rehacer lo vuelve a poner', async () => {
    const h = armar();
    await h.commitFields(catalogo.p1, { precio_venta: 1500 }, { label: 'Precio' });
    await h.undo();
    await h.redo();
    expect(catalogo.p1.precio_venta).toBe(1500);
  });

  it('un campo que el producto no tenía se deshace a nada, no a cero', async () => {
    // Poner 0 en un stock mínimo que nunca existió lo convierte en una regla
    // real y el producto empieza a avisar solo.
    const h = armar();
    await h.commitFields(catalogo.p1, { stock_min: 5 }, { label: 'Mínimo' });
    escrituras.length = 0;
    await h.undo();
    expect(enColeccion('catalogo').at(-1).datos.stock_min).toBeNull();
  });

  it('hacer algo nuevo después de deshacer cancela el rehacer', async () => {
    const h = armar();
    await h.commitFields(catalogo.p1, { precio_venta: 1500 }, { label: 'A' });
    await h.undo();
    await h.commitFields(catalogo.p1, { precio_venta: 1800 }, { label: 'B' });

    expect(await h.redo()).toBeNull();
    expect(catalogo.p1.precio_venta).toBe(1800);
  });

  it('deshacer con el historial vacío no hace nada ni escribe', async () => {
    const h = armar();
    expect(await h.undo()).toBeNull();
    expect(escrituras.length).toBe(0);
  });
});

describe('deshacer un borrado', () => {
  it('recrea el producto entero', async () => {
    const h = armar();
    const borrado = { ...catalogo.p1 };
    h.recordDelete(borrado, { label: 'Borrar' });
    delete catalogo.p1;                            // el borrado lo hizo la página
    escrituras.length = 0;

    await h.undo();

    const alta = enColeccion('catalogo').find(e => e.tipo === 'set');
    expect(alta).toBeTruthy();
    expect(alta.datos.nombre).toBe('CUADERNO RIVADAVIA');
    expect(alta.datos.precio_venta).toBe(1000);
    expect(catalogo.p1).toBeTruthy();
  });

  it('y levanta la lápida, o el POS no vuelve a ver el producto', async () => {
    // Sin esto el producto vuelve al panel pero sigue marcado como borrado: la
    // caja no lo encuentra al escanearlo y nadie entiende por qué.
    const h = armar();
    h.recordDelete({ ...catalogo.p1 }, { label: 'Borrar' });
    delete catalogo.p1;
    escrituras.length = 0;

    await h.undo();

    const lapida = enColeccion('catalogo_deleted').find(e => e.tipo === 'delete');
    expect(lapida, 'la lápida tiene que borrarse al recrear').toBeTruthy();
    expect(lapida.ref.id).toBe('p1');
  });

  it('rehacer el borrado lo vuelve a sacar', async () => {
    const h = armar();
    h.recordDelete({ ...catalogo.p1 }, { label: 'Borrar' });
    delete catalogo.p1;
    await h.undo();
    escrituras.length = 0;

    await h.redo();
    expect(enColeccion('catalogo').some(e => e.tipo === 'delete')).toBe(true);
    expect(catalogo.p1).toBeUndefined();
  });

  it('deshacer un borrado masivo va en lotes y recrea todo', async () => {
    const h = armar();
    const cambios = [];
    for (let i = 0; i < 300; i++) {
      cambios.push({ docId: `x${i}`, invId: null, syncInv: false,
                     before: { doc_id: `x${i}`, nombre: `PROD ${i}`, precio_venta: 100 }, after: null });
    }
    h.recordBatch(cambios, { label: '300 borrados' });
    escrituras.length = 0;

    await h.undo();

    const recreados = escrituras.filter(e => e.tipo === 'batch-set' && e.ref?._col === 'catalogo');
    expect(recreados.length).toBe(300);
    const lapidas = escrituras.filter(e => e.tipo === 'batch-delete' && e.ref?._col === 'catalogo_deleted');
    expect(lapidas.length).toBe(300);
  });
});

describe('deshacer un alta', () => {
  it('borra el producto y deja la lápida puesta', async () => {
    const h = armar();
    catalogo.p9 = { doc_id: 'p9', nombre: 'PRODUCTO NUEVO', precio_venta: 700 };
    h.recordCreate('p9', catalogo.p9, { label: 'Crear' });
    escrituras.length = 0;

    await h.undo();

    expect(enColeccion('catalogo').some(e => e.tipo === 'delete' && e.ref.id === 'p9')).toBe(true);
    expect(escrituras.some(e => e.tipo === 'lapida')).toBe(true);
    expect(catalogo.p9).toBeUndefined();
  });
});

describe('inventario del POS', () => {
  it('deshacer un precio con sync también corrige el inventario', async () => {
    const h = armar();
    await h.commitFields(catalogo.p1, { precio_venta: 1500 }, { label: 'Precio', syncInv: true });
    escrituras.length = 0;

    await h.undo();

    const inv = enColeccion('inventario').at(-1);
    expect(inv).toBeTruthy();
    expect(inv.datos.precio).toBe(1000);
    expect(inv.datos.id).toBe(501);
  });

  it('un cambio que no toca precio/stock/costo no escribe inventario', async () => {
    const h = armar();
    await h.commitFields(catalogo.p1, { marca: 'RIVADAVIA' }, { label: 'Marca', syncInv: true });
    expect(enColeccion('inventario').length).toBe(0);
  });
});

describe('varios pasos de una', () => {
  it('undoTo desarma todo hasta el paso elegido, inclusive', async () => {
    const h = armar();
    const primera = await h.commitFields(catalogo.p1, { precio_venta: 1100 }, { label: 'A' });
    await h.commitFields(catalogo.p1, { precio_venta: 1200 }, { label: 'B' });
    await h.commitFields(catalogo.p1, { precio_venta: 1300 }, { label: 'C' });

    await h.undoTo(primera.id);

    expect(catalogo.p1.precio_venta).toBe(1000);   // el valor original
    expect(h.canUndo()).toBe(false);
  });

  it('undoTo con un paso que ya no está no rompe ni deshace de más', async () => {
    const h = armar();
    await h.commitFields(catalogo.p1, { precio_venta: 1100 }, { label: 'A' });
    await h.undoTo(99999);
    expect(catalogo.p1.precio_venta).toBe(1100);
  });
});

describe('el historial sobrevive al F5', () => {
  it('una instancia nueva puede deshacer lo de la sesión anterior', async () => {
    const h1 = armar();
    await h1.commitFields(catalogo.p1, { precio_venta: 1500 }, { label: 'Precio' });
    expect(h1.pendingCount()).toBe(1);

    const h2 = armar();                    // como si se recargara la página
    expect(h2.pendingCount()).toBe(1);
    escrituras.length = 0;
    await h2.undo();
    expect(catalogo.p1.precio_venta).toBe(1000);
  });

  it('un localStorage corrupto arranca vacío en vez de romper la página', () => {
    localStorage.setItem('pos_catalogo_history_v1', '{esto no es json');
    const h = armar();
    expect(h.pendingCount()).toBe(0);
    expect(h.canUndo()).toBe(false);
  });

  it('el historial no crece sin techo', async () => {
    const h = armar();
    for (let i = 0; i < 95; i++) {
      await h.commitFields(catalogo.p2, { precio_venta: 300 + i }, { label: `P${i}` });
    }
    expect(h.pendingCount()).toBeLessThanOrEqual(80);
  });
});

describe('los atajos de teclado', () => {
  it('Ctrl+Z deshace', async () => {
    const h = armar();
    h.attachKeyboard();
    await h.commitFields(catalogo.p1, { precio_venta: 1500 }, { label: 'Precio' });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 0));

    expect(catalogo.p1.precio_venta).toBe(1000);
    h.detachKeyboard();
  });

  it('escribiendo en un campo, Ctrl+Z es el del navegador y no toca el catálogo', async () => {
    // Deshacer una letra mal tipeada no puede revertir el precio de un producto.
    const h = armar();
    h.attachKeyboard();
    await h.commitFields(catalogo.p1, { precio_venta: 1500 }, { label: 'Precio' });

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 0));

    expect(catalogo.p1.precio_venta).toBe(1500);
    h.detachKeyboard();
  });

  it('fuera de la página del catálogo el atajo no hace nada', async () => {
    const h = armar({ isActive: () => false });
    h.attachKeyboard();
    await h.commitFields(catalogo.p1, { precio_venta: 1500 }, { label: 'Precio' });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 0));

    expect(catalogo.p1.precio_venta).toBe(1500);
    h.detachKeyboard();
  });

  it('soltar el teclado no deja el handler de la instancia anterior colgado', async () => {
    // Al entrar y salir del catálogo se crea una instancia nueva cada vez: sin
    // esto se acumulan handlers y un Ctrl+Z deshace varios pasos de golpe.
    const h1 = armar();
    h1.attachKeyboard();
    h1.detachKeyboard();
    const h2 = armar();
    h2.attachKeyboard();

    await h2.commitFields(catalogo.p1, { precio_venta: 1500 }, { label: 'Precio' });
    await h2.commitFields(catalogo.p1, { precio_venta: 1900 }, { label: 'Precio 2' });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 0));

    expect(catalogo.p1.precio_venta).toBe(1500);   // un solo paso, no dos
    h2.detachKeyboard();
  });
});

describe('el panel de historial', () => {
  it('se abre, lista lo hecho y se cierra', async () => {
    const h = armar();
    await h.commitFields(catalogo.p1, { precio_venta: 1500 }, { label: 'Cambio de precio' });

    h.openPanel();
    expect(document.querySelector('.hist-overlay').textContent).toContain('Cambio de precio');

    h.closePanel();
    expect(document.querySelector('#hist-close')).toBeNull();
  });

  it('abrirlo dos veces no deja dos paneles encimados', async () => {
    const h = armar();
    await h.commitFields(catalogo.p1, { precio_venta: 1500 }, { label: 'X' });
    h.openPanel();
    h.openPanel();
    expect(document.querySelectorAll('#hist-close').length).toBe(1);
    h.closePanel();
  });

  it('el nombre de un producto no se cuela como HTML', async () => {
    const h = armar();
    catalogo.p1.nombre = '<img src=x onerror=alert(1)>';
    h.recordDelete({ ...catalogo.p1 }, {});
    h.openPanel();
    expect(document.querySelector('#hist-panel img, .hist-panel img')).toBeNull();
    expect(document.body.innerHTML).toContain('&lt;img');
    h.closePanel();
  });
});

describe('el aviso con el botón de deshacer', () => {
  it('el botón del cartel deshace el cambio recién hecho', async () => {
    const h = armar();
    await h.commitFields(catalogo.p1, { precio_venta: 1500 }, { label: 'Precio' });

    const btn = [...document.querySelectorAll('button')].find(b => /deshacer/i.test(b.textContent));
    expect(btn, 'el cartel tiene que ofrecer deshacer').toBeTruthy();
    btn.click();
    await new Promise(r => setTimeout(r, 0));

    expect(catalogo.p1.precio_venta).toBe(1000);
  });
});
