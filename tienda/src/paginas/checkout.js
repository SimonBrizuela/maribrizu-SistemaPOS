/**
 * Checkout.
 *
 * Una sola pantalla, sin pasos: en un pedido de libreria son cuatro datos y
 * partirlos en tres pantallas con "Siguiente" solo agrega lugares donde
 * abandonar. Los bloques van numerados para que se lea el orden sin obligar a
 * recorrerlo de a uno.
 *
 * Lo primero que hace es revalidar el carrito contra la base. Entre que el
 * cliente lo armo y llego aca el local pudo vender, reponer o cambiar precios, y
 * confirmar con los datos viejos genera un pedido que no se puede cumplir.
 */
import { cargarConfig, cargarAvisos, avisoDe } from '../datos.js';
import { pie, vacio } from '../componentes.js';
import { pesos, esc, distancia, lineasDeHorario } from '../formato.js';
import { icono } from '../iconos.js';
import * as carrito from '../carrito.js';
import { avisar } from '../avisos.js';
import { ir } from '../router.js';
import { crearPedido, nuevoIdDePedido } from '../pedidos.js';
import { esComprobanteValido } from '../comprobante.js';
import { estadoDelLocal } from '../horarios.js';
import { datosParaCompletar, recordarDelPedido, sesion } from '../cuenta.js';
import { olvidar } from '../cliente.js';
import { cotizar, rangoDeTramos, llegaAEnvioGratis } from '../envio.js';
import { montarDirecciones } from '../direcciones.js';
import { montarMapa } from '../mapa.js';

/**
 * Despierta las tres funciones del checkout apenas se abre la pantalla.
 *
 * Cada una vive en su propia lambda y la primera llamada de la sesión pagaba
 * el arranque en frío (medido: 2,1 s la cotización fría, 0,4 s caliente), justo
 * cuando el cliente tipeaba su dirección. Avisándoles ahora, se despiertan y
 * dejan su config leída mientras él llena el nombre y el teléfono. Si alguna
 * falla no pasa nada: era solo un aviso, y la llamada de verdad degrada igual
 * que siempre.
 */
function despertarFunciones() {
  const aviso = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"warmup":1}',
  };
  fetch('/.netlify/functions/direcciones', aviso).catch(() => {});
  fetch('/.netlify/functions/envio', aviso).catch(() => {});
  fetch('/.netlify/functions/mapa?warmup=1').catch(() => {});
}

export async function checkout({ montar }) {
  despertarFunciones();
  const cfg = await cargarConfig();
  const avisos = await cargarAvisos();
  document.title = 'Confirmar tu pedido · Librería Liceo';

  if (carrito.estaVacio()) {
    montar(pantallaVacia(cfg));
    return;
  }

  // La revalidacion pega contra la base una vez por producto, asi que se avisa
  // que esta pasando en vez de dejar la pantalla en blanco.
  montar(`
    <div class="contenedor" style="padding-block:var(--e-8)">
      <div class="esqueleto" style="height:28px;width:220px;margin-bottom:var(--e-5)"></div>
      <div class="esqueleto" style="height:120px;margin-bottom:var(--e-4)"></div>
      <div class="esqueleto" style="height:180px"></div>
      <p class="solo-lectores" role="status">Revisando precios y stock</p>
    </div>`);

  const cambios = await carrito.revalidar();

  if (carrito.estaVacio()) {
    montar(pantallaSinStock(cfg));
    return;
  }

  pintarFormulario({ montar, cfg, cambios, avisos });
}

/* ── Pantallas de salida ──────────────────────────────────────────────────── */

function pantallaVacia(cfg) {
  return `
    <div class="contenedor">
      ${vacio({
        titulo: 'Tu pedido está vacío',
        texto: 'Agregá algo al pedido y volvé para confirmarlo.',
        acciones: '<a class="boton boton--primario" href="/catalogo">Ver el catálogo</a>',
      })}
    </div>
    ${pie(cfg)}`;
}

function pantallaSinStock(cfg) {
  return `
    <div class="contenedor">
      ${vacio({
        titulo: 'Nos quedamos sin lo que tenías',
        texto: 'Mientras armabas el pedido se vendió lo último. Escribinos y te avisamos ' +
               'apenas vuelva a entrar.',
        acciones: `
          <a class="boton boton--primario" href="/catalogo">Ver el catálogo</a>
          <a class="boton boton--secundario" href="https://wa.me/${esc(cfg.whatsapp)}"
             target="_blank" rel="noopener">${icono('whatsapp', { tam: 16 })} Consultar</a>`,
      })}
    </div>
    ${pie(cfg)}`;
}

/* ── Formulario ───────────────────────────────────────────────────────────── */

function pintarFormulario({ montar, cfg, cambios, avisos }) {
  const entrega = cfg.entrega || {};

  // Lo que ya sabemos de esta persona: de su cuenta si entró, y si no, de lo
  // que escribió la última vez en este teléfono. Escribir el nombre, el
  // teléfono y la dirección de nuevo en cada pedido es la razón más tonta por
  // la que alguien no vuelve a comprar.
  const conocido = datosParaCompletar();
  const guardadas = conocido?.direcciones || [];
  const hayRetiro = entrega.retiro_habilitado !== false;
  const hayDelivery = entrega.delivery_habilitado !== false;

  // Con el local cerrado el pedido no entra. Se deja ver el checkout entero
  // igual —con el total, el envío y todo— y se traba solo el botón: sacar la
  // pantalla del medio le esconde al cliente lo que ya había armado, y el
  // carrito sobrevive al cierre.
  //
  // Cierra por horario o porque lo cerraron a mano desde el panel; para el
  // cliente es lo mismo, salvo que en el primer caso se le dice cuándo abrimos.
  const estadoLocal = estadoDelLocal(cfg);
  const cerrada = !estadoLocal.abierto;

  // Monto mínimo del pedido. No se esconde el checkout ni se traba el carrito:
  // se muestra cuánto falta, que es lo único accionable. Un cartel que dice
  // "mínimo $6.500" sin decir que faltan $900 obliga a hacer la cuenta.
  const pedidoMinimo = Number(entrega.pedido_minimo) || 0;

  /** @type {'retiro'|'delivery'} */
  let modo = hayRetiro ? 'retiro' : 'delivery';

  // El efectivo se prende y se apaga desde el panel. Apagado, la única forma es
  // la transferencia y el bloque muestra una sola opción, ya elegida: no se le
  // pide al cliente que "elija" entre una cosa sola.
  const hayEfectivo = cfg.pago?.efectivo_habilitado === true;
  let formaPago = hayEfectivo ? 'efectivo' : 'transferencia';

  // Coordenadas del domicilio, cuando el cliente elige una direccion del
  // autocompletado. Sin ellas la cotizacion queda en "a confirmar": no hay
  // forma de medir una distancia contra un texto escrito a mano.
  let destino = null;
  let cotizacion = { estado: 'a_confirmar', precio: 0, km: null };

  // Como se consiguio esa coordenada. Cambia lo que se le dice al cliente: una
  // direccion que eligio de la lista es suya; una que resolvimos nosotros a
  // partir de lo que escribio tiene que poder mirarla antes de confirmar.
  let ubicacion = 'escribiendo';
  let soltarMapa = null;

  const rango = rangoDeTramos(entrega);

  montar(`
    <div class="contenedor checkout">
      <a class="checkout__volver" href="/catalogo">
        ${icono('izquierda', { tam: 16 })} Seguir mirando
      </a>
      <h1 class="checkout__titulo">Confirmá tu pedido</h1>

      ${cambios.length ? avisoDeCambios(cambios) : ''}

      <div class="checkout__grilla">
        <form class="checkout__form" novalidate data-form>

          ${bloque(1, 'Tus datos', `
            ${conocido ? `
              <p class="checkout__conocido">
                ${icono('tilde', { tam: 16 })}
                <span>Hola de nuevo${conocido.nombre ? `, ${esc(conocido.nombre.split(' ')[0])}` : ''}.
                Completamos tus datos.
                <button type="button" data-no-soy-yo>No soy yo</button></span>
              </p>` : ''}
            ${campo({
              id: 'nombre',
              etiqueta: 'Nombre y apellido',
              obligatorio: true,
              valor: conocido?.nombre || '',
              extra: 'autocomplete="name" maxlength="80" placeholder="Como te conocen en el local"',
            })}
            ${campo({
              id: 'telefono',
              etiqueta: 'Teléfono',
              tipo: 'tel',
              obligatorio: true,
              valor: conocido?.telefono || '',
              ayuda: 'Te escribimos por acá si falta algo del pedido.',
              extra: 'autocomplete="tel" inputmode="tel" maxlength="30" placeholder="351 704 6684"',
            })}
          `)}

          ${bloque(2, 'Cómo lo recibís', `
            <div class="opciones" role="radiogroup" aria-label="Forma de entrega">
              ${hayRetiro ? `
                <button type="button" class="opcion" role="radio" data-modo="retiro"
                        aria-checked="${modo === 'retiro'}">
                  <span class="opcion__marca" aria-hidden="true"></span>
                  <span class="opcion__texto">
                    <span class="opcion__titulo">Lo retiro del local</span>
                    <span class="opcion__detalle">
                      ${esc(cfg.direccion)}
                      ${lineasDeHorario(cfg.horarios_texto)
                        .map(l => `<br>${esc(l)}`).join('')}
                    </span>
                  </span>
                  <span class="opcion__precio" style="color:var(--exito)">Sin cargo</span>
                </button>` : ''}

              ${hayDelivery ? `
                <button type="button" class="opcion" role="radio" data-modo="delivery"
                        aria-checked="${modo === 'delivery'}">
                  <span class="opcion__marca" aria-hidden="true"></span>
                  <span class="opcion__texto">
                    <span class="opcion__titulo">Me lo llevan a casa</span>
                    <span class="opcion__detalle">
                      Córdoba, hasta ${entrega.radio_max_km || 12} km del local · demora ${esc(entrega.demora_texto || '24 a 48 hs')}
                    </span>
                  </span>
                  <span class="opcion__precio">${
                    rango
                      ? (rango.min === rango.max ? pesos(rango.min) : `${pesos(rango.min)}–${pesos(rango.max)}`)
                      : 'A confirmar'
                  }</span>
                </button>` : ''}
            </div>

            <div class="checkout__domicilio" data-domicilio hidden>
              ${guardadas.length ? `
                <div class="checkout__guardadas">
                  <span class="campo__label">Tus direcciones</span>
                  <div class="checkout__guardadas-lista">
                    ${guardadas.map((d, i) => `
                      <button type="button" class="checkout__guardada" data-usar-direccion="${i}">
                        ${icono('pin', { tam: 15 })}
                        <span>${esc(d.direccion)}</span>
                      </button>`).join('')}
                  </div>
                </div>` : ''}
              ${campo({
                id: 'direccion',
                etiqueta: 'Dirección',
                obligatorio: true,
                ayuda: 'Calle y altura. Elegí de la lista para que te calculemos el envío exacto.',
                extra: 'autocomplete="street-address" maxlength="120" placeholder="Av. Alfonsina Storni 168"',
              })}
              <p class="direccion-estado" role="status" data-estado hidden></p>
              ${campo({
                id: 'referencia',
                etiqueta: 'Piso, departamento o referencia',
                valor: guardadas[0]?.referencia || '',
                extra: 'maxlength="120" placeholder="Piso 2 depto B · casa con reja verde"',
              })}
              <div data-mapa></div>
            </div>
          `)}

          ${bloque(3, 'Cómo pagás', `
            <div class="opciones" role="radiogroup" aria-label="Forma de pago">
              ${hayEfectivo ? `
              <button type="button" class="opcion" role="radio" data-pago="efectivo" aria-checked="true">
                <span class="opcion__marca" aria-hidden="true"></span>
                <span class="opcion__texto">
                  <span class="opcion__titulo">Efectivo</span>
                  <span class="opcion__detalle" data-detalle-efectivo>Al retirarlo en el local.</span>
                </span>
              </button>` : ''}
              <button type="button" class="opcion" role="radio" data-pago="transferencia"
                      aria-checked="${hayEfectivo ? 'false' : 'true'}">
                <span class="opcion__marca" aria-hidden="true"></span>
                <span class="opcion__texto">
                  <span class="opcion__titulo">Transferencia</span>
                  <span class="opcion__detalle">${
                    cfg.pago?.alias
                      ? `Alias <b class="opcion__alias">${esc(cfg.pago.alias)}</b>${
                          cfg.pago.titular ? ` · ${esc(cfg.pago.titular)}` : ''}`
                      : 'Te pasamos los datos cuando confirmemos el pedido.'
                  }</span>
                </span>
              </button>
            </div>
          `)}

          ${bloque(4, 'Algo para aclarar', `
            ${campo({
              id: 'nota',
              etiqueta: 'Nota para el local',
              tipo: 'textarea',
              ayuda: 'Opcional. Un color preferido, un horario que te sirve, lo que sea.',
              extra: 'maxlength="500" placeholder="Si no hay del azul, mandame del negro."',
            })}
          `)}
        </form>

        <aside class="checkout__resumen" data-resumen></aside>
      </div>
    </div>

    ${pie(cfg)}
  `);

  /* ── Referencias ────────────────────────────────────────────────────────── */

  const form = document.querySelector('[data-form]');
  const cajaDomicilio = document.querySelector('[data-domicilio]');
  const cajaResumen = document.querySelector('[data-resumen]');
  const cajaEstado = document.querySelector('[data-estado]');
  const cajaMapa = document.querySelector('[data-mapa]');

  /* ── Resumen ────────────────────────────────────────────────────────────── */

  function pintarResumen({ enviando = false } = {}) {
    const renglones = carrito.items();
    const subtotal = sumar(renglones);
    const gratis = modo === 'delivery' && llegaAEnvioGratis(subtotal, entrega);
    const envio = modo === 'delivery' && !gratis ? cotizacion.precio : 0;
    // El mínimo se mide contra el total, con el envío adentro: es lo que entra
    // por el pedido. Con retiro en el local, o mientras el envío está a
    // confirmar, el envío es cero y queda medido contra los productos solos.
    const falta = Math.max(0, pedidoMinimo - (subtotal + envio));

    const lineaEnvio = modo === 'retiro'
      ? '<strong style="color:var(--exito)">Sin cargo</strong>'
      : gratis
        ? '<strong class="totales__gratis">Sin cargo</strong>'
        : cotizacion.estado === 'ok'
          ? `<strong class="cifra">${pesos(envio)}</strong>`
          : cotizacion.estado === 'fuera_de_radio'
            ? '<strong style="color:var(--alerta)">Fuera de radio</strong>'
            : '<strong style="color:var(--text-2)">A confirmar</strong>';

    const ahorroDe = r => (r.es_pack ? carrito.ahorroDePack({
      precioSuelto: r.precio_suelto, precioPack: r.precio,
      contenido: r.pack_contenido, cantidad: r.cantidad,
    }) : null);
    const ahorroTotal = renglones.reduce((acc, r) => acc + (ahorroDe(r)?.pesos || 0), 0);

    const nota = modo === 'delivery' && cotizacion.estado === 'a_confirmar'
      ? `<p class="checkout__nota-envio">
           ${icono('atencion', { tam: 15 })}
           <span>Calculamos el envío por la distancia real cuando preparemos el pedido y te lo
           avisamos antes de salir. ${rango
             ? `Hoy va de ${pesos(rango.min)} a ${pesos(rango.max)}.`
             : ''}</span>
         </p>`
      : (modo === 'delivery' && cotizacion.estado === 'ok' && cotizacion.km !== null
          ? `<p class="checkout__nota-envio">${icono('camion', { tam: 15 })}
               <span>${distancia(cotizacion.km)} hasta tu dirección.</span></p>`
          : '');

    // Los avisos de lo que hay en el carrito, sin repetir: si tres artículos de
    // mercería dicen lo mismo, se lee una sola vez. Acá es donde confirma, así
    // que es el último lugar donde puede enterarse a tiempo.
    const avisosDelPedido = [...new Set(
      renglones.map(r => avisoDe(r, avisos)).filter(Boolean)
    )];

    cajaResumen.innerHTML = `
      <div class="checkout__caja">
        <h2 class="checkout__caja-titulo">Tu pedido</h2>

        ${avisosDelPedido.length ? `
          <div class="checkout__avisos">
            ${avisosDelPedido.map(a => `
              <p class="aviso-producto">
                ${icono('atencion', { tam: 16 })}
                <span>${esc(a)}</span>
              </p>`).join('')}
          </div>` : ''}

        <ul class="resumen-items">
          ${renglones.map(r => {
            // Mismo cálculo que en la ficha y en el panel: contra el precio
            // de a uno. Se muestra lo que saldría suelto tachado debajo del
            // precio, y el ahorro en pesos: es donde confirma, y "la plata se
            // explica" quiere decir que pueda rastrear cada número.
            const ahorro = ahorroDe(r);
            const nombreConVariedad = r.variedad ? `${r.nombre} (${r.variedad})` : r.nombre;
            const detalle = r.es_pack
              ? esc(carrito.describirPack(r)) + (ahorro
                  ? ` · <span class="resumen-item__ahorro">Ahorrás ${esc(pesos(ahorro.pesos))} (${ahorro.porcentaje}%)</span>`
                  : '')
              : '';
            return `
            <li class="resumen-item">
              <span class="resumen-item__cantidad cifra">${
                esc(carrito.formatearCantidad(r.cantidad, r.unidad))}</span>
              <span class="resumen-item__nombre">
                ${esc(nombreConVariedad)}
                ${detalle ? `<em>${detalle}</em>` : ''}
              </span>
              <span class="resumen-item__precio cifra">
                ${pesos(r.precio * r.cantidad)}
                ${ahorro ? `<s class="resumen-item__antes">${pesos(r.precio * r.cantidad + ahorro.pesos)}</s>` : ''}
              </span>
            </li>`;
          }).join('')}
        </ul>

        <div class="totales">
          <div class="totales__fila">
            <span>Productos (${renglones.length})</span>
            <strong class="cifra">${pesos(subtotal)}</strong>
          </div>
          <div class="totales__fila">
            <span>Envío</span>
            ${lineaEnvio}
          </div>
          <div class="totales__fila totales__fila--total">
            <span>Total</span>
            <strong class="cifra">${pesos(subtotal + envio)}</strong>
          </div>
          ${ahorroTotal > 0 ? `
          <div class="totales__ahorro">
            <span>Ahorrás llevando en pack</span>
            <strong class="cifra">${pesos(ahorroTotal)}</strong>
          </div>` : ''}
        </div>

        ${nota}

        ${falta > 0 ? `
          <div class="checkout__aviso-minimo">
            Te faltan <strong class="cifra">${pesos(falta)}</strong> para llegar al
            pedido mínimo de <strong class="cifra">${pesos(pedidoMinimo)}</strong>${
              envio > 0 ? ', contando el envío' : ''}.
            <a href="/catalogo">Seguir agregando</a>
          </div>` : ''}

        <button type="button" class="boton boton--primario boton--grande boton--bloque${
                  enviando ? ' boton--cargando' : ''}"
                data-confirmar ${enviando || cerrada || falta > 0 ? 'disabled' : ''}>
          ${cerrada ? 'La tienda está cerrada'
                    : falta > 0 ? `Faltan ${pesos(falta)}`
                    : enviando ? 'Enviando el pedido…' : 'Confirmar el pedido'}
        </button>

        <p class="checkout__legal">
          ${cerrada
            ? (estadoLocal.abre
                ? `Ahora está cerrado, abrimos ${esc(estadoLocal.abre)}. Tu carrito queda
                   guardado: volvé y confirmalo de una.`
                : `Ahora no estamos tomando pedidos. Tu carrito queda guardado:
                   volvé cuando abramos y confirmalo de una.`)
            : `No se cobra nada ahora. El pedido queda reservado y lo pagás
               ${modo === 'retiro' ? 'al retirarlo' : 'al recibirlo'}.`}
        </p>
      </div>`;
  }

  /* ── Entrega ────────────────────────────────────────────────────────────── */

  function cambiarModo(nuevo) {
    modo = nuevo;
    document.querySelectorAll('[data-modo]').forEach(b => {
      b.setAttribute('aria-checked', String(b.dataset.modo === modo));
    });
    cajaDomicilio.hidden = modo !== 'delivery';

    const detalle = document.querySelector('[data-detalle-efectivo]');
    if (detalle) {
      detalle.textContent = modo === 'retiro' ? 'Al retirarlo en el local.' : 'Al recibirlo en tu casa.';
    }

    if (modo === 'delivery') recotizar();
    else pintarResumen();
  }

  async function recotizar() {
    const subtotal = sumar(carrito.items());
    cotizacion = await cotizar(destino, entrega, subtotal);
    pintarResumen();
    pintarDomicilio();
  }

  document.querySelectorAll('[data-modo]').forEach(boton => {
    boton.addEventListener('click', () => cambiarModo(boton.dataset.modo));
  });

  /**
   * El estado de la dirección y el mapa.
   *
   * El mapa aparece recién cuando hay coordenadas, y se rehace en cada
   * cotización para que el cartel de los kilómetros no quede diciendo la
   * distancia de la dirección anterior.
   */
  function pintarDomicilio() {
    soltarMapa?.();
    soltarMapa = null;

    const aviso = AVISOS_DIRECCION[ubicacion];
    cajaEstado.hidden = !aviso;
    if (aviso) {
      cajaEstado.className = `direccion-estado ${aviso.clase}`;
      cajaEstado.innerHTML = `${icono(aviso.icono, { tam: 14, grosor: 2.5 })}<span>${aviso.texto}</span>`;
    }

    if (!destino || !cfg.origen) return;
    soltarMapa = montarMapa(cajaMapa, {
      local: cfg.origen,
      destino,
      direccionLocal: cfg.direccion,
      direccionDestino: valor('direccion'),
      km: cotizacion.estado === 'ok' ? cotizacion.km : null,
    });
  }

  // Al elegir una dirección del desplegable llegan sus coordenadas y se cotiza
  // en el momento. Al volver a escribir se pierden: la dirección dejó de estar
  // verificada y el precio anterior ya no corresponde a lo que dice el campo.
  montarDirecciones(document.getElementById('direccion'), cambio => {
    const antes = destino;
    ubicacion = cambio.estado;
    destino = Number.isFinite(cambio.lat) && Number.isFinite(cambio.lng)
      ? { lat: cambio.lat, lng: cambio.lng }
      : null;

    if (destino || antes) recotizar();
    else pintarDomicilio();
  });

  // Una dirección guardada trae sus coordenadas: se cotiza sin volver a
  // preguntarle nada a Google ni al cliente.
  document.querySelectorAll('[data-usar-direccion]').forEach(boton => {
    boton.addEventListener('click', () => {
      const d = guardadas[Number(boton.dataset.usarDireccion)];
      if (!d) return;

      const campoDireccion = document.getElementById('direccion');
      campoDireccion.value = d.direccion;
      if (d.referencia) document.getElementById('referencia').value = d.referencia;

      ubicacion = Number.isFinite(d.lat) ? 'ubicada' : 'escribiendo';
      destino = Number.isFinite(d.lat) && Number.isFinite(d.lng)
        ? { lat: d.lat, lng: d.lng } : null;
      recotizar();
    });
  });

  document.querySelectorAll('[data-pago]').forEach(boton => {
    boton.addEventListener('click', () => {
      formaPago = boton.dataset.pago;
      document.querySelectorAll('[data-pago]').forEach(otro => {
        otro.setAttribute('aria-checked', String(otro.dataset.pago === formaPago));
      });
    });
  });

  // El error se limpia apenas la persona vuelve a escribir: dejarlo puesto
  // mientras corrige el campo es regañarla por algo que ya esta arreglando.
  form.addEventListener('input', ev => {
    const control = ev.target.closest('.campo__control');
    if (control) limpiarError(control);
  });

  /* ── Confirmar ──────────────────────────────────────────────────────────── */

  cajaResumen.addEventListener('click', ev => {
    if (ev.target.closest('[data-confirmar]')) confirmar();
  });

  document.querySelector('[data-no-soy-yo]')?.addEventListener('click', () => {
    olvidar();
    ['nombre', 'telefono', 'direccion', 'referencia'].forEach(id => {
      const campo = document.getElementById(id);
      if (campo) campo.value = '';
    });
    document.querySelector('.checkout__conocido')?.remove();
    document.querySelector('.checkout__guardadas')?.remove();
    document.getElementById('nombre')?.focus();
  });

  async function confirmar() {
    if (cerrada) {
      avisar(estadoLocal.abre
        ? `Ahora está cerrado. Abrimos ${estadoLocal.abre} y tu carrito queda guardado.`
        : 'Ahora no estamos tomando pedidos. Tu carrito queda guardado.',
        { tipo: 'error', duracion: 6000 });
      return;
    }

    // La misma cuenta que muestra el resumen, con el envío adentro.
    const productos = sumar(carrito.items());
    const gratis = modo === 'delivery' && llegaAEnvioGratis(productos, entrega);
    const conEnvio = productos + (modo === 'delivery' && !gratis ? cotizacion.precio : 0);

    const faltante = pedidoMinimo - conEnvio;
    if (faltante > 0) {
      avisar(`Te faltan ${pesos(faltante)} para llegar al pedido mínimo.`,
             { tipo: 'error', duracion: 6000 });
      return;
    }

    const valores = {
      nombre: valor('nombre'),
      telefono: valor('telefono'),
      direccion: valor('direccion'),
      referencia: valor('referencia'),
      nota: valor('nota'),
    };

    const problemas = validar(valores, modo);
    if (problemas.length) {
      problemas.forEach(p => marcarError(p.campo, p.mensaje));
      const primero = document.getElementById(problemas[0].campo);
      primero?.focus();
      primero?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      avisar('Faltan datos para poder confirmar', { tipo: 'error' });
      return;
    }

    if (modo === 'delivery' && cotizacion.estado === 'fuera_de_radio') {
      avisar('Tu dirección queda fuera del radio de reparto. Podés retirarlo del local.',
             { tipo: 'error', duracion: 6000 });
      return;
    }

    pintarResumen({ enviando: true });

    try {
      // Ultimo control contra la base. Entre que se abrio el checkout y se
      // confirma pueden pasar minutos, y este es el momento en que el pedido se
      // vuelve un compromiso.
      const cambiosTardios = await carrito.revalidar();
      if (carrito.estaVacio()) {
        montar(pantallaSinStock(cfg));
        return;
      }
      if (cambiosTardios.length) {
        pintarResumen();
        document.querySelector('[data-cambios]')?.remove();
        document.querySelector('.checkout__titulo')
          ?.insertAdjacentHTML('afterend', avisoDeCambios(cambiosTardios));
        avisar('Cambió algo de tu pedido, revisalo antes de confirmar', { tipo: 'error', duracion: 7000 });
        return;
      }

      const renglones = carrito.items();
      const subtotal = sumar(renglones);
      const gratis = modo === 'delivery' && llegaAEnvioGratis(subtotal, entrega);
      const envio = modo === 'delivery' && !gratis ? cotizacion.precio : 0;

      const cuentaActual = sesion();

      const payload = {
        cliente: { nombre: valores.nombre, telefono: valores.telefono },
        // Firmado con la cuenta cuando hay una: es lo que después deja pedir
        // "mis pedidos" desde cualquier aparato. Sin cuenta no va el campo, y
        // el pedido entra igual.
        ...(cuentaActual ? { uid: cuentaActual.uid } : {}),
        entrega: {
          modo,
          direccion: modo === 'delivery' ? valores.direccion : null,
          referencia: modo === 'delivery' ? valores.referencia : null,
          coordenadas: modo === 'delivery' ? destino : null,
          distancia_km: modo === 'delivery' ? cotizacion.km : null,
          // Le dice al local que el numero de envio todavia no es definitivo.
          // Sin altura el precio sale del centro de la calle, que puede caer en
          // otro tramo: el pedido entra con el número que se calculó, pero
          // marcado para que el local lo revise antes de salir.
          envio_a_confirmar: modo === 'delivery' && !gratis
            && (cotizacion.estado !== 'ok' || ubicacion === 'falta_altura'),
          demora_texto: entrega.demora_texto || null,
        },
        pago: { modo: formaPago, pagado: false },
        items: renglones.map(r => ({
          id: r.id,
          nombre: r.nombre,
          // La foto viaja adentro del pedido y no se busca despues por id: el
          // pedido es una foto de lo que se compro ese dia, y el producto puede
          // cambiar de imagen o dejar de publicarse. Ademas ahorra una lectura
          // por renglon cada vez que el cliente mira el seguimiento.
          foto: r.foto || null,
          variedad: r.variedad,
          unidad: r.unidad,
          es_pack: r.es_pack,
          pack_contenido: r.pack_contenido,
          pack_nombre: r.pack_nombre || null,
          pack_unidad: r.pack_unidad || 'unidad',
          cantidad: r.cantidad,
          precio: r.precio,
          subtotal: Math.round(r.precio * r.cantidad),
        })),
        subtotal,
        envio,
        nota: valores.nota,
      };

      /** Lo que pasa una vez que el pedido ya se puede crear. */
      const cerrarPedido = async (id = null) => {
        const creado = await crearPedido({ ...payload, id });

        // Los datos quedan guardados recién ahora: a mitad de tipear el nombre
        // es "Ma" y el teléfono tres dígitos, y eso no completa nada la próxima
        // vez. Un pedido confirmado es la señal de que están bien.
        await recordarDelPedido({
          nombre: valores.nombre,
          telefono: valores.telefono,
          direccion: modo === 'delivery' ? valores.direccion : '',
          referencia: modo === 'delivery' ? valores.referencia : '',
          coordenadas: modo === 'delivery' ? destino : null,
        });

        carrito.vaciar();
        ir(`/pedido/${creado.id}`);
      };

      // Con transferencia el pedido no nace acá: primero se le muestran el
      // alias y el total, y nace recién cuando llega el comprobante. Así el
      // local no recibe pedidos a la espera de un pago que quizá no llegue, y
      // el cliente ve el alias en el momento en que lo necesita.
      if (formaPago === 'transferencia') {
        pantallaTransferencia({
          cfg,
          total: subtotal + envio,
          alCrear: cerrarPedido,
        });
        return;
      }

      await cerrarPedido();
    } catch (err) {
      console.error('[checkout] no se pudo crear el pedido:', err);
      pintarResumen();
      avisar('No pudimos enviar el pedido. Probá de nuevo o escribinos por WhatsApp.',
             { tipo: 'error', duracion: 7000 });
    }
  }

  /* ── Pantalla de transferencia ──────────────────────────────────────────
     El último paso: acá está el alias, el monto exacto y el pedido del
     comprobante. El pedido todavía no existe; nace cuando el comprobante
     llega. El id se reserva antes para poder guardar el archivo con el nombre
     del pedido al que va a pertenecer. */
  function pantallaTransferencia({ cfg, total, alCrear }) {
    const id = nuevoIdDePedido();
    const alias = cfg.pago?.alias;
    const titular = cfg.pago?.titular;

    document.title = 'Transferí y mandanos el comprobante · Librería Liceo';
    montar(`
      <div class="contenedor seccion">
        <div class="transferencia">
          <h1 class="transferencia__titulo">Ya casi</h1>
          <p class="transferencia__bajada">
            Transferí <strong>${pesos(total)}</strong> y mandanos el comprobante.
            Con eso queda hecho tu pedido.
          </p>

          <div class="transferencia__datos">
            ${alias ? `
              <div class="transferencia__dato transferencia__dato--alias">
                <span>Alias</span>
                <b data-alias>${esc(alias)}</b>
                <button type="button" class="boton boton--secundario boton--chico"
                        data-copiar-alias>Copiar</button>
              </div>` : `
              <div class="transferencia__dato">
                <span>Alias</span>
                <b>Te lo pasamos por WhatsApp</b>
              </div>`}
            ${titular ? `
              <div class="transferencia__dato">
                <span>A nombre de</span><b>${esc(titular)}</b>
              </div>` : ''}
            <div class="transferencia__dato transferencia__dato--total">
              <span>Total</span><b>${pesos(total)}</b>
            </div>
          </div>

          <p class="transferencia__pedido">
            Si ya transferiste, sacale captura y pasanos el comprobante. ¡Gracias!
          </p>

          <input type="file" accept="image/*,application/pdf" hidden data-archivo>
          <button type="button" class="boton boton--primario boton--grande transferencia__boton"
                  data-adjuntar>
            ${icono('hoja', { tam: 18 })} Subir el comprobante
          </button>
          <p class="transferencia__estado" data-estado></p>

          <p class="transferencia__ayuda">
            ¿Algún problema?
            <a href="https://wa.me/${esc(cfg.whatsapp)}" target="_blank" rel="noopener">
              Escribinos por WhatsApp</a> y lo resolvemos.
          </p>
        </div>
      </div>
      ${pie(cfg)}`);

    const caja = document.querySelector('.transferencia');
    const archivo = caja.querySelector('[data-archivo]');
    const boton = caja.querySelector('[data-adjuntar]');
    const estado = caja.querySelector('[data-estado]');
    const decir = (texto, mal = false) => {
      estado.textContent = texto || '';
      estado.classList.toggle('transferencia__estado--mal', mal);
    };

    caja.querySelector('[data-copiar-alias]')?.addEventListener('click', async ev => {
      try {
        await navigator.clipboard.writeText(alias);
        ev.target.textContent = 'Copiado';
        setTimeout(() => { ev.target.textContent = 'Copiar'; }, 2000);
      } catch { avisar('Copialo a mano: ' + alias, { duracion: 6000 }); }
    });

    boton.addEventListener('click', () => archivo.click());

    archivo.addEventListener('change', async () => {
      const elegido = archivo.files?.[0];
      archivo.value = '';
      if (!elegido) return;

      const problema = esComprobanteValido(elegido);
      if (problema) { decir(problema, true); return; }

      boton.disabled = true;
      boton.classList.add('boton--cargando');
      try {
        const { subirComprobante } = await import('../comprobante.js');
        await subirComprobante(id, elegido, { alProgreso: t => decir(t) });
        decir('Listo, lo recibimos. Armando tu pedido…');
        await alCrear(id);
      } catch (err) {
        console.error('[checkout] comprobante:', err);
        decir(err?.message || 'No se pudo subir. Probá de nuevo.', true);
        boton.disabled = false;
        boton.classList.remove('boton--cargando');
      }
    });
  }

  /* ── Arranque ───────────────────────────────────────────────────────────── */

  cambiarModo(modo);
}

/* ── Piezas ───────────────────────────────────────────────────────────────── */

/**
 * Lo que se le dice al cliente sobre su dirección.
 *
 * Mientras escribe no se dice nada: un cartel que cambia en cada tecla es
 * ruido. Los otros tres estados sí se dicen, porque de esa coordenada sale
 * cuánto paga de envío y tiene derecho a saber de dónde salió.
 *
 * `sin_servicio` no tiene aviso a propósito: que la función no esté desplegada
 * es un problema nuestro, no del cliente, y el resumen ya le dice que el envío
 * se confirma antes de salir.
 */
const AVISOS_DIRECCION = {
  ubicada: {
    clase: 'direccion-estado--ok',
    icono: 'tilde',
    texto: 'Dirección ubicada. El envío sale de la distancia real hasta acá.',
  },
  aproximada: {
    clase: 'direccion-estado--aprox',
    icono: 'atencion',
    texto: 'Ubicamos tu dirección a partir de lo que escribiste. ' +
           'Miralá en el mapa y corregila si no es esa.',
  },
  // Elegir la calle sin el número deja la coordenada en el medio de la cuadra
  // —o de diez cuadras— y de ahí sale lo que paga de envío. Se pide el número
  // en vez de cobrar un precio sacado de un punto que nadie eligió.
  falta_altura: {
    clase: 'direccion-estado--aprox',
    icono: 'atencion',
    texto: 'Falta la altura. Escribí el número de la puerta para que el envío ' +
           'salga exacto.',
  },
  no_ubicada: {
    clase: '',
    icono: 'pin',
    texto: 'No la encontramos en el mapa. El pedido entra igual y el envío ' +
           'te lo confirmamos por teléfono.',
  },
};

function bloque(numero, titulo, contenido) {
  return `
    <section class="checkout__bloque">
      <h2 class="checkout__bloque-titulo">
        <span class="checkout__numero" aria-hidden="true">${numero}</span>
        ${esc(titulo)}
      </h2>
      <div class="checkout__bloque-cuerpo">${contenido}</div>
    </section>`;
}

function campo({ id, etiqueta, tipo = 'text', ayuda = '', obligatorio = false, extra = '',
                valor: inicial = '' }) {
  const control = tipo === 'textarea'
    ? `<textarea class="campo__control" id="${id}" name="${id}" ${extra}>${esc(inicial)}</textarea>`
    : `<input class="campo__control" id="${id}" name="${id}" type="${tipo}" ${extra}
              value="${esc(inicial)}">`;

  return `
    <div class="campo" data-campo="${id}">
      <label class="campo__label" for="${id}" ${obligatorio ? 'data-obligatorio' : ''}>${esc(etiqueta)}</label>
      ${control}
      ${ayuda ? `<span class="campo__ayuda" id="${id}-ayuda">${esc(ayuda)}</span>` : ''}
    </div>`;
}

/**
 * Lo que cambió mientras el cliente armaba el pedido.
 * Se muestra siempre, nunca se corrige en silencio: enterarse de que el precio
 * subió cuando llega el ticket es la peor forma de enterarse.
 */
function avisoDeCambios(cambios) {
  const texto = c => {
    if (c.tipo === 'baja') return `<strong>${esc(c.nombre)}</strong> ya no está disponible y lo sacamos del pedido.`;
    if (c.tipo === 'sin_stock') return `<strong>${esc(c.nombre)}</strong> se quedó sin stock y lo sacamos del pedido.`;
    if (c.tipo === 'menos_stock') return `De <strong>${esc(c.nombre)}</strong> quedaban ${c.ahora}, así que ajustamos la cantidad.`;
    if (c.tipo === 'precio') return `<strong>${esc(c.nombre)}</strong> cambió de ${pesos(c.antes)} a ${pesos(c.ahora)}.`;
    if (c.tipo === 'minimo') return `<strong>${esc(c.nombre)}</strong> se vende desde ${c.ahora}, así que ajustamos la cantidad.`;
    return esc(c.nombre);
  };

  return `
    <div class="checkout__cambios" role="status" data-cambios>
      <h2 class="checkout__cambios-titulo">
        ${icono('atencion', { tam: 18 })} Algo cambió desde que armaste el pedido
      </h2>
      <ul>${cambios.map(c => `<li>${texto(c)}</li>`).join('')}</ul>
    </div>`;
}

/* ── Validación ───────────────────────────────────────────────────────────── */

function valor(id) {
  return (document.getElementById(id)?.value || '').trim();
}

function validar(v, modo) {
  const problemas = [];

  if (v.nombre.length < 2) {
    problemas.push({ campo: 'nombre', mensaje: 'Necesitamos tu nombre para preparar el pedido.' });
  }

  // Las reglas de la base piden entre 6 y 30 caracteres; acá se controla que
  // además tenga números suficientes para ser un teléfono de verdad.
  const digitos = v.telefono.replace(/\D/g, '');
  if (digitos.length < 6) {
    problemas.push({ campo: 'telefono', mensaje: 'Escribí un teléfono donde podamos ubicarte.' });
  } else if (v.telefono.length > 30) {
    problemas.push({ campo: 'telefono', mensaje: 'Ese teléfono es demasiado largo.' });
  }

  if (modo === 'delivery' && v.direccion.length < 6) {
    problemas.push({ campo: 'direccion', mensaje: 'Poné calle y altura para poder llegar.' });
  }

  return problemas;
}

function marcarError(id, mensaje) {
  const caja = document.querySelector(`[data-campo="${id}"]`);
  if (!caja) return;
  caja.classList.add('campo--error');
  caja.querySelector('.campo__error')?.remove();
  caja.insertAdjacentHTML('beforeend', `
    <span class="campo__error" role="alert">
      ${icono('atencion', { tam: 14, grosor: 2.5 })} ${esc(mensaje)}
    </span>`);
  caja.querySelector('.campo__control')?.setAttribute('aria-invalid', 'true');
}

function limpiarError(control) {
  const caja = control.closest('.campo');
  if (!caja?.classList.contains('campo--error')) return;
  caja.classList.remove('campo--error');
  caja.querySelector('.campo__error')?.remove();
  control.removeAttribute('aria-invalid');
}

/**
 * Se redondea cada renglón antes de sumar, no la suma.
 * El total del pedido tiene que dar exactamente subtotal + envío: las reglas de
 * la base lo verifican, y medio metro de una cinta impar deja centavos que
 * hacen fallar esa igualdad.
 */
function sumar(renglones) {
  return renglones.reduce((t, r) => t + Math.round(r.precio * r.cantidad), 0);
}
