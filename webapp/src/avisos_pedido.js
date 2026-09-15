/**
 * Lo que se le escribe al cliente en cada paso del pedido.
 *
 * Vive aparte de la pantalla porque es la única parte del aviso que se puede
 * romper en silencio: un número mal armado abre WhatsApp con un contacto que no
 * existe, y nadie se entera hasta que el cliente llama preguntando por qué no
 * le avisaron. Acá se puede probar sin abrir el panel.
 *
 * Mandarlo solo, sin que nadie toque nada, necesita la API de WhatsApp de Meta:
 * cuenta de Business, plantilla aprobada y un costo por conversación, porque
 * fuera de las 24 horas de la última respuesta del cliente solo se pueden
 * mandar plantillas. CallMeBot —lo que avisa al local— solo puede escribirle a
 * un número que lo autorizó, así que sirve para el local y no para los
 * clientes. Mientras tanto, el mensaje va escrito y a un toque.
 */
import { whatsappDeTelefono } from '../../tienda/src/telefono.js';

const MENSAJES = {
  preparando: p => `Hola ${nombreCorto(p)}, estamos preparando tu pedido ${p.codigo}. `
                 + 'Te avisamos apenas esté.',

  listo: (p, local) => p?.entrega?.modo === 'delivery'
    ? `Hola ${nombreCorto(p)}, tu pedido ${p.codigo} ya está listo y sale para tu casa.`
    : `Hola ${nombreCorto(p)}, tu pedido ${p.codigo} ya está listo para que lo retires.`
      + (local ? ` Te esperamos en ${local}.` : ''),

  en_camino: p => `Hola ${nombreCorto(p)}, tu pedido ${p.codigo} salió para tu casa. `
                + 'Llega en un rato.',

  entregado: p => `Hola ${nombreCorto(p)}, gracias por tu compra. `
                + 'Cualquier cosa que necesites, escribinos por acá.',

  cancelado: p => `Hola ${nombreCorto(p)}, tuvimos que cancelar tu pedido ${p.codigo}. `
                + 'Cualquier duda, escribinos.',
};

/** Solo el primer nombre: "Hola María Fernanda Gómez" no lo dice nadie. */
export function nombreCorto(pedido) {
  return String(pedido?.cliente?.nombre || '').trim().split(/\s+/)[0] || '';
}

/**
 * El número del cliente, como lo quiere wa.me. La regla vive en
 * `tienda/src/telefono.js`: la usa también la pantalla del repartidor.
 */
export function whatsappDe(pedido) {
  return whatsappDeTelefono(pedido?.cliente?.telefono);
}

/** El enlace a WhatsApp con el mensaje del estado actual, o null si no aplica. */
export function enlaceAviso(pedido, { direccionLocal = '' } = {}) {
  const numero = whatsappDe(pedido);
  const armar = MENSAJES[pedido?.estado];
  if (!numero || !armar) return null;
  return `https://wa.me/${numero}?text=${encodeURIComponent(armar(pedido, direccionLocal))}`;
}

/** El texto suelto, para poder mirarlo sin abrir WhatsApp. */
export function mensajeDe(pedido, { direccionLocal = '' } = {}) {
  const armar = MENSAJES[pedido?.estado];
  return armar ? armar(pedido, direccionLocal) : null;
}
