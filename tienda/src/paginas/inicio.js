import { cargarConfig, cargarRubros, traerDestacados, traerProductos } from '../datos.js';
import { cardProducto, grilla, grillaCargando, pie } from '../componentes.js';
import { franjaMarca, icono, resplandores } from '../iconos.js';
import { esc } from '../formato.js';

/**
 * Mosaico de la portada.
 *
 * Donde una tienda pondria una foto de portada, esta libreria no tiene ninguna.
 * En vez de dejar dos tercios de la pantalla en negro vacio, se usa el recurso
 * grafico de la marca (fichas de color inclinadas sobre negro) diciendo en pocas
 * palabras que se vende. Es lo mismo que hace el logo, y no envejece cuando
 * cambia el catalogo.
 *
 * Las posiciones estan escritas a mano, no generadas al azar: al azar salen
 * choques y huecos, y hay que mirarlo igual para corregirlo.
 */
// Las coordenadas van en porcentaje del alto y ancho del mosaico. Estan
// calculadas para que el conjunto ocupe de 0 a 98 en los dos ejes: la version
// anterior llegaba al 84% a lo ancho y dejaba una franja muerta a la derecha,
// que hacia ver todo el bloque corrido hacia la izquierda.
const MOSAICO = [
  { texto: 'Cuadernos', color: 'violeta', x: 0,  y: 6,  ancho: 46, alto: 44, giro: -4, tam: 1.6 },
  { texto: 'Hilos',     color: 'verde',   x: 52, y: 0,  ancho: 36, alto: 30, giro: 3,  tam: 1.25 },
  { texto: 'Mochilas',  color: 'naranja', x: 56, y: 34, ancho: 42, alto: 34, giro: -3, tam: 1.35 },
  { texto: 'Témperas',  color: 'cyan',    x: 4,  y: 56, ancho: 42, alto: 36, giro: 4,  tam: 1.35 },
  { texto: 'Regalos',   color: 'rojo',    x: 50, y: 72, ancho: 44, alto: 26, giro: -2, tam: 1.25 },
];

function mosaico() {
  const fichas = MOSAICO.map((f, i) => `
    <div class="mosaico__ficha"
         style="left:${f.x}%; top:${f.y}%; width:${f.ancho}%; height:${f.alto}%;
                transform:rotate(${f.giro}deg);
                background:var(--liceo-${f.color});
                color:var(--liceo-${f.color}-tinta);
                font-size:${f.tam}rem;
                animation-delay:${i * 70}ms">${f.texto}</div>`).join('');

  // aria-hidden: para un lector de pantalla son cinco palabras sueltas sin
  // contexto. Lo que hay que leer ya está en el título de al lado.
  return `<div class="mosaico" aria-hidden="true">${fichas}</div>`;
}

/** Una tira de productos de un rubro. */
function tira(rubro, productos) {
  return `
    <section class="tira" data-rubro="${esc(rubro.clave)}">
      <div class="tira__cabecera">
        <span class="tira__marca"></span>
        <h2 class="tira__titulo">${esc(rubro.nombre)}</h2>
        <span class="tira__cuenta">${rubro.cantidad.toLocaleString('es-AR')}</span>
        <a class="tira__ver" href="/catalogo/${encodeURIComponent(rubro.clave)}">Ver todo</a>
      </div>
      <div class="tira__productos">
        ${productos.map((p, i) => cardProducto(p, i, { conRubro: false })).join('')}
      </div>
    </section>`;
}

export async function inicio({ montar }) {
  const cfg = await cargarConfig();

  // La portada se pinta antes de tener productos: no depende de ninguna consulta,
  // así que aparece de inmediato y la primera pantalla nunca está en blanco.
  montar(`
    <section class="marco-oscuro marco-oscuro--vivo">
      ${resplandores()}
      <div class="contenedor" style="padding-block:var(--e-7)">
        <div class="portada__cuerpo">
          <div>
            <p class="portada__lugar">Córdoba · Parque Liceo</p>
            <h1 class="portada__titulo">Todo para el cole, la casa y el regalo</h1>
            <p class="portada__bajada">
              Somos la librería de la esquina, con el catálogo entero en tu celular.
              Te lo llevamos a tu casa o lo pasás a buscar cuando te queda cómodo.
            </p>
            <div class="portada__acciones">
              <a class="boton boton--primario boton--grande" href="/catalogo">
                Ver el catálogo ${icono('derecha', { tam: 18, grosor: 2.5 })}
              </a>
              <a class="boton boton--grande boton--sobre-negro"
                 href="https://maps.google.com/?q=${encodeURIComponent(cfg.direccion)}"
                 target="_blank" rel="noopener">
                ${icono('pin', { tam: 18 })} Cómo llegar
              </a>
            </div>
          </div>
          ${mosaico()}
        </div>
      </div>

      <div class="contenedor" style="padding-bottom:var(--e-7)">
        <div class="rubros" data-rubros>
          ${Array(6).fill('<div class="esqueleto" style="height:76px;border-radius:var(--r-md)"></div>').join('')}
        </div>
      </div>

      ${franjaMarca()}
    </section>

    <div class="contenedor seccion" data-tiras>
      ${grillaCargando(6)}
    </div>

    <section class="marco-oscuro marco-oscuro--vivo">
      ${franjaMarca()}
      ${resplandores()}
      <div class="contenedor">
        <div class="pasos">
          <div style="--paso-color:var(--liceo-violeta)">
            <div class="pasos__numero">01</div>
            <h3>Armás el pedido</h3>
            <p>Buscás lo que necesitás y lo vas cargando. Sin registrarte ni crear una cuenta.</p>
          </div>
          <div style="--paso-color:var(--liceo-cyan)">
            <div class="pasos__numero">02</div>
            <h3>Elegís cómo lo recibís</h3>
            <p>Te lo llevamos a tu casa en Córdoba, o lo pasás a buscar por el local sin costo.</p>
          </div>
          <div style="--paso-color:var(--liceo-verde)">
            <div class="pasos__numero">03</div>
            <h3>Pagás al recibirlo</h3>
            <p>Efectivo o transferencia, cuando el pedido ya está en tus manos. Demora ${esc(cfg.entrega.demora_texto)}.</p>
          </div>
        </div>
      </div>
    </section>

    ${pie(cfg)}
  `);

  const rubros = await cargarRubros();

  const cajaRubros = document.querySelector('[data-rubros]');
  if (cajaRubros) {
    cajaRubros.innerHTML = rubros.map(r => `
      <a class="rubro-ficha" data-rubro="${esc(r.clave)}" href="/catalogo/${encodeURIComponent(r.clave)}">
        <span class="rubro-ficha__nombre">${esc(r.nombre)}</span>
        <span class="rubro-ficha__cuenta">${(r.con_stock ?? r.cantidad).toLocaleString('es-AR')} disponibles</span>
      </a>`).join('');

  // Se muestra lo que se puede comprar hoy, no el total publicado. De los 4.163
  // de Libreria hay stock de 1.024: prometer 4.163 y que el cliente entre a ver
  // una pantalla de agotados es peor que decir 1.024 de entrada.
  }

  const cajaTiras = document.querySelector('[data-tiras]');
  if (!cajaTiras) return;

  const destacados = await traerDestacados(12);

  // Las consultas de todos los rubros salen juntas. En serie serían seis viajes
  // encadenados y la portada tardaría seis veces más en llenarse.
  const conProductos = await Promise.all(
    rubros.map(async r => {
      // Se salta a un punto al azar dentro del rubro. Sin esto cada tira
      // muestra siempre los primeros alfabeticamente, y en Libreria eso son
      // seis abrochadoras seguidas.
      //
      // El salto se limita al tramo que tiene stock (el orden lo pone primero),
      // asi las tiras nunca arrancan con productos agotados. Se restan 6 para
      // no caer al final y volver con menos de los que entran en la fila.
      const tope = Math.max(0, (r.con_stock || r.cantidad) - 6);
      const desde = tope > 0 ? Math.floor(Math.random() * tope) : 0;
      return {
        rubro: r,
        productos: (await traerProductos({ rubro: r.clave, desde, cantidad: 6 })).productos,
      };
    }),
  );

  const partes = [];

  // Los destacados van arriba de todo, cuando existan. Mientras nadie marque
  // ninguno desde el panel, esta sección simplemente no aparece: un título
  // "Lo más pedido" sobre productos elegidos por orden alfabético es mentira, y
  // se nota apenas mirás lo que hay abajo.
  if (destacados.length) {
    partes.push(`
      <section class="tira">
        <div class="tira__cabecera">
          <span class="tira__marca" style="background:var(--liceo-rojo)"></span>
          <h2 class="tira__titulo">Lo más pedido</h2>
          <a class="tira__ver" href="/catalogo" style="color:var(--primary-txt)">Ver todo</a>
        </div>
        <div class="tira__productos">
          ${destacados.map((p, i) => cardProducto(p, i)).join('')}
        </div>
      </section>`);
  }

  partes.push(...conProductos
    .filter(x => x.productos.length)
    .map(x => tira(x.rubro, x.productos)));

  cajaTiras.innerHTML = partes.length
    ? partes.join('')
    : '<p style="color:var(--text-2)">Estamos cargando el catálogo. Volvé en un rato.</p>';
}
