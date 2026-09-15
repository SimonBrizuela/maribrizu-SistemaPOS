/**
 * El link del repartidor.
 *
 * El panel genera una clave larga al azar y la guarda en `tienda_reparto/acceso`
 * (una colección que solo leen el panel y estas funciones). El link lleva esa
 * clave; generar otro la reemplaza y sube la `version`, y el anterior deja de
 * servir. Anularlo la deja marcada sin borrarla.
 *
 * La versión también viaja en la sesión del repartidor (`reparto_version`) y
 * las reglas de Firestore la comparan: un celular con el link viejo deja de
 * leer pedidos aunque su sesión siga abierta.
 */
import crypto from 'node:crypto';
import { leerDocPrivado } from './firestore.mjs';

export const RE_CLAVE = /^[A-Za-z0-9_-]{32,128}$/;

/** @returns {Promise<{ok: true, version: number}|{ok: false}>} */
export async function verificarClave(clave) {
  if (typeof clave !== 'string' || !RE_CLAVE.test(clave)) return { ok: false };
  const acceso = await leerDocPrivado('tienda_reparto', 'acceso');
  if (!acceso || acceso.anulado === true || typeof acceso.clave !== 'string') return { ok: false };

  // Comparación de tiempo constante: medir cuánto tarda en fallar no dice
  // cuántos caracteres se acertaron.
  const esperada = crypto.createHash('sha256').update(acceso.clave).digest();
  const recibida = crypto.createHash('sha256').update(clave).digest();
  if (!crypto.timingSafeEqual(esperada, recibida)) return { ok: false };
  return { ok: true, version: Number(acceso.version) || 1 };
}
