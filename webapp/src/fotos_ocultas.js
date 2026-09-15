/**
 * Lo que se oculta de "Les falta la foto", en Fotos Pedidas.
 *
 * Hay productos a los que no se les va a sacar nunca una foto, y con ellos en la
 * lista los que sí importan quedaban perdidos entre doscientos renglones. Ocultar
 * es una decisión sobre esa lista y nada más: no toca el catálogo, ni el espejo
 * público, ni lo que ve el cliente. Un "publicar siempre" oculto se sigue
 * mostrando en la vidriera con el cuadrito gris.
 *
 * Vive en `config/fotos_ocultas`, un campo por producto (el id del catálogo) con
 * `{nombre, oculto_en}`:
 *
 * - Un campo por producto y no una lista: la escritura manda solo ese campo, así
 *   que dos pestañas ocultando a la vez no se pisan.
 * - En `config` y no en `tienda_config`: ese último se lee sin sesión desde la
 *   tienda, y esto es del local. `config` ya tiene regla (lee cualquier usuario
 *   del panel, escribe el admin), así que no hace falta publicar reglas nuevas.
 *
 * Lo puro (repartir, qué cambió, reconciliar) está separado de la lectura y la
 * escritura para poder probarlo sin Firebase.
 */
import { doc, onSnapshot } from 'firebase/firestore';
import { actualizarDoc, leerDocRest } from './tienda_espejo.js';
import { leerDocRapido } from './config.js';

const COLECCION = 'config';
const DOCUMENTO = 'fotos_ocultas';

/**
 * Cuánto se le cree a lo recién guardado por encima de lo que dice la base.
 *
 * La escritura va por REST y el aviso en vivo llega por el SDK, cada uno por su
 * lado: un aviso armado antes de la escritura puede llegar después. Pasado este
 * rato, si la base sigue diciendo otra cosa, es que la cambió otra pestaña.
 */
export const GRACIA_PENDIENTE_MS = 15000;

/* ── Puro ────────────────────────────────────────────────────────────────── */

/** El documento como `Map<id, {nombre, oculto_en: Date|null}>`. */
export function ocultosDelDoc(datos) {
  const ocultos = new Map();
  if (!datos || typeof datos !== 'object') return ocultos;
  for (const [id, valor] of Object.entries(datos)) {
    if (!valor || typeof valor !== 'object') continue;
    ocultos.set(id, { nombre: String(valor.nombre ?? ''), oculto_en: fechaDe(valor.oculto_en) });
  }
  return ocultos;
}

function fechaDe(valor) {
  if (valor instanceof Date) return valor;
  if (typeof valor?.toDate === 'function') return valor.toDate();
  return null;
}

/**
 * Reparte los renglones. Lo visible conserva el orden de la lista; lo oculto va
 * del último que se ocultó al primero, que es el que se viene a buscar cuando
 * se ocultó uno sin querer.
 */
export function separarOcultos(filas, ocultos) {
  const visibles = [];
  const ocultas = [];
  for (const f of filas) (ocultos.has(f.id) ? ocultas : visibles).push(f);
  const cuando = f => ocultos.get(f.id)?.oculto_en?.getTime() || 0;
  ocultas.sort((a, b) => cuando(b) - cuando(a));
  return { visibles, ocultas };
}

/** Los cambios para `actualizarDoc`: un solo campo, el del producto. */
export function cambioOcultar(fila, cuando = new Date()) {
  return { [fila.id]: { nombre: fila.nombre, oculto_en: cuando } };
}

/** `undefined` en la máscara es borrar el campo. */
export function cambioMostrar(id) {
  return { [id]: undefined };
}

export function diferencias(antes, despues) {
  return {
    ocultados: [...despues.keys()].filter(id => !antes.has(id)),
    mostrados: [...antes.keys()].filter(id => !despues.has(id)),
  };
}

/**
 * Lo que dice la base, con lo recién tocado encima.
 *
 * `pendientes` es `Map<id, {entrada, guardadoEn}>`: `entrada` es lo que se
 * quiere (los datos para ocultarlo, o null para mostrarlo) y `guardadoEn`
 * cuándo terminó de guardarse (null mientras se está guardando).
 *
 * Un pendiente se resuelve cuando la base dice lo mismo, o cuando pasó la
 * gracia desde que se guardó y dice otra cosa. Mientras se guarda no vence.
 *
 * @returns {{efectivo: Map, resueltos: string[]}}
 */
export function reconciliar(servidor, pendientes, ahora = Date.now()) {
  const efectivo = new Map(servidor);
  const resueltos = [];
  for (const [id, { entrada, guardadoEn }] of pendientes) {
    const quiereOculto = entrada !== null;
    if (servidor.has(id) === quiereOculto) { resueltos.push(id); continue; }
    if (guardadoEn !== null && ahora - guardadoEn > GRACIA_PENDIENTE_MS) {
      resueltos.push(id);
      continue;
    }
    if (quiereOculto) efectivo.set(id, entrada);
    else efectivo.delete(id);
  }
  return { efectivo, resueltos };
}

/* ── Base ────────────────────────────────────────────────────────────────── */

/**
 * La lectura del arranque. Por REST con la sesión, que no hace cola detrás de
 * los listeners grandes del SDK (un getDoc suelto llegó a tardar 103 s); si la
 * REST no está, cache primero y servidor después.
 */
export async function leerOcultos(db) {
  const porRest = await leerDocRest(COLECCION, DOCUMENTO, null, { conSesion: true });
  if (porRest) return ocultosDelDoc(porRest.datos);
  const datos = await leerDocRapido(doc(db, COLECCION, DOCUMENTO),
                                    { etiqueta: `${COLECCION}/${DOCUMENTO}`, vacio: null });
  return ocultosDelDoc(datos);
}

/** Avisa cada vez que cambia el documento, venga de esta pestaña o de otra. */
export function escucharOcultos(db, alCambiar) {
  try {
    return onSnapshot(doc(db, COLECCION, DOCUMENTO),
      snap => alCambiar(ocultosDelDoc(snap.exists() ? snap.data() : null)),
      err => console.warn('[fotos] no se pudo escuchar los ocultos:', err?.message || err));
  } catch (err) {
    console.warn('[fotos] no se pudo escuchar los ocultos:', err?.message || err);
    return () => {};
  }
}

/** Escribe lo que armó `cambioOcultar` o `cambioMostrar`. El primero crea el documento. */
export async function guardarCambioDeOcultos(db, cambios) {
  await actualizarDoc(db, COLECCION, DOCUMENTO, cambios, { crearSiFalta: true });
}
