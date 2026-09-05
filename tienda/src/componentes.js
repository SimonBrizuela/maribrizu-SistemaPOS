/**
 * Piezas de interfaz que se repiten en varias pantallas.
 * Devuelven HTML como texto; quien las usa lo inserta y engancha los eventos.
 */
import { pesos, esc, nombreBonito, marcaCorta, colorDeVariedad, lineasDeHorario } from './formato.js';
import { icono, franjaMarca } from './iconos.js';
import { tildeFoto } from './fotos.js';
import { soloPack } from './carrito.js';

/**
 * "rollo" → "el rollo" · "caja de 12" → "la caja de 12".
 *
 * El género por la última letra de la primera palabra no es gramática, pero
 * alcanza para rollo, caja, bolsa, bobina, cartón y pack — todo lo que existe
 * en el catálogo. Si ya viene con artículo se respeta tal cual.
 */
export function conArticulo(nombre) {
  const n = String(nombre || 'pack').toLowerCase().trim();
  if (/^(el|la|los|las) /.test(n)) return n;
  return (/a$/.test(n.split(' ')[0]) ? 'la ' : 'el ') + n;
}

/**
 * Card de producto.
 *
 * El enlace cubre la card entera con un ::after, y el boton de agregar se apoya
 * arriba con z-index. Envolver el boton dentro del <a> seria HTML invalido y en
 * la practica haria que cada toque en el signo abriera la ficha del producto.
 */
export function cardProducto(p, indice = 0, { conRubro = true, conDestacado = true } = {}) {
  // Un producto que solo se vende por pack está agotado cuando no queda un
  // pack entero: prometer "el rollo de 100 m" con 60 m sueltos es un reclamo.
  // La card de un grupo no entra en esa cuenta: su precio es "desde" el tamaño
  // más barato y el pack se resuelve en la ficha, tamaño por tamaño.
  const soloRollo = !p.esGrupo && soloPack(p);
  const agotado = p.stock <= 0 || (soloRollo && p.stock < p.pack_contenido);
  const foto = p.imagenes?.[0];

  // Se muestra el rubro, no la subcategoria. La subcategoria del catalogo es
  // interna y ruidosa ("Jugueteria General", "Abrochadora"): se parte en dos
  // lineas, grita, y no le dice nada a un cliente. El rubro es corto y ademas
  // es el que le da el color a la card.
  const etiqueta = nombreBonito(p.rubro) || p.categoria;

  // Segunda linea de contexto. Sin foto, la marca o la subcategoria son lo unico
  // que separa "Bolsa Carton Color 30X32" de "Bolsa Carton Color 30X41". La
  // marca va resumida: el campo con todas las marcas posibles vive en la ficha.
  const detalle = [marcaCorta(p.marca), p.sub_rubro].filter(Boolean).join(' · ');

  const bloqueFoto = foto
    ? `<div class="card-producto__foto">
         <img src="${esc(foto)}" alt="${esc(p.nombre)}" loading="lazy"
              decoding="async" width="400" height="400">
       </div>`
    : '';

  const conVariedades = (p.variedades || []).filter(v => v.stock > 0);
  const muestras = conVariedades.slice(0, 3).map(v => {
    const color = colorDeVariedad(v.nombre);
    return color
      ? `<span class="card-producto__color" style="background:${color}" title="${esc(v.nombre)}"></span>`
      : '';
  }).filter(Boolean).join('');

  const sobrantes = conVariedades.length - 3;
  const tiraVariedades = muestras
    ? `<div class="card-producto__variedades">${muestras}${
         sobrantes > 0 ? `<span class="card-producto__mas-colores">+${sobrantes}</span>` : ''
       }</div>`
    : '';

  // El descuento le gana a "Más pedido": es el dato que hace frenar el ojo.
  // `conDestacado` lo apaga adentro de la sección "Lo más pedido": ahí el
  // título ya lo dice y repetirlo en cada card era ruido.
  const pctOferta = p.descuento?.porcentaje > 0 ? p.descuento.porcentaje : null;
  const cinta = agotado
    ? '<span class="card-producto__cinta ficha">Sin stock</span>'
    : pctOferta
      ? `<span class="card-producto__cinta ficha ficha--oferta">−${pctOferta}%</span>`
      : (conDestacado && p.destacado && foto ? '<span class="card-producto__cinta ficha ficha--rubro">Más pedido</span>' : '');

  // Con variedades el signo lleva a elegir, no agrega a ciegas: sumar "un
  // boligrafo" cuando hay cinco colores obliga a corregirlo despues. Con un
  // grupo de tamaños pasa lo mismo: primero se elige el tamaño en la ficha.
  const necesitaElegir = conVariedades.length > 0 || p.esGrupo === true;
  const accion = agotado ? '' : `
    <button class="card-producto__agregar" data-agregar="${esc(p.id)}"
            data-elegir="${necesitaElegir ? '1' : ''}"
            aria-label="${necesitaElegir ? 'Elegir variedad de' : 'Agregar'} ${esc(p.nombre)}">
      ${icono('mas', { tam: 18, grosor: 2.5 })}
    </button>`;

  const anterior = p.precio_anterior && p.precio_anterior > p.precio
    ? `<span class="card-producto__precio-anterior cifra">${pesos(p.precio_anterior)}</span>`
    : '';

  // La card de un grupo dice que adentro se elige el tamaño, sin prometer un
  // número que la tanda a la vista no puede garantizar. Si los tamaños tienen
  // precios distintos, el precio va con "desde": es el más bajo del grupo.
  const lineaTamanos = p.esGrupo
    ? '<span class="card-producto__tamanos">Varios tamaños</span>'
    : '';
  const desde = p.esGrupo && p.grupoDesde
    ? '<span class="card-producto__desde">desde</span> '
    : '';

  return `
    <article class="card-producto${foto ? '' : ' card-producto--sin-foto'}${
               agotado ? ' card-producto--agotado' : ''}"
             data-rubro="${esc(p.rubro)}" style="--i:${indice}">
      ${cinta}
      ${tildeFoto(p)}
      ${bloqueFoto}
      <div class="card-producto__cuerpo">
        ${conRubro ? `<span class="card-producto__rubro">${esc(etiqueta)}</span>` : ''}
        <h3 class="card-producto__nombre">
          <a class="card-producto__enlace" href="/p/${esc(p.id)}"
             style="color:inherit;text-decoration:none">${esc(p.nombre)}</a>
        </h3>
        ${detalle ? `<span class="card-producto__detalle">${esc(detalle)}</span>` : ''}
        ${lineaTamanos}
        ${tiraVariedades}
        <div class="card-producto__pie">
          <div>${soloRollo ? '' : anterior}<span class="card-producto__precio cifra">${
            desde}${pesos(soloRollo ? p.precio_pack : p.precio)}</span>${
            soloRollo
              ? `<span style="display:block;font-size:var(--t-xs);color:var(--text-2);font-weight:600;line-height:1.2">${
                  esc(conArticulo(p.pack_nombre || p.pack_tipo))}</span>`
              : p.unidad === 'metro'
                ? '<span style="display:block;font-size:var(--t-xs);color:var(--text-2);font-weight:600;line-height:1.2">el metro</span>'
                : ''
          }</div>
          ${accion}
        </div>
      </div>
    </article>`;
}

/** Grilla de cards con entrada escalonada. */
export function grilla(productos) {
  return `<div class="grilla grilla--entrada">
    ${productos.map((p, i) => cardProducto(p, i)).join('')}
  </div>`;
}

/** Esqueletos mientras cargan los productos. */
export function grillaCargando(cantidad = 10) {
  const uno = `
    <article class="card-producto card-producto--sin-foto" aria-hidden="true"
             style="border-top-color:var(--border)">
      <div class="card-producto__cuerpo">
        <div class="esqueleto" style="height:11px;width:45%"></div>
        <div class="esqueleto" style="height:15px;width:100%"></div>
        <div class="esqueleto" style="height:15px;width:70%"></div>
        <div class="card-producto__pie"><div class="esqueleto" style="height:22px;width:80px"></div></div>
      </div>
    </article>`;
  return `<div class="grilla" role="status" aria-label="Cargando productos">
    ${uno.repeat(cantidad)}
  </div>`;
}

export function cabecera({ unidades = 0, busqueda = '' } = {}) {
  return `
    <header class="cabecera">
      <div class="contenedor cabecera__fila">
        <a class="cabecera__logo" href="/" data-ruta>
          <img src="/logo-liceo.png" alt="Librería Liceo" width="768" height="168">
        </a>

        <button class="icono-boton" data-abrir-busqueda aria-label="Buscar productos">
          ${icono('buscar')}
        </button>
        <button class="icono-boton" data-cerrar-busqueda aria-label="Cerrar la búsqueda">
          ${icono('izquierda')}
        </button>

        <form class="buscador" role="search" data-buscador>
          <label class="solo-lectores" for="q">Buscar productos</label>
          <span class="buscador__icono">${icono('buscar', { tam: 20 })}</span>
          <input class="buscador__input" id="q" name="q" type="search" autocomplete="off"
                 placeholder="Buscar cuadernos, hilos, juguetes…" value="${esc(busqueda)}">
        </form>

        <!-- En el celular esto vive en la barra de abajo. En la computadora esa
             barra no existe, así que no había forma de llegar a los pedidos
             hechos salvo escribiendo la dirección a mano. -->
        <a class="cabecera__mis-pedidos" href="/seguimiento" data-ruta>
          ${icono('bolsa', { tam: 20 })}
          <span>Mis pedidos</span>
        </a>

        <button class="icono-boton carrito-boton" data-abrir-carrito
                aria-label="Ver tu pedido${unidades ? `, ${unidades} producto${unidades === 1 ? '' : 's'}` : ', vacío'}">
          ${icono('carrito')}
          ${unidades ? `<span class="carrito-boton__globo cifra">${unidades}</span>` : ''}
        </button>
      </div>
    </header>`;
}

export function navInferior(rutaActual = '/', unidades = 0) {
  const item = (href, nombre, texto) => {
    const actual = href === '/' ? rutaActual === '/' : rutaActual.startsWith(href);
    return `
      <a class="nav-inferior__item" href="${href}" data-ruta ${actual ? 'aria-current="page"' : ''}>
        ${icono(nombre, { tam: 22 })}
        <span>${texto}</span>
      </a>`;
  };

  return `
    <nav class="nav-inferior" aria-label="Navegación principal">
      ${item('/', 'casa', 'Inicio')}
      ${item('/catalogo', 'grilla', 'Catálogo')}
      <!-- "Carrito" y "Mis pedidos", no "Pedido" y "Mi pedido": son dos cosas
           distintas —lo que estás armando y lo que ya compraste— y con esos dos
           nombres, uno al lado del otro, no había forma de saber cuál era cuál. -->
      <button class="nav-inferior__item" data-abrir-carrito
              aria-label="Ver tu pedido${unidades ? `, ${unidades} producto${unidades === 1 ? '' : 's'}` : ', vacío'}">
        ${icono('carrito', { tam: 22 })}
        <span>Carrito${unidades ? ` (${unidades})` : ''}</span>
      </button>
      ${item('/seguimiento', 'bolsa', 'Mis pedidos')}
    </nav>`;
}

export function pie(cfg) {
  return `
    <footer class="marco-oscuro">
      ${franjaMarca()}
      <div class="contenedor pie__grilla">
        <div>
          <img class="pie__logo" src="/logo-liceo.png" alt="Librería Liceo"
               width="768" height="168" loading="lazy" decoding="async">
          <p class="pie__texto" style="margin-top:var(--e-3)">
            ${esc(cfg.direccion)}
          </p>
        </div>
        <div>
          <h3 class="pie__titulo">Horarios</h3>
          <ul class="pie__horarios">
            ${lineasDeHorario(cfg.horarios_texto).map(l => `<li>${esc(l)}</li>`).join('')}
          </ul>
        </div>
        <div>
          <h3 class="pie__titulo">Contacto</h3>
          <p class="pie__texto">
            <a href="tel:${esc(cfg.telefono)}">${esc(cfg.telefono)}</a><br>
            <a href="mailto:${esc(cfg.email)}">${esc(cfg.email)}</a>
          </p>
          <div class="pie__redes">
            <a class="boton boton--sobre-negro boton--chico"
               href="https://wa.me/${esc(cfg.whatsapp)}" target="_blank" rel="noopener">
              ${icono('whatsapp', { tam: 16 })} WhatsApp
            </a>
            ${cfg.instagram ? `
              <a class="boton boton--sobre-negro boton--chico"
                 href="${esc(cfg.instagram)}" target="_blank" rel="noopener">
                ${icono('instagram', { tam: 16 })} Instagram
              </a>` : ''}
          </div>
        </div>
      </div>
      <div class="contenedor pie__legal">
        Librería Liceo · Córdoba, Argentina
      </div>
    </footer>`;
}

/** Estado vacío. `acciones` es HTML de botones ya armado. */
export function vacio({ titulo, texto, acciones = '' }) {
  return `
    <div class="vacio">
      <h2 class="vacio__titulo">${titulo}</h2>
      <p class="vacio__texto">${texto}</p>
      ${acciones ? `<div class="vacio__acciones">${acciones}</div>` : ''}
    </div>`;
}
