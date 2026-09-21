/**
 * El último dólar que se supo, a mano y sin pedirle nada a nadie.
 *
 * Existe separado de `cotizacion_usd.js` por la misma razón que
 * `temporadas.js` está separado de `temporadas_datos.js`: hay módulos que
 * necesitan el VALOR y no pueden depender de Firebase al importarse.
 * `tienda_espejo.js` es el caso: lo importan las pruebas de la tienda, y
 * arrastrar el SDK desde ahí las rompe.
 *
 * Acá no hay red ni base: solo el número que alguien consiguió, con una copia
 * en el navegador para que al abrir el panel ya haya algo con qué calcular
 * antes de que conteste Firestore.
 */
import { cotizacionValida } from './precio_usd.js';

const CLAVE_LOCAL = 'cotizacion_usd';

let _enMemoria = null;

/**
 * Lo último que se sabe. null si todavía no se consiguió ninguna.
 *
 * El almacenamiento del navegador puede estar bloqueado (ventana privada,
 * datos del sitio bloqueados) y tirar al leerlo: por eso el try.
 */
export function cotizacionEnMemoria() {
  if (_enMemoria) return _enMemoria;
  try {
    const guardado = JSON.parse(localStorage.getItem(CLAVE_LOCAL) || 'null');
    if (guardado && cotizacionValida(guardado.valor)) {
      _enMemoria = guardado;
      return guardado;
    }
  } catch (_) { /* sin almacenamiento: se sigue con lo que haya en memoria */ }
  return null;
}

/** El valor para calcular un precio. 0 si todavía no hay ninguno. */
export function valorActual() {
  const c = cotizacionEnMemoria();
  return c && cotizacionValida(c.valor) ? Number(c.valor) : 0;
}

/** Guarda la cotización que se acaba de conseguir y la devuelve. */
export function recordarCotizacion(cot) {
  if (!cot) return cot;
  _enMemoria = cot;
  try { localStorage.setItem(CLAVE_LOCAL, JSON.stringify(cot)); } catch (_) { /* privado */ }
  return cot;
}

/** Solo para las pruebas: vuelve a empezar de cero. */
export function olvidarCotizacion() {
  _enMemoria = null;
  try { localStorage.removeItem(CLAVE_LOCAL); } catch (_) { /* privado */ }
}
