/**
 * La galería de la ficha: la foto grande, las miniaturas, y qué foto toca
 * cuando el cliente elige un color.
 *
 * Un producto trae `imagenes` (la primera es la portada, las demás la galería)
 * y cada variedad puede traer su propia `imagen`. Las reglas:
 *
 *   · Sin variedad elegida se ve la portada. Las miniaturas son la galería
 *     entera, y solo aparecen si hay más de una foto.
 *   · Al elegir una variedad con foto propia, la grande pasa a ser esa. Si esa
 *     foto es una de la galería se marca su miniatura; si no, ninguna queda
 *     marcada — la foto del color no se cuela entre las del producto, que con
 *     treinta colores serían treinta miniaturas.
 *   · Elegir una variedad SIN foto propia no cambia nada: se sigue viendo la
 *     que estaba. Volver a la portada no es un salto que el cliente pidió.
 *   · Tocar una miniatura muestra esa foto sin tocar la variedad elegida.
 *
 * Lo que decide qué se ve está separado del DOM (`fotoAlElegir`, `miniaturas`,
 * `fotoDeVariedad`) para poder probarlo; `montarGaleria` es la parte que toca
 * la pantalla.
 */
import { esc } from './formato.js';

/** La foto propia de una variedad, por su nombre público. Null si no tiene. */
export function fotoDeVariedad(p, nombre) {
  if (!nombre) return null;
  const v = (p?.variedades || []).find(x => x && x.nombre === nombre);
  const url = String(v?.imagen ?? '').trim();
  return url || null;
}

/** La portada: la primera de la galería, o null si el producto no tiene fotos. */
export function portada(p) {
  const url = (p?.imagenes || []).find(u => String(u ?? '').trim());
  return url ? String(url).trim() : null;
}

/** Las miniaturas que se muestran: la galería, solo si tiene más de una. */
export function miniaturas(p) {
  const lista = (p?.imagenes || []).map(u => String(u ?? '').trim()).filter(Boolean);
  return lista.length > 1 ? lista : [];
}

/**
 * Qué foto grande corresponde después de elegir (o soltar) una variedad.
 *
 * @param {object} p           el producto
 * @param {string|null} nombre la variedad elegida, o null si se soltó
 * @param {string|null} actual la foto que se está viendo ahora
 * @returns {string|null}      la que hay que mostrar
 */
export function fotoAlElegir(p, nombre, actual = null) {
  if (!nombre) return portada(p) ?? actual ?? null;
  return fotoDeVariedad(p, nombre) ?? actual ?? portada(p) ?? null;
}

/** El HTML de la galería. Sin fotos, la placa con la inicial de siempre. */
export function htmlGaleria(p) {
  const grande = portada(p);
  if (!grande) {
    return `<div class="galeria__principal card-producto__placa"><span style="font-size:6rem">${
      esc((p.nombre || '?').charAt(0).toUpperCase())}</span></div>`;
  }

  const minis = miniaturas(p);
  return `
    <div class="galeria__principal">
      <img data-galeria-grande src="${esc(grande)}" alt="${esc(p.nombre)}" width="800" height="800">
    </div>
    ${minis.length ? `
      <div class="galeria__miniaturas" role="group" aria-label="Más fotos del producto">
        ${minis.map((url, i) => `
          <button type="button" class="galeria__miniatura" data-galeria-mini="${esc(url)}"
                  aria-pressed="${i === 0}" aria-label="Foto ${i + 1} de ${minis.length}">
            <img src="${esc(url)}" alt="" loading="lazy" decoding="async" width="72" height="72">
          </button>`).join('')}
      </div>` : ''}`;
}

/**
 * Engancha la galería ya pintada dentro de `raiz`.
 *
 * Devuelve `mostrar(url)` para poner una foto grande y `alElegirVariedad(nombre)`
 * para que la ficha avise cuando cambia el color. Sin fotos no hay nada que
 * enganchar y las dos funciones no hacen nada.
 */
export function montarGaleria(raiz, p) {
  const grande = raiz?.querySelector('[data-galeria-grande]');
  if (!grande) return { mostrar() {}, alElegirVariedad() {} };

  const minis = [...raiz.querySelectorAll('[data-galeria-mini]')];
  let actual = grande.getAttribute('src');

  function mostrar(url) {
    if (!url || url === actual) return;
    actual = url;
    grande.setAttribute('src', url);
    minis.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.galeriaMini === url)));
  }

  minis.forEach(b => b.addEventListener('click', () => mostrar(b.dataset.galeriaMini)));

  return {
    mostrar,
    alElegirVariedad(nombre) { mostrar(fotoAlElegir(p, nombre, actual)); },
  };
}
