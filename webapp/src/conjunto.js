/**
 * Las cuentas de un producto conjunto, lado panel.
 *
 * Espejo de `pos_system/models/conjunto.py`: la misma regla escrita en los dos
 * lenguajes, y `tienda/pruebas/conjunto.test.js` las compara caso por caso.
 * Si se cambia una, se cambia la otra y se agrega el caso a la prueba.
 *
 * Lo que se guarda:
 *     total = unidades × contenido + restante
 * `unidades` son los packs CERRADOS y `restante` las unidades sueltas del pack
 * abierto. Cuando se abre un pack baja de `unidades` y su contenido pasa a
 * `restante`, así que nunca se cuentan dos veces.
 *
 * Lo que se tipea en el formulario es LITERAL desde el 2026-08-31: packs
 * CERRADOS por un lado y sueltos por el otro; el abierto no se cuenta como
 * pack. Entre el 22-08 y el 31-08 rigió la "regla del estante" (lo tipeado
 * incluía el abierto y el guardado le restaba uno); se retiró a pedido del
 * dueño y la traducción histórica vive solo en `pos_system/models/conjunto.py`
 * (`packs_a_guardar` / `packs_a_mostrar`), que la migración
 * `scripts/corregir_pack_abierto.py` usó para dejar todo el catálogo en
 * cerrados el 31-08. `conjunto_packs_cerrados: true` marca los docs cuyo
 * `unidades` ya son packs cerrados.
 */

export function num(v, porDefecto = 0) {
  if (v === null || v === undefined || v === '') return porDefecto;
  const n = Number(v);
  return Number.isFinite(n) ? n : porDefecto;
}

function redondear(n) {
  return Math.round(n * 10000) / 10000;
}

/** Cuántas unidades trae el pack de esta variedad: el suyo si lo tiene, si no el del producto. */
export function contenidoDe(variedad, contenidoProducto) {
  const propio = num(variedad?.contenido);
  return propio > 0 ? propio : num(contenidoProducto);
}

/** Unidades sueltas totales de una variedad: cerrados × contenido + sueltos. */
export function totalVariedad(variedad, contenidoProducto) {
  const v = variedad || {};
  return num(v.unidades) * contenidoDe(v, contenidoProducto) + num(v.restante);
}

/** Lo mismo, sumado sobre todas las variedades. */
export function totalConjunto(colores, contenidoProducto) {
  return (Array.isArray(colores) ? colores : [])
    .filter(c => c && typeof c === 'object')
    .reduce((acc, c) => acc + totalVariedad(c, contenidoProducto), 0);
}

/**
 * Parte un total en (packs cerrados, sueltos), inversa exacta de `totalVariedad`:
 * repartirTotal(t, c) devuelve {unidades, restante} con unidades × c + restante = t.
 * Sin contenido no hay packs posibles y todo queda como suelto.
 */
export function repartirTotal(total, contenido) {
  const t = Math.max(0, redondear(num(total)));
  const c = num(contenido);
  if (!(c > 0)) return { unidades: 0, restante: t, total: t };
  const cerrados = Math.floor(t / c);
  const resto = redondear(t - cerrados * c);
  if (resto < 1e-9) return { unidades: cerrados, restante: 0, total: t };
  return { unidades: cerrados, restante: resto, total: t };
}

/**
 * Saca `delta` unidades sueltas de un conjunto y vuelve a partir lo que queda.
 * Si los sueltos no alcanzan, se abre un pack solo. `delta` negativo devuelve
 * mercadería. Nunca baja de cero.
 */
export function descontarDeTotal(total, delta, contenido) {
  return repartirTotal(Math.max(0, num(total) - num(delta)), contenido);
}

/** Si el producto ya está guardado con `unidades` = packs cerrados. */
export function guardaCerrados(producto) {
  return producto?.conjunto_packs_cerrados === true;
}

/**
 * Campos a escribir cuando se edita el stock total desde el editor rápido del
 * inventario. Hasta ahora ese editor tocaba solo el `stock` plano y el
 * conjunto quedaba atrás: la caja cargada a mano desaparecía en la ficha
 * (caso real: ALFILER ERIZO, 27-08). Devuelve null si el producto tiene
 * variedades — ahí no se puede saber a qué variedad va la mercadería y el
 * número se carga desde la ficha.
 */
export function camposStockRapido(producto, valor) {
  const p = producto || {};
  const esConjunto = p.es_conjunto === true || p.es_conjunto === 1;
  if (!esConjunto) return { stock: Math.max(0, num(valor)) };
  const tieneVariedades = Array.isArray(p.conjunto_colores)
    && p.conjunto_colores.some(c => c && typeof c === 'object');
  if (tieneVariedades) return null;
  const r = repartirTotal(valor, num(p.conjunto_contenido));
  return {
    stock: Math.max(0, Math.floor(r.total)),
    conjunto_unidades: r.unidades,
    conjunto_restante: r.restante,
    conjunto_total: r.total,
    conjunto_packs_cerrados: true,
  };
}
