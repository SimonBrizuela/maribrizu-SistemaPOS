/**
 * Las cuentas del zoom de las fotos, sin DOM.
 *
 * El estado de una foto ampliada es `{escala, x, y}`: cuánto se acercó y cuánto
 * se corrió desde el centro, en píxeles de pantalla. Las medidas van aparte:
 * `marco` es el lugar donde se ve la foto y `foto` lo que mide la foto a escala
 * 1, ya ajustada al marco.
 *
 * Probado en `pruebas/zoom.test.js`. Lo que toca la pantalla vive en
 * `visor_fotos.js`.
 */

/** Hasta dónde se acerca. Las fotos se suben a 900 px: más que esto se ve borroso. */
export const ESCALA_MAX = 3;

/** Cuánto acerca un doble toque o la lupa del visor. */
export const ESCALA_DOBLE = 2;

/** Cuánto acerca la lupa de la ficha al pasar el mouse. */
export const ESCALA_LUPA = 2;

const entre = (valor, min, max) => Math.min(max, Math.max(min, valor));

/**
 * La escala dentro de lo permitido y el desplazamiento hasta el borde de la
 * foto y no más: arrastrarla nunca deja un pedazo de fondo vacío.
 */
export function limitar(estado, marco, foto) {
  const escala = entre(Number(estado.escala) || 1, 1, ESCALA_MAX);
  const sobraX = Math.max(0, ((foto.ancho || 0) * escala - (marco.ancho || 0)) / 2);
  const sobraY = Math.max(0, ((foto.alto || 0) * escala - (marco.alto || 0)) / 2);
  // `+ 0` convierte el -0 de Math.min en 0: la escala 1 queda centrada de verdad.
  return {
    escala,
    x: entre(Number(estado.x) || 0, -sobraX, sobraX) + 0,
    y: entre(Number(estado.y) || 0, -sobraY, sobraY) + 0,
  };
}

/**
 * Acerca o aleja dejando quieto el punto que está debajo del dedo o del mouse.
 * `punto` es relativo al centro del marco.
 */
export function zoomEnPunto(estado, escala, punto, marco, foto) {
  const nueva = entre(escala, 1, ESCALA_MAX);
  const factor = nueva / (estado.escala || 1);
  return limitar({
    escala: nueva,
    x: punto.x - (punto.x - estado.x) * factor,
    y: punto.y - (punto.y - estado.y) * factor,
  }, marco, foto);
}

/** Un golpe de rueda acerca un poco, no de a saltos. */
export function escalaConRueda(escala, deltaY) {
  return entre(escala * Math.exp(-deltaY * 0.002), 1, ESCALA_MAX);
}

/** Dónde está el mouse, en porcentaje de la foto: de ahí crece la lupa. */
export function origenLupa(punto, rect) {
  if (!rect?.width || !rect?.height) return { x: 50, y: 50 };
  const pct = (v) => Math.round(entre(v, 0, 1) * 1000) / 10;
  return {
    x: pct((punto.x - rect.left) / rect.width),
    y: pct((punto.y - rect.top) / rect.height),
  };
}

/**
 * Qué fotos se recorren en el visor y en cuál arranca.
 *
 * La galería del producto, en la foto que se estaba viendo. La foto propia de
 * un color no es de la galería (con treinta colores serían treinta fotos), así
 * que si era esa la que se veía va primero y detrás la galería.
 */
export function fotosDelVisor(p, actual) {
  const galeria = (p?.imagenes || []).map(u => String(u ?? '').trim()).filter(Boolean);
  const vista = String(actual ?? '').trim();
  if (!vista) return { fotos: galeria, indice: 0 };
  const indice = galeria.indexOf(vista);
  if (indice >= 0) return { fotos: galeria, indice };
  return { fotos: [vista, ...galeria], indice: 0 };
}

const PASO_FOTO = 60;     // px de costado para cambiar de foto
const PASO_CERRAR = 90;   // px para abajo para cerrar

/**
 * Qué hace un deslizamiento al soltar el dedo. Solo sin zoom: con zoom,
 * arrastrar es recorrer la foto. Y solo si el gesto es claro: en diagonal
 * pareja no se adivina.
 */
export function gestoAlSoltar({ dx, dy, escala, hayAnterior, haySiguiente }) {
  if (escala > 1.01) return null;
  const ancho = Math.abs(dx);
  const alto = Math.abs(dy);

  if (ancho > PASO_FOTO && ancho > alto * 1.5) {
    if (dx < 0) return haySiguiente ? 'siguiente' : null;
    return hayAnterior ? 'anterior' : null;
  }
  if (dy > PASO_CERRAR && alto > ancho * 1.5) return 'cerrar';
  return null;
}
