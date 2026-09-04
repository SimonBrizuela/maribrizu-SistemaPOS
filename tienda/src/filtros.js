/**
 * El orden de las pastillas de filtro del catálogo.
 *
 * El agregado que escribe el sync trae los rubros ordenados por lo que
 * facturan —es el orden de la portada, y ahí se queda— y los subrubros por
 * cantidad de productos. Para una fila de filtros ese orden no sirve: quien
 * busca "Tijeras" no sabe cuánto vende Tijeras, sabe con qué letra empieza.
 * Acá todo lo que se muestra como filtro sale de la A a la Z.
 *
 * Lógica pura, sin DOM: es lo que permite probarla en filtros.test.js.
 */

const porNombre = (a, b) =>
  a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' });

/** La misma lista, de la A a la Z por nombre. Tildes y mayúsculas no pesan. */
export function ordenarAz(lista) {
  return lista.slice().sort(porNombre);
}

/**
 * La fila de subrubros a la vista y el panel con todos.
 *
 * A la vista van los `aLaVista` con más productos —son los que cubren casi
 * todo el rubro— pero de la A a la Z, no del más grande al más chico. El
 * elegido entra siempre, aunque esté en el fondo de la lista: si no, el filtro
 * activo no se ve por ningún lado. El resto vive en el panel, también de la A
 * a la Z, y con pocos subrubros no hay panel: van todos en la fila.
 */
export function filaDeSubrubros(subrubros, { elegido = null, aLaVista = 14 } = {}) {
  const hayPanel = subrubros.length > aLaVista;
  const visibles = hayPanel
    ? subrubros.slice()
        .sort((a, b) => (b.cantidad - a.cantidad) || porNombre(a, b))
        .slice(0, aLaVista)
    : subrubros.slice();

  if (elegido && !visibles.some(s => s.nombre === elegido)) {
    const oculto = subrubros.find(s => s.nombre === elegido);
    if (oculto) visibles.push(oculto);
  }

  return { visibles: ordenarAz(visibles), todos: ordenarAz(subrubros), hayPanel };
}
