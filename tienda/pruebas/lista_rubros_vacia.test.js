/**
 * Una lectura fallida de la configuración no puede vaciar la tienda.
 *
 * `leerDocRapido` devuelve `{}` cuando no pudo leer `tienda_config/publicacion`
 * (sin red, caché frío, permisos), y las tres pantallas que espejan traducen
 * eso a `rubros: []`. Con la lista vacía la regla contesta "el rubro no está
 * habilitado" para todos los productos, y como desde el 2026-09-08 cada
 * guardado borra del espejo lo que no corresponde publicar, cargar una foto en
 * ese estado sacaba el producto de la vidriera. Guardando varios, la tienda se
 * vaciaba de a uno, y recién volvía con la corrida siguiente del sync.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../webapp/src/auth.js', () => ({ auth: { currentUser: null } }));

const lote = { update: vi.fn(), set: vi.fn(), delete: vi.fn(), commit: vi.fn(async () => {}) };

vi.mock('firebase/firestore', () => ({
  doc: (_db, col, id) => ({ col, id }),
  getDoc: vi.fn(async () => ({ exists: () => false, data: () => undefined })),
  getDocFromCache: vi.fn(), collection: vi.fn(), query: vi.fn(), orderBy: vi.fn(),
  limit: vi.fn(), where: vi.fn(), getDocs: vi.fn(async () => ({ docs: [] })),
  writeBatch: () => lote,
  updateDoc: vi.fn(async () => {}), deleteDoc: vi.fn(async () => {}),
  serverTimestamp: () => ({ _methodName: 'serverTimestamp' }),
  deleteField: () => ({ _methodName: 'deleteField' }),
}));

import { espejar, espejarLote, motivoDeNoPublicar } from '../../webapp/src/tienda_espejo.js';

const db = {};

const CUADERNO = {
  doc_id: 'p1', nombre: 'CUADERNO RIVADAVIA', estado: 'activo',
  precio_venta: 3500, stock: 12, rubro: 'LIBRERÍA', sub_rubro: 'CUADERNOS',
  tienda_imagenes: ['foto.webp'],
};

/** Los borrados que se mandaron al espejo, por id. */
const borrados = () => [
  ...lote.delete.mock.calls.filter(([r]) => r.col === 'tienda_productos').map(([r]) => r.id),
  ...lote.set.mock.calls.filter(([r]) => r.col === 'tienda_productos').map(([r]) => r.id),
];

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => { throw new Error('sin red'); });
  lote.set.mockClear(); lote.update.mockClear(); lote.delete.mockClear(); lote.commit.mockClear();
});

describe('la lista de rubros vacía no toca el espejo', () => {
  it('espejar no borra el producto y dice que no pudo leer la configuración', async () => {
    const r = await espejar(db, 'p1', CUADERNO, []);

    expect(r.publicado).toBe(false);
    expect(r.motivo).toMatch(/no se pudo leer/i);
    // Lo que importa: NO se tocó el espejo.
    expect(borrados()).toEqual([]);
    expect(lote.commit).not.toHaveBeenCalled();
  });

  it('el lote entero se niega en vez de vaciar la tienda de a uno', async () => {
    const productos = [
      { id: 'p1', datos: CUADERNO },
      { id: 'p2', datos: { ...CUADERNO, doc_id: 'p2', nombre: 'LAPIZ' } },
    ];

    await expect(espejarLote(db, productos, [])).rejects.toThrow(/no se pudo leer/i);
    expect(borrados()).toEqual([]);
  });

  it('con la lista de verdad sigue borrando lo que no corresponde publicar', async () => {
    // Un rubro que existe y no incluye al del producto: eso SÍ es una decisión
    // tomada, y el producto tiene que salir de la vidriera.
    const r = await espejar(db, 'p1', CUADERNO, ['PAPELERA']);

    expect(r.publicado).toBe(false);
    expect(r.motivo).toBe('el rubro no está habilitado');
    expect(lote.delete).toHaveBeenCalledWith({ col: 'tienda_productos', id: 'p1' });
  });

  it('sin lista (null) sigue significando "contestame por el resto de las reglas"', async () => {
    // Es como pregunta quien quiere saber por qué un producto no está en la
    // tienda, y no tiene nada que ver con una lectura fallida.
    expect(motivoDeNoPublicar(CUADERNO, null)).toBeNull();
  });
});
