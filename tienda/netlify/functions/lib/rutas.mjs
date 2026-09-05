/**
 * La distancia de manejo hasta un domicilio, con la Routes API de Google.
 *
 * Distancia de manejo y no en línea recta: en Córdoba el río y las vías hacen
 * que dos puntos a tres kilómetros estén a siete de recorrido, y el que maneja
 * hace los siete.
 *
 * Vive acá y no dentro de una función porque la usan dos: la cotización que ve
 * el cliente mientras escribe la dirección, y la que rehace el número al crear
 * el pedido. Si cada una midiera a su manera, el pedido podría entrar con un
 * precio de envío distinto del que se le mostró.
 */

export function coordenadaValida(c) {
  return Boolean(c)
    && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng))
    && Math.abs(Number(c.lat)) <= 90 && Math.abs(Number(c.lng)) <= 180;
}

/**
 * Metros de recorrido entre dos puntos, o null si Google no encontró camino
 * (pasa con coordenadas caídas en el medio del campo o del otro lado de un río
 * sin puente).
 */
export async function medirMetros(origen, destino, clave) {
  const respuesta = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': clave,
      // Routes cobra segun los campos que se piden. Pidiendo solo la distancia
      // se queda en el tramo mas barato de la tarifa.
      'X-Goog-FieldMask': 'routes.distanceMeters',
    },
    body: JSON.stringify({
      origin:      { location: { latLng: { latitude: Number(origen.lat),  longitude: Number(origen.lng) } } },
      destination: { location: { latLng: { latitude: Number(destino.lat), longitude: Number(destino.lng) } } },
      travelMode: 'DRIVE',
      // Sin tráfico en vivo: el reparto no sale en el momento, así que el
      // estado del tránsito de ahora no dice nada y encarece la consulta.
      routingPreference: 'TRAFFIC_UNAWARE',
      units: 'METRIC',
      regionCode: 'AR',
    }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`Routes devolvió ${respuesta.status}: ${detalle.slice(0, 300)}`);
  }

  const datos = await respuesta.json();
  const metros = datos?.routes?.[0]?.distanceMeters;
  return Number.isFinite(metros) ? metros : null;
}

/** Los mismos kilómetros que muestra la cotización: dos decimales. */
export function kmDeMetros(metros) {
  return Math.round((metros / 1000) * 100) / 100;
}
