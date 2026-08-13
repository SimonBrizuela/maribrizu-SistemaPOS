import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { getCached } from './cache.js';
import { getFechaInicioDate, parseArDate } from './config.js';

/**
 * Numeración unificada de ventas (display-only).
 *
 * Cada PC lleva su propio contador local (sale_id/num_venta) → eso genera
 * duplicados (PC1 #4 + PC2 #4) al ver la web. Esta función asigna un número
 * global 1..N por orden cronológico, único entre todas las PCs.
 *
 * Deriva los números de `dashboard:ventas` (mismo dataset que el store ya tiene
 * en memoria) — antes hacía un getDocs propio sin limit que descargaba todo
 * en paralelo al listener del store. Ahora se sirve del store y elimina ese
 * download duplicado.
 *
 * Solo afecta lo que se muestra; el sale_id interno sigue siendo el real
 * (usado para abrir modales, buscar items en ventas_por_dia, etc.).
 */
export async function getSaleNumberMap(db) {
  const fechaInicio = await getFechaInicioDate(db);
  return getCached('sale_numbers:global', async () => {
    console.log('[sale_numbers] derivando de dashboard:ventas (store cache)');
    const _t0 = performance.now();
    // dashboard:ventas viene desc (más nuevo primero) — invertimos para asc.
    const ventas = await getCached('dashboard:ventas', async () => {
      const snap = await getDocs(query(collection(db, 'ventas'), orderBy('created_at', 'desc')));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }, { ttl: 60 * 1000 });
    const map = {};
    let n = 0;
    // procesar en orden cronológico ascendente para que la numeración sea estable
    for (let i = ventas.length - 1; i >= 0; i--) {
      const v = ventas[i];
      if (v.deleted === true) continue;
      const dt = parseArDate(v.created_at);
      if (dt < fechaInicio) continue;
      const pcId   = v.pc_id || '';
      const saleId = v.sale_id || v.id;
      const key    = `${pcId}|${saleId}`;
      if (!(key in map)) {
        n++;
        map[key] = n;
      }
    }
    console.log(`[sale_numbers] ✓ numeración generada en ${(performance.now() - _t0).toFixed(0)}ms (${n} ventas únicas)`);
    return map;
  }, { ttl: 60 * 1000 });
}

/** # global para una venta de la colección `ventas`. */
export function displayNumForVenta(v, map) {
  const pcId   = v.pc_id || '';
  const saleId = v.sale_id || v.id;
  return map[`${pcId}|${saleId}`] || saleId || '-';
}

/** # global para un item de `ventas_por_dia` (requiere _pc_id extraído del doc.id). */
export function displayNumForItem(item, map) {
  const pcId   = item.pc_id || item._pc_id || '';
  const saleId = item.num_venta;
  return map[`${pcId}|${saleId}`] || saleId || '-';
}
