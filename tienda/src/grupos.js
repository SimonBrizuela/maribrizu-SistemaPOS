/**
 * Un producto que se hace en varios tamaños sale a la vidriera UNA sola vez.
 *
 * El catálogo carga "Cierre Común 10 cm", "Cierre Común 12 cm"… como productos
 * separados —cada uno con su stock y su precio, que es como se cobra en el
 * mostrador— y la tienda mostraba diez cards casi iguales, una atrás de otra.
 * El panel los agrupa (campos `tienda_grupo` y `tienda_tamano` del catálogo,
 * que el espejo publica como `grupo`, `grupo_clave` y `tamano`) y acá la grilla
 * los pliega: una card con el nombre del grupo, y el tamaño se elige adentro
 * de la ficha.
 *
 * Lógica pura, sin Firebase: es lo que permite probarla en grupos.test.js.
 */

/**
 * Los números que tiene una etiqueta de tamaño, para ordenar como ordena una
 * persona: "9 cm" antes que "10 cm" (alfabético los da vuelta), "10x15" antes
 * que "10x20". Sin ningún número queda al final, en orden alfabético.
 */
export function valorDeTamano(tamano) {
  const numeros = String(tamano || '').match(/\d+(?:[.,]\d+)?/g) || [];
  if (!numeros.length) return [Infinity];
  return numeros.map(n => parseFloat(n.replace(',', '.')));
}

function compararTamanos(a, b) {
  const va = valorDeTamano(a.tamano);
  const vb = valorDeTamano(b.tamano);
  const largo = Math.max(va.length, vb.length);
  for (let i = 0; i < largo; i++) {
    const na = va[i] ?? -Infinity;
    const nb = vb[i] ?? -Infinity;
    if (na !== nb) return na - nb;
  }
  return String(a.tamano || a.nombre).localeCompare(String(b.tamano || b.nombre), 'es');
}

/** Los productos de un grupo en el orden del tamaño, del más chico al más grande. */
export function ordenarPorTamano(productos) {
  return productos.slice().sort(compararTamanos);
}

/**
 * Cómo se llama cada botón del selector de tamaños, sin dos iguales.
 *
 * El tamaño lo escribe una persona en el panel, así que en Papel Obra hay dos
 * miembros del grupo etiquetados "200 gr" (son de marcas distintas). El selector
 * mostraba dos botones idénticos y no había forma de saber cuál era cuál: se
 * elegía a ver qué salía.
 *
 * Se desempata con lo primero que los distinga: la marca, después el nombre
 * completo del producto y, si ni eso los separa —dos fichas realmente gemelas en
 * el catálogo—, un número, que es feo pero no miente.
 *
 * @param {Array} tamanos miembros del grupo, ya ordenados
 * @returns {string[]} una etiqueta por miembro, en el mismo orden
 */
export function etiquetasDeTamano(tamanos) {
  const base = tamanos.map(t => String(t.tamano || t.nombre || '').trim() || '—');
  const repetidas = new Set(base.filter((e, i) => base.indexOf(e) !== i));

  const usadas = new Set();
  return base.map((etiqueta, i) => {
    if (!repetidas.has(etiqueta)) { usadas.add(etiqueta); return etiqueta; }

    const t = tamanos[i];
    const marca = String(t.marca || '').trim();
    const nombre = String(t.nombre || '').trim();

    let elegida = [marca ? `${etiqueta} · ${marca}` : null, nombre || null]
      .find(c => c && !usadas.has(c));

    if (!elegida) {
      let n = 2;
      while (usadas.has(`${etiqueta} (${n})`)) n += 1;
      elegida = `${etiqueta} (${n})`;
    }

    usadas.add(elegida);
    return elegida;
  });
}

/**
 * La card que representa al grupo entero.
 *
 * Sale del primer miembro que apareció en la lista —que por el orden del sync
 * es el que más se vende— con el nombre del grupo y el precio más bajo entre
 * los tamaños a la vista. Los colores son la unión de todos los tamaños: la
 * card dice qué existe, y la ficha ya dice qué hay de cada tamaño.
 */
export function cardDeGrupo(miembros) {
  const lider = miembros[0];

  // Con UN solo tamaño a la vista no hay grupo que mostrar: la card es la del
  // producto, con su nombre y su precio de siempre. Pasa cuando los demás
  // tamaños están agotados, y ahí "Varios tamaños" sería una promesa falsa.
  if (miembros.length === 1) return lider;
  const precios = miembros.map(m => Number(m.precio) || 0).filter(p => p > 0);
  const desde = precios.length ? Math.min(...precios) : lider.precio;

  const coloresVistos = new Map();
  for (const m of miembros) {
    for (const v of m.variedades || []) {
      const clave = String(v.nombre || '').trim().toLowerCase();
      if (!clave) continue;
      const visto = coloresVistos.get(clave);
      if (visto) visto.stock += Math.max(0, Number(v.stock) || 0);
      else coloresVistos.set(clave, { nombre: v.nombre, stock: Math.max(0, Number(v.stock) || 0) });
    }
  }

  // Un descuento se muestra solo si TODOS los tamaños lo tienen igual:
  // prometer −20% en la card y que el tamaño elegido no lo tenga es un reclamo.
  const pctLider = lider.descuento?.porcentaje || null;
  const mismoDescuento = pctLider
    && miembros.every(m => (m.descuento?.porcentaje || null) === pctLider);

  return {
    ...lider,
    nombre: lider.grupo,
    precio: desde,
    precio_anterior: mismoDescuento ? lider.precio_anterior : null,
    descuento: mismoDescuento ? lider.descuento : null,
    variedades: [...coloresVistos.values()],
    esGrupo: true,
    grupoCantidad: miembros.length,
    grupoDesde: precios.length > 1 && Math.min(...precios) !== Math.max(...precios),
  };
}

/**
 * Pliega una lista de productos: cada grupo queda como UNA card en el lugar
 * del primer miembro; lo que no tiene grupo pasa tal cual.
 *
 * `vistos` es para las listas paginadas: un Set compartido entre tandas con
 * las claves de grupo ya dibujadas. Un miembro que cae en una tanda posterior
 * no vuelve a dibujar la card del grupo.
 */
export function plegarGrupos(productos, vistos = null) {
  const porGrupo = new Map();
  for (const p of productos) {
    if (!p.grupo_clave) continue;
    if (!porGrupo.has(p.grupo_clave)) porGrupo.set(p.grupo_clave, []);
    porGrupo.get(p.grupo_clave).push(p);
  }

  const emitidos = new Set();
  const salida = [];
  for (const p of productos) {
    if (!p.grupo_clave) { salida.push(p); continue; }
    if (vistos?.has(p.grupo_clave) || emitidos.has(p.grupo_clave)) continue;
    emitidos.add(p.grupo_clave);
    vistos?.add(p.grupo_clave);
    salida.push(cardDeGrupo(porGrupo.get(p.grupo_clave)));
  }
  return salida;
}
