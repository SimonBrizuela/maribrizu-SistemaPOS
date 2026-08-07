/**
 * Mapa chico con el local y el domicilio del cliente.
 *
 * Existe para una sola cosa: que el cliente vea que la direccion que quedo
 * cargada es la suya. El checkout puede resolver por su cuenta lo que escribio
 * a mano, y de esa coordenada sale cuanto paga de envio. Un numero que salio de
 * una direccion que no vio es un numero que no puede discutir; el mapa se la
 * muestra antes de que confirme.
 *
 * Esta escrito a mano en vez de traer Leaflet o la libreria de Maps. Son ~230
 * lineas contra 150 kB de dependencia, y de un mapa que no se arrastra ni hace
 * zoom se usa el 5% de lo que traen esas librerias. Los mosaicos salen de
 * OpenStreetMap por CARTO, que no pide clave: la Maps Static API de Google
 * habria servido igual pero no esta habilitada en el proyecto, y habilitarla
 * significa una llamada facturada por cada vez que alguien abre el checkout.
 *
 * Si los mosaicos no cargan —sin internet, o el servidor de CARTO caido— quedan
 * los dos marcadores sobre el fondo y el enlace a Google Maps. Se ve peor pero
 * sigue diciendo lo que tiene que decir.
 */
import { icono } from './iconos.js';
import { esc, distancia } from './formato.js';

const TILE = 256;
const ZOOM_MAX = 17;
const ZOOM_MIN = 9;
// Aire alrededor de los marcadores para que ninguno quede pegado al borde. Es
// mas arriba que abajo porque el marcador cuelga hacia arriba de su punto.
const AIRE = { arriba: 54, abajo: 26, costado: 40 };

const MOSAICOS = 'https://basemaps.cartocdn.com/light_all';
const CREDITO = '© OpenStreetMap · CARTO';

/**
 * @param {HTMLElement} contenedor  donde se dibuja; se vacia
 * @param {object} opciones
 * @param {{lat:number, lng:number}} opciones.local
 * @param {{lat:number, lng:number}} opciones.destino
 * @param {string} [opciones.direccionLocal]
 * @param {string} [opciones.direccionDestino]
 * @param {number} [opciones.km]  distancia de manejo, si ya se cotizo
 * @returns {() => void} para desenganchar
 */
export function montarMapa(contenedor, opciones) {
  if (!contenedor) return () => {};

  const { local, destino } = opciones;
  if (!esCoordenada(local) || !esCoordenada(destino)) {
    contenedor.innerHTML = '';
    return () => {};
  }

  let ancho = 0;

  function dibujar() {
    const medido = Math.round(contenedor.clientWidth);
    // El primer render puede caer con el contenedor todavia en cero, y volver a
    // pedir los mismos mosaicos en cada resize de un pixel es tirar pedidos.
    if (medido < 80 || medido === ancho) return;
    ancho = medido;
    contenedor.innerHTML = pintar(ancho, opciones);
  }

  dibujar();

  const observador = typeof ResizeObserver === 'function'
    ? new ResizeObserver(dibujar)
    : null;
  if (observador) observador.observe(contenedor);
  else window.addEventListener('resize', dibujar);

  return () => {
    if (observador) observador.disconnect();
    else window.removeEventListener('resize', dibujar);
    contenedor.innerHTML = '';
  };
}

/* ── Dibujo ───────────────────────────────────────────────────────────────── */

function pintar(ancho, { local, destino, direccionLocal, direccionDestino, km }) {
  const alto = Math.round(Math.min(280, Math.max(190, ancho * 0.52)));
  const zoom = zoomQueEntra(local, destino, ancho, alto);

  const a = aPixeles(local, zoom);
  const b = aPixeles(destino, zoom);
  const centro = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

  // Esquina superior izquierda del recorte, en pixeles del mundo a este zoom.
  const origen = { x: centro.x - ancho / 2, y: centro.y - alto / 2 };

  const enPantalla = p => ({ x: Math.round(p.x - origen.x), y: Math.round(p.y - origen.y) });
  const pLocal = enPantalla(a);
  const pDestino = enPantalla(b);

  return `
    <figure class="mapa" style="--mapa-alto:${alto}px">
      <div class="mapa__lienzo">
        ${mosaicos(origen, ancho, alto, zoom)}
        <svg class="mapa__vinculo" width="${ancho}" height="${alto}" aria-hidden="true">
          <line x1="${pLocal.x}" y1="${pLocal.y}" x2="${pDestino.x}" y2="${pDestino.y}"/>
        </svg>
        ${marcador(pDestino, 'casa', 'destino', direccionDestino || 'Tu dirección')}
        ${marcador(pLocal, 'local', 'local', direccionLocal || 'El local')}
      </div>

      <figcaption class="mapa__pie">
        <span class="mapa__leyenda">
          <i class="mapa__punto mapa__punto--local" aria-hidden="true"></i> El local
          <i class="mapa__punto mapa__punto--destino" aria-hidden="true"></i> Tu dirección
          ${Number.isFinite(km) ? `<span class="mapa__km">${distancia(km)}</span>` : ''}
        </span>
        <a class="mapa__enlace" target="_blank" rel="noopener"
           href="https://www.google.com/maps/dir/?api=1&origin=${local.lat},${local.lng}&destination=${destino.lat},${destino.lng}">
          Ver en Google Maps
        </a>
      </figcaption>
      <p class="mapa__credito">${CREDITO}</p>
    </figure>`;
}

function mosaicos(origen, ancho, alto, zoom) {
  const total = 2 ** zoom;
  const desdeX = Math.floor(origen.x / TILE);
  const desdeY = Math.floor(origen.y / TILE);
  const hastaX = Math.floor((origen.x + ancho) / TILE);
  const hastaY = Math.floor((origen.y + alto) / TILE);

  const piezas = [];
  for (let y = desdeY; y <= hastaY; y++) {
    // Arriba del polo norte y abajo del sur no hay mosaico. En Córdoba no pasa,
    // pero pedirlos devolveria 404 y dejaria huecos grises.
    if (y < 0 || y >= total) continue;
    for (let x = desdeX; x <= hastaX; x++) {
      // El mundo da la vuelta en horizontal: el mosaico -1 es el ultimo.
      const xMundo = ((x % total) + total) % total;
      piezas.push(`
        <img class="mapa__mosaico" alt="" aria-hidden="true" decoding="async"
             src="${MOSAICOS}/${zoom}/${xMundo}/${y}.png"
             srcset="${MOSAICOS}/${zoom}/${xMundo}/${y}@2x.png 2x"
             style="left:${Math.round(x * TILE - origen.x)}px;top:${Math.round(y * TILE - origen.y)}px">`);
    }
  }
  return piezas.join('');
}

function marcador(punto, nombre, tipo, titulo) {
  return `
    <span class="mapa__marcador mapa__marcador--${tipo}"
          style="left:${punto.x}px;top:${punto.y}px" title="${esc(titulo)}">
      <span class="mapa__globo">${icono(nombre, { tam: 16, grosor: 2.2 })}</span>
      <span class="solo-lectores">${esc(titulo)}</span>
    </span>`;
}

/* ── Proyeccion ───────────────────────────────────────────────────────────── */

function esCoordenada(c) {
  return !!c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng));
}

/** Web Mercator: de grados a pixeles del mundo entero a ese zoom. */
function aPixeles({ lat, lng }, zoom) {
  const lado = TILE * 2 ** zoom;
  const seno = Math.sin(clamp(Number(lat), -85.05112878, 85.05112878) * Math.PI / 180);
  return {
    x: (Number(lng) + 180) / 360 * lado,
    y: (0.5 - Math.log((1 + seno) / (1 - seno)) / (4 * Math.PI)) * lado,
  };
}

/** El zoom mas cerrado en el que los dos marcadores entran con aire. */
function zoomQueEntra(a, b, ancho, alto) {
  const cabenEn = ancho - AIRE.costado * 2;
  const cabenAlto = alto - AIRE.arriba - AIRE.abajo;

  for (let z = ZOOM_MAX; z > ZOOM_MIN; z--) {
    const pa = aPixeles(a, z);
    const pb = aPixeles(b, z);
    if (Math.abs(pa.x - pb.x) <= cabenEn && Math.abs(pa.y - pb.y) <= cabenAlto) {
      return z;
    }
  }
  return ZOOM_MIN;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
