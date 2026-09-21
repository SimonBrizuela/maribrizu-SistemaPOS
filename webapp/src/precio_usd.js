/**
 * Los productos que se compran en dólares, pasados a pesos.
 *
 * Hay mercadería que el proveedor cobra en dólares (importado, accesorios de
 * plata, algún juguete). Cargar el precio en pesos a mano significa que cada
 * salto del dólar deja el precio viejo hasta que alguien se acuerda de tocarlo
 * producto por producto. La alternativa es guardar el precio EN DÓLARES y
 * pasarlo a pesos con la cotización del momento, cada vez que se vende.
 *
 * Cómo se guarda un producto en dólares
 * -------------------------------------
 * En el documento de `catalogo`, además de lo de siempre:
 *
 *   moneda_costo: 'USD'     el producto se maneja en dólares. Cualquier otra
 *                           cosa (o nada) = pesos, y acá no pasa nada.
 *   costo_usd:    12.5      lo que cuesta el pack/la unidad, en dólares
 *   precio_usd:   43.75     lo que se vende, en dólares (costo × margen)
 *   conjunto_precio_unidad_usd
 *                           lo que sale UNA unidad, en dólares
 *   conjunto_colores[].costo_usd / .precio_pack_usd / .precio_usd
 *                           lo mismo por variedad
 *
 * `costo`, `precio_venta`, `conjunto_precio_unidad` y los precios de cada
 * variedad SIGUEN escritos en pesos. Son el último precio calculado, y es lo
 * que usa todo lo que no sabe de dólares: el balance, los reportes, el Centro
 * de Compras, y el propio POS cuando se queda sin cotización. Un producto en
 * dólares nunca se queda sin precio: en el peor caso vende al último que se
 * calculó.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ IMPORTANTE — esto es un gemelo de `pos_system/utils/precio_usd.py`. El  │
 * │ panel muestra el precio en pesos mientras se edita la ficha, el POS lo  │
 * │ calcula al vender y el sync de la tienda lo publica: si las dos cuentas │
 * │ no dan EXACTAMENTE lo mismo, el cliente ve un precio en la vidriera, el │
 * │ cajero cobra otro y nadie entiende por qué.                             │
 * │ `tienda/pruebas/precio_usd.test.js` las compara con los casos de        │
 * │ `scripts/casos_precio_usd.py`.                                          │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * No depende de Firebase ni del DOM: lo importan el panel, el espejo de la
 * tienda y las pruebas.
 */
import { redondearCentena } from './tienda_descuentos_regla.js';

// Nombre del campo que marca un producto en dólares, y su único valor válido.
export const MONEDA_USD = 'USD';

/** Lo que venga (texto, null, número) leído como número. */
function numero(v, porDefecto = 0) {
  if (v === null || v === undefined || v === '' || v === false) return porDefecto;
  const n = Number(v);
  return Number.isFinite(n) ? n : porDefecto;
}

/** True si este producto lleva los precios en dólares. */
export function esUsd(producto) {
  if (!producto || typeof producto !== 'object') return false;
  return String(producto.moneda_costo ?? '').trim().toUpperCase() === MONEDA_USD;
}

/**
 * La cotización sirve solo si es un número positivo y creíble.
 *
 * El tope de 1.000.000 no es paranoia: una respuesta rota de la API que
 * devuelva el valor en centavos, o un cero mal leído al cargarla a mano,
 * multiplicaría todos los precios del local de una. Ante la duda, no se
 * convierte nada y se vende con el último precio en pesos.
 */
export function cotizacionValida(cotizacion) {
  const n = numero(cotizacion);
  return n > 0 && n < 1000000;
}

/**
 * Un precio de venta en dólares, en pesos y redondeado como el local.
 *
 * Devuelve 0 cuando no hay con qué calcular: el que llama decide con qué
 * precio se queda (siempre el último en pesos, nunca cero).
 */
export function precioEnPesos(montoUsd, cotizacion) {
  const usd = numero(montoUsd);
  if (usd <= 0 || !cotizacionValida(cotizacion)) return 0;
  return redondearCentena(usd * numero(cotizacion));
}

/**
 * Un costo en dólares, en pesos.
 *
 * El costo NO se redondea a la centena: no es un precio de mostrador, es lo
 * que se paga. Redondearlo ensuciaría el margen y el Centro de Compras.
 */
export function costoEnPesos(montoUsd, cotizacion) {
  const usd = numero(montoUsd);
  if (usd <= 0 || !cotizacionValida(cotizacion)) return 0;
  return Math.round(usd * numero(cotizacion) * 100) / 100;
}

/**
 * El precio de UNA unidad fraccionada (un metro, un bolígrafo) en pesos.
 *
 * Sin redondeo a la centena: un metro de cinta a $150 pasaría a $200, un 33%
 * más. El precio unitario se maneja con dos decimales, igual que cuando se
 * deriva del precio del pack.
 */
export function precioUnidadEnPesos(montoUsd, cotizacion) {
  const usd = numero(montoUsd);
  if (usd <= 0 || !cotizacionValida(cotizacion)) return 0;
  return Math.round(usd * numero(cotizacion) * 100) / 100;
}

/**
 * El precio de venta en dólares que sale de un costo y un margen.
 *
 * Se guarda calculado (`precio_usd`) para que pasar a pesos sea una sola
 * multiplicación y no dependa de que el margen siga estando.
 */
export function precioDesdeCosto(costoUsd, margenPct) {
  const costo = numero(costoUsd);
  if (costo <= 0) return 0;
  return Math.round(costo * (1 + numero(margenPct) / 100) * 10000) / 10000;
}

/**
 * Una variedad con sus precios del día, si tiene precios en dólares.
 *
 * Devuelve una copia. Los campos en dólares se dejan tal cual: el que los lea
 * después tiene que poder recalcular.
 */
export function convertirVariedad(variedad, cotizacion) {
  if (!variedad || typeof variedad !== 'object') return variedad;
  const copia = { ...variedad };
  if (!cotizacionValida(cotizacion)) return copia;

  const costoUsd = numero(copia.costo_usd);
  if (costoUsd > 0) copia.costo = costoEnPesos(costoUsd, cotizacion);

  const packUsd = numero(copia.precio_pack_usd);
  if (packUsd > 0) copia.precio_pack = precioEnPesos(packUsd, cotizacion);

  const unitUsd = numero(copia.precio_usd);
  if (unitUsd > 0) copia.precio = precioUnidadEnPesos(unitUsd, cotizacion);

  return copia;
}

/**
 * El producto con los precios en pesos de hoy.
 *
 * Devuelve una copia con `price`/`precio_venta`, `cost`/`costo`,
 * `conjunto_precio_unidad` y cada variedad recalculados con la cotización.
 * Si el producto no es en dólares, o la cotización no sirve, devuelve una
 * copia sin tocar: el último precio en pesos es siempre un precio válido.
 *
 * Acepta tanto el documento del catálogo (`precio_venta`, `costo`) como la
 * fila de SQLite del POS (`price`, `cost`), y escribe las dos formas cuando
 * ya estaban, para que cualquiera de los dos lados lo lea igual.
 */
export function convertirProducto(producto, cotizacion) {
  if (!producto || typeof producto !== 'object') return producto;
  const copia = { ...producto };
  if (!esUsd(producto) || !cotizacionValida(cotizacion)) return copia;

  const precioUsd = numero(copia.precio_usd);
  if (precioUsd > 0) {
    const pesos = precioEnPesos(precioUsd, cotizacion);
    if (pesos > 0) {
      if ('price' in copia) copia.price = pesos;
      if ('precio_venta' in copia || !('price' in copia)) copia.precio_venta = pesos;
    }
  }

  const costoUsd = numero(copia.costo_usd);
  if (costoUsd > 0) {
    const pesosCosto = costoEnPesos(costoUsd, cotizacion);
    if (pesosCosto > 0) {
      if ('cost' in copia) copia.cost = pesosCosto;
      if ('costo' in copia || !('cost' in copia)) copia.costo = pesosCosto;
    }
  }

  const unidadUsd = numero(copia.conjunto_precio_unidad_usd);
  if (unidadUsd > 0) {
    const pesosUnidad = precioUnidadEnPesos(unidadUsd, cotizacion);
    if (pesosUnidad > 0) copia.conjunto_precio_unidad = pesosUnidad;
  }

  if (Array.isArray(copia.conjunto_colores) && copia.conjunto_colores.length) {
    copia.conjunto_colores = copia.conjunto_colores.map(
      c => (c && typeof c === 'object' ? convertirVariedad(c, cotizacion) : c)
    );
  }

  return copia;
}

/**
 * True si el producto trae algún precio en dólares para convertir.
 *
 * Un producto marcado en dólares pero sin ningún `*_usd` cargado todavía no
 * tiene nada que recalcular: se vende con lo que diga en pesos.
 */
export function tienePreciosUsd(producto) {
  if (!esUsd(producto)) return false;
  if (numero(producto.precio_usd) > 0) return true;
  if (numero(producto.costo_usd) > 0) return true;
  if (numero(producto.conjunto_precio_unidad_usd) > 0) return true;
  const colores = producto.conjunto_colores;
  if (Array.isArray(colores)) {
    for (const c of colores) {
      if (!c || typeof c !== 'object') continue;
      if (numero(c.precio_usd) > 0 || numero(c.precio_pack_usd) > 0 || numero(c.costo_usd) > 0) {
        return true;
      }
    }
  }
  return false;
}
