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
 * Lo que carga el personal es otra cosa: cuenta los packs que ve en el estante,
 * incluido el abierto, y aparte los sueltos. "3 packs y 36 sueltos" quiere decir
 * 2 cerrados + 1 abierto con 36. Hasta el 2026-08-22 el formulario guardaba los
 * 3 como cerrados y cada papel quedaba con un pack fantasma: la góndola se
 * vaciaba mientras el sistema todavía mostraba 250 hojas. `packsAGuardar` y
 * `packsAMostrar` hacen la traducción entre las dos lecturas; el producto lleva
 * `conjunto_packs_cerrados: true` cuando ya está guardado con la regla nueva.
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

/**
 * Packs cerrados a guardar a partir de lo que tipeó el personal: los packs que
 * ve (incluido el abierto) y los sueltos. Con sueltos, uno de esos packs es el
 * abierto y no se cuenta entero.
 */
export function packsAGuardar(packsVistos, sueltos) {
  const p = Math.max(0, num(packsVistos));
  return num(sueltos) > 0 ? Math.max(0, p - 1) : p;
}

/**
 * Packs a mostrar en el formulario a partir de lo guardado: los cerrados más
 * el abierto, si hay sueltos. Es la inversa de `packsAGuardar` siempre que
 * haya al menos un pack.
 */
export function packsAMostrar(cerrados, sueltos) {
  const c = Math.max(0, num(cerrados));
  return num(sueltos) > 0 ? c + 1 : c;
}

/** Si el producto ya está guardado con `unidades` = packs cerrados. */
export function guardaCerrados(producto) {
  return producto?.conjunto_packs_cerrados === true;
}

/**
 * Si lo que muestra y tipea el formulario incluye el pack abierto (regla
 * nueva). En productos nuevos o ya migrados sí; en los viejos los inputs
 * muestran `unidades` tal cual está guardado, que es lo que el POS vende como
 * cerrados — restarles uno en pantalla muestra un pack menos del que hay.
 * Misma condición que decide `convertirPacks` al guardar.
 */
export function formularioIncluyeAbierto(producto, esNuevo) {
  if (esNuevo) return true;
  const eraConjunto = producto?.es_conjunto === true || producto?.es_conjunto === 1;
  return !eraConjunto || guardaCerrados(producto);
}

/**
 * Packs cerrados a partir de lo tipeado en el formulario, respetando la
 * convención del producto: con la regla nueva lo tipeado incluye el abierto y
 * se descuenta; con la vieja ya son los cerrados y van tal cual.
 */
export function packsCerradosTipeados(packsTipeados, sueltos, incluyeAbierto) {
  return incluyeAbierto
    ? packsAGuardar(packsTipeados, sueltos)
    : Math.max(0, num(packsTipeados));
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
