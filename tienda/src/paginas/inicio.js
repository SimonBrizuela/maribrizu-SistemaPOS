import { cargarConfig, cargarRubros, traerDestacados, traerProductos } from '../datos.js';
import { grilla, grillaCargando, pie } from '../componentes.js';
import { franjaMarca, icono } from '../iconos.js';
import { esc } from '../formato.js';

export async function inicio({ montar }) {
  const cfg = await cargarConfig();

  // Se pinta la portada antes de tener los productos: el bloque negro con el
  // titulo no depende de ninguna consulta, asi que aparece de inmediato y la
  // primera pantalla no se ve en blanco mientras Firestore responde.
  montar(`
    <section class="marco-oscuro">
      <div class="contenedor" style="padding-block:var(--e-8) var(--e-7)">
        <p class="portada__lugar">Córdoba · Villa Cabrera</p>
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

      <div class="contenedor" style="padding-bottom:var(--e-7)">
        <div class="rubros" data-rubros>
          ${Array(5).fill('<div class="esqueleto" style="height:76px;border-radius:var(--r-md)"></div>').join('')}
        </div>
      </div>

      ${franjaMarca()}
    </section>

    <div class="contenedor seccion">
      <div class="seccion__cabecera">
        <h2>Lo más pedido</h2>
        <a href="/catalogo" style="font-size:var(--t-sm);font-weight:600">Ver todo</a>
      </div>
      <div data-destacados>${grillaCargando(10)}</div>
    </div>

    <div class="contenedor seccion" style="padding-top:0">
      <div class="seccion__cabecera"><h2>Cómo funciona</h2></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:var(--e-5)">
        <div>
          <div style="color:var(--liceo-violeta-txt);margin-bottom:var(--e-2)">${icono('grilla', { tam: 26 })}</div>
          <h3 style="margin-bottom:var(--e-1)">Armás el pedido</h3>
          <p style="color:var(--text-2);font-size:var(--t-sm);line-height:1.6">
            Buscás lo que necesitás y lo vas cargando. Sin registrarte ni crear una cuenta.
          </p>
        </div>
        <div>
          <div style="color:var(--liceo-cyan-txt);margin-bottom:var(--e-2)">${icono('camion', { tam: 26 })}</div>
          <h3 style="margin-bottom:var(--e-1)">Elegís cómo lo recibís</h3>
          <p style="color:var(--text-2);font-size:var(--t-sm);line-height:1.6">
            Te lo llevamos a tu casa en Córdoba, o lo pasás a buscar por el local sin costo.
          </p>
        </div>
        <div>
          <div style="color:var(--liceo-verde-txt);margin-bottom:var(--e-2)">${icono('bolsa', { tam: 26 })}</div>
          <h3 style="margin-bottom:var(--e-1)">Pagás al recibirlo</h3>
          <p style="color:var(--text-2);font-size:var(--t-sm);line-height:1.6">
            Efectivo o transferencia, cuando el pedido ya está en tus manos. Demora ${esc(cfg.entrega.demora_texto)}.
          </p>
        </div>
      </div>
    </div>

    ${pie(cfg)}
  `);

  // Las dos consultas salen juntas: encadenarlas duplicaria la espera sin
  // ningun motivo, porque una no depende de la otra.
  const [rubros, destacados] = await Promise.all([
    cargarRubros(),
    traerDestacados(10),
  ]);

  const cajaRubros = document.querySelector('[data-rubros]');
  if (cajaRubros) {
    cajaRubros.innerHTML = rubros.length
      ? rubros.map(r => `
          <a class="rubro-ficha" data-rubro="${esc(r.clave)}" href="/catalogo/${encodeURIComponent(r.clave)}">
            <span class="rubro-ficha__nombre">${esc(r.nombre)}</span>
            <span class="rubro-ficha__cuenta">${r.cantidad.toLocaleString('es-AR')} productos</span>
          </a>`).join('')
      : '';
  }

  const cajaDestacados = document.querySelector('[data-destacados]');
  if (!cajaDestacados) return;

  // Sin destacados marcados todavia, se muestran los primeros del catalogo: la
  // portada con un hueco se ve peor que la portada con productos cualquiera.
  let lista = destacados;
  if (!lista.length) {
    const { productos } = await traerProductos({ cantidad: 10 });
    lista = productos;
  }

  cajaDestacados.innerHTML = lista.length
    ? grilla(lista)
    : '<p style="color:var(--text-2)">Estamos cargando el catálogo. Volvé en un rato.</p>';
}
