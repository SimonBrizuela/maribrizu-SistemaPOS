/**
 * Fotos que llegan del celular en base64: la del reclamo del cliente y la de la
 * entrega del repartidor.
 *
 * Llegan ya achicadas (`src/fotos_reclamo.js`), pero lo que llega al servidor lo
 * puede haber armado cualquiera: se revisa el tipo, el peso y que los primeros
 * bytes sean de verdad de una imagen.
 */
import { LIMITES } from '../../../src/reclamos.js';

const RE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
export const EXTENSIONES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Si los primeros bytes son de verdad del tipo que dice. El tipo lo declara el
 * navegador y se puede escribir a mano: un HTML con nombre de foto no entra.
 */
function esImagenDelTipo(bytes, tipo) {
  if (tipo === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (tipo === 'image/png') {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (tipo === 'image/webp') {
    return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  }
  return false;
}

/**
 * Una foto del cuerpo, decodificada; o el mensaje de por qué no sirve.
 * @returns {{bytes: Buffer, tipo: string}|{error: string}}
 */
export function leerFoto(foto) {
  const tipo = foto?.tipo;
  const datos = foto?.datos;
  const noSeLee = { error: 'Una de las fotos no se pudo leer. Probá con otra.' };
  if (!EXTENSIONES[tipo] || typeof datos !== 'string' || !RE_BASE64.test(datos)) return noSeLee;
  // Se mira el largo antes de decodificar: no se arma en memoria algo que
  // igual se va a rechazar.
  if (datos.length > Math.ceil(LIMITES.bytesFoto / 3) * 4) {
    return { error: 'Una de las fotos pesa demasiado. Probá con otra.' };
  }
  const bytes = Buffer.from(datos, 'base64');
  if (!bytes.length || !esImagenDelTipo(bytes, tipo)) return noSeLee;
  if (bytes.length > LIMITES.bytesFoto) return { error: 'Una de las fotos pesa demasiado. Probá con otra.' };
  return { bytes, tipo };
}
