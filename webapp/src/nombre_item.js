/**
 * Leer el nombre del renglón que escribió el POS.
 *
 * Cuando la venta sale del diálogo de producto conjunto, el POS no guarda el
 * nombre pelado: guarda uno "decorado" con la variedad y la presentación
 * adentro.
 *
 *     "[Verde]  GOMA EVA 40X60  ·  2 u"
 *     "PAPEL OBRA A4  ·  1 pack(s)"
 *     "CINTA RASO  ·  2,5 m"
 *
 * Ese texto es el ÚNICO lugar donde vive la cantidad real de una venta
 * fraccionada: el campo `cantidad` de `ventas_por_dia` dice 1 cuando se
 * vendieron 2,5 metros, y dice 1 cuando se vendió un rollo de 25. Por eso hay
 * dos cosas para sacar de acá: cuál es el producto de verdad, y cuántas
 * unidades base se llevó.
 *
 * Lo usan dos cosas que parecen no tener nada que ver:
 *   · `stock_revert.js`, para saber cuánto stock devolver al borrar una venta;
 *   · `inventario_resumen.js`, para la velocidad de venta. Sin esto, todo lo
 *     que se vende fraccionado quedaba indexado por su nombre decorado, no
 *     coincidía con ningún producto del catálogo y figuraba con cero ventas:
 *     el Inventario lo mostraba "sin movimiento" y el Centro de Compras no lo
 *     proponía nunca.
 *
 * Las tablas de abajo son gemelas de `pos_system/models/conjunto.py`;
 * `tienda/pruebas/stock_revert.test.js` las compara.
 */

const SEPARADOR = '·';

export const CONJ_TIPOS = {
  rollo: 'rollo', pack: 'pack', caja: 'caja', bobina: 'bobina', bolsa: 'bolsa',
  plancha: 'plancha', cartulina: 'cartulina', papel: 'papel', carton: 'cartón',
  goma_eva: 'goma eva', cinta: 'cinta', tela: 'tela', unidad: 'unidad', otro: 'otro',
};

export const CONJ_UNIDADES = {
  m:  { short: 'm',  base: 'longitud', factor: 1 },
  cm: { short: 'cm', base: 'longitud', factor: 0.01 },
  u:  { short: 'u',  base: 'cuenta',   factor: 1 },
  g:  { short: 'g',  base: 'masa',     factor: 0.001 },
  kg: { short: 'kg', base: 'masa',     factor: 1 },
  l:  { short: 'l',  base: 'volumen',  factor: 1 },
  ml: { short: 'ml', base: 'volumen',  factor: 0.001 },
  m2: { short: 'm²', base: 'area',     factor: 1 },
};

export const UNIDAD_WEBAPP = {
  metros: 'm', m: 'm', centimetros: 'cm', 'centímetros': 'cm', cm: 'cm',
  unidades: 'u', u: 'u', gramos: 'g', g: 'g', kilos: 'kg', kilogramos: 'kg', kg: 'kg',
  litros: 'l', l: 'l', mililitros: 'ml', ml: 'ml', m2: 'm2', 'm²': 'm2',
};

function _num(n) { return Number(n) || 0; }

/**
 * Parte el nombre decorado en variedad, producto y presentación.
 * @returns {{color: string, base: string, descripcion: string}}
 */
export function parseNombreItem(txt) {
  let s = String(txt || '').trim();
  let color = '';
  const m = s.match(/^\[([^\]]*)\]\s*(.+)$/);
  if (m) { color = m[1].trim(); s = m[2].trim(); }
  let descripcion = '';
  if (s.includes(SEPARADOR)) {
    const partes = s.split(SEPARADOR);
    descripcion = partes.pop().trim();
    s = partes.join(SEPARADOR).trim();
  }
  return { color, base: s, descripcion };
}

/**
 * Cuánto stock (en unidad base del conjunto) representa UNA unidad del campo
 * `cantidad` del renglón, según la presentación escrita en el nombre
 * ("1 pack(s)", "2 u", "0,5 m").
 *
 * El POS arma el carrito así: si la cantidad vendida es entera, va como
 * `cantidad = N` con el nombre diciendo "N <unidad>"; si es decimal, va como
 * `cantidad = 1` y la cantidad real queda sólo en el nombre. Por eso el factor
 * incluye N cuando N no es entero.
 *
 * Devuelve null si la unidad no se puede interpretar: es preferible no
 * contestar y que quien llama avise, antes que devolver una cantidad
 * equivocada.
 */
export function factorPorUnidad(prod, descripcion) {
  const m = String(descripcion || '').trim().match(/^([\d]+(?:[.,][\d]+)?)\s*(.+)$/);
  if (!m) return null;
  const n = Number(String(m[1]).replace(',', '.'));
  if (!(n > 0)) return null;
  const unidadTxt = m[2].trim().toLowerCase();
  const porItem = Number.isInteger(n) ? 1 : n;

  // Vendido por contenedor entero: "1 pack(s)", "2 rollo(s)".
  const tipo = CONJ_TIPOS[String(prod?.conjunto_tipo || '').toLowerCase()];
  const contenido = _num(prod?.conjunto_contenido);
  if (tipo && unidadTxt === `${tipo}(s)`) {
    return contenido > 0 ? porItem * contenido : null;
  }

  // Vendido por unidad base o por una unidad convertible (cm→m, g→kg, …).
  const baseKey  = UNIDAD_WEBAPP[String(prod?.conjunto_unidad_medida || '').toLowerCase()] || 'u';
  const specBase = CONJ_UNIDADES[baseKey];
  const spec = Object.values(CONJ_UNIDADES).find(u => u.short.toLowerCase() === unidadTxt);
  if (!spec || !specBase || spec.base !== specBase.base) return null;
  return porItem * (spec.factor / specBase.factor);
}

/**
 * Cuántas unidades base se llevó un renglón de `ventas_por_dia`.
 *
 * `prod` es el producto del catálogo, que hace falta para entender "1 pack(s)".
 * Sin él —o si la presentación no se puede leer— vale la cantidad tal cual,
 * que es lo que corresponde para un producto común.
 */
/**
 * Encuentra el producto del catálogo que corresponde a un renglón vendido.
 *
 * `indice` es un objeto {NOMBRE EN MAYÚSCULAS: producto}. Se prueba primero el
 * nombre tal cual —por si algún producto lleva un "·" en su nombre de verdad—
 * y recién después el nombre limpio. Así sólo se pueden encontrar MÁS
 * productos, nunca cambiar una coincidencia que ya funcionaba.
 *
 * Sin esto, todo lo que se vende fraccionado no cruza contra el catálogo: no
 * tiene costo, no suma al CMV y el panel avisa "X% del ingreso sin costo
 * cargado" cuando el costo estaba cargado desde siempre.
 */
export function buscarPorNombre(indice, nombreDelRenglon) {
  if (!indice) return null;
  const crudo = String(nombreDelRenglon || '').toUpperCase().trim();
  if (crudo && indice[crudo]) return indice[crudo];
  const limpio = String(parseNombreItem(nombreDelRenglon).base || '').toUpperCase().trim();
  return (limpio && indice[limpio]) ? indice[limpio] : null;
}

export function unidadesDelRenglon(item, prod = null) {
  const cantidad = _num(item?.cantidad) || 1;
  const { descripcion } = parseNombreItem(item?.producto || item?.product_name);
  if (!descripcion || !prod) return cantidad;
  const factor = factorPorUnidad(prod, descripcion);
  return factor === null ? cantidad : cantidad * factor;
}
