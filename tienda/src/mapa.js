/**
 * Mapa chico con el local y el domicilio del cliente.
 *
 * Existe para una sola cosa: que el cliente vea que la direccion que quedo
 * cargada es la suya. El checkout puede resolver por su cuenta lo que escribio
 * a mano, y de esa coordenada sale cuanto paga de envio. Un numero que salio de
 * una direccion que no vio es un numero que no puede discutir; el mapa se la
 * muestra antes de que confirme.
 *
 * El fondo es una imagen de la Maps Static API, servida por
 * `netlify/functions/mapa.mjs` para que la clave no viaje al navegador. Los
 * marcadores los dibuja este archivo encima, con los colores de la marca en vez
 * de los pines rojos de Google: como el centro y el zoom se calculan aca, se
 * sabe exactamente en que pixel cae cada punto.
 *
 * Se probo antes con mosaicos de OpenStreetMap por CARTO, que no necesitan
 * clave. Se descarto: los basemaps de CARTO piden licencia Enterprise para uso
 * comercial y esto es una tienda que vende. Google, en cambio, ya es el
 * proveedor de las direcciones y del calculo de envio, tiene 10.000 mapas por
 * mes sin cargo y esta tienda no se acerca a ese numero.
 *
 * Si la imagen no carga —la API sin habilitar, la funcion sin desplegar, sin
 * internet— el mapa se saca solo y el checkout sigue igual. Es una ayuda para
 * mirar, nunca un requisito para comprar.
 */
import { icono } from './iconos.js';
import { esc, distancia } from './formato.js';

const FUNCION = '/.netlify/functions/mapa';

const TILE = 256;
const ZOOM_MAX = 17;
const ZOOM_MIN = 9;

// Tope de la Static API. Se pide hasta esto y el navegador la estira: con
// `scale=2` llegan 1.280 px reales, de sobra para el ancho del bloque.
const LADO_MAXIMO = 640;

// Aire alrededor de los marcadores para que ninguno quede pegado al borde. Es
// mas arriba que abajo porque el marcador cuelga hacia arriba de su punto.
const AIRE = { arriba: 54, abajo: 26, costado: 40 };

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
    // pedir la misma imagen en cada resize de un pixel es tirar llamadas.
    if (medido < 80 || medido === ancho) return;
    ancho = medido;
    contenedor.innerHTML = pintar(ancho, opciones);

    // Si el fondo no llega, no queda un rectangulo vacio con dos pines
    // flotando: se saca el mapa entero.
    contenedor.querySelector('[data-fondo]')
      ?.addEventListener('error', () => { contenedor.innerHTML = ''; ancho = 0; });
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
  // El alto que se querria, y el tamaño que se le pide de verdad a Google. La
  // proporcion sale del pedido y no al reves, asi la imagen entra exacta y los
  // marcadores caen donde tienen que caer y no medio pixel al costado.
  const altoDeseado = Math.min(280, Math.max(190, ancho * 0.52));
  const pedidoAncho = Math.min(LADO_MAXIMO, Math.round(ancho));
  const pedidoAlto = Math.min(LADO_MAXIMO, Math.round(pedidoAncho * altoDeseado / ancho));
  const alto = Math.round(ancho * pedidoAlto / pedidoAncho);

  const zoom = zoomQueEntra(local, destino, pedidoAncho, pedidoAlto);

  const a = aPixeles(local, zoom);
  const b = aPixeles(destino, zoom);
  const centro = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const centroEnGrados = aGrados(centro, zoom);

  // Esquina superior izquierda de la imagen, en pixeles del mundo a este zoom.
  const origen = { x: centro.x - pedidoAncho / 2, y: centro.y - pedidoAlto / 2 };

  // En porcentaje y no en pixeles: la imagen se pide hasta 640 de ancho y el
  // navegador la estira al ancho real del bloque, asi que los marcadores tienen
  // que estirarse con ella.
  const enPantalla = p => ({
    x: (p.x - origen.x) / pedidoAncho * 100,
    y: (p.y - origen.y) / pedidoAlto * 100,
  });

  const fondo = `${FUNCION}?lat=${centroEnGrados.lat.toFixed(6)}`
              + `&lng=${centroEnGrados.lng.toFixed(6)}`
              + `&zoom=${zoom}&ancho=${pedidoAncho}&alto=${pedidoAlto}`;

  return `
    <figure class="mapa" style="--mapa-alto:${alto}px">
      <div class="mapa__lienzo">
        <img class="mapa__fondo" data-fondo src="${fondo}" alt="" aria-hidden="true"
             width="${pedidoAncho}" height="${pedidoAlto}" decoding="async">
        <svg class="mapa__vinculo" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line x1="${enPantalla(a).x}" y1="${enPantalla(a).y}"
                x2="${enPantalla(b).x}" y2="${enPantalla(b).y}"
                vector-effect="non-scaling-stroke"/>
        </svg>
        ${marcador(enPantalla(b), 'casa', 'destino', direccionDestino || 'Tu dirección')}
        ${marcador(enPantalla(a), 'local', 'local', direccionLocal || 'El local')}
      </div>

      <figcaption class="mapa__pie">
        <span class="mapa__leyenda">
          <i class="mapa__punto mapa__punto--local" aria-hidden="true"></i> El local
          <i class="mapa__punto mapa__punto--destino" aria-hidden="true"></i> Tu dirección
          ${Number.isFinite(km) ? `<span class="mapa__km">${distancia(km)}</span>` : ''}
        </span>
        <a class="mapa__enlace" target="_blank" rel="noopener"
           href="https://www.google.com/maps/dir/?api=1&origin=${local.lat},${local.lng}&destination=${destino.lat},${destino.lng}">
          Cómo llegar
        </a>
      </figcaption>
    </figure>`;
}

function marcador(punto, nombre, tipo, titulo) {
  return `
    <span class="mapa__marcador mapa__marcador--${tipo}"
          style="left:${punto.x.toFixed(3)}%;top:${punto.y.toFixed(3)}%" title="${esc(titulo)}">
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

/** La vuelta: la necesita el `center` que se le manda a Google. */
function aGrados({ x, y }, zoom) {
  const lado = TILE * 2 ** zoom;
  return {
    lng: x / lado * 360 - 180,
    lat: 90 - 360 * Math.atan(Math.exp((y / lado - 0.5) * 2 * Math.PI)) / Math.PI,
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
