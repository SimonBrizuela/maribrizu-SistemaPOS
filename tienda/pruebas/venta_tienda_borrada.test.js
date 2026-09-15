/**
 * Borrar desde Ventas una venta que vino de la tienda tiene que dejar el stock
 * exactamente como estaba antes de entregar el pedido.
 *
 * Pasó el 15-09 con un pedido de prueba: una caja de 50 Bic negras entregada
 * desde el panel. Borrar esa venta desde Ventas no devolvía nada:
 *   · los renglones se buscaban con `num_venta` como número y la tienda lo
 *     guarda como texto (el código del pedido, "Y73U"): no aparecía ninguno,
 *     no se devolvía stock y el renglón seguía contando en el balance;
 *   · y aunque aparecieran, la cantidad salía del nombre del renglón, como en
 *     el POS ("· 1 Caja"). El de la tienda no lo lleva: trae `es_pack` y
 *     `pack_contenido`, así que devolvía 1 unidad en vez de 50.
 *
 * La prueba entrega con la cuenta real de `pedido_venta.js` (la misma que usa
 * el panel al tocar "Entregado") y borra con la de `stock_revert.js`: si las
 * dos no son inversas, el stock no vuelve a su lugar.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const nube = vi.hoisted(() => ({ datos: {}, movimientos: [] }));

vi.mock('firebase/firestore', () => {
  const { datos } = nube;
  const snap = (col, id) => ({
    id, ref: { col, id },
    exists: () => datos[col]?.[id] !== undefined,
    data: () => datos[col]?.[id],
  });
  const aplicar = (ref, cambios, merge = true) => {
    datos[ref.col] ||= {};
    const actual = merge ? { ...(datos[ref.col][ref.id] || {}) } : {};
    for (const [k, v] of Object.entries(cambios)) {
      actual[k] = v && typeof v === 'object' && '_incremento' in v ? (Number(actual[k]) || 0) + v._incremento : v;
    }
    datos[ref.col][ref.id] = actual;
  };
  const cumple = (d, filtros) => filtros.every(({ campo, op, valor }) =>
    (op === '==' ? d[campo] === valor : op === 'in' ? valor.includes(d[campo]) : false));
  return {
    doc: (_db, col, id) => ({ col, id }),
    collection: (_db, col) => ({ col }),
    where: (campo, op, valor) => ({ campo, op, valor }),
    query: (ref, ...filtros) => ({ col: ref.col, filtros }),
    getDocs: async (q) => ({
      docs: Object.keys(datos[q.col] || {})
        .filter(id => cumple(datos[q.col][id], q.filtros || []))
        .map(id => snap(q.col, id)),
    }),
    writeBatch: () => {
      const ops = [];
      return {
        set: (ref, cambios, opciones) => ops.push([ref, cambios, !!opciones?.merge]),
        update: (ref, cambios) => ops.push([ref, cambios, true]),
        commit: async () => ops.forEach(([r, c, m]) => aplicar(r, c, m)),
      };
    },
    runTransaction: async (_db, fn) => {
      const ops = [];
      await fn({
        get: async (ref) => snap(ref.col, ref.id),
        set: (ref, cambios, opciones) => ops.push([ref, cambios, !!opciones?.merge]),
      });
      ops.forEach(([r, c, m]) => aplicar(r, c, m));
    },
    setDoc: async (ref, cambios, opciones) => aplicar(ref, cambios, !!opciones?.merge),
    serverTimestamp: () => 'AHORA',
    increment: (n) => ({ _incremento: n }),
  };
});
vi.mock('../../webapp/src/cache.js', () => ({
  getCached: async (_clave, traer) => traer(), invalidateCacheByPrefix: () => {},
}));
vi.mock('../../webapp/src/stock_ledger.js', () => ({
  registrarMovimiento: (_db, m) => { nube.movimientos.push(m); },
}));
// El espejo de la tienda tiene sus propias pruebas (stock_revert_tienda.test.js).
vi.mock('../../webapp/src/tienda_espejo.js', () => ({
  espejar: async () => ({ publicado: false }),
  leerPublicacion: async () => ({ rubros: null }),
  programarRecuentoDeRubros: () => {},
}));

import { planDescuento, documentosDeVenta } from '../../webapp/src/pedido_venta.js';
import { revertirStockVenta, itemsDeLaVenta } from '../../webapp/src/stock_revert.js';

const db = {};
const { datos } = nube;

// El caso real: un conjunto con variedades vendido por caja cerrada.
const BIC = {
  nombre: 'BOLIGRAFO BIC 1 MM TRAZO GRUESO', es_conjunto: true, conjunto_tipo: 'caja', conjunto_contenido: 50,
  conjunto_colores: [
    { color: 'Azul', unidades: 10, restante: 26 },
    { color: 'Negra', unidades: 7, restante: 42 },
  ],
  conjunto_total: 918, conjunto_unidades: 17, conjunto_restante: 68, stock: 918,
};
// Un conjunto sin variedades, vendido suelto.
const CREPE = {
  nombre: 'PAPEL CREPE', es_conjunto: true, conjunto_contenido: 10,
  conjunto_total: 25, conjunto_unidades: 2, conjunto_restante: 5, stock: 25,
};
// Un producto común, vendido por pack.
const LAPIZ = { id: 55, nombre: 'LAPIZ FABER HB', stock: 40, pack_contenido: 12 };
// Un producto vinculado: la tienda descuenta su stock propio, no el del vinculado.
const TAPA = { nombre: 'TAPA ANILLADO', stock: 9, vinculaciones: [{ doc_id: 'ANILLO', cantidad: 1 }] };

const renglon = (extra) => ({
  cantidad: 1, precio: 100, subtotal: 100, unidad: 'unidad', es_pack: false, pack_contenido: null, variedad: null, ...extra,
});

const PEDIDO = {
  codigo: 'Y73U', estado: 'listo', entrega: { modo: 'delivery' }, pago: { modo: 'transferencia' }, envio: 1500,
  cliente: { nombre: 'Prueba' },
  items: [
    renglon({ id: 'BIC', nombre: 'Bolígrafo Bic 1 mm', variedad: 'Negra', cantidad: 1, es_pack: true, pack_contenido: 50, pack_nombre: 'Caja', precio: 44200, subtotal: 44200 }),
    renglon({ id: 'CREPE', nombre: 'Papel crepé', cantidad: 7 }),
    renglon({ id: 'LAPIZ', nombre: 'Lápiz Faber', cantidad: 2, es_pack: true, pack_contenido: 12 }),
    renglon({ id: 'TAPA', nombre: 'Tapa anillado', cantidad: 3 }),
  ],
};

/** Lo mismo que hace "Entregado" en el panel, sin la transacción. */
function entregar(pedido, pedidoId) {
  const catalogo = Object.fromEntries(Object.entries(datos.catalogo).map(([id, d]) => [id, { ...d, doc_id: id }]));
  const plan = planDescuento(pedido.items, catalogo);
  for (const p of plan.productos) datos.catalogo[p.id] = { ...datos.catalogo[p.id], ...p.campos };
  const docs = documentosDeVenta(pedido, pedidoId, catalogo, new Date('2026-09-15T17:25:18Z'));
  datos.ventas[docs.ventaId] = { ...docs.venta };
  for (const l of docs.lineas) datos.ventas_por_dia[l.docId] = { ...l.datos };
  return docs;
}

/** Lo mismo que hace "Eliminar venta" en Ventas. */
async function borrar(ventaId) {
  const venta = { id: ventaId, ...datos.ventas[ventaId] };
  const itemDocs = await itemsDeLaVenta(db, venta);
  return { itemDocs, resumen: await revertirStockVenta(db, { saleId: venta.sale_id, pcId: venta.pc_id, itemDocs }) };
}

const copia = (x) => JSON.parse(JSON.stringify(x));

beforeEach(() => {
  for (const k of Object.keys(datos)) delete datos[k];
  nube.movimientos.length = 0;
  datos.catalogo = { BIC: copia(BIC), CREPE: copia(CREPE), LAPIZ: copia(LAPIZ), TAPA: copia(TAPA), ANILLO: { nombre: 'ANILLO', stock: 100 } };
  datos.ventas = {};
  datos.ventas_por_dia = {
    // Una venta del POS con el mismo número de otra PC: no se tiene que tocar.
    'DESKTOP1-aaa_5288_0': { num_venta: 5288, pc_id: 'DESKTOP1-aaa', producto: 'PAPEL CREPE', cantidad: 1 },
  };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('borrar una venta de la tienda', () => {
  it('encuentra sus renglones aunque el número de venta sea el código del pedido', async () => {
    const { ventaId } = entregar(PEDIDO, 'ped1');
    const venta = { id: ventaId, ...datos.ventas[ventaId] };
    const items = await itemsDeLaVenta(db, venta);
    expect(items.map(d => d.id).sort()).toEqual(['TIENDA_Y73U_0', 'TIENDA_Y73U_1', 'TIENDA_Y73U_2', 'TIENDA_Y73U_3', 'TIENDA_Y73U_4']);
  });

  it('deja el stock exactamente como estaba antes de entregar', async () => {
    const antes = copia(datos.catalogo);
    const { ventaId } = entregar(PEDIDO, 'ped1');
    // Entregar descontó de verdad: la caja de Negra, el crepé, los dos packs de lápiz y las tapas.
    expect(datos.catalogo.BIC.conjunto_colores.find(c => c.color === 'Negra').unidades).toBe(6);
    expect(datos.catalogo.LAPIZ.stock).toBe(16);

    const { resumen } = await borrar(ventaId);

    expect(resumen.omitidos).toEqual([]);
    const bic = datos.catalogo.BIC;
    expect(bic.conjunto_colores).toEqual(antes.BIC.conjunto_colores);
    expect(bic.conjunto_total).toBe(918);
    expect(bic.conjunto_unidades).toBe(17);
    expect(bic.conjunto_restante).toBe(68);
    expect(bic.stock).toBe(918);
    expect(datos.catalogo.CREPE).toMatchObject({ conjunto_total: 25, stock: 25 });
    expect(datos.catalogo.LAPIZ.stock).toBe(40);
    expect(datos.catalogo.TAPA.stock).toBe(9);
    // El vinculado no se toca: la tienda nunca le descontó.
    expect(datos.catalogo.ANILLO.stock).toBe(100);
  });

  it('la caja vuelve entera: 50 unidades, no 1', async () => {
    const { ventaId } = entregar({ ...PEDIDO, items: [PEDIDO.items[0]], envio: 0 }, 'ped1');
    const { resumen } = await borrar(ventaId);
    expect(resumen.devueltos).toEqual([{ nombre: 'BOLIGRAFO BIC 1 MM TRAZO GRUESO', cantidad: 50, tipo: 'producto' }]);
    expect(nube.movimientos.map(m => m.cantidad)).toEqual([50]);
  });

  it('los renglones quedan marcados como borrados, así dejan de contar en el balance', async () => {
    const { ventaId } = entregar(PEDIDO, 'ped1');
    await borrar(ventaId);
    for (const i of [0, 1, 2, 3, 4]) {
      expect(datos.ventas_por_dia[`TIENDA_Y73U_${i}`]).toMatchObject({ deleted: true, stock_revertido: true });
    }
    expect(datos.ventas_por_dia['DESKTOP1-aaa_5288_0'].deleted).toBeUndefined();
  });

  it('el renglón del envío no se reporta como algo que no se pudo devolver', async () => {
    const { ventaId } = entregar({ ...PEDIDO, items: [PEDIDO.items[1]] }, 'ped1');
    const { resumen } = await borrar(ventaId);
    expect(resumen.omitidos).toEqual([]);
  });

  it('busca el producto por su id: un nombre cambiado en el catálogo no lo pierde', async () => {
    const { ventaId } = entregar({ ...PEDIDO, items: [PEDIDO.items[2]], envio: 0 }, 'ped1');
    datos.catalogo.LAPIZ.nombre = 'LAPIZ FABER CASTELL HB';
    await borrar(ventaId);
    expect(datos.catalogo.LAPIZ.stock).toBe(40);
  });

  it('borrarla dos veces no devuelve dos veces', async () => {
    const { ventaId } = entregar(PEDIDO, 'ped1');
    await borrar(ventaId);
    await borrar(ventaId);
    expect(datos.catalogo.LAPIZ.stock).toBe(40);
    expect(datos.catalogo.BIC.stock).toBe(918);
  });
});

describe('las ventas del POS siguen igual', () => {
  it('encuentra los renglones por número y los de su PC, no los de otra con el mismo número', async () => {
    datos.ventas_por_dia['DESKTOP2-bbb_5288_0'] = { num_venta: 5288, pc_id: 'DESKTOP2-bbb', producto: 'PAPEL CREPE', cantidad: 1 };
    const items = await itemsDeLaVenta(db, { id: 'DESKTOP2-bbb_5288', sale_id: 5288, pc_id: 'DESKTOP2-bbb' });
    expect(items.map(d => d.id)).toEqual(['DESKTOP2-bbb_5288_0']);
  });

  it('una venta del POS por presentación sigue leyendo la cantidad del nombre', async () => {
    datos.ventas_por_dia['DESKTOP1-aaa_77_0'] = { num_venta: 77, pc_id: 'DESKTOP1-aaa', producto: 'PAPEL CREPE  ·  1 pack(s)', cantidad: 1 };
    datos.catalogo.CREPE.conjunto_tipo = 'pack';
    const items = await itemsDeLaVenta(db, { id: 'DESKTOP1-aaa_77', sale_id: 77, pc_id: 'DESKTOP1-aaa' });
    const resumen = await revertirStockVenta(db, { saleId: 77, pcId: 'DESKTOP1-aaa', itemDocs: items });
    expect(resumen.devueltos).toEqual([{ nombre: 'PAPEL CREPE', cantidad: 10, tipo: 'producto' }]);
    expect(datos.catalogo.CREPE.conjunto_total).toBe(35);
  });
});
