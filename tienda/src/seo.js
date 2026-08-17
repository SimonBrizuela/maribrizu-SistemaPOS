/**
 * Lo que la tienda le dice a Google y a WhatsApp de cada pantalla.
 *
 * La tienda pinta todo con JavaScript, asi que las etiquetas del `<head>` que
 * dependen de la pantalla (canonical, descripcion, og:url, datos de producto)
 * las pone y las saca esto en cada navegacion. Google ejecuta el JavaScript y
 * las lee; WhatsApp no, por eso lo que tiene que verse al compartir cualquier
 * enlace (nombre del sitio, imagen) va fijo en `index.html`.
 *
 * Todo sale de `location`: la tienda vive hoy en `beta.liceolibreria.com` y va
 * a pasar a la raiz. Nada de aca tiene una direccion escrita, asi que ese dia
 * no hay que tocar nada.
 */
import { pesos, nombreBonito } from './formato.js';

const DESCRIPCION_BASE = 'Comprá online en Librería Liceo. Cuadernos, mercería, juguetería y '
  + 'regalería con envío a domicilio en Córdoba o retiro en Av. Alfonsina Storni 168.';

/**
 * Los hosts que no son la tienda de verdad: el subdominio de prueba, las
 * direcciones de Netlify y la maquina propia. En esos, `noindex`: aparecer en
 * Google con "beta" en la direccion, compitiendo con la raiz, es peor que no
 * aparecer. Cuando la tienda pase a `liceolibreria.com` esto deja de cumplirse
 * solo.
 */
export function esHostDePrueba(host = location.hostname) {
  return host.startsWith('beta.')
      || host.endsWith('.netlify.app')
      || host === 'localhost'
      || host === '127.0.0.1';
}

/** Lo que Google tiene que tomar como direccion de esta pantalla: sin ?q= ni #. */
function canonicalActual() {
  return `${location.origin}${location.pathname}`;
}

function meta(nombreOPropiedad, contenido, { propiedad = false } = {}) {
  const atributo = propiedad ? 'property' : 'name';
  let etiqueta = document.head.querySelector(`meta[${atributo}="${nombreOPropiedad}"]`);
  if (contenido === null || contenido === undefined || contenido === '') {
    etiqueta?.remove();
    return;
  }
  if (!etiqueta) {
    etiqueta = document.createElement('meta');
    etiqueta.setAttribute(atributo, nombreOPropiedad);
    document.head.appendChild(etiqueta);
  }
  etiqueta.setAttribute('content', contenido);
}

function enlace(rel, href) {
  let etiqueta = document.head.querySelector(`link[rel="${rel}"]`);
  if (!href) { etiqueta?.remove(); return; }
  if (!etiqueta) {
    etiqueta = document.createElement('link');
    etiqueta.setAttribute('rel', rel);
    document.head.appendChild(etiqueta);
  }
  etiqueta.setAttribute('href', href);
}

/**
 * Se llama en cada navegacion, antes de pintar la pantalla. Deja canonical,
 * og:url y descripcion generica; la ficha del producto despues pisa la
 * descripcion y agrega sus datos con `fijarProducto`.
 *
 * `privada` es para las pantallas de una sola persona (checkout, pedido,
 * cuenta): esas no se indexan nunca, este el host donde este.
 */
export function fijarPantalla({ privada = false } = {}) {
  const url = canonicalActual();
  enlace('canonical', url);
  meta('og:url', url, { propiedad: true });
  meta('og:title', document.title || 'Librería Liceo · Córdoba', { propiedad: true });
  meta('description', DESCRIPCION_BASE);
  meta('og:description', DESCRIPCION_BASE, { propiedad: true });
  meta('robots', privada || esHostDePrueba() ? 'noindex, nofollow' : null);
  quitarDatosDeProducto();
}

/** El titulo cambia despues de fijarPantalla en varias pantallas: se vuelve a copiar. */
export function fijarTitulo(titulo) {
  document.title = titulo;
  meta('og:title', titulo, { propiedad: true });
}

/* ── La ficha del producto ────────────────────────────────────────────────── */

/**
 * Descripcion propia y datos estructurados de la ficha.
 *
 * Con esto Google puede mostrar el precio y si hay stock directamente en el
 * resultado, y al compartir por WhatsApp sale la foto del producto y no la
 * portada. Se manda solo lo publicable: nombre, marca, rubro, precio, stock,
 * foto. Nada de costo ni proveedor, que no estan en el espejo de todos modos.
 */
export function fijarProducto(p) {
  // Primero se limpia lo de la ficha anterior; lo de esta se pone después.
  quitarDatosDeProducto();

  const partes = [];
  if (p.marca) partes.push(p.marca);
  if (p.categoria || p.rubro) partes.push(nombreBonito(p.categoria || p.rubro));
  const precio = p.unidad === 'metro' ? `${pesos(p.precio)} el metro` : pesos(p.precio);
  const stock = p.stock > 0 ? 'Con stock' : 'Sin stock por ahora';
  const descripcion = `${p.nombre}${partes.length ? ` · ${partes.join(' · ')}` : ''}. ${precio}. ${stock}. `
    + 'Retirá por el local o te lo llevamos en Córdoba.';

  meta('description', descripcion);
  meta('og:description', descripcion, { propiedad: true });
  meta('og:type', 'product', { propiedad: true });
  const foto = p.imagenes?.[0];
  if (foto) {
    meta('og:image', foto, { propiedad: true });
    meta('twitter:image', foto);
  }

  // Todas las fotos, la portada primera: Google toma la primera para el
  // resultado y usa el resto en la ficha enriquecida.
  const fotos = (p.imagenes || []).filter(Boolean);
  const datos = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.nombre,
    ...(fotos.length ? { image: fotos } : {}),
    ...(p.marca ? { brand: { '@type': 'Brand', name: p.marca } } : {}),
    ...(p.categoria || p.rubro ? { category: nombreBonito(p.categoria || p.rubro) } : {}),
    sku: p.id,
    offers: {
      '@type': 'Offer',
      url: canonicalActual(),
      priceCurrency: 'ARS',
      price: Number(p.precio) || 0,
      availability: p.stock > 0
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: 'Librería Liceo' },
    },
  };

  const script = document.createElement('script');
  script.type = 'application/ld+json';
  script.dataset.seoProducto = '1';
  script.textContent = JSON.stringify(datos);
  document.head.appendChild(script);
}

function quitarDatosDeProducto() {
  document.head.querySelector('script[data-seo-producto]')?.remove();
  // Al salir de una ficha vuelven la imagen y el tipo genericos del index.html.
  meta('og:type', 'website', { propiedad: true });
  const portada = 'https://liceolibreria.com/portada.webp';
  meta('og:image', portada, { propiedad: true });
  meta('twitter:image', portada);
}
