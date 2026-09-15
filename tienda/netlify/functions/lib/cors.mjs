/**
 * Quién puede llamar a una función de la tienda desde otro dominio.
 *
 * El panel vive en otro sitio (admin.liceolibreria.com) y le avisa a la tienda
 * cuando cambia un pedido. El navegador solo deja leer la respuesta si la
 * función nombra ese origen. Se nombran uno por uno: con `*` cualquier página
 * podría disparar los avisos desde el navegador de quien la visite.
 *
 * `ORIGENES_PANEL` (separados por coma) suma otros, por si el panel se muda.
 */
const FIJOS = [
  'https://admin.liceolibreria.com',
  // El panel en desarrollo.
  'http://localhost:3000',
];

function permitidos() {
  const extra = String(process.env.ORIGENES_PANEL || '')
    .split(',').map(o => o.trim()).filter(Boolean);
  return new Set([...FIJOS, ...extra]);
}

/** Las cabeceras CORS para esa petición: vacías si el origen no está en la lista. */
export function cabecerasCors(peticion) {
  const origen = peticion.headers.get('origin');
  if (!origen || !permitidos().has(origen)) return {};
  return {
    'Access-Control-Allow-Origin': origen,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

/** Respuesta con las cabeceras CORS puestas. */
export function responder(peticion, cuerpo, status = 200) {
  const headers = cabecerasCors(peticion);
  if (cuerpo === null) return new Response(null, { status, headers });
  return Response.json(cuerpo, { status, headers });
}
