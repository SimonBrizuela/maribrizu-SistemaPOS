/**
 * Mis pedidos.
 *
 * Las reglas no dejan listar `tienda_pedidos`, y esta bien que sea asi: si se
 * pudiera listar, cualquiera se llevaria el nombre, el telefono y la direccion
 * de todos los clientes. La contra es que no hay forma de preguntar "cuales son
 * mis pedidos" desde el servidor sin cuenta, asi que la lista sale de este
 * navegador y, si hay sesion, se completa con los de la base.
 *
 * ## Por que pinta antes de tener todo
 *
 * Los pedidos de este telefono ya estan en el aparato: son cuatro renglones en
 * localStorage y se leen en un microsegundo. Lo que tarda es lo otro —el SDK de
 * Auth son 40 kB que se bajan recien la primera vez, y la consulta a Firestore
 * es un viaje a la red—, y antes la pantalla esperaba a las dos cosas para
 * recien ahi pintar. Tocabas "Mis pedidos" y no pasaba nada por un segundo
 * largo, que es exactamente lo que se siente como que el boton no anduvo.
 *
 * Ahora se pinta primero con lo que hay en el telefono y lo de la cuenta entra
 * despues, encima. En el caso normal —la persona pide y vuelve a mirar desde el
 * mismo celular— la lista de arranque ya es la definitiva y no se mueve nada.
 */
import { cargarConfig, configEnCache } from '../datos.js';
import { pie, vacio } from '../componentes.js';
import { pesos, esc } from '../formato.js';
import { icono } from '../iconos.js';
import { misPedidos, pedidosDeLaCuenta } from '../pedidos.js';
import { sesion, iniciarCuenta } from '../cuenta.js';

const CAMINO = '/seguimiento';

export async function seguimiento({ montar }) {
  document.title = 'Mis pedidos · Librería Liceo';

  const locales = misPedidos();

  // Primer pintado, sin esperar nada.
  montar(pantalla(locales, { cfg: configEnCache(), cuenta: null, buscando: true }));

  // El pie necesita la config. Casi siempre ya está en memoria y esto resuelve
  // en el acto; solo cuesta un viaje si alguien entró directo a esta dirección.
  const cfg = await cargarConfig();
  if (!sigueAca()) return;
  const cajaPie = document.querySelector('[data-pie]');
  if (cajaPie && !cajaPie.innerHTML) cajaPie.innerHTML = pie(cfg);

  await iniciarCuenta();
  if (!sigueAca()) return;

  const cuenta = sesion();
  const deLaCuenta = cuenta ? await pedidosDeLaCuenta(cuenta.uid) : [];
  if (!sigueAca()) return;

  const vistos = new Set(deLaCuenta.map(p => p.id));
  const todos = [...deLaCuenta, ...locales.filter(p => !vistos.has(p.id))]
    .sort((a, b) => (b.cuando || 0) - (a.cuando || 0));

  // Si la cuenta no agregó nada solo se apaga el cartelito de "buscando": no
  // hay por qué repintar una lista que ya está bien.
  if (todos.length === locales.length) {
    document.querySelector('[data-buscando]')?.remove();
    actualizarBajada(cuenta);
    return;
  }

  montar(pantalla(todos, { cfg, cuenta, buscando: false }));
}

/** Si el cliente ya se fue a otra pantalla, lo que llega tarde no se pinta. */
function sigueAca() {
  return location.pathname === CAMINO;
}

function actualizarBajada(cuenta) {
  const bajada = document.querySelector('[data-bajada]');
  if (bajada && cuenta) {
    bajada.textContent = 'Todos los que hiciste con tu cuenta, desde cualquier teléfono.';
  }
}

function pantalla(lista, { cfg, cuenta, buscando }) {
  const cuerpo = lista.length
    ? conPedidos(lista, { cuenta, buscando })
    : sinPedidos({ cfg, cuenta, buscando });

  return `
    <div class="contenedor" style="padding-block:var(--e-6)">${cuerpo}</div>
    <div data-pie>${cfg ? pie(cfg) : ''}</div>`;
}

function conPedidos(lista, { cuenta, buscando }) {
  return `
    <h1 class="checkout__titulo">Mis pedidos</h1>
    <p data-bajada style="color:var(--text-2);margin-bottom:var(--e-5)">
      ${cuenta
        ? 'Todos los que hiciste con tu cuenta, desde cualquier teléfono.'
        : `Los que hiciste desde este teléfono.
           <a href="/cuenta">Entrá a tu cuenta</a> para verlos todos.`}
    </p>

    <div class="pedidos-lista">
      ${lista.map(fila).join('')}
      ${buscando ? cargando() : ''}
    </div>`;
}

/**
 * Mientras se pregunta por los de la cuenta.
 *
 * Es un renglón más al pie de la lista, no una pantalla de espera: lo que ya
 * está se lee mientras tanto, que es todo el punto.
 */
function cargando() {
  return `
    <div class="pedidos-buscando" data-buscando role="status">
      <span class="pedidos-buscando__punto"></span>
      Buscando los de tu cuenta
    </div>`;
}

function fila(p) {
  return `
    <a class="pedido-fila" href="/pedido/${esc(p.id)}">
      <span class="pedido-fila__codigo cifra">${esc(p.codigo || '—')}</span>
      <span class="pedido-fila__datos">
        <span class="pedido-fila__cuando">${esc(cuando(p.cuando))}</span>
        <span class="pedido-fila__modo">${
          p.modo === 'delivery' ? 'Envío a domicilio' : 'Retiro en el local'}</span>
      </span>
      <span class="pedido-fila__total cifra">${pesos(p.total || 0)}</span>
      <span class="pedido-fila__flecha">${icono('derecha', { tam: 18 })}</span>
    </a>`;
}

function sinPedidos({ cfg, cuenta, buscando }) {
  // Mientras se busca no se dice "no hiciste ninguno": puede haberlos en la
  // cuenta y desmentirse solo un segundo después queda pésimo.
  if (buscando) {
    return `
      <h1 class="checkout__titulo">Mis pedidos</h1>
      <div class="pedidos-lista">${cargando()}</div>`;
  }

  return vacio({
    titulo: 'Todavía no hiciste ningún pedido',
    texto: cuenta
      ? 'Cuando hagas uno va a aparecer acá, con su código y en qué anda.'
      : 'Cuando hagas uno va a aparecer acá, con su código y en qué anda. ' +
        'Si pediste desde otro teléfono, entrá a tu cuenta y los vas a ver todos.',
    acciones: `
      <a class="boton boton--primario" href="/catalogo">Ver el catálogo</a>
      ${cuenta ? '' : '<a class="boton boton--secundario" href="/cuenta">Entrar a mi cuenta</a>'}
      ${cfg ? `<a class="boton boton--secundario" href="https://wa.me/${esc(cfg.whatsapp)}"
         target="_blank" rel="noopener">${icono('whatsapp', { tam: 16 })} Escribirnos</a>` : ''}`,
  });
}

/** "Hoy 14:30" · "Ayer 09:12" · "12 de agosto" */
function cuando(marca) {
  if (!marca) return '';
  const fecha = new Date(marca);
  if (Number.isNaN(fecha.getTime())) return '';

  const hoy = new Date();
  const mismoDia = (a, b) => a.toDateString() === b.toDateString();
  const ayer = new Date(hoy);
  ayer.setDate(hoy.getDate() - 1);

  const hora = fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  if (mismoDia(fecha, hoy)) return `Hoy ${hora}`;
  if (mismoDia(fecha, ayer)) return `Ayer ${hora}`;
  return fecha.toLocaleDateString('es-AR', { day: 'numeric', month: 'long' });
}
