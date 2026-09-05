/**
 * Las reglas de cuánto sale un renglón y de a cuánto se vende.
 *
 * Están acá, sueltas y sin ninguna importación, porque las usan los dos lados:
 * el carrito del navegador y la función que crea el pedido en el servidor. Si
 * vivieran solo en `carrito.js` habría que escribirlas de nuevo del lado del
 * servidor, y el día que el panel cambie un mínimo las dos copias empiezan a
 * cobrar distinto sin que nadie se entere.
 *
 * Nada de acá toca Firebase ni el DOM: es aritmética sobre el producto tal como
 * lo publica el espejo.
 */

/**
 * Cuanto suma o resta un toque.
 *
 * Se acepta el producto entero o solo su unidad: el panel puede fijar un paso
 * propio por producto ("de a 6"), y cuando no lo hizo vale el natural — medio
 * metro para lo que se corta del rollo, uno para el resto.
 */
export function pasoDe(productoOUnidad) {
  if (typeof productoOUnidad === 'object' && productoOUnidad) {
    const propio = Number(productoOUnidad.paso);
    if (propio > 0) return propio;
    return productoOUnidad.unidad === 'metro' ? 0.5 : 1;
  }
  return productoOUnidad === 'metro' ? 0.5 : 1;
}

/**
 * Lo minimo que se puede llevar de este producto.
 *
 * Un pedido online cuesta trabajo aunque sea de $100: hay que leerlo, buscar la
 * cosa entre dos mil cuatrocientas, contarla, embalarla. Por eso hay productos
 * que en el mostrador se venden de a uno y por la web no: medido, un mapa de
 * $100 deja $40 y eso no paga ni el minuto de ir a buscarlo.
 *
 * Sin configurar es un paso, o sea como estaba siempre.
 */
export function minimoDe(producto) {
  const propio = Number(producto?.minimo);
  const paso = pasoDe(producto);
  return propio > 0 ? Math.max(propio, paso) : paso;
}

/**
 * Si el producto se vende únicamente por pack entero (el rollo, la caja).
 *
 * La señal la da el panel sin campo nuevo: un mínimo igual o mayor al
 * contenido del pack dice que lo suelto no se ofrece — pedir 100 metros de
 * una tanza de 100 es pedir el rollo. La ficha y las cards pasan a ofrecer
 * solo el pack, al precio del pack; el precio por metro deja de mostrarse.
 */
export function soloPack(producto) {
  const contenido = Number(producto?.pack_contenido);
  return Number(producto?.precio_pack) > 0 && contenido > 0
    && Number(producto?.minimo) >= contenido;
}

/** La variedad elegida dentro del producto, o null. */
export function variedadDe(producto, nombre) {
  if (!nombre) return null;
  return (producto?.variedades || []).find(v => v.nombre === nombre) || null;
}

/**
 * Lo que sale una unidad de este renglón: el rollo entero si va por pack, el
 * precio propio de la variedad si lo tiene, y si no el del producto.
 */
export function precioDeRenglon(producto, { variedad = null, esPack = false } = {}) {
  if (esPack) return Number(producto?.precio_pack || 0);
  const v = variedadDe(producto, variedad);
  return Number((v && v.precio) ? v.precio : producto?.precio) || 0;
}

/**
 * Cuántas unidades de este renglón se pueden despachar.
 *
 * Por pack se cuentan packs enteros: con 60 metros sueltos no hay un rollo de
 * 100 para vender. Con variedad elegida manda el stock de esa variedad, que es
 * el error que termina en una llamada incómoda: la cartulina tiene 1.180 en
 * total y 12 celestes.
 */
export function stockDeRenglon(producto, { variedad = null, esPack = false } = {}) {
  const v = variedadDe(producto, variedad);
  const unidades = v ? Number(v.stock ?? 0) : Number(producto?.stock ?? 0);
  if (!esPack) return unidades;
  const contenido = Number(producto?.pack_contenido) || 1;
  return Math.floor(unidades / contenido);
}

/**
 * Los flotantes dejan restos tipo 2.4000000000000004 al sumar de a 0,5. Un
 * decimal alcanza para medio metro y evita que el total salga con centavos
 * fantasma.
 */
export function redondearCantidad(n) {
  return Math.round(Number(n) * 10) / 10;
}

/**
 * Lo que suma un renglón al pedido.
 *
 * El redondeo va por renglón y no sobre el total: es como lo muestra el
 * resumen del checkout, y si el total se redondeara aparte podría no coincidir
 * con la suma de lo que el cliente tiene a la vista.
 */
export function subtotalDeRenglon(precio, cantidad) {
  return Math.round(Number(precio) * Number(cantidad));
}

/**
 * Arriba de este porcentaje el ahorro no se muestra.
 *
 * Una resma de 500 hojas a $7.800 contra la hoja suelta a $50 da "Ahorrás
 * 69%", y es cierto: la hoja de a una se cobra como se cobra en el mostrador.
 * Pero dicho asi suena a que lo suelto esta caro, no a que el pack conviene.
 * De ahi para arriba se muestra el precio del pack y listo.
 */
const TOPE_AHORRO_PACK = 50;

/**
 * Cuanto se ahorra llevando el pack en vez de lo mismo suelto.
 *
 * Una sola cuenta para la ficha, el carrito y el checkout: si en la ficha dice
 * 12%, en el resumen del pedido no puede decir otra cosa. Devuelve null cuando
 * no hay ahorro que mostrar (no conviene, o conviene tanto que no se dice).
 *
 * @returns {{ pesos: number, porcentaje: number } | null}
 */
export function ahorroDePack({ precioSuelto, precioPack, contenido, cantidad = 1 }) {
  const suelto = Number(precioSuelto) * Number(contenido) * Number(cantidad);
  const pack = Number(precioPack) * Number(cantidad);
  if (!(suelto > 0) || !(pack > 0)) return null;
  const pesos = suelto - pack;
  const porcentaje = Math.round((pesos / suelto) * 100);
  if (pesos <= 0 || porcentaje <= 0 || porcentaje > TOPE_AHORRO_PACK) return null;
  return { pesos, porcentaje };
}
