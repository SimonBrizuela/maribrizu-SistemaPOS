/**
 * Avisos flotantes de la app (stock, pedidos de la tienda).
 *
 * Antes cada módulo armaba su propia pila: los de stock caían en el medio de la
 * pantalla y tapaban justo la búsqueda y los filtros del catálogo, y los de
 * pedidos vivían arriba a la derecha con otro z-index. Dos pilas separadas se
 * superponen cuando entran juntos, que es exactamente cuando más importa leerlos.
 *
 * Acá hay una sola pila, pegada al costado derecho debajo de la barra superior:
 * no tapa nada de lo que se está usando, se lee en orden y los avisos que no se
 * pueden perder (un pedido nuevo) se ubican arriba de todo.
 */

const MAX_VISIBLES = 4;
let _stack = null;

function _asegurarPila() {
  if (_stack && document.body.contains(_stack)) return _stack;
  _stack = document.createElement('div');
  _stack.id = 'llToastStack';           // sin la palabra "toast" en la clase: hay
  _stack.setAttribute('aria-live', 'polite');  // pruebas que cuentan .toast en el DOM
  document.body.appendChild(_stack);
  return _stack;
}

function _escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Saca los más viejos cuando la pila se pasa de largo. Los prioritarios quedan. */
function _podar() {
  const pila = _asegurarPila();
  const vivos = () => [...pila.children].filter(el => el.dataset.cerrando !== '1');
  // Primero se van los que igual se cerraban solos; si aun asi la pila tapa
  // media pantalla, cae el mas viejo aunque sea prioritario.
  let comunes = vivos().filter(el => el.dataset.prioritario !== '1');
  while (vivos().length > MAX_VISIBLES && comunes.length) cerrarToast(comunes.shift());
  let todos = vivos();
  while (todos.length > MAX_VISIBLES && todos.length) cerrarToast(todos.shift());
}

export function cerrarToast(el) {
  if (!el || el.dataset.cerrando === '1') return;
  el.dataset.cerrando = '1';
  if (el._llTimer) clearTimeout(el._llTimer);
  el.classList.add('ll-toast--sale');
  const quitar = () => { el.remove(); if (_stack && !_stack.children.length) { _stack.remove(); _stack = null; } };
  el.addEventListener('transitionend', quitar, { once: true });
  setTimeout(quitar, 320);   // red de seguridad si la transición no dispara
}

/**
 * Muestra un aviso.
 *
 * @param {object}   o
 * @param {string}   o.tono          rojo | naranja | verde | violeta (define color e intención)
 * @param {string}   o.etiqueta      línea corta de arriba ("Sin stock", "Pedido nuevo")
 * @param {string}   o.icono         nombre del material icon
 * @param {string}   o.titulo        texto plano (se escapa acá)
 * @param {string}   o.detalleHtml   HTML ya armado por quien llama
 * @param {Array}    o.chips         [{ texto, tono }]
 * @param {Array}    o.acciones      [{ id, texto, principal }]
 * @param {number}   o.duracion      ms hasta cerrarse solo; 0 = queda hasta que lo cierren
 * @param {boolean}  o.prioritario   se ubica arriba de la pila y no lo poda un aviso nuevo
 * @param {Function} o.onAccion      (id, api) => void
 * @returns {{ cerrar: Function, el: HTMLElement }}
 */
export function mostrarToast({
  tono = 'violeta', etiqueta = '', icono = 'info', titulo = '', detalleHtml = '',
  chips = [], acciones = [], duracion = 0, prioritario = false, onAccion = null,
} = {}) {
  const pila = _asegurarPila();
  const el = document.createElement('div');
  el.className = `ll-toast ll-toast--${tono}${prioritario ? ' ll-toast--fijo' : ''}`;
  el.setAttribute('role', prioritario ? 'alert' : 'status');
  if (prioritario) el.dataset.prioritario = '1';

  const chipsHtml = chips.filter(Boolean).map(c =>
    `<span class="ll-toast-chip ll-toast-chip--${c.tono || tono}">${_escape(c.texto)}</span>`).join('');

  const accionesHtml = acciones.length ? `
    <div class="ll-toast-acciones">
      ${acciones.map(a => `<button type="button" data-act="${_escape(a.id)}" class="ll-toast-btn${a.principal ? ' ll-toast-btn--pri' : ''}">${_escape(a.texto)}</button>`).join('')}
    </div>` : '';

  el.innerHTML = `
    <div class="ll-toast-fila">
      <span class="ll-toast-ico material-icons">${_escape(icono)}</span>
      <div class="ll-toast-cuerpo">
        ${etiqueta || chipsHtml ? `<div class="ll-toast-tope">
          ${etiqueta ? `<span class="ll-toast-etiqueta">${_escape(etiqueta)}</span>` : ''}${chipsHtml}
        </div>` : ''}
        ${titulo ? `<div class="ll-toast-titulo">${_escape(titulo)}</div>` : ''}
        ${detalleHtml ? `<div class="ll-toast-detalle">${detalleHtml}</div>` : ''}
        ${accionesHtml}
      </div>
      <button type="button" data-act="__cerrar" class="ll-toast-x" aria-label="Cerrar">
        <span class="material-icons">close</span>
      </button>
    </div>
    ${duracion > 0 ? '<div class="ll-toast-barra"><i></i></div>' : ''}
  `;

  const api = { cerrar: () => cerrarToast(el), el };

  el.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.dataset.act;
    if (id === '__cerrar') { cerrarToast(el); return; }
    if (typeof onAccion === 'function') onAccion(id, api);
  });

  if (duracion > 0) {
    const barra = el.querySelector('.ll-toast-barra > i');
    if (barra) barra.style.animationDuration = duracion + 'ms';
    el._llTimer = setTimeout(() => cerrarToast(el), duracion);
    // Mientras el mouse está encima, el aviso no se va: se lo está leyendo.
    el.addEventListener('mouseenter', () => {
      clearTimeout(el._llTimer);
      if (barra) barra.style.animationPlayState = 'paused';
    });
    el.addEventListener('mouseleave', () => {
      if (el.dataset.cerrando === '1') return;
      if (barra) barra.style.animationPlayState = 'running';
      el._llTimer = setTimeout(() => cerrarToast(el), duracion);
    });
  }

  // Los prioritarios arriba; el resto en orden de llegada.
  const primerComun = [...pila.children].find(c => c.dataset.prioritario !== '1');
  if (prioritario && primerComun) pila.insertBefore(el, primerComun);
  else pila.appendChild(el);

  _podar();
  requestAnimationFrame(() => el.classList.add('ll-toast--entra'));
  return api;
}

/** Solo para pruebas: deja el DOM limpio entre casos. */
export function _resetToasts() {
  if (_stack) _stack.remove();
  _stack = null;
}
