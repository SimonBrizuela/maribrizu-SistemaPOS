/**
 * Lo que la pantalla del repartidor pide afuera, además de la sesión: mover un
 * pedido (función `reparto-mover`) y seguir la ubicación del celular.
 */

/**
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function mover(clave, pedido, estado, { cobrado = null, foto = null } = {}) {
  try {
    const respuesta = await fetch('/.netlify/functions/reparto-mover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clave, pedido, estado, cobrado, foto }),
    });
    if (respuesta.ok) return { ok: true };
    if (respuesta.status === 401) return { ok: false, error: 'link' };
    const cuerpo = await respuesta.json().catch(() => ({}));
    return { ok: false, error: cuerpo?.error || 'red' };
  } catch {
    return { ok: false, error: 'red' };
  }
}

export const ubicacion = {
  /** 'granted' | 'prompt' | 'denied' | 'no_disponible' */
  async permiso() {
    if (!navigator.geolocation) return 'no_disponible';
    try {
      const estado = await navigator.permissions?.query({ name: 'geolocation' });
      return estado?.state || 'prompt';
    } catch {
      // Safari no deja preguntar por este permiso: se ofrece el botón.
      return 'prompt';
    }
  },

  seguir(alMover, alFallar) {
    const id = navigator.geolocation.watchPosition(
      (posicion) => alMover({ lat: posicion.coords.latitude, lng: posicion.coords.longitude }),
      alFallar,
      // Una posición de hace 15 segundos sirve: en moto no cambia tanto la
      // recomendación, y pedirla siempre fresca gasta batería.
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  },
};
