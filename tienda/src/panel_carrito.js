/**
 * Panel del carrito.
 *
 * Se abre encima de la tienda en vez de navegar a otra pagina: revisar el
 * pedido no deberia sacar al cliente de donde estaba comprando.
 */
import * as carrito from './carrito.js';
import { configEnCache } from './datos.js';
import { pesos, esc } from './formato.js';
import { icono } from './iconos.js';
import { avisar } from './avisos.js';
import { vacio } from './componentes.js';
import { ir } from './router.js';
import { refrescarBarraPedido } from './barra_pedido.js';

let abierto = false;
let velo = null;
let panel = null;
let desuscribir = null;
let devolverFocoA = null;

export function estaAbierto() {
  return abierto;
}

export function abrir() {
  if (abierto) return;
  abierto = true;
  devolverFocoA = document.activeElement;

  velo = document.createElement('div');
  velo.className = 'velo';
  velo.addEventListener('click', cerrar);

  panel = document.createElement('aside');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Tu pedido');

  document.body.appendChild(velo);
  document.body.appendChild(panel);
  // Sin esto la tienda de atras sigue desplazandose mientras el panel esta
  // abierto, que en el celular se siente como si la app estuviera rota.
  document.body.style.overflow = 'hidden';

  desuscribir = carrito.suscribir(pintar);
  // La barra de abajo muestra lo mismo que este panel: mientras está abierto,
  // sobra.
  refrescarBarraPedido();

  document.addEventListener('keydown', alPresionarTecla);
  panel.addEventListener('click', alHacerClic);

  // El foco entra al panel para que el teclado y el lector de pantalla lo sigan.
  requestAnimationFrame(() => panel.querySelector('[data-cerrar]')?.focus());
}

export function cerrar() {
  if (!abierto) return;
  abierto = false;

  document.removeEventListener('keydown', alPresionarTecla);
  desuscribir?.();
  desuscribir = null;

  velo.classList.add('velo--saliendo');
  panel.classList.add('panel--saliendo');
  refrescarBarraPedido();

  const quitar = () => {
    velo?.remove();
    panel?.remove();
    velo = panel = null;
    document.body.style.overflow = '';
  };
  panel.addEventListener('animationend', quitar, { once: true });
  // Red de seguridad: si la animacion no dispara (pestaña en segundo plano,
  // movimiento reducido) el panel igual se saca.
  setTimeout(quitar, 400);

  devolverFocoA?.focus?.();
  devolverFocoA = null;
}

function alPresionarTecla(ev) {
  if (ev.key === 'Escape') { cerrar(); return; }
  if (ev.key !== 'Tab' || !panel) return;

  // Atrapa el tabulador dentro del panel: si se escapa, el foco termina en la
  // tienda de atras, que esta tapada y no se ve.
  const focales = panel.querySelectorAll(
    'button:not([disabled]), a[href], input, [tabindex]:not([tabindex="-1"])');
  if (!focales.length) return;
  const primero = focales[0];
  const ultimo = focales[focales.length - 1];

  if (ev.shiftKey && document.activeElement === primero) {
    ev.preventDefault();
    ultimo.focus();
  } else if (!ev.shiftKey && document.activeElement === ultimo) {
    ev.preventDefault();
    primero.focus();
  }
}

function alHacerClic(ev) {
  const boton = ev.target.closest('button');
  if (!boton) return;

  if (boton.hasAttribute('data-cerrar')) { cerrar(); return; }

  if (boton.hasAttribute('data-seguir')) {
    cerrar();
    ir('/catalogo');
    return;
  }

  if (boton.hasAttribute('data-checkout')) {
    cerrar();
    ir('/checkout');
    return;
  }

  const id = boton.dataset.id;
  const variedad = boton.dataset.variedad || null;
  const esPack = boton.dataset.pack === '1';
  // El paso lo decide la unidad: medio metro para lo que se corta, uno para el
  // resto. Sumar de a uno en una cinta obliga a tocar el mas dos veces por
  // metro.
  const paso = carrito.pasoDe(boton.dataset.unidad);
  const actual = carrito.cantidadDe(id, variedad, esPack);

  if (boton.hasAttribute('data-sumar')) {
    carrito.cambiarCantidad(id, variedad, actual + paso, esPack);
  } else if (boton.hasAttribute('data-restar')) {
    carrito.cambiarCantidad(id, variedad, actual - paso, esPack);
  } else if (boton.hasAttribute('data-sacar')) {
    const posicion = carrito.posicionDe(id, variedad, esPack);
    const fuera = carrito.sacar(id, variedad, esPack);
    if (fuera) {
      avisar(`Sacaste ${fuera.nombre}`, {
        accion: { texto: 'Deshacer', alHacer: () => carrito.restaurar(fuera, posicion) },
      });
    }
  }
}

function renglon(r) {
  const foto = r.foto
    ? `<img src="${esc(r.foto)}" alt="" loading="lazy" width="64" height="64">`
    : `<div class="card-producto__placa"><span style="font-size:1.4rem">${
         esc((r.nombre || '?').charAt(0).toUpperCase())}</span></div>`;

  const datos = `data-id="${esc(r.id)}" data-variedad="${esc(r.variedad || '')}" `
              + `data-unidad="${esc(r.unidad)}" data-pack="${r.es_pack ? '1' : '0'}"`;
  const tope = r.stock > 0 && r.cantidad >= r.stock;
  const paso = carrito.pasoDe(r.unidad);
  const cantidad = carrito.formatearCantidad(r.cantidad, r.unidad);

  // Arriba se muestra el total del renglón, así que el precio de a uno hace
  // falta apenas hay más de uno: sin él, tres cuadernos son "$9.300" y no hay
  // forma de saber cuánto sale el cuaderno.
  const unitario = r.cantidad !== 1
    ? `${pesos(r.precio)} ${r.unidad === 'metro' ? 'el metro' : 'c/u'}`
    : '';

  // El color o modelo va pegado al nombre, entre paréntesis: es lo que
  // distingue dos renglones del mismo producto y tiene que leerse de un
  // vistazo, no perderse en el detalle de abajo.
  const nombre = r.variedad ? `${r.nombre} (${r.variedad})` : r.nombre;

  // Mismo cálculo que en la ficha del producto: contra el precio de a uno.
  // En pesos y no solo en porcentaje: "12%" obliga a hacer la cuenta.
  const ahorro = r.es_pack ? carrito.ahorroDePack({
    precioSuelto: r.precio_suelto, precioPack: r.precio,
    contenido: r.pack_contenido, cantidad: r.cantidad,
  }) : null;

  const notas = [
    r.es_pack ? esc(carrito.describirPack(r)) : '',
    ahorro
      ? `<span class="renglon__ahorro">Ahorrás ${esc(pesos(ahorro.pesos))} (${ahorro.porcentaje}%)</span>`
      : '',
    esc(unitario),
  ].filter(Boolean);

  const detalle = notas.length
    ? `<div class="renglon__variedad">${notas.join(' · ')}</div>`
    : '';

  return `
    <div class="renglon" data-rubro="${esc(r.rubro)}">
      <div class="renglon__foto">${foto}</div>
      <div class="renglon__datos">
        <div class="renglon__cabecera">
          <div class="renglon__nombre">${esc(nombre)}</div>
          <span class="renglon__precio cifra">${pesos(r.precio * r.cantidad)}</span>
        </div>
        ${detalle}
        <div class="renglon__acciones">
          <div class="contador">
            <button class="contador__boton" data-restar ${datos}
                    ${r.cantidad <= paso ? 'disabled' : ''}
                    aria-label="${r.unidad === 'metro' ? 'Medio metro menos' : 'Quitar uno'}">
              ${icono('menos', { tam: 16, grosor: 2.5 })}
            </button>
            <span class="contador__valor" style="min-width:${r.unidad === 'metro' ? 52 : 32}px"
                  aria-live="polite">${cantidad}</span>
            <button class="contador__boton" data-sumar ${datos}
                    ${tope ? 'disabled' : ''}
                    aria-label="${r.unidad === 'metro' ? 'Medio metro más' : 'Agregar uno'}">
              ${icono('mas', { tam: 16, grosor: 2.5 })}
            </button>
          </div>
          <button class="icono-boton renglon__sacar" data-sacar ${datos}
                  aria-label="Sacar ${esc(r.nombre)} del pedido">
            ${icono('tacho', { tam: 17 })}
          </button>
        </div>
        ${tope ? '<span class="renglon__tope">Es todo lo que hay</span>' : ''}
      </div>
    </div>`;
}

function pintar(renglones) {
  if (!panel) return;

  const cabecera = `
    <div class="panel__cabecera">
      <h2 style="font-size:var(--t-lg)">Tu pedido</h2>
      <button class="icono-boton" data-cerrar aria-label="Cerrar el pedido">
        ${icono('cerrar')}
      </button>
    </div>`;

  if (!renglones.length) {
    panel.innerHTML = cabecera + `
      <div class="panel__cuerpo">
        ${vacio({
          titulo: 'Tu pedido está vacío',
          texto: 'Empezá por lo más pedido de la semana, o buscá directamente lo que necesitás.',
          acciones: '<button class="boton boton--primario" data-seguir>Ver el catálogo</button>',
        })}
      </div>`;
    return;
  }

  const cuantos = carrito.unidades();
  const total = carrito.subtotal();

  // Lo que ya se ahorró llevando en pack, sumado en pesos: el porcentaje de
  // cada renglón no dice nada del pedido entero, y es lo que convence de
  // seguir comprando así.
  const ahorroTotal = renglones
    .filter(r => r.es_pack)
    .reduce((acc, r) => acc + (carrito.ahorroDePack({
      precioSuelto: r.precio_suelto, precioPack: r.precio,
      contenido: r.pack_contenido, cantidad: r.cantidad,
    })?.pesos || 0), 0);

  panel.innerHTML = cabecera + `
    <div class="panel__cuerpo">${renglones.map(renglon).join('')}</div>
    <div class="panel__pie">
      ${faltaParaElMinimo(total)}
      <div class="totales" style="margin-bottom:var(--e-4)">
        <div class="totales__fila">
          <span>Productos (${cuantos})</span>
          <strong class="cifra">${pesos(total)}</strong>
        </div>
        ${ahorroTotal > 0 ? `
        <div class="totales__ahorro">
          <span>Ahorrás llevando en pack</span>
          <strong class="cifra">${pesos(ahorroTotal)}</strong>
        </div>` : ''}
        <div class="totales__fila" style="font-size:var(--t-xs)">
          <span>El envío se calcula en el paso siguiente</span>
        </div>
      </div>
      <button class="boton boton--primario boton--grande boton--bloque" data-checkout>
        Continuar ${icono('derecha', { tam: 18, grosor: 2.5 })}
      </button>
    </div>`;
}

/**
 * Cuánto falta para el pedido mínimo, acá y no recién en el checkout.
 *
 * Enterarse de que faltan $6.000 después de cargar el pedido, elegir cómo lo
 * recibís y escribir la dirección es la forma más cara de perder una venta: el
 * cliente ya invirtió cinco minutos y se va enojado. Acá todavía está comprando
 * y agregar algo más es un toque.
 *
 * El envío también suma para el mínimo (así está el checkout), pero acá todavía
 * no se sabe cómo lo va a recibir, así que se cuenta solo lo que hay: es la
 * cuenta pesimista, y prometer menos y cobrar menos es el único error que no
 * duele.
 */
function faltaParaElMinimo(total) {
  const minimo = Number(configEnCache()?.entrega?.pedido_minimo) || 0;
  if (minimo <= 0) return '';

  const falta = minimo - total;
  if (falta <= 0) {
    return `
      <p class="panel__minimo panel__minimo--listo">
        ${icono('tilde', { tam: 16, grosor: 2.5 })}
        <span>Llegaste al pedido mínimo de ${pesos(minimo)}</span>
      </p>`;
  }

  const porcentaje = Math.max(4, Math.min(100, Math.round((total / minimo) * 100)));
  return `
    <div class="panel__minimo">
      <p class="panel__minimo__texto">
        ${icono('atencion', { tam: 16 })}
        <span>Te faltan <strong class="cifra">${pesos(falta)}</strong> para el pedido
              mínimo de <strong class="cifra">${pesos(minimo)}</strong></span>
      </p>
      <span class="panel__minimo__barra">
        <span style="width:${porcentaje}%"></span>
      </span>
    </div>`;
}
