/**
 * Avisos flotantes.
 *
 * Se anuncian con aria-live pero no roban el foco: si lo hicieran, quien navega
 * con teclado perderia el lugar en el formulario cada vez que agrega algo.
 */
import { icono } from './iconos.js';
import { esc } from './formato.js';

let zona = null;

function asegurarZona() {
  if (zona) return zona;
  zona = document.createElement('div');
  zona.className = 'toast-zona';
  zona.setAttribute('aria-live', 'polite');
  zona.setAttribute('aria-atomic', 'false');
  document.body.appendChild(zona);
  return zona;
}

/**
 * @param {string} texto
 * @param {object} [opciones]
 * @param {'exito'|'error'|'neutro'} [opciones.tipo='exito']
 * @param {{texto:string, alHacer:Function}} [opciones.accion]  boton de deshacer
 * @param {number} [opciones.duracion=4000]
 */
export function avisar(texto, { tipo = 'exito', accion = null, duracion = 4000 } = {}) {
  const contenedor = asegurarZona();

  const nodo = document.createElement('div');
  nodo.className = `toast toast--${tipo}`;

  const glifo = tipo === 'error' ? 'atencion' : 'tilde';
  nodo.innerHTML = `
    <span class="toast__icono">${icono(glifo, { tam: 18, grosor: 2.5 })}</span>
    <span>${esc(texto)}</span>`;

  let temporizador;

  const cerrar = () => {
    clearTimeout(temporizador);
    nodo.classList.add('toast--saliendo');
    nodo.addEventListener('animationend', () => nodo.remove(), { once: true });
  };

  if (accion) {
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.textContent = accion.texto;
    boton.style.cssText = 'margin-left:auto;background:none;border:none;color:inherit;' +
      'font-weight:700;font-size:var(--t-xs);cursor:pointer;text-decoration:underline;' +
      'padding:var(--e-1) var(--e-2)';
    boton.addEventListener('click', () => { accion.alHacer(); cerrar(); });
    nodo.appendChild(boton);
  }

  contenedor.appendChild(nodo);

  // Con varios avisos encima la pantalla se tapa; se deja el ultimo par.
  while (contenedor.children.length > 3) contenedor.firstChild.remove();

  temporizador = setTimeout(cerrar, duracion);
  return cerrar;
}
