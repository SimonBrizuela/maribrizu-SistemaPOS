/**
 * El mapa del sitio y el robots.txt, armados al vuelo.
 *
 * La tienda tiene 2.300 fichas de producto que cambian todos los dias (entran,
 * se agotan, se despublican). Un sitemap escrito a mano queda viejo a la
 * semana; uno generado en cada despliegue queda viejo hasta el proximo, y la
 * tienda se despliega cuando hace falta, no todos los dias. Por eso se arma
 * cuando Google lo pide, leyendo el catalogo publicado.
 *
 * Lee `tienda_config/rubros` y `tienda_productos` por la API REST publica, sin
 * credenciales, igual que el asistente: es lo mismo que ve cualquier visitante.
 * Solo se piden los ids y la fecha de sincronizacion, no el documento entero.
 *
 * Las direcciones salen del host que llego (`beta.liceolibreria.com` hoy, la
 * raiz cuando la tienda se mude): no hay nada escrito que haya que acordarse
 * de cambiar ese dia. El robots.txt, que tiene que decir donde esta el sitemap,
 * vive en `robots.mjs` por la misma razon.
 *
 * Mientras la tienda viva en `beta.` no se quiere que Google la indexe: es un
 * subdominio de prueba y aparecer ahi con "beta" en la direccion, compitiendo
 * con la raiz, es peor que no aparecer. Eso lo decide `src/seo.js` poniendo
 * `noindex` cuando el host es de prueba; el sitemap se sirve igual, listo para
 * el dia que deje de serlo.
 */
import { origenDe } from './lib/origen.mjs';

const PROYECTO = 'mari-d7c71';
const BASE_REST = `https://firestore.googleapis.com/v1/projects/${PROYECTO}/databases/(default)/documents`;

// Una hora en la CDN. El catalogo se sincroniza cada seis, asi que estar hasta
// una hora atrasado no cambia nada, y evita releer 2.300 documentos por cada
// rastreo.
const CACHE = 'public, max-age=3600, s-maxage=3600';

export const config = { path: '/sitemap.xml' };

export default async (peticion) => {
  const origen = origenDe(peticion);

  try {
    const [rubros, productos] = await Promise.all([leerRubros(), leerProductos()]);
    return new Response(armarSitemap(origen, rubros, productos), {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': CACHE },
    });
  } catch (err) {
    console.error('[sitemap]', err);
    // Sin catalogo se devuelven al menos las fijas: peor es un 500 que hace
    // que Google deje de pedirlo.
    return new Response(armarSitemap(origen, [], []), {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  }
};

/* ── Firestore ────────────────────────────────────────────────────────────── */

async function leerRubros() {
  const respuesta = await fetch(`${BASE_REST}/tienda_config/rubros`);
  if (!respuesta.ok) return [];
  const doc = await respuesta.json();
  const lista = doc.fields?.lista?.arrayValue?.values || [];
  return lista
    .map(v => v.mapValue?.fields || {})
    .map(f => ({
      clave: f.clave?.stringValue || '',
      cantidad: Number(f.cantidad?.integerValue ?? f.cantidad?.doubleValue ?? 0),
    }))
    .filter(r => r.clave && r.cantidad > 0);
}

/**
 * Todos los ids publicados, de a 1.000 por pagina. Se pide solo `actualizado`
 * con `mask.fieldPaths`: el documento entero trae fotos, tokens y variedades y
 * multiplica por veinte lo que viaja.
 */
async function leerProductos() {
  const productos = [];
  let token = null;

  do {
    const params = new URLSearchParams({ pageSize: '1000' });
    params.append('mask.fieldPaths', 'actualizado');
    if (token) params.set('pageToken', token);

    const respuesta = await fetch(`${BASE_REST}/tienda_productos?${params}`);
    if (!respuesta.ok) throw new Error(`Firestore devolvió ${respuesta.status}`);
    const datos = await respuesta.json();

    for (const doc of datos.documents || []) {
      const id = String(doc.name || '').split('/').pop();
      if (!id) continue;
      const fecha = doc.fields?.actualizado?.timestampValue || doc.updateTime || null;
      productos.push({ id, fecha });
    }
    token = datos.nextPageToken || null;
  } while (token);

  return productos;
}

/* ── El XML ───────────────────────────────────────────────────────────────── */

function armarSitemap(origen, rubros, productos) {
  const hoy = new Date().toISOString().slice(0, 10);

  const fijas = [
    { loc: '/', prioridad: '1.0', frecuencia: 'daily' },
    { loc: '/catalogo', prioridad: '0.9', frecuencia: 'daily' },
  ];

  const deRubros = rubros.map(r => ({
    loc: `/catalogo/${encodeURIComponent(r.clave)}`,
    prioridad: '0.8',
    frecuencia: 'daily',
  }));

  const deProductos = productos.map(p => ({
    loc: `/p/${encodeURIComponent(p.id)}`,
    prioridad: '0.6',
    frecuencia: 'weekly',
    fecha: p.fecha ? String(p.fecha).slice(0, 10) : null,
  }));

  const filas = [...fijas, ...deRubros, ...deProductos].map(u => `
  <url>
    <loc>${escaparXml(origen + u.loc)}</loc>
    <lastmod>${u.fecha || hoy}</lastmod>
    <changefreq>${u.frecuencia}</changefreq>
    <priority>${u.prioridad}</priority>
  </url>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${filas}
</urlset>
`;
}

function escaparXml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
