/**
 * Configuración de la tienda online.
 *
 * Todo lo que la tienda muestra y cobra sin que haya que tocar código: los
 * horarios, cuánto sale el envío según la distancia, hasta dónde se reparte,
 * el alias para transferir y qué rubros salen a la web.
 *
 * Dos cosas escriben acá:
 *
 *   · `tienda_config/settings` — lo lee la tienda al cargar y también las tres
 *     funciones de servidor (envío, direcciones, asistente), que la leen por la
 *     API REST sin credenciales porque es pública.
 *   · `tienda_config/publicacion` — qué rubros se publican. Cambiarlo mueve
 *     cientos de productos, así que el panel espeja el rubro entero en el
 *     momento en vez de esperar al sync.
 *
 * Los valores por defecto son los mismos que tiene la tienda en
 * `tienda/src/datos.js`: si el documento no existe, la tienda igual funciona.
 */
import { collection, doc, getDocs, orderBy, query, setDoc } from 'firebase/firestore';
import { getCached, invalidateCache } from '../cache.js';
import { leerDocRapido } from '../config.js';
import { alertDialog, confirmDialog, escHtml } from '../components/dialogs.js';
import { espejarLote, recomputarRubros, motivoDeNoPublicar, nombreBonito,
         claveDeRubro } from '../tienda_espejo.js';
import { textoDeHorarios } from '../../../tienda/src/horarios.js';
import '../styles/tienda.css';

const POR_DEFECTO = {
  abierta: true,
  nombre: 'Librería Liceo',
  telefono: '3517046684',
  whatsapp: '5493517046684',
  email: 'libreria.liceo@hotmail.com',
  direccion: 'Av. Alfonsina Storni 168, X5019 Córdoba',
  barrio: 'Parque Liceo 1ª Sección',
  horarios_texto: '',
  banner: null,
  entrega: {
    retiro_habilitado: true,
    delivery_habilitado: true,
    radio_max_km: 12,
    tramos: [{ hasta_km: 3, precio: 1500 }, { hasta_km: 6, precio: 2500 }, { hasta_km: 12, precio: 3500 }],
    envio_gratis_desde: null,
    demora_texto: '24 a 48 hs',
    pedido_minimo: 0,
  },
  // `efectivo_habilitado` en false es el estado que se quiere hoy: si el
  // documento todavía no trae el campo, la tienda cobra solo por transferencia.
  pago: { alias: null, titular: null, efectivo_habilitado: false },
};

let _db = null;
let _config = null;
let _tramos = [];
let _habilitados = [];
// { RUBRO: ['SUBRUBRO', …] } — lo que queda afuera dentro de un rubro prendido.
let _subExcluidos = {};
let _catalogo = [];
let _horarios = null;
// Si alguien ya empezó a editar, la revalidación contra el server no repinta.
let _tocado = false;

/* ── Lectura ──────────────────────────────────────────────────────────────── */

function completarConfig(datos) {
  const d = datos || {};
  return {
    ...POR_DEFECTO, ...d,
    entrega: { ...POR_DEFECTO.entrega, ...(d.entrega || {}) },
    pago: { ...POR_DEFECTO.pago, ...(d.pago || {}) },
  };
}

/**
 * Deja el mapa de subrubros excluidos en una forma sola: claves y valores en
 * mayúsculas, sin vacíos. Lo que llega de Firestore puede venir escrito de
 * cualquier manera si alguna vez se editó a mano.
 */
function normalizarExcluidos(crudo) {
  const salida = {};
  if (!crudo || typeof crudo !== 'object') return salida;
  for (const [rubro, subs] of Object.entries(crudo)) {
    if (!Array.isArray(subs)) continue;
    const limpios = subs.map(claveDeRubro).filter(Boolean);
    if (limpios.length) salida[claveDeRubro(rubro)] = limpios;
  }
  return salida;
}

async function leerConfig(db, alRevalidar) {
  // Cache-first, igual que el Balance: el getDoc al server queda encolado
  // detrás de los listeners grandes del store y esta pantalla no pinta hasta
  // que vuelve.
  const datos = await leerDocRapido(doc(db, 'tienda_config', 'settings'), {
    etiqueta: 'tienda_config/settings',
    vacio: {},
    alRevalidar: frescos => alRevalidar?.(completarConfig(frescos)),
  });
  return completarConfig(datos);
}

/* ── Pintado ──────────────────────────────────────────────────────────────── */

function pesos(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}

function campo(id, etiqueta, valor, { pista = '', tipo = 'text', placeholder = '' } = {}) {
  return `
    <div class="tienda-campo">
      <label for="${id}">${etiqueta}</label>
      <input type="${tipo}" id="${id}" value="${escHtml(valor ?? '')}"
             placeholder="${escHtml(placeholder)}">
      ${pista ? `<div class="tienda-pista">${pista}</div>` : ''}
    </div>`;
}

function pintarTramos() {
  const caja = document.getElementById('cfgTramos');
  if (!caja) return;

  caja.innerHTML = _tramos.map((t, i) => `
    <div style="display:grid;grid-template-columns:1fr 1fr 38px;gap:10px;align-items:end;margin-bottom:8px"
         data-tramo="${i}">
      <div class="tienda-campo" style="margin:0">
        <label>Hasta (km)</label>
        <input type="number" step="0.5" min="0" data-campo="hasta_km" value="${t.hasta_km}">
      </div>
      <div class="tienda-campo" style="margin:0">
        <label>Cuesta</label>
        <input type="number" step="100" min="0" data-campo="precio" value="${t.precio}">
      </div>
      <button class="pc-btn danger" data-quitar="${i}" style="height:37px" title="Quitar tramo">
        <span class="material-icons">delete</span>
      </button>
    </div>`).join('')
    + `<button class="pc-btn" id="cfgAgregarTramo" style="margin-top:4px">
         <span class="material-icons">add</span> Agregar tramo
       </button>`;

  pintarTramosResumen(_tramos);
}

/**
 * La tabla leída como la lee el cliente.
 *
 * Los campos dicen "hasta 6 km, $2.500", que es la forma de cargarlo, pero lo
 * que se cobra es un rango. Verlo escrito es lo que hace notar el tramo que
 * quedó cubriendo desde cero.
 */
function pintarTramosResumen(tramos) {
  const resumen = document.getElementById('cfgTramosResumen');
  if (!resumen) return;

  const ordenados = [...tramos].filter(t => t.hasta_km > 0).sort((a, b) => a.hasta_km - b.hasta_km);
  resumen.innerHTML = ordenados.length
    ? ordenados.map((t, i) => {
        const desde = i === 0 ? 0 : ordenados[i - 1].hasta_km;
        return `<div>De ${String(desde).replace('.', ',')} a
                ${String(t.hasta_km).replace('.', ',')} km · <b>${pesos(t.precio)}</b></div>`;
      }).join('')
      + `<div style="margin-top:5px;color:var(--tint-red-fg)">
           Más de ${String(ordenados[ordenados.length - 1].hasta_km).replace('.', ',')} km ·
           fuera de reparto</div>`
    : '<div>Sin tramos cargados: la tienda cotiza "a confirmar".</div>';
}

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

/** Siete días, con el horario de siempre si nunca se cargó ninguno. */
function normalizarHorarios(horarios) {
  const base = Array.isArray(horarios) && horarios.length === 7 ? horarios : null;
  if (base) {
    // En Firestore cada día es un mapa con `tramos` adentro: la base no admite
    // arreglos anidados y guardar un arreglo de arreglos falla.
    return base.map(dia => {
      const lista = Array.isArray(dia) ? dia : (Array.isArray(dia?.tramos) ? dia.tramos : []);
      return lista.slice(0, 2).map(t => ({
        desde: String(t?.desde || ''), hasta: String(t?.hasta || ''),
      }));
    });
  }
  const habil = [{ desde: '09:00', hasta: '13:00' }, { desde: '17:00', hasta: '20:30' }];
  return [habil, habil, habil, habil, habil,
          [{ desde: '09:00', hasta: '13:00' }, { desde: '17:30', hasta: '20:30' }],
          []].map(d => d.map(t => ({ ...t })));
}

/**
 * El horario, día por día.
 *
 * Dos tramos por día porque así trabaja el local: abre a la mañana, cierra al
 * mediodía y vuelve a la tarde. Un día sin tramos es un día cerrado, y así es
 * como el domingo aparece cerrado en la tienda sin que nadie lo apague a mano.
 */
function pintarHorarios() {
  const caja = document.getElementById('cfgHorarios');
  if (!caja) return;

  caja.innerHTML = _horarios.map((tramos, dia) => {
    const cerrado = !tramos.length;
    return `
      <div class="tienda-dia ${cerrado ? 'cerrado' : ''}" data-dia="${dia}">
        <button class="tienda-switch" data-dia-abrir aria-checked="${!cerrado}"
                title="${cerrado ? 'Abrir este día' : 'Cerrar todo el día'}"></button>
        <span class="tienda-dia__nombre">${DIAS[dia]}</span>
        ${cerrado ? '<span class="tienda-dia__cerrado">Cerrado todo el día</span>' : `
          <div class="tienda-dia__tramos">
            ${tramos.map((t, i) => `
              <span class="tienda-dia__tramo">
                <input type="time" data-tramo="${i}" data-punta="desde" value="${escHtml(t.desde)}">
                <span>a</span>
                <input type="time" data-tramo="${i}" data-punta="hasta" value="${escHtml(t.hasta)}">
                ${tramos.length > 1 ? `<button class="pc-btn danger" data-quitar-tramo="${i}"
                    title="Quitar este tramo"><span class="material-icons">close</span></button>` : ''}
              </span>`).join('')}
            ${tramos.length < 2
              ? '<button class="pc-btn" data-sumar-tramo>+ Otro tramo</button>' : ''}
          </div>`}
      </div>`;
  }).join('')
  + `<button class="pc-btn" id="cfgCopiarHabiles" style="margin-top:8px">
       <span class="material-icons">content_copy</span> Copiar el lunes a los días hábiles
     </button>`;

  const texto = document.getElementById('cfgHorariosTexto');
  if (texto) {
    texto.innerHTML = 'Así se va a leer en la tienda:<br><b>'
      + escHtml(textoDeHorarios(_horarios) || 'sin horarios') + '</b>';
  }
}

function pintarRubros() {
  const caja = document.getElementById('cfgRubros');
  if (!caja) return;

  // Cuántos productos entrarían por cada rubro si se habilita. Se calcula sobre
  // el catálogo entero con las reglas del sync, no adivinando: habilitar un
  // rubro de 600 productos donde 53 tienen stock publica 53.
  //
  // Lo mismo por subrubro, que es lo que permite destildar "Abrochadora" dentro
  // de Librería sabiendo cuántos productos se van con él.
  const porRubro = new Map();
  for (const d of _catalogo) {
    const rubro = claveDeRubro(d.rubro);
    if (!rubro) continue;
    const actual = porRubro.get(rubro) || { total: 0, publicables: 0, subs: new Map() };
    actual.total++;
    // Se pregunta como si el rubro estuviera habilitado: interesa cuántos
    // entrarían, no cuántos entran hoy. Y sin mirar los subrubros excluidos,
    // que son justamente lo que se está por decidir en esta pantalla.
    const entra = !motivoDeNoPublicar(d, null);
    if (entra) actual.publicables++;

    const sub = claveDeRubro(d.sub_rubro);
    if (sub) {
      const s = actual.subs.get(sub) || { total: 0, publicables: 0 };
      s.total++;
      if (entra) s.publicables++;
      actual.subs.set(sub, s);
    }
    porRubro.set(rubro, actual);
  }

  const lista = [...porRubro.entries()].sort((a, b) => b[1].publicables - a[1].publicables);

  caja.innerHTML = lista.map(([rubro, n]) => {
    const prendido = _habilitados.includes(rubro);
    const excluidos = _subExcluidos[rubro] || [];

    // Solo los subrubros que aportan algo publicable. Los que no tienen nada
    // con stock ensucian la lista con filtros que no cambian nada.
    const subs = [...n.subs.entries()]
      .filter(([, s]) => s.publicables > 0)
      .sort((a, b) => b[1].publicables - a[1].publicables);

    const cuerpoSubs = subs.length ? `
      <div class="tienda-subrubros" data-subs-de="${escHtml(rubro)}"
           ${prendido ? '' : 'hidden'}>
        <div class="tienda-pista" style="margin:0 0 6px">
          Destildá lo que no quieras publicar de este rubro.
        </div>
        ${subs.map(([sub, s]) => `
          <label class="tienda-subrubro">
            <input type="checkbox" data-subrubro="${escHtml(sub)}"
                   data-subrubro-de="${escHtml(rubro)}"
                   ${excluidos.includes(sub) ? '' : 'checked'}>
            <span>${escHtml(nombreBonito(sub))}</span>
            <b>${s.publicables}</b>
          </label>`).join('')}
      </div>` : '';

    return `
      <div class="tienda-rubro-caja">
        <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;
                      cursor:pointer;border:1px solid var(--border);background:var(--card-bg)">
          <input type="checkbox" data-rubro="${escHtml(rubro)}"
                 ${prendido ? 'checked' : ''}
                 style="width:17px;height:17px;cursor:pointer">
          <span style="flex:1;min-width:0">
            <b style="font-size:13.5px">${escHtml(nombreBonito(rubro))}</b>
            <span style="display:block;font-size:11.5px;color:var(--text-muted)">
              ${n.publicables} con stock de ${n.total}${
                excluidos.length ? ` · ${excluidos.length} subrubro${
                  excluidos.length === 1 ? '' : 's'} sin publicar` : ''}
            </span>
          </span>
        </label>
        ${cuerpoSubs}
      </div>`;
  }).join('');

  // Los subrubros de un rubro apagado no se muestran: el rubro manda, así que
  // ahí no hay nada que decidir.
  caja.querySelectorAll('[data-rubro]').forEach(check => {
    check.addEventListener('change', () => {
      const subs = caja.querySelector(`[data-subs-de="${CSS.escape(check.dataset.rubro)}"]`);
      if (subs) subs.hidden = !check.checked;
    });
  });

  prepararBuscadorDeRubros(lista);
}

/**
 * Buscador de la lista de rubros.
 *
 * Con los subrubros adentro la lista pasó de veinte líneas a varios cientos, y
 * encontrar "Abrochadora" a mano dejó de ser posible. Busca por rubro y por
 * subrubro: escribir un subrubro trae el rubro del que cuelga, ya abierto.
 *
 * Sin `<datalist>`: con esta cantidad de opciones el desplegable nativo tapa
 * media pantalla apenas se toca el campo, no se puede estilar y duplica lo que
 * ya hace el filtrado en vivo, que además muestra el resultado en su lugar.
 *
 * Los que no coinciden se **esconden**, no se sacan del DOM: al guardar se leen
 * todas las casillas, y quitarlas perdería lo tildado en un rubro que no
 * coincide con lo que quedó escrito en el buscador.
 */
function prepararBuscadorDeRubros(lista) {
  const campo = document.getElementById('cfgBuscarRubro');
  const caja = document.getElementById('cfgRubros');
  if (!campo || !caja) return;

  const cuenta = document.getElementById('cfgBuscarCuenta');
  const limpiar = document.getElementById('cfgBuscarLimpiar');

  const filtrar = () => {
    const q = claveDeRubro(campo.value);
    if (limpiar) limpiar.hidden = !q;

    let visibles = 0;
    for (const bloque of caja.querySelectorAll('.tienda-rubro-caja')) {
      const check = bloque.querySelector('[data-rubro]');
      const rubro = check?.dataset.rubro || '';
      const subs = [...bloque.querySelectorAll('[data-subrubro]')]
        .map(c => c.dataset.subrubro);

      const porRubro = !q || rubro.includes(q);
      const porSub = !!q && subs.some(s => s.includes(q));
      const entra = porRubro || porSub;

      bloque.hidden = !entra;
      if (entra) visibles++;

      // Si el que coincide es un subrubro, se abre el rubro para mostrarlo,
      // aunque esté apagado: es lo que la persona fue a buscar.
      const cajaSubs = bloque.querySelector('[data-subs-de]');
      if (cajaSubs) {
        cajaSubs.hidden = q ? !porSub && !(porRubro && check?.checked)
                            : !check?.checked;
      }
      for (const fila of bloque.querySelectorAll('.tienda-subrubro')) {
        // La clave del dataset y no el texto de la fila: el texto arrastra el
        // número de productos y "12" haría coincidir cualquier cosa.
        const clave = fila.querySelector('[data-subrubro]')?.dataset.subrubro || '';
        const coincide = !q || clave.includes(q);
        fila.classList.toggle('tienda-subrubro--apagado', !!q && porSub && !coincide);
      }
    }

    if (cuenta) {
      cuenta.textContent = q
        ? `${visibles} de ${lista.length} rubros`
        : '';
    }
  };

  campo.addEventListener('input', filtrar);
  limpiar?.addEventListener('click', () => { campo.value = ''; filtrar(); campo.focus(); });
}

/* ── Entrada ──────────────────────────────────────────────────────────────── */

export async function renderTiendaAjustes(container, db) {
  _db = db;
  _tocado = false;

  container.innerHTML = `<div style="display:flex;flex-direction:column;gap:12px">
    ${Array(4).fill('<div class="skel skel-card" style="height:120px"></div>').join('')}
  </div>`;

  // La copia del cache puede estar vieja si alguien guardó desde otra PC. Si la
  // del server llega distinta se repinta la pantalla, pero solo mientras nadie
  // haya tocado nada: pisar un formulario a medio llenar es peor que mostrar un
  // dato viejo unos segundos.
  const alLlegarDelServer = frescos => {
    if (_tocado || !container.isConnected) return;
    if (JSON.stringify(frescos) === JSON.stringify(_config)) return;
    console.log('[tienda] la configuración cambió desde otra PC, se repinta');
    renderTiendaAjustes(container, db);
  };

  const [config, publicacion, catalogo] = await Promise.all([
    leerConfig(db, alLlegarDelServer),
    leerDocRapido(doc(db, 'tienda_config', 'publicacion'),
                  { etiqueta: 'tienda_config/publicacion', vacio: {} }),
    getCached('catalogo:all', async () => {
      const snap = await getDocs(query(collection(db, 'catalogo'), orderBy('nombre')));
      return snap.docs.map(d => ({ ...d.data(), doc_id: d.id }));
    }, { ttl: 10 * 60 * 1000, memOnly: true }),
  ]);

  _config = config;
  _tramos = (config.entrega.tramos || []).map(t => ({
    hasta_km: Number(t.hasta_km) || 0, precio: Number(t.precio) || 0,
  }));
  _horarios = normalizarHorarios(config.horarios);
  _habilitados = Array.isArray(publicacion?.rubros)
    ? publicacion.rubros.map(r => String(r).trim().toUpperCase()) : [];
  _subExcluidos = normalizarExcluidos(publicacion?.subrubros_excluidos);
  _catalogo = (catalogo || []).filter(d => d && d.doc_id)
    .map(d => (typeof d.doc_id === 'string' ? d : { ...d, doc_id: String(d.doc_id) }));

  const e = config.entrega;

  container.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px;align-items:start">

      <section class="tienda-bloque" style="background:var(--surface);border:1px solid var(--border);
               border-radius:12px;padding:18px 20px;margin:0">
        <h4>El local</h4>
        <label style="display:flex;align-items:center;gap:10px;margin-bottom:14px;cursor:pointer">
          <button class="tienda-switch" id="cfgAbierta" aria-checked="${config.abierta !== false}"></button>
          <span style="font-size:13.5px">
            <b id="cfgAbiertaTexto">${config.abierta !== false ? 'La tienda toma pedidos' : 'Tienda cerrada'}</b>
            <span style="display:block;font-size:11.5px;color:var(--text-muted)">
              Cerrada se puede mirar el catálogo, pero no se puede confirmar un pedido.
            </span>
          </span>
        </label>
        ${campo('cfgNombre', 'Nombre', config.nombre)}
        ${campo('cfgDireccion', 'Dirección', config.direccion)}
        ${campo('cfgTelefono', 'Teléfono', config.telefono)}
        ${campo('cfgWhatsapp', 'WhatsApp', config.whatsapp,
          { pista: 'Con código de país y sin signos: 5493517046684' })}
        ${campo('cfgEmail', 'Email', config.email)}
        <div class="tienda-campo">
          <label>Horarios de atención</label>
          <div id="cfgHorarios" class="tienda-horarios"></div>
          <div class="tienda-pista" id="cfgHorariosTexto"></div>
        </div>
        ${campo('cfgBanner', 'Aviso en la portada', config.banner,
          { placeholder: 'Vacío = sin aviso',
            pista: 'Una línea arriba de todo: "Cerramos por vacaciones del 1 al 10".' })}
      </section>

      <section class="tienda-bloque" style="background:var(--surface);border:1px solid var(--border);
               border-radius:12px;padding:18px 20px;margin:0">
        <h4>Entrega</h4>
        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13.5px">
            <input type="checkbox" id="cfgRetiro" ${e.retiro_habilitado !== false ? 'checked' : ''}
                   style="width:17px;height:17px;cursor:pointer">
            Retiro en el local
          </label>
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13.5px">
            <input type="checkbox" id="cfgDelivery" ${e.delivery_habilitado !== false ? 'checked' : ''}
                   style="width:17px;height:17px;cursor:pointer">
            Envío a domicilio
          </label>
        </div>

        <div class="tienda-dos">
          ${campo('cfgRadio', 'Radio máximo (km)', e.radio_max_km, { tipo: 'number' })}
          ${campo('cfgDemora', 'Demora que se promete', e.demora_texto)}
        </div>
        ${campo('cfgGratis', 'Envío gratis desde', e.envio_gratis_desde ?? '',
          { tipo: 'number', placeholder: 'Vacío = nunca',
            pista: 'Monto de productos, sin contar el envío.' })}
        ${campo('cfgMinimo', 'Pedido mínimo', e.pedido_minimo ?? '',
          { tipo: 'number', placeholder: 'Vacío = sin mínimo',
            pista: 'Preparar un pedido cuesta lo mismo valga $500 o $50.000. '
                 + 'Debajo del mínimo el checkout muestra cuánto falta y no deja confirmar.' })}

        <h4 style="margin-top:18px">Cuánto sale el envío</h4>
        <div id="cfgTramos"></div>
        <div class="tienda-pista" id="cfgTramosResumen" style="margin-top:10px;line-height:1.7"></div>
      </section>

      <section class="tienda-bloque" style="background:var(--surface);border:1px solid var(--border);
               border-radius:12px;padding:18px 20px;margin:0">
        <h4>Formas de pago</h4>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13.5px;
                      margin-bottom:14px">
          <input type="checkbox" id="cfgEfectivo"
                 ${config.pago?.efectivo_habilitado === true ? 'checked' : ''}
                 style="width:17px;height:17px;cursor:pointer">
          <span>Aceptar efectivo</span>
        </label>
        <div class="tienda-pista" style="margin-bottom:16px">
          Apagado, el checkout ofrece solo transferencia y la portada deja de
          prometer efectivo. Prenderlo lo vuelve a mostrar al instante, sin
          publicar la tienda de nuevo.
        </div>

        ${campo('cfgAlias', 'Alias', config.pago?.alias,
          { placeholder: 'libreria.liceo.mp' })}
        ${campo('cfgTitular', 'A nombre de', config.pago?.titular,
          { placeholder: 'María Brizuela' })}
        <div class="tienda-pista">
          Mientras estén vacíos, el checkout le dice al cliente que los datos se
          los pasan al confirmar. Cargados, los muestra y los deja copiar.
        </div>
      </section>

      <section class="tienda-bloque" style="background:var(--surface);border:1px solid var(--border);
               border-radius:12px;padding:18px 20px;margin:0">
        <h4>Rubros en la tienda</h4>
        <div class="tienda-pista" style="margin-bottom:12px">
          Lo tildado sale a la web. Un producto suelto se puede forzar o sacar
          desde el catálogo de la tienda, sin tocar el rubro entero.
        </div>

        <div class="tienda-buscador">
          <span class="material-icons tienda-buscador__lupa">search</span>
          <input type="text" id="cfgBuscarRubro" autocomplete="off" spellcheck="false"
                 placeholder="Buscar rubro o subrubro…">
          <button type="button" class="tienda-buscador__x" id="cfgBuscarLimpiar"
                  title="Limpiar" hidden>
            <span class="material-icons">close</span>
          </button>
        </div>
        <div class="tienda-pista" id="cfgBuscarCuenta" style="margin:6px 0 8px"></div>

        <div id="cfgRubros" style="display:flex;flex-direction:column;gap:6px;
                                   max-height:340px;overflow-y:auto"></div>
      </section>
    </div>

    <div style="display:flex;gap:12px;align-items:center;margin-top:18px;flex-wrap:wrap">
      <button class="pc-btn" id="cfgGuardar"
              style="padding:11px 26px;background:#4361ee;color:#fff;border-color:#4361ee;font-size:14px">
        <span class="material-icons">save</span> Guardar
      </button>
      <span id="cfgEstado" style="font-size:13px;color:var(--text-muted)"></span>
    </div>`;

  pintarTramos();
  pintarHorarios();
  pintarRubros();

  /* ── Eventos ── */
  const $ = sel => container.querySelector(sel);

  // Apenas alguien toca algo, la pantalla deja de repintarse sola aunque llegue
  // una versión más nueva del server.
  const marcarTocado = () => { _tocado = true; };
  container.addEventListener('input', marcarTocado);
  container.addEventListener('change', marcarTocado);
  container.addEventListener('click', marcarTocado);

  $('#cfgAbierta').addEventListener('click', () => {
    const abierta = $('#cfgAbierta').getAttribute('aria-checked') !== 'true';
    $('#cfgAbierta').setAttribute('aria-checked', String(abierta));
    $('#cfgAbiertaTexto').textContent = abierta ? 'La tienda toma pedidos' : 'Tienda cerrada';
  });

  $('#cfgTramos').addEventListener('click', ev => {
    if (ev.target.closest('#cfgAgregarTramo')) {
      const ultimo = _tramos[_tramos.length - 1];
      _tramos.push({ hasta_km: (ultimo?.hasta_km || 0) + 3, precio: ultimo?.precio || 1500 });
      pintarTramos();
      return;
    }
    const quitar = ev.target.closest('[data-quitar]');
    if (quitar) {
      _tramos.splice(Number(quitar.dataset.quitar), 1);
      pintarTramos();
    }
  });

  $('#cfgTramos').addEventListener('input', ev => {
    const entrada = ev.target.closest('[data-campo]');
    if (!entrada) return;
    const i = Number(entrada.closest('[data-tramo]').dataset.tramo);
    _tramos[i][entrada.dataset.campo] = Number(entrada.value) || 0;
    // Se repinta solo el resumen: repintar los campos mientras se escribe
    // pierde el cursor.
    pintarTramosResumen(_tramos);
  });

  // ── Horarios ──
  $('#cfgHorarios').addEventListener('click', ev => {
    const fila = ev.target.closest('[data-dia]');
    if (!fila) return;
    const dia = Number(fila.dataset.dia);

    if (ev.target.closest('#cfgCopiarHabiles')) return;

    if (ev.target.closest('[data-dia-abrir]')) {
      // Al reabrir un día se le pone el horario del lunes, que es lo que casi
      // siempre corresponde; dejarlo vacío obliga a tipear cuatro horas.
      _horarios[dia] = _horarios[dia].length
        ? []
        : (_horarios[0].length
            ? _horarios[0].map(t => ({ ...t }))
            : [{ desde: '09:00', hasta: '13:00' }]);
      pintarHorarios();
      return;
    }

    const quitar = ev.target.closest('[data-quitar-tramo]');
    if (quitar) {
      _horarios[dia].splice(Number(quitar.dataset.quitarTramo), 1);
      pintarHorarios();
      return;
    }

    if (ev.target.closest('[data-sumar-tramo]')) {
      _horarios[dia].push({ desde: '17:00', hasta: '20:30' });
      pintarHorarios();
    }
  });

  $('#cfgHorarios').addEventListener('change', ev => {
    const campo = ev.target.closest('[data-tramo]');
    if (!campo) return;
    const dia = Number(campo.closest('[data-dia]').dataset.dia);
    const tramo = _horarios[dia][Number(campo.dataset.tramo)];
    if (tramo) tramo[campo.dataset.punta] = campo.value;
    // Solo se repinta el texto de abajo: repintar la grilla mientras se elige
    // una hora cierra el reloj del navegador.
    const texto = document.getElementById('cfgHorariosTexto');
    if (texto) {
      texto.innerHTML = 'Así se va a leer en la tienda:<br><b>'
        + escHtml(textoDeHorarios(_horarios) || 'sin horarios') + '</b>';
    }
  });

  container.addEventListener('click', ev => {
    if (!ev.target.closest('#cfgCopiarHabiles')) return;
    const lunes = _horarios[0].map(t => ({ ...t }));
    for (let dia = 1; dia <= 4; dia++) _horarios[dia] = lunes.map(t => ({ ...t }));
    pintarHorarios();
  });

  $('#cfgGuardar').addEventListener('click', () => guardarTodo(container));
}

/* ── Guardar ──────────────────────────────────────────────────────────────── */

async function guardarTodo(container) {
  const $ = sel => container.querySelector(sel);
  const boton = $('#cfgGuardar');
  const estado = $('#cfgEstado');

  const elegidos = [...container.querySelectorAll('[data-rubro]')]
    .filter(c => c.checked).map(c => c.dataset.rubro);

  // Los subrubros destildados, solo dentro de los rubros que quedan prendidos:
  // guardar exclusiones de un rubro apagado sería ruido que después confunde.
  const excluidos = {};
  for (const check of container.querySelectorAll('[data-subrubro]')) {
    if (check.checked) continue;
    const rubro = check.dataset.subrubroDe;
    if (!elegidos.includes(rubro)) continue;
    (excluidos[rubro] ||= []).push(check.dataset.subrubro);
  }

  const entraron = elegidos.filter(r => !_habilitados.includes(r));
  const salieron = _habilitados.filter(r => !elegidos.includes(r));

  // Rubros donde cambió qué subrubros salen. Sus productos también hay que
  // revisarlos, aunque el rubro haya estado prendido desde antes.
  const mismos = (a = [], b = []) =>
    a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
  const rubrosConSubsCambiados = [...new Set([
    ...Object.keys(excluidos), ...Object.keys(_subExcluidos),
  ])].filter(r => !mismos(excluidos[r], _subExcluidos[r]));

  const cambioPublicacion = entraron.length || salieron.length
                         || rubrosConSubsCambiados.length;

  // Mover un rubro entero es cientos de escrituras y se ve en la tienda al
  // instante. Se avisa antes con el número puesto, no después.
  if (cambioPublicacion) {
    const tocados = [...new Set([...entraron, ...salieron, ...rubrosConSubsCambiados])];
    const afectados = _catalogo.filter(d => tocados.includes(claveDeRubro(d.rubro)));

    const sacadosPorSub = rubrosConSubsCambiados
      .flatMap(r => (excluidos[r] || []).map(s => nombreBonito(s)));

    const ok = await confirmDialog({
      title: 'Cambiar lo que se publica',
      message: [
        entraron.length ? `Entran: ${entraron.map(nombreBonito).join(', ')}.` : '',
        salieron.length ? `Salen: ${salieron.map(nombreBonito).join(', ')}.` : '',
        sacadosPorSub.length ? `Subrubros sin publicar: ${sacadosPorSub.join(', ')}.` : '',
        `Se van a revisar ${afectados.length.toLocaleString('es-AR')} productos y la tienda`,
        'va a cambiar en el momento.',
      ].filter(Boolean).join(' '),
      confirmText: 'Aplicar',
    });
    if (!ok) return;
  }

  boton.disabled = true;
  estado.textContent = 'Guardando…';

  const numero = (id) => {
    const v = $(id).value.trim();
    return v === '' ? null : Number(v);
  };
  const texto = (id) => $(id).value.trim() || null;

  try {
    const ajustes = {
      abierta: $('#cfgAbierta').getAttribute('aria-checked') === 'true',
      nombre: texto('#cfgNombre') || 'Librería Liceo',
      direccion: texto('#cfgDireccion'),
      telefono: texto('#cfgTelefono'),
      whatsapp: texto('#cfgWhatsapp'),
      email: texto('#cfgEmail'),
      // Un mapa por día y no un arreglo de arreglos: Firestore no admite
      // arreglos anidados y rechaza el documento entero.
      horarios: _horarios.map(tramos => ({ tramos })),
      // El texto se genera desde la estructura y no se edita a mano: dos
      // fuentes para lo mismo terminan diciendo cosas distintas, y la que
      // decide si la tienda abre es la estructura.
      horarios_texto: textoDeHorarios(_horarios),
      banner: texto('#cfgBanner'),
      entrega: {
        retiro_habilitado: $('#cfgRetiro').checked,
        delivery_habilitado: $('#cfgDelivery').checked,
        radio_max_km: numero('#cfgRadio') ?? 12,
        demora_texto: texto('#cfgDemora') || '24 a 48 hs',
        envio_gratis_desde: numero('#cfgGratis'),
        pedido_minimo: numero('#cfgMinimo') ?? 0,
        tramos: _tramos
          .filter(t => t.hasta_km > 0)
          .sort((a, b) => a.hasta_km - b.hasta_km)
          .map(t => ({ hasta_km: t.hasta_km, precio: Math.max(0, t.precio) })),
      },
      pago: {
        alias: texto('#cfgAlias'),
        titular: texto('#cfgTitular'),
        efectivo_habilitado: $('#cfgEfectivo').checked,
      },
      // El origen no se toca desde acá: está verificado contra Places y de esa
      // coordenada sale lo que paga cada cliente. Se conserva tal cual estaba.
      origen: _config.origen,
      origen_verificado: _config.origen_verificado,
      barrio: _config.barrio,
    };

    await setDoc(doc(_db, 'tienda_config', 'settings'), ajustes, { merge: true });

    if (cambioPublicacion) {
      await setDoc(doc(_db, 'tienda_config', 'publicacion'), {
        rubros: elegidos,
        subrubros_excluidos: excluidos,
      });

      const tocados = [...new Set([...entraron, ...salieron, ...rubrosConSubsCambiados])];
      const afectados = _catalogo
        .filter(d => tocados.includes(claveDeRubro(d.rubro)))
        .map(d => ({ id: d.doc_id, datos: d }));

      const { publicados, sacados } = await espejarLote(
        _db, afectados, elegidos,
        (hechos, total) => { estado.textContent = `Publicando… ${hechos} de ${total}`; },
        excluidos);

      estado.textContent = 'Actualizando la portada…';
      await recomputarRubros(_db,
        _catalogo.map(d => ({ datos: d })), elegidos, excluidos);

      _habilitados = elegidos;
      _subExcluidos = excluidos;
      invalidateCache('tienda:publicacion');
      estado.textContent = `Guardado. ${publicados} productos en la tienda, ${sacados} afuera.`;
    } else {
      estado.textContent = 'Guardado.';
    }

    _config = { ...(_config || {}), ...ajustes };
  } catch (err) {
    console.error('[tienda] configuración:', err);
    estado.textContent = 'No se pudo guardar.';
    alertDialog({
      title: 'No se pudo guardar',
      message: err?.code === 'permission-denied'
        ? 'La configuración de la tienda la puede cambiar solo un administrador.'
        : String(err?.message || err),
    });
  } finally {
    boton.disabled = false;
  }
}
