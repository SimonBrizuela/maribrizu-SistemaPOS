/**
 * Aviso de pedido nuevo al WhatsApp del local.
 *
 * La tienda llama a esta funcion apenas guarda el pedido. No manda el texto del
 * mensaje: manda el id, y la funcion lee el pedido de Firestore y arma el
 * mensaje ella misma. Es la diferencia entre un endpoint publico y un endpoint
 * publico que cualquiera puede usar para mandarle lo que quiera al telefono del
 * dueño.
 *
 * Ademas se rechaza todo pedido de mas de diez minutos, asi que el endpoint no
 * sirve para repetir avisos viejos en loop.
 *
 * El pedido se lee con la API REST de Firestore sin credenciales: las reglas
 * dejan leer un pedido a quien sepa su id, que es justo lo que esta funcion
 * acaba de recibir. Por eso no hace falta meter una cuenta de servicio aca.
 *
 * Proveedores de envio, se usa el que este configurado:
 *
 *   CallMeBot        CALLMEBOT_TELEFONO, CALLMEBOT_APIKEY
 *                    Gratis y se activa en dos minutos: el dueño le manda
 *                    "I allow callmebot to send me messages" al +34 644 51 95 23
 *                    y recibe su apikey. Para arrancar hoy.
 *
 *   WhatsApp Cloud   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_DESTINO,
 *   API (Meta)       WHATSAPP_PLANTILLA
 *                    El camino oficial. Necesita cuenta de Meta Business y una
 *                    plantilla aprobada, porque fuera de la ventana de 24 horas
 *                    solo se pueden mandar plantillas.
 *
 * Sin ninguno configurado devuelve 204 y no rompe nada: el pedido ya esta
 * guardado, y el local igual lo ve por la webapp y por el POS.
 */

const PROYECTO = 'mari-d7c71';
const MINUTOS_DE_GRACIA = 10;

export default async (peticion) => {
  if (peticion.method !== 'POST') {
    return new Response('Método no permitido', { status: 405 });
  }

  let id;
  try {
    ({ id } = await peticion.json());
  } catch {
    return new Response('Cuerpo inválido', { status: 400 });
  }

  // Los ids de Firestore son veinte caracteres alfanuméricos. Cualquier otra
  // cosa no llega a tocar la base.
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{15,40}$/.test(id)) {
    return new Response('Id inválido', { status: 400 });
  }

  let pedido;
  try {
    pedido = await leerPedido(id);
  } catch (err) {
    console.error('[avisar-pedido] no se pudo leer el pedido:', err);
    return new Response('No se pudo leer el pedido', { status: 502 });
  }

  if (!pedido) return new Response('No existe', { status: 404 });

  const antiguedad = Date.now() - new Date(pedido.creado).getTime();
  if (!(antiguedad >= 0) || antiguedad > MINUTOS_DE_GRACIA * 60_000) {
    return new Response('Pedido fuera de plazo', { status: 409 });
  }

  const mensaje = armarMensaje(pedido);

  try {
    const enviado = await enviar(mensaje);
    if (!enviado) return new Response(null, { status: 204 });
    return Response.json({ avisado: true });
  } catch (err) {
    // El aviso es un extra. Si falla, el pedido ya esta guardado y el local lo
    // ve igual por la webapp: no tiene sentido devolverle un error al cliente
    // que acaba de comprar.
    console.error('[avisar-pedido] no se pudo enviar:', err);
    return new Response(null, { status: 204 });
  }
};

/* ── Leer el pedido ───────────────────────────────────────────────────────── */

async function leerPedido(id) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROYECTO}` +
              `/databases/(default)/documents/tienda_pedidos/${id}`;
  const respuesta = await fetch(url);
  if (respuesta.status === 404 || respuesta.status === 403) return null;
  if (!respuesta.ok) throw new Error(`Firestore devolvió ${respuesta.status}`);

  const crudo = await respuesta.json();
  return aplanar(crudo.fields || {});
}

/**
 * La API REST devuelve cada valor envuelto en su tipo
 * (`{stringValue: "..."}`), asi que hay que desenvolverlo para poder usarlo.
 */
function aplanar(campos) {
  const salida = {};
  for (const [clave, valor] of Object.entries(campos)) {
    salida[clave] = valorDe(valor);
  }
  return salida;
}

function valorDe(v) {
  if (v == null) return null;
  if ('stringValue'    in v) return v.stringValue;
  if ('integerValue'   in v) return Number(v.integerValue);
  if ('doubleValue'    in v) return Number(v.doubleValue);
  if ('booleanValue'   in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue'      in v) return null;
  if ('mapValue'       in v) return aplanar(v.mapValue.fields || {});
  if ('arrayValue'     in v) return (v.arrayValue.values || []).map(valorDe);
  return null;
}

/* ── Mensaje ──────────────────────────────────────────────────────────────── */

function pesos(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}

function armarMensaje(p) {
  const entrega = p.entrega || {};
  const cliente = p.cliente || {};

  const renglones = (p.items || []).map(i => {
    const cantidad = i.unidad === 'metro'
      ? `${Number(i.cantidad).toFixed(1).replace('.', ',')} m`
      : `${Math.round(i.cantidad)}x`;
    const variedad = i.variedad ? ` (${i.variedad})` : '';
    return `• ${cantidad} ${i.nombre}${variedad} — ${pesos(i.subtotal)}`;
  });

  const destino = entrega.modo === 'delivery'
    ? `Envío a ${entrega.direccion || 'dirección sin cargar'}` +
      (entrega.referencia ? ` (${entrega.referencia})` : '')
    : 'Retira en el local';

  const envio = entrega.modo === 'delivery'
    ? (entrega.envio_a_confirmar ? 'Envío: a confirmar' : `Envío: ${pesos(p.envio)}`)
    : 'Sin envío';

  return [
    `PEDIDO NUEVO ${p.codigo || ''}`,
    '',
    `${cliente.nombre || 'Sin nombre'} · ${cliente.telefono || 'sin teléfono'}`,
    destino,
    '',
    ...renglones,
    '',
    `Productos: ${pesos(p.subtotal)}`,
    envio,
    `TOTAL: ${pesos(p.total)}`,
    `Paga con ${p.pago?.modo === 'transferencia' ? 'transferencia' : 'efectivo'}`,
    p.nota ? `\nNota: ${p.nota}` : '',
  ].join('\n').trim();
}

/* ── Envío ────────────────────────────────────────────────────────────────── */

async function enviar(mensaje) {
  const { CALLMEBOT_TELEFONO, CALLMEBOT_APIKEY,
          WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_DESTINO,
          WHATSAPP_PLANTILLA } = process.env;

  if (WHATSAPP_TOKEN && WHATSAPP_PHONE_ID && WHATSAPP_DESTINO) {
    await porCloudApi({
      token: WHATSAPP_TOKEN,
      telefonoId: WHATSAPP_PHONE_ID,
      destino: WHATSAPP_DESTINO,
      plantilla: WHATSAPP_PLANTILLA,
      mensaje,
    });
    return true;
  }

  if (CALLMEBOT_TELEFONO && CALLMEBOT_APIKEY) {
    await porCallMeBot({ telefono: CALLMEBOT_TELEFONO, apikey: CALLMEBOT_APIKEY, mensaje });
    return true;
  }

  console.warn('[avisar-pedido] no hay proveedor de WhatsApp configurado');
  return false;
}

async function porCallMeBot({ telefono, apikey, mensaje }) {
  const url = 'https://api.callmebot.com/whatsapp.php'
            + `?phone=${encodeURIComponent(telefono)}`
            + `&text=${encodeURIComponent(mensaje)}`
            + `&apikey=${encodeURIComponent(apikey)}`;
  const respuesta = await fetch(url);
  if (!respuesta.ok) throw new Error(`CallMeBot devolvió ${respuesta.status}`);
}

/**
 * Fuera de la ventana de 24 horas Meta solo deja mandar plantillas aprobadas,
 * y un pedido casi siempre cae fuera de esa ventana. Por eso, si hay plantilla
 * configurada se usa esa; el texto libre queda para cuando la conversación está
 * abierta.
 */
async function porCloudApi({ token, telefonoId, destino, plantilla, mensaje }) {
  const cuerpo = plantilla
    ? {
        messaging_product: 'whatsapp',
        to: destino,
        type: 'template',
        template: {
          name: plantilla,
          language: { code: 'es_AR' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: mensaje.slice(0, 1024) }] }],
        },
      }
    : {
        messaging_product: 'whatsapp',
        to: destino,
        type: 'text',
        text: { body: mensaje },
      };

  const respuesta = await fetch(`https://graph.facebook.com/v21.0/${telefonoId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cuerpo),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`Cloud API devolvió ${respuesta.status}: ${detalle.slice(0, 300)}`);
  }
}
