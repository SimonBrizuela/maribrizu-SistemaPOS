/**
 * El mapa del repartidor: el local, dónde está él y las paradas numeradas en el
 * orden recomendado.
 *
 * Igual que el mapa del checkout (`src/mapa.js`): el fondo es una imagen de la
 * Maps Static API que sirve la función `mapa` (la clave no viaja al navegador)
 * y los marcadores se dibujan encima con los colores de la marca. El fondo se
 * vuelve a pedir solo si cambian las paradas o el repartidor se sale de lo que
 * se ve; moverse adentro solo corre su punto.
 */
import { vistaQueEntra } from '../mapa.js';
import { icono } from '../iconos.js';
import { esc } from '../formato.js';

const FUNCION = '/.netlify/functions/mapa';
const LADO_MAXIMO = 640;

export function montarMapaRuta(contenedor) {
  let opciones = { local: null, yo: null, paradas: [] };
  let ancho = 0;
  let clave = '';
  let vista = null;

  function puntos() {
    return [opciones.local, opciones.yo, ...opciones.paradas].filter(Boolean);
  }

  function adentro(punto) {
    if (!vista || !punto) return false;
    const { x, y } = vista.enPantalla(punto);
    return x > 3 && x < 97 && y > 8 && y < 97;
  }

  function dibujar({ forzar = false } = {}) {
    const medido = Math.round(contenedor.clientWidth);
    if (medido < 80) return;
    const todos = puntos();
    if (!todos.length) {
      contenedor.innerHTML = '';
      clave = '';
      return;
    }

    const pedidoAncho = Math.min(LADO_MAXIMO, medido);
    const altoCss = parseFloat(getComputedStyle(contenedor).getPropertyValue('--mapa-ruta-alto')) || 260;
    const pedidoAlto = Math.min(LADO_MAXIMO, Math.round(pedidoAncho * altoCss / medido));

    const firma = JSON.stringify([pedidoAncho, pedidoAlto, opciones.local, opciones.paradas.map(p => [p.lat, p.lng])]);
    const hayQueRehacer = forzar || medido !== ancho || firma !== clave || !adentro(opciones.yo);
    if (hayQueRehacer) {
      ancho = medido;
      clave = firma;
      vista = vistaQueEntra(todos, pedidoAncho, pedidoAlto);
      const fondo = `${FUNCION}?lat=${vista.centro.lat.toFixed(6)}&lng=${vista.centro.lng.toFixed(6)}`
        + `&zoom=${vista.zoom}&ancho=${pedidoAncho}&alto=${pedidoAlto}`;
      contenedor.innerHTML = `
        <div class="mapa-ruta" style="height:${altoCss}px">
          <img class="mapa__fondo" data-fondo src="${fondo}" alt="" aria-hidden="true" decoding="async">
          <div data-marcadores></div>
        </div>`;
      contenedor.querySelector('[data-fondo]')
        ?.addEventListener('error', () => { contenedor.innerHTML = ''; clave = ''; });
    }
    pintarMarcadores();
  }

  function pintarMarcadores() {
    const capa = contenedor.querySelector('[data-marcadores]');
    if (!capa || !vista) return;
    const en = (p) => {
      const { x, y } = vista.enPantalla(p);
      return `left:${x.toFixed(3)}%;top:${y.toFixed(3)}%`;
    };
    capa.innerHTML = `
      ${opciones.local ? `
        <span class="mapa__marcador mapa__marcador--local" style="${en(opciones.local)}" title="El local">
          <span class="mapa__globo">${icono('local', { tam: 16, grosor: 2.2 })}</span>
        </span>` : ''}
      ${[...opciones.paradas].reverse().map(p => `
        <button type="button" class="mapa-ruta__parada${p.numero === 1 ? ' mapa-ruta__parada--proxima' : ''}"
                style="${en(p)}" data-ir-a="${esc(p.id)}" aria-label="Parada ${p.numero}">${p.numero}</button>`).join('')}
      ${opciones.yo ? `<span class="mapa-ruta__yo" style="${en(opciones.yo)}" title="Estás acá"></span>` : ''}`;
  }

  // Tocar un número lleva a su tarjeta.
  contenedor.addEventListener('click', (ev) => {
    const boton = ev.target.closest('[data-ir-a]');
    if (!boton) return;
    document.querySelector(`[data-parada="${CSS.escape(boton.dataset.irA)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  const observador = typeof ResizeObserver === 'function' ? new ResizeObserver(() => dibujar()) : null;
  observador?.observe(contenedor);

  return {
    actualizar(cambios) {
      opciones = { ...opciones, ...cambios };
      dibujar();
    },
    soltar() {
      observador?.disconnect();
      contenedor.innerHTML = '';
    },
  };
}
