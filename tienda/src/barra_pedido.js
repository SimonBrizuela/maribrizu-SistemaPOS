/**
 * La barra que muestra lo que se va llevando.
 *
 * Aparece abajo apenas entra el primer producto y se queda mientras haya algo
 * en el pedido: las fotitas de lo agregado, cuántas cosas son, cuánto va y un
 * botón para abrir el pedido.
 *
 * Por qué existe: antes, agregar algo mostraba un aviso que se iba a los tres
 * segundos y después no quedaba nada. Para saber qué llevabas había que abrir
 * el carrito, y para seguir comprando cerrarlo. En el celular, con el catálogo
 * scrolleando, se perdía la cuenta enseguida — que es justo cuando la persona
 * decide si sigue agregando o se va.
 *
 * Lo último que entró se destaca un momento: eso es lo que reemplaza al aviso.
 * En vez de leer "Agregaste Cartulina Luma", se ve la cartulina entrar a la
 * barra y el total moverse.
 *
 * Va sobre la barra de navegación de abajo en el celular y flotando abajo en la
 * computadora; el `padding-bottom` del `body` se ajusta solo para que no tape
 * el final de la página.
 */
import * as carrito from './carrito.js';
import { pesos, esc } from './formato.js';
import { icono } from './iconos.js';
import { abrir as abrirCarrito, estaAbierto } from './panel_carrito.js';

// Cuántas fotitas entran sin que la barra se vuelva un mosaico. Con más, se
// muestra "+N" en la última.
const FOTOS_VISIBLES = 4;

let barra = null;
let ultimaClave = null;
let cantidadAnterior = 0;

/** Cada renglón tiene una clave propia: el mismo producto en dos colores son dos. */
function claveDe(r) {
  return `${r.id}|${r.variedad || ''}|${r.es_pack ? 'pack' : 'u'}`;
}

export function iniciarBarraPedido() {
  if (document.querySelector('.barra-pedido')) return;

  barra = document.createElement('div');
  barra.className = 'barra-pedido';
  barra.setAttribute('role', 'status');
  barra.setAttribute('aria-live', 'polite');
  document.body.appendChild(barra);

  carrito.suscribir(pintar);
}

function pintar(renglones) {
  if (!barra) return;

  // Con el pedido abierto la barra sobra: se está viendo lo mismo en grande.
  const mostrar = renglones.length > 0 && !estaAbierto();

  if (!mostrar) {
    barra.classList.remove('barra-pedido--visible');
    document.body.style.removeProperty('--alto-barra-pedido');
    if (!renglones.length) ultimaClave = null;
    cantidadAnterior = renglones.length;
    return;
  }

  // Qué entró último. Solo se destaca cuando el pedido crece: si el cliente
  // sacó algo, resaltar lo que quedó sería festejar lo que no hizo.
  const crecio = renglones.length > cantidadAnterior;
  const nuevo = crecio ? claveDe(renglones[renglones.length - 1]) : null;
  cantidadAnterior = renglones.length;

  const total = carrito.subtotal();
  const cosas = renglones.length;
  const sobran = cosas - FOTOS_VISIBLES;

  // Las últimas primero: lo recién agregado se ve sin tener que buscarlo.
  const visibles = renglones.slice(-FOTOS_VISIBLES).reverse();

  barra.innerHTML = `
    <button class="barra-pedido__cuerpo" data-abrir-pedido
            aria-label="Ver tu pedido: ${cosas} producto${cosas === 1 ? '' : 's'}, ${pesos(total)}">
      <span class="barra-pedido__fotos">
        ${visibles.map((r, i) => {
          const clave = claveDe(r);
          const esNuevo = clave === nuevo;
          return `
            <span class="barra-pedido__foto${esNuevo ? ' barra-pedido__foto--nueva' : ''}"
                  style="z-index:${FOTOS_VISIBLES - i}" title="${esc(r.nombre)}">
              ${r.foto
                ? `<img src="${esc(r.foto)}" alt="" loading="lazy">`
                : `<span class="barra-pedido__inicial">${esc((r.nombre || '?').charAt(0))}</span>`}
            </span>`;
        }).join('')}
        ${sobran > 0 ? `<span class="barra-pedido__mas">+${sobran}</span>` : ''}
      </span>

      <span class="barra-pedido__texto">
        <strong>${cosas} ${cosas === 1 ? 'producto' : 'productos'}</strong>
        <span class="barra-pedido__total cifra">${pesos(total)}</span>
      </span>

      <span class="barra-pedido__accion">
        Ver pedido ${icono('derecha', { tam: 16 })}
      </span>
    </button>`;

  barra.querySelector('[data-abrir-pedido]').addEventListener('click', abrirCarrito);

  // La clase de entrada se pone en el cuadro siguiente: puesta en el mismo,
  // el navegador pinta el estado final de una y no hay transición que ver.
  requestAnimationFrame(() => barra.classList.add('barra-pedido--visible'));

  // El alto real se mide y se publica para que el pie de la página no quede
  // tapado. Se mide en vez de fijarlo: cambia entre celular y computadora.
  requestAnimationFrame(() => {
    const alto = barra.getBoundingClientRect().height;
    if (alto) document.body.style.setProperty('--alto-barra-pedido', `${Math.round(alto)}px`);
  });

  if (nuevo) {
    barra.classList.add('barra-pedido--latiendo');
    setTimeout(() => barra?.classList.remove('barra-pedido--latiendo'), 500);
  }
}

/** El panel del carrito la esconde mientras está abierto y la repone al cerrar. */
export function refrescarBarraPedido() {
  if (barra) pintar(carrito.items());
}
