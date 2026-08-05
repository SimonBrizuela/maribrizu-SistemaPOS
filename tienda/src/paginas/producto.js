import { cargarConfig, traerProducto, traerProductos } from '../datos.js';
import { grilla, pie, vacio } from '../componentes.js';
import { pesos, esc, nombreBonito, colorDeVariedad } from '../formato.js';
import { icono } from '../iconos.js';
import * as carrito from '../carrito.js';
import { avisar } from '../avisos.js';
import { abrir as abrirCarrito } from '../panel_carrito.js';

export async function producto({ montar, params }) {
  const cfg = await cargarConfig();
  const p = await traerProducto(params.id);

  if (!p) {
    montar(`
      <div class="contenedor">
        ${vacio({
          titulo: 'No encontramos este producto',
          texto: 'Puede que lo hayamos sacado del catálogo o que el enlace esté cortado.',
          acciones: '<a class="boton boton--primario" href="/catalogo">Ver el catálogo</a>',
        })}
      </div>
      ${pie(cfg)}`);
    return;
  }

  document.title = `${p.nombre} · Librería Liceo`;

  const variedades = p.variedades || [];
  const hayVariedades = variedades.length > 0;
  const disponibles = variedades.filter(v => v.stock > 0);
  const agotado = p.stock <= 0 || (hayVariedades && !disponibles.length);

  // Con variedades se arranca sin ninguna elegida a proposito: preseleccionar
  // un color hace que el cliente agregue el equivocado sin darse cuenta.
  let elegida = null;

  const foto = p.imagenes?.[0];
  const medios = foto
    ? `<img src="${esc(foto)}" alt="${esc(p.nombre)}" width="800" height="800">`
    : `<div class="card-producto__placa"><span style="font-size:6rem">${
         esc((p.nombre || '?').charAt(0).toUpperCase())}</span></div>`;

  const listaVariedades = hayVariedades ? `
    <div class="variedades">
      <span class="campo__label" id="tit-variedades">Elegí el color o modelo</span>
      <div class="variedades__lista" role="group" aria-labelledby="tit-variedades">
        ${variedades.map(v => {
          const color = colorDeVariedad(v.nombre);
          const sinStock = v.stock <= 0;
          return `
            <button class="variedad" data-variedad="${esc(v.nombre)}"
                    aria-pressed="false" ${sinStock ? 'disabled' : ''}
                    ${sinStock ? `aria-label="${esc(v.nombre)}, sin stock"` : ''}>
              ${color ? `<span class="variedad__punto" style="background:${color}"></span>` : ''}
              ${esc(v.nombre)}
            </button>`;
        }).join('')}
      </div>
    </div>` : '';

  const estadoStock = agotado
    ? `<span class="dato-stock" style="color:var(--text-2)">${icono('atencion', { tam: 18 })} Sin stock por ahora</span>`
    : (p.stock <= 5
        ? `<span class="dato-stock" style="color:var(--alerta)">${icono('atencion', { tam: 18 })} Quedan ${p.stock}</span>`
        : `<span class="dato-stock" style="color:var(--exito)">${icono('tilde', { tam: 18 })} Hay stock</span>`);

  montar(`
    <div class="contenedor" data-rubro="${esc(p.rubro)}">
      <nav class="migas" aria-label="Dónde estás">
        <a href="/">Inicio</a>
        <span>${icono('derecha', { tam: 12 })}</span>
        <a href="/catalogo/${encodeURIComponent(p.rubro)}">${esc(nombreBonito(p.rubro))}</a>
        <span>${icono('derecha', { tam: 12 })}</span>
        <span>${esc(p.categoria || 'Producto')}</span>
      </nav>

      <div class="ficha-producto">
        <div class="ficha-producto__foto">${medios}</div>

        <div class="ficha-producto__datos">
          <div>
            <span class="card-producto__rubro">${esc(p.categoria || p.rubro)}</span>
            <h1 class="ficha-producto__titulo" style="margin-top:var(--e-2)">${esc(p.nombre)}</h1>
            ${p.marca ? `<p style="color:var(--text-2);font-size:var(--t-sm);margin-top:var(--e-1)">${esc(p.marca)}</p>` : ''}
          </div>

          <div>
            <div class="ficha-producto__precio cifra" data-precio>${pesos(p.precio)}</div>
            ${estadoStock}
          </div>

          ${p.descripcion ? `<p style="color:var(--text-2);line-height:var(--alto-suelto)">${esc(p.descripcion)}</p>` : ''}

          ${listaVariedades}

          ${agotado ? `
            <div style="padding:var(--e-4);border-radius:var(--r-md);background:var(--surface-2);border:1px solid var(--border)">
              <p style="font-weight:600;margin-bottom:var(--e-2)">Se nos terminó</p>
              <p style="color:var(--text-2);font-size:var(--t-sm);line-height:1.5;margin-bottom:var(--e-3)">
                Escribinos y te avisamos apenas vuelva a entrar.
              </p>
              <a class="boton boton--secundario boton--chico"
                 href="https://wa.me/${esc(cfg.whatsapp)}?text=${
                   encodeURIComponent(`Hola, quiero saber cuándo vuelve: ${p.nombre}`)}"
                 target="_blank" rel="noopener">
                ${icono('whatsapp', { tam: 16 })} Consultar
              </a>
            </div>`
          : `
            <button class="boton boton--primario boton--grande boton--bloque" data-agregar>
              ${icono('carrito', { tam: 20 })} Agregar al pedido
            </button>`}

          <div style="display:flex;flex-direction:column;gap:var(--e-2);padding-top:var(--e-3);border-top:1px solid var(--border)">
            <span style="display:flex;gap:var(--e-2);align-items:center;font-size:var(--t-sm);color:var(--text-2)">
              ${icono('camion', { tam: 18 })} Envío a domicilio en Córdoba, se calcula por distancia
            </span>
            <span style="display:flex;gap:var(--e-2);align-items:center;font-size:var(--t-sm);color:var(--text-2)">
              ${icono('local', { tam: 18 })} Retiro sin costo en ${esc(cfg.direccion)}
            </span>
            <span style="display:flex;gap:var(--e-2);align-items:center;font-size:var(--t-sm);color:var(--text-2)">
              ${icono('reloj', { tam: 18 })} Demora ${esc(cfg.entrega.demora_texto)}
            </span>
          </div>
        </div>
      </div>

      <div class="seccion">
        <div class="seccion__cabecera"><h2>Otros de ${esc(nombreBonito(p.rubro))}</h2></div>
        <div data-relacionados></div>
      </div>
    </div>

    ${pie(cfg)}
  `);

  /* ── Variedades ─────────────────────────────────────────────────────────── */
  const botonAgregar = document.querySelector('[data-agregar]');
  const cajaPrecio = document.querySelector('[data-precio]');

  document.querySelectorAll('[data-variedad]').forEach(boton => {
    boton.addEventListener('click', () => {
      const nombre = boton.dataset.variedad;
      const yaEstaba = elegida === nombre;
      elegida = yaEstaba ? null : nombre;

      document.querySelectorAll('[data-variedad]').forEach(otro => {
        otro.setAttribute('aria-pressed', String(otro.dataset.variedad === elegida));
      });

      const v = variedades.find(x => x.nombre === elegida);
      if (v && v.precio) cajaPrecio.textContent = pesos(v.precio);
      else cajaPrecio.textContent = pesos(p.precio);
    });
  });

  botonAgregar?.addEventListener('click', () => {
    if (hayVariedades && !elegida) {
      avisar('Elegí primero el color o modelo', { tipo: 'error' });
      // Lleva el foco al primer botón disponible: sin esto el cliente lee el
      // aviso y no sabe qué tiene que tocar.
      document.querySelector('[data-variedad]:not([disabled])')?.focus();
      return;
    }
    carrito.agregar(p, { variedad: elegida });
    avisar(`Agregaste ${p.nombre}${elegida ? ` · ${elegida}` : ''}`, {
      accion: { texto: 'Ver pedido', alHacer: abrirCarrito },
    });
  });

  /* ── Relacionados ───────────────────────────────────────────────────────── */
  const { productos } = await traerProductos({ rubro: p.rubro, cantidad: 6 });
  const otros = productos.filter(x => x.id !== p.id).slice(0, 5);
  const caja = document.querySelector('[data-relacionados]');
  if (caja) caja.innerHTML = otros.length ? grilla(otros) : '';
}
