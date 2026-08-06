/**
 * Pedido confirmado y su seguimiento.
 *
 * Es la misma pantalla para los dos momentos: el segundo despues de confirmar y
 * la vuelta a mirar como viene. Separarlas obligaria a mantener dos veces el
 * mismo resumen, y el cliente que confirma quiere ver exactamente lo que va a
 * mirar despues.
 *
 * El estado se actualiza solo. Que el cliente vea pasar "Preparando" a "En
 * camino" sin recargar es lo que convierte esta pagina en un seguimiento de
 * verdad y le saca al local la mitad de las llamadas preguntando.
 */
import { cargarConfig } from '../datos.js';
import { pie, vacio } from '../componentes.js';
import { pesos, esc, distancia } from '../formato.js';
import { icono } from '../iconos.js';
import { traerPedido, seguirPedido, pasosDe, indiceDeEstado } from '../pedidos.js';

// Vive fuera de la funcion a proposito: al navegar a otra pantalla el nodo se
// reemplaza pero la suscripcion seguiria viva, escuchando una pagina que ya no
// existe.
let cortarSeguimiento = null;

export async function pedido({ montar, params }) {
  cortarSeguimiento?.();
  cortarSeguimiento = null;

  const cfg = await cargarConfig();

  let datos;
  try {
    datos = await traerPedido(params.id);
  } catch (err) {
    console.error('[pedido] no se pudo leer:', err);
    datos = null;
  }

  if (!datos) {
    document.title = 'No encontramos el pedido · Librería Liceo';
    montar(`
      <div class="contenedor">
        ${vacio({
          titulo: 'No encontramos este pedido',
          texto: 'Puede que el enlace esté cortado. Si ya lo hiciste, buscalo en "Mi pedido"; ' +
                 'y si no aparece, escribinos con tu nombre y lo ubicamos.',
          acciones: `
            <a class="boton boton--primario" href="/seguimiento">Ver mis pedidos</a>
            <a class="boton boton--secundario" href="https://wa.me/${esc(cfg.whatsapp)}"
               target="_blank" rel="noopener">${icono('whatsapp', { tam: 16 })} Escribirnos</a>`,
        })}
      </div>
      ${pie(cfg)}`);
    return;
  }

  document.title = `Pedido ${datos.codigo || ''} · Librería Liceo`;

  montar(`<div class="contenedor" data-pedido></div>${pie(cfg)}`);
  const caja = document.querySelector('[data-pedido]');
  caja.innerHTML = contenido(datos, cfg);

  cortarSeguimiento = seguirPedido(params.id, actualizado => {
    // Si la pantalla ya no está en el documento, la persona navegó a otra cosa
    // y esta suscripción no tiene a quién avisarle.
    if (!document.contains(caja)) {
      cortarSeguimiento?.();
      cortarSeguimiento = null;
      return;
    }
    if (actualizado) caja.innerHTML = contenido(actualizado, cfg);
  });
}

function contenido(p, cfg) {
  const modo = p.entrega?.modo || 'retiro';
  const cancelado = p.estado === 'cancelado';
  const pasos = pasosDe(modo);
  const actual = indiceDeEstado(p.estado, modo);

  const mensajeWhatsapp = encodeURIComponent(
    `Hola, consulto por mi pedido ${p.codigo || ''} a nombre de ${p.cliente?.nombre || ''}.`);

  return `
    <div class="pedido">
      <div class="pedido__cabecera">
        <span class="pedido__marca">${icono('tilde', { tam: 26, grosor: 3 })}</span>
        <div>
          <h1 class="pedido__titulo">${cancelado ? 'Pedido cancelado' : 'Listo, tenemos tu pedido'}</h1>
          <p class="pedido__bajada">${
            cancelado
              ? 'Si fue un error, escribinos y lo volvemos a cargar.'
              : `Te avisamos por WhatsApp al ${esc(p.cliente?.telefono || '')} cuando esté ${
                  modo === 'retiro' ? 'para retirar' : 'en camino'}.`
          }</p>
        </div>
      </div>

      <div class="pedido__codigo">
        <span class="pedido__codigo-etiqueta">Tu código</span>
        <strong class="pedido__codigo-valor cifra">${esc(p.codigo || '—')}</strong>
        <span class="pedido__codigo-ayuda">Decilo cuando vengas o cuando nos escribas.</span>
      </div>

      <div class="pedido__grilla">
        <div class="pedido__caja">
          <h2 class="checkout__caja-titulo">Cómo viene</h2>
          ${cancelado ? `
            <p style="color:var(--text-2);line-height:var(--alto-suelto)">
              Este pedido está cancelado.
            </p>`
          : `
            <div class="progreso">
              ${pasos.map((paso, i) => `
                <div class="progreso__paso${
                  i < actual ? ' progreso__paso--hecho' : (i === actual ? ' progreso__paso--actual' : '')}">
                  <span class="progreso__marca" aria-hidden="true">${
                    i < actual ? icono('tilde', { tam: 13, grosor: 3 }) : ''}</span>
                  <span class="progreso__texto">
                    <span class="progreso__titulo">${esc(paso.titulo)}</span>
                    ${i === actual ? `<span class="progreso__hora">${esc(paso.detalle)}</span>` : ''}
                  </span>
                </div>`).join('')}
            </div>`}
        </div>

        <div class="pedido__caja">
          <h2 class="checkout__caja-titulo">${modo === 'retiro' ? 'Lo retirás en' : 'Lo llevamos a'}</h2>
          <p class="pedido__dato">
            ${modo === 'retiro'
              ? `${esc(cfg.direccion)}<br><span class="apagado">${esc(cfg.horarios_texto)}</span>`
              : `${esc(p.entrega?.direccion || '')}${
                  p.entrega?.referencia ? `<br><span class="apagado">${esc(p.entrega.referencia)}</span>` : ''}${
                  p.entrega?.distancia_km ? `<br><span class="apagado">${distancia(p.entrega.distancia_km)} del local</span>` : ''}`}
          </p>
          <p class="pedido__dato">
            <span class="apagado">Pagás con</span> ${
              p.pago?.modo === 'transferencia' ? 'transferencia' : 'efectivo'}${
              p.pago?.modo === 'transferencia' && cfg.pago?.alias
                ? `<br><span class="apagado">Alias</span> <strong>${esc(cfg.pago.alias)}</strong>`
                : ''}
          </p>
          ${p.nota ? `<p class="pedido__dato"><span class="apagado">Tu nota</span><br>${esc(p.nota)}</p>` : ''}
        </div>
      </div>

      <div class="pedido__caja">
        <h2 class="checkout__caja-titulo">Lo que pediste</h2>
        <ul class="resumen-items">
          ${(p.items || []).map(i => `
            <li class="resumen-item">
              <span class="resumen-item__cantidad cifra">${
                esc(i.unidad === 'metro'
                  ? `${Number(i.cantidad).toFixed(1).replace('.', ',')} m`
                  : String(Math.round(i.cantidad)))}</span>
              <span class="resumen-item__nombre">
                ${esc(i.nombre)}
                ${i.variedad ? `<em>${esc(i.variedad)}</em>` : ''}
                ${i.es_pack ? `<em>Pack de ${i.pack_contenido}</em>` : ''}
              </span>
              <span class="resumen-item__precio cifra">${pesos(i.subtotal ?? i.precio * i.cantidad)}</span>
            </li>`).join('')}
        </ul>

        <div class="totales">
          <div class="totales__fila">
            <span>Productos</span>
            <strong class="cifra">${pesos(p.subtotal || 0)}</strong>
          </div>
          <div class="totales__fila">
            <span>Envío</span>
            ${modo === 'retiro'
              ? '<strong style="color:var(--exito)">Sin cargo</strong>'
              : p.entrega?.envio_a_confirmar
                ? '<strong style="color:var(--text-2)">A confirmar</strong>'
                : `<strong class="cifra">${pesos(p.envio || 0)}</strong>`}
          </div>
          <div class="totales__fila totales__fila--total">
            <span>Total</span>
            <strong class="cifra">${pesos(p.total || 0)}</strong>
          </div>
        </div>
        ${p.entrega?.envio_a_confirmar
          ? `<p class="checkout__nota-envio">${icono('atencion', { tam: 15 })}
               <span>Falta sumarle el envío. Te lo decimos antes de salir.</span></p>`
          : ''}
      </div>

      <div class="pedido__acciones">
        <a class="boton boton--secundario" href="https://wa.me/${esc(cfg.whatsapp)}?text=${mensajeWhatsapp}"
           target="_blank" rel="noopener">
          ${icono('whatsapp', { tam: 18 })} Consultar por este pedido
        </a>
        <a class="boton boton--fantasma" href="/catalogo">Seguir comprando</a>
      </div>
    </div>`;
}
