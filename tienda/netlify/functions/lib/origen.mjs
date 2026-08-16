/**
 * `https://beta.liceolibreria.com`, `https://liceolibreria.com`, lo que sea
 * que este delante de la funcion. Netlify pasa el host original en
 * `x-forwarded-host`; si no esta, vale el de la URL del pedido.
 *
 * Va en una carpeta aparte y no como `.mjs` suelto: cada archivo suelto de
 * `netlify/functions/` se despliega como una funcion, y esto es solo un helper.
 */
export function origenDe(peticion) {
  const url = new URL(peticion.url);
  const host = peticion.headers.get('x-forwarded-host') || url.host;
  const proto = peticion.headers.get('x-forwarded-proto')
             || url.protocol.replace(':', '')
             || 'https';
  return `${proto}://${host}`;
}
