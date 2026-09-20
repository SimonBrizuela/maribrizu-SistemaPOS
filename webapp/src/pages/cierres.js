import { collection, getDocs, query, orderBy, where, limit, doc, updateDoc, setDoc, getDoc, runTransaction, Timestamp, writeBatch } from 'firebase/firestore';
import { getCached, invalidateCache, peekCacheValue } from '../cache.js';
import { onStoreChange } from '../store.js';
import { getFechaInicioDate, getFechaInicio, isVentaVarios2, isItemVarios2, fechaDMYtoYMD } from '../config.js';
import { confirmDialog, alertDialog, escHtml } from '../components/dialogs.js';
// Separar una caja que quedó con dos días adentro: la cuenta de los días y el
// plan de cómo queda cada caja viven aparte, sin Firestore ni DOM, para poder
// probarlos enteros (`tienda/pruebas/separar_caja.test.js`).
import {
  diasDeLaCaja, tieneDiasMezclados, cortesSugeridos, cortesDesdeMapa, armarGrupos,
  planDeSeparacion, idsLibres, diaCompleto,
} from '../cajas_dias.js';
import { numerosOcupados, ejecutarSeparacion, separacionPendiente, chequearIdLibre, cajaAbiertaAhora } from '../cajas_separar.js';
// Cómo se reparte cada renglón entre efectivo y transferencia. La regla vive
// ahí y tiene gemelo en `pos_system/utils/medios_de_pago.py`, que es el que
// arma el mismo cierre desde el POS. Ver tienda/pruebas/medios_pago.test.js.
import { repartoDeItem } from '../medios_de_pago.js';
// Los renglones fraccionados llegan con el nombre decorado y no cruzan contra
// el catálogo si se los busca tal cual.
import { buscarPorNombre } from '../nombre_item.js';

export async function renderCierres(container, db) {
  // Shell vacío al toque: mismo esqueleto que la pantalla final, para que no
  // salte el layout cuando llegan los datos.
  container.innerHTML = esqueletoCierresHTML();

  const fechaInicio    = await getFechaInicioDate(db);
  const fechaInicioStr = await getFechaInicio(db);

  // TTL corto: la caja abierta es crítica y debe reflejarse casi en tiempo real.
  // Catálogo + gastos se usan en el modal de cierre para calcular rentabilidad.
  // `ventas_por_dia` es la fuente de verdad para los totales (misma que Historial):
  // los campos total_* guardados en cierres_caja pueden quedar stale si una caja
  // multi-PC se cierra desde una sola PC y las demás siguen vendiendo → acá los
  // ignoramos y recomputamos por rango [apertura, cierre] contra los items.
  const [todosRaw, catalogo, gastosAll, itemsRaw, cajaActivaSnap] = await Promise.all([
    getCached('cierres:caja', async () => {
      const snap = await getDocs(query(collection(db, 'cierres_caja'), orderBy('fecha_apertura', 'desc')));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }, { ttl: 30 * 1000 }),
    getCached('catalogo:all', async () => {
      const snap = await getDocs(collection(db, 'catalogo'));
      return snap.docs.map(d => d.data());
    }, { ttl: 10 * 60 * 1000, memOnly: true }),
    getCached('gastos:all', async () => {
      const snap = await getDocs(query(collection(db, 'gastos'), orderBy('created_at', 'desc')));
      return snap.docs.map(d => d.data());
    }, { ttl: 60 * 1000 }),
    getCached('historial:ventas_dia:v3', async () => {
      const snap = await getDocs(query(collection(db, 'ventas_por_dia'), orderBy('fecha', 'desc')));
      return snap.docs.map(d => {
        const data  = d.data();
        const parts = d.id.split('_');
        const pcId  = parts.length >= 3 ? parts.slice(0, -2).join('_') : '';
        return { ...data, _pc_id: pcId };
      });
    }, { ttl: 60 * 1000 }),
    // caja_activa/current es la fuente de verdad sobre cuál caja está REALMENTE
    // abierta. Si un doc fantasma de cierres_caja quedó con fecha_cierre vacía
    // (bug: una PC desktop reabre su caja vieja pisando un cierre), la ignoramos.
    // Se lee del store (key pinned 'caja_activa:current', listener realtime) para
    // que el estado abierta/cerrada se refleje en vivo y el primer paint salga del
    // snapshot del server, no del cache stale del getDoc one-shot. El fetcher de
    // abajo es solo fallback si el store todavía no respondió.
    getCached('caja_activa:current', async () => {
      const s = await getDoc(doc(db, 'caja_activa', 'current'));
      return s.exists() ? s.data() : null;
    }, { ttl: 30 * 1000 }),
  ]);

  const items = normalizarItems(itemsRaw, fechaInicioStr);
  const aggregateInRange = (apertura, cierre) => agregarEnRango(items, apertura, cierre);

  // Ocultar cierres cerrados anteriores a fecha_inicio.
  // Las cajas abiertas se muestran siempre (para poder cerrarlas aunque sean viejas).
  const todos = todosRaw.filter(c => {
    const estaAbierta = !c.fecha_cierre || c.fecha_cierre === '';
    if (estaAbierta) return true;
    const d = toDate(c.fecha_apertura);
    return d && d >= fechaInicio;
  });

  // Separar cajas abiertas (sin fecha_cierre) de las cerradas.
  // Filtro adicional: solo aceptamos como "abierta" la que matchea
  // caja_activa/current.id. Así, si un doc fantasma quedó sin fecha_cierre (bug
  // de PC vieja que reabre su caja pisando un cierre), lo tratamos como
  // cerrada para la UI (no se suma a la tarjeta "Caja Abierta").
  const cajaActivaId = (cajaActivaSnap && cajaActivaSnap.status === 'open')
    ? (cajaActivaSnap.register_id != null ? String(cajaActivaSnap.register_id)
        : (cajaActivaSnap.id != null ? String(cajaActivaSnap.id) : null))
    : null;
  const cajasAbiertasRaw = todos.filter(c => {
    const sinCierre = !c.fecha_cierre || c.fecha_cierre === null || c.fecha_cierre === '';
    if (!sinCierre) return false;
    // Si caja_activa/current dice que la única abierta es otra, descartamos.
    if (cajaActivaId && c.register_id != null && String(c.register_id) !== cajaActivaId) {
      return false;
    }
    return true;
  });
  const _seenReg = new Set();
  const cajasAbiertas = [];
  for (const c of cajasAbiertasRaw) {
    const key = c.register_id != null ? String(c.register_id) : `_doc_${c.id}`;
    if (_seenReg.has(key)) continue;
    _seenReg.add(key);
    cajasAbiertas.push(c);
  }
  // Los docs filtrados (fantasmas reabiertos) los contamos como cerrados igual,
  // para que no desaparezcan de la tabla — usamos su fecha_cierre original si
  // la tienen, o la apertura como fallback (caso raro).
  const cierres = todos.filter(c => {
    if (c.fecha_cierre && c.fecha_cierre !== '') return true;
    if (cajaActivaId && c.register_id != null && String(c.register_id) !== cajaActivaId) {
      return true;  // fantasma: tratarla como cerrada para que aparezca en la tabla
    }
    return false;
  });

  // Caja abierta consolidada: totales computados desde `ventas_por_dia` en el
  // rango [apertura_mas_temprana, ahora]. Ignora los totales guardados en los
  // docs de cierres_caja (que pueden estar stale si no sincronizó una PC).
  let cajaAbierta = null;
  if (cajasAbiertas.length > 0) {
    const fechaAperturaRaw = cajasAbiertas.reduce(
      (min, c) => (!min || toDate(c.fecha_apertura) < toDate(min) ? c.fecha_apertura : min), null
    );
    const fechaAperturaDate = toDate(fechaAperturaRaw);
    const agg = aggregateInRange(fechaAperturaDate, null);

    cajaAbierta = {
      cajero:              cajasAbiertas.map(c => c.cajero || c.pc_id || 'PC').join(', '),
      fecha_apertura:      fechaAperturaRaw,
      monto_inicial:       cajasAbiertas[0]?.monto_inicial || 0,
      total_ventas:        agg.total_ventas,
      total_efectivo:      agg.total_efectivo,
      total_transferencia: agg.total_transferencia,
      total_retiros:       cajasAbiertas.reduce((s, c) => s + (c.total_retiros || 0), 0),
      total_transacciones: agg.total_transacciones,
      productos_vendidos:  agg.productos_vendidos,
      retiros:             cajasAbiertas.flatMap(c => c.retiros || []),
      _pcs:                cajasAbiertas.length,
    };
  }

  // Una fila por caja-doc (sin agrupar). El total proviene de los items
  // atribuidos a esa caja vía cash_register_id en ventas_por_dia — así una
  // caja multi-PC con su propio register_id se ve aparte y los totales no
  // se mezclan.
  // Para datos viejos (cierres_caja sin register_id consolidado), conservamos
  // los stats guardados en el doc; los recomputamos solo cuando hay un
  // register_id válido para filtrar.
  const sesiones = cierres.map(c => {
    const registerId = (c.register_id != null && c.register_id !== '') ? Number(c.register_id) : null;
    const s = {
      register_id:      registerId,
      fecha_apertura:   c.fecha_apertura,
      fecha_cierre:     c.fecha_cierre,
      cajero:           c.cajero || '-',
      pcs:              c.pc_id ? [c.pc_id] : [],
      monto_inicial:    Number(c.monto_inicial || 0),
      total_retiros:    Number(c.total_retiros || 0),
      monto_final:      Number(c.monto_final || 0),
      retiros:          c.retiros || [],
      pendiente_conteo: c.pendiente_conteo === true,
      _docs:            [c],
    };
    // Recomputar stats desde ventas_por_dia por register_id (fuente correcta:
    // las ventas llevan el cash_register_id que se setteó al momento de venta).
    // Si la caja no tiene register_id, caemos a los stats guardados en el doc.
    let dayOfMostVentas = null;
    if (registerId != null && Number.isFinite(registerId)) {
      let total_efectivo = 0, total_transferencia = 0;
      const ventasEf = new Set();
      const ventasTr = new Set();
      const ventas   = new Set();
      const prodMap  = {};
      const ventasPorDia = {};  // ymd -> total
      const diasDeLaFila = new Map();  // ymd -> { total, ventas } para detectar días pegados
      for (const it of items) {
        if (it.cash_register_id !== registerId) continue;
        const parte = repartoDeItem(it);
        const key   = `${it.pc_id}|${it.num_venta}`;
        total_efectivo      += parte.efectivo;
        total_transferencia += parte.transferencia;
        ventas.add(key);
        if (parte.efectivo)      ventasEf.add(key);
        if (parte.transferencia) ventasTr.add(key);
        if (!prodMap[it.producto]) prodMap[it.producto] = { product_name: it.producto, total_quantity: 0, total_amount: 0 };
        prodMap[it.producto].total_quantity += it.cantidad || 1;
        prodMap[it.producto].total_amount   += it.subtotal;
        if (it.fecha_ymd) {
          ventasPorDia[it.fecha_ymd] = (ventasPorDia[it.fecha_ymd] || 0) + it.subtotal;
          if (!diasDeLaFila.has(it.fecha_ymd)) {
            diasDeLaFila.set(it.fecha_ymd, { ymd: it.fecha_ymd, total: 0, ventas: new Set() });
          }
          const dia = diasDeLaFila.get(it.fecha_ymd);
          dia.total += it.subtotal;
          dia.ventas.add(key);
        }
      }
      s.total_efectivo           = total_efectivo;
      s.total_transferencia      = total_transferencia;
      s.total_ventas             = total_efectivo + total_transferencia;
      s.num_ventas_efectivo      = ventasEf.size;
      s.num_ventas_transferencia = ventasTr.size;
      s.total_transacciones      = ventas.size;
      s.productos_vendidos       = Object.values(prodMap).sort((a, b) => b.total_amount - a.total_amount);
      // Día operacional = el de mayor venta dentro de los items de esta caja.
      const top = Object.entries(ventasPorDia).sort((a, b) => b[1] - a[1])[0];
      if (top) dayOfMostVentas = top[0];
      // ¿La caja junta dos jornadas de verdad? Una que abre 20:30 y sigue
      // vendiendo al otro día es lo normal y no se marca; dos días con
      // actividad propia sí, que es lo que se puede separar.
      const resumenDias = [...diasDeLaFila.values()]
        .map(d => ({ ymd: d.ymd, total: d.total, tx: d.ventas.size }))
        .sort((a, b) => a.ymd.localeCompare(b.ymd));
      s._dias     = resumenDias;
      s._mezclada = tieneDiasMezclados(resumenDias);
      s._separando = c.separacion?.estado === 'en_curso' || c.separacion?.estado === 'revisar';
    } else {
      // Compat: usar los stats del doc cuando no hay register_id para filtrar
      s.total_efectivo           = Number(c.total_efectivo || 0);
      s.total_transferencia      = Number(c.total_transferencia || 0);
      s.total_ventas             = Number(c.total_ventas || 0);
      s.num_ventas_efectivo      = Number(c.num_ventas_efectivo || 0);
      s.num_ventas_transferencia = Number(c.num_ventas_transferencia || 0);
      s.total_transacciones      = Number(c.total_transacciones || 0);
      s.productos_vendidos       = c.productos_vendidos || [];
    }
    s.monto_esperado = (s.monto_inicial || 0) + s.total_efectivo - (s.total_retiros || 0);
    // Label de la fila: día con más ventas. Si no hay ventas, apertura. Si no, session_id.
    s.session_id = dayOfMostVentas || aperturaDayKey(c.fecha_apertura) || c.session_id || c.id;
    return s;
  })
  // Sort por DÍA OPERACIONAL (label) DESC; desempate por cierre DESC.
  // Así "2026-05-20" siempre queda arriba de "2026-05-16" aunque ambas cajas
  // hayan cerrado en el mismo minuto del 20/5.
  .sort((a, b) => {
    if (a.session_id !== b.session_id) {
      return (b.session_id || '').localeCompare(a.session_id || '');
    }
    return (toDate(b.fecha_cierre) || 0) - (toDate(a.fecha_cierre) || 0);
  });

  const totalCierres = sesiones.length;
  // Tarjetas "TOTAL ACUMULADO": suma directa de las filas (ya sin overlap,
  // cada item entra una sola vez vía su cash_register_id único).
  let totalVentas = 0, totalEfect = 0, totalTransf = 0;
  for (const s of sesiones) {
    totalVentas += s.total_ventas;
    totalEfect  += s.total_efectivo;
    totalTransf += s.total_transferencia;
  }

  // ID de la caja abierta (para cerrarla desde la web). Si hay varias PCs con
  // distinto register_id (raro tras la migracion), tomamos el primero.
  const cajaAbiertaId = cajaAbierta && cajasAbiertas.length > 0
    ? (cajasAbiertas[0].register_id != null ? cajasAbiertas[0].register_id : null)
    : null;
  // Próximo register_id sugerido para apertura (max actual + 1).
  const maxRegId = todos.reduce((m, c) => {
    const r = parseInt(c.register_id);
    return Number.isFinite(r) && r > m ? r : m;
  }, 0);
  const proximoRegId = maxRegId + 1;

  container.innerHTML = `
    ${cajaAbierta ? cajaAbiertaHTML(cajaAbierta, cajaAbiertaId) : sinCajaHTML(proximoRegId)}
    ${kpisCierresHTML({ totalCierres, totalVentas, totalEfect, totalTransf })}
    ${tablaCierresHTML(sesiones)}
  `;

  // Click en fila → abrir modal detallado.
  // El catálogo y los gastos se leen al ABRIR el detalle, no al dibujar la
  // pantalla: como esta pantalla ya no se redibuja con cada cambio, un costo
  // corregido en Control Total habría seguido mostrando el margen viejo hasta
  // salir y volver a entrar.
  container.querySelectorAll('.clickable-row').forEach(row => {
    row.addEventListener('click', () => {
      const idx = parseInt(row.dataset.idx);
      openCierreModal(sesiones[idx], indiceCatalogo(catalogo), gastosFrescos(gastosAll), db,
                      () => renderCierres(container, db),
                      { items, cierres: todosRaw });
    });
  });

  // Botón cerrar caja desde web — pasamos el monto_inicial y los retiros del doc
  // de cierres_caja para calcular monto_esperado correctamente.
  const btnCerrarWeb = container.querySelector('#btn-cerrar-caja-web');
  if (btnCerrarWeb && cajaAbiertaId != null) {
    btnCerrarWeb.addEventListener('click', () => {
      const cajaCtx = {
        registerId:    cajaAbiertaId,
        monto_inicial: cajasAbiertas[0]?.monto_inicial || 0,
        cajero:        cajasAbiertas[0]?.cajero || '',
        retiros:       cajaAbierta?.retiros || [],
        total_retiros: cajaAbierta?.total_retiros || 0,
      };
      openCerrarCajaModal(db, cajaCtx, () => {
        invalidateCache('cierres:caja');
        renderCierres(container, db);
      });
    });
  }

  // Botón abrir caja desde web
  const btnAbrirWeb = container.querySelector('#btn-abrir-caja-web');
  if (btnAbrirWeb) {
    btnAbrirWeb.addEventListener('click', () => {
      openAbrirCajaModal(db, proximoRegId, () => {
        invalidateCache('cierres:caja');
        renderCierres(container, db);
      });
    });
  }

  seguirCajaEnVivo(container, db, { fechaInicioStr, cajaAbiertaId });
}

// Índice del catálogo por nombre, para sacar el costo de cada producto al
// calcular el CMV del turno. `fallback` es lo que se leyó al dibujar, por si el
// store todavía no cargó el catálogo.
function indiceCatalogo(fallback) {
  const cat = peekCacheValue('catalogo:all');
  const lista = Array.isArray(cat) ? cat : (fallback || []);
  const porNombre = {};
  for (const p of lista) {
    const key = (p.nombre || '').toUpperCase().trim();
    if (key) porNombre[key] = p;
  }
  return porNombre;
}

function gastosFrescos(fallback) {
  const g = peekCacheValue('gastos:all');
  return Array.isArray(g) ? g : (fallback || []);
}

// ─── Refresco en vivo ─────────────────────────────────────────────────────
// Esta pantalla lee `ventas_por_dia` y `catalogo`, así que main.js la
// redibujaba entera con CADA venta del POS: con el local vendiendo se veía
// como recargas cortitas, y la tabla se iba sola arriba de todo. Ahora main.js
// la deja afuera de ese refresco global (ver la exclusión allá) y el refresco
// lo maneja esta pantalla:
//
//   · los seis números de la caja abierta se mueven en el lugar, sin tocar la
//     tabla ni el scroll — es lo único que cambia con cada venta;
//   · todo lo demás (la tabla de cierres y los cuatro totales de arriba) se
//     vigila con una huella. Si cambia, se redibuja entero. Sin eso la pantalla
//     se quedaba vieja cuando una PC cargaba el conteo de un cierre, mergeaba
//     su reporte al cerrar, o sincronizaba tarde una venta de una caja ya
//     cerrada.
let _cierresUnsub = null;
let _cierresReloj = null;

function _soltarSeguimiento() {
  if (_cierresUnsub) { try { _cierresUnsub(); } catch (_) {} _cierresUnsub = null; }
  if (_cierresReloj) { clearInterval(_cierresReloj); _cierresReloj = null; }
}

// Las fechas llegan como Timestamp vivo, como {seconds} del cache, o string.
function _claveFecha(v) {
  if (!v) return '';
  if (typeof v.toDate === 'function') return String(v.toDate().getTime());
  if (typeof v === 'object' && v.seconds !== undefined) return String(v.seconds);
  return String(v);
}

// Huella de lo que se ve FUERA del panel de la caja abierta.
// A propósito NO entra la cantidad total de items: cada venta la movería y
// volveríamos a redibujar toda la pantalla, que es justo lo que se quiere
// evitar. Solo se cuentan los renglones atribuidos a una caja que no es la
// abierta, que son los únicos que pueden cambiar un cierre ya cerrado.
export function huellaDeLaTabla(cierresRaw, itemsRaw, idAbierta) {
  const partes = [];
  for (const c of cierresRaw) {
    partes.push([
      c.id, c.register_id,
      _claveFecha(c.fecha_apertura), _claveFecha(c.fecha_cierre),
      c.total_ventas || 0, c.total_efectivo || 0, c.total_transferencia || 0,
      c.total_retiros || 0, c.total_transacciones || 0, c.monto_final || 0,
      c.pendiente_conteo ? 1 : 0, c.cajero || '',
    ].join(':'));
  }
  const abierta = idAbierta == null ? null : Number(idAbierta);
  let ajenos = 0;
  for (const it of itemsRaw) {
    const cr = it.cash_register_id;
    if (cr === null || cr === undefined || cr === '') continue;
    if (abierta !== null && Number(cr) === abierta) continue;
    ajenos++;
  }
  return `${ajenos}#${partes.join('|')}`;
}

function seguirCajaEnVivo(container, db, ctx) {
  _soltarSeguimiento();

  const { fechaInicioStr } = ctx;
  const idActual = ctx.cajaAbiertaId;

  // Recalcula la caja abierta con lo que ya tiene el store en memoria.
  // Cero lecturas a Firestore: son las mismas claves que pobló el listener.
  const recalcular = () => {
    const cierresRaw = peekCacheValue('cierres:caja');
    const itemsRaw   = peekCacheValue('historial:ventas_dia:v3');
    const activa     = peekCacheValue('caja_activa:current');
    if (!Array.isArray(cierresRaw) || !Array.isArray(itemsRaw)) return null;

    const activaId = (activa && activa.status === 'open')
      ? (activa.register_id != null ? String(activa.register_id)
          : (activa.id != null ? String(activa.id) : null))
      : null;

    const abiertas = [];
    const vistos = new Set();
    for (const c of cierresRaw) {
      if (c.fecha_cierre) continue;
      if (activaId && c.register_id != null && String(c.register_id) !== activaId) continue;
      const key = c.register_id != null ? String(c.register_id) : `_doc_${c.id}`;
      if (vistos.has(key)) continue;
      vistos.add(key);
      abiertas.push(c);
    }

    const id = abiertas.length && abiertas[0].register_id != null ? abiertas[0].register_id : null;
    const huella = huellaDeLaTabla(cierresRaw, itemsRaw, id);
    if (!abiertas.length) return { id: null, caja: null, huella };

    const aperturaRaw = abiertas.reduce(
      (min, c) => (!min || toDate(c.fecha_apertura) < toDate(min) ? c.fecha_apertura : min), null
    );
    const agg = agregarEnRango(normalizarItems(itemsRaw, fechaInicioStr), toDate(aperturaRaw), null);
    return {
      id,
      huella,
      caja: {
        cajero:              abiertas.map(c => c.cajero || c.pc_id || 'PC').join(', '),
        fecha_apertura:      aperturaRaw,
        monto_inicial:       abiertas[0]?.monto_inicial || 0,
        total_retiros:       abiertas.reduce((s, c) => s + (c.total_retiros || 0), 0),
        retiros:             abiertas.flatMap(c => c.retiros || []),
        _pcs:                abiertas.length,
        ...agg,
      },
    };
  };

  // Escribe los valores dentro de las tarjetas que ya están dibujadas. Devuelve
  // false si el panel no es el que espera, y ahí el que llama redibuja.
  const pintarEnElLugar = (caja) => {
    const panel = container.querySelector('.cj-caja--abierta');
    if (!panel) return false;

    const v = valoresCaja(caja);
    for (const [clave, texto] of Object.entries(v)) {
      const tile = panel.querySelector(`.cj-stat[data-cj="${clave}"]`);
      if (!tile) return false;
      const el = tile.querySelector('.cj-stat-v');
      if (el && el.textContent !== texto) el.textContent = texto;
      if (clave === 'retiros') tile.classList.toggle('cj-stat--neg', (caja.total_retiros || 0) > 0);
    }

    const meta = panel.querySelector('.cj-caja-meta');
    if (meta) {
      const txt = metaCaja(caja);
      if (meta.innerHTML !== txt) meta.innerHTML = txt;
    }

    // Los retiros se cargan desde el POS en el medio del turno: si aparece uno
    // nuevo hay que dibujar la lista, y eso ya no es mover un número.
    const enPantalla = panel.querySelectorAll('.cj-retiro').length;
    if (enPantalla !== (caja.retiros || []).length) return false;
    return true;
  };

  let huellaActual = (recalcular() || {}).huella;

  const refrescar = () => {
    if (!document.body.contains(container)) { _soltarSeguimiento(); return; }
    // Con un modal abierto no se toca nada: el usuario puede estar cargando el
    // efectivo contado o cerrando la caja.
    if (document.querySelector('.modal-overlay')) return;

    const r = recalcular();
    if (!r) return;

    // Cambió algo de la tabla o de los totales de arriba: otra caja abierta,
    // un cierre con su conteo cargado, un reporte mergeado por una PC, o una
    // venta vieja que sincronizó tarde. Ahí sí va el redibujo entero — son
    // eventos de a lo sumo unas pocas veces por día.
    // La barra de arriba dice "Actualizado: hh:mm:ss". La pone main.js al
    // terminar de cargar una página, y acá ya no recargamos ninguna: sin este
    // aviso marcaría la hora en que entraste mientras los números se mueven.
    const marcarFresco = () => document.dispatchEvent(new CustomEvent('ll:datos-frescos'));

    if (r.huella !== huellaActual || String(r.id) !== String(idActual)) {
      renderCierres(container, db).then(marcarFresco, () => {});
      return;
    }
    if (!r.caja) return;                      // sin caja abierta no hay nada que mover
    if (!pintarEnElLugar(r.caja)) { renderCierres(container, db).then(marcarFresco, () => {}); return; }
    marcarFresco();
  };

  // Una venta toca `ventas_por_dia` y `catalogo` casi al mismo tiempo: sin este
  // respiro recalculábamos dos veces por venta.
  let timer = null;
  const pedirRefresco = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; refrescar(); }, 200);
  };

  _cierresUnsub = onStoreChange((col) => {
    if (col !== 'ventas_por_dia' && col !== 'cierres_caja' && col !== 'caja_activa') return;
    pedirRefresco();
  });

  // El "abierta hace 3 h 20 m" se queda viejo solo: lo movemos cada minuto.
  if (idActual != null) _cierresReloj = setInterval(refrescar, 60 * 1000);
}

// ─── Cálculo de los totales ───────────────────────────────────────────────

// Items de `ventas_por_dia` normalizados. Cada uno lleva su `cash_register_id`
// (las ventas nuevas) → permite atribuir el item a SU caja sin doble suma
// cuando hay cajas que se solapan. Los items viejos no tienen ese campo →
// fallback al rango temporal por día.
function normalizarItems(itemsRaw, fechaInicioStr) {
  return (itemsRaw || [])
    .filter(it => {
      if (it.deleted === true) return false;
      if (isItemVarios2(it)) return false;
      return fechaDMYtoYMD(it.fecha) >= fechaInicioStr;
    })
    .map(it => {
      let dt = null;
      if (it.fecha_dt) {
        dt = typeof it.fecha_dt.toDate === 'function' ? it.fecha_dt.toDate()
           : it.fecha_dt.seconds !== undefined
             ? new Date(it.fecha_dt.seconds * 1000 + Math.floor((it.fecha_dt.nanoseconds || 0) / 1e6))
             : new Date(it.fecha_dt);
        if (dt && isNaN(dt)) dt = null;
      }
      if (!dt) {
        const ymdStr = fechaDMYtoYMD(it.fecha);
        const hora = (it.hora || '00:00:00').padEnd(8, ':00').slice(0, 8);
        if (ymdStr) {
          const parsed = new Date(`${ymdStr}T${hora}-03:00`);
          if (!isNaN(parsed)) dt = parsed;
        }
      }
      // cash_register_id puede venir como number, string, o ausente (ventas viejas).
      let crId = it.cash_register_id;
      if (crId !== null && crId !== undefined && crId !== '') {
        const n = Number(crId);
        crId = Number.isFinite(n) ? n : null;
      } else {
        crId = null;
      }
      return {
        pc_id:             it._pc_id || it.pc_id || '',
        num_venta:         it.num_venta,
        subtotal:          Number(it.subtotal || 0),
        cantidad:          Number(it.cantidad || 0),
        tipo_pago:         it.tipo_pago || '',
        // Reparto entre los dos medios de pago, tal como lo dejó el POS. Los
        // renglones viejos no lo traen y `repartoDeItem` cae al tipo_pago.
        monto_efectivo:      it.monto_efectivo,
        monto_transferencia: it.monto_transferencia,
        producto:          it.producto || it.product_name || '-',
        fecha_dt:          dt,
        fecha_ymd:         fechaDMYtoYMD(it.fecha),  // 'YYYY-MM-DD' del día de la venta
        cash_register_id:  crId,
      };
    });
}

// Agrega items cuyo `fecha_dt` cae en [apertura, cierre] (caja abierta actual).
// Solo se usa para la tarjeta "Caja Abierta" — ahí sí queremos rango temporal.
function agregarEnRango(items, apertura, cierre) {
  const ini = apertura && !isNaN(apertura) ? apertura.getTime() : -Infinity;
  const fin = cierre   && !isNaN(cierre)   ? cierre.getTime()   : Infinity;
  let total_efectivo = 0, total_transferencia = 0;
  const ventasEf = new Set();
  const ventasTr = new Set();
  const ventas   = new Set();
  const prodMap  = {};
  for (const it of items) {
    if (!it.fecha_dt) continue;
    const t = it.fecha_dt.getTime();
    if (t < ini || t > fin) continue;
    const parte = repartoDeItem(it);
    const key   = `${it.pc_id}|${it.num_venta}`;
    total_efectivo      += parte.efectivo;
    total_transferencia += parte.transferencia;
    ventas.add(key);
    if (parte.efectivo)      ventasEf.add(key);
    if (parte.transferencia) ventasTr.add(key);
    if (!prodMap[it.producto]) {
      prodMap[it.producto] = { product_name: it.producto, total_quantity: 0, total_amount: 0 };
    }
    prodMap[it.producto].total_quantity += it.cantidad || 1;
    prodMap[it.producto].total_amount   += it.subtotal;
  }
  return {
    total_ventas:             total_efectivo + total_transferencia,
    total_efectivo,
    total_transferencia,
    num_ventas_efectivo:      ventasEf.size,
    num_ventas_transferencia: ventasTr.size,
    // Ventas distintas, no la suma: una mixta figura en las dos listas
    // porque dejó plata en las dos.
    total_transacciones:      ventas.size,
    productos_vendidos:       Object.values(prodMap).sort((a, b) => b.total_amount - a.total_amount),
  };
}

// ─── Markup de la pantalla ────────────────────────────────────────────────
// Separado del fetch para poder dibujar la pantalla con datos de prueba sin
// pegarle a Firebase (previsualización en el navegador a distintos anchos).
// Los estilos viven en `styles/main.css`, bloque "CIERRES DE CAJA (.cj-*)".

// Hace cuánto está abierta la caja, en criollo.
function tiempoAbierto(apertura) {
  if (!apertura) return '-';
  const aDate = toDate(apertura);
  if (!aDate || isNaN(aDate)) return '-';
  const mins = Math.round((new Date() - aDate) / 60000);
  const hrs  = Math.floor(mins / 60);
  const min  = mins % 60;
  return hrs > 0 ? `${hrs} h ${min} m` : `${min} m`;
}

// `clave` etiqueta la tarjeta para poder actualizar su número sin redibujar el
// panel entero (ver seguirCajaEnVivo). Sin eso habría que ubicarlas por
// posición, y mover una en el markup mezclaría los valores sin que se note.
function statHTML(clave, titulo, valor, extraClase = '') {
  return `
    <div class="cj-stat ${extraClase}" data-cj="${clave}">
      <span class="cj-stat-t">${titulo}</span>
      <span class="cj-stat-v">${valor}</span>
    </div>`;
}

// Los seis números del panel, en el mismo formato que los pinta el markup.
// Una sola fuente: la usan el dibujo inicial y el refresco en vivo.
export function valoresCaja(caja) {
  const retiros = caja.total_retiros || 0;
  return {
    inicial:       `$${fmt(caja.monto_inicial || 0)}`,
    ventas:        `$${fmt(caja.total_ventas || 0)}`,
    efectivo:      `$${fmt(caja.total_efectivo || 0)}`,
    transferencia: `$${fmt(caja.total_transferencia || 0)}`,
    transacciones: String(caja.total_transacciones || 0),
    retiros:       retiros > 0 ? `-$${fmt(retiros)}` : `$${fmt(0)}`,
  };
}

// Línea de "Cajero: X · abierta hace Y · apertura Z".
function metaCaja(caja) {
  const quien = caja._pcs > 1
    ? `${caja._pcs} cajas activas`
    : `Cajero: ${escHtml(caja.cajero || 'Sin cajero')}`;
  return `${quien} · abierta hace ${tiempoAbierto(caja.fecha_apertura)} · apertura ${fmtDT(parseArDate(caja.fecha_apertura))}`;
}

export function cajaAbiertaHTML(caja, registerId) {
  const retirosLista = caja.retiros || [];
  const totalRetiros = caja.total_retiros || 0;
  const v = valoresCaja(caja);

  return `
    <section class="cj-caja cj-caja--abierta">
      <div class="cj-caja-head">
        <div class="cj-caja-id">
          <div class="cj-caja-titulo">
            <span class="cj-estado cj-estado--abierta"><span class="cj-punto"></span>Abierta</span>
            <h3>Caja${registerId != null ? ` #${registerId}` : ''}</h3>
          </div>
          <p class="cj-caja-meta">${metaCaja(caja)}</p>
        </div>
        ${registerId != null ? `
        <button type="button" id="btn-cerrar-caja-web" class="cj-btn cj-btn--cerrar">
          <span class="material-icons">lock</span>Cerrar caja
        </button>` : ''}
      </div>

      <div class="cj-stats">
        ${statHTML('inicial',       'Monto inicial',   v.inicial)}
        ${statHTML('ventas',        'Ventas en curso', v.ventas, 'cj-stat--fuerte')}
        ${statHTML('efectivo',      'Efectivo',        v.efectivo)}
        ${statHTML('transferencia', 'Transferencias',  v.transferencia)}
        ${statHTML('transacciones', 'Transacciones',   v.transacciones)}
        ${statHTML('retiros',       'Retiros',         v.retiros, totalRetiros > 0 ? 'cj-stat--neg' : '')}
      </div>

      ${retirosLista.length > 0 ? `
      <div class="cj-retiros">
        <div class="cj-retiros-t">Retiros de esta sesión</div>
        ${retirosLista.map(r => `
          <div class="cj-retiro">
            <span>${escHtml(r.reason || r.motivo || 'Retiro')}</span>
            <b>-$${fmt(r.amount || r.monto || 0)}</b>
          </div>`).join('')}
      </div>` : ''}
    </section>`;
}

export function sinCajaHTML(proximoRegId) {
  return `
    <section class="cj-caja cj-caja--cerrada">
      <div class="cj-caja-head">
        <div class="cj-caja-id">
          <div class="cj-caja-titulo">
            <span class="cj-estado cj-estado--cerrada"><span class="cj-punto"></span>Sin caja abierta</span>
          </div>
          <p class="cj-caja-meta">Nadie está vendiendo contra una caja ahora mismo. La próxima será la <b>#${proximoRegId}</b>.</p>
        </div>
        <button type="button" id="btn-abrir-caja-web" class="cj-btn cj-btn--abrir">
          <span class="material-icons">lock_open</span>Abrir caja #${proximoRegId}
        </button>
      </div>
    </section>`;
}

function kpiHTML(icono, tono, titulo, valor) {
  return `
    <article class="cj-kpi">
      <div class="cj-kpi-top">
        <span class="cj-kpi-ico cj-kpi-ico--${tono}"><span class="material-icons">${icono}</span></span>
        <span class="cj-kpi-t">${titulo}</span>
      </div>
      <div class="cj-kpi-v">${valor}</div>
    </article>`;
}

export function kpisCierresHTML({ totalCierres, totalVentas, totalEfect, totalTransf }) {
  return `
    <div class="cj-kpis">
      ${kpiHTML('lock_clock',   'violeta', 'Cierres',        String(totalCierres))}
      ${kpiHTML('attach_money', 'verde',   'Total vendido',  `$${fmt(totalVentas)}`)}
      ${kpiHTML('payments',     'azul',    'Efectivo',       `$${fmt(totalEfect)}`)}
      ${kpiHTML('swap_horiz',   'naranja', 'Transferencias', `$${fmt(totalTransf)}`)}
    </div>`;
}

function filaCierreHTML(c, i) {
  const retiros = c.total_retiros || 0;
  const cajero  = (c.cajero && c.cajero !== '-') ? escHtml(c.cajero) : '';
  const pcLabel = (c.pcs || []).length > 1
    ? ` <span class="cj-sub">${c.pcs.length} PCs</span>` : '';
  const pendBadge = c.pendiente_conteo
    ? ' <span class="cj-pend">Pendiente</span>' : '';
  // Dos jornadas pegadas en una sola caja: la fila muestra el doble de plata
  // del día que dice. Se avisa acá porque es donde se mira.
  const diasBadge = c._separando
    ? ' <span class="cj-dias cj-dias--alerta">Separación a medio hacer</span>'
    : (c._mezclada ? ` <span class="cj-dias">${c._dias.length} días</span>` : '');
  const titulo = c._separando
    ? 'Quedó una separación sin terminar — click para retomarla'
    : c._mezclada
      ? `Esta caja junta ventas de ${c._dias.length} días — click para separarla`
      : c.pendiente_conteo
        ? 'Cierre pendiente de conteo — click para cargar'
        : 'Ver detalle del cierre';

  return `
    <tr class="clickable-row" data-idx="${i}" title="${titulo}">
      <td class="cj-dia"><b>${c.session_id || '-'}</b>${pcLabel}${pendBadge}${diasBadge}</td>
      <td class="cj-fecha">${fmtDT(parseArDate(c.fecha_apertura))}</td>
      <td class="cj-fecha cie-col-cierre">${fmtDT(parseArDate(c.fecha_cierre))}</td>
      <td class="cj-c"><span class="badge badge-blue">${c.total_transacciones || 0}</span></td>
      <td class="cj-n cj-total">$${fmt(c.total_ventas)}</td>
      <td class="cj-n cie-col-efectivo">$${fmt(c.total_efectivo)}</td>
      <td class="cj-n cie-col-transferencia">$${fmt(c.total_transferencia)}</td>
      <td class="cj-n cie-col-retiros ${retiros > 0 ? 'cj-neg' : 'cj-vacio'}">${retiros > 0 ? `-$${fmt(retiros)}` : '—'}</td>
      <td class="${cajero ? '' : 'cj-vacio'}">${cajero || '—'}</td>
    </tr>`;
}

export function tablaCierresHTML(sesiones) {
  return `
    <div class="table-card cj-tabla-card">
      <div class="table-card-header cj-tabla-head">
        <h3><span class="material-icons">lock</span>Cierres de caja</h3>
        <span class="cj-tabla-hint">${sesiones.length} ${sesiones.length === 1 ? 'cierre' : 'cierres'} · click en una fila para ver el detalle</span>
      </div>
      <div class="table-wrap cj-tabla-wrap">
        <table class="cj-tabla">
          <thead><tr>
            <th>Día</th>
            <th>Apertura</th>
            <th class="cie-col-cierre">Cierre</th>
            <th class="cj-c">Ventas</th>
            <th class="cj-n">Total</th>
            <th class="cj-n cie-col-efectivo">Efectivo</th>
            <th class="cj-n cie-col-transferencia">Transferencia</th>
            <th class="cj-n cie-col-retiros">Retiros</th>
            <th>Cajero</th>
          </tr></thead>
          <tbody id="cierresBody">
            ${sesiones.length === 0
              ? '<tr><td colspan="9" class="cj-tabla-vacia">Sin cierres registrados</td></tr>'
              : sesiones.map(filaCierreHTML).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

// Esqueleto de carga: mismas cajas y mismas alturas que la pantalla real.
export function esqueletoCierresHTML() {
  const stat = '<div class="cj-stat"><div class="skel" style="height:10px;width:70%;border-radius:4px"></div><div class="skel" style="height:19px;width:85%;border-radius:5px;margin-top:9px"></div></div>';
  const kpi  = '<article class="cj-kpi"><div class="skel" style="height:22px;width:60%;border-radius:5px"></div><div class="skel" style="height:26px;width:85%;border-radius:6px;margin-top:12px"></div></article>';
  const fila = '<tr><td colspan="9" style="padding:7px 16px"><div class="skel" style="height:26px;border-radius:6px"></div></td></tr>';
  return `
    <section class="cj-caja">
      <div class="cj-caja-head">
        <div class="cj-caja-id">
          <div class="skel" style="height:21px;width:180px;border-radius:6px"></div>
          <div class="skel" style="height:12px;width:min(340px,100%);border-radius:5px;margin-top:9px"></div>
        </div>
      </div>
      <div class="cj-stats">${Array(6).fill(stat).join('')}</div>
    </section>
    <div class="cj-kpis">${Array(4).fill(kpi).join('')}</div>
    <div class="table-card cj-tabla-card">
      <div class="table-card-header cj-tabla-head">
        <h3><span class="material-icons">lock</span>Cierres de caja</h3>
      </div>
      <div class="table-wrap cj-tabla-wrap">
        <table class="cj-tabla">
          <thead><tr>
            <th>Día</th><th>Apertura</th><th class="cie-col-cierre">Cierre</th>
            <th class="cj-c">Ventas</th><th class="cj-n">Total</th>
            <th class="cj-n cie-col-efectivo">Efectivo</th>
            <th class="cj-n cie-col-transferencia">Transferencia</th>
            <th class="cj-n cie-col-retiros">Retiros</th><th>Cajero</th>
          </tr></thead>
          <tbody>${Array(8).fill(fila).join('')}</tbody>
        </table>
      </div>
    </div>`;
}

// ─── Modal: Cerrar caja desde web ─────────────────────────────────────────
// Lee `ventas` filtradas por cash_register_id, calcula totales (efectivo,
// transferencia, transacciones, productos_vendidos) y los escribe a
// cierres_caja/{id} junto con fecha_cierre y pendiente_conteo:true.
// Después marca caja_activa/current como cerrada — los listeners desktop
// detectan y, si tienen la caja abierta local, mergean también su reporte.
// Cuando NO hay PCs online, los stats igual aparecen porque la web los calcula.
export function openCerrarCajaModal(db, ctx, onDone) {
  const { registerId, monto_inicial = 0, cajero = '', retiros = [], total_retiros = 0 } = ctx;
  document.querySelector('.modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:480px">
      <div class="modal-header cj-mh cj-mh--rojo">
        <div class="cj-mh-id">
          <span class="material-icons">lock</span>
          <h3>Cerrar caja #${registerId}</h3>
        </div>
        <button class="modal-close cj-mh-x"><span class="material-icons">close</span></button>
      </div>
      <div class="modal-body" style="padding:20px 22px">
        <div style="background:var(--tint-yellow-bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:14px;display:flex;gap:10px">
          <span class="material-icons" style="color:var(--tint-orange-fg)">info</span>
          <div style="font-size:12.5px;color:var(--tint-orange-fg);line-height:1.45">
            La web calculará los totales desde las ventas y cerrará la caja.
            Las PCs conectadas también la marcarán como cerrada.
            Quedará <b>pendiente de conteo</b>: cargá después el efectivo real.
          </div>
        </div>
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:14px">¿Confirmás cerrar la caja <b>#${registerId}</b>?</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="btn-cancel-cerrar" style="background:var(--border);color:var(--text-muted);border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer">Cancelar</button>
          <button id="btn-confirm-cerrar" style="background:#b91c1c;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:6px">
            <span class="material-icons" style="font-size:16px">lock</span>Cerrar caja
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.querySelector('#btn-cancel-cerrar').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  const btn = overlay.querySelector('#btn-confirm-cerrar');
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.innerHTML = '<span class="material-icons" style="font-size:16px">hourglass_empty</span>Calculando...';
    try {
      const nowDate = new Date();
      const nowIso = nowDate.toISOString();
      const nowTs = Timestamp.fromDate(nowDate);
      const sessionId = nowDate.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

      // 1. Calcular y escribir todos los stats al doc cierres_caja/{id}
      await calcularYMergearStatsCaja(db, registerId, {
        monto_inicial, cajero, retiros, total_retiros,
        fecha_cierre: nowTs, session_id: sessionId,
        pendiente_conteo: true, cerrado_desde: 'web', updated_at: nowIso,
      });

      // 2. Marcar caja_activa/current como cerrada → dispara listeners desktop.
      //    Las PCs con la caja abierta local también van a mergear su reporte,
      //    pero los stats principales ya están escritos por la web.
      await setDoc(doc(db, 'caja_activa', 'current'), {
        status:      'closed',
        id:          Number(registerId),
        register_id: Number(registerId),
        session_id:  sessionId,
        updated_at:  nowIso,
      }, { merge: true });

      close();
      if (typeof onDone === 'function') onDone();
    } catch (e) {
      btn.disabled = false; btn.innerHTML = '<span class="material-icons" style="font-size:16px">lock</span>Cerrar caja';
      alertDialog({ title: 'Error', message: 'No se pudo cerrar la caja: ' + escHtml(e?.message || e), type: 'error' });
    }
  });
}

// ─── Helper: calcular stats desde ventas + ventas_por_dia y mergear ───────
// Usado al cerrar caja desde web Y al recalcular un cierre con stats vacíos.
// extras: campos extra a mergear al doc (fecha_cierre, pendiente_conteo, etc.)
async function calcularYMergearStatsCaja(db, registerId, extras = {}) {
  // ── Items de la caja desde `ventas_por_dia` ──
  // Antes leíamos `ventas` con limit(500): para una caja vieja (fuera de las
  // 500 más recientes) los stats salían 0 → cierre con 0 ventas falso.
  // Ahora vamos directo a `ventas_por_dia` filtrando por cash_register_id —
  // es la fuente con atribución correcta y sin limit artificial.
  const itemsSnap = await getDocs(query(
    collection(db, 'ventas_por_dia'),
    where('cash_register_id', '==', Number(registerId))
  ));

  let total_efectivo = 0, total_transferencia = 0;
  const ventasEf = new Set();
  const ventasTr = new Set();
  const ventas   = new Set();
  const productosMap = {};
  let lastItemDt = null;
  for (const d of itemsSnap.docs) {
    const it = d.data();
    if (it.deleted === true) continue;
    if (isItemVarios2(it)) continue;
    const subtotal = Number(it.subtotal || 0);
    // Clave única de venta: incluye pc del doc id para no colisionar entre PCs
    const parts = d.id.split('_');
    const pcId = parts.length >= 3 ? parts.slice(0, -2).join('_') : '';
    const nvKey = `${pcId}|${it.num_venta}`;
    const parte = repartoDeItem(it);
    total_efectivo      += parte.efectivo;
    total_transferencia += parte.transferencia;
    ventas.add(nvKey);
    if (parte.efectivo)      ventasEf.add(nvKey);
    if (parte.transferencia) ventasTr.add(nvKey);
    const nombre = (it.producto || it.product_name || '').trim();
    if (nombre) {
      if (!productosMap[nombre]) productosMap[nombre] = { product_name: nombre, total_quantity: 0, total_amount: 0 };
      productosMap[nombre].total_quantity += Number(it.cantidad || it.quantity || 0);
      productosMap[nombre].total_amount   += subtotal;
    }
    // Trackear hora del último item, para usar como fecha_cierre en auto-orphan
    let itDt = null;
    if (it.fecha_dt) {
      itDt = typeof it.fecha_dt.toDate === 'function' ? it.fecha_dt.toDate()
           : it.fecha_dt.seconds !== undefined
             ? new Date(it.fecha_dt.seconds * 1000)
             : new Date(it.fecha_dt);
    }
    if (!itDt && it.fecha) {
      const ymd = fechaDMYtoYMD(it.fecha);
      const hora = (it.hora || '20:00:00').padEnd(8, ':00').slice(0, 8);
      if (ymd) {
        const parsed = new Date(`${ymd}T${hora}-03:00`);
        if (!isNaN(parsed)) itDt = parsed;
      }
    }
    if (itDt && (!lastItemDt || itDt > lastItemDt)) lastItemDt = itDt;
  }
  const num_ventas_efectivo      = ventasEf.size;
  const num_ventas_transferencia = ventasTr.size;
  const total_ventas             = total_efectivo + total_transferencia;
  // Ventas distintas: una mixta aportó a las dos columnas y sumarlas la
  // contaría dos veces.
  const total_transacciones      = ventas.size;
  const monto_inicial = Number(extras.monto_inicial) || 0;
  const total_retiros = Number(extras.total_retiros) || 0;
  const monto_esperado = monto_inicial + total_efectivo - total_retiros;

  const productos_vendidos = Object.values(productosMap).sort((a, b) => b.total_amount - a.total_amount);

  // En auto-orphan: usar la hora de la última venta como fecha_cierre real
  // (no `now`). Refleja cuándo dejó de operar la caja, no cuándo se limpió.
  const finalExtras = { ...extras };
  if (extras.cerrado_desde === 'auto-orphan' && lastItemDt) {
    finalExtras.fecha_cierre = Timestamp.fromDate(lastItemDt);
  }

  // Mergear todos los campos calculados + cualquier extra que vino del caller
  await setDoc(doc(db, 'cierres_caja', String(registerId)), {
    register_id:               Number(registerId),
    monto_inicial:             monto_inicial,
    monto_esperado:            monto_esperado,
    total_ventas:              total_ventas,
    total_efectivo:            total_efectivo,
    total_transferencia:       total_transferencia,
    total_transacciones:       total_transacciones,
    num_ventas_efectivo:       num_ventas_efectivo,
    num_ventas_transferencia:  num_ventas_transferencia,
    total_retiros:             total_retiros,
    retiros:                   extras.retiros || [],
    productos_vendidos:        productos_vendidos,
    cajero:                    extras.cajero || '',
    ...finalExtras,
  }, { merge: true });

  return { total_ventas, total_efectivo, total_transferencia, total_transacciones };
}

// ─── Modal: Abrir caja desde web ──────────────────────────────────────────
// Crea caja_activa/current con status='open' y cierres_caja/{id} con esquema
// base. Las PCs reciben el snapshot via listener y crean la fila en su SQLite
// local (cash_register) con el mismo id, así las próximas ventas usan ese
// cash_register_id automáticamente.
// Usa runTransaction para evitar colisiones si una PC abre una caja al mismo
// tiempo: si la caja_activa/current ya está 'open', se aborta y reintenta.
export function openAbrirCajaModal(db, sugerenciaId, onDone) {
  document.querySelector('.modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:480px">
      <div class="modal-header cj-mh cj-mh--verde">
        <div class="cj-mh-id">
          <span class="material-icons">lock_open</span>
          <h3>Abrir caja #${sugerenciaId}</h3>
        </div>
        <button class="modal-close cj-mh-x"><span class="material-icons">close</span></button>
      </div>
      <div class="modal-body" style="padding:20px 22px">
        <div style="background:var(--tint-green-bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:14px;display:flex;gap:10px">
          <span class="material-icons" style="color:var(--tint-green-fg)">info</span>
          <div style="font-size:12.5px;color:var(--tint-green-fg);line-height:1.45">
            Esto abrirá la caja <b>#${sugerenciaId}</b> en todas las PCs.
            Las ventas que hagan se vincularán automáticamente a esta caja.
          </div>
        </div>
        <div style="margin-bottom:14px">
          <label style="font-size:12px;color:var(--text-muted);font-weight:700;display:block;margin-bottom:6px">Monto inicial ($)</label>
          <input type="number" step="0.01" id="abrir-monto" placeholder="0.00" value="0" style="width:100%;padding:10px 12px;font-size:14px;border:1.5px solid var(--border);border-radius:8px;outline:none;font-family:inherit">
        </div>
        <div style="margin-bottom:14px">
          <label style="font-size:12px;color:var(--text-muted);font-weight:700;display:block;margin-bottom:6px">Cajero / Notas (opcional)</label>
          <input type="text" id="abrir-notas" placeholder="Ej: Turno mañana - María" style="width:100%;padding:10px 12px;font-size:14px;border:1.5px solid var(--border);border-radius:8px;outline:none;font-family:inherit">
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="btn-cancel-abrir" style="background:var(--border);color:var(--text-muted);border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer">Cancelar</button>
          <button id="btn-confirm-abrir" style="background:#15803d;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:6px">
            <span class="material-icons" style="font-size:16px">lock_open</span>Abrir caja
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.querySelector('#btn-cancel-abrir').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  const btn = overlay.querySelector('#btn-confirm-abrir');
  const inputMonto = overlay.querySelector('#abrir-monto');
  const inputNotas = overlay.querySelector('#abrir-notas');
  setTimeout(() => { inputMonto.focus(); inputMonto.select(); }, 50);

  btn.addEventListener('click', async () => {
    const monto = parseFloat(inputMonto.value);
    if (isNaN(monto) || monto < 0) { inputMonto.focus(); return; }
    const notas = (inputNotas.value || '').trim();
    btn.disabled = true; btn.textContent = 'Abriendo...';
    try {
      const nowDate = new Date();
      const nowIso = nowDate.toISOString();
      const nowTs = Timestamp.fromDate(nowDate);
      const sessionId = nowDate.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });

      // Recalcular max(register_id) ANTES de la transaction.
      // Las queries con collection() no se permiten dentro de runTransaction
      // (solo tx.get sobre un documento). El lock fuerte se hace sobre
      // caja_activa/current dentro de la transaction.
      let nextId = sugerenciaId;
      try {
        const cierresSnap = await getDocs(query(collection(db, 'cierres_caja'), orderBy('register_id', 'desc'), limit(1)));
        if (!cierresSnap.empty) {
          const top = parseInt(cierresSnap.docs[0].data().register_id);
          if (Number.isFinite(top)) nextId = Math.max(nextId, top + 1);
        }
      } catch (_) { /* si falla, usamos sugerenciaId */ }

      // Transaction: lockea caja_activa/current. Si una PC ya abrió una caja
      // entre el render y el click, vemos status='open' y abortamos.
      const cajaActivaRef = doc(db, 'caja_activa', 'current');
      const newId = await runTransaction(db, async (tx) => {
        const snap = await tx.get(cajaActivaRef);
        if (snap.exists()) {
          const data = snap.data();
          if (data.status === 'open') {
            throw new Error(`Ya hay una caja abierta (#${data.id}) — refrescá la página.`);
          }
        }

        // Escritura 1: caja_activa/current → dispara listener apertura en PCs
        // opening_date como Timestamp → desktop lo recibe como datetime y lo
        // pasa a SQLite vía _to_ar_str (acepta datetime nativamente).
        tx.set(cajaActivaRef, {
          id:             nextId,
          initial_amount: monto,
          opening_date:   nowTs,
          notes:          notas,
          status:         'open',
          updated_at:     nowIso,
        });

        // Escritura 2: cierres_caja/{id} con esquema base (igual que sync_open_register)
        tx.set(doc(db, 'cierres_caja', String(nextId)), {
          register_id:               nextId,
          pc_id:                     'WEB',
          session_id:                sessionId,
          fecha_apertura:            nowTs,
          fecha_cierre:              '',
          cajero:                    notas || 'Web',
          monto_inicial:             monto,
          total_ventas:              0,
          total_efectivo:            0,
          total_transferencia:       0,
          total_retiros:             0,
          total_transacciones:       0,
          num_ventas_efectivo:       0,
          num_ventas_transferencia:  0,
          monto_esperado:            monto,
          monto_final:               0,
          productos_vendidos:        [],
          retiros:                   [],
          abierto_desde:             'web',
        });

        return nextId;
      });

      // Auto-cerrar huérfanos: docs en cierres_caja con fecha_cierre vacío y
      // register_id != newId. Quedan así si una caja se abandona sin cerrar
      // (PC offline, cierre fallido, etc.). Cada huérfano recibe stats
      // recalculados desde ventas_por_dia + fecha_cierre = ahora, así no
      // queda como fantasma con $0.
      try {
        const orphSnap = await getDocs(query(
          collection(db, 'cierres_caja'),
          where('fecha_cierre', '==', '')
        ));
        const orphans = orphSnap.docs.filter(d => {
          const data = d.data();
          const rid = data.register_id != null ? Number(data.register_id) : null;
          return rid !== null && rid !== Number(newId);
        });
        for (const d of orphans) {
          const data = d.data();
          await calcularYMergearStatsCaja(db, Number(data.register_id), {
            monto_inicial:    Number(data.monto_inicial) || 0,
            cajero:           data.cajero || '',
            retiros:          data.retiros || [],
            total_retiros:    Number(data.total_retiros) || 0,
            fecha_cierre:     nowTs,
            cerrado_desde:    'auto-orphan',
            pendiente_conteo: false,
            updated_at:       nowIso,
          });
        }
        if (orphans.length > 0) {
          console.log(`Auto-cerradas ${orphans.length} caja(s) huérfana(s) con stats recalculados:`,
            orphans.map(d => d.id));
        }
      } catch (e) {
        console.warn('No se pudieron auto-cerrar huérfanos:', e);
      }

      close();
      if (typeof onDone === 'function') onDone();
      // Pequeño delay para que el listener del desktop alcance a procesar
      setTimeout(() => {
        alertDialog({ title: 'Caja abierta', message: `Caja <b>#${escHtml(newId)}</b> abierta. Las PCs conectadas la detectarán en unos segundos.`, type: 'success' });
      }, 300);
    } catch (e) {
      btn.disabled = false; btn.innerHTML = '<span class="material-icons" style="font-size:16px">lock_open</span>Abrir caja';
      alertDialog({ title: 'Error', message: 'No se pudo abrir la caja: ' + escHtml(e?.message || e), type: 'error' });
    }
  });
}

export function openCierreModal(c, catByName, gastosAll, db, onSaved, ctx = {}) {
  document.querySelector('.modal-overlay')?.remove();

  // Días que junta esta caja. `ctx.items` son los renglones ya normalizados de
  // la pantalla; sin ellos (una llamada suelta) simplemente no se ofrece separar.
  const docCierre     = (c._docs || []).find(d => d.register_id != null) || null;
  const separacionAMedias = separacionPendiente(docCierre);
  const idsDeLaCaja   = [c.register_id, ...(separacionAMedias?.ids_nuevos || [])]
    .filter(v => v != null && Number.isFinite(Number(v))).map(Number);
  const diasDelCierre = (ctx.items && idsDeLaCaja.length)
    ? diasDeLaCaja(ctx.items, idsDeLaCaja) : [];
  const sePuedeSeparar = diasDelCierre.filter(d => !d.sinFecha).length >= 2;
  const mezclada       = tieneDiasMezclados(diasDelCierre);

  const apertura  = parseArDate(c.fecha_apertura);
  const cierre    = parseArDate(c.fecha_cierre);
  const retiros   = c.total_retiros || 0;
  const efectivo  = c.total_efectivo || 0;
  const transf    = c.total_transferencia || 0;
  const total     = c.total_ventas || 0;
  const inicial   = c.monto_inicial || 0;
  const esperado  = c.monto_esperado || (inicial + efectivo - retiros);
  const final_amt = c.monto_final || 0;
  const diff      = final_amt - esperado;
  const numVentas = c.total_transacciones || 0;
  const ticketPromedio = numVentas > 0 ? total / numVentas : 0;
  const productosRaw  = c.productos_vendidos || [];
  const retiros_lista = c.retiros || [];

  // Calcular duración del turno
  let duracion = '-';
  let duracionMins = 0;
  if (apertura && cierre && !isNaN(apertura) && !isNaN(cierre)) {
    duracionMins = Math.round((cierre - apertura) / 60000);
    const hrs  = Math.floor(duracionMins / 60);
    const min  = duracionMins % 60;
    duracion = hrs > 0 ? `${hrs}h ${min}m` : `${min}m`;
  }
  const ventasPorHora = duracionMins > 0 ? (numVentas / (duracionMins / 60)) : 0;

  // ── Rentabilidad del turno (misma lógica que Control Total) ────────────
  // Cruza cada producto vendido con el catálogo para obtener su costo.
  // Lo que no tiene costo cargado queda fuera del CMV y se avisa aparte.
  let cmv = 0, ingresoConCosto = 0, ingresoSinCosto = 0, itemsSinCosto = 0;
  const productos = productosRaw.map(p => {
    const nombre    = (p.product_name || p.nombre || '').toUpperCase().trim();
    // Por el nombre limpio: lo que se vende fraccionado llega decorado
    // ("PAPEL A4 · 1 pack(s)") y no cruzaba contra el catálogo. Su costo
    // quedaba en cero y el turno lo contaba como "ingreso sin costo cargado"
    // teniendo el costo cargado desde siempre.
    const cat       = buscarPorNombre(catByName, p.product_name || p.nombre);
    const cantidad  = Number(p.total_quantity || p.cantidad || 0);
    const ingreso   = Number(p.total_amount || p.total || 0);
    const costoUnit = Number(cat?.costo || 0);
    const costoTot  = costoUnit * cantidad;
    if (costoUnit > 0) {
      cmv             += costoTot;
      ingresoConCosto += ingreso;
    } else {
      ingresoSinCosto += ingreso;
      if (cantidad > 0) itemsSinCosto++;
    }
    return {
      ...p,
      _nombre:     p.product_name || p.nombre || '-',
      _cantidad:   cantidad,
      _ingreso:    ingreso,
      _costoUnit:  costoUnit,
      _costoTot:   costoTot,
      _ganancia:   costoUnit > 0 ? ingreso - costoTot : null,
      _margenPct:  costoUnit > 0 && ingreso > 0 ? ((ingreso - costoTot) / ingreso) * 100 : null,
    };
  }).sort((a, b) => b._ingreso - a._ingreso);

  // Gastos registrados en el rango apertura→cierre del turno
  let gastosTurno = [];
  if (apertura && cierre && !isNaN(apertura) && !isNaN(cierre)) {
    const aperturaStr = apertura.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const cierreStr   = cierre.toLocaleDateString('en-CA',   { timeZone: 'America/Argentina/Buenos_Aires' });
    gastosTurno = (gastosAll || []).filter(g => (g.fecha || '') >= aperturaStr && (g.fecha || '') <= cierreStr);
  }
  const gastoTotal    = gastosTurno.reduce((s, g) => s + Number(g.monto || 0), 0);
  const gananciaBruta = ingresoConCosto - cmv;
  const gananciaNeta  = gananciaBruta - gastoTotal;
  const margenPct     = ingresoConCosto > 0 ? (gananciaBruta / ingresoConCosto) * 100 : 0;
  const pctConCosto   = total > 0 ? (ingresoConCosto / total) * 100 : 0;

  // Salud del turno segun margen
  let salud = { color: 'var(--text-muted)', bg: 'var(--surface-2)', label: 'S/D', icon: 'help_outline' };
  if (ingresoConCosto > 0) {
    if (margenPct >= 40)      salud = { color: 'var(--tint-green-fg)', bg: 'var(--tint-green-bg)', label: 'Excelente', icon: 'trending_up' };
    else if (margenPct >= 25) salud = { color: 'var(--tint-green-fg)', bg: 'var(--tint-green-bg)', label: 'Bueno',     icon: 'check_circle' };
    else if (margenPct >= 10) salud = { color: 'var(--tint-yellow-fg)', bg: 'var(--tint-yellow-bg)', label: 'Bajo',      icon: 'warning' };
    else                      salud = { color: 'var(--tint-red-fg)', bg: 'var(--tint-red-bg)', label: 'Critico',   icon: 'error' };
  }

  // Top 3 productos por ingreso
  const top3 = productos.slice(0, 3);

  // Las cajas viejas guardan '-' cuando nadie firmó el turno.
  const cajeroNombre = (c.cajero && c.cajero !== '-') ? c.cajero : 'Sin cajero';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" id="cierreModal" style="max-width:760px">
      <!-- Header: identificacion del turno + los cuatro numeros que importan -->
      <div class="modal-header cj-mh cj-mh--oscuro cj-mh--detalle">
        <div class="cj-mh-fila">
          <div class="cj-mh-id">
            <div class="cj-mh-ico"><span class="material-icons">receipt_long</span></div>
            <div style="min-width:0">
              <div class="cj-mh-linea">
                <h3>Cierre #${c.session_id || c.register_id || '-'}</h3>
                ${c.pcs && c.pcs.length > 1 ? `<span class="cj-mh-tag">${c.pcs.length} PCs</span>` : ''}
                <span class="cj-mh-tag"${ingresoConCosto > 0 ? ` style="background:${salud.bg};color:${salud.color}"` : ''}>
                  <span class="material-icons">${salud.icon}</span>${salud.label}
                </span>
              </div>
              <div class="cj-mh-sub">${escHtml(cajeroNombre)} · ${duracion} de operación · ${numVentas} ${numVentas === 1 ? 'venta' : 'ventas'}</div>
            </div>
          </div>
          <button class="modal-close cj-mh-x"><span class="material-icons">close</span></button>
        </div>

        <div class="cj-mh-kpis">
          <div class="cj-mh-kpi">
            <span class="cj-mh-kpi-t">Total vendido</span>
            <span class="cj-mh-kpi-v">$${fmt(total)}</span>
          </div>
          <div class="cj-mh-kpi">
            <span class="cj-mh-kpi-t">Ticket promedio</span>
            <span class="cj-mh-kpi-v">$${fmt(ticketPromedio)}</span>
          </div>
          <div class="cj-mh-kpi">
            <span class="cj-mh-kpi-t">Margen</span>
            <span class="cj-mh-kpi-v" style="color:${ingresoConCosto > 0 ? (margenPct >= 25 ? '#6ee7a8' : margenPct >= 10 ? '#f2cb6a' : '#f79b9b') : 'rgba(255,255,255,.55)'}">${ingresoConCosto > 0 ? margenPct.toFixed(1) + '%' : '—'}</span>
          </div>
          <div class="cj-mh-kpi">
            <span class="cj-mh-kpi-t">Ganancia neta</span>
            <span class="cj-mh-kpi-v" style="color:${gananciaNeta >= 0 ? '#6ee7a8' : '#f79b9b'}">${gananciaNeta >= 0 ? '$' : '-$'}${fmt(Math.abs(gananciaNeta))}</span>
          </div>
        </div>
      </div>

      <div class="modal-body" style="padding:22px 24px">

        ${c.pendiente_conteo ? `
        <!-- Banner: cierre pendiente de conteo -->
        <div id="pendiente-banner" style="background:var(--tint-yellow-bg);border:1.5px solid #f59e0b;border-radius:12px;padding:14px 18px;margin-bottom:18px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:10px">
              <span class="material-icons" style="color:var(--tint-orange-fg)">pending_actions</span>
              <div>
                <div style="font-size:13px;font-weight:800;color:var(--tint-orange-fg)">Cierre pendiente de conteo</div>
                <div style="font-size:11px;color:var(--tint-yellow-fg);margin-top:2px">${total === 0 ? 'Stats vacíos: recalculá desde ventas y después cargá el efectivo contado.' : 'Cargá el efectivo real contado para finalizar el cierre.'}</div>
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${total === 0 ? `
              <button id="btn-recalc-stats" style="background:#475569;color:white;border:none;border-radius:8px;padding:9px 14px;font-weight:700;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px">
                <span class="material-icons" style="font-size:16px">calculate</span>Recalcular stats
              </button>` : ''}
              <button id="btn-cargar-conteo" style="background:#d97706;color:white;border:none;border-radius:8px;padding:9px 16px;font-weight:700;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px">
                <span class="material-icons" style="font-size:16px">payments</span>Cargar efectivo contado
              </button>
            </div>
          </div>
          <div id="conteo-form" style="display:none;margin-top:12px;padding-top:12px;border-top:1px dashed #f59e0b">
            <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap">
              <div style="flex:1;min-width:180px">
                <label style="font-size:11px;color:var(--tint-orange-fg);font-weight:700;display:block;margin-bottom:4px">Efectivo contado ($)</label>
                <input type="number" step="0.01" id="input-conteo" placeholder="0.00" value="${esperado.toFixed(2)}" style="width:100%;padding:10px 12px;font-size:14px;border:2px solid #d97706;border-radius:8px;outline:none;font-family:inherit">
                <div style="font-size:10px;color:var(--tint-yellow-fg);margin-top:4px">Esperado: $${fmt(esperado)}</div>
              </div>
              <button id="btn-guardar-conteo" style="background:#15803d;color:white;border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer">Guardar</button>
              <button id="btn-cancelar-conteo" style="background:var(--border);color:var(--text-muted);border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13px;cursor:pointer">Cancelar</button>
            </div>
          </div>
        </div>
        ` : ''}

        ${bannerDiasHTML({ dias: diasDelCierre, mezclada, sePuedeSeparar, separacionAMedias })}

        <!-- Linea temporal del turno -->
        <div style="background:var(--surface-2);border-radius:12px;padding:14px 18px;margin-bottom:22px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:180px">
            <div style="width:10px;height:10px;border-radius:50%;background:#0d6efd"></div>
            <div>
              <div style="font-size:10px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.5px">Apertura</div>
              <div style="font-size:13px;font-weight:700;color:var(--text-strong)">${fmtDT(apertura)}</div>
            </div>
          </div>
          <div style="flex:2;min-width:120px;display:flex;align-items:center;gap:10px;justify-content:center">
            <div style="flex:1;height:2px;background:var(--border-strong);border-radius:2px"></div>
            <div style="font-size:11px;color:var(--text-muted);font-weight:600;white-space:nowrap">${duracion}${ventasPorHora > 0 ? ` · ${ventasPorHora.toFixed(1)} v/h` : ''}</div>
            <div style="flex:1;height:2px;background:var(--border-strong);border-radius:2px"></div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:180px;justify-content:flex-end">
            <div style="text-align:right">
              <div style="font-size:10px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.5px">Cierre</div>
              <div style="font-size:13px;font-weight:700;color:var(--text-strong)">${fmtDT(cierre)}</div>
            </div>
            <div style="width:10px;height:10px;border-radius:50%;background:#198754"></div>
          </div>
        </div>

        <!-- Ventas por tipo de pago -->
        <div style="margin-bottom:22px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)">Ventas por tipo de pago</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div style="background:var(--tint-green-bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center">
              <div>
                <div style="font-size:11px;color:var(--tint-green-fg);font-weight:700">Efectivo</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${c.num_ventas_efectivo || 0} ${(c.num_ventas_efectivo || 0) === 1 ? 'venta' : 'ventas'}${total > 0 ? ` · ${Math.round((efectivo/total)*100)}%` : ''}</div>
              </div>
              <div style="font-size:18px;font-weight:800;color:var(--tint-green-fg)">$${fmt(efectivo)}</div>
            </div>
            <div style="background:var(--tint-blue-bg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;display:flex;justify-content:space-between;align-items:center">
              <div>
                <div style="font-size:11px;color:var(--tint-blue-fg);font-weight:700">Transferencia</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${c.num_ventas_transferencia || 0} ${(c.num_ventas_transferencia || 0) === 1 ? 'venta' : 'ventas'}${total > 0 ? ` · ${Math.round((transf/total)*100)}%` : ''}</div>
              </div>
              <div style="font-size:18px;font-weight:800;color:var(--tint-blue-fg)">$${fmt(transf)}</div>
            </div>
          </div>
        </div>

        <!-- Rentabilidad del turno -->
        <div style="margin-bottom:22px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)">Rentabilidad del turno</div>
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:14px 16px">
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
              <div>
                <div style="font-size:10px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px">Ingreso c/costo</div>
                <div style="font-size:16px;font-weight:700;color:var(--text-strong);margin-top:3px">$${fmt(ingresoConCosto)}</div>
                <div style="font-size:10px;color:var(--text-muted)">${Math.round(pctConCosto)}% del total</div>
              </div>
              <div>
                <div style="font-size:10px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px">Costo (CMV)</div>
                <div style="font-size:16px;font-weight:700;color:var(--tint-orange-fg);margin-top:3px">-$${fmt(cmv)}</div>
                <div style="font-size:10px;color:var(--text-muted)">costo de los productos</div>
              </div>
              <div>
                <div style="font-size:10px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px">Ganancia bruta</div>
                <div style="font-size:16px;font-weight:700;color:${gananciaBruta>=0?'var(--tint-green-fg)':'var(--tint-red-fg)'};margin-top:3px">$${fmt(gananciaBruta)}</div>
                <div style="font-size:10px;color:var(--text-muted)">margen ${margenPct.toFixed(1)}%</div>
              </div>
            </div>
            <div style="border-top:1px dashed var(--border);margin:12px 0 10px"></div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
              <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                <span style="font-size:12px;color:var(--text-muted)">Bruta <b style="color:${gananciaBruta>=0?'var(--tint-green-fg)':'var(--tint-red-fg)'}">$${fmt(gananciaBruta)}</b></span>
                ${gastoTotal > 0 ? `<span style="font-size:12px;color:var(--text-muted)">− Gastos <b style="color:var(--tint-red-fg)">$${fmt(gastoTotal)}</b></span>` : ''}
                <span style="font-size:12px;color:var(--text-muted)">=</span>
              </div>
              <div style="background:${gananciaNeta>=0?'var(--tint-green-bg)':'var(--tint-red-bg)'};border:2px solid ${gananciaNeta>=0?'#10b981':'#ef4444'};border-radius:10px;padding:8px 14px;display:flex;align-items:center;gap:8px">
                <span style="font-size:10px;font-weight:700;color:${gananciaNeta>=0?'var(--tint-green-fg)':'var(--tint-red-fg)'};text-transform:uppercase;letter-spacing:.4px">Ganancia neta</span>
                <span style="font-size:17px;font-weight:800;color:${gananciaNeta>=0?'var(--tint-green-fg)':'var(--tint-red-fg)'}">${gananciaNeta>=0?'$':'-$'}${fmt(Math.abs(gananciaNeta))}</span>
              </div>
            </div>
          </div>
          ${itemsSinCosto > 0 ? `
          <div style="background:var(--tint-yellow-bg);border:1px solid var(--border);border-radius:8px;padding:8px 12px;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--tint-orange-fg);margin-top:10px">
            <span class="material-icons" style="font-size:16px;color:var(--tint-orange-fg)">warning</span>
            <span><b>${itemsSinCosto}</b> producto${itemsSinCosto===1?'':'s'} sin costo cargado ($${fmt(ingresoSinCosto)} en ventas). Cargalos en Control Total para mejorar el calculo.</span>
          </div>` : ''}
        </div>

        <!-- Resumen de efectivo -->
        <div style="margin-bottom:22px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)">Resumen de efectivo</div>
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:14px 16px">
            <div style="display:grid;grid-template-columns:1fr;gap:8px">
              ${lineaEf('Monto inicial', `$${fmt(inicial)}`, 'var(--text)')}
              ${lineaEf('+ Ventas efectivo', `$${fmt(efectivo)}`, 'var(--tint-green-fg)')}
              ${retiros > 0 ? lineaEf('− Retiros', `$${fmt(retiros)}`, 'var(--tint-red-fg)') : ''}
              ${lineaEf('= Efectivo esperado', `$${fmt(esperado)}`, 'var(--text-strong)', true)}
            </div>
            ${final_amt > 0 ? `
              <div style="border-top:1px dashed var(--border);margin:12px 0 10px"></div>
              <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
                <div>
                  <div style="font-size:10px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.4px">Efectivo contado</div>
                  <div style="font-size:16px;font-weight:700;color:var(--text-strong)">$${fmt(final_amt)}</div>
                </div>
                <div style="background:${diff >= 0 ? 'var(--tint-green-bg)' : 'var(--tint-red-bg)'};border:1px solid ${diff >= 0 ? '#bbf7d0' : '#fecaca'};border-radius:10px;padding:8px 14px;display:flex;align-items:center;gap:8px">
                  <span class="material-icons" style="font-size:16px;color:${diff >= 0 ? 'var(--tint-green-fg)' : 'var(--tint-red-fg)'}">${diff >= 0 ? 'check_circle' : 'error'}</span>
                  <div>
                    <div style="font-size:10px;font-weight:700;color:${diff >= 0 ? 'var(--tint-green-fg)' : 'var(--tint-red-fg)'};text-transform:uppercase">${diff === 0 ? 'Exacto' : diff > 0 ? 'Sobrante' : 'Faltante'}</div>
                    <div style="font-size:14px;font-weight:800;color:${diff >= 0 ? 'var(--tint-green-fg)' : 'var(--tint-red-fg)'}">${diff === 0 ? '$0,00' : (diff > 0 ? '+' : '-') + '$' + fmt(Math.abs(diff))}</div>
                  </div>
                </div>
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Productos vendidos -->
        ${productos.length > 0 ? `
        <div style="margin-bottom:22px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted)">Productos vendidos <span style="color:var(--text-muted);font-weight:600">(${productos.length})</span></div>
            <div style="font-size:11px;color:var(--text-muted)">Ordenados por ingreso</div>
          </div>
          ${top3.length > 0 ? `
          <div style="display:grid;grid-template-columns:repeat(${Math.min(top3.length,3)},1fr);gap:8px;margin-bottom:10px">
            ${top3.map((p, i) => {
              const medal = ['#fbbf24','#94a3b8','#d97706'][i];
              return `
              <div style="background:var(--surface-2);border:1px solid var(--border);border-left:3px solid ${medal};border-radius:8px;padding:8px 12px">
                <div style="font-size:10px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px">#${i+1} mas vendido</div>
                <div style="font-size:12px;font-weight:700;color:var(--text-strong);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${p._nombre}">${p._nombre}</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${p._cantidad} u. · <b style="color:var(--tint-green-fg)">$${fmt(p._ingreso)}</b></div>
              </div>`;
            }).join('')}
          </div>` : ''}
          <div style="max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:10px">
            <table style="width:100%;border-collapse:collapse;font-size:12.5px">
              <thead>
                <tr style="background:var(--surface-2);position:sticky;top:0;z-index:1">
                  <th style="padding:9px 10px;text-align:left;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">Producto</th>
                  <th style="padding:9px 10px;text-align:center;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">Cant.</th>
                  <th style="padding:9px 10px;text-align:right;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">Ingreso</th>
                  <th style="padding:9px 10px;text-align:right;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">Costo</th>
                  <th style="padding:9px 10px;text-align:right;font-weight:700;color:var(--text-muted);border-bottom:1px solid var(--border)">Ganancia</th>
                </tr>
              </thead>
              <tbody>
                ${productos.map((p, i) => {
                  const sinCosto = p._costoUnit === 0;
                  return `
                  <tr style="background:${i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)'}">
                    <td style="padding:8px 10px;color:var(--text-strong);font-weight:500">${p._nombre}</td>
                    <td style="padding:8px 10px;text-align:center;color:var(--text-muted)">${p._cantidad}</td>
                    <td style="padding:8px 10px;text-align:right;font-weight:700;color:var(--tint-green-fg)">$${fmt(p._ingreso)}</td>
                    <td style="padding:8px 10px;text-align:right;color:${sinCosto?'var(--tint-orange-fg)':'var(--text-muted)'};${sinCosto?'font-style:italic':''}">
                      ${sinCosto ? '—' : '$'+fmt(p._costoTot)}
                    </td>
                    <td style="padding:8px 10px;text-align:right;font-weight:700;color:${sinCosto?'var(--text-muted)':(p._ganancia>=0?'var(--tint-green-fg)':'var(--tint-red-fg)')}">
                      ${sinCosto ? '<span title="sin costo cargado">s/c</span>' : `$${fmt(p._ganancia)}${p._margenPct!=null?` <span style="font-size:10px;color:var(--text-muted);font-weight:600">(${p._margenPct.toFixed(0)}%)</span>`:''}`}
                    </td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
        ` : ''}

        <!-- Gastos + Retiros (side by side si ambos existen) -->
        ${(gastosTurno.length > 0 || retiros_lista.length > 0) ? `
        <div style="display:grid;grid-template-columns:${(gastosTurno.length > 0 && retiros_lista.length > 0) ? '1fr 1fr' : '1fr'};gap:16px;margin-bottom:22px">
          ${gastosTurno.length > 0 ? `
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)">Gastos del turno <span style="color:var(--text-muted);font-weight:600">(${gastosTurno.length})</span></div>
            ${gastosTurno.map(g => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--tint-red-bg);border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
                <div style="min-width:0;flex:1">
                  <div style="font-size:12px;font-weight:600;color:var(--tint-red-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${g.descripcion || '-'}</div>
                  <div style="font-size:10px;color:var(--text-muted)">${g.fecha || ''}${g.tipo ? ' · ' + g.tipo : ''}</div>
                </div>
                <div style="font-size:14px;font-weight:700;color:var(--tint-red-fg);white-space:nowrap;margin-left:8px">-$${fmt(g.monto)}</div>
              </div>
            `).join('')}
          </div>` : ''}
          ${retiros_lista.length > 0 ? `
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-muted);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)">Retiros de caja <span style="color:var(--text-muted);font-weight:600">(${retiros_lista.length})</span></div>
            ${retiros_lista.map(r => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--tint-red-bg);border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
                <div style="min-width:0;flex:1">
                  <div style="font-size:12px;font-weight:600;color:var(--tint-red-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.reason || r.motivo || 'Retiro'}</div>
                  <div style="font-size:10px;color:var(--text-muted)">${r.created_at ? fmtDT(parseArDate(r.created_at)) : ''}</div>
                </div>
                <div style="font-size:14px;font-weight:700;color:var(--tint-red-fg);white-space:nowrap;margin-left:8px">-$${fmt(r.amount || r.monto || 0)}</div>
              </div>
            `).join('')}
          </div>` : ''}
        </div>
        ` : ''}

      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  });

  // Wire-up: cargar efectivo contado (solo si pendiente_conteo)
  const btnCargar = overlay.querySelector('#btn-cargar-conteo');
  if (btnCargar && db) {
    const formEl = overlay.querySelector('#conteo-form');
    const inputEl = overlay.querySelector('#input-conteo');
    btnCargar.addEventListener('click', () => {
      formEl.style.display = 'block';
      btnCargar.style.display = 'none';
      inputEl.focus();
      inputEl.select();
    });
    overlay.querySelector('#btn-cancelar-conteo').addEventListener('click', () => {
      formEl.style.display = 'none';
      btnCargar.style.display = 'flex';
    });
    const btnGuardar = overlay.querySelector('#btn-guardar-conteo');
    const guardar = async () => {
      const val = parseFloat(inputEl.value);
      if (isNaN(val) || val < 0) { inputEl.focus(); return; }
      btnGuardar.disabled = true; btnGuardar.textContent = 'Guardando...';
      try {
        const docs = c._docs || [];
        const diferencia = val - esperado;
        const nowIso = new Date().toISOString();
        for (let i = 0; i < docs.length; i++) {
          const d = docs[i];
          if (!d.id) continue;
          await updateDoc(doc(db, 'cierres_caja', d.id), {
            monto_final:      i === 0 ? val : 0,
            diferencia:       i === 0 ? diferencia : 0,
            pendiente_conteo: false,
            updated_at:       nowIso,
          });
        }
        invalidateCache('cierres:caja');
        overlay.remove();
        if (typeof onSaved === 'function') onSaved();
      } catch (e) {
        btnGuardar.disabled = false; btnGuardar.textContent = 'Guardar';
        alertDialog({ title: 'Error', message: 'No se pudo guardar: ' + escHtml(e?.message || e), type: 'error' });
      }
    };
    btnGuardar.addEventListener('click', guardar);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') guardar(); });
  }

  // Wire-up: separar la caja por día
  const btnSeparar = overlay.querySelector('#btn-separar-dias');
  if (btnSeparar && db) {
    btnSeparar.addEventListener('click', () => {
      overlay.remove();
      openSepararCajaModal(db, {
        // La fila de la tabla no guarda la PC ni el cajero como los tiene el
        // cierre (la PC viaja en `pcs` y el cajero vacío se muestra como '-'):
        // se los toma del documento para que las cajas nuevas los hereden.
        caja: {
          ...c,
          pc_id:  docCierre?.pc_id || (c.pcs || [])[0] || '',
          cajero: (c.cajero && c.cajero !== '-') ? c.cajero : (docCierre?.cajero || ''),
        },
        dias:      diasDelCierre,
        cierres:   ctx.cierres || [],
        items:     ctx.items || [],
        pendiente: separacionAMedias,
      }, onSaved);
    });
  }

  // Wire-up: recalcular stats (solo si total_ventas == 0 y pendiente_conteo)
  const btnRecalc = overlay.querySelector('#btn-recalc-stats');
  if (btnRecalc && db) {
    btnRecalc.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Recalcular stats', message: 'Esto va a recalcular ingreso, transferencia, transacciones y productos vendidos desde la colección ventas. ¿Continuar?', confirmText: 'Recalcular' })) return;
      btnRecalc.disabled = true;
      btnRecalc.innerHTML = '<span class="material-icons" style="font-size:16px">hourglass_empty</span>Recalculando...';
      try {
        // El register_id puede venir en c.register_id o en algun doc del session.
        // Para sesiones agrupadas tomamos el primer doc con register_id.
        const docCierre = (c._docs || []).find(d => d.register_id != null) || c;
        const regId = docCierre.register_id;
        if (!regId) throw new Error('No se encontró register_id en este cierre.');
        const result = await calcularYMergearStatsCaja(db, regId, {
          monto_inicial: docCierre.monto_inicial || 0,
          cajero:        docCierre.cajero || '',
          retiros:       docCierre.retiros || [],
          total_retiros: docCierre.total_retiros || 0,
          updated_at:    new Date().toISOString(),
        });
        invalidateCache('cierres:caja');
        overlay.remove();
        if (typeof onSaved === 'function') onSaved();
        setTimeout(() => {
          alertDialog({ title: 'Stats recalculados', message: `<b>$${fmt(result.total_ventas)}</b> en <b>${result.total_transacciones}</b> ventas.`, type: 'success' });
        }, 200);
      } catch (e) {
        btnRecalc.disabled = false;
        btnRecalc.innerHTML = '<span class="material-icons" style="font-size:16px">calculate</span>Recalcular stats';
        alertDialog({ title: 'Error', message: 'No se pudo recalcular: ' + escHtml(e?.message || e), type: 'error' });
      }
    });
  }
}

// ─── Separar una caja que juntó varios días ───────────────────────────────
// El aviso dentro del detalle del cierre. Tres tonos: la separación que quedó
// a medio hacer (hay que terminarla), los dos días pegados de verdad, y el día
// con una venta suelta, que casi siempre es normal y no conviene empujar.
function bannerDiasHTML({ dias, mezclada, sePuedeSeparar, separacionAMedias }) {
  if (separacionAMedias) {
    const cuantos = separacionAMedias.ids_nuevos.length;
    const revisar = separacionAMedias.estado === 'revisar';
    return `
      <div style="background:var(--tint-red-bg);border:1.5px solid #ef4444;border-radius:12px;padding:14px 18px;margin-bottom:18px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="material-icons" style="color:var(--tint-red-fg)">error</span>
          <div>
            <div style="font-size:13px;font-weight:800;color:var(--tint-red-fg)">${revisar
              ? 'La separación terminó pero los números no cerraron'
              : 'Quedó una separación sin terminar'}</div>
            <div style="font-size:11px;color:var(--tint-red-fg);opacity:.85;margin-top:2px">
              ${revisar
                ? `Esta caja se partió en ${cuantos + 1} y lo que quedó en la base no da igual que lo calculado. Conviene mirarlo antes de creerle a estos totales.`
                : `Se empezó a partir esta caja en ${cuantos + 1} y no llegó a cerrarse. Hasta terminarla, los totales pueden verse raros.`}
            </div>
          </div>
        </div>
        <button id="btn-separar-dias" style="background:#b91c1c;color:#fff;border:none;border-radius:8px;padding:9px 16px;font-weight:700;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px">
          <span class="material-icons" style="font-size:16px">replay</span>Retomar
        </button>
      </div>`;
  }
  if (!sePuedeSeparar) return '';

  const conFecha = dias.filter(d => !d.sinFecha);
  const detalle = conFecha
    .map(d => `${fmtDia(d.ymd)}: ${d.tx} ${d.tx === 1 ? 'venta' : 'ventas'} · $${fmt(d.total)}`)
    .join(' — ');

  if (mezclada) {
    return `
      <div style="background:var(--tint-yellow-bg);border:1.5px solid #f59e0b;border-radius:12px;padding:14px 18px;margin-bottom:18px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:10px;min-width:0">
          <span class="material-icons" style="color:var(--tint-orange-fg)">calendar_month</span>
          <div style="min-width:0">
            <div style="font-size:13px;font-weight:800;color:var(--tint-orange-fg)">Esta caja junta ${conFecha.length} días</div>
            <div style="font-size:11px;color:var(--tint-yellow-fg);margin-top:2px">${escHtml(detalle)}</div>
          </div>
        </div>
        <button id="btn-separar-dias" style="background:#d97706;color:#fff;border:none;border-radius:8px;padding:9px 16px;font-weight:700;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px;white-space:nowrap">
          <span class="material-icons" style="font-size:16px">call_split</span>Separar por día
        </button>
      </div>`;
  }
  return `
    <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin-bottom:18px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div style="font-size:11.5px;color:var(--text-muted)">
        Tiene ventas de ${conFecha.length} días (${escHtml(detalle)}). Abrir de noche y seguir vendiendo al otro día es lo normal.
      </div>
      <button id="btn-separar-dias" style="background:transparent;color:var(--text-muted);border:1px solid var(--border-strong);border-radius:8px;padding:7px 12px;font-weight:700;font-size:11.5px;cursor:pointer;white-space:nowrap">
        Separar igual
      </button>
    </div>`;
}

/**
 * El diálogo de separar. Muestra los días, deja elegir dónde cortar, pregunta
 * el monto inicial de cada caja nueva, chequea contra Firestore que los números
 * estén libres y recién ahí escribe.
 */
export function openSepararCajaModal(db, ctx, onDone) {
  // `verificar` y `separar` se pueden reemplazar para previsualizar el diálogo
  // sin pegarle a Firebase (ver `dev/cierres_preview.html`). En la app van los
  // de verdad.
  const {
    caja, dias, cierres = [], items = [], pendiente = null,
    verificar = null, separar = ejecutarSeparacion,
  } = ctx;

  document.querySelector('.modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:760px">
      <div class="modal-header cj-mh cj-mh--oscuro">
        <div class="cj-mh-id">
          <div class="cj-mh-ico"><span class="material-icons">call_split</span></div>
          <div>
            <h3>Separar la caja #${escHtml(caja.register_id)}</h3>
            <div class="cj-mh-sub">Cada día queda con su propia caja, su propio efectivo y su propio conteo</div>
          </div>
        </div>
        <button class="modal-close cj-mh-x"><span class="material-icons">close</span></button>
      </div>
      <div class="modal-body sep-body" style="padding:20px 22px"></div>
    </div>`;
  document.body.appendChild(overlay);

  const cuerpo = overlay.querySelector('.sep-body');
  const cerrar = () => { document.removeEventListener('keydown', alEscape); overlay.remove(); };
  const alEscape = (e) => { if (e.key === 'Escape' && !estado.trabajando) cerrar(); };
  overlay.querySelector('.modal-close').addEventListener('click', () => { if (!estado.trabajando) cerrar(); });
  overlay.addEventListener('click', e => { if (e.target === overlay && !estado.trabajando) cerrar(); });
  document.addEventListener('keydown', alEscape);

  // ── Estado del diálogo ──────────────────────────────────────────────────
  const idsPropios = pendiente?.ids_nuevos || [];
  const estado = {
    cortes: pendiente
      ? cortesDesdeMapa(dias, pendiente.dias, caja.register_id)
      : cortesSugeridos(dias),
    montos: [],     // texto del input de monto inicial, por grupo
    conteos: [],    // { pendiente: bool, texto: string }, por grupo
    chequeos: null, // null = todavía mirando
    trabajando: false,
  };
  // Si los cortes sugeridos no parten nada (el usuario entró igual desde un día
  // con una venta suelta), se corta en el primer día que se pueda.
  if (!estado.cortes.some(Boolean)) {
    const primero = dias.findIndex((d, i) => i > 0 && !d.sinFecha);
    if (primero > 0) estado.cortes[primero] = true;
  }

  const ocupados = numerosOcupados(cierres);
  // Los números que ya son nuestros de un intento anterior no cuentan como ocupados.
  idsPropios.forEach(id => ocupados.delete(Number(id)));

  const defectosDeGrupo = (grupos) => {
    const heredaConteo = !caja.pendiente_conteo && Number(caja.monto_final || 0) > 0;
    estado.montos = grupos.map((_, i) => (estado.montos[i] !== undefined
      ? estado.montos[i] : String(Number(caja.monto_inicial || 0))));
    estado.conteos = grupos.map((_, i) => {
      if (estado.conteos[i] !== undefined) return estado.conteos[i];
      const ultimo = i === grupos.length - 1;
      return (ultimo && heredaConteo)
        ? { pendiente: false, texto: String(Number(caja.monto_final || 0)) }
        : { pendiente: true, texto: '' };
    });
  };

  // Plan vigente con lo que hay cargado en pantalla. Sin ningún corte no hay
  // plan: la caja queda como está y no hay nada para escribir.
  const calcular = () => {
    const grupos = armarGrupos(dias, estado.cortes);
    defectosDeGrupo(grupos);
    if (grupos.length < 2) return { grupos, plan: null };
    const nuevos = idsLibres(ocupados, proximoNumero(ocupados), Math.max(0, grupos.length - 1));
    const ids = idsPropios.length >= grupos.length - 1
      ? idsPropios.slice(0, grupos.length - 1)   // retomar: los mismos de antes
      : nuevos;
    const conteos = grupos.map((_, i) => (estado.conteos[i].pendiente
      ? null : Number(estado.conteos[i].texto)));
    const plan = planDeSeparacion({
      caja, grupos, idsNuevos: ids,
      montosIniciales: grupos.map((_, i) => Number(estado.montos[i])),
      conteos,
    });
    return { grupos, plan };
  };

  const valoresValidos = () => estado.montos.every(m => m !== '' && Number.isFinite(Number(m)) && Number(m) >= 0)
    && estado.conteos.every(c => c.pendiente || (c.texto !== '' && Number.isFinite(Number(c.texto)) && Number(c.texto) >= 0));

  // ── Chequeos contra Firestore ───────────────────────────────────────────
  // Que el número esté libre no se puede saber mirando la lista de cierres: una
  // PC pudo haber usado ese número sin subir nunca su cierre. Se pregunta por
  // los renglones y las ventas de verdad.
  const chequear = async (plan) => {
    if (!plan) { estado.chequeos = { ok: false, problemas: [] }; pintar(); return; }
    estado.chequeos = null;
    pintar();
    const problemas = [];
    try {
      if (verificar) {
        estado.chequeos = await verificar(plan);
        pintar();
        return;
      }
      const abierta = await cajaAbiertaAhora(db);
      if (abierta !== null && plan.cajas.some(c => c.id === abierta)) {
        problemas.push(`La caja #${abierta} está abierta ahora mismo. Cerrala antes de separarla.`);
      }
      for (const nueva of plan.cajas.slice(1)) {
        if (idsPropios.includes(nueva.id)) continue;
        const r = await chequearIdLibre(db, nueva.id);
        if (!r.libre) problemas.push(`El número #${nueva.id} no está libre: ${r.problemas.join(', ')}.`);
      }
      estado.chequeos = { ok: problemas.length === 0, problemas };
    } catch (e) {
      estado.chequeos = { ok: false, problemas: [`No se pudo verificar contra la base: ${e?.message || e}`] };
    }
    pintar();
  };

  // ── Dibujo ──────────────────────────────────────────────────────────────
  const pintar = () => {
    const { plan } = calcular();
    const mapaDias  = plan ? plan.mapaDias : {};
    const ymdsDelPlan = new Set(plan ? Object.keys(mapaDias) : []);
    const idsDelPlan  = plan ? plan.cajas.map(x => x.id) : [caja.register_id];
    cuerpo.innerHTML = `
      ${pendiente ? avisoRetomarHTML(pendiente) : ''}
      ${tablaDiasSeparacionHTML(dias, estado.cortes, mapaDias, caja.register_id)}
      ${plan
        ? cajasResultantesHTML(plan, estado)
          + chequeosHTML(plan, estado, ajenasDeEsosDias(items, ymdsDelPlan, idsDelPlan))
        : `<div class="sep-nada">Así no se separa nada: todos los días quedan en la caja #${escHtml(caja.register_id)}.
             Marcá "Caja nueva" en el día que arranca la otra jornada.</div>`}
      <div class="sep-pie">
        <div class="sep-progreso" id="sep-progreso"></div>
        <div style="display:flex;gap:8px">
          <button id="sep-cancelar" class="sep-btn sep-btn--gris">Cancelar</button>
          <button id="sep-confirmar" class="sep-btn sep-btn--ok${plan ? '' : ' sep-btn--off'}" ${plan ? '' : 'disabled'}>
            <span class="material-icons" style="font-size:16px">call_split</span>
            ${plan ? `Separar en ${plan.cajas.length} cajas` : 'Separar'}
          </button>
        </div>
      </div>`;
    cablear(plan);
  };

  const cablear = (plan) => {
    cuerpo.querySelectorAll('[data-corte]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.corte);
        estado.cortes[i] = !estado.cortes[i];
        // Cambió la cantidad de cajas: los montos y conteos se recalculan.
        estado.montos = [];
        estado.conteos = [];
        pintar();
        chequear(calcular().plan);
      });
    });
    cuerpo.querySelectorAll('[data-monto]').forEach(input => {
      input.addEventListener('input', () => {
        estado.montos[Number(input.dataset.monto)] = input.value;
        refrescarNumeros();
      });
    });
    cuerpo.querySelectorAll('[data-conteo]').forEach(input => {
      input.addEventListener('input', () => {
        estado.conteos[Number(input.dataset.conteo)].texto = input.value;
        refrescarNumeros();
      });
    });
    cuerpo.querySelectorAll('[data-pendiente]').forEach(chk => {
      chk.addEventListener('change', () => {
        const i = Number(chk.dataset.pendiente);
        estado.conteos[i].pendiente = chk.checked;
        pintar();
      });
    });
    cuerpo.querySelector('#sep-cancelar')?.addEventListener('click', () => { if (!estado.trabajando) cerrar(); });
    cuerpo.querySelector('#sep-confirmar')?.addEventListener('click', () => confirmarYSeparar());
    aplicarEstadoBoton(plan);
  };

  // Cambiar un monto no cambia los grupos: se actualizan sólo los números que
  // dependen de él, así el cursor no se sale del input mientras se escribe.
  const refrescarNumeros = () => {
    const { plan } = calcular();
    if (!plan) return;
    plan.cajas.forEach((c, i) => {
      const esperado = cuerpo.querySelector(`[data-calc="esperado-${i}"]`);
      if (esperado) esperado.textContent = `$${fmt(c.monto_esperado)}`;
      const dif = cuerpo.querySelector(`[data-calc="dif-${i}"]`);
      if (dif) dif.innerHTML = textoDiferencia(c);
    });
    aplicarEstadoBoton(plan);
  };

  const aplicarEstadoBoton = (plan) => {
    const btn = cuerpo.querySelector('#sep-confirmar');
    if (!btn) return;
    const listo = !!plan && plan.control.ok && valoresValidos()
      && estado.chequeos !== null && estado.chequeos.ok && !estado.trabajando;
    btn.disabled = !listo;
    btn.classList.toggle('sep-btn--off', !listo);
  };

  const avisar = (texto) => {
    const el = cuerpo.querySelector('#sep-progreso');
    if (el) el.textContent = texto;
  };

  const confirmarYSeparar = async () => {
    const { plan } = calcular();
    if (!plan || !plan.control.ok || !valoresValidos() || !estado.chequeos?.ok) return;

    const resumen = plan.cajas.map(c => `
      <li><b>Caja #${c.id}</b>${c.esNuevo ? ' (nueva)' : ''} · ${c.ymds.map(fmtDia).join(', ')} ·
      ${c.total_transacciones} ventas · $${fmt(c.total_ventas)}${c.pendiente_conteo ? ' · queda pendiente de conteo' : ''}</li>`).join('');
    const ok = await confirmDialog({
      title: `¿Separar la caja #${caja.register_id}?`,
      message: `Se van a mover las ventas de cada día a su caja:<ul style="margin:8px 0 0;padding-left:18px;line-height:1.7">${resumen}</ul>
                <div style="margin-top:10px">La caja #${caja.register_id} deja de tener las ventas de los otros días. Se puede volver atrás a mano, pero no con un botón.</div>`,
      confirmText: 'Sí, separar',
    });
    if (!ok) return;

    estado.trabajando = true;
    aplicarEstadoBoton(plan);
    cuerpo.querySelector('#sep-cancelar').disabled = true;
    try {
      const r = await separar(db, { plan, onProgreso: avisar, idsPropios });
      invalidateCache('cierres:caja');
      invalidateCache('historial:ventas_dia:v3');
      cerrar();
      if (typeof onDone === 'function') onDone();
      setTimeout(() => {
        const quedaron = (r.renglones.sinDia.length + r.ventas.sinDia.length);
        const base = `Quedaron <b>${plan.cajas.length}</b> cajas: ${plan.cajas.map(c => `#${c.id}`).join(', ')}.<br>
                      Se movieron <b>${r.renglones.movidos}</b> renglones de venta y <b>${r.ventas.movidos}</b> ventas.
                      ${quedaron ? `<br><span style="color:var(--tint-orange-fg)">Quedaron sin mover ${quedaron} registros sin fecha: siguen en la caja #${caja.register_id}.</span>` : ''}`;
        // Lo que dice la base después de escribir, no lo que decía el plan.
        if (r.verificacion?.ok === false) {
          const flojas = r.verificacion.detalles.filter(d => !d.ok).map(d =>
            `<li>Caja <b>#${d.id}</b>: en la base hay $${fmt(d.efectivo.base + d.transferencia.base)} en ${d.ventas.base} ventas, ` +
            `y la cuenta daba $${fmt(d.efectivo.plan + d.transferencia.plan)} en ${d.ventas.plan}.</li>`).join('');
          alertDialog({
            title: 'Separada, pero hay que mirarla',
            message: `${base}<br><br>Al volver a leer las cajas, los números no dieron iguales:
                      <ul style="margin:6px 0 0;padding-left:18px;line-height:1.6">${flojas}</ul>
                      <div style="margin-top:8px">Puede ser una venta que sincronizó una PC justo ahora. El cierre quedó marcado para revisar.</div>`,
            type: 'error',
          });
          return;
        }
        alertDialog({
          title: 'Caja separada',
          message: `${base}<br>Las cajas se releyeron y los totales dan.`,
          type: 'success',
        });
      }, 250);
    } catch (e) {
      estado.trabajando = false;
      pintar();
      alertDialog({
        title: 'No se separó',
        message: `No se tocó nada de lo que faltaba: ${escHtml(e?.message || e)}`,
        type: 'error',
      });
    }
  };

  pintar();
  chequear(calcular().plan);
}

/** El número que le tocaría a la próxima caja: el más alto usado + 1. */
function proximoNumero(ocupados) {
  let max = 0;
  ocupados.forEach(id => { if (id > max) max = id; });
  return max + 1;
}

function avisoRetomarHTML(pendiente) {
  return `
    <div style="background:var(--tint-red-bg);border:1px solid #ef4444;border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:var(--tint-red-fg)">
      Se está retomando una separación que quedó a medias${pendiente.ts ? ` (${fmtDT(pendiente.ts)})` : ''}.
      Se usan los mismos números de caja: ${pendiente.ids_nuevos.map(i => `#${i}`).join(', ')}.
    </div>`;
}

function tablaDiasSeparacionHTML(dias, cortes, mapaDias, idOriginal) {
  const totalCaja = dias.reduce((s, d) => s + d.total, 0);
  const filas = dias.map((dia, i) => {
    const destino = dia.sinFecha ? idOriginal : (mapaDias[dia.ymd] ?? idOriginal);
    const corta = cortes[i] === true;
    const flojo = !dia.sinFecha && !diaCompleto(dia, totalCaja);
    const boton = (i === 0 || dia.sinFecha) ? '' : `
      <button type="button" data-corte="${i}" class="sep-chip ${corta ? 'sep-chip--nueva' : 'sep-chip--sigue'}"
              title="${corta ? 'Click para que este día siga en la caja anterior' : 'Click para que este día estrene caja'}">
        ${corta ? 'Caja nueva' : `Sigue en #${destino}`}
      </button>`;
    return `
      <tr>
        <td><b>${dia.sinFecha ? 'Sin fecha' : fmtDia(dia.ymd)}</b>${flojo ? ' <span class="sep-flojo">día flojo</span>' : ''}</td>
        <td class="cj-c">${dia.tx}</td>
        <td class="cj-n">$${fmt(dia.total)}</td>
        <td class="cj-n">$${fmt(dia.efectivo)}</td>
        <td class="cj-n">$${fmt(dia.transferencia)}</td>
        <td class="cj-n">${dia.primera ? fmtHora(dia.primera) : '—'}${dia.ultima ? ` a ${fmtHora(dia.ultima)}` : ''}</td>
        <td class="sep-destino">Caja #${destino}${boton}</td>
      </tr>`;
  }).join('');

  return `
    <div class="sep-seccion">Los días que tiene adentro</div>
    <div class="sep-tabla-wrap">
      <table class="sep-tabla">
        <thead><tr>
          <th>Día</th><th class="cj-c">Ventas</th><th class="cj-n">Total</th>
          <th class="cj-n">Efectivo</th><th class="cj-n">Transferencia</th>
          <th class="cj-n">Horario</th><th>Queda en</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`;
}

function textoDiferencia(caja) {
  if (caja.pendiente_conteo) return '<span class="sep-pendiente">Pendiente de conteo</span>';
  const d = caja.diferencia || 0;
  if (Math.abs(d) < 0.01) return '<span style="color:var(--tint-green-fg);font-weight:700">Cierra exacto</span>';
  const color = d > 0 ? 'var(--tint-green-fg)' : 'var(--tint-red-fg)';
  return `<span style="color:${color};font-weight:700">${d > 0 ? 'Sobra' : 'Falta'} $${fmt(Math.abs(d))}</span>`;
}

function cajasResultantesHTML(plan, estado) {
  const tarjetas = plan.cajas.map((c, i) => {
    const conteo = estado.conteos[i] || { pendiente: true, texto: '' };
    return `
      <div class="sep-caja ${c.esNuevo ? 'sep-caja--nueva' : ''}">
        <div class="sep-caja-top">
          <div>
            <span class="sep-caja-id">Caja #${c.id}</span>
            <span class="sep-caja-tag">${c.esNuevo ? 'Nueva' : 'La de siempre'}</span>
          </div>
          <div class="sep-caja-dias">${c.ymds.map(fmtDia).join(' · ') || 'Sin fecha'}</div>
        </div>
        <div class="sep-caja-meta">
          ${fmtDT(c.fecha_apertura)} → ${fmtDT(c.fecha_cierre)} ·
          ${c.total_transacciones} ventas · $${fmt(c.total_ventas)}
          (efectivo $${fmt(c.total_efectivo)} · transferencia $${fmt(c.total_transferencia)})
          ${c.total_retiros > 0 ? ` · retiros -$${fmt(c.total_retiros)}` : ''}
        </div>
        <div class="sep-campos">
          <label class="sep-campo">
            <span>Monto inicial ($)</span>
            <input type="number" step="0.01" min="0" data-monto="${i}" value="${escHtml(estado.montos[i] ?? '')}">
          </label>
          <label class="sep-campo">
            <span>Efectivo contado ($)</span>
            <input type="number" step="0.01" min="0" data-conteo="${i}" value="${escHtml(conteo.texto)}"
                   ${conteo.pendiente ? 'disabled' : ''} placeholder="${conteo.pendiente ? 'sin contar' : '0.00'}">
          </label>
          <label class="sep-check">
            <input type="checkbox" data-pendiente="${i}" ${conteo.pendiente ? 'checked' : ''}>
            <span>Nadie la contó</span>
          </label>
        </div>
        <div class="sep-caja-pie">
          <span>Esperado en el cajón <b data-calc="esperado-${i}">$${fmt(c.monto_esperado)}</b></span>
          <span data-calc="dif-${i}">${textoDiferencia(c)}</span>
        </div>
        ${c.hereda_conteo ? `
        <div class="sep-nota">El conteo de esa noche ($${fmt(c.monto_final)}) se cargó acá: fue la única vez que se contó la caja.</div>` : ''}
      </div>`;
  }).join('');
  return `<div class="sep-seccion">Cómo queda cada caja</div><div class="sep-cajas">${tarjetas}</div>`;
}

/** Otras cajas que también tienen ventas de esos días. No se tocan; se avisan. */
function ajenasDeEsosDias(items, ymds, idsPropios) {
  const propios = new Set(idsPropios.map(Number));
  const otras = new Map();
  for (const it of items || []) {
    if (!ymds.has(it.fecha_ymd)) continue;
    const rid = it.cash_register_id;
    if (rid == null || propios.has(Number(rid))) continue;
    if (!otras.has(rid)) otras.set(rid, { id: rid, total: 0, ventas: new Set() });
    const o = otras.get(rid);
    o.total += it.subtotal;
    o.ventas.add(`${it.pc_id}|${it.num_venta}`);
  }
  return [...otras.values()].map(o => ({ id: o.id, total: o.total, tx: o.ventas.size }));
}

function chequeosHTML(plan, estado, ajenas) {
  const linea = (estadoChequeo, texto) => {
    const icono = { ok: 'check_circle', mal: 'error', mirando: 'hourglass_empty', info: 'info' }[estadoChequeo];
    const color = { ok: 'var(--tint-green-fg)', mal: 'var(--tint-red-fg)',
                    mirando: 'var(--text-muted)', info: 'var(--text-muted)' }[estadoChequeo];
    return `<div class="sep-chequeo" style="color:${color}"><span class="material-icons">${icono}</span><span>${texto}</span></div>`;
  };

  const c = plan.control;
  const sumas = c.ok
    ? linea('ok', `Las ${plan.cajas.length} cajas suman lo mismo que la caja entera: $${fmt(c.ventas.caja)}`)
    : linea('mal', `Las partes no suman la caja entera ($${fmt(c.ventas.partes)} contra $${fmt(c.ventas.caja)}). No se puede separar así.`);

  const tx = c.txIgual ? '' : linea('info',
    `La suma de ventas de los días da ${c.tx.partes} y la caja tiene ${c.tx.caja}: hay números de venta repetidos entre días. La plata está bien.`);

  const nuevos = plan.cajas.slice(1).map(x => `#${x.id}`);
  let numeros;
  if (estado.chequeos === null) {
    numeros = linea('mirando', `Verificando que ${nuevos.length === 1 ? 'el número esté libre' : 'los números estén libres'}...`);
  } else if (estado.chequeos.ok) {
    numeros = linea('ok', nuevos.length === 1
      ? `El número ${nuevos[0]} está libre: sin cierre, sin ventas y sin renglones.`
      : `Los números ${nuevos.join(', ')} están libres: sin cierre, sin ventas y sin renglones.`);
  } else {
    numeros = estado.chequeos.problemas.map(p => linea('mal', escHtml(p))).join('');
  }

  const otras = ajenas.length
    ? linea('info', `Esos días también tienen ventas en ${ajenas.map(a => `la caja #${a.id} (${a.tx} ${a.tx === 1 ? 'venta' : 'ventas'}, $${fmt(a.total)})`).join(' y ')}. No se tocan.`)
    : '';

  return `<div class="sep-seccion">Antes de escribir</div><div class="sep-chequeos">${sumas}${tx}${numeros}${otras}</div>`;
}

/** '2026-09-18' como '18/09'. */
function fmtDia(ymd) {
  if (!ymd || ymd.length < 10) return ymd || '—';
  return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
}

function fmtHora(d) {
  const f = d instanceof Date ? d : new Date(d);
  if (isNaN(f)) return '—';
  return f.toLocaleTimeString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function lineaEf(label, valor, color = 'var(--text-strong)', bold = false) {
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;${bold ? 'padding-top:8px;border-top:1px dashed var(--border);' : ''}">
      <span style="font-size:12px;color:var(--text-muted);${bold ? 'font-weight:700' : ''}">${label}</span>
      <span style="font-size:${bold ? '15px' : '13px'};font-weight:${bold ? '800' : '600'};color:${color};font-variant-numeric:tabular-nums;white-space:nowrap">${valor}</span>
    </div>
  `;
}

// Maneja: Timestamp live (.toDate), Timestamp de localStorage ({ seconds, nanoseconds }), ISO string
function toDate(val) {
  if (!val) return null;
  if (typeof val.toDate === 'function') return val.toDate();
  if (typeof val === 'object' && val.seconds !== undefined)
    return new Date(val.seconds * 1000 + Math.floor((val.nanoseconds || 0) / 1e6));
  return new Date(val);
}

// Returns 'YYYY-MM-DD' in AR timezone from a fecha_apertura value.
// Strings (naive AR local time) are sliced directly; Firestore Timestamps
// se restan 3h (AR = UTC-3) para que el slice del ISO devuelva el día AR.
function aperturaDayKey(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.slice(0, 10);
  if (typeof val.toDate === 'function') {
    const ar = new Date(val.toDate().getTime() - 3 * 3600000);
    return ar.toISOString().slice(0, 10);
  }
  if (typeof val === 'object' && val.seconds !== undefined) {
    const ar = new Date(val.seconds * 1000 - 3 * 3600000);
    return ar.toISOString().slice(0, 10);
  }
  return '';
}

// Fechas guardadas por Python con timezone AR → Firestore las almacena como UTC correcto → no necesita compensación
function parseArDate(val) {
  if (!val) return null;
  if (typeof val.toDate === 'function') return val.toDate();
  if (typeof val === 'object' && val.seconds !== undefined)
    return new Date(val.seconds * 1000 + Math.floor((val.nanoseconds || 0) / 1e6));
  return new Date(val);
}

function fmt(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDT(d) {
  if (!d || isNaN(d)) return '-';
  const opts = { timeZone: 'America/Argentina/Buenos_Aires' };
  return d.toLocaleDateString('es-AR', opts) + ' ' + d.toLocaleTimeString('es-AR', { ...opts, hour: '2-digit', minute: '2-digit', hour12: false });
}
