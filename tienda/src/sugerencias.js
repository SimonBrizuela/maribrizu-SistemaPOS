/**
 * Sugerencias del buscador.
 *
 * En un catálogo de 2.315 productos con nombres internos del POS ("Abrojo
 * 100MM X Mt", "Cinta Doble Faz CBX 12 MM X 10 MT"), acertar el nombre exacto
 * es imposible. Las sugerencias son lo que convierte el buscador en algo
 * usable: escribís tres letras y ves si lo que buscás está.
 *
 * Si estás mirando un rubro, busca ahí primero y te lo dice, con la salida a
 * todo el catálogo a un toque. Sin eso, no encontrar algo dentro de Papelera
 * se lee como que el producto no existe.
 */
import { sugerir } from './datos.js';
import { pesos, esc, normalizar, nombreBonito } from './formato.js';
import { ir } from './router.js';

const ESPERA = 220;   // ms desde la última tecla hasta consultar

let caja = null;
let temporizador = null;
let indice = -1;      // fila resaltada con las flechas
let actuales = [];
let ambito = null;    // rubro en el que se busca, o null
let pedido = 0;       // descarta respuestas de consultas ya viejas

/** Marca en negrita la parte del nombre que coincide con lo escrito. */
function resaltar(nombre, texto) {
  const palabras = normalizar(texto).split(/\s+/).filter(w => w.length >= 2);
  if (!palabras.length) return esc(nombre);

  const plano = normalizar(nombre);
  // Se marca sobre el texto normalizado y se recorta el original por posición,
  // así los acentos no corren los índices.
  const tramos = [];
  for (const w of palabras) {
    let desde = 0;
    let i;
    while ((i = plano.indexOf(w, desde)) !== -1) {
      tramos.push([i, i + w.length]);
      desde = i + w.length;
    }
  }
  if (!tramos.length) return esc(nombre);

  tramos.sort((a, b) => a[0] - b[0]);
  const unidos = [tramos[0]];
  for (const [a, b] of tramos.slice(1)) {
    const ultimo = unidos[unidos.length - 1];
    if (a <= ultimo[1]) ultimo[1] = Math.max(ultimo[1], b);
    else unidos.push([a, b]);
  }

  let salida = '';
  let cursor = 0;
  for (const [a, b] of unidos) {
    salida += esc(nombre.slice(cursor, a)) + '<b>' + esc(nombre.slice(a, b)) + '</b>';
    cursor = b;
  }
  return salida + esc(nombre.slice(cursor));
}

function fila(p, texto) {
  const foto = p.imagenes?.[0]
    ? `<img src="${esc(p.imagenes[0])}" alt="" loading="lazy">`
    : `<span>${esc((p.nombre || '?').charAt(0).toUpperCase())}</span>`;

  const meta = [nombreBonito(p.rubro), p.marca].filter(Boolean).join(' · ');

  // Un grupo de tamaños sugiere con el nombre del grupo: "Cierre Común ·
  // varios tamaños" dice más que el tamaño puntual que casualmente rankeó.
  const nombre = p.grupo || p.nombre;

  return `
    <a class="sugerencia${p.stock <= 0 ? ' sugerencia--agotada' : ''}"
       href="/p/${esc(p.id)}" role="option" aria-selected="false"
       data-rubro="${esc(p.rubro)}" data-id="${esc(p.id)}">
      <span class="sugerencia__foto">${foto}</span>
      <span class="sugerencia__datos">
        <span class="sugerencia__nombre">${resaltar(nombre, texto)}</span>
        <span class="sugerencia__meta">${esc(meta)}${
          p.grupo ? ' · varios tamaños' : ''}${
          p.stock <= 0 ? ' · sin stock' : ''}</span>
      </span>
      <span class="sugerencia__precio cifra">${pesos(p.precio)}${
        p.unidad === 'metro' ? '<small style="font-weight:600;color:var(--text-2)">/m</small>' : ''
      }</span>
    </a>`;
}

function cerrar() {
  caja?.remove();
  caja = null;
  indice = -1;
  actuales = [];
  document.querySelector('.buscador__input')?.setAttribute('aria-expanded', 'false');
}

function pintar(productos, texto) {
  const form = document.querySelector('[data-buscador]');
  if (!form) return;

  if (!caja) {
    caja = document.createElement('div');
    caja.className = 'sugerencias';
    caja.setAttribute('role', 'listbox');
    caja.setAttribute('aria-label', 'Sugerencias');
    form.appendChild(caja);
  }

  const cabecera = ambito ? `
    <div class="sugerencias__ambito">
      Buscando en <strong>${esc(nombreBonito(ambito))}</strong>
      <button type="button" data-todo-el-catalogo>Buscar en todo</button>
    </div>` : '';

  if (!productos.length) {
    caja.innerHTML = cabecera + `
      <p class="sugerencias__vacio">
        Nada con «${esc(texto)}»${ambito ? ' en este rubro' : ''}.
      </p>`;
    return;
  }

  caja.innerHTML = cabecera
    + productos.map(p => fila(p, texto)).join('')
    + `<button type="submit" class="sugerencias__todo">
         Ver todos los resultados de «${esc(texto)}»
       </button>`;

  document.querySelector('.buscador__input')?.setAttribute('aria-expanded', 'true');
  actuales = productos;
  indice = -1;
}

function mover(paso) {
  const filas = [...(caja?.querySelectorAll('.sugerencia') || [])];
  if (!filas.length) return;
  filas[indice]?.setAttribute('aria-selected', 'false');
  indice = (indice + paso + filas.length + 1) % (filas.length + 1);
  // El último paso vuelve al campo de texto, para poder corregir lo escrito sin
  // tener que salir con Escape.
  if (indice === filas.length) { indice = -1; return; }
  filas[indice].setAttribute('aria-selected', 'true');
  filas[indice].scrollIntoView({ block: 'nearest' });
}

async function consultar(texto) {
  const mio = ++pedido;
  const productos = await sugerir(texto, { rubro: ambito });
  // Llegó tarde: ya se escribió algo más. Pintarla haría parpadear resultados
  // viejos encima de los nuevos.
  if (mio !== pedido) return;
  pintar(productos, texto);
}

/**
 * Engancha el buscador. Se llama una vez al arrancar; el encabezado se repinta
 * seguido, así que todo va delegado en el documento.
 */
export function iniciarSugerencias() {
  document.addEventListener('input', ev => {
    const campo = ev.target.closest('.buscador__input');
    if (!campo) return;

    const texto = campo.value.trim();
    clearTimeout(temporizador);

    if (texto.length < 2) { cerrar(); return; }

    // Se espera a que deje de escribir: consultar en cada tecla son seis
    // lecturas por palabra y resultados que parpadean.
    temporizador = setTimeout(() => consultar(texto), ESPERA);
  });

  document.addEventListener('keydown', ev => {
    const campo = ev.target.closest('.buscador__input');
    if (!campo) return;

    if (ev.key === 'Escape') { cerrar(); campo.blur(); return; }
    if (!caja) return;

    if (ev.key === 'ArrowDown') { ev.preventDefault(); mover(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); mover(-1); }
    else if (ev.key === 'Enter' && indice >= 0) {
      ev.preventDefault();
      const fila = caja.querySelectorAll('.sugerencia')[indice];
      if (fila) { cerrar(); campo.blur(); ir(fila.getAttribute('href')); }
    }
  });

  document.addEventListener('click', ev => {
    if (ev.target.closest('[data-todo-el-catalogo]')) {
      ev.preventDefault();
      ambito = null;
      const campo = document.querySelector('.buscador__input');
      if (campo?.value.trim()) consultar(campo.value.trim());
      return;
    }
    // Un clic en una sugerencia navega por el enlace; el resto de la página
    // cierra el panel.
    if (ev.target.closest('.sugerencia')) { cerrar(); return; }
    if (!ev.target.closest('[data-buscador]')) cerrar();
  });

  // Al enviar el formulario o cambiar de pantalla, el panel se va.
  document.addEventListener('submit', cerrar);
}

/**
 * Le dice al buscador en qué rubro está parada la persona.
 * Lo llama el router en cada cambio de pantalla.
 */
export function fijarAmbito(rubro) {
  ambito = rubro || null;
  const campo = document.querySelector('.buscador__input');
  if (campo) {
    campo.placeholder = ambito
      ? `Buscar en ${nombreBonito(ambito)}…`
      : 'Buscar cuadernos, hilos, juguetes…';
  }
}

export { cerrar as cerrarSugerencias };
