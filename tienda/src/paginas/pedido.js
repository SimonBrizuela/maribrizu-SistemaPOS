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
import { cargarConfig } from '../datos.js';
import { pie, vacio } from '../componentes.js';
import { pesos, esc, distancia, cuando, haceCuanto, lineasDeHorario } from '../formato.js';
import { icono, franjaMarca } from '../iconos.js';
import { montarMapa } from '../mapa.js';
import { traerPedido, seguirPedido, pasosDe, indiceDeEstado } from '../pedidos.js';

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

  pintar(datos);

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
    if (actualizado) pintar(actualizado);
  });
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
        bajada: 'Salió para tu dirección. Tené el efectivo a mano si pagás así.',
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
          i.es_pack ? `Pack de ${i.pack_contenido}` : '',
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
        ${p.pago?.modo === 'transferencia' && cfg.pago?.alias
          ? `<p class="pedido-ficha__apoyo">Alias <strong>${esc(cfg.pago.alias)}</strong></p>` : ''}
      </div>

      ${p.nota ? `
        <div class="pedido-ficha__parte">
          <h2 class="pedido-ficha__titulo">${icono('hoja', { tam: 16 })} Tu nota</h2>
          <p class="pedido-ficha__valor pedido-ficha__valor--nota">${esc(p.nota)}</p>
        </div>` : ''}
    </div>`;
}
