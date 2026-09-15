/**
 * Lo que se dibuja en la pantalla del repartidor. Solo HTML a partir de datos:
 * quién lo decide y cuándo se repinta está en `app.js`.
 */
import { esc, distancia, haceCuanto, pesos, aFecha } from '../formato.js';
import { icono } from '../iconos.js';
import { whatsappDeTelefono } from '../telefono.js';
import {
  ETIQUETAS, siguientePaso, cobroDe, enlaceNavegar, enlaceRuta, resumenDelDia,
  PERIODOS_HISTORIAL, etiquetaDia, envioDe,
} from '../reparto.js';

// En la lista "Después" todo está para llevar: con "Listo" alcanza, y el lugar
// que sobra es para el nombre del cliente.
const ETIQUETAS_LISTA = { listo: 'Listo' };

/* ── Pantallas enteras ────────────────────────────────────────────────────── */

export function pantallaAviso({ titulo, texto, reintentar = false }) {
  return `
    <div class="reparto-aviso" role="status">
      <span class="reparto-aviso__icono">${icono('camion', { tam: 28 })}</span>
      <h1 class="reparto-aviso__titulo">${esc(titulo)}</h1>
      <p class="reparto-aviso__texto">${esc(texto)}</p>
      ${reintentar ? '<button type="button" class="boton boton--primario" data-reintentar>Reintentar</button>' : ''}
    </div>`;
}

export function esqueleto() {
  return `
    <div class="reparto-cuerpo" aria-busy="true">
      <div class="esqueleto reparto-esqueleto reparto-esqueleto--alto"></div>
      <div class="esqueleto reparto-esqueleto"></div>
      <div class="esqueleto reparto-esqueleto"></div>
    </div>`;
}

/** El armazón que queda fijo: el mapa no se vuelve a pedir con cada cambio. */
export function armazon() {
  return `
    <header class="reparto-barra">
      <div class="reparto-barra__marca">
        <img src="/logo-liceo.png" alt="Librería Liceo" width="96" height="24">
        <span class="reparto-barra__titulo">Reparto</span>
      </div>
      <span class="reparto-vivo" data-vivo><i aria-hidden="true"></i>En vivo</span>
      <nav class="reparto-pestanas" role="tablist" aria-label="Secciones">
        <button type="button" role="tab" class="reparto-pestana" data-vista="reparto" aria-selected="true">Pedidos</button>
        <button type="button" role="tab" class="reparto-pestana" data-vista="historial" aria-selected="false">Historial</button>
      </nav>
      <p class="reparto-conexion" data-conexion role="status" hidden>
        ${icono('atencion', { tam: 16 })}<span>Se cortó la conexión. Reconectando, lo que ves puede no estar al día.</span>
      </p>
    </header>
    <div data-pantalla-reparto>
      <div class="reparto-resumen" data-resumen></div>
      <main class="reparto-cuerpo">
        <div class="reparto-principal">
          <div data-aviso-ubicacion></div>
          <section data-zona-proxima></section>
          <section data-listas></section>
        </div>
        <aside class="reparto-lateral">
          <div class="reparto-mapa" data-mapa></div>
          <div data-zona-ruta></div>
        </aside>
      </main>
    </div>
    <section class="reparto-historial" data-historial aria-label="Historial" hidden></section>`;
}

/* ── Partes ───────────────────────────────────────────────────────────────── */

export function resumen({ enCurso, entregadosHoy }) {
  const llevar = enCurso.filter(p => p.estado === 'listo' || p.estado === 'en_camino').length;
  const preparando = enCurso.length - llevar;
  const dia = resumenDelDia(entregadosHoy);
  const dato = (n, texto) => `<span class="reparto-resumen__dato"><strong>${n}</strong> ${texto}</span>`;
  return `
    ${dato(llevar, 'para llevar')}
    ${dato(preparando, 'preparando')}
    ${dato(dia.entregados, dia.entregados === 1 ? 'entregado hoy' : 'entregados hoy')}
    ${dia.efectivo ? `<span class="reparto-resumen__dato reparto-resumen__dato--plata">${pesos(dia.efectivo)} en efectivo</span>` : ''}`;
}

export function avisoUbicacion(estado) {
  if (estado === 'activa' || estado === 'pidiendo') return '';
  const texto = estado === 'denegada'
    ? 'La ubicación está bloqueada. Activala en los permisos del navegador para que te recomiende el más cercano.'
    : estado === 'no_disponible'
      ? 'Este navegador no da la ubicación: el orden es por el que entró primero.'
      : 'Activá tu ubicación y te recomiendo el pedido que te queda más cerca.';
  return `
    <div class="reparto-ubicacion">
      ${icono('pin', { tam: 20 })}
      <p>${esc(texto)}</p>
      ${estado === 'sin_pedir' ? '<button type="button" class="boton boton--secundario boton--chico" data-activar-ubicacion>Activar</button>' : ''}
    </div>`;
}

function contacto(pedido, { grande = false } = {}) {
  const telefono = String(pedido.cliente?.telefono || '').trim();
  if (!telefono) return '';
  const wa = whatsappDeTelefono(telefono);
  const clase = grande ? 'boton boton--secundario reparto-icono-boton' : 'reparto-enlace';
  return `
    <a class="${clase}" href="tel:${esc(telefono.replace(/[^\d+]/g, ''))}" aria-label="Llamar a ${esc(pedido.cliente?.nombre || 'el cliente')}">
      ${icono('telefono', { tam: 18 })}${grande ? '' : ' Llamar'}
    </a>
    ${wa ? `
      <a class="${clase}${grande ? ' reparto-icono-boton--wa' : ''}" href="https://wa.me/${wa}?text=${encodeURIComponent(`Hola ${pedido.cliente?.nombre || ''}, soy el repartidor de Librería Liceo con tu pedido ${pedido.codigo || ''}.`)}"
         target="_blank" rel="noopener" aria-label="WhatsApp a ${esc(pedido.cliente?.nombre || 'el cliente')}">
        ${icono('whatsapp', { tam: 18 })}${grande ? '' : ' WhatsApp'}
      </a>` : ''}`;
}

function chipCobro(pedido) {
  const c = cobroDe(pedido);
  const tono = c.pagado ? 'pagado' : c.efectivo ? 'cobrar' : 'consultar';
  return `<span class="reparto-cobro reparto-cobro--${tono}">${esc(c.texto)}</span>`;
}

function botonMover(pedido, moviendo) {
  const paso = siguientePaso(pedido);
  if (!paso) return '';
  const ocupado = moviendo.has(pedido.id);
  const final = paso.estado === 'entregado';
  return `
    <button type="button" class="boton ${final ? 'boton--entregar' : 'boton--secundario'} boton--bloque${ocupado ? ' boton--cargando' : ''}"
            data-mover="${paso.estado}" data-id="${esc(pedido.id)}" ${ocupado ? 'disabled' : ''}>
      ${final ? icono('tilde', { tam: 18, grosor: 2.5 }) : ''}${esc(paso.texto)}
    </button>`;
}

function direccion(pedido) {
  const e = pedido.entrega || {};
  return `
    <p class="reparto-direccion">${esc(e.direccion || 'Sin dirección')}</p>
    ${e.referencia ? `<p class="reparto-referencia">${esc(e.referencia)}</p>` : ''}`;
}

/**
 * La tarjeta grande: el pedido que conviene llevar ahora.
 * @param {{pedido, km}} parada
 */
export function proxima(parada, { moviendo, conUbicacion }) {
  if (!parada) {
    return `
      <div class="reparto-vacio">
        ${icono('tilde', { tam: 26, grosor: 2.5 })}
        <p class="reparto-vacio__titulo">No hay pedidos para llevar</p>
        <p class="reparto-vacio__texto">Cuando el local marque uno como listo aparece acá, sin recargar.</p>
      </div>`;
  }
  const { pedido, km } = parada;
  const navegar = enlaceNavegar(pedido);
  return `
    <article class="reparto-proxima" data-proxima="${esc(pedido.id)}" data-parada="${esc(pedido.id)}">
      <div class="reparto-proxima__cabeza">
        <span class="parada__numero" aria-hidden="true">1</span>
        <span class="reparto-proxima__etiqueta">${conUbicacion ? 'Te queda más cerca' : 'Próxima parada'}</span>
        ${km !== null && km !== undefined ? `<span class="reparto-proxima__km">a ${distancia(km)}</span>` : ''}
      </div>
      <h2 class="reparto-proxima__nombre">${esc(pedido.cliente?.nombre || 'Sin nombre')}</h2>
      ${direccion(pedido)}
      <div class="reparto-proxima__datos">
        <span class="reparto-codigo">${esc(pedido.codigo || '')}</span>
        <span class="reparto-estado reparto-estado--${esc(pedido.estado)}">${esc(ETIQUETAS[pedido.estado] || '')}</span>
        ${chipCobro(pedido)}
      </div>
      ${pedido.nota ? `<p class="reparto-nota">${icono('chat', { tam: 15 })}<span>${esc(pedido.nota)}</span></p>` : ''}
      <div class="reparto-proxima__acciones">
        ${navegar ? `
          <a class="boton boton--primario reparto-navegar" href="${esc(navegar)}" target="_blank" rel="noopener" data-navegar>
            ${icono('navegar', { tam: 20 })} Navegar
          </a>` : ''}
        ${contacto(pedido, { grande: true })}
      </div>
      ${botonMover(pedido, moviendo)}
    </article>`;
}

function productos(pedido) {
  return `
    <ul class="reparto-productos">
      ${(pedido.items || []).map(i => `
        <li><strong>${esc(String(i.cantidad ?? ''))}</strong> ${esc(i.nombre || '')}${
          i.variedad ? ` <span>· ${esc(i.variedad)}</span>` : ''}${i.es_pack ? ` <span>· ${esc(i.pack_nombre || 'pack')}</span>` : ''}</li>`).join('')}
    </ul>`;
}

function parada({ pedido, km }, numero, { moviendo, abiertos }) {
  const abierta = abiertos.has(pedido.id);
  const navegar = enlaceNavegar(pedido);
  return `
    <li class="parada${abierta ? ' parada--abierta' : ''}" data-parada="${esc(pedido.id)}">
      <button type="button" class="parada__cabeza" data-abrir="${esc(pedido.id)}" aria-expanded="${abierta}">
        <span class="parada__numero">${numero}</span>
        <span class="parada__texto">
          <span class="parada__nombre">${esc(pedido.cliente?.nombre || 'Sin nombre')}</span>
          <span class="parada__direccion">${esc(pedido.entrega?.direccion || 'Sin dirección')}</span>
        </span>
        <span class="parada__lado">
          ${km !== null && km !== undefined ? `<span class="parada__km">${distancia(km)}</span>` : ''}
          <span class="reparto-estado reparto-estado--${esc(pedido.estado)}">${esc(ETIQUETAS_LISTA[pedido.estado] || ETIQUETAS[pedido.estado] || '')}</span>
        </span>
      </button>
      <div class="parada__detalle">
        ${direccion(pedido)}
        <div class="parada__fila">
          <span class="reparto-codigo">${esc(pedido.codigo || '')}</span>
          ${chipCobro(pedido)}
        </div>
        ${productos(pedido)}
        ${pedido.nota ? `<p class="reparto-nota">${icono('chat', { tam: 15 })}<span>${esc(pedido.nota)}</span></p>` : ''}
        <div class="parada__enlaces">
          ${navegar ? `<a class="reparto-enlace" href="${esc(navegar)}" target="_blank" rel="noopener" data-navegar>${icono('navegar', { tam: 18 })} Navegar</a>` : ''}
          ${contacto(pedido)}
        </div>
        ${botonMover(pedido, moviendo)}
      </div>
    </li>`;
}

function preparando(pedido, { moviendo }) {
  return `
    <li class="reparto-preparando" data-preparando="${esc(pedido.id)}">
      <div class="reparto-preparando__texto">
        <span class="parada__nombre">${esc(pedido.cliente?.nombre || 'Sin nombre')}</span>
        <span class="parada__direccion">${esc(pedido.entrega?.direccion || '')} · entró ${esc(haceCuanto(pedido.creado))}</span>
        <span class="reparto-estado reparto-estado--${esc(pedido.estado)}">${esc(ETIQUETAS[pedido.estado] || '')}</span>
      </div>
      ${botonMover(pedido, moviendo)}
    </li>`;
}

/**
 * Las listas: lo que hay que llevar en orden de recorrido, lo que se está
 * preparando y lo entregado hoy.
 */
export function listas({ ruta, preparandoLista, entregadosHoy }, estado) {
  const resto = ruta.slice(1);
  return `
    ${resto.length ? `
      <h2 class="reparto-seccion">Después <span>${resto.length}</span></h2>
      <ol class="reparto-paradas">
        ${resto.map((p, i) => parada(p, i + 2, estado)).join('')}
      </ol>` : ''}
    ${preparandoLista.length ? `
      <h2 class="reparto-seccion">Se están preparando <span>${preparandoLista.length}</span></h2>
      <ul class="reparto-paradas">
        ${preparandoLista.map(p => preparando(p, estado)).join('')}
      </ul>` : ''}
    ${entregadosHoy.length ? `
      <details class="reparto-entregados"${estado.entregadosAbiertos ? ' open' : ''}>
        <summary>Entregados hoy <span>${entregadosHoy.length}</span></summary>
        <ul>
          ${entregadosHoy.map(p => `
            <li>
              <span>${esc(p.cliente?.nombre || '')} · ${esc(p.entrega?.direccion || '')}</span>
              <span class="reparto-codigo">${esc(p.codigo || '')}</span>
            </li>`).join('')}
        </ul>
      </details>` : ''}`;
}

/** El número de la próxima parada va primero, así el 1 del mapa es la tarjeta grande. */
export function enlaceDeRuta(ruta) {
  if (ruta.length < 2) return '';
  const url = enlaceRuta(ruta.map(p => p.pedido));
  return url ? `
    <a class="boton boton--secundario boton--bloque reparto-ruta" href="${esc(url)}" target="_blank" rel="noopener" data-ruta>
      ${icono('navegar', { tam: 18 })} Ruta con las ${Math.min(ruta.length, 10)} paradas
    </a>` : '';
}

/* ── Historial ────────────────────────────────────────────────────────────── */

const HORA = new Intl.DateTimeFormat('es-AR', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires',
});

function envioDeTexto(pedido) {
  if (pedido.entrega?.envio_gratis) return 'Gratis';
  if (pedido.entrega?.envio_a_confirmar) return 'A confirmar';
  return pesos(envioDe(pedido));
}

function entregaDelHistorial(pedido) {
  const fecha = aFecha(pedido.entregado_en);
  return `
    <li class="reparto-entrega">
      <div class="reparto-entrega__texto">
        <span class="reparto-entrega__nombre">${esc(pedido.cliente?.nombre || 'Sin nombre')}</span>
        <span class="reparto-entrega__direccion">${esc(pedido.entrega?.direccion || '')}</span>
        <span class="reparto-entrega__meta">
          <span class="reparto-codigo">${esc(pedido.codigo || '')}</span>${fecha ? `<span>${HORA.format(fecha)}</span>` : ''}
        </span>
      </div>
      <span class="reparto-entrega__envio">${esc(envioDeTexto(pedido))}</span>
    </li>`;
}

/**
 * El historial: la plata de los envíos del período, lo entregado y la lista
 * por día.
 * @param {{periodo: string, resumen: object, cargando: boolean, error: boolean}} datos
 */
export function historial({ periodo, resumen: r, cargando, error }) {
  const periodos = `
    <div class="reparto-periodos" role="group" aria-label="Período">
      ${PERIODOS_HISTORIAL.map(p => `
        <button type="button" class="reparto-periodo" data-periodo="${p.clave}" aria-pressed="${p.clave === periodo}">${p.texto}</button>`).join('')}
    </div>`;

  if (error) {
    return `${periodos}
      <div class="reparto-vacio reparto-vacio--error" role="alert">
        ${icono('atencion', { tam: 26 })}
        <p class="reparto-vacio__titulo">No pudimos traer el historial</p>
        <p class="reparto-vacio__texto">Revisá que tengas internet y probá de nuevo.</p>
        <button type="button" class="boton boton--secundario" data-reintentar-historial>Reintentar</button>
      </div>`;
  }
  if (cargando) {
    return `${periodos}
      <div class="esqueleto reparto-esqueleto reparto-esqueleto--total" aria-busy="true"></div>
      <div class="esqueleto reparto-esqueleto"></div>
      <div class="esqueleto reparto-esqueleto"></div>`;
  }

  const nombrePeriodo = PERIODOS_HISTORIAL.find(p => p.clave === periodo)?.texto || '';
  const notas = [
    r.gratis ? `${r.gratis} con envío gratis` : '',
    r.aConfirmar ? `${r.aConfirmar} con envío a confirmar` : '',
  ].filter(Boolean);

  return `${periodos}
    <section class="reparto-total">
      <p class="reparto-total__etiqueta">Plata de envíos · ${esc(nombrePeriodo)}</p>
      <p class="reparto-total__monto">${pesos(r.envios)}</p>
      <p class="reparto-total__detalle">
        <strong>${r.entregados}</strong> ${r.entregados === 1 ? 'pedido entregado' : 'pedidos entregados'}${
          r.efectivo ? ` · <strong>${pesos(r.efectivo)}</strong> cobrados en efectivo` : ''}
      </p>
      ${notas.length ? `<p class="reparto-total__nota">${esc(notas.join(' · '))}: no suman a la plata de envíos.</p>` : ''}
    </section>
    ${r.dias.length ? r.dias.map(dia => `
      <section class="reparto-dia">
        <h3 class="reparto-dia__titulo">
          <span>${esc(etiquetaDia(dia.dia))}</span>
          <span class="reparto-dia__suma">${dia.cantidad} ${dia.cantidad === 1 ? 'pedido' : 'pedidos'} · ${pesos(dia.envios)}</span>
        </h3>
        <ul class="reparto-dia__lista">
          ${dia.pedidos.map(entregaDelHistorial).join('')}
        </ul>
      </section>`).join('') : `
      <div class="reparto-vacio reparto-vacio--neutro">
        <p class="reparto-vacio__titulo">No hubo entregas en este período</p>
        <p class="reparto-vacio__texto">Probá con otro período arriba.</p>
      </div>`}`;
}
