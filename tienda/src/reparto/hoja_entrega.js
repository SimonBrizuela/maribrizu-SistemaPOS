/**
 * La confirmación de "Lo entregué".
 *
 * Una hoja que sube desde abajo, colgada del body: la pantalla de atrás se
 * repinta sola con cada cambio de la base y lo que el repartidor está eligiendo
 * no se puede perder. Si el pedido se cobra en efectivo pregunta si cobró; la
 * foto de la entrega es opcional.
 */
import { esc, pesos } from '../formato.js';
import { icono } from '../iconos.js';
import { cobroDe } from '../reparto.js';

let abierta = null;

/**
 * @param {object} pedido
 * @param {{confirmar: (datos: {cobrado: boolean|null, foto: object|null}) => Promise<{ok: boolean, mensaje?: string}>,
 *          achicar: Function}} opciones
 */
export function abrirHojaEntrega(pedido, { confirmar, achicar }) {
  cerrarHojaEntrega();
  const cobro = cobroDe(pedido);
  const raiz = document.createElement('div');
  raiz.className = 'reparto-hoja';
  raiz.dataset.hojaEntrega = '';
  document.body.appendChild(raiz);

  abierta = {
    raiz, pedido, confirmar, achicar,
    preguntaCobro: cobro.efectivo && !cobro.pagado,
    cobrado: null, foto: null, procesando: false, enviando: false, error: null,
  };
  pintar();
  raiz.addEventListener('click', alTocar);
  raiz.addEventListener('change', alCambiar);
  document.addEventListener('keydown', alApretarEscape);
}

export function cerrarHojaEntrega() {
  if (!abierta) return;
  const { raiz, foto } = abierta;
  if (foto?.vista) URL.revokeObjectURL?.(foto.vista);
  document.removeEventListener('keydown', alApretarEscape);
  raiz.remove();
  abierta = null;
}

function alApretarEscape(ev) {
  if (ev.key === 'Escape' && !abierta?.enviando) cerrarHojaEntrega();
}

function listo() {
  const a = abierta;
  return !a.procesando && !a.enviando && (!a.preguntaCobro || a.cobrado !== null);
}

function pintar() {
  const a = abierta;
  const { pedido } = a;
  a.raiz.innerHTML = `
    <div class="reparto-hoja__fondo" data-cerrar-hoja></div>
    <section class="reparto-hoja__caja" role="dialog" aria-modal="true" aria-labelledby="entrega-titulo">
      <header class="reparto-hoja__cabecera">
        <div>
          <h2 id="entrega-titulo">Entregar el pedido ${esc(pedido.codigo || '')}</h2>
          <p>${esc(pedido.cliente?.nombre || '')} · ${esc(pedido.entrega?.direccion || '')}</p>
        </div>
        <button type="button" class="reparto-hoja__cerrar" data-cerrar-hoja aria-label="Cerrar">${icono('cerrar', { tam: 20 })}</button>
      </header>

      <div class="reparto-hoja__cuerpo">
        ${a.preguntaCobro ? `
          <div class="reparto-hoja__paso" role="radiogroup" aria-labelledby="entrega-cobro">
            <p class="reparto-hoja__pregunta" id="entrega-cobro">¿Cobraste ${pesos(pedido.total)}?</p>
            <div class="reparto-hoja__opciones">
              <button type="button" class="opcion reparto-hoja__opcion" role="radio" data-cobrado="si" aria-checked="${a.cobrado === true}">
                <span class="opcion__marca" aria-hidden="true"></span><span class="opcion__titulo">Sí, cobré</span>
              </button>
              <button type="button" class="opcion reparto-hoja__opcion" role="radio" data-cobrado="no" aria-checked="${a.cobrado === false}">
                <span class="opcion__marca" aria-hidden="true"></span><span class="opcion__titulo">No cobré</span>
              </button>
            </div>
            ${a.cobrado === false ? '<p class="reparto-hoja__nota">Queda anotado para que el local lo vea.</p>' : ''}
          </div>` : ''}

        <div class="reparto-hoja__paso">
          <p class="reparto-hoja__pregunta">Foto de la entrega <span>opcional</span></p>
          ${a.foto ? `
            <figure class="reparto-hoja__foto">
              <img src="${esc(a.foto.vista)}" alt="Foto de la entrega">
              <button type="button" class="reparto-hoja__quitar" data-quitar-foto aria-label="Quitar la foto">${icono('cerrar', { tam: 16, grosor: 2.5 })}</button>
            </figure>` : `
            <label class="reparto-hoja__sumar${a.procesando ? ' esqueleto' : ''}">
              <input type="file" accept="image/*" capture="environment" class="solo-lectores" data-foto-entrega>
              ${icono('camara', { tam: 24 })}
              <span>${a.procesando ? 'Preparando la foto' : 'Sacar una foto'}</span>
            </label>`}
        </div>
      </div>

      <footer class="reparto-hoja__pie">
        ${a.error ? `<p class="reparto-hoja__error" role="alert">${icono('atencion', { tam: 16 })}<span>${esc(a.error)}</span></p>` : ''}
        <button type="button" class="boton boton--primario boton--bloque boton--grande${a.enviando ? ' boton--cargando' : ''}"
                data-confirmar-entrega ${listo() ? '' : 'disabled'}>
          ${icono('tilde', { tam: 20, grosor: 2.5 })} Confirmar entrega
        </button>
      </footer>
    </section>`;
}

function alTocar(ev) {
  const a = abierta;
  if (!a) return;
  if (ev.target.closest('[data-cerrar-hoja]')) {
    if (!a.enviando) cerrarHojaEntrega();
    return;
  }
  const cobro = ev.target.closest('[data-cobrado]');
  if (cobro) {
    a.cobrado = cobro.dataset.cobrado === 'si';
    pintar();
    return;
  }
  if (ev.target.closest('[data-quitar-foto]')) {
    URL.revokeObjectURL?.(a.foto?.vista);
    a.foto = null;
    pintar();
    return;
  }
  if (ev.target.closest('[data-confirmar-entrega]')) enviar();
}

async function alCambiar(ev) {
  const entrada = ev.target.closest('[data-foto-entrega]');
  const a = abierta;
  if (!entrada || !a) return;
  const archivo = entrada.files?.[0];
  if (!archivo) return;
  a.procesando = true;
  a.error = null;
  pintar();
  try {
    const foto = await a.achicar(archivo);
    if (abierta !== a) return;
    a.foto = { tipo: foto.tipo, datos: foto.datos, vista: URL.createObjectURL?.(foto.blob) || '' };
  } catch (err) {
    if (abierta !== a) return;
    a.error = err?.message || 'No pudimos abrir esa foto. Probá con otra.';
  } finally {
    if (abierta === a) {
      a.procesando = false;
      pintar();
    }
  }
}

async function enviar() {
  const a = abierta;
  if (!a || !listo()) return;
  a.enviando = true;
  a.error = null;
  pintar();
  const resultado = await a.confirmar({
    cobrado: a.preguntaCobro ? a.cobrado : null,
    foto: a.foto ? { tipo: a.foto.tipo, datos: a.foto.datos } : null,
  });
  if (abierta !== a) return;
  if (resultado.ok) {
    cerrarHojaEntrega();
    return;
  }
  a.enviando = false;
  a.error = resultado.mensaje || 'No se pudo marcar la entrega. Probá de nuevo.';
  pintar();
}
