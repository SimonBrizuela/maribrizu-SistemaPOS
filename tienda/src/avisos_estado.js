/**
 * Lo que dice la notificación del celular en cada paso del pedido y del reclamo.
 *
 * Lo usan la función que manda los avisos (`netlify/functions/avisar-estado`) y
 * las pruebas, así que no puede depender de Firebase ni del DOM. Los textos van
 * en el mismo tono que la pantalla del pedido: es lo único que el cliente lee de
 * la tienda sin estar en la tienda.
 *
 * Todas las notificaciones de un pedido llevan la misma etiqueta (`tag`): la
 * nueva reemplaza a la anterior y en el celular queda una sola que va avanzando.
 * La imagen de abajo dibuja el recorrido con el paso actual marcado; una página
 * web no puede poner una barra de progreso en la notificación, y así se ve el
 * avance igual.
 */

const TOPE_TITULO = 60;
const TOPE_CUERPO = 160;

const recortar = (texto, tope) => {
  const limpio = String(texto || '').replace(/\s+/g, ' ').trim();
  return limpio.length <= tope ? limpio : `${limpio.slice(0, tope - 1).trimEnd()}…`;
};

/** Los pasos que dibuja la imagen, según cómo recibe el pedido. */
export function pasosDeAviso(modo) {
  const pasos = [
    { clave: 'nuevo', texto: 'Recibido' },
    { clave: 'preparando', texto: 'Preparando' },
    { clave: 'listo', texto: modo === 'envio' ? 'Listo' : 'Para retirar' },
    { clave: 'en_camino', texto: 'En camino' },
    { clave: 'entregado', texto: 'Entregado' },
  ];
  return modo === 'envio' ? pasos : pasos.filter(p => p.clave !== 'en_camino');
}

/** Las rutas de todas las imágenes que puede nombrar un aviso. */
export function imagenesDeAvisos() {
  return ['retiro', 'envio'].flatMap(modo => pasosDeAviso(modo)
    .filter(p => p.clave !== 'nuevo')
    .map(p => `/avisos/${modo}-${p.clave}.png`));
}

/**
 * La notificación de un pedido en su estado actual, o null si ese estado no se
 * avisa (recién entrado: el cliente acaba de verlo en la pantalla).
 *
 * @param {object} pedido  el documento, con `id`
 * @param {{direccionLocal?: string}} [opciones]
 * @returns {{titulo, cuerpo, tag, url, imagen}|null}
 */
export function avisoDeEstado(pedido, { direccionLocal = '' } = {}) {
  if (!pedido?.id) return null;
  const codigo = pedido.codigo || '';
  const modo = pedido.entrega?.modo === 'delivery' ? 'envio' : 'retiro';
  const enEfectivo = pedido.pago?.modo === 'efectivo';

  const textos = {
    preparando: {
      titulo: `Estamos armando tu pedido ${codigo}`,
      cuerpo: 'Te avisamos apenas esté listo.',
    },
    listo: modo === 'retiro'
      ? {
          titulo: `Tu pedido ${codigo} está listo`,
          cuerpo: direccionLocal
            ? `Pasalo a buscar por ${direccionLocal}. Decí tu código al llegar.`
            : 'Pasalo a buscar por el local. Decí tu código al llegar.',
        }
      : {
          titulo: `Tu pedido ${codigo} está listo`,
          cuerpo: 'Sale con el próximo reparto. Te avisamos cuando arranque.',
        },
    en_camino: {
      titulo: `Tu pedido ${codigo} va en camino`,
      cuerpo: enEfectivo
        ? 'Salió para tu dirección. Tené el efectivo a mano.'
        : 'Salió para tu dirección.',
    },
    entregado: {
      titulo: modo === 'retiro' ? `Retiraste tu pedido ${codigo}` : `Entregamos tu pedido ${codigo}`,
      cuerpo: 'Gracias por comprar en Librería Liceo.',
    },
    cancelado: {
      titulo: `Cancelamos tu pedido ${codigo}`,
      cuerpo: 'Si fue un error, escribinos y lo volvemos a cargar.',
    },
  };

  const texto = textos[pedido.estado];
  if (!texto) return null;
  const dibujado = pedido.estado !== 'cancelado'
    && pasosDeAviso(modo).some(p => p.clave === pedido.estado);

  return {
    titulo: recortar(texto.titulo, TOPE_TITULO),
    cuerpo: recortar(texto.cuerpo, TOPE_CUERPO),
    tag: `pedido-${pedido.id}`,
    url: `/pedido/${pedido.id}`,
    imagen: dibujado ? `/avisos/${modo}-${pedido.estado}.png` : null,
  };
}

/**
 * Con qué se anota un paso del reclamo como ya avisado. Lleva el id además del
 * estado: un pedido puede tener un segundo reclamo, y si terminara igual que el
 * primero ("resuelto") no le llegaría nada.
 */
export function claveDeReclamo(reclamo) {
  if (!reclamo?.estado) return null;
  return `${reclamo.id || ''}:${reclamo.estado}`;
}

/**
 * La notificación de un reclamo, o null si ese estado no se avisa (recién
 * creado: lo acaba de mandar el cliente). Va con su propia etiqueta, así no
 * reemplaza el aviso del pedido.
 */
export function avisoDeReclamo(pedido, reclamo) {
  if (!pedido?.id || !reclamo) return null;
  const codigo = pedido.codigo || '';
  const respuesta = String(reclamo.respuesta || '').trim();

  const textos = {
    revisando: {
      titulo: `Estamos revisando tu reclamo del pedido ${codigo}`,
      cuerpo: 'Te escribimos apenas tengamos una respuesta.',
    },
    resuelto: {
      titulo: `Resolvimos tu reclamo del pedido ${codigo}`,
      cuerpo: respuesta || 'Entrá para ver cómo lo solucionamos.',
    },
    rechazado: {
      titulo: `Revisamos tu reclamo del pedido ${codigo}`,
      cuerpo: respuesta || 'Entrá para ver la respuesta.',
    },
  };

  const texto = textos[reclamo.estado];
  if (!texto) return null;
  return {
    titulo: recortar(texto.titulo, TOPE_TITULO),
    cuerpo: recortar(texto.cuerpo, TOPE_CUERPO),
    tag: `reclamo-${pedido.id}`,
    url: `/pedido/${pedido.id}`,
    imagen: null,
  };
}
