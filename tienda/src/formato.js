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
 * Los horarios, partidos en renglones.
 *
 * En la config viven como un solo texto separado por puntos medios
 * ("Lunes a viernes de 9 a 13 · Sábados de 9 a 13 · Domingos cerrado"), que es
 * comodo de editar pero se lee mal: en el pie y en la opcion de retiro del
 * checkout entra en una sola linea, se corta y hay que adivinar el resto.
 *
 * Cada tramo va en su renglon. El punto medio se acepta con y sin espacios
 * alrededor, y tambien el punto y coma, porque el texto lo escribe una persona.
 */
export function lineasDeHorario(texto) {
  return String(texto || '')
    .split(/\s*[·;]\s*/)
    .map(l => l.trim())
    .filter(Boolean);
}

/**
 * Lo que venga de Firestore, pasado a Date.
 *
 * Un campo de fecha llega como Timestamp cuando el documento ya volvio del
 * servidor, pero como null en el instante entre que se escribe con
 * `serverTimestamp()` y que el servidor confirma. El seguimiento pinta en ese
 * hueco, asi que devolver null en vez de una fecha inventada es parte del
 * contrato.
 */
export function aFecha(valor) {
  if (!valor) return null;
  const fecha = typeof valor?.toDate === 'function' ? valor.toDate() : new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

// `hour12: false` explícito: es-AR devuelve "02:17 p. m." por defecto y acá la
// hora se lee de un vistazo, no se interpreta.
const HORA = new Intl.DateTimeFormat('es-AR', {
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const DIA = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'long' });

/** "Hoy 14:33" · "Ayer 19:02" · "5 de agosto, 14:33" */
export function cuando(valor) {
  const fecha = aFecha(valor);
  if (!fecha) return '';

  const dias = diasDeDiferencia(fecha, new Date());
  if (dias === 0) return `Hoy ${HORA.format(fecha)}`;
  if (dias === 1) return `Ayer ${HORA.format(fecha)}`;
  return `${DIA.format(fecha)}, ${HORA.format(fecha)}`;
}

/**
 * "recién" · "hace 12 minutos" · "hace 3 horas" · "hace 2 días"
 *
 * Es lo que le da a la pantalla la sensacion de estar viva cuando el cliente
 * vuelve a mirarla. Se corta en los dias: mas atras que eso, la hora exacta
 * dice mas que el tiempo transcurrido.
 */
export function haceCuanto(valor) {
  const fecha = aFecha(valor);
  if (!fecha) return '';

  const minutos = Math.floor((Date.now() - fecha.getTime()) / 60000);
  if (minutos < 1) return 'recién';
  if (minutos < 60) return `hace ${plural(minutos, 'minuto')}`;

  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `hace ${plural(horas, 'hora')}`;

  return `hace ${plural(Math.floor(horas / 24), 'día')}`;
}

/** Dias de calendario entre dos fechas, no de 24 horas: "ayer" es ayer. */
function diasDeDiferencia(a, b) {
  const soloDia = f => new Date(f.getFullYear(), f.getMonth(), f.getDate()).getTime();
  return Math.round((soloDia(b) - soloDia(a)) / 86_400_000);
}

function plural(n, palabra) {
  return `${n} ${palabra}${n === 1 ? '' : 's'}`;
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
 * Palabras que el sync NO guarda como token al indexar (`VACIAS` en
 * scripts/sync_tienda.py). Tienen que ser exactamente las mismas: si la
 * consulta pide una palabra que el indice nunca guardo, la busqueda devuelve
 * cero aunque el producto exista.
 *
 * Lo que pasaba: "Goma Borrar Maped" queda indexado como [goma, borrar, maped],
 * sin el "de". Buscar "goma de borrar" exigia un token que empieza con "de" y
 * no lo tiene ningun producto del catalogo. Medido: "goma de borrar" devolvia 0
 * y "goma borrar" 21.
 */
export const VACIAS = new Set([
  'de', 'del', 'la', 'las', 'el', 'los', 'y', 'con', 'sin',
  'para', 'por', 'a', 'en', 'un', 'una', 'marca',
]);

/**
 * La consulta partida en palabras, con el mismo criterio con el que el sync
 * arma los `tokens` de cada producto.
 *
 * Se corta por caracter no alfanumerico y no por espacio, porque el sync hace
 * lo mismo: "2,5cm" queda como el token "5cm".
 *
 * @param {string} texto
 * @param {Set<string>} [extras]  palabras a descartar ademas de las del indice
 */
export function despiezar(texto, extras = null) {
  return normalizar(texto)
    .split(/[^0-9a-z]+/)
    .filter(p => p.length >= 2 && !VACIAS.has(p) && !(extras && extras.has(p)));
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
