/**
 * Cotizacion del envio.
 *
 * El precio sale de tramos por distancia configurados en `tienda_config`. La
 * distancia real la calcula una funcion del servidor con la Routes API de
 * Google: hacerlo en el navegador obligaria a publicar la clave de Routes, y
 * ademas el precio quedaria a un `precio = 0` de distancia en la consola.
 *
 * Mientras la funcion no este desplegada la tienda no se queda sin checkout:
 * cotiza "a confirmar" y muestra el rango de los tramos, que es lo que el
 * cliente necesita para decidir. El local ajusta el numero final al preparar el
 * pedido, igual que cuando el pedido entra por telefono.
 */

const FUNCION = '/.netlify/functions/envio';

/** Tramos de menor a mayor, saneados. */
function tramos(entrega) {
  return (entrega?.tramos || [])
    .filter(t => Number(t?.hasta_km) > 0 && Number(t?.precio) >= 0)
    .map(t => ({ hasta_km: Number(t.hasta_km), precio: Number(t.precio) }))
    .sort((a, b) => a.hasta_km - b.hasta_km);
}

/** El piso y el techo de la tabla, para decir "entre X e Y" antes de tener la dirección. */
export function rangoDeTramos(entrega) {
  const lista = tramos(entrega);
  if (!lista.length) return null;
  const precios = lista.map(t => t.precio);
  return { min: Math.min(...precios), max: Math.max(...precios) };
}

/**
 * Precio del tramo que le toca a una distancia.
 * Devuelve null si queda fuera de la tabla, que es lo mismo que fuera de radio.
 */
export function precioPorDistancia(km, entrega) {
  const lista = tramos(entrega);
  const tramo = lista.find(t => km <= t.hasta_km);
  return tramo ? tramo.precio : null;
}

/** Los pedidos grandes no pagan envío, cuando el local lo tiene configurado. */
export function llegaAEnvioGratis(subtotal, entrega) {
  const desde = Number(entrega?.envio_gratis_desde) || 0;
  return desde > 0 && subtotal >= desde;
}

/**
 * Cotiza contra el servidor.
 *
 * @param {{lat:number, lng:number}} destino
 * @param {object} entrega  el bloque `entrega` de la config
 * @param {number} subtotal para resolver el envío gratis
 * @returns {Promise<{estado:'ok'|'gratis'|'fuera_de_radio'|'a_confirmar',
 *                    precio:number, km:number|null, motivo?:string}>}
 */
export async function cotizar(destino, entrega, subtotal = 0) {
  if (llegaAEnvioGratis(subtotal, entrega)) {
    return { estado: 'gratis', precio: 0, km: null };
  }

  if (!destino || !Number.isFinite(destino.lat) || !Number.isFinite(destino.lng)) {
    return { estado: 'a_confirmar', precio: 0, km: null, motivo: 'sin_coordenadas' };
  }

  try {
    const respuesta = await fetch(FUNCION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destino }),
    });

    // En desarrollo, y hasta que el sitio de Netlify exista, esto es un 404. No
    // es un error a mostrar: es que todavia no hay servidor.
    if (!respuesta.ok) {
      return { estado: 'a_confirmar', precio: 0, km: null, motivo: `http_${respuesta.status}` };
    }

    const datos = await respuesta.json();
    const km = Number(datos?.km);
    if (!Number.isFinite(km)) {
      return { estado: 'a_confirmar', precio: 0, km: null, motivo: 'respuesta_invalida' };
    }

    const radio = Number(entrega?.radio_max_km) || 0;
    if (radio > 0 && km > radio) {
      return { estado: 'fuera_de_radio', precio: 0, km };
    }

    const precio = precioPorDistancia(km, entrega);
    if (precio === null) return { estado: 'fuera_de_radio', precio: 0, km };

    return { estado: 'ok', precio, km };
  } catch (err) {
    // Sin internet o funcion caida. El pedido tiene que poder entrar igual.
    console.warn('[envio] no se pudo cotizar:', err);
    return { estado: 'a_confirmar', precio: 0, km: null, motivo: 'red' };
  }
}
