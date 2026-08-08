/**
 * El chat de la tienda.
 *
 * Un boton flotante que abre un panel donde se pregunta por productos en
 * castellano y se contesta con el catalogo de verdad: precio, stock y colores.
 * Lo que contesta lo arma `netlify/functions/asistente.mjs`; aca solo esta la
 * conversacion y como se muestra.
 *
 * Dos decisiones que valen la pena contar:
 *
 * · La respuesta viene en dos partes, texto y productos. El texto lo escribe el
 *   modelo; las cards las pinta la tienda con los datos que salieron de
 *   Firestore. Asi el precio que se ve nunca paso por el modelo, y el boton de
 *   agregar es el mismo de todo el resto del sitio.
 *
 * · Si la funcion no esta configurada (sin clave de Gemini) el boton no se
 *   dibuja. Es como degradan las direcciones y el mapa: la tienda funciona
 *   igual, simplemente sin esta parte.
 */
import { pesos, esc } from './formato.js';
import { icono } from './iconos.js';

const RUTA = '/.netlify/functions/asistente';

// El historial que se manda de vuelta en cada mensaje. Solo en memoria: al
// recargar se arranca de cero, que para una consulta de mostrador es lo
// esperable y evita tener que explicarle a nadie donde se guarda su charla.
const historial = [];

let panel = null;
let apagado = false;

const EJEMPLOS = [
  '¿Tenés cartulina Luma?',
  '¿Cuánto sale un cuaderno Rivadavia?',
  'Necesito algo para forrar carpetas',
];

/* ── Armado ───────────────────────────────────────────────────────────────── */

export function iniciarAsistente() {
  if (document.querySelector('.asistente')) return;

  const raiz = document.createElement('div');
  raiz.className = 'asistente';
  raiz.innerHTML = `
    <button class="asistente__boton" type="button" data-abrir-asistente
            aria-label="Preguntar por un producto">
      ${icono('chat', { tam: 22 })}
      <span class="asistente__boton-texto">Preguntá</span>
    </button>`;
  document.body.appendChild(raiz);

  raiz.querySelector('[data-abrir-asistente]').addEventListener('click', abrir);
}

function abrir() {
  if (panel) return;

  panel = document.createElement('div');
  panel.className = 'asistente-panel';
  panel.innerHTML = `
    <div class="asistente-panel__fondo" data-cerrar-asistente></div>
    <section class="asistente-panel__caja" role="dialog" aria-modal="true"
             aria-label="Consultar por un producto">
      <header class="asistente-panel__cabecera">
        <div>
          <h2 class="asistente-panel__titulo">Preguntá por un producto</h2>
          <p class="asistente-panel__bajada">Te digo el precio y si hay stock</p>
        </div>
        <button class="asistente-panel__cerrar" type="button"
                data-cerrar-asistente aria-label="Cerrar">
          ${icono('cerrar', { tam: 20 })}
        </button>
      </header>

      <div class="asistente-panel__charla" data-charla role="log" aria-live="polite">
        ${historial.length ? '' : bienvenida()}
      </div>

      <form class="asistente-panel__pie" data-form-asistente>
        <input class="asistente-panel__campo" type="text" name="texto"
               placeholder="Escribí qué estás buscando" autocomplete="off"
               maxlength="500" aria-label="Tu consulta">
        <button class="asistente-panel__enviar" type="submit" aria-label="Enviar">
          ${icono('derecha', { tam: 18, grosor: 2.5 })}
        </button>
      </form>
    </section>`;

  document.body.appendChild(panel);
  document.body.style.overflow = 'hidden';

  // Se repinta lo que ya se habló: el panel se destruye al cerrar, pero la
  // conversación sigue viva mientras no se recargue la página.
  for (const m of historial) agregarBurbuja(m.rol, m.texto, m.productos);

  panel.querySelectorAll('[data-cerrar-asistente]')
    .forEach(b => b.addEventListener('click', cerrar));
  panel.querySelector('[data-form-asistente]').addEventListener('submit', alEnviar);
  panel.querySelectorAll('[data-ejemplo]').forEach(b =>
    b.addEventListener('click', () => preguntar(b.dataset.ejemplo)));

  document.addEventListener('keydown', alApretarEscape);

  // En el celular el foco automático levanta el teclado y tapa media pantalla
  // antes de que se llegue a leer de qué se trata.
  if (window.matchMedia('(min-width: 700px)').matches) {
    panel.querySelector('.asistente-panel__campo')?.focus();
  }
}

function cerrar() {
  if (!panel) return;
  document.removeEventListener('keydown', alApretarEscape);
  panel.remove();
  panel = null;
  document.body.style.overflow = '';
  document.querySelector('[data-abrir-asistente]')?.focus();
}

function alApretarEscape(ev) {
  if (ev.key === 'Escape') cerrar();
}

function bienvenida() {
  return `
    <div class="asistente-bienvenida">
      <p>Preguntame por cualquier producto del catálogo y te digo el precio,
         si hay stock y de qué colores.</p>
      <div class="asistente-bienvenida__ejemplos">
        ${EJEMPLOS.map(e => `
          <button class="asistente-ejemplo" type="button" data-ejemplo="${esc(e)}">
            ${esc(e)}
          </button>`).join('')}
      </div>
    </div>`;
}

/* ── Conversación ─────────────────────────────────────────────────────────── */

function alEnviar(ev) {
  ev.preventDefault();
  const campo = ev.target.querySelector('.asistente-panel__campo');
  const texto = campo.value.trim();
  if (!texto) return;
  campo.value = '';
  preguntar(texto);
}

async function preguntar(texto) {
  panel?.querySelector('.asistente-bienvenida')?.remove();

  historial.push({ rol: 'cliente', texto });
  agregarBurbuja('cliente', texto);
  const pensando = agregarPensando();

  try {
    const respuesta = await fetch(RUTA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Se manda el historial sin los productos: al modelo le importa lo que se
      // dijo, no las cards que se pintaron de este lado.
      body: JSON.stringify({
        mensajes: historial.map(({ rol, texto }) => ({ rol, texto })),
      }),
    });

    if (respuesta.status === 503) {
      apagar();
      return;
    }
    if (!respuesta.ok) throw new Error(`La función devolvió ${respuesta.status}`);

    const datos = await respuesta.json();
    pensando.remove();

    historial.push({
      rol: 'tienda',
      texto: datos.respuesta,
      productos: datos.productos || [],
    });
    agregarBurbuja('tienda', datos.respuesta, datos.productos);
  } catch (err) {
    console.error('[asistente]', err);
    pensando.remove();
    agregarBurbuja('tienda',
      'No pude conectarme. Probá de nuevo, o escribinos por WhatsApp que te '
    + 'contestamos igual.');
  }
}

/**
 * El asistente se apaga solo.
 *
 * Pasa cuando la funcion responde 503, que es lo que devuelve sin clave de
 * Gemini configurada. Antes que dejar un boton que da error a cada toque, se
 * saca del medio: la tienda entera funciona sin esto.
 */
function apagar() {
  apagado = true;
  cerrar();
  document.querySelector('.asistente')?.remove();
}

/* ── Pintado ──────────────────────────────────────────────────────────────── */

function charla() {
  return panel?.querySelector('[data-charla]');
}

function agregarBurbuja(rol, texto, productos = []) {
  const caja = charla();
  if (!caja) return null;

  const nodo = document.createElement('div');
  nodo.className = `asistente-msj asistente-msj--${rol === 'cliente' ? 'cliente' : 'tienda'}`;
  nodo.innerHTML = `<p class="asistente-msj__texto">${esc(texto)}</p>`;

  if (productos?.length) {
    nodo.innerHTML += `
      <div class="asistente-hallazgos">
        ${productos.map(renglon).join('')}
      </div>`;
  }

  caja.appendChild(nodo);
  caja.scrollTop = caja.scrollHeight;
  return nodo;
}

function agregarPensando() {
  const caja = charla();
  const nodo = document.createElement('div');
  nodo.className = 'asistente-msj asistente-msj--tienda asistente-msj--pensando';
  nodo.innerHTML = '<span></span><span></span><span></span>';
  nodo.setAttribute('aria-label', 'Buscando');
  caja?.appendChild(nodo);
  if (caja) caja.scrollTop = caja.scrollHeight;
  return nodo;
}

/**
 * Un producto encontrado.
 *
 * No se reusa `cardProducto()`: esa card esta hecha para una grilla y dentro de
 * un panel de 380 px entran dos por fila, ilegibles. Esto es la misma
 * informacion en una fila: foto chica, nombre, precio y el signo de agregar.
 *
 * El boton lleva los mismos `data-agregar` / `data-elegir` que el resto de la
 * tienda, asi que el delegado de main.js lo maneja sin enterarse de que salio
 * del chat: agrega al carrito y avisa igual que desde el catalogo.
 */
function renglon(p) {
  const foto = p.imagenes?.[0];
  const necesitaElegir = (p.variedades || []).some(v => v.stock > 0);

  return `
    <div class="asistente-hallazgo">
      <a class="asistente-hallazgo__enlace" href="/p/${esc(p.id)}">
        ${foto
          ? `<img class="asistente-hallazgo__foto" src="${esc(foto)}"
                  alt="" loading="lazy" decoding="async" width="48" height="48">`
          : '<span class="asistente-hallazgo__foto asistente-hallazgo__foto--vacia"></span>'}
        <span class="asistente-hallazgo__nombre">${esc(p.nombre)}</span>
      </a>
      <span class="asistente-hallazgo__precio cifra">
        ${pesos(p.precio)}${p.unidad === 'metro' ? '<small>el metro</small>' : ''}
      </span>
      <button class="asistente-hallazgo__agregar" data-agregar="${esc(p.id)}"
              data-elegir="${necesitaElegir ? '1' : ''}"
              aria-label="${necesitaElegir ? 'Elegir variedad de' : 'Agregar'} ${esc(p.nombre)}">
        ${icono('mas', { tam: 16, grosor: 2.5 })}
      </button>
    </div>`;
}

export function asistenteApagado() {
  return apagado;
}
