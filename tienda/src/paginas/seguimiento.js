/**
 * Mis pedidos.
 *
 * Las reglas no dejan listar `tienda_pedidos`, y esta bien que sea asi: si se
 * pudiera listar, cualquiera se llevaria el nombre, el telefono y la direccion
 * de todos los clientes. La contra es que no hay forma de preguntar "cuales son
 * mis pedidos" desde el servidor, asi que la lista sale de este navegador.
 *
 * Es suficiente para el caso real: la persona pide desde el celular y vuelve a
 * mirar desde el mismo celular. Para cualquier otro caso esta el codigo y el
 * WhatsApp del local.
 */
import { cargarConfig } from '../datos.js';
import { pie, vacio } from '../componentes.js';
import { pesos, esc } from '../formato.js';
import { icono } from '../iconos.js';
import { misPedidos, pedidosDeLaCuenta } from '../pedidos.js';
import { sesion, iniciarCuenta } from '../cuenta.js';

export async function seguimiento({ montar }) {
  const cfg = await cargarConfig();
  document.title = 'Mis pedidos · Librería Liceo';

  // Con cuenta, la lista sale de la base y vale desde cualquier aparato. Los de
  // este navegador se suman igual: pueden ser de antes de crear la cuenta, o de
  // una compra hecha sin entrar.
  await iniciarCuenta();
  const cuenta = sesion();
  const deLaCuenta = cuenta ? await pedidosDeLaCuenta(cuenta.uid) : [];

  const vistos = new Set(deLaCuenta.map(p => p.id));
  const lista = [...deLaCuenta, ...misPedidos().filter(p => !vistos.has(p.id))]
    .sort((a, b) => (b.cuando || 0) - (a.cuando || 0));

  if (!lista.length) {
    montar(`
      <div class="contenedor">
        ${vacio({
          titulo: 'Todavía no hiciste ningún pedido',
          texto: cuenta
            ? 'Cuando hagas uno va a aparecer acá, con su código y en qué anda.'
            : 'Cuando hagas uno va a aparecer acá, con su código y en qué anda. ' +
              'Si pediste desde otro teléfono, entrá a tu cuenta y los vas a ver todos.',
          acciones: `
            <a class="boton boton--primario" href="/catalogo">Ver el catálogo</a>
            ${cuenta ? '' : '<a class="boton boton--secundario" href="/cuenta">Entrar a mi cuenta</a>'}
            <a class="boton boton--secundario" href="https://wa.me/${esc(cfg.whatsapp)}"
               target="_blank" rel="noopener">${icono('whatsapp', { tam: 16 })} Escribirnos</a>`,
        })}
      </div>
      ${pie(cfg)}`);
    return;
  }

  montar(`
    <div class="contenedor" style="padding-block:var(--e-6)">
      <h1 class="checkout__titulo">Mis pedidos</h1>
      <p style="color:var(--text-2);margin-bottom:var(--e-5)">
        ${cuenta
          ? 'Todos los que hiciste con tu cuenta, desde cualquier teléfono.'
          : `Los que hiciste desde este teléfono.
             <a href="/cuenta">Entrá a tu cuenta</a> para verlos todos.`}
      </p>

      <div class="pedidos-lista">
        ${lista.map(p => `
          <a class="pedido-fila" href="/pedido/${esc(p.id)}">
            <span class="pedido-fila__codigo cifra">${esc(p.codigo || '—')}</span>
            <span class="pedido-fila__datos">
              <span class="pedido-fila__cuando">${esc(cuando(p.cuando))}</span>
              <span class="pedido-fila__modo">${p.modo === 'delivery' ? 'Envío a domicilio' : 'Retiro en el local'}</span>
            </span>
            <span class="pedido-fila__total cifra">${pesos(p.total || 0)}</span>
            <span class="pedido-fila__flecha">${icono('derecha', { tam: 18 })}</span>
          </a>`).join('')}
      </div>
    </div>
    ${pie(cfg)}`);
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
