/**
 * Las lápidas de `catalogo_deleted`.
 *
 * Al borrar un producto queda una lápida con su código, y cada PC la usa para
 * sacar ese producto de su base local. El problema es que los códigos se
 * reciclan: el generador reparte el número de un producto borrado, así que un
 * producto NUEVO puede nacer con un código que ya tiene lápida. Si la lápida
 * queda, el POS baja el producto, la ve y lo borra: existe en el panel y en la
 * tienda, y en la caja no aparece nunca. Fue el caso de BLISTER DE CEBITAS.
 *
 * Por eso toda alta de producto levanta la lápida de su código. El POS además
 * se defiende solo (`pos_system/models/tombstones.py`): una lápida anterior al
 * producto no borra nada.
 */
import { doc, deleteDoc, writeBatch } from 'firebase/firestore';

// Firestore admite 500 operaciones por lote; 400 deja aire.
export const POR_LOTE = 400;

// Las operaciones de Firestore, en un objeto, para que las pruebas puedan
// pasar un doble sin levantar una conexión.
const FIRESTORE = { doc, deleteDoc, writeBatch };

/** Códigos limpios, sin vacíos ni repetidos, en el orden en que llegaron. */
export function codigosLimpios(docIds) {
  return [...new Set(
    (docIds || []).map(v => (v ?? '').toString().trim()).filter(Boolean)
  )];
}

/** Levanta la lápida de un código que vuelve a estar en uso. */
export async function levantarLapida(db, docId, ops = FIRESTORE) {
  const [id] = codigosLimpios([docId]);
  if (!id) return 0;
  try {
    await ops.deleteDoc(ops.doc(db, 'catalogo_deleted', id));
    return 1;
  } catch (e) {
    console.warn('No se pudo levantar la lápida de', id, e?.message || e);
    return 0;
  }
}

/**
 * Lo mismo para un alta masiva. Borrar una lápida que no existe no es un error
 * en Firestore, así que no hace falta averiguar antes cuáles hay.
 */
export async function levantarLapidas(db, docIds, ops = FIRESTORE) {
  const ids = codigosLimpios(docIds);
  if (!ids.length) return 0;

  let levantadas = 0;
  for (let i = 0; i < ids.length; i += POR_LOTE) {
    const trozo = ids.slice(i, i + POR_LOTE);
    const lote = ops.writeBatch(db);
    for (const id of trozo) lote.delete(ops.doc(db, 'catalogo_deleted', id));
    try {
      await lote.commit();
      levantadas += trozo.length;
    } catch (e) {
      console.warn('No se pudieron levantar lápidas:', e?.message || e);
    }
  }
  return levantadas;
}
