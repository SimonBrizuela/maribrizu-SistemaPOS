/** Utilidades de formato y texto. Sin dependencias. */

const PESOS = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * 14900 → "$14.900". Sin centavos: en la libreria no se usan.
 * Intl mete un espacio duro entre el signo y el numero; se saca porque a lo
 * ancho de una card de producto ese espacio se nota y descoloca el precio.
 */
export function pesos(n) {
  return PESOS.format(Math.round(Number(n) || 0)).replace(/\s/g, '');
}

/** 4.137 → "4,1 km" · 0.85 → "850 m" */
export function distancia(km) {
  const n = Number(km) || 0;
  if (n < 1) return `${Math.round(n * 1000)} m`;
  return `${n.toFixed(1).replace('.', ',')} km`;
}

/**
 * Quita acentos y pasa a minusculas para comparar.
 * "BOLÍGRAFO" y "boligrafo" tienen que encontrarse mutuamente: nadie escribe
 * los acentos al buscar desde el celular.
 */
export function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/**
 * El catalogo guarda los nombres en mayusculas porque el POS los muestra asi en
 * pantalla chica. Gritados en una tienda se ven agresivos y baratos, asi que se
 * pasan a formato titulo.
 *
 * Las palabras cortas de union quedan en minuscula, y lo que ya venia con
 * mayusculas y numeros mezclados (C12-003, A4, 500ML) se deja intacto porque
 * suele ser un codigo o una medida.
 */
const MENORES = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'con', 'sin', 'para', 'por', 'a', 'en']);

export function nombreBonito(texto) {
  const palabras = String(texto || '').trim().split(/\s+/).filter(Boolean);
  if (!palabras.length) return '';

  return palabras
    .map((original, i) => {
      // Codigos y medidas (C12-003, A4, 500ML): se respetan como vinieron.
      if (/\d/.test(original)) return original.toUpperCase();
      const baja = original.toLowerCase();
      if (i > 0 && MENORES.has(baja)) return baja;
      return baja.charAt(0).toUpperCase() + baja.slice(1);
    })
    .join(' ');
}

/** "BOLIGRAFO FILGO GEL" → "boligrafo-filgo-gel" para la URL. */
export function aSlug(texto) {
  return normalizar(texto)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}

/** Escapa texto que va a innerHTML. */
export function esc(texto) {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Une clases salteando las vacias. */
export function clases(...xs) {
  return xs.filter(Boolean).join(' ');
}

/**
 * Adivina un color CSS a partir del nombre de una variedad.
 * El catalogo guarda "Azul", "Negro", "Rosa viejo" como texto libre, sin codigo
 * de color. Cuando no se reconoce se devuelve null y la tienda muestra el
 * nombre en texto en vez de un circulito de color equivocado.
 */
const COLORES = {
  negro: '#1A1A1A', blanco: '#F5F5F5', gris: '#9AA0A6', plateado: '#C0C0C0',
  rojo: '#D32F2F', bordo: '#7B1E1E', rosa: '#E91E8C', fucsia: '#D81B7A',
  naranja: '#F57C00', amarillo: '#F9C400', dorado: '#C9A227',
  verde: '#2E7D32', 'verde agua': '#4DB6AC', turquesa: '#26A69A',
  azul: '#1565C0', celeste: '#42A5F5', marino: '#152C5B',
  violeta: '#7B3FA6', lila: '#B388D9', morado: '#6A1B9A',
  marron: '#6D4C41', beige: '#D7C4A3', crema: '#EFE3C8',
  transparente: null, natural: '#E8DCC8', surtido: null,
};

export function colorDeVariedad(nombre) {
  const n = normalizar(nombre);
  if (!n) return null;
  if (n in COLORES) return COLORES[n];
  // "azul marino", "verde claro": se busca la primera palabra conocida.
  for (const clave of Object.keys(COLORES)) {
    if (n.startsWith(clave + ' ') || n.endsWith(' ' + clave)) return COLORES[clave];
  }
  return null;
}
