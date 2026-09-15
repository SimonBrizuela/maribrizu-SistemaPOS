/**
 * La hoja donde el cliente cuenta qué pasó con su pedido.
 *
 * Se abre encima de la pantalla del pedido y vive aparte, colgada del body: la
 * pantalla se rearma entera con cada cambio de estado, y lo que el cliente está
 * escribiendo no se puede borrar porque el local tocó algo.
 *
 * Tres cosas, en el orden en que se piensan: qué pasó, con qué producto (si el
 * motivo es de productos) y el detalle, con fotos si quiere. Lo que va
 * completando queda guardado mientras no recargue: si la cierra sin querer y la
 * vuelve a abrir, sigue ahí.
 *
 * Si no se puede mandar (sin red, el servidor caído, fuera de plazo) se ofrece
 * mandar lo mismo por WhatsApp: el reclamo no se pierde.
 */
import { esc } from './formato.js';
import { icono } from './iconos.js';
import { capaConHistorial } from './router.js';
import { LIMITES, MOTIVOS, motivosPara, motivoLegible, validarReclamo } from './reclamos.js';
import { achicarFoto } from './fotos_reclamo.js';

const PISTAS = {
  roto: 'Por ejemplo: la resma llegó mojada en una esquina.',
  falta: 'Por ejemplo: pedí 5 cartulinas y llegaron 4.',
  otro_producto: 'Por ejemplo: pedí azul y vino verde.',
  cobro: 'Por ejemplo: me cobraron el envío dos veces.',
  no_llego: 'Por ejemplo: figura entregado pero no lo recibí.',
};
const PISTA_GENERAL = 'Contanos con tus palabras qué pasó.';

// Lo que el cliente fue completando, por pedido. Sobrevive a cerrar la hoja.
const borradores = new Map();
let abierta = null;
let proximaClave = 0;

function borradorDe(id) {
  if (!borradores.has(id)) {
    borradores.set(id, { motivo: null, renglones: [], detalle: '', fotos: [], procesando: 0 });
  }
  return borradores.get(id);
}

const conProductos = (clave) => Boolean(MOTIVOS.find(m => m.clave === clave)?.conProductos);

/* ── Mandar ───────────────────────────────────────────────────────────────── */

/**
 * @returns {Promise<{ok: true, reclamo: object} | {ok: false, status: number, error: string, campo?: string, mensaje?: string}>}
 */
export async function mandarReclamo(pedidoId, entrada, { pedir = globalThis.fetch } = {}) {
  try {
    const respuesta = await pedir('/.netlify/functions/crear-reclamo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pedido: pedidoId, ...entrada }),
    });
    let cuerpo = null;
    try { cuerpo = await respuesta.json(); } catch { /* sin cuerpo: un 413 o un 502 de Netlify */ }
    if (respuesta.ok && cuerpo?.ok) return { ok: true, reclamo: cuerpo.reclamo };
    return {
      ok: false,
      status: respuesta.status,
      error: cuerpo?.error || 'fallo',
      campo: cuerpo?.campo || null,
      mensaje: cuerpo?.mensaje || null,
    };
  } catch {
    return { ok: false, status: 0, error: 'red' };
  }
}

/** Qué se le dice al cliente según cómo contestó el servidor. */
function explicar(resultado) {
  const { status, error, campo, mensaje } = resultado;
  if (status === 400 && (error === 'invalido' || error === 'foto')) {
    return { texto: mensaje || 'Revisá lo que escribiste.', campo: error === 'foto' ? 'fotos' : campo, whatsapp: false };
  }
  if (error === 'abierto') {
    return { texto: 'Ya tenés un reclamo abierto en este pedido. Te respondemos en esta página.', whatsapp: false };
  }
  if (error === 'plazo') {
    return {
      texto: `Pasaron más de ${LIMITES.diasParaReclamar} días desde la entrega. Mandanos lo mismo por WhatsApp y lo vemos.`,
      whatsapp: true,
    };
  }
  if (error === 'limite' || error === 'estado') {
    return { texto: 'Este pedido no admite otro reclamo desde acá. Mandanos lo mismo por WhatsApp y lo vemos.', whatsapp: true };
  }
  return { texto: 'No pudimos mandarlo. Probá de nuevo o mandalo por WhatsApp.', whatsapp: true };
}

/* ── Abrir y cerrar ───────────────────────────────────────────────────────── */

/**
 * @param {object} pedido  con su `id`
 * @param {{whatsapp?: string, alEnviado?: Function, achicar?: Function, pedir?: Function}} [opciones]
 */
export function abrirHojaReclamo(pedido, opciones = {}) {
  if (abierta) return;

  const raiz = document.createElement('div');
  raiz.className = 'reclamo-hoja';
  raiz.dataset.hojaReclamo = '';
  document.body.appendChild(raiz);
  document.body.style.overflow = 'hidden';

  abierta = {
    raiz,
    pedido,
    opciones: { achicar: achicarFoto, pedir: globalThis.fetch, ...opciones },
    borrador: borradorDe(pedido.id),
    error: null,
    whatsapp: false,
    enviando: false,
    hecho: false,
    // El "atrás" del celular cierra la hoja en vez de salir del pedido.
    capa: capaConHistorial(() => cerrar({ desdeHistorial: true })),
  };

  pintar();
  raiz.addEventListener('click', alTocar);
  raiz.addEventListener('input', alEscribir);
  raiz.addEventListener('change', alCambiar);
  document.addEventListener('keydown', alApretarEscape);

  // En el celular no se enfoca nada: levantaría el teclado antes de leer.
  if (window.matchMedia?.('(min-width: 768px)').matches) {
    raiz.querySelector('[data-motivo]')?.focus();
  }
}

export function cerrarHojaReclamo() {
  cerrar();
}

function cerrar({ desdeHistorial = false } = {}) {
  if (!abierta) return;
  const { raiz, capa } = abierta;
  abierta = null;
  document.removeEventListener('keydown', alApretarEscape);
  raiz.remove();
  document.body.style.overflow = '';
  if (!desdeHistorial) capa?.soltar();
  document.querySelector('[data-abrir-reclamo]')?.focus();
}

function alApretarEscape(ev) {
  if (ev.key === 'Escape') cerrar();
}

/* ── Dibujo ───────────────────────────────────────────────────────────────── */

function pintar() {
  const { raiz, pedido, borrador, hecho } = abierta;
  raiz.innerHTML = `
    <div class="reclamo-hoja__fondo" data-cerrar-reclamo></div>
    <section class="reclamo-hoja__caja" role="dialog" aria-modal="true" aria-labelledby="reclamo-titulo">
      ${hecho ? vistaHecha(pedido) : formulario(pedido, borrador)}
    </section>`;
}

function cabecera(pedido, titulo) {
  return `
    <header class="reclamo-hoja__cabecera">
      <div>
        <h2 class="reclamo-hoja__titulo" id="reclamo-titulo">${esc(titulo)}</h2>
        <p class="reclamo-hoja__bajada">Pedido ${esc(pedido.codigo || '')}</p>
      </div>
      <button type="button" class="reclamo-hoja__cerrar" data-cerrar-reclamo aria-label="Cerrar">
        ${icono('cerrar', { tam: 20 })}
      </button>
    </header>`;
}

function formulario(pedido, b) {
  const items = Array.isArray(pedido.items) ? pedido.items : [];
  return `
    ${cabecera(pedido, 'Contanos qué pasó')}
    <div class="reclamo-hoja__cuerpo">
      <div class="reclamo-paso" role="group" aria-labelledby="reclamo-motivo" data-paso-motivo>
        <p class="reclamo-paso__titulo" id="reclamo-motivo">¿Qué pasó?</p>
        <div class="reclamo-motivos" role="radiogroup" aria-labelledby="reclamo-motivo">
          ${motivosPara(pedido).map(m => `
            <button type="button" class="opcion reclamo-motivo" role="radio" data-motivo="${m.clave}"
                    aria-checked="${b.motivo === m.clave}">
              <span class="opcion__marca" aria-hidden="true"></span>
              <span class="opcion__titulo">${esc(m.texto)}</span>
            </button>`).join('')}
        </div>
      </div>

      <div class="reclamo-paso" role="group" aria-labelledby="reclamo-productos" data-paso-productos
           ${conProductos(b.motivo) ? '' : 'hidden'}>
        <p class="reclamo-paso__titulo" id="reclamo-productos">¿Con qué producto?</p>
        <div class="reclamo-productos">
          ${items.map((i, n) => `
            <label class="reclamo-producto">
              <input type="checkbox" class="solo-lectores" data-renglon="${n}"
                     ${b.renglones.includes(n) ? 'checked' : ''}>
              <span class="reclamo-producto__foto">${
                i.foto
                  ? `<img src="${esc(i.foto)}" alt="" loading="lazy" width="40" height="40">`
                  : `<span>${esc((i.nombre || '?').charAt(0).toUpperCase())}</span>`}</span>
              <span class="reclamo-producto__texto">
                <span class="reclamo-producto__nombre">${esc(i.nombre || '')}</span>
                <span class="reclamo-producto__nota">${esc(notaDe(i))}</span>
              </span>
              <span class="reclamo-producto__marca" aria-hidden="true">${icono('tilde', { tam: 14, grosor: 3 })}</span>
            </label>`).join('')}
        </div>
      </div>

      <div class="campo reclamo-paso" data-campo-detalle>
        <label class="campo__label reclamo-paso__titulo" for="reclamo-detalle">Contanos un poco más</label>
        <textarea id="reclamo-detalle" class="campo__control reclamo-detalle" data-detalle rows="4"
                  maxlength="${LIMITES.detalleMax}" placeholder="${esc(PISTAS[b.motivo] || PISTA_GENERAL)}">${esc(b.detalle)}</textarea>
        <span class="campo__ayuda reclamo-contador" data-contador>${contador(b.detalle)}</span>
      </div>

      <div class="reclamo-paso" role="group" aria-labelledby="reclamo-fotos" data-paso-fotos>
        <p class="reclamo-paso__titulo" id="reclamo-fotos">
          Fotos <span class="reclamo-paso__opcional">Opcional, hasta ${LIMITES.fotos}</span>
        </p>
        <div class="reclamo-fotos" data-fotos>${fotos(b)}</div>
      </div>
    </div>
    <footer class="reclamo-hoja__pie" data-pie>${pie()}</footer>`;
}

function notaDe(item) {
  const cantidad = item.unidad === 'metro'
    ? `${String(item.cantidad).replace('.', ',')} m`
    : `${Math.round(Number(item.cantidad) || 0)} u.`;
  return [item.variedad, cantidad].filter(Boolean).join(' · ');
}

function contador(texto) {
  return `${texto.length} / ${LIMITES.detalleMax}`;
}

function fotos(b) {
  const puestas = b.fotos.map((f, i) => `
    <figure class="reclamo-foto" data-foto>
      <img src="${esc(f.vista)}" alt="Foto ${i + 1}">
      <button type="button" class="reclamo-foto__quitar" data-quitar-foto="${f.clave}"
              aria-label="Quitar la foto ${i + 1}">${icono('cerrar', { tam: 14, grosor: 2.5 })}</button>
    </figure>`).join('');
  const preparando = '<div class="reclamo-foto esqueleto" role="status" aria-label="Preparando la foto"></div>'
    .repeat(b.procesando);
  const sumar = b.fotos.length + b.procesando < LIMITES.fotos
    ? `
      <label class="reclamo-fotos__sumar">
        <input type="file" accept="image/*" multiple class="solo-lectores" data-sumar-fotos>
        ${icono('camara', { tam: 22 })}
        <span>Sumar foto</span>
      </label>`
    : '';
  return puestas + preparando + sumar;
}

function pie() {
  const { error, whatsapp, enviando, borrador } = abierta;
  return `
    <p class="reclamo-hoja__error" data-error role="alert" ${error ? '' : 'hidden'}>${
      error ? `${icono('atencion', { tam: 16 })}<span>${esc(error)}</span>` : ''}</p>
    ${whatsapp ? `
      <a class="boton boton--secundario boton--bloque" data-whatsapp-reclamo href="${esc(enlaceWhatsapp())}"
         target="_blank" rel="noopener">${icono('whatsapp', { tam: 18 })} Mandarlo por WhatsApp</a>` : ''}
    <button type="button" class="boton boton--primario boton--bloque${enviando ? ' boton--cargando' : ''}"
            data-enviar-reclamo ${enviando || borrador.procesando ? 'disabled' : ''}>
      ${enviando ? 'Enviando' : 'Enviar reclamo'}
    </button>`;
}

function vistaHecha(pedido) {
  return `
    ${cabecera(pedido, 'Reclamo enviado')}
    <div class="reclamo-hecho" role="status">
      <span class="reclamo-hecho__icono">${icono('tilde', { tam: 28, grosor: 2.5 })}</span>
      <p class="reclamo-hecho__titulo">Recibimos tu reclamo</p>
      <p class="reclamo-hecho__texto">Lo revisamos y te respondemos en esta misma página.
        Si tenés los avisos activados, te llega también al celular.</p>
      <button type="button" class="boton boton--primario" data-cerrar-reclamo>Listo</button>
    </div>`;
}

function enlaceWhatsapp() {
  const { pedido, borrador, opciones } = abierta;
  const partes = [
    `Hola, tengo un problema con mi pedido ${pedido.codigo || ''}.`,
    borrador.motivo ? `${motivoLegible(borrador.motivo)}.` : '',
    borrador.detalle.trim(),
  ].filter(Boolean);
  return `https://wa.me/${opciones.whatsapp || ''}?text=${encodeURIComponent(partes.join(' '))}`;
}

/* ── Partes que se actualizan solas ───────────────────────────────────────── */

function repintarPie() {
  const lugar = abierta?.raiz.querySelector('[data-pie]');
  if (lugar) lugar.innerHTML = pie();
}

function repintarFotos() {
  const lugar = abierta?.raiz.querySelector('[data-fotos]');
  if (lugar) lugar.innerHTML = fotos(abierta.borrador);
}

function mostrarError(texto, { campo = null, whatsapp = false } = {}) {
  abierta.error = texto;
  abierta.whatsapp = whatsapp;
  limpiarMarcas();
  const destino = {
    motivo: '[data-paso-motivo]',
    renglones: '[data-paso-productos]',
    fotos: '[data-paso-fotos]',
  }[campo];
  if (destino) abierta.raiz.querySelector(destino)?.classList.add('reclamo-paso--error');
  if (campo === 'detalle') abierta.raiz.querySelector('[data-campo-detalle]')?.classList.add('campo--error');
  repintarPie();
}

function limpiarError() {
  if (!abierta.error) return;
  abierta.error = null;
  abierta.whatsapp = false;
  limpiarMarcas();
  repintarPie();
}

function limpiarMarcas() {
  abierta.raiz.querySelectorAll('.reclamo-paso--error').forEach(n => n.classList.remove('reclamo-paso--error'));
  abierta.raiz.querySelectorAll('.campo--error').forEach(n => n.classList.remove('campo--error'));
}

/* ── Lo que toca el cliente ───────────────────────────────────────────────── */

function alTocar(ev) {
  if (ev.target.closest('[data-cerrar-reclamo]')) {
    cerrar();
    return;
  }

  const motivo = ev.target.closest('[data-motivo]');
  if (motivo) {
    const b = abierta.borrador;
    b.motivo = motivo.dataset.motivo;
    abierta.raiz.querySelectorAll('[data-motivo]').forEach(boton =>
      boton.setAttribute('aria-checked', String(boton === motivo)));
    abierta.raiz.querySelector('[data-paso-productos]').hidden = !conProductos(b.motivo);
    abierta.raiz.querySelector('[data-detalle]').placeholder = PISTAS[b.motivo] || PISTA_GENERAL;
    limpiarError();
    return;
  }

  const quitar = ev.target.closest('[data-quitar-foto]');
  if (quitar) {
    const b = abierta.borrador;
    const clave = Number(quitar.dataset.quitarFoto);
    const foto = b.fotos.find(f => f.clave === clave);
    if (foto) URL.revokeObjectURL?.(foto.vista);
    b.fotos = b.fotos.filter(f => f.clave !== clave);
    repintarFotos();
    limpiarError();
    return;
  }

  if (ev.target.closest('[data-enviar-reclamo]')) enviar();
}

function alEscribir(ev) {
  const campo = ev.target.closest('[data-detalle]');
  if (!campo) return;
  abierta.borrador.detalle = campo.value;
  abierta.raiz.querySelector('[data-contador]').textContent = contador(campo.value);
  if (abierta.error) limpiarError();
}

function alCambiar(ev) {
  const casilla = ev.target.closest('[data-renglon]');
  if (casilla) {
    const b = abierta.borrador;
    const n = Number(casilla.dataset.renglon);
    b.renglones = casilla.checked
      ? [...new Set([...b.renglones, n])].sort((x, y) => x - y)
      : b.renglones.filter(r => r !== n);
    limpiarError();
    return;
  }

  const entrada = ev.target.closest('[data-sumar-fotos]');
  if (entrada) {
    const archivos = [...(entrada.files || [])];
    entrada.value = '';
    sumarFotos(archivos);
  }
}

async function sumarFotos(archivos) {
  if (!archivos.length) return;
  const actual = abierta;
  const b = actual.borrador;
  const lugar = Math.max(0, LIMITES.fotos - b.fotos.length - b.procesando);
  const elegidas = archivos.slice(0, lugar);
  if (archivos.length > lugar) mostrarError(`Podés mandar hasta ${LIMITES.fotos} fotos.`, { campo: 'fotos' });
  else limpiarError();

  b.procesando += elegidas.length;
  repintarFotos();
  repintarPie();

  // De a una: achicar tres fotos de cámara a la vez en un celular modesto
  // puede quedarse sin memoria.
  for (const archivo of elegidas) {
    try {
      const foto = await actual.opciones.achicar(archivo);
      b.fotos.push({
        clave: ++proximaClave, tipo: foto.tipo, datos: foto.datos, bytes: foto.bytes,
        vista: URL.createObjectURL?.(foto.blob) || '',
      });
    } catch (err) {
      if (abierta === actual) mostrarError(err?.message || 'No pudimos abrir esa foto. Probá con otra.', { campo: 'fotos' });
    } finally {
      b.procesando -= 1;
      if (abierta === actual) {
        repintarFotos();
        repintarPie();
      }
    }
  }
}

async function enviar() {
  const actual = abierta;
  const { pedido, borrador: b } = actual;
  if (actual.enviando || b.procesando) return;

  const entrada = {
    motivo: b.motivo,
    renglones: conProductos(b.motivo) ? b.renglones : [],
    detalle: b.detalle.trim(),
    fotos: b.fotos.map(f => ({ tipo: f.tipo, datos: f.datos })),
  };
  const falta = validarReclamo(entrada, pedido);
  if (falta) {
    mostrarError(falta.mensaje, { campo: falta.campo });
    return;
  }

  actual.enviando = true;
  actual.error = null;
  actual.whatsapp = false;
  limpiarMarcas();
  repintarPie();

  const resultado = await mandarReclamo(pedido.id, entrada, { pedir: actual.opciones.pedir });
  actual.enviando = false;

  if (resultado.ok) {
    b.fotos.forEach(f => URL.revokeObjectURL?.(f.vista));
    borradores.delete(pedido.id);
    if (abierta === actual) {
      actual.hecho = true;
      pintar();
    }
    actual.opciones.alEnviado?.(resultado.reclamo);
    return;
  }

  if (abierta !== actual) return;
  const { texto, campo, whatsapp } = explicar(resultado);
  mostrarError(texto, { campo, whatsapp });
}
