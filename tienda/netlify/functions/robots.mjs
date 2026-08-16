/**
 * El robots.txt de la tienda.
 *
 * No es un archivo estatico porque tiene que decir la direccion completa del
 * sitemap, y esa cambia cuando la tienda pase de `beta.` a la raiz. Se arma con
 * el host que llego, asi no hay nada que acordarse de cambiar ese dia.
 *
 * No bloquea la tienda mientras esta en beta: para respetar el `noindex` que
 * pone `src/seo.js` en los hosts de prueba, Google tiene que poder entrar a
 * leerlo. Lo unico que se cierra son las pantallas de una sola persona.
 */
import { origenDe } from './lib/origen.mjs';

// Pantallas de una sola persona: no tiene sentido que aparezcan en Google.
const PRIVADAS = ['/checkout', '/pedido/', '/seguimiento', '/cuenta'];

export const config = { path: '/robots.txt' };

export default async (peticion) => {
  const cuerpo = [
    'User-agent: *',
    ...PRIVADAS.map(r => `Disallow: ${r}`),
    '',
    `Sitemap: ${origenDe(peticion)}/sitemap.xml`,
    '',
  ].join('\n');

  return new Response(cuerpo, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
};
