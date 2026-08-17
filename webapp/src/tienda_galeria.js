/**
 * Las fotos de un producto tal como las administra el panel: la galería del
 * producto y la foto de cada variedad.
 *
 * Todo esto es aritmética sobre listas y mapas, sin Firebase ni DOM. Vive
 * aparte del editor a propósito: es lo que se puede probar (lo hace
 * `tienda/pruebas/galeria_panel.test.js`) y lo que no puede tener un error
 * silencioso — una foto que se borra del producto pero queda colgada de una
 * variedad es una imagen rota en la ficha, y nadie lo ve hasta que un cliente
 * la elige.
 *
 * Cómo se guarda:
 *
 *   · `tienda_imagenes: string[]` — la galería. La primera es la PORTADA: la
 *     de la card del listado y la que abre la ficha. Las demás se ven como
 *     miniaturas debajo.
 *   · `tienda_variedades[clave].imagen` — la foto de ESA variedad. Puede ser
 *     una de la galería o una subida solo para ella. La tienda la muestra al
 *     elegir la variedad y la manda al carrito en lugar de la portada.
 *
 * Ninguna función muta lo que recibe: devuelven listas y mapas nuevos.
 */

/** Deja la foto `i` primera. Fuera de rango o ya primera, devuelve una copia. */
export function ponerDePortada(imagenes, i) {
  const lista = limpiarLista(imagenes);
  if (!Number.isInteger(i) || i <= 0 || i >= lista.length) return lista;
  const [movida] = lista.splice(i, 1);
  lista.unshift(movida);
  return lista;
}

/** Corre la foto `desde` una posición hacia `hasta`. Fuera de rango, copia. */
export function moverFoto(imagenes, desde, hasta) {
  const lista = limpiarLista(imagenes);
  if (!Number.isInteger(desde) || !Number.isInteger(hasta)) return lista;
  if (desde < 0 || hasta < 0 || desde >= lista.length || hasta >= lista.length) return lista;
  if (desde === hasta) return lista;
  const [movida] = lista.splice(desde, 1);
  lista.splice(hasta, 0, movida);
  return lista;
}

/**
 * Saca una foto de la galería, y de cualquier variedad que la tuviera puesta.
 *
 * Devuelve las dos cosas nuevas y si hubo que tocar los ajustes: quien llama
 * guarda `tienda_variedades` solo cuando `desvinculadas` trae algo, así una
 * foto que ninguna variedad usaba no reescribe el mapa entero.
 */
export function quitarFoto(imagenes, ajustes, url) {
  const buscada = String(url ?? '').trim();
  const lista = limpiarLista(imagenes).filter(u => u !== buscada);
  const { ajustes: nuevos, desvinculadas } = desvincularFoto(ajustes, buscada);
  return { imagenes: lista, ajustes: nuevos, desvinculadas };
}

/**
 * Le saca la foto `url` a toda variedad que la tuviera. No toca el resto del
 * ajuste (nombre, publicar): la variedad sigue como estaba, sin foto.
 */
export function desvincularFoto(ajustes, url) {
  const buscada = String(url ?? '').trim();
  const nuevos = {};
  const desvinculadas = [];
  for (const [clave, ajuste] of Object.entries(mapa(ajustes))) {
    if (!ajuste || typeof ajuste !== 'object') continue;
    if (String(ajuste.imagen ?? '').trim() === buscada && buscada) {
      const { imagen, ...resto } = ajuste;
      nuevos[clave] = resto;
      desvinculadas.push(clave);
    } else {
      nuevos[clave] = { ...ajuste };
    }
  }
  return { ajustes: nuevos, desvinculadas };
}

/** La foto de una variedad, o null. */
export function fotoDeVariedad(ajustes, clave) {
  const ajuste = mapa(ajustes)[clave];
  const url = String(ajuste?.imagen ?? '').trim();
  return url || null;
}

/** Le pone (o le saca, con null) la foto a una variedad. */
export function vincularFoto(ajustes, clave, url) {
  const nuevos = {};
  for (const [k, v] of Object.entries(mapa(ajustes))) nuevos[k] = { ...(v || {}) };
  const limpia = String(url ?? '').trim();
  const actual = { ...(nuevos[clave] || {}) };
  if (limpia) actual.imagen = limpia;
  else delete actual.imagen;
  nuevos[clave] = actual;
  return nuevos;
}

/**
 * Lo que se guarda en `tienda_variedades`.
 *
 * Las variedades sin nada que decir no se guardan: un mapa lleno de entradas
 * vacías engorda el documento y no cambia nada. Devuelve `undefined` cuando no
 * queda ninguna, que es lo que `guardarYEspejar` entiende como "borrar el
 * campo".
 */
export function limpiarAjustes(ajustes) {
  const limpias = {};
  for (const [clave, ajuste] of Object.entries(mapa(ajustes))) {
    if (!ajuste || typeof ajuste !== 'object') continue;
    const nombre = String(ajuste.nombre ?? '').trim();
    const oculta = ajuste.publicar === false;
    const imagen = String(ajuste.imagen ?? '').trim();
    if (!nombre && !oculta && !imagen) continue;
    limpias[clave] = { publicar: !oculta, nombre: nombre || null };
    if (imagen) limpias[clave].imagen = imagen;
  }
  return Object.keys(limpias).length ? limpias : undefined;
}

/**
 * Las fotos que ninguna variedad usa y que tampoco están en la galería:
 * quedaron huérfanas y se pueden borrar de Storage sin que nada las extrañe.
 *
 * `candidatas` son las que se subieron en esta sesión del editor; solo esas se
 * evalúan, porque son las únicas que pudieron quedar colgadas por cancelar.
 */
export function fotosHuerfanas(candidatas, imagenes, ajustes) {
  const enUso = new Set(limpiarLista(imagenes));
  for (const ajuste of Object.values(mapa(ajustes))) {
    const url = String(ajuste?.imagen ?? '').trim();
    if (url) enUso.add(url);
  }
  return [...new Set(limpiarLista(candidatas))].filter(u => !enUso.has(u));
}

/**
 * Las fotos que estaban antes y ya no están después: son las que hay que
 * sacar de Storage (y desvincular de las variedades) al guardar la galería.
 * Lo nuevo que todavía no se subió no cuenta: no está en ninguna de las dos.
 */
export function fotosQuitadas(antes, despues) {
  const quedan = new Set(limpiarLista(despues));
  return [...new Set(limpiarLista(antes))].filter(u => !quedan.has(u));
}

function limpiarLista(imagenes) {
  return (Array.isArray(imagenes) ? imagenes : [])
    .map(u => String(u ?? '').trim())
    .filter(Boolean);
}

function mapa(ajustes) {
  return ajustes && typeof ajustes === 'object' && !Array.isArray(ajustes) ? ajustes : {};
}
