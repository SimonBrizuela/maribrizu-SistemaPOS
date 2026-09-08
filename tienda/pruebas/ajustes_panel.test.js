// @vitest-environment jsdom
/**
 * Lo que la pantalla de Configuración de la tienda promete.
 *
 * Los interruptores de "toma pedidos" y "aceptar efectivo" no llegan a la
 * tienda en el momento: las funciones del servidor cachean la configuración
 * cinco minutos por instancia y la tienda la lee una vez por sesión. La
 * pantalla decía "al instante", y quien apagaba el efectivo y probaba desde
 * el celular veía que seguía ahí y volvía a tocar el interruptor.
 *
 * No se tocan los cachés: se prueba que el texto diga lo que pasa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { datos } = vi.hoisted(() => ({
  datos: { porColeccion: {}, escrituras: [] },
}));

vi.mock('firebase/firestore', async () => {
  const { firestoreFalso } = await import('./firestore_falso.js');
  const base = firestoreFalso({ registro: datos.escrituras });
  const snapshot = (nombre) => {
    const lista = datos.porColeccion[nombre] || [];
    return {
      docs: lista.map((d, i) => ({
        id: d.__id || `doc${i}`, ref: { id: d.__id || `doc${i}` },
        data: () => d, exists: () => true,
      })),
      empty: lista.length === 0, size: lista.length, docChanges: () => [],
      forEach(fn) { this.docs.forEach(fn); },
    };
  };
  return {
    ...base,
    collection: (_db, nombre) => ({ _col: nombre }),
    query: (col, ...partes) => ({ _col: col?._col, partes }),
    getDocs: async (q) => snapshot(q?._col || q?.col?._col),
    getDoc: async (ref) => {
      const lista = datos.porColeccion[ref?._col] || [];
      const encontrado = lista.find(d => (d.__id || '') === ref?.id);
      return { exists: () => !!encontrado, data: () => encontrado, id: ref?.id || 'x' };
    },
    getDocFromCache: async () => { throw new Error('sin cache local'); },
    onSnapshot: (q, cb) => {
      try { cb?.(snapshot(q?._col || q?.col?._col)); } catch (_) {}
      return () => {};
    },
  };
});
vi.mock('../../webapp/src/firebase.js', () => ({ db: {}, app: {}, storage: {} }));
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

let contenedor;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  datos.escrituras.length = 0;
  datos.porColeccion = {
    catalogo: [],
    tienda_config: [
      { __id: 'settings', abierta: true, pago: { efectivo_habilitado: true } },
      { __id: 'publicacion', rubros: ['LIBRERIA'] },
    ],
  };
  document.body.innerHTML = '';
  contenedor = document.createElement('div');
  contenedor.id = 'content';
  document.body.appendChild(contenedor);
});

const esperar = (ms = 0) => new Promise(r => setTimeout(r, ms));

async function montar() {
  const mod = await import('../../webapp/src/pages/tienda_ajustes.js');
  await mod.renderTiendaAjustes(contenedor, {});
  for (let i = 0; i < 10; i++) await esperar();
  return contenedor;
}

describe('lo que prometen los interruptores', () => {
  it('"toma pedidos" avisa que tarda unos minutos en llegar a la tienda', async () => {
    await montar();
    const texto = document.getElementById('cfgAbierta').closest('label').textContent;
    expect(texto).toMatch(/no se puede confirmar un pedido/);
    expect(texto).toMatch(/unos minutos/);
    expect(texto).toMatch(/recargar/);
  });

  it('"aceptar efectivo" no dice "al instante"', async () => {
    await montar();
    const bloque = document.getElementById('cfgEfectivo').closest('section').textContent;
    expect(bloque).not.toMatch(/al instante/);
    expect(bloque).toMatch(/unos minutos/);
    expect(bloque).toMatch(/recargar/);
  });
});

/**
 * La bajada de "Rubros en la tienda".
 *
 * Decía que un producto suelto se podía forzar o sacar desde el catálogo de la
 * tienda "sin tocar el rubro entero". Desde el 2026-09-08 el rubro apagado le
 * gana a la marca de la ficha, así que la dueña destildó Cotillón, leyó esta
 * bajada, fue al catálogo a poner "Publicar siempre" en las tres cosas que
 * igual quería dejar, y no salió ninguna: el editor de la ficha le avisaba lo
 * contrario que esta pantalla. Se comparan las dos cosas, el texto y la regla.
 */
describe('la bajada de los rubros', () => {
  async function bajadaDeRubros() {
    const c = await montar();
    const seccion = [...c.querySelectorAll('section')]
      .find(s => s.querySelector('h4')?.textContent.includes('Rubros en la tienda'));
    expect(seccion).toBeTruthy();
    return seccion.querySelector('.tienda-pista').textContent.replace(/\s+/g, ' ').trim();
  }

  it('no promete forzar un producto suelto con el rubro apagado', async () => {
    const pista = await bajadaDeRubros();
    expect(pista).not.toMatch(/sin tocar el rubro entero/);
    expect(pista).toMatch(/el rubro apagado no publica nada/);
    expect(pista).toMatch(/Publicar siempre/);
  });

  it('lo que promete es lo que hace la regla del espejo', async () => {
    const pista = await bajadaDeRubros();
    const { motivoDeNoPublicar } = await import('../../webapp/src/tienda_espejo.js');
    const bengala = {
      nombre: 'BENGALA FANTASIA', rubro: 'COTILLON', sub_rubro: 'BENGALAS',
      estado: 'activo', stock: 14, precio_venta: 1200,
      tienda_publicar: true, tienda_imagenes: ['d.webp'],
    };

    // "el rubro apagado no publica nada, ni lo marcado con Publicar siempre"
    expect(motivoDeNoPublicar(bengala, ['LIBRERIA']))
      .toBe('el rubro no está habilitado');

    // "o forzarlo dentro de un rubro prendido": ahí sí le gana al subrubro
    // destildado, que es el único lugar donde la marca sirve.
    expect(pista).toMatch(/dentro de un rubro prendido/);
    expect(motivoDeNoPublicar(bengala, ['LIBRERIA', 'COTILLON'],
                              { COTILLON: ['BENGALAS'] })).toBe(null);

    // "se puede sacar un producto suelto": eso sigue andando con el rubro
    // prendido, y es lo único que la bajada manda a hacer al catálogo.
    expect(pista).toMatch(/sacar un producto suelto/);
    expect(motivoDeNoPublicar({ ...bengala, tienda_publicar: false },
                              ['LIBRERIA', 'COTILLON'])).toBe('excluido a mano');
  });
});
