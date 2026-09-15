/**
 * Le abre la sesión al repartidor con su link.
 *
 * Recibe la clave del link y, si es la vigente, devuelve un token de Firebase
 * Auth con el permiso `reparto`. La pantalla lo canjea y con esa sesión las
 * reglas le dejan escuchar en vivo los pedidos con envío, sin usuario ni
 * contraseña. Mover un pedido no pasa por esa sesión: va por `reparto-mover`,
 * que vuelve a mirar la clave cada vez.
 */
import { hayCredenciales, firmarTokenPersonalizado } from './lib/firestore.mjs';
import { RE_CLAVE, verificarClave } from './lib/reparto_acceso.mjs';

export default async (peticion) => {
  if (peticion.method !== 'POST') return Response.json({ error: 'metodo' }, { status: 405 });

  let cuerpo;
  try {
    cuerpo = await peticion.json();
  } catch {
    return Response.json({ error: 'cuerpo' }, { status: 400 });
  }
  if (typeof cuerpo?.clave !== 'string' || !RE_CLAVE.test(cuerpo.clave)) {
    return Response.json({ error: 'clave' }, { status: 400 });
  }
  if (!hayCredenciales()) return Response.json({ error: 'sin_credenciales' }, { status: 501 });

  try {
    const acceso = await verificarClave(cuerpo.clave);
    if (!acceso.ok) return Response.json({ error: 'link' }, { status: 401 });
    const token = await firmarTokenPersonalizado('repartidor', { reparto: true, reparto_version: acceso.version });
    return Response.json({ token });
  } catch (err) {
    console.error('[reparto-sesion]', err);
    return Response.json({ error: 'fallo' }, { status: 502 });
  }
};
