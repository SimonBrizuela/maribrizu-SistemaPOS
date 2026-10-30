/**
 * Escribir un producto releyendo la nube, con su movimiento de stock en la
 * misma transacción.
 *
 * La ficha, la celda de stock de la grilla y el "Deshacer" pasan por acá: leen
 * el producto como está HOY adentro de `runTransaction`, arman lo que hay que
 * escribir con `stock_concurrencia.js` y escriben el producto y la fila de
 * `stock_movimientos` juntas. Si la transacción se reintenta (alguien vendió
 * justo en ese momento), se vuelve a armar con el número nuevo.
 *
 * Una transacción necesita conexión: sin internet falla en vez de encolarse.
 * Es a propósito: encolar una escritura absoluta era justamente lo que pisaba
 * ventas.
 */
import { doc, runTransaction } from 'firebase/firestore';
import { armarMovimiento, refMovimientoNuevo } from './stock_ledger.js';

export class ProductoNoExiste extends Error {
  constructor(docId) {
    super(`El producto ${docId} ya no existe en la nube (¿lo borraron desde otra pantalla?).`);
    this.name = 'ProductoNoExiste';
  }
}

/**
 * `armar(nube)` recibe el documento leído en la transacción y devuelve
 * `{ plan, datos, movimiento }`:
 *   plan        — lo que devolvió `resolverGuardado` / `resolverDeshacer`
 *   datos       — los campos a escribir (ya con el plan aplicado)
 *   movimiento  — { nombre, motivo, detalle } o null para no anotar
 *
 * Si el plan necesita que la persona decida, no se escribe nada y se devuelve
 * `{ pregunta: plan, nube }`. Si no, `{ plan, nube, datos }`.
 */
export async function escribirReleyendo(db, docId, armar) {
  const ref = doc(db, 'catalogo', String(docId));
  const refMov = refMovimientoNuevo(db);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new ProductoNoExiste(docId);
    const nube = snap.data() || {};
    const { plan, datos, movimiento } = armar(nube);
    if (plan.necesitaDecision) return { pregunta: plan, nube };
    tx.update(ref, datos);
    if (movimiento) {
      const fila = armarMovimiento({
        docId: String(docId),
        ...movimiento,
        antes: plan.antes,
        despues: plan.despues,
      });
      if (fila) tx.set(refMov, fila);
    }
    return { plan, nube, datos };
  });
}

/**
 * Lo mismo, preguntando cuando hace falta. `preguntar(plan)` muestra el
 * diálogo y devuelve 'sumar', 'literal' o null (volver sin guardar).
 * `armar(nube, decision)` arma con la decisión tomada.
 *
 * Devuelve `{ plan, nube, datos }`, o null si la persona prefirió volver.
 */
export async function escribirPreguntando(db, docId, armar, preguntar) {
  let decision = null;
  // Tres vueltas alcanzan: la segunda ya lleva la decisión; una tercera sólo
  // pasa si la nube cambió de forma justo entre la pregunta y el guardado.
  for (let vuelta = 0; vuelta < 3; vuelta++) {
    const r = await escribirReleyendo(db, docId, nube => armar(nube, decision));
    if (!r.pregunta) return r;
    decision = await preguntar(r.pregunta, r.nube);
    if (!decision) return null;
  }
  throw new Error('El stock no paró de cambiar mientras se guardaba. Probá de nuevo en un momento.');
}
