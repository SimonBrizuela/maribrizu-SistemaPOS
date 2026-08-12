/**
 * Piezas de interfaz que se repiten en varias pantallas.
 * Devuelven HTML como texto; quien las usa lo inserta y engancha los eventos.
 */
import { pesos, esc, nombreBonito, colorDeVariedad, lineasDeHorario } from './formato.js';
import { icono, franjaMarca } from './iconos.js';
import { tildeFoto } from './fotos.js';

/**
 * Card de producto.
 *
 * El enlace cubre la card entera con un ::after, y el boton de agregar se apoya
 * arriba con z-index. Envolver el boton dentro del <a> seria HTML invalido y en
 * la practica haria que cada toque en el signo abriera la ficha del producto.
 */
export function cardProducto(p, indice = 0, { conRubro = true } = {}) {
  const agotado = p.stock <= 0;
  const foto = p.imagenes?.[0];

  // Se muestra el rubro, no la subcategoria. La subcategoria del catalogo es
  // interna y ruidosa ("Jugueteria General", "Abrochadora"): se parte en dos
  // lineas, grita, y no le dice nada a un cliente. El rubro es corto y ademas
  // es el que le da el color a la card.
  const etiqueta = nombreBonito(p.rubro) || p.categoria;

  // Segunda linea de contexto. Sin foto, la marca o la subcategoria son lo unico
  // que separa "Bolsa Carton Color 30X32" de "Bolsa Carton Color 30X41".
  const detalle = [p.marca, p.sub_rubro].filter(Boolean).join(' · ');

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

  const cinta = agotado
    ? '<span class="card-producto__cinta ficha">Sin stock</span>'
    : (p.destacado && foto ? '<span class="card-producto__cinta ficha ficha--rubro">Más pedido</span>' : '');

  // Con variedades el signo lleva a elegir, no agrega a ciegas: sumar "un
  // boligrafo" cuando hay cinco colores obliga a corregirlo despues.
  const necesitaElegir = conVariedades.length > 0;
  const accion = agotado ? '' : `
    <button class="card-producto__agregar" data-agregar="${esc(p.id)}"
            data-elegir="${necesitaElegir ? '1' : ''}"
            aria-label="${necesitaElegir ? 'Elegir variedad de' : 'Agregar'} ${esc(p.nombre)}">
      ${icono('mas', { tam: 18, grosor: 2.5 })}
    </button>`;

  const anterior = p.precio_anterior && p.precio_anterior > p.precio
    ? `<span class="card-producto__precio-anterior cifra">${pesos(p.precio_anterior)}</span>`
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
        ${tiraVariedades}
        <div class="card-producto__pie">
          <div>${anterior}<span class="card-producto__precio cifra">${pesos(p.precio)}</span>${
            p.unidad === 'metro'
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
      <button class="nav-inferior__item" data-abrir-carrito
              aria-label="Ver tu pedido${unidades ? `, ${unidades} producto${unidades === 1 ? '' : 's'}` : ', vacío'}">
        ${icono('carrito', { tam: 22 })}
        <span>Pedido${unidades ? ` (${unidades})` : ''}</span>
      </button>
      ${item('/seguimiento', 'bolsa', 'Mi pedido')}
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
