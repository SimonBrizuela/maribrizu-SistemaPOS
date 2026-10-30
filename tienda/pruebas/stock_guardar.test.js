/**
 * La transacción que guarda stock desde el panel.
 *
 * Firestore reintenta una transacción si el documento cambió entre la lectura
 * y la escritura (justo lo que pasa cuando el POS vende en ese instante). En
 * cada vuelta hay que rearmar con el número nuevo, y el movimiento del
 * historial tiene que quedar UNA vez, con el antes y el después de la vuelta
 * que se escribió.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { nube } = vi.hoisted(() => ({
  nube: { lecturas: [], vuelta: 0, confirmadas: [], refsMov: new Set() },
}));

vi.mock('firebase/firestore', () => ({
  doc: (_db, col, id) => ({ _col: col, id }),
  collection: (_db, nombre) => ({ _col: nombre }),
  addDoc: async () => ({ id: 'x' }),
  query: () => ({}), where: () => ({}), orderBy: () => ({}), limit: () => ({}),
  getDocs: async () => ({ docs: [] }),
  serverTimestamp: () => 'AHORA',
  // Corre el callback una vez por cada lectura preparada: las primeras
  // "pierden" contra otra escritura y sólo la última se confirma, como el SDK.
  runTransaction: async (_db, fn) => {
    let resultado;
    for (let i = 0; i < nube.lecturas.length; i++) {
      const escrituras = [];
      const d = nube.lecturas[i];
      resultado = await fn({
        get: async () => ({ exists: () => d !== null, data: () => ({ ...d }) }),
        update: (ref, datos) => escrituras.push({ tipo: 'update', ref, datos }),
        set: (ref, datos) => { escrituras.push({ tipo: 'set', ref, datos }); nube.refsMov.add(ref.id); },
      });
      if (i === nube.lecturas.length - 1) nube.confirmadas.push(...escrituras);
    }
    return resultado;
  },
}));
vi.mock('../../webapp/src/auth.js', () => ({
  auth: { currentUser: { displayName: 'Mari' } },
}));

const { escribirReleyendo, escribirPreguntando, ProductoNoExiste } =
  await import('../../webapp/src/stock_guardar.js');
const { resolverGuardado, aplicarPlan } = await import('../../webapp/src/stock_concurrencia.js');

beforeEach(() => {
  nube.lecturas = [];
  nube.confirmadas = [];
  nube.refsMov = new Set();
});

/** Lo que arma la celda de stock: el usuario pasó de 12 a 20. */
const armarCelda = (decision) => (n, dec = decision) => {
  const plan = resolverGuardado({
    inicial: { stock: 12 }, escrito: { stock: 20 }, visto: { stock: 12 }, nube: n, decision: dec,
  });
  return {
    plan,
    datos: { ...aplicarPlan({}, plan), ultima_actualizacion: 'AHORA' },
    movimiento: { nombre: 'GOMA EVA', motivo: 'edicion_manual', detalle: 'Celda' },
  };
};

describe('una venta justo mientras se guarda', () => {
  it('la vuelta que se confirma es la que manda, y el movimiento queda una vez', async () => {
    // Primera lectura: 12 (como lo vio). Reintento: el POS vendió 2.
    nube.lecturas = [{ stock: 12 }, { stock: 10 }];
    const r = await escribirReleyendo({}, 'p1', armarCelda('sumar'));

    const upd = nube.confirmadas.filter(e => e.tipo === 'update');
    const mov = nube.confirmadas.filter(e => e.tipo === 'set');
    expect(upd).toHaveLength(1);
    expect(upd[0].datos.stock).toBe(18);
    expect(mov).toHaveLength(1);
    expect(mov[0].datos).toMatchObject({ stock_antes: 10, stock_despues: 18, cantidad: 8, firebase_id: 'p1' });
    // Las dos vueltas usaron el mismo documento de movimiento: un reintento no duplica.
    expect(nube.refsMov.size).toBe(1);
    expect(r.plan.despues).toBe(18);
  });

  it('si hace falta preguntar, no escribe nada', async () => {
    nube.lecturas = [{ stock: 10 }];
    const r = await escribirReleyendo({}, 'p1', armarCelda(null));
    expect(r.pregunta).toBeTruthy();
    expect(nube.confirmadas).toEqual([]);
  });

  it('un producto borrado en otra pantalla no se resucita', async () => {
    nube.lecturas = [null];
    await expect(escribirReleyendo({}, 'p1', armarCelda(null))).rejects.toBeInstanceOf(ProductoNoExiste);
  });
});

describe('preguntar y guardar', () => {
  it('pregunta con los números de la nube y guarda lo elegido', async () => {
    nube.lecturas = [{ stock: 10 }];
    const preguntar = vi.fn(async (plan) => {
      expect(plan.resumen).toMatchObject({ visto: 12, nube: 10, sumado: 18, literal: 20 });
      return 'literal';
    });
    const r = await escribirPreguntando({}, 'p1', (n, dec) => armarCelda(null)(n, dec), preguntar);
    expect(preguntar).toHaveBeenCalledTimes(1);
    expect(r.datos.stock).toBe(20);
    const mov = nube.confirmadas.find(e => e.tipo === 'set');
    expect(mov.datos.detalle).toBe('Celda');
  });

  it('"volver sin guardar" no escribe nada', async () => {
    nube.lecturas = [{ stock: 10 }];
    const r = await escribirPreguntando({}, 'p1', (n, dec) => armarCelda(null)(n, dec), async () => null);
    expect(r).toBeNull();
    expect(nube.confirmadas).toEqual([]);
  });

  it('sin carrera no pregunta', async () => {
    nube.lecturas = [{ stock: 12 }];
    const preguntar = vi.fn();
    const r = await escribirPreguntando({}, 'p1', (n, dec) => armarCelda(null)(n, dec), preguntar);
    expect(preguntar).not.toHaveBeenCalled();
    expect(r.datos.stock).toBe(20);
  });
});

describe('quién movió', () => {
  it('cada movimiento lleva la pestaña, el navegador y el equipo', async () => {
    nube.lecturas = [{ stock: 12 }];
    await escribirReleyendo({}, 'p1', armarCelda(null));
    const mov = nube.confirmadas.find(e => e.tipo === 'set');
    expect(mov.datos.pc_id).toBe('webapp');
    expect(mov.datos).toHaveProperty('panel_pestana');
    expect(mov.datos).toHaveProperty('panel_navegador');
    expect(typeof mov.datos.panel_agente).toBe('string');
    expect(mov.ref.id.startsWith('webapp_')).toBe(true);
  });
});
