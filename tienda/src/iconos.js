/**
 * Iconos en SVG inline.
 *
 * No se usan emojis: dependen de la fuente del sistema, se ven distinto en cada
 * telefono y no se pueden pintar con los tokens del tema. Todos comparten la
 * misma grilla de 24, el mismo grosor de trazo y las mismas terminaciones
 * redondeadas, que es lo que hace que un juego de iconos se vea de una pieza.
 *
 * El trazo tiene que quedar entre 1 y 23 en los dos ejes. El grosor de 2 se
 * reparte una unidad para cada lado del camino, y lo que se sale del viewBox se
 * recorta sin aviso: un icono dibujado sobre una grilla mas grande no se ve
 * chico, se ve mordido contra el borde.
 */

const TRAZOS = {
  buscar:   '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  carrito:  '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  mas:      '<path d="M12 5v14M5 12h14"/>',
  menos:    '<path d="M5 12h14"/>',
  cerrar:   '<path d="M18 6 6 18M6 6l12 12"/>',
  tilde:    '<path d="M20 6 9 17l-5-5"/>',
  atencion: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
  tacho:    '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  casa:     '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  grilla:   '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  pin:      '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  camion:   '<path d="M3 7h11v10H3zM14 10h4l3 3v4h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>',
  bolsa:    '<path d="M5 12h14"/><path d="M5 12a7 7 0 0 1 14 0"/><path d="M7 12v6a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-6"/>',
  derecha:  '<path d="m9 18 6-6-6-6"/>',
  izquierda:'<path d="m15 18-6-6 6-6"/>',
  abajo:    '<path d="m6 9 6 6 6-6"/>',
  reloj:    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  chat:     '<path d="M21 6v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  // La burbuja estaba dibujada para una grilla de 28: se salia tres unidades por
  // la derecha y una por arriba, y como el contenido fuera del viewBox se
  // recorta, el circulo aparecia aplanado contra el borde. Redibujada sobre un
  // circulo de radio 9 centrado en (13, 11), que es lo mas grande que entra
  // dejandole lugar a la cola en la esquina de abajo a la izquierda.
  whatsapp: '<path d="M4.27 13.18A9 9 0 1 1 8.5 18.79L2.7 21.3Z"/><path d="M8.7 6.5c.2-.5.4-.5.7-.5h.6c.2 0 .4 0 .6.5l.8 1.9c.1.3 0 .5-.1.7l-.5.6c-.2.2-.3.4-.1.7a7.4 7.4 0 0 0 3.4 3c.3.2.5.1.7-.1l.6-.7c.2-.2.4-.2.6-.1l1.9.9c.3.1.4.3.4.5v.7c0 .5-.4 1-1 1.2a3 3 0 0 1-1.4.1c-1.2-.2-3.3-1-5.2-2.9s-2.7-4-2.9-5.2a3 3 0 0 1 .1-1.4"/>',
  local:    '<path d="M4 9h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="m4 9 1.6-5A1 1 0 0 1 6.6 3h10.8a1 1 0 0 1 1 .7L20 9"/><path d="M9 21v-6h6v6"/>',
  // El marco, la lente y el punto del flash: es la silueta que se reconoce a
  // 16 px, que es el tamaño al que se usa en el pie.
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="3.6"/><circle cx="17.2" cy="6.8" r="0.6" fill="currentColor" stroke="none"/>',

  // Uno por rubro. Se eligio el objeto mas reconocible de cada uno a tamaño
  // chico, no el mas representativo: a 20 px una maquina de coser es una mancha,
  // un boton de cuatro agujeros se entiende de una.
  lapiz:    '<path d="M3 21 4 16.5 16.5 4a2.1 2.1 0 0 1 3 3L7 20z"/><path d="m14.5 6 3.5 3.5"/>',
  hoja:     '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  boton:    '<circle cx="12" cy="12" r="8.5"/><circle cx="9.6" cy="9.6" r="1.15"/><circle cx="14.4" cy="9.6" r="1.15"/><circle cx="9.6" cy="14.4" r="1.15"/><circle cx="14.4" cy="14.4" r="1.15"/>',
  regalo:   '<rect x="3" y="9" width="18" height="12" rx="1.5"/><path d="M3 13.5h18M12 9v12"/><path d="M12 9C10.4 6.1 8.2 5 7.2 6.1 6 7.4 8.2 9 12 9zM12 9c1.6-2.9 3.8-4 4.8-2.9C18 7.4 15.8 9 12 9z"/>',
  bloques:  '<rect x="8" y="3.5" width="8" height="7.5" rx="1.3"/><rect x="3" y="13" width="8" height="7.5" rx="1.3"/><rect x="13" y="13" width="8" height="7.5" rx="1.3"/>',
  perfume:  '<rect x="7" y="9" width="10" height="12" rx="2"/><path d="M10 9V6h4v3"/><path d="M14 4.5h3.5V8"/><path d="M20.5 5v.01M20.5 8v.01"/>',
};

/**
 * @param {string} nombre  clave de TRAZOS
 * @param {object} [opciones]
 * @param {number} [opciones.tam=22]
 * @param {number} [opciones.grosor=2]
 * @param {string} [opciones.titulo]  si se pasa, el icono deja de ser decorativo
 *                                    y se anuncia con ese texto
 */
export function icono(nombre, { tam = 22, grosor = 2, titulo = '' } = {}) {
  const trazo = TRAZOS[nombre];
  if (!trazo) {
    console.warn(`[iconos] no existe "${nombre}"`);
    return '';
  }
  // Un icono junto a texto que ya dice lo mismo es ruido para un lector de
  // pantalla: por defecto va oculto.
  const accesible = titulo
    ? `role="img" aria-label="${titulo}"`
    : 'aria-hidden="true"';

  return `<svg width="${tam}" height="${tam}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="${grosor}" stroke-linecap="round"
    stroke-linejoin="round" ${accesible}>${trazo}</svg>`;
}

/** Las cinco fichas del logo, en barras. Se lee a 20 px de alto. */
export function fichasMarca() {
  return '<span class="marca-fichas"><i></i><i></i><i></i><i></i><i></i></span>';
}

/** Franja de cinco colores que cierra los bloques oscuros. */
export function franjaMarca() {
  return '<div class="franja-marca"><i></i><i></i><i></i><i></i><i></i></div>';
}

/**
 * El icono que le toca a un rubro del catalogo.
 *
 * Se compara sin acentos porque en el catalogo conviven "MERCERÍA" y "MERCERIA"
 * segun quien haya cargado el producto. Un rubro que no este en la lista cae en
 * la grilla generica en vez de quedarse sin icono: son seis hoy, pero el dia que
 * alguien agregue uno la portada no tiene que romperse.
 */
const ICONO_RUBRO = {
  libreria:   'lapiz',
  papelera:   'hoja',
  merceria:   'boton',
  regaleria:  'regalo',
  jugueteria: 'bloques',
  perfumeria: 'perfume',
};

export function iconoDeRubro(rubro) {
  const clave = String(rubro || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
  return ICONO_RUBRO[clave] || 'grilla';
}

/**
 * Capa de resplandores de marca para los bloques oscuros.
 * Puramente visual, por eso no la ve ningun lector de pantalla.
 */
export function resplandores() {
  return `<div class="resplandores" aria-hidden="true">
    <span class="resplandor resplandor--1"></span>
    <span class="resplandor resplandor--2"></span>
    <span class="resplandor resplandor--3"></span>
    <span class="resplandor resplandor--4"></span>
  </div>`;
}
