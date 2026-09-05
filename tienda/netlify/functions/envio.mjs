/**
 * Cotizacion del envio.
 *
 * Mide la distancia real de manejo hasta el domicilio con la Routes API y le
 * aplica los tramos de precio configurados en `tienda_config`.
 *
 * Vive en el servidor por dos razones distintas, y las dos importan:
 *
 *   · La clave de Routes no puede restringirse por dominio, porque la llamada
 *     no sale de un navegador. Una clave asi en el bundle publico es una
 *     factura de Google esperando a que alguien la encuentre.
 *   · El precio lo decide el servidor. Del lado del cliente, el envio es un
 *     numero en la memoria del navegador y cualquiera lo pone en cero.
 *
 * La tabla de tramos y la medicion se comparten con `crear-pedido`, que rehace
 * el numero al guardar: si cada una cotizara a su manera, el pedido podria
 * entrar con un envio distinto del que se le mostro al cliente.
 */
import { leerConfigTienda } from './lib/firestore.mjs';
import { coordenadaValida, medirMetros, kmDeMetros } from './lib/rutas.mjs';
import { precioPorDistancia } from '../../src/envio.js';

export default async (peticion) => {
  if (peticion.method !== 'POST') {
    return new Response('Método no permitido', { status: 405 });
  }

  const clave = process.env.GOOGLE_ROUTES_KEY;
  if (!clave) {
    // Sin clave la tienda cotiza "a confirmar" y el pedido entra igual.
    console.warn('[envio] falta GOOGLE_ROUTES_KEY');
    return new Response('Sin clave de Routes', { status: 503 });
  }

  let cuerpo;
  try {
    cuerpo = await peticion.json();
  } catch {
    return new Response('Cuerpo inválido', { status: 400 });
  }

  // Aviso de precalentamiento del checkout: despierta la instancia y deja la
  // config leída, así la cotización de verdad no paga el arranque en frío
  // (medido: 2,1 s fría contra 0,4 s caliente). No llama a Routes.
  if (cuerpo?.warmup) {
    leerConfigTienda().catch(() => {});
    return new Response(null, { status: 204 });
  }

  const destino = cuerpo?.destino;

  if (!coordenadaValida(destino)) {
    return new Response('Destino inválido', { status: 400 });
  }

  let config;
  try {
    config = await leerConfigTienda();
  } catch (err) {
    console.error('[envio] no se pudo leer la configuración:', err);
    return new Response('No se pudo leer la configuración', { status: 502 });
  }

  const origen = config.origen;
  if (!coordenadaValida(origen)) {
    console.error('[envio] la configuración no tiene un origen válido');
    return new Response('Sin origen configurado', { status: 500 });
  }

  let metros;
  try {
    metros = await medirMetros(origen, destino, clave);
  } catch (err) {
    console.error('[envio] Routes falló:', err);
    return new Response('No se pudo medir la distancia', { status: 502 });
  }

  if (metros === null) {
    // Google no encontró camino. Pasa con coordenadas caídas en el medio del
    // campo o del otro lado de un río sin puente.
    return Response.json({ km: null, precio: null, motivo: 'sin_ruta' });
  }

  const km = kmDeMetros(metros);
  const entrega = config.entrega || {};
  const radio = Number(entrega.radio_max_km) || 0;

  if (radio > 0 && km > radio) {
    return Response.json({ km, precio: null, fuera_de_radio: true });
  }

  return Response.json({ km, precio: precioPorDistancia(km, entrega) });
};
