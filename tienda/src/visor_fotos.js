/**
 * Las fotos de la ficha, para verlas bien.
 *
 * Quien compra útiles lo hace casi siempre desde el celular, y en la ficha la
 * foto es chica: una cartulina de 29 colores o la letra de una etiqueta no se
 * distinguen sin acercarse. Dos cosas:
 *
 *   · En la computadora, la lupa: al pasar el mouse la foto se acerca en el
 *     lugar, siguiendo al puntero. Se mira de cerca sin abrir nada.
 *   · En cualquier aparato, tocar la foto la abre a pantalla completa. Ahí se
 *     acerca con dos dedos, con doble toque, con la rueda o con la lupa de
 *     arriba; se recorre arrastrando; se pasa de foto deslizando o con las
 *     flechas; y se cierra con la cruz, tocando afuera, deslizando para abajo,
 *     con Escape o con el "atrás" del celular.
 *
 * Las cuentas (cuánto acerca, hasta dónde se corre, qué hace un deslizamiento)
 * están en `zoom.js`, probadas sin DOM.
 */
import { icono } from './iconos.js';
import { esc } from './formato.js';
import { capaConHistorial } from './router.js';
import {
  ESCALA_DOBLE, limitar, zoomEnPunto, escalaConRueda, origenLupa, fotosDelVisor, gestoAlSoltar,
} from './zoom.js';

const SIN_ZOOM = Object.freeze({ escala: 1, x: 0, y: 0 });
const DOBLE_TOQUE_MS = 300;
const PASO_TECLA = 1.5;

let _abierto = null;

const quieto = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
const conDedos = () => window.matchMedia?.('(pointer: coarse)')?.matches === true;

/** Cierra el visor si hay uno abierto. */
export function cerrarVisorFotos() {
  _abierto?.cerrar();
}

/**
 * Abre las fotos a pantalla completa.
 *
 * @param {{fotos: string[], indice?: number, nombre?: string, disparador?: HTMLElement}} opciones
 *        `disparador` recibe el foco de vuelta al cerrar.
 */
export function abrirVisorFotos({ fotos, indice = 0, nombre = '', disparador = null }) {
  const lista = (fotos || []).map(u => String(u ?? '').trim()).filter(Boolean);
  if (!lista.length) return null;
  // Nunca dos: si ya hay uno abierto se cambian sus fotos y se conserva la
  // entrada del historial que ya tiene.
  if (_abierto) {
    _abierto.cambiar({ fotos: lista, indice, nombre, disparador });
    return _abierto;
  }

  let actuales = lista;
  let posicion = 0;
  let titulo = nombre;
  let volverA = disparador || document.activeElement;
  let estado = SIN_ZOOM;
  let cerrado = false;

  const visor = document.createElement('div');
  visor.className = 'visor-fotos';
  visor.setAttribute('role', 'dialog');
  visor.setAttribute('aria-modal', 'true');

  const $ = sel => visor.querySelector(sel);
  const escenario = () => $('[data-visor-escenario]');
  const imagen = () => $('[data-visor-imagen]');

  function armar() {
    const varias = actuales.length > 1;
    visor.setAttribute('aria-label', titulo ? `Fotos de ${titulo}` : 'Fotos del producto');
    visor.innerHTML = `
      <div class="visor-fotos__barra">
        ${varias ? '<span class="visor-fotos__cuenta" data-visor-cuenta aria-live="polite"></span>' : '<span></span>'}
        <div class="visor-fotos__acciones">
          <button type="button" class="visor-fotos__boton" data-visor-zoom aria-label="Acercar">
            ${icono('ampliar', { tam: 20 })}
          </button>
          <button type="button" class="visor-fotos__boton" data-visor-cerrar aria-label="Cerrar">
            ${icono('cerrar', { tam: 20 })}
          </button>
        </div>
      </div>
      <div class="visor-fotos__escenario" data-visor-escenario>
        <img class="visor-fotos__imagen" data-visor-imagen alt="" draggable="false">
      </div>
      ${varias ? `
        <button type="button" class="visor-fotos__flecha visor-fotos__flecha--anterior"
                data-visor-anterior aria-label="Foto anterior">${icono('izquierda', { tam: 24 })}</button>
        <button type="button" class="visor-fotos__flecha visor-fotos__flecha--siguiente"
                data-visor-siguiente aria-label="Foto siguiente">${icono('derecha', { tam: 24 })}</button>` : ''}
      ${pistaHtml()}`;
  }

  /** Cómo se acerca, dicho una sola vez por visita: después ya se sabe. */
  function pistaHtml() {
    try {
      if (sessionStorage.getItem('visorPistaVista')) return '';
      sessionStorage.setItem('visorPistaVista', '1');
    } catch (_) { /* sin almacenamiento se muestra igual */ }
    const texto = conDedos() ? 'Tocá dos veces o usá dos dedos para acercar'
                             : 'Doble clic o la rueda para acercar';
    return `<p class="visor-fotos__pista" aria-hidden="true">${esc(texto)}</p>`;
  }

  /* ── Medidas ── */

  function medidas() {
    const caja = escenario()?.getBoundingClientRect() || { width: 0, height: 0, left: 0, top: 0 };
    const img = imagen();
    return {
      caja,
      marco: { ancho: caja.width, alto: caja.height },
      // Lo que mide la foto a escala 1: el tamaño de maqueta, sin la transformación.
      foto: { ancho: img?.offsetWidth || 0, alto: img?.offsetHeight || 0 },
    };
  }

  /** Un punto de la pantalla, relativo al centro del escenario. */
  function relativo(clientX, clientY) {
    const { caja } = medidas();
    return { x: clientX - (caja.left + caja.width / 2), y: clientY - (caja.top + caja.height / 2) };
  }

  /* ── Pintar ── */

  function aplicar(nuevo, animado = true) {
    estado = nuevo;
    const img = imagen();
    if (!img) return;
    img.classList.toggle('visor-fotos__imagen--animada', animado);
    const s = Math.round(estado.escala * 1000) / 1000;
    img.style.transform = `translate3d(${Math.round(estado.x)}px, ${Math.round(estado.y)}px, 0) scale(${s})`;

    const acercada = estado.escala > 1.01;
    visor.classList.toggle('visor-fotos--acercada', acercada);
    const boton = $('[data-visor-zoom]');
    if (boton) {
      boton.setAttribute('aria-label', acercada ? 'Alejar' : 'Acercar');
      boton.innerHTML = icono(acercada ? 'achicar' : 'ampliar', { tam: 20 });
    }
  }

  function acercarEn(escala, punto, animado = true) {
    const { marco, foto } = medidas();
    aplicar(zoomEnPunto(estado, escala, punto, marco, foto), animado);
  }

  function alternarZoom(punto = { x: 0, y: 0 }) {
    if (estado.escala > 1.01) aplicar(SIN_ZOOM);
    else acercarEn(ESCALA_DOBLE, punto);
  }

  function mostrar(i) {
    posicion = Math.min(actuales.length - 1, Math.max(0, i));
    const img = imagen();
    img.setAttribute('src', actuales[posicion]);
    img.setAttribute('alt', actuales.length > 1
      ? `${titulo} · foto ${posicion + 1} de ${actuales.length}` : titulo);
    aplicar(SIN_ZOOM, false);

    const cuenta = $('[data-visor-cuenta]');
    if (cuenta) cuenta.textContent = `${posicion + 1} / ${actuales.length}`;
    const anterior = $('[data-visor-anterior]');
    const siguiente = $('[data-visor-siguiente]');
    if (anterior) anterior.disabled = posicion === 0;
    if (siguiente) siguiente.disabled = posicion === actuales.length - 1;

    // La foto nueva entra con un fundido corto, no de golpe.
    if (!quieto() && typeof img.animate === 'function') {
      img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
    }
    // Las vecinas se piden antes de que se las busque: pasar de foto no espera.
    [posicion - 1, posicion + 1].forEach(j => {
      if (actuales[j]) { const previa = new Image(); previa.src = actuales[j]; }
    });
  }

  /* ── Gestos con el dedo y el mouse ── */

  const punteros = new Map();
  let gesto = null;
  let arrastro = false;
  let ultimoToque = null;
  let ultimoTipo = 'mouse';

  function empezarArrastre(punto) {
    gesto = { tipo: 'arrastre', desde: punto, inicio: estado };
  }

  function alBajar(ev) {
    const caja = ev.target.closest?.('[data-visor-escenario]');
    if (!caja || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    ultimoTipo = ev.pointerType || 'mouse';
    try { caja.setPointerCapture?.(ev.pointerId); } catch (_) { /* puntero ya suelto */ }
    punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    arrastro = false;

    if (punteros.size >= 2) {
      const [a, b] = [...punteros.values()];
      gesto = {
        tipo: 'pellizco',
        distancia: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        medio: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        inicio: estado,
      };
    } else {
      empezarArrastre({ x: ev.clientX, y: ev.clientY });
    }
    if (estado.escala > 1.01) visor.classList.add('visor-fotos--arrastrando');
  }

  function alMover(ev) {
    if (!punteros.has(ev.pointerId) || !gesto) return;
    punteros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const { marco, foto } = medidas();

    if (gesto.tipo === 'pellizco' && punteros.size >= 2) {
      const [a, b] = [...punteros.values()];
      const distancia = Math.hypot(a.x - b.x, a.y - b.y);
      const medio = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const base = gesto.medio;
      const acercado = zoomEnPunto(gesto.inicio, gesto.inicio.escala * distancia / gesto.distancia,
        relativo(base.x, base.y), marco, foto);
      arrastro = true;
      aplicar(limitar({
        escala: acercado.escala,
        x: acercado.x + (medio.x - base.x),
        y: acercado.y + (medio.y - base.y),
      }, marco, foto), false);
      return;
    }

    if (gesto.tipo !== 'arrastre') return;
    const dx = ev.clientX - gesto.desde.x;
    const dy = ev.clientY - gesto.desde.y;
    if (Math.hypot(dx, dy) > 6) arrastro = true;

    if (gesto.inicio.escala > 1.01) {
      aplicar(limitar({ escala: gesto.inicio.escala, x: gesto.inicio.x + dx, y: gesto.inicio.y + dy },
        marco, foto), false);
      return;
    }

    // Sin zoom y con el dedo, la foto sigue al dedo: de costado para pasar de
    // foto, para abajo para cerrar, con el fondo aclarándose.
    if (ev.pointerType === 'mouse') return;
    const img = imagen();
    img.classList.remove('visor-fotos__imagen--animada');
    if (Math.abs(dx) > Math.abs(dy)) {
      img.style.transform = `translate3d(${Math.round(dx)}px, 0, 0) scale(1)`;
    } else {
      const baja = dy > 0 ? dy : dy * 0.25;
      img.style.transform = `translate3d(0, ${Math.round(baja)}px, 0) scale(1)`;
      visor.style.setProperty('--visor-fondo', String(Math.max(0.35, 1 - Math.max(0, dy) / 420)));
    }
  }

  function alSoltar(ev) {
    if (!punteros.has(ev.pointerId)) return;
    const suelto = punteros.get(ev.pointerId);
    punteros.delete(ev.pointerId);
    visor.classList.remove('visor-fotos--arrastrando');

    // De dos dedos a uno: sigue como arrastre desde donde quedó.
    if (punteros.size === 1) {
      const [resto] = [...punteros.values()];
      empezarArrastre(resto);
      return;
    }
    if (punteros.size > 1 || !gesto) return;

    const terminado = gesto;
    gesto = null;
    visor.style.removeProperty('--visor-fondo');

    if (terminado.tipo === 'arrastre' && terminado.inicio.escala <= 1.01 && ev.pointerType !== 'mouse') {
      const accion = gestoAlSoltar({
        dx: suelto.x - terminado.desde.x,
        dy: suelto.y - terminado.desde.y,
        escala: estado.escala,
        hayAnterior: posicion > 0,
        haySiguiente: posicion < actuales.length - 1,
      });
      if (accion === 'siguiente') { mostrar(posicion + 1); return; }
      if (accion === 'anterior') { mostrar(posicion - 1); return; }
      if (accion === 'cerrar') { cerrar(); return; }
    }

    // Doble toque con el dedo. Con mouse lo resuelve `dblclick`.
    if (ev.pointerType !== 'mouse' && !arrastro) {
      const ahora = Date.now();
      if (ultimoToque && ahora - ultimoToque.t < DOBLE_TOQUE_MS
          && Math.hypot(suelto.x - ultimoToque.x, suelto.y - ultimoToque.y) < 30) {
        ultimoToque = null;
        alternarZoom(relativo(suelto.x, suelto.y));
        return;
      }
      ultimoToque = { t: ahora, x: suelto.x, y: suelto.y };
    }

    // Lo que quedó a medio camino vuelve a su lugar con suavidad.
    const { marco, foto } = medidas();
    aplicar(limitar(estado, marco, foto), true);
  }

  /* ── Botones, teclado y rueda ── */

  visor.addEventListener('click', ev => {
    if (ev.target.closest('[data-visor-cerrar]')) { cerrar(); return; }
    if (ev.target.closest('[data-visor-zoom]')) { alternarZoom(); return; }
    if (ev.target.closest('[data-visor-anterior]')) { mostrar(posicion - 1); return; }
    if (ev.target.closest('[data-visor-siguiente]')) { mostrar(posicion + 1); return; }
    // Soltar después de arrastrar también dispara click: eso no es tocar afuera.
    if (arrastro) { arrastro = false; return; }
    if (ev.target === escenario()) cerrar();
  });

  visor.addEventListener('dblclick', ev => {
    if (ultimoTipo !== 'mouse' || !ev.target.closest('[data-visor-escenario]')) return;
    alternarZoom(relativo(ev.clientX, ev.clientY));
  });

  visor.addEventListener('wheel', ev => {
    if (!ev.target.closest('[data-visor-escenario]')) return;
    ev.preventDefault();
    acercarEn(escalaConRueda(estado.escala, ev.deltaY), relativo(ev.clientX, ev.clientY), false);
  }, { passive: false });

  visor.addEventListener('pointerdown', alBajar);
  visor.addEventListener('pointermove', alMover);
  visor.addEventListener('pointerup', alSoltar);
  visor.addEventListener('pointercancel', alSoltar);

  function alTeclado(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      // Con zoom, primero se aleja: cerrar de golpe perdía lo que se miraba.
      if (estado.escala > 1.01) aplicar(SIN_ZOOM);
      else cerrar();
      return;
    }
    if (ev.key === 'ArrowRight') { mostrar(posicion + 1); return; }
    if (ev.key === 'ArrowLeft') { mostrar(posicion - 1); return; }
    if (ev.key === '+' || ev.key === '=') { acercarEn(estado.escala * PASO_TECLA, { x: 0, y: 0 }); return; }
    if (ev.key === '-') { acercarEn(estado.escala / PASO_TECLA, { x: 0, y: 0 }); return; }
    if (ev.key === '0') { aplicar(SIN_ZOOM); return; }
    if (ev.key === 'Tab') {
      // El foco no se escapa a la página de atrás, que está tapada.
      const botones = [...visor.querySelectorAll('button:not([disabled])')];
      if (!botones.length) return;
      const i = botones.indexOf(document.activeElement);
      const siguiente = ev.shiftKey
        ? botones[(i <= 0 ? botones.length : i) - 1]
        : botones[(i + 1) % botones.length];
      ev.preventDefault();
      siguiente.focus();
    }
  }

  /* ── Abrir y cerrar ── */

  const overflowAntes = document.documentElement.style.overflow;
  const capa = capaConHistorial(() => cerrar({ desdeHistorial: true }));

  function cerrar({ desdeHistorial = false } = {}) {
    if (cerrado) return;
    cerrado = true;
    _abierto = null;
    document.removeEventListener('keydown', alTeclado);
    document.documentElement.style.overflow = overflowAntes;
    if (!desdeHistorial) capa.soltar();
    volverA?.focus?.({ preventScroll: true });

    if (quieto() || typeof visor.animate !== 'function') { visor.remove(); return; }
    const salida = visor.animate([{ opacity: 1 }, { opacity: 0 }],
      { duration: 150, easing: 'ease-in', fill: 'forwards' });
    salida.finished.then(() => visor.remove(), () => visor.remove());
  }

  armar();
  document.body.appendChild(visor);
  document.documentElement.style.overflow = 'hidden';
  document.addEventListener('keydown', alTeclado);
  mostrar(indice);
  $('[data-visor-cerrar]').focus({ preventScroll: true });

  if (!quieto() && typeof visor.animate === 'function') {
    visor.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
    imagen().animate([{ transform: 'scale(.96)' }, { transform: 'scale(1)' }],
      { duration: 260, easing: 'cubic-bezier(.22, 1, .36, 1)', composite: 'add' });
  }

  _abierto = {
    visor,
    cerrar,
    cambiar(nuevas) {
      actuales = nuevas.fotos;
      titulo = nuevas.nombre;
      volverA = nuevas.disparador || volverA;
      armar();
      mostrar(nuevas.indice);
      $('[data-visor-cerrar]').focus({ preventScroll: true });
    },
  };
  return _abierto;
}

/**
 * La lupa y el botón de ampliar de la galería de la ficha.
 *
 * `galeria` es lo que devuelve `montarGaleria`: de ahí sale qué foto se está
 * viendo, que puede ser la de un color y no la portada.
 */
export function montarAmpliar(raiz, p, galeria) {
  const principal = raiz?.querySelector('.galeria__principal');
  const boton = raiz?.querySelector('[data-galeria-ampliar]');
  const img = raiz?.querySelector('[data-galeria-grande]');
  if (!principal || !boton || !img) return;

  boton.addEventListener('click', () => {
    const { fotos, indice } = fotosDelVisor(p, galeria?.actual?.());
    abrirVisorFotos({ fotos, indice, nombre: p.nombre || '', disparador: boton });
  });

  // La lupa es para el mouse: con el dedo no hay "pasar por encima", y un toque
  // tiene que abrir la foto grande, no acercarla a medias.
  if (!window.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches) return;

  const seguir = ev => {
    if (ev.pointerType && ev.pointerType !== 'mouse') return;
    const o = origenLupa({ x: ev.clientX, y: ev.clientY }, principal.getBoundingClientRect());
    img.style.transformOrigin = `${o.x}% ${o.y}%`;
    principal.classList.add('galeria__principal--lupa');
  };
  principal.addEventListener('pointerenter', seguir);
  principal.addEventListener('pointermove', seguir);
  principal.addEventListener('pointerleave', () => principal.classList.remove('galeria__principal--lupa'));
}
