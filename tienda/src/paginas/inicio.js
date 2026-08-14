import { cargarConfig, cargarRubros, traerDestacados, traerProductos } from '../datos.js';
import { cardProducto, grilla, grillaCargando, pie } from '../componentes.js';
import { franjaMarca, icono, iconoDeRubro, resplandores } from '../iconos.js';
import { esc } from '../formato.js';

// Hasta dónde puede saltar una tira de la portada dentro de su rubro. El sync
// ordena por lo que se vende, así que los primeros treinta son los que valen
// mostrar; más allá empieza la cola larga.
const CABEZA_DE_TIRA = 30;

/**
 * Imagen de la portada.
 *
 * Antes eran fichas de color armadas con CSS, con el nombre de cada rubro
 * escrito adentro. Cumplian mientras no hubo ninguna foto en el catalogo, pero
 * eran cinco rectangulos con texto: decian que se vende sin mostrarlo. La
 * imagen mantiene el mismo recurso grafico de la marca (fichas de color
 * inclinadas sobre negro) y ademas trae los productos de verdad.
 *
 * Va como <img> y no como fondo en CSS para que el navegador la trate como
 * contenido: la descarga con prioridad alta, la puede servir en el tamano que
 * corresponde y no desaparece al imprimir.
 *
 * aria-hidden porque no aporta nada que no diga ya el titulo de al lado. Que un
 * lector de pantalla lea "cuadernos, hilos, mochilas, temperas, regalos"
 * despues del titulo es repetir el menu en desorden.
 */
function ilustracion() {
  return `
    <div class="portada__imagen entra entra--pieza" style="--entra-orden:2" aria-hidden="true">
      <img src="/portada.webp" alt="" width="1200" height="800"
           fetchpriority="high" decoding="async">
    </div>`;
}

/**
 * La misma idea que `ilustracion()` pero para el celular.
 *
 * Son dos imagenes distintas y no la misma escalada: la de escritorio es
 * apaisada y ocupa la mitad derecha de la portada; en una pantalla de 390 px esa
 * proporcion deja una franja de 120 px de alto donde no se distingue nada.
 *
 * Va de fondo de la portada entera y bien difuminada. Nitida detras del texto no
 * se puede: para que el blanco se lea sobre la mochila violeta hace falta un
 * velo tan cargado que apaga la foto. Desenfocada deja de competir —queda como
 * luz de color, no como imagen— y el texto se lee sin pelear con nada.
 *
 * Ademas no le cuesta un pixel de altura a la portada, que es la razon por la
 * que la imagen estaba oculta en el celular: el boton "Ver el catalogo" tiene
 * que entrar en la primera pantalla.
 *
 * El archivo va chico a proposito, 360 px de ancho y 17 kB. Con 26 px de
 * desenfoque el detalle no sobrevive, asi que mandar la version grande seria
 * gastar 86 kB del plan de datos del cliente para que se vean las mismas
 * manchas de color.
 */
function ilustracionMovil() {
  return `
    <div class="portada__fondo entra entra--fondo" aria-hidden="true">
      <img src="/portada-movil.webp"
           srcset="/portada-movil.webp 480w, /portada-movil@2x.webp 960w"
           sizes="100vw" alt="" width="480" height="596"
           fetchpriority="high" decoding="async">
    </div>`;
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
    <section class="marco-oscuro marco-oscuro--vivo portada">
      ${ilustracionMovil()}
      ${resplandores()}
      <div class="contenedor portada__hero" style="padding-block:var(--e-7)">
        <div class="portada__cuerpo">
          <div>
            <p class="portada__lugar entra" style="--entra-orden:0">Córdoba · Parque Liceo</p>
            <h1 class="portada__titulo entra" style="--entra-orden:1">Todo para el cole, la casa y el regalo</h1>
            <p class="portada__bajada entra" style="--entra-orden:2">
              Somos la librería de la esquina, con el catálogo entero en tu celular.
              Te lo llevamos a tu casa o lo pasás a buscar cuando te queda cómodo.
            </p>
            <div class="portada__acciones entra" style="--entra-orden:3">
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
          ${ilustracion()}
        </div>
      </div>

      <div class="contenedor" style="padding-bottom:var(--e-7)">
        <div class="rubros" data-rubros>
          ${Array(6).fill('<div class="esqueleto" style="height:76px;border-radius:var(--r-md)"></div>').join('')}
        </div>
      </div>

      ${franjaMarca({ entra: true })}
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
            <p>${cfg.pago?.efectivo_habilitado === true ? 'Efectivo o transferencia' : 'Por transferencia'
              }, cuando el pedido ya está en tus manos. Demora ${esc(cfg.entrega.demora_texto)}.</p>
          </div>
        </div>
      </div>
    </section>

    ${pie(cfg)}
  `);

  const rubros = await cargarRubros();

  const cajaRubros = document.querySelector('[data-rubros]');
  if (cajaRubros) {
    // Las fichas entran escalonadas igual que el texto de arriba, pero el
    // reloj les arranca acá, cuando se insertan, y no cuando se pintó la
    // portada: llegan después de consultar los rubros y encadenarlas al
    // retraso original las dejaría apareciendo de a una con la consulta ya
    // resuelta.
    cajaRubros.innerHTML = rubros.map((r, i) => `
      <a class="rubro-ficha entra" style="--entra-orden:${i}"
         data-rubro="${esc(r.clave)}" href="/catalogo/${encodeURIComponent(r.clave)}">
        <span class="rubro-ficha__icono">${icono(iconoDeRubro(r.clave), { tam: 20 })}</span>
        <span class="rubro-ficha__texto">
          <span class="rubro-ficha__nombre">${esc(r.nombre)}</span>
          <span class="rubro-ficha__cuenta">${(r.con_stock ?? r.cantidad).toLocaleString('es-AR')} disponibles</span>
        </span>
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
      // Cada tira arranca dentro de lo que más se vende de ese rubro.
      //
      // Antes saltaba a un punto al azar de todo el rubro, porque el catálogo
      // estaba ordenado alfabéticamente y las tiras mostraban seis abrochadoras
      // seguidas. Ahora el sync lo ordena por ventas: saltar lejos sería
      // esconder justo lo que la gente compra.
      //
      // Queda un salto corto, dentro de la cabeza de la lista, para que la
      // portada no sea idéntica en cada visita. El tramo se acota también al
      // stock, así ninguna tira arranca con algo agotado.
      const cabeza = Math.min(CABEZA_DE_TIRA, Math.max(0, (r.con_stock || r.cantidad) - 6));
      const desde = cabeza > 0 ? Math.floor(Math.random() * cabeza) : 0;
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
