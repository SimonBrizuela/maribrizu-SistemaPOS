/**
 * Pedido confirmado y su seguimiento.
 *
 * Es la misma pantalla para los dos momentos: el segundo despues de confirmar y
 * la vuelta a mirar como viene. Separarlas obligaria a mantener dos veces el
 * mismo resumen, y el cliente que confirma quiere ver exactamente lo que va a
 * mirar despues.
 *
 * Los dos momentos piden cosas distintas y por eso la pantalla esta partida en
 * dos alturas. Arriba, sobre negro, lo unico que importa recien confirmado: que
 * entro, el codigo para dictarlo y por donde le vamos a avisar. Abajo, lo que
 * importa cuando vuelve: en que anda y que pidio.
 *
 * El estado se actualiza solo. Que el cliente vea pasar "Preparando" a "En
 * camino" sin recargar es lo que convierte esta pagina en un seguimiento de
 * verdad y le saca al local la mitad de las llamadas preguntando.
 */
import { cargarConfig, configEnCache } from '../datos.js';
// La validación viene del módulo chico; el que sube (con el SDK de Storage
// atrás) se carga recién cuando alguien elige un archivo.
import { esComprobanteValido, comprobanteRecordado } from '../comprobante.js';
import { pie, vacio } from '../componentes.js';
import { pesos, esc, distancia, cuando, haceCuanto, lineasDeHorario } from '../formato.js';
import { icono, franjaMarca } from '../iconos.js';
import { montarMapa } from '../mapa.js';
import { seguirPedido, pasosDe, indiceDeEstado } from '../pedidos.js';
import { describirPack } from '../carrito.js';
import { avisar } from '../avisos.js';

// Viven fuera de la funcion a proposito: al navegar a otra pantalla el nodo se
// reemplaza pero la suscripcion y el mapa seguirian vivos, escuchando y
// midiendo una pagina que ya no existe.
let cortarSeguimiento = null;
let soltarMapa = null;

export async function pedido({ montar, params }) {
  cortarSeguimiento?.();
  cortarSeguimiento = null;
  soltarMapa?.();
  soltarMapa = null;

  const cfg = configEnCache() || await cargarConfig();

  // Se pinta el armazón antes de tener el pedido. Antes esta pantalla hacía dos
  // viajes a la red en fila —una lectura suelta y después la suscripción, que
  // trae exactamente lo mismo— y no mostraba nada hasta que volvían los dos.
  // Ahora el único viaje es la suscripción, y mientras tanto hay algo en
  // pantalla en vez de un blanco.
  document.title = 'Pedido · Librería Liceo';
  montar(`<div class="contenedor" data-pedido>${esqueleto()}</div>${pie(cfg)}`);
  const caja = document.querySelector('[data-pedido]');

  function pintar(p) {
    soltarMapa?.();
    soltarMapa = null;
    caja.innerHTML = contenido(p, cfg);

    // El mapa se monta despues de tener el nodo en el documento: necesita
    // medirlo para saber que area pedirle a Google.
    const hueco = caja.querySelector('[data-mapa-pedido]');
    const destino = p.entrega?.coordenadas;
    if (hueco && cfg.origen && destino) {
      soltarMapa = montarMapa(hueco, {
        local: cfg.origen,
        destino,
        direccionLocal: cfg.direccion,
        direccionDestino: p.entrega?.direccion,
        km: p.entrega?.distancia_km,
      });
    }
  }

  /* ── Comprobante de transferencia ───────────────────────────────────────
     Un solo listener en el contenedor: la pantalla se vuelve a pintar con cada
     cambio de estado del pedido, así que enganchar el botón directo lo dejaría
     muerto a la primera actualización. */
  caja.addEventListener('click', ev => {
    if (!ev.target.closest('[data-subir-comprobante]')) return;
    caja.querySelector('[data-archivo-comprobante]')?.click();
  });

  caja.addEventListener('change', async ev => {
    const input = ev.target.closest('[data-archivo-comprobante]');
    if (!input) return;

    const archivo = input.files?.[0];
    input.value = '';
    if (!archivo) return;

    const bloque = caja.querySelector('[data-comprobante]');
    const pista = bloque?.querySelector('[data-estado-comprobante]');
    const boton = bloque?.querySelector('[data-subir-comprobante]');
    const decir = (texto, mal = false) => {
      if (!pista) return;
      pista.textContent = texto;
      pista.classList.toggle('comprobante__pista--mal', mal);
    };

    const problema = esComprobanteValido(archivo);
    if (problema) { decir(problema, true); return; }

    if (boton) boton.disabled = true;
    try {
      const { subirComprobante } = await import('../comprobante.js');
      const { tipo } = await subirComprobante(params.id, archivo,
                                              { alProgreso: t => decir(t) });
      // El recibo se rearma con lo recién subido: miniatura nueva, pista limpia.
      const recibo = bloque.querySelector('.comprobante__recibo');
      if (recibo) recibo.outerHTML = reciboComprobante(comprobanteRecordado(params.id));
      const pistaNueva = bloque.querySelector('[data-estado-comprobante]');
      if (pistaNueva) {
        pistaNueva.textContent = tipo === 'pdf'
          ? 'Recibimos el PDF nuevo. Lo revisamos y te confirmamos el pedido.'
          : 'Recibimos la foto nueva. La revisamos y te confirmamos el pedido.';
      }
      if (boton) boton.disabled = false;
    } catch (err) {
      console.error('[comprobante]', err);
      decir(err?.message || 'No se pudo enviar. Probá de nuevo.', true);
      if (boton) boton.disabled = false;
    }
  });

  // Copiar el alias sin salir de la ficha: es el dato que el cliente lleva al
  // homebanking y tipearlo a mano es donde se equivoca.
  caja.addEventListener('click', async ev => {
    const boton = ev.target.closest('[data-copiar-alias]');
    if (!boton) return;
    const alias = caja.querySelector('[data-alias]')?.textContent?.trim();
    if (!alias) return;
    try {
      await navigator.clipboard.writeText(alias);
      boton.textContent = 'Copiado';
      setTimeout(() => { boton.textContent = 'Copiar'; }, 2000);
    } catch (_) {
      avisar('Copialo a mano: ' + alias, { duracion: 6000 });
    }
  });

  // Copiar el enlace, con el aviso puesto en el propio botón: un toast más
  // arriba de todo, en el celular, aparece fuera de la vista.
  caja.addEventListener('click', async ev => {
    const boton = ev.target.closest('[data-copiar]');
    if (!boton) return;

    try {
      await navigator.clipboard.writeText(location.href);
      const antes = boton.innerHTML;
      boton.innerHTML = `${icono('tilde', { tam: 16 })} Copiado`;
      setTimeout(() => { boton.innerHTML = antes; }, 2000);
    } catch {
      // Sin permiso de portapapeles —pasa en algunos navegadores del celular—
      // se selecciona la dirección para que se pueda copiar a mano.
      avisar('Copiá el enlace desde la barra de direcciones del navegador.',
             { duracion: 6000 });
    }
  });

  /** Cuando el pedido no existe, o cuando no se pudo leer. */
  function pintarPerdido() {
    document.title = 'No encontramos el pedido · Librería Liceo';
    caja.innerHTML = vacio({
      titulo: 'No encontramos este pedido',
      texto: 'Puede que el enlace esté cortado. Si ya lo hiciste, buscalo en "Mi pedido"; ' +
             'y si no aparece, escribinos con tu nombre y lo ubicamos.',
      acciones: `
        <a class="boton boton--primario" href="/seguimiento">Ver mis pedidos</a>
        <a class="boton boton--secundario" href="https://wa.me/${esc(cfg.whatsapp)}"
           target="_blank" rel="noopener">${icono('whatsapp', { tam: 16 })} Escribirnos</a>`,
    });
  }

  cortarSeguimiento = seguirPedido(params.id, actualizado => {
    // Si la pantalla ya no está en el documento, la persona navegó a otra cosa
    // y esta suscripción no tiene a quién avisarle.
    if (!document.contains(caja)) {
      cortarSeguimiento?.();
      cortarSeguimiento = null;
      soltarMapa?.();
      soltarMapa = null;
      return;
    }
    if (actualizado) {
      document.title = `Pedido ${actualizado.codigo || ''} · Librería Liceo`;
      pintar(actualizado);
    } else {
      pintarPerdido();
    }
  }, () => {
    if (document.contains(caja)) pintarPerdido();
  });
}

/**
 * El armazón mientras llega el pedido.
 *
 * Repite la forma de lo que viene —la tarjeta oscura de arriba y los pasos— así
 * el contenido real no reacomoda la pantalla al entrar.
 */
function esqueleto() {
  return `
    <div class="pedido-esqueleto" aria-hidden="true">
      <div class="pedido-esqueleto__tapa"></div>
      <div class="pedido-esqueleto__barra" style="width:45%"></div>
      <div class="pedido-esqueleto__barra" style="width:80%"></div>
      <div class="pedido-esqueleto__barra" style="width:65%"></div>
    </div>
    <p class="pedido-esqueleto__aviso" role="status">Buscando tu pedido</p>`;
}

/* ── Pantalla ─────────────────────────────────────────────────────────────── */

function contenido(p, cfg) {
  const modo = p.entrega?.modo || 'retiro';
  const cancelado = p.estado === 'cancelado';

  const mensajeWhatsapp = encodeURIComponent(
    `Hola, consulto por mi pedido ${p.codigo || ''} a nombre de ${p.cliente?.nombre || ''}.`);

  return `
    <div class="pedido">
      ${encabezado(p, cfg, { modo, cancelado })}

      <!-- Tres hermanos y no dos columnas con cosas adentro: en el celular se
           apilan en un orden distinto del que tienen en escritorio, y eso solo
           se puede hacer si la grilla los coloca de a uno. -->
      <div class="pedido__grilla">
        ${cancelado ? '' : seccion('Cómo viene', linea(p, modo), 'linea')}
        <aside class="pedido__ficha-hueco">${ficha(p, cfg, modo)}</aside>
        ${seccion('Lo que pediste', detalleDelPedido(p, modo), 'items')}
      </div>

      <!-- El enlace de este pedido es la unica llave que abre esta pantalla
           desde otro telefono o desde la computadora: la lista de "Mis pedidos"
           sale de este navegador, porque las reglas no dejan listar la
           coleccion y esta bien que no lo dejen. Guardarlo es lo que hace que
           el pedido no se pierda si la persona cambia de aparato o borra los
           datos del navegador. -->
      <div class="pedido__guardar">
        <p class="pedido__guardar-texto">
          ${icono('pin', { tam: 17 })}
          <span>Guardá este enlace para seguir el pedido desde cualquier
          teléfono o computadora.</span>
        </p>
        <div class="pedido__guardar-botones">
          <button type="button" class="boton boton--secundario boton--chico" data-copiar>
            ${icono('bolsa', { tam: 16 })} Copiar el enlace
          </button>
          <a class="boton boton--secundario boton--chico"
             href="https://wa.me/?text=${encodeURIComponent(
               `Mi pedido ${p.codigo || ''} en Librería Liceo: ${location.href}`)}"
             target="_blank" rel="noopener">
            ${icono('whatsapp', { tam: 16 })} Mandármelo por WhatsApp
          </a>
        </div>
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

/**
 * El bloque negro de arriba.
 *
 * Va sobre negro y no sobre blanco por lo mismo que el encabezado y la portada:
 * el logo es color saturado sobre negro y esa tension es la marca. Ademas
 * separa de un vistazo lo que se mira una sola vez —el codigo— de lo que se
 * vuelve a mirar cada vez que el cliente entra.
 */
function encabezado(p, cfg, { modo, cancelado }) {
  const paso = pasosDe(modo)[indiceDeEstado(p.estado, modo)];
  const { titulo, bajada } = mensaje(p, modo, cancelado);
  const desde = haceCuanto(p.creado);

  return `
    <header class="pedido-hero${cancelado ? ' pedido-hero--cancelado' : ''}">
      <div class="pedido-hero__cuerpo">
        ${paso && !cancelado ? `
          <p class="pedido-hero__estado">
            <span class="pedido-hero__pulso" aria-hidden="true"></span>
            ${esc(paso.titulo)}
          </p>` : ''}
        <h1 class="pedido-hero__titulo">${esc(titulo)}</h1>
        <p class="pedido-hero__bajada">${esc(bajada)}</p>
        ${desde ? `<p class="pedido-hero__desde">Entró ${esc(desde)}</p>` : ''}
      </div>

      <div class="pedido-hero__codigo">
        <span class="pedido-hero__etiqueta">Tu código</span>
        <strong class="pedido-hero__valor">${esc(p.codigo || '—')}</strong>
        <span class="pedido-hero__ayuda">Decilo cuando vengas o cuando nos escribas.</span>
      </div>

      ${franjaMarca()}
    </header>`;
}

/**
 * El titulo grande y su bajada, segun donde este el pedido.
 *
 * Antes era un solo texto para todos los estados y quedaba raro cuando el
 * pedido ya estaba listo: arriba decia "Listo" el estado y abajo "Listo,
 * tenemos tu pedido", como si no se hubiera enterado. Y el "te avisamos cuando
 * este en camino" seguia ahi despues de que el pedido salio.
 */
function mensaje(p, modo, cancelado) {
  const telefono = p.cliente?.telefono || '';
  const retiro = modo === 'retiro';

  if (cancelado) {
    return {
      titulo: 'Pedido cancelado',
      bajada: 'Si fue un error, escribinos y lo volvemos a cargar.',
    };
  }

  switch (p.estado) {
    case 'entregado':
      return {
        titulo: retiro ? 'Pedido retirado' : 'Pedido entregado',
        bajada: 'Gracias por comprar acá.',
      };
    case 'en_camino':
      return {
        titulo: 'Tu pedido va en camino',
        // El recordatorio del efectivo sale del pago de ESTE pedido, no de la
        // config: un pedido viejo cargado en efectivo lo sigue necesitando
        // aunque la tienda ya no lo ofrezca.
        bajada: p.pago?.modo === 'efectivo'
          ? 'Salió para tu dirección. Tené el efectivo a mano.'
          : 'Salió para tu dirección.',
      };
    case 'listo':
      return retiro
        ? {
            titulo: 'Ya lo podés pasar a buscar',
            bajada: 'Está armado y esperándote en el local. Decí tu código al llegar.',
          }
        : {
            titulo: 'Listo para salir',
            bajada: `Sale con el próximo reparto. Te avisamos al ${telefono} cuando arranque.`,
          };
    default:
      return {
        titulo: 'Listo, tenemos tu pedido',
        bajada: `Te avisamos por WhatsApp al ${telefono} cuando esté ${
          retiro ? 'para retirar' : 'en camino'}.`,
      };
  }
}

/** Titulo con su regla y el contenido debajo. Sin caja: la pantalla es un documento. */
function seccion(titulo, cuerpo, area) {
  return `
    <section class="pedido-seccion" style="grid-area:${area}">
      <h2 class="pedido-seccion__titulo">${esc(titulo)}</h2>
      ${cuerpo}
    </section>`;
}

/* ── Cómo viene ───────────────────────────────────────────────────────────── */

/**
 * Los pasos, con los marcadores de tres tamanos distintos.
 *
 * Antes eran cinco circulos iguales y solo cambiaba el color: la pantalla no
 * decia en que anda el pedido, habia que leerla. Ahora el paso actual es el
 * marcador grande, lo hecho queda chico y en verde, y lo que falta son anillos
 * finos unidos por una linea de puntos. Se lee de lejos y sin texto.
 *
 * Los unicos tiempos que aparecen son los que existen de verdad. El documento
 * guarda `creado` y nada mas: el local mueve el estado pero no deja la hora de
 * cada paso, asi que poner "13:24" en "Lo estamos preparando" seria inventarlo.
 */
function linea(p, modo) {
  const pasos = pasosDe(modo);
  const actual = indiceDeEstado(p.estado, modo);
  const entrada = cuando(p.creado);

  return `
    <ol class="linea">
      ${pasos.map((paso, i) => {
        const hecho = i < actual;
        const esActual = i === actual;

        const meta = i === 0 && entrada ? entrada
                   : esActual ? paso.detalle
                   : '';

        return `
          <li class="linea__paso${hecho ? ' linea__paso--hecho' : esActual ? ' linea__paso--actual' : ''}">
            <span class="linea__marca" aria-hidden="true">${
              hecho ? icono('tilde', { tam: 12, grosor: 3.5 }) : ''}</span>
            <span class="linea__texto">
              <span class="linea__titulo">${esc(paso.titulo)}</span>
              ${meta ? `<span class="linea__meta">${esc(meta)}</span>` : ''}
            </span>
            ${esActual ? '<span class="solo-lectores">(paso actual)</span>' : ''}
          </li>`;
      }).join('')}
    </ol>`;
}

/* ── Lo que pediste ───────────────────────────────────────────────────────── */

function detalleDelPedido(p, modo) {
  const items = p.items || [];

  return `
    <ul class="pedido-items">
      ${items.map(i => {
        const cantidad = i.unidad === 'metro'
          ? `${Number(i.cantidad).toFixed(1).replace('.', ',')} m`
          : `${Math.round(i.cantidad)}`;

        const notas = [
          i.variedad || '',
          i.es_pack ? describirPack(i) : '',
          // El precio de a uno solo cuando hay mas de uno: con una unidad
          // repetiria el numero de la derecha.
          Number(i.cantidad) !== 1
            ? `${pesos(i.precio)} ${i.unidad === 'metro' ? 'el metro' : 'c/u'}`
            : '',
        ].filter(Boolean);

        return `
          <li class="pedido-item">
            <span class="pedido-item__foto">${
              i.foto
                ? `<img src="${esc(i.foto)}" alt="" loading="lazy" width="48" height="48">`
                : `<span class="pedido-item__inicial">${
                     esc((i.nombre || '?').charAt(0).toUpperCase())}</span>`}</span>
            <span class="pedido-item__texto">
              <span class="pedido-item__nombre">${esc(i.nombre)}</span>
              ${notas.length ? `<span class="pedido-item__nota">${esc(notas.join(' · '))}</span>` : ''}
            </span>
            <span class="pedido-item__cantidad cifra">${esc(cantidad)}</span>
            <span class="pedido-item__precio cifra">${pesos(i.subtotal ?? i.precio * i.cantidad)}</span>
          </li>`;
      }).join('')}
    </ul>

    <div class="totales">
      <div class="totales__fila">
        <span>Productos${items.length > 1 ? ` (${items.length})` : ''}</span>
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
      : ''}`;
}

/* ── La ficha del costado ─────────────────────────────────────────────────── */

/**
 * Donde, como se paga y la nota, en una sola caja.
 *
 * Antes eran dos cajas en una grilla de dos columnas de alturas iguales, y la
 * de la derecha tenia tres renglones contra los cinco pasos de la izquierda:
 * quedaba media caja en blanco. Ahora la columna es angosta, las cosas se
 * apilan y el mapa ocupa el lugar que sobraba diciendo algo.
 */
/**
 * El comprobante de la transferencia, que ya está enviado.
 *
 * Un pedido por transferencia nace recién cuando el comprobante llega, así que
 * en esta pantalla SIEMPRE hay uno: pedirlo de nuevo como si faltara hacía
 * dudar al cliente de si su pago llegó. Se muestra que está recibido, con la
 * vista previa cuando este navegador fue el que lo subió, y un botón para
 * cambiarlo por si la captura salió mal (subir de nuevo reemplaza, no acumula).
 *
 * Los pedidos ya entregados o cancelados no muestran nada: ahí no hay nada
 * que revisar.
 */
function reciboComprobante(recuerdo) {
  const miniatura = recuerdo?.url && recuerdo.tipo === 'imagen'
    ? `<a class="comprobante__miniatura" href="${esc(recuerdo.url)}"
          target="_blank" rel="noopener" title="Ver el comprobante entero">
         <img src="${esc(recuerdo.url)}" alt="Tu comprobante" loading="lazy">
       </a>`
    : `<span class="comprobante__icono">${icono('hoja', { tam: 18 })}</span>`;

  return `
    <div class="comprobante__recibo">
      ${miniatura}
      <div class="comprobante__texto">
        <p class="comprobante__titulo">${icono('tilde', { tam: 14, grosor: 3 })} Comprobante enviado</p>
        <p class="comprobante__pista" data-estado-comprobante>${
          recuerdo?.tipo === 'pdf' ? 'Recibimos el PDF. ' : ''
        }Lo revisamos y te confirmamos el pedido.</p>
      </div>
    </div>`;
}

function bloqueComprobante(p) {
  if (['entregado', 'cancelado'].includes(p.estado)) return '';

  return `
    <div class="comprobante comprobante--listo" data-comprobante>
      <input type="file" accept="image/*,application/pdf" hidden data-archivo-comprobante>
      ${reciboComprobante(comprobanteRecordado(p.id))}
      <button type="button" class="boton boton--secundario boton--chico"
              data-subir-comprobante>
        Cambiar el comprobante
      </button>
    </div>`;
}

function ficha(p, cfg, modo) {
  const retiro = modo === 'retiro';
  const hayMapa = !retiro && p.entrega?.coordenadas && cfg.origen;

  const domicilio = retiro
    ? `<p class="pedido-ficha__valor">${esc(cfg.direccion)}</p>
       ${lineasDeHorario(cfg.horarios_texto)
           .map(l => `<p class="pedido-ficha__apoyo">${esc(l)}</p>`).join('')}`
    : `<p class="pedido-ficha__valor">${esc(p.entrega?.direccion || '')}</p>
       ${p.entrega?.referencia
         ? `<p class="pedido-ficha__apoyo">${esc(p.entrega.referencia)}</p>` : ''}
       ${p.entrega?.distancia_km
         ? `<p class="pedido-ficha__apoyo">${esc(distancia(p.entrega.distancia_km))} del local</p>` : ''}
       ${p.entrega?.demora_texto
         ? `<p class="pedido-ficha__apoyo">Demora ${esc(p.entrega.demora_texto)}</p>` : ''}`;

  const pago = p.pago?.modo === 'transferencia' ? 'Transferencia' : 'Efectivo';

  return `
    <div class="pedido-ficha">
      <div class="pedido-ficha__parte">
        <h2 class="pedido-ficha__titulo">
          ${icono(retiro ? 'local' : 'camion', { tam: 16 })}
          ${retiro ? 'Lo retirás en' : 'Lo llevamos a'}
        </h2>
        ${domicilio}
      </div>

      ${hayMapa ? '<div class="pedido-ficha__mapa" data-mapa-pedido></div>' : ''}

      <div class="pedido-ficha__parte">
        <h2 class="pedido-ficha__titulo">${icono('bolsa', { tam: 16 })} Cómo pagás</h2>
        <p class="pedido-ficha__valor">${pago}
          <span class="pedido-ficha__apoyo pedido-ficha__apoyo--enlinea">${
            retiro ? 'al retirarlo' : 'al recibirlo'}</span>
        </p>
        ${p.pago?.modo === 'transferencia' && cfg.pago?.alias ? `
          <div class="transferencia__datos pedido-ficha__transferencia">
            <div class="transferencia__dato transferencia__dato--alias">
              <span>Alias</span><b data-alias>${esc(cfg.pago.alias)}</b>
              <button type="button" class="boton boton--secundario boton--chico"
                      data-copiar-alias>Copiar</button>
            </div>
            ${cfg.pago.titular ? `
              <div class="transferencia__dato">
                <span>Titular</span><b>${esc(cfg.pago.titular)}</b>
              </div>` : ''}
          </div>` : ''}
        ${p.pago?.modo === 'transferencia' ? bloqueComprobante(p) : ''}
      </div>

      ${p.nota ? `
        <div class="pedido-ficha__parte">
          <h2 class="pedido-ficha__titulo">${icono('hoja', { tam: 16 })} Tu nota</h2>
          <p class="pedido-ficha__valor pedido-ficha__valor--nota">${esc(p.nota)}</p>
        </div>` : ''}
    </div>`;
}
