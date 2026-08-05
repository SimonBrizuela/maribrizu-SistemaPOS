/**
 * Iconos en SVG inline.
 *
 * No se usan emojis: dependen de la fuente del sistema, se ven distinto en cada
 * telefono y no se pueden pintar con los tokens del tema. Todos comparten la
 * misma grilla de 24, el mismo grosor de trazo y las mismas terminaciones
 * redondeadas, que es lo que hace que un juego de iconos se vea de una pieza.
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
  whatsapp: '<path d="M20.5 3.5A11 11 0 0 0 3.2 16.9L2 22l5.2-1.2A11 11 0 1 0 20.5 3.5"/><path d="M8.5 8.2c.2-.5.4-.5.7-.5h.6c.2 0 .4 0 .6.5l.8 1.9c.1.3 0 .5-.1.7l-.5.6c-.2.2-.3.4-.1.7a7.4 7.4 0 0 0 3.4 3c.3.2.5.1.7-.1l.6-.7c.2-.2.4-.2.6-.1l1.9.9c.3.1.4.3.4.5v.7c0 .5-.4 1-1 1.2a3 3 0 0 1-1.4.1c-1.2-.2-3.3-1-5.2-2.9s-2.7-4-2.9-5.2a3 3 0 0 1 .1-1.4"/>',
  local:    '<path d="M4 9h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="m4 9 1.6-5A1 1 0 0 1 6.6 3h10.8a1 1 0 0 1 1 .7L20 9"/><path d="M9 21v-6h6v6"/>',
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
