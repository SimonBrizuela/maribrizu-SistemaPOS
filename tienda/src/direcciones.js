/**
 * Autocompletado del campo de direccion.
 *
 * Engancha un desplegable de sugerencias a un input comun. Cuando el cliente
 * elige una, resuelve sus coordenadas y las devuelve: son las que le permiten a
 * la tienda cobrar el envio que corresponde en vez de "a confirmar".
 *
 * Degrada solo. Si la funcion del servidor no esta desplegada o no tiene clave,
 * las sugerencias no aparecen y el campo sigue siendo un campo de texto: el
 * cliente escribe su direccion, el pedido entra igual y el envio se confirma al
 * prepararlo. Nunca bloquea el checkout, que es lo unico que no se puede
 * romper.
 */
import { esc } from './formato.js';
import { icono } from './iconos.js';

const FUNCION = '/.netlify/functions/direcciones';
const ESPERA_MS = 300;

/**
 * @param {HTMLInputElement} input
 * @param {(elegida: {direccion:string, lat:number, lng:number}|null) => void} alElegir
 *        Recibe null cuando el cliente vuelve a escribir: la direccion dejo de
 *        estar verificada y la cotizacion anterior ya no vale.
 * @returns {() => void} para desenganchar
 */
export function montarDirecciones(input, alElegir) {
  if (!input) return () => {};

  // El desplegable se posiciona contra este envoltorio, no contra el campo:
  // el campo vive dentro de un .campo que tambien tiene la etiqueta y la ayuda.
  const caja = document.createElement('div');
  caja.className = 'direcciones';
  input.parentNode.insertBefore(caja, input);
  caja.appendChild(input);

  const lista = document.createElement('div');
  lista.className = 'direcciones__lista';
  lista.setAttribute('role', 'listbox');
  lista.hidden = true;
  caja.appendChild(lista);

  let sugerencias = [];
  let marcada = -1;
  let temporizador = null;
  let peticion = 0;
  let apagado = false;

  function cerrar() {
    lista.hidden = true;
    lista.innerHTML = '';
    sugerencias = [];
    marcada = -1;
    input.setAttribute('aria-expanded', 'false');
  }

  function pintar() {
    if (!sugerencias.length) { cerrar(); return; }

    lista.innerHTML = sugerencias.map((s, i) => `
      <button type="button" class="direccion" role="option" data-i="${i}"
              aria-selected="${i === marcada}">
        <span class="direccion__pin">${icono('pin', { tam: 18 })}</span>
        <span class="direccion__texto">
          <span class="direccion__titulo">${esc(s.titulo)}</span>
          ${s.detalle ? `<span class="direccion__detalle">${esc(s.detalle)}</span>` : ''}
        </span>
      </button>`).join('');

    lista.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  async function buscar() {
    const q = input.value.trim();
    if (q.length < 3) { cerrar(); return; }

    const mio = ++peticion;
    try {
      const respuesta = await fetch(FUNCION, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q }),
      });

      // 503 es "no hay clave configurada". No tiene sentido seguir preguntando
      // en cada tecla: se apaga y el campo queda como texto libre.
      if (respuesta.status === 503) { apagado = true; cerrar(); return; }
      if (!respuesta.ok) { cerrar(); return; }

      // Llegó tarde: el cliente siguió escribiendo y ya hay otra consulta en
      // vuelo. Pintar esta le cambiaría la lista por una vieja.
      if (mio !== peticion) return;

      const datos = await respuesta.json();
      sugerencias = datos.sugerencias || [];
      marcada = -1;
      pintar();
    } catch {
      cerrar();
    }
  }

  async function elegir(i) {
    const s = sugerencias[i];
    if (!s) return;

    cerrar();
    input.value = [s.titulo, s.detalle].filter(Boolean).join(', ');

    try {
      const respuesta = await fetch(FUNCION, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placeId: s.id }),
      });
      if (!respuesta.ok) return;

      const datos = await respuesta.json();
      if (datos.direccion) input.value = datos.direccion;

      if (Number.isFinite(datos.lat) && Number.isFinite(datos.lng)) {
        alElegir({ direccion: input.value, lat: datos.lat, lng: datos.lng });
      }
    } catch (err) {
      console.warn('[direcciones] no se pudo resolver el lugar:', err);
    }
  }

  /* ── Eventos ────────────────────────────────────────────────────────────── */

  function alEscribir() {
    // Cualquier tecla invalida la dirección verificada: si el cliente eligió
    // una del desplegable y después le agregó algo, las coordenadas guardadas
    // ya no son de lo que dice el campo.
    alElegir(null);

    if (apagado) return;
    clearTimeout(temporizador);
    temporizador = setTimeout(buscar, ESPERA_MS);
  }

  function alTeclear(ev) {
    if (lista.hidden || !sugerencias.length) return;

    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const paso = ev.key === 'ArrowDown' ? 1 : -1;
      marcada = (marcada + paso + sugerencias.length) % sugerencias.length;
      pintar();
    } else if (ev.key === 'Enter' && marcada >= 0) {
      ev.preventDefault();
      elegir(marcada);
    } else if (ev.key === 'Escape') {
      cerrar();
    }
  }

  function alClicar(ev) {
    const boton = ev.target.closest('[data-i]');
    if (boton) elegir(Number(boton.dataset.i));
  }

  // El clic en una sugerencia dispara el blur del campo antes que su propio
  // click. Sin el retraso, la lista se cierra y el clic cae en el vacío.
  function alSalir() {
    setTimeout(cerrar, 150);
  }

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('autocomplete', 'off');

  input.addEventListener('input', alEscribir);
  input.addEventListener('keydown', alTeclear);
  input.addEventListener('blur', alSalir);
  lista.addEventListener('click', alClicar);

  return () => {
    clearTimeout(temporizador);
    input.removeEventListener('input', alEscribir);
    input.removeEventListener('keydown', alTeclear);
    input.removeEventListener('blur', alSalir);
    lista.removeEventListener('click', alClicar);
    lista.remove();
  };
}
