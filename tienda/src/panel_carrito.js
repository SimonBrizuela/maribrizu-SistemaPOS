/**
 * Panel del carrito.
 *
 * Se abre encima de la tienda en vez de navegar a otra pagina: revisar el
 * pedido no deberia sacar al cliente de donde estaba comprando.
 */
import * as carrito from './carrito.js';
import { pesos, esc } from './formato.js';
import { icono } from './iconos.js';
import { avisar } from './avisos.js';
import { vacio } from './componentes.js';
import { ir } from './router.js';

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

  const detalle = r.es_pack
    ? `<div class="renglon__variedad">Pack cerrado · ${r.pack_contenido} unidades</div>`
    : (r.variedad ? `<div class="renglon__variedad">${esc(r.variedad)}</div>` : '');

  return `
    <div class="renglon" data-rubro="${esc(r.rubro)}">
      <div class="renglon__foto">${foto}</div>
      <div class="renglon__datos">
        <div class="renglon__nombre">${esc(r.nombre)}</div>
        ${detalle}
        <div class="contador" style="margin-top:var(--e-1)">
          <button class="contador__boton" data-restar ${datos}
                  ${r.cantidad <= paso ? 'disabled' : ''}
                  aria-label="${r.unidad === 'metro' ? 'Medio metro menos' : 'Quitar uno'}">
            ${icono('menos', { tam: 16, grosor: 2.5 })}
          </button>
          <span class="contador__valor" style="min-width:52px" aria-live="polite">${cantidad}</span>
          <button class="contador__boton" data-sumar ${datos}
                  ${tope ? 'disabled' : ''}
                  aria-label="${r.unidad === 'metro' ? 'Medio metro más' : 'Agregar uno'}">
            ${icono('mas', { tam: 16, grosor: 2.5 })}
          </button>
        </div>
        ${tope ? `<span style="font-size:var(--t-xs);color:var(--alerta)">Es todo lo que hay</span>` : ''}
      </div>
      <div class="renglon__lado">
        <span class="renglon__precio cifra">${pesos(r.precio * r.cantidad)}</span>
        <button class="icono-boton" style="width:32px;height:32px;color:var(--text-3)"
                data-sacar ${datos} aria-label="Sacar ${esc(r.nombre)} del pedido">
          ${icono('tacho', { tam: 17 })}
        </button>
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

  panel.innerHTML = cabecera + `
    <div class="panel__cuerpo">${renglones.map(renglon).join('')}</div>
    <div class="panel__pie">
      <div class="totales" style="margin-bottom:var(--e-4)">
        <div class="totales__fila">
          <span>Productos (${cuantos})</span>
          <strong class="cifra">${pesos(total)}</strong>
        </div>
        <div class="totales__fila" style="font-size:var(--t-xs)">
          <span>El envío se calcula en el paso siguiente</span>
        </div>
      </div>
      <button class="boton boton--primario boton--grande boton--bloque" data-checkout>
        Continuar ${icono('derecha', { tam: 18, grosor: 2.5 })}
      </button>
    </div>`;
}
