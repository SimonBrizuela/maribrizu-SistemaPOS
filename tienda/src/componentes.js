/**
 * Piezas de interfaz que se repiten en varias pantallas.
 * Devuelven HTML como texto; quien las usa lo inserta y engancha los eventos.
 */
import { pesos, esc, colorDeVariedad } from './formato.js';
import { icono, fichasMarca, franjaMarca } from './iconos.js';

/**
 * Card de producto.
 *
 * El enlace cubre la card entera con un ::after, y el boton de agregar se apoya
 * arriba con z-index. Envolver el boton dentro del <a> seria HTML invalido y en
 * la practica haria que cada toque en el signo abriera la ficha del producto.
 */
export function cardProducto(p, indice = 0) {
  const agotado = p.stock <= 0;
  const foto = p.imagenes?.[0];
  const inicial = (p.nombre || '?').trim().charAt(0).toUpperCase();

  const medios = foto
    ? `<img src="${esc(foto)}" alt="${esc(p.nombre)}" loading="lazy" decoding="async" width="400" height="400">`
    : `<div class="card-producto__placa" aria-hidden="true"><span>${esc(inicial)}</span></div>`;

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
    : (p.destacado ? '<span class="card-producto__cinta ficha ficha--rubro">Más pedido</span>' : '');

  // Con variedades el signo lleva a elegir, no agrega a ciegas: sumar "un
  // boligrafo" cuando hay cinco colores obliga a corregirlo despues.
  const necesitaElegir = conVariedades.length > 0;
  const accion = agotado ? '' : `
    <button class="card-producto__agregar" data-agregar="${esc(p.id)}"
            data-elegir="${necesitaElegir ? '1' : ''}"
            aria-label="${necesitaElegir ? 'Elegir variedad de' : 'Agregar'} ${esc(p.nombre)}">
      ${icono('mas', { tam: 20, grosor: 2.5 })}
    </button>`;

  const anterior = p.precio_anterior && p.precio_anterior > p.precio
    ? `<span class="card-producto__precio-anterior cifra">${pesos(p.precio_anterior)}</span>`
    : '';

  return `
    <article class="card-producto${agotado ? ' card-producto--agotado' : ''}"
             data-rubro="${esc(p.rubro)}" style="--i:${indice}">
      ${cinta}
      <div class="card-producto__foto">${medios}</div>
      <div class="card-producto__cuerpo">
        <span class="card-producto__rubro">${esc(p.categoria || p.rubro)}</span>
        <h3 class="card-producto__nombre">
          <a class="card-producto__enlace" href="/p/${esc(p.id)}"
             style="color:inherit;text-decoration:none">${esc(p.nombre)}</a>
        </h3>
        ${tiraVariedades}
        <div class="card-producto__pie">
          <div>${anterior}<span class="card-producto__precio cifra">${pesos(p.precio)}</span></div>
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
    <article class="card-producto" aria-hidden="true">
      <div class="card-producto__foto"><div class="esqueleto" style="width:100%;height:100%;border-radius:0"></div></div>
      <div class="card-producto__cuerpo">
        <div class="esqueleto" style="height:11px;width:45%"></div>
        <div class="esqueleto" style="height:13px;width:100%"></div>
        <div class="esqueleto" style="height:13px;width:65%"></div>
        <div class="card-producto__pie"><div class="esqueleto" style="height:20px;width:70px"></div></div>
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
          ${fichasMarca()}
          <span>Librería Liceo</span>
        </a>

        <form class="buscador" role="search" data-buscador>
          <label class="solo-lectores" for="q">Buscar productos</label>
          <span class="buscador__icono">${icono('buscar', { tam: 20 })}</span>
          <input class="buscador__input" id="q" name="q" type="search" autocomplete="off"
                 placeholder="Buscar cuadernos, hilos, juguetes…" value="${esc(busqueda)}">
        </form>

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
          <span class="cabecera__logo" style="color:var(--ink-texto)">
            ${fichasMarca()}
            <span>Librería Liceo</span>
          </span>
          <p class="pie__texto" style="margin-top:var(--e-3)">
            ${esc(cfg.direccion)}
          </p>
        </div>
        <div>
          <h3 class="pie__titulo">Horarios</h3>
          <p class="pie__texto">${esc(cfg.horarios_texto)}</p>
        </div>
        <div>
          <h3 class="pie__titulo">Contacto</h3>
          <p class="pie__texto">
            <a href="tel:${esc(cfg.telefono)}">${esc(cfg.telefono)}</a><br>
            <a href="mailto:${esc(cfg.email)}">${esc(cfg.email)}</a>
          </p>
          <a class="boton boton--sobre-negro boton--chico" style="margin-top:var(--e-3)"
             href="https://wa.me/${esc(cfg.whatsapp)}" target="_blank" rel="noopener">
            ${icono('whatsapp', { tam: 16 })} WhatsApp
          </a>
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
