/**
 * Estadísticas de la tienda online.
 *
 * Qué buscan los clientes (y qué buscaron sin encontrar), qué fichas abren,
 * qué agregan al pedido, cuándo entran y de dónde vienen. Sirve para decidir
 * qué cargar al catálogo, qué destacar y a qué hora conviene publicar.
 *
 * Los números salen de `tienda_estadisticas`: un documento por día con
 * contadores, que escribe la función `medir` de la tienda cuando el navegador
 * le manda lo que pasó (`tienda/src/medicion.js`). Acá se leen los días del
 * rango elegido y se juntan con `combinarDias()` (`tienda/src/estadisticas.js`,
 * compartido con la función). Los pedidos no se cuentan de ahí: salen de
 * `tienda_pedidos`, que es la verdad, y por eso "pedidos" es un número
 * confiable aunque una visita tenga la medición apagada.
 *
 * No hay personas en estos datos: ni teléfonos, ni cuentas, ni lo que se
 * escribió en el chat. Solo cuántas veces pasó cada cosa.
 */
import { collection, getDocs, query, where, Timestamp } from 'firebase/firestore';
import { escHtml } from '../components/dialogs.js';
import { nombreBonito, decodificarCampos, codificarValor } from '../tienda_espejo.js';
import { auth } from '../auth.js';
import { combinarDias, claveDeDia, inicioDelDia, porcentaje }
  from '../../../tienda/src/estadisticas.js';
import '../styles/tienda.css';

const REST = 'https://firestore.googleapis.com/v1/projects/mari-d7c71/databases/(default)/documents';
const CLAVE_RANGO = 'tienda_estadisticas.rango';
const ESPERA_REST_MS = 8000;

export const RANGOS = [
  { clave: 'hoy', texto: 'Hoy', dias: 1 },
  { clave: '7', texto: '7 días', dias: 7 },
  { clave: '30', texto: '30 días', dias: 30 },
  { clave: '90', texto: '90 días', dias: 90 },
];

const ORIGEN_TEXTO = {
  directo: 'Directo / WhatsApp', instagram: 'Instagram', whatsapp: 'WhatsApp',
  facebook: 'Facebook', google: 'Google', otro: 'Otros sitios',
};
const DISPOSITIVO_TEXTO = { movil: 'Celular', escritorio: 'Computadora' };

let _db = null;
/** Donde se pinta cada carga. La hoja de estilos queda afuera, en el contenedor. */
let _caja = null;
let _rango = null;
let _carga = 0;

const numero = n => Math.round(Number(n) || 0).toLocaleString('es-AR');
const pesos = n => `$${numero(n)}`;

/* ── Lectura ──────────────────────────────────────────────────────────────── */

/**
 * Una consulta por REST con el token de la sesión. Una lectura suelta por el
 * SDK queda encolada detrás de los listeners grandes del panel y puede tardar
 * más de un minuto; por REST sale enseguida. Devuelve null si no se pudo, y
 * ahí se cae al SDK.
 */
async function consultarRest({ coleccion, filtros = [], campos = null, limite = 500 }) {
  if (typeof fetch !== 'function') return null;
  let token;
  try { token = await auth.currentUser?.getIdToken?.(); } catch { return null; }
  if (!token) return null;

  const donde = filtros.map(([campo, op, valor]) => ({
    fieldFilter: { field: { fieldPath: campo }, op, value: codificarValor(valor) },
  }));
  const consulta = {
    from: [{ collectionId: coleccion }],
    limit: limite,
    ...(donde.length === 1 ? { where: donde[0] } : {}),
    ...(donde.length > 1 ? { where: { compositeFilter: { op: 'AND', filters: donde } } } : {}),
    ...(campos ? { select: { fields: campos.map(c => ({ fieldPath: c })) } } : {}),
  };

  try {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), ESPERA_REST_MS);
    const r = await fetch(`${REST}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ structuredQuery: consulta }),
      signal: control.signal,
    }).finally(() => clearTimeout(reloj));
    if (!r.ok) return null;
    const filas = await r.json();
    return (Array.isArray(filas) ? filas : [])
      .filter(f => f?.document?.name)
      .map(f => ({ id: String(f.document.name).split('/').pop(), ...decodificarCampos(f.document.fields) }));
  } catch (err) {
    console.warn('[estadisticas] la REST no respondió, se usa el SDK:', err?.message || err);
    return null;
  }
}

async function leerDias(desde, hasta) {
  const porRest = await consultarRest({
    coleccion: 'tienda_estadisticas',
    filtros: [['dia', 'GREATER_THAN_OR_EQUAL', desde], ['dia', 'LESS_THAN_OR_EQUAL', hasta]],
  });
  if (porRest !== null) return porRest;
  const snap = await getDocs(query(collection(_db, 'tienda_estadisticas'),
    where('dia', '>=', desde), where('dia', '<=', hasta)));
  return snap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
}

async function leerPedidos(desdeMs) {
  const porRest = await consultarRest({
    coleccion: 'tienda_pedidos',
    filtros: [['creado', 'GREATER_THAN_OR_EQUAL', new Date(desdeMs)]],
    campos: ['estado', 'items', 'creado', 'total'],
    limite: 3000,
  });
  if (porRest !== null) return porRest;
  const snap = await getDocs(query(collection(_db, 'tienda_pedidos'),
    where('creado', '>=', Timestamp.fromDate(new Date(desdeMs)))));
  return snap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
}

/**
 * Lo que dicen los pedidos del rango: cuántos entraron (los cancelados no),
 * cuánta plata, y cuántos pedidos llevó cada producto. Los pedidos que se
 * escribieron antes del servidor tienen los mismos `items[].id`.
 */
export function resumirPedidos(pedidos) {
  const porProducto = new Map();
  let cantidad = 0;
  let total = 0;
  for (const p of pedidos || []) {
    if (!p || p.estado === 'cancelado') continue;
    cantidad += 1;
    total += Number(p.total) || 0;
    const vistos = new Set();
    for (const it of Array.isArray(p.items) ? p.items : []) {
      const id = it?.id != null ? String(it.id) : null;
      if (!id || vistos.has(id)) continue;
      vistos.add(id);
      porProducto.set(id, (porProducto.get(id) || 0) + 1);
    }
  }
  return { cantidad, total, porProducto };
}

/* ── Rango ────────────────────────────────────────────────────────────────── */

function rangoGuardado() {
  try {
    const clave = localStorage.getItem(CLAVE_RANGO);
    return RANGOS.find(r => r.clave === clave) || RANGOS[2];
  } catch {
    return RANGOS[2];
  }
}

/** Los límites del rango: el día de hoy hacia atrás, en hora argentina. */
export function limitesDe(rango, ahoraMs = Date.now()) {
  const hasta = claveDeDia(ahoraMs);
  const desde = claveDeDia(inicioDelDia(hasta) - (rango.dias - 1) * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000);
  return { desde, hasta, desdeMs: inicioDelDia(desde) };
}

/* ── Pintado ──────────────────────────────────────────────────────────────── */

/** "6/9" de un '2026-09-06'. */
function diaCorto(dia) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dia || ''));
  return m ? `${Number(m[3])}/${Number(m[2])}` : '';
}

function tarjeta({ titulo, valor, detalle = '', icono, color = 'bg-blue' }) {
  return `
    <div class="card stat-card">
      <div class="icon-wrap ${color}"><span class="material-icons">${icono}</span></div>
      <div class="label">${escHtml(titulo)}</div>
      <div class="value">${escHtml(valor)}</div>
      ${detalle ? `<div class="est-detalle">${escHtml(detalle)}</div>` : ''}
    </div>`;
}

/**
 * Una barra horizontal con su etiqueta y su cifra. La cifra va en texto, no
 * adentro de la barra: la barra dice cuánto respecto del resto, el número
 * dice cuánto.
 */
function fila({ texto, valor, maximo, extra = '', titulo = '' }) {
  const ancho = maximo > 0 ? Math.max(2, Math.round((valor / maximo) * 100)) : 0;
  return `
    <div class="est-fila" title="${escHtml(titulo || `${texto}: ${numero(valor)}`)}">
      <div class="est-fila__texto">${escHtml(texto)}${extra}</div>
      <div class="est-fila__barra"><span style="width:${ancho}%"></span></div>
      <div class="est-fila__cifra">${numero(valor)}</div>
    </div>`;
}

function listaVacia(texto) {
  return `<p class="est-vacio">${escHtml(texto)}</p>`;
}

/** Barras verticales: una por día o por hora. */
function columnas(valores, { etiqueta, titulo, cada = 1 }) {
  const maximo = Math.max(0, ...valores);
  return `
    <div class="est-columnas" role="img" aria-label="${escHtml(titulo)}">
      ${valores.map((v, i) => {
        const alto = maximo > 0 ? Math.round((v / maximo) * 100) : 0;
        // La última columna lleva etiqueta solo si queda lejos de la anterior
        // con etiqueta: "5/9" y "6/9" pegadas se leían como un solo número.
        const ultima = i === valores.length - 1;
        const conEtiqueta = i % cada === 0 || (ultima && i % cada > cada / 2);
        return `
          <div class="est-columna" title="${escHtml(`${etiqueta(i, true)}: ${numero(v)}`)}">
            <div class="est-columna__espacio"><span style="height:${alto}%"></span></div>
            <div class="est-columna__etiqueta">${conEtiqueta ? escHtml(etiqueta(i, false)) : ''}</div>
          </div>`;
      }).join('')}
    </div>`;
}

function seccion(titulo, cuerpo, { nota = '', clase = '' } = {}) {
  return `
    <div class="card est-seccion ${clase}">
      <div class="est-seccion__cabecera">
        <h4>${escHtml(titulo)}</h4>
        ${nota ? `<span>${escHtml(nota)}</span>` : ''}
      </div>
      ${cuerpo}
    </div>`;
}

function sinDatos(rango) {
  return `
    <div class="card est-sin-datos">
      <span class="material-icons">query_stats</span>
      <p><b>Todavía no hay movimiento ${rango.clave === 'hoy' ? 'hoy' : `en los últimos ${rango.dias} días`}.</b></p>
      <p>
        La tienda cuenta sola cada visita, búsqueda y ficha abierta desde que se
        publicó esta versión. Apenas alguien entre, acá aparece qué buscó, qué
        miró y qué agregó al pedido.
      </p>
    </div>`;
}

function pintar(datos, rango, { desde, hasta }) {
  const r = combinarDias(datos.dias);
  const pedidos = resumirPedidos(datos.pedidos);
  const t = r.total;
  const hayAlgo = t.paginas > 0 || t.visitas > 0 || pedidos.cantidad > 0;

  const cabeza = `
    <div class="est-cabecera">
      <div>
        <h3>
          <span class="material-icons">query_stats</span>
          Estadísticas de la tienda
        </h3>
        <div class="est-subtitulo">
          Qué buscan, qué miran y qué agregan al pedido los que entran a la tienda.
          Sin datos de nadie: solo cuántas veces pasó cada cosa.
        </div>
      </div>
      <div class="est-rangos" role="group" aria-label="Período">
        ${RANGOS.map(x => `
          <button class="est-rango" data-rango="${x.clave}" aria-pressed="${x.clave === rango.clave}">
            ${escHtml(x.texto)}
          </button>`).join('')}
      </div>
    </div>
    <div class="est-periodo">
      ${rango.clave === 'hoy'
        ? `Hoy, ${diaCorto(hasta)}`
        : `Del ${diaCorto(desde)} al ${diaCorto(hasta)}`} · hora de Córdoba
    </div>`;

  if (!hayAlgo) {
    _caja.innerHTML = cabeza + sinDatos(rango);
    return;
  }

  const sinResultado = porcentaje(t.busquedas_sin_resultado, t.busquedas);
  const tarjetas = `
    <div class="est-tarjetas">
      ${tarjeta({ titulo: 'Visitas', valor: numero(t.visitas), icono: 'people',
                  detalle: t.visitantes_nuevos ? `${numero(t.visitantes_nuevos)} entraron por primera vez` : '' })}
      ${tarjeta({ titulo: 'Búsquedas', valor: numero(t.busquedas), icono: 'search', color: 'bg-purple',
                  detalle: t.busquedas ? `${sinResultado}% sin resultado` : '' })}
      ${tarjeta({ titulo: 'Fichas abiertas', valor: numero(t.fichas), icono: 'visibility', color: 'bg-teal',
                  detalle: t.visitas ? `${(t.fichas / t.visitas).toFixed(1).replace('.', ',')} por visita` : '' })}
      ${tarjeta({ titulo: 'Al carrito', valor: numero(t.carrito), icono: 'add_shopping_cart', color: 'bg-orange',
                  detalle: t.fichas ? `${porcentaje(t.carrito, t.fichas)}% de las fichas` : '' })}
      ${tarjeta({ titulo: 'Llegaron al checkout', valor: numero(t.checkouts), icono: 'point_of_sale', color: 'bg-purple',
                  detalle: t.visitas ? `${porcentaje(t.checkouts, t.visitas)}% de las visitas` : '' })}
      ${tarjeta({ titulo: 'Pedidos', valor: numero(pedidos.cantidad), icono: 'shopping_bag', color: 'bg-green',
                  detalle: pedidos.cantidad
                    ? `${pesos(pedidos.total)}${t.visitas ? ` · ${porcentaje(pedidos.cantidad, t.visitas)}% de las visitas` : ''}`
                    : 'Sin pedidos en el período' })}
    </div>`;

  /* Día por día y hora por hora. Con "Hoy" el día por día no dice nada. */
  const porDia = new Map(r.porDia.map(d => [d.dia, d]));
  const diasDelRango = [];
  for (let ms = inicioDelDia(desde); ms <= inicioDelDia(hasta); ms += 24 * 60 * 60 * 1000) {
    diasDelRango.push(claveDeDia(ms + 3 * 60 * 60 * 1000));
  }
  const visitasPorDia = diasDelRango.map(d => porDia.get(d)?.visitas || 0);
  const cadaDia = diasDelRango.length > 45 ? 15 : diasDelRango.length > 14 ? 7 : 1;

  const tiempo = `
    <div class="est-dos">
      ${rango.clave === 'hoy' ? '' : seccion('Visitas por día', columnas(visitasPorDia, {
        etiqueta: (i, larga) => (larga ? diasDelRango[i] : diaCorto(diasDelRango[i])),
        titulo: 'Visitas por día',
        cada: cadaDia,
      }))}
      ${seccion('A qué hora entran', columnas(r.horas, {
        etiqueta: (i, larga) => (larga ? `${i}:00 a ${i}:59` : `${i}`),
        titulo: 'Pantallas vistas por hora',
        cada: 3,
      }), { nota: 'pantallas vistas, hora de Córdoba' })}
    </div>`;

  /* Qué buscan. */
  const maxTermino = r.terminos[0]?.n || 0;
  const terminos = r.terminos.length
    ? r.terminos.slice(0, 25).map(x => fila({
        texto: x.termino, valor: x.n, maximo: maxTermino,
        extra: x.sin ? `<span class="est-marca est-marca--roja">${x.sin === x.n ? 'sin resultado' : `${x.sin} sin resultado`}</span>` : '',
        titulo: `«${x.termino}»: ${x.n} ${x.n === 1 ? 'vez' : 'veces'}${x.sin ? `, ${x.sin} sin resultado` : ''}`,
      })).join('')
    : listaVacia('Nadie usó el buscador todavía.');

  const maxSin = r.sinResultado[0]?.sin || 0;
  const noEncontraron = r.sinResultado.length
    ? r.sinResultado.slice(0, 25).map(x => fila({
        texto: x.termino, valor: x.sin, maximo: maxSin,
        titulo: `«${x.termino}»: ${x.sin} ${x.sin === 1 ? 'vez' : 'veces'} sin resultado`,
      })).join('')
    : listaVacia('Todo lo que buscaron lo encontraron.');

  const busquedas = `
    <div class="est-dos">
      ${seccion('Qué buscan', terminos, { nota: 'las 25 palabras más buscadas' })}
      ${seccion('Buscaron y no encontraron', noEncontraron,
                { nota: 'lo que conviene cargar o renombrar', clase: 'est-seccion--alerta' })}
    </div>`;

  /* Qué miran. */
  const maxVistas = r.productos[0]?.vistas || 0;
  const productos = r.productos.length ? `
    <div class="est-tabla-marco">
      <table class="tienda-tabla est-tabla">
        <thead>
          <tr><th>Producto</th><th>Rubro</th><th class="est-num">Fichas abiertas</th>
              <th class="est-num">Al carrito</th><th class="est-num">Pedidos</th></tr>
        </thead>
        <tbody>
          ${r.productos.slice(0, 30).map(p => `
            <tr>
              <td>
                <div class="est-producto">${escHtml(p.nombre || p.id)}</div>
                <div class="est-codigo">${escHtml(p.id)}</div>
              </td>
              <td class="est-rubro">${escHtml(p.rubro ? nombreBonito(p.rubro) : '')}</td>
              <td class="est-num">
                <div class="est-celda-barra">
                  <span class="est-fila__barra"><span style="width:${maxVistas ? Math.max(2, Math.round((p.vistas / maxVistas) * 100)) : 0}%"></span></span>
                  ${numero(p.vistas)}
                </div>
              </td>
              <td class="est-num">${numero(p.carrito)}</td>
              <td class="est-num">${numero(pedidos.porProducto.get(p.id) || 0)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : listaVacia('Nadie abrió una ficha todavía.');

  const miran = seccion('Qué miran', productos,
    { nota: 'los 30 productos con más fichas abiertas' });

  /* Rubros, origen y aparato. */
  const maxRubro = r.rubros[0]?.vistas || 0;
  const rubros = r.rubros.length
    ? r.rubros.slice(0, 12).map(x => fila({ texto: nombreBonito(x.clave), valor: x.vistas, maximo: maxRubro })).join('')
    : listaVacia('Nadie entró a un rubro todavía.');

  const maxOrigen = r.origenes[0]?.visitas || 0;
  const origenes = r.origenes.length
    ? r.origenes.slice(0, 10).map(x => fila({
        texto: ORIGEN_TEXTO[x.clave] || x.clave, valor: x.visitas, maximo: maxOrigen,
      })).join('')
    : listaVacia('Sin visitas en el período.');

  const dispositivos = Object.entries(r.dispositivos).sort((a, b) => b[1] - a[1]);
  const maxAparato = dispositivos[0]?.[1] || 0;
  const aparatos = dispositivos.length
    ? dispositivos.map(([clave, v]) => fila({
        texto: DISPOSITIVO_TEXTO[clave] || clave, valor: v, maximo: maxAparato,
        extra: `<span class="est-marca">${porcentaje(v, t.visitas)}%</span>`,
      })).join('')
    : listaVacia('Sin visitas en el período.');

  const contexto = `
    <div class="est-tres">
      ${seccion('Rubros más visitados', rubros, { nota: 'veces que abrieron el catálogo del rubro' })}
      ${seccion('De dónde vienen', origenes, { nota: 'WhatsApp casi nunca avisa: cuenta como directo' })}
      ${seccion('Desde qué aparato', aparatos)}
    </div>`;

  _caja.innerHTML = cabeza + tarjetas + tiempo + busquedas + miran + contexto;
}

function pintarError(err, rango) {
  _caja.innerHTML = `
    <div class="card est-sin-datos">
      <span class="material-icons">error_outline</span>
      <p><b>No se pudieron leer las estadísticas.</b></p>
      <p>${escHtml(err?.message || String(err))}</p>
      <button class="pc-btn" data-reintentar>Reintentar</button>
    </div>`;
  _caja.querySelector('[data-reintentar]')?.addEventListener('click', () => cargar(rango));
}

async function cargar(rango) {
  const mia = ++_carga;
  _rango = rango;
  try { localStorage.setItem(CLAVE_RANGO, rango.clave); } catch { /* sin storage */ }

  _caja.querySelectorAll('[data-rango]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.rango === rango.clave));
  });
  _caja.classList.add('est-cargando');

  const limites = limitesDe(rango);
  try {
    const [dias, pedidos] = await Promise.all([
      leerDias(limites.desde, limites.hasta),
      leerPedidos(limites.desdeMs),
    ]);
    if (mia !== _carga) return;
    pintar({ dias, pedidos }, rango, limites);
  } catch (err) {
    if (mia !== _carga) return;
    console.error('[estadisticas] no se pudieron leer:', err);
    pintarError(err, rango);
  } finally {
    _caja.classList.remove('est-cargando');
  }
}

/* ── Entrada ──────────────────────────────────────────────────────────────── */

export async function renderTiendaEstadisticas(container, db) {
  _db = db;

  // La hoja de estilos va en el contenedor y la pantalla se pinta en una caja
  // adentro: cada carga reemplaza la caja entera, y si el `<style>` viviera
  // ahí se iría con el esqueleto en el primer pintado con datos.
  container.innerHTML = `
    <style>
      .est-cabecera { display:flex; justify-content:space-between; align-items:flex-start;
                      gap:12px; flex-wrap:wrap; margin-bottom:6px }
      .est-cabecera h3 { margin:0; display:flex; align-items:center; gap:6px }
      .est-cabecera h3 .material-icons { color:var(--primary) }
      .est-subtitulo { font-size:12.5px; color:var(--text-muted); margin-top:3px; max-width:560px; line-height:1.45 }
      .est-rangos { display:inline-flex; border:1.5px solid var(--border); border-radius:8px;
                    overflow:hidden; background:var(--surface) }
      .est-rango { border:0; background:transparent; color:var(--text); font:inherit; font-size:13px;
                   font-weight:600; padding:7px 13px; cursor:pointer }
      .est-rango + .est-rango { border-left:1.5px solid var(--border) }
      .est-rango[aria-pressed="true"] { background:var(--primary); color:#fff }
      .est-periodo { font-size:12px; color:var(--text-muted); margin-bottom:14px }
      .est-cargando { opacity:.55; pointer-events:none; transition:opacity .15s }
      .est-tarjetas { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:14px }
      .est-detalle { font-size:12px; color:var(--text-muted); margin-top:-2px }
      .est-dos { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:14px; margin-bottom:14px }
      .est-tres { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; margin-bottom:14px }
      .est-seccion { padding:16px 18px; margin-bottom:14px }
      .est-dos .est-seccion, .est-tres .est-seccion { margin-bottom:0 }
      .est-seccion__cabecera { display:flex; justify-content:space-between; align-items:baseline;
                               gap:10px; flex-wrap:wrap; margin-bottom:12px }
      .est-seccion__cabecera h4 { margin:0; font-size:14px }
      .est-seccion__cabecera span { font-size:11.5px; color:var(--text-muted) }
      .est-seccion--alerta { border-left:4px solid var(--secondary) }
      .est-fila { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(60px,1fr) 44px; gap:10px;
                  align-items:center; padding:5px 0; font-size:13px }
      .est-fila__texto { overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
      .est-fila__barra { display:block; height:8px; border-radius:4px; background:var(--chart-grid, rgba(0,0,0,.05)); overflow:hidden }
      .est-fila__barra > span { display:block; height:100%; border-radius:0 4px 4px 0; background:var(--primary) }
      .est-fila__cifra { text-align:right; font-variant-numeric:tabular-nums; font-weight:600 }
      .est-marca { display:inline-block; margin-left:6px; padding:1px 6px; border-radius:99px; font-size:11px;
                   font-weight:600; background:var(--tint-gray-bg); color:var(--tint-gray-fg); vertical-align:1px }
      .est-marca--roja { background:var(--tint-orange-bg); color:var(--tint-orange-fg) }
      .est-vacio { margin:4px 0; font-size:13px; color:var(--text-muted) }
      .est-columnas { display:flex; align-items:flex-end; gap:3px; height:150px }
      .est-columna { flex:1; min-width:0; display:flex; flex-direction:column; height:100% }
      .est-columna__espacio { flex:1; display:flex; align-items:flex-end }
      .est-columna__espacio > span { display:block; width:100%; min-height:2px; border-radius:4px 4px 0 0;
                                     background:var(--primary) }
      .est-columna__etiqueta { height:16px; font-size:10.5px; color:var(--text-muted); text-align:center;
                               white-space:nowrap; overflow:visible }
      .est-tabla-marco { overflow-x:auto }
      .est-tabla { width:100%; border-collapse:collapse; font-size:13px }
      .est-tabla th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.4px;
                      color:var(--text-muted); padding:6px 8px; border-bottom:1px solid var(--border) }
      .est-tabla td { padding:7px 8px; border-bottom:1px solid var(--border); vertical-align:middle }
      .est-tabla .est-num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap }
      .est-producto { font-weight:600 }
      .est-codigo { font-size:11.5px; color:var(--text-muted); font-family:ui-monospace,monospace }
      .est-rubro { color:var(--text-muted); white-space:nowrap }
      .est-celda-barra { display:inline-grid; grid-template-columns:70px auto; gap:8px; align-items:center }
      .est-sin-datos { padding:32px; text-align:center; color:var(--text-muted) }
      .est-sin-datos .material-icons { font-size:36px; opacity:.4 }
      .est-sin-datos p { margin:8px auto 0; max-width:480px; font-size:14px; line-height:1.5 }
      .est-sin-datos b { color:var(--text) }
      .est-sin-datos .pc-btn { margin-top:12px }
    </style>
    <div data-estadisticas>
      <div class="est-cabecera">
        <div><h3><span class="material-icons">query_stats</span> Estadísticas de la tienda</h3></div>
      </div>
      <div class="est-tarjetas">
        ${Array(6).fill('<div class="skel skel-card" style="height:110px"></div>').join('')}
      </div>
      <div class="skel skel-card" style="height:220px"></div>
    </div>`;
  _caja = container.querySelector('[data-estadisticas]');

  container.addEventListener('click', ev => {
    const boton = ev.target.closest('[data-rango]');
    if (!boton) return;
    const rango = RANGOS.find(r => r.clave === boton.dataset.rango);
    if (rango && rango !== _rango) cargar(rango);
  });

  await cargar(rangoGuardado());
}
