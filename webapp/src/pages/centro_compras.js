// ── Centro de Compras ─────────────────────────────────────────────────────────
// Semáforo de presupuesto de inversión en producto. La idea del dueño: cuidar la
// plata del negocio. Todos los meses separa una rentabilidad (monto fijo, nunca
// menos que un piso % de las ventas). Los gastos fijos se cubren aparte. El único
// gasto que maneja activamente es la compra de mercadería. Esta página le dice, en
// vivo, cuánto puede gastar este mes/semana en producto y en qué orden comprar
// (los más urgentes/vendidos primero) hasta que la plata se acaba (línea de corte).
//
//   presupuesto = ingresosMes − gastosFijosMes − rentabilidad − comprasProductoMes
//
// Ingresos y gastos fijos salen del Balance Mensual (control_config/balance y
// control_config/dias_<ym>). Las alertas de reposición vienen de notifications.js.
// A la lista entra: lo que está POR DEBAJO de su stock mínimo cargado, y lo que
// no tiene mínimo pero se vende seguido y el stock no cubre el horizonte; lo que
// tiene mínimo y está bien NO figura (ver fuentesCompra).
//
// El ORDEN es lo que hace útil la página, y sale de un solo número: la urgencia
// de compra (0–100), que conjuga las tres cosas que pidió el dueño —lo que más
// se movió estos días, lo que más se vende en el mes y el stock mínimo cargado—
// contra lo que le queda de stock. La cuenta vive en `urgencia_compra.js`. De
// ese mismo número salen los tres niveles: SÍ O SÍ, IMPORTANTE y PUEDE ESPERAR,
// así la lista ordenada los deja agrupados sin que haya que ordenar dos veces.
// La plata que se deja de facturar (ritmo × precio) NO entra en el puntaje —si
// entrara, las hojas quedarían siempre debajo de cualquier cosa cara que no
// rota— pero se muestra y desempata. El presupuesto se asigna en dos pasadas:
// primero lo SÍ O SÍ — si no entra completo a la cobertura objetivo, se achica
// la cobertura hasta un piso de 7 días ANTES de dejar productos afuera — y con
// lo que sobra se va marcando el resto en orden (lo que entra, entra, aunque
// esté después del corte). Al registrar una compra se escribe una línea en el
// libro diario del Balance, así el semáforo baja y el gasto queda contabilizado
// en un solo lugar.

import { doc, updateDoc, serverTimestamp, deleteField } from 'firebase/firestore';
import { loadBalanceConfig, loadDiasMes, saveDiasMes, loadComprasConfig, saveComprasConfig } from '../config.js';
import { refrescarAlertas, obtenerCandidatosCompra, obtenerVentanasVenta } from '../notifications.js';
import { peekCacheValue } from '../cache.js';
import { sugerirCantidad } from '../inventario_resumen.js';
import { confirmDialog, alertDialog } from '../components/dialogs.js';
import { listaCuadernoHtml } from '../lista_cuaderno.js';
import {
  CAMPOS_FILTRO, SIN_VALOR, filtrosVacios, sanearFiltros, cantidadFiltros,
  coincideCompra, opcionesCompras, filtrarOpciones, campoTieneValores, textoBusquedaCompra,
} from '../filtros_compras.js';
import {
  puntajeUrgencia, nivelPorPuntaje, compararUrgencia, motivosUrgencia, explicarUrgencia, ritmoDe,
  VENTANA_CORTA_DIAS, COBERTURA_DEFAULT_DIAS as COBERTURA_DEFAULT,
} from '../urgencia_compra.js';
import {
  motivoTemporada, explicarTemporada, claveProducto, ajustesDeFecha, temporadaPorId, estaExcluido,
} from '../temporadas.js';
import {
  cargarEstudio, rehacerEstudio, recomendacionesDeTemporada, ideasQueFaltan,
  fechasDelAnio, estadoDeFecha, guardarAjusteManual, borrarAjusteManual,
} from '../temporadas_datos.js';

const MEDIOS = [
  { k: 'efectivo', label: 'Efectivo' },
  { k: 'mp',       label: 'Mercado Pago' },
  { k: 'lapos',    label: 'Lapos' },
];
// Rubros que NO son inversión en producto (se cubren como gasto fijo aparte) y por
// eso no descuentan del presupuesto de compras. Normalizados (sin acento, minúscula).
const RUBROS_FIJOS_DEFAULT = ['sueldos', 'gastos fijos'];
const MIN_COBERTURA_DIAS = 7;    // piso al achicar cantidades de lo SÍ O SÍ cuando la plata no alcanza
const MIN_ROTACION = 3;          // unidades vendidas en la ventana para considerar que "rota"
// Marca "ya lo anoté en el cuaderno": si el producto salió de la lista (se repuso
// o dejó de rotar) la marca vieja se limpia sola pasados estos días. Mientras el
// producto siga figurando, la marca no caduca nunca (hay cosas que tardan meses
// en conseguirse y justamente para eso está).
const ANOTADO_CADUCA_DIAS = 60;

// ── Formato / parseo es-AR (réplica de balance_mensual.js) ────────────────────
function fmt(n, dec = 2) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function money(n, dec = 0) { return '$ ' + fmt(n, dec); }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
// Parseo tolerante es-AR: "312.400" → 312400, "1.234,56" → 1234.56.
function parseNum(raw) {
  if (typeof raw === 'number') return raw;
  if (raw == null) return null;
  let s = String(raw).trim().replace(/[^\d.,\-]/g, '');
  if (s === '' || s === '-') return null;
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    const dots = (s.match(/\./g) || []).length;
    if (dots > 1 || /^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}
function normRubro(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
// Fecha de hoy en Argentina como "YYYY-MM-DD".
function hoyAR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}
const MESES_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
function labelFromYm(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return `${MESES_ES[+m[2] - 1] || ''} ${m[1].slice(2)}`.trim();
}

// ── Helpers de Balance como funciones puras (replicadas, toman balCfg/diasDoc) ─
// ¿Aplica un monto fijo en el mes ym? Respeta pausa global (activo:false), baja
// "desde tal mes" (desactivadoDesde) y exclusión puntual del mes (fijosExcluidos).
function fijoAplica(balCfg, ym, fijo) {
  if (fijo.activo === false) return false;
  if (fijo.desactivadoDesde && ym >= fijo.desactivadoDesde) return false;
  const mes = balCfg?.meses?.[ym];
  if (mes && Array.isArray(mes.fijosExcluidos) && mes.fijosExcluidos.includes(fijo.id)) return false;
  return true;
}
function fijoMontoEnMes(balCfg, ym, fijo) {
  if (!fijoAplica(balCfg, ym, fijo)) return 0;
  const ov = balCfg?.meses?.[ym]?.fijosOverride?.[fijo.id];
  if (ov != null) return Number(ov) || 0;
  return Number(fijo.monto) || 0;
}
function totalFijosMes(balCfg, ym) {
  return (balCfg?.montosFijos || [])
    .filter(f => f.activo !== false)
    .reduce((s, f) => s + fijoMontoEnMes(balCfg, ym, f), 0);
}
// Ingresos del mes = suma de todos los ingresos diarios cargados en el Balance.
function sumIngresosMes(diasDoc) {
  const dias = diasDoc?.dias || {};
  let total = 0;
  for (const dd of Object.keys(dias)) {
    for (const x of (dias[dd].ingresos || [])) total += Number(x.monto) || 0;
  }
  return total;
}
// Compras de producto ya hechas este mes = compras del libro diario cuyo rubro NO
// es un rubro fijo (sueldos / gastos fijos), que se cubren aparte.
function sumComprasProductoMes(diasDoc, rubrosFijos) {
  const dias = diasDoc?.dias || {};
  const fijos = new Set((rubrosFijos && rubrosFijos.length ? rubrosFijos : RUBROS_FIJOS_DEFAULT).map(normRubro));
  let total = 0;
  for (const dd of Object.keys(dias)) {
    for (const x of (dias[dd].compras || [])) {
      const monto = Number(x.monto) || 0;
      if (monto <= 0) continue;
      if (fijos.has(normRubro(x.rubro))) continue;
      total += monto;
    }
  }
  return total;
}
// Semanas que quedan del mes (inclusive de la actual), mínimo 1.
function semanasRestantesDelMes(ym) {
  const hoy = hoyAR();
  const [y, m] = ym.split('-').map(Number);
  const diasEnMes = new Date(y, m, 0).getDate();
  let diasRestantes = diasEnMes;
  if (ym === hoy.slice(0, 7)) diasRestantes = diasEnMes - Number(hoy.slice(8, 10)) + 1;
  return Math.max(1, Math.ceil(diasRestantes / 7));
}

// ── Cálculo del presupuesto ───────────────────────────────────────────────────
// Si hay un monto fijado a mano ("la plata que tengo HOY para gastar", guardado
// en control_config/compras), ese monto manda: las compras registradas DESPUÉS
// de fijarlo lo van bajando (las anteriores ya estaban descontadas cuando el
// usuario lo cargó). Solo vale para el mes en que se fijó.
function computeBudget(balCfg, diasDoc, comprasCfg, ym) {
  const ingresosMes = sumIngresosMes(diasDoc);
  const gastosFijosMes = totalFijosMes(balCfg, ym);
  const rentMonto = Number(comprasCfg.rentabilidad_monto) || 0;
  const rentPiso = Number(comprasCfg.rentabilidad_piso_pct) || 0;
  const rentabilidad = Math.max(rentMonto, (rentPiso / 100) * ingresosMes);
  const comprasProductoMes = sumComprasProductoMes(diasDoc, comprasCfg.rubros_excluidos);
  let presupuestoMes = ingresosMes - gastosFijosMes - rentabilidad - comprasProductoMes;
  let manual = null;
  const manMonto = Number(comprasCfg.presupuesto_manual);
  if (comprasCfg.presupuesto_manual != null && Number.isFinite(manMonto)
      && comprasCfg.presupuesto_manual_ym === ym) {
    const compradoDesde = Math.max(0, comprasProductoMes - (Number(comprasCfg.presupuesto_manual_base) || 0));
    presupuestoMes = manMonto - compradoDesde;
    manual = { monto: manMonto, compradoDesde, fecha: comprasCfg.presupuesto_manual_fecha || '' };
  }
  const gastableMes = Math.max(0, presupuestoMes);
  const semanasRestantes = semanasRestantesDelMes(ym);
  const gastableSemana = Math.max(0, gastableMes / semanasRestantes);
  return {
    ingresosMes, gastosFijosMes, rentabilidad, comprasProductoMes,
    presupuestoMes, gastableMes, gastableSemana, semanasRestantes, manual,
  };
}

// ── Filas priorizadas ─────────────────────────────────────────────────────────
// Urgencia de una alerta (0–100) y, de ahí, su nivel:
//   sisi       → o el puntaje es alto, o ya no hay nada de algo que rota.
//   importante → puntaje medio, o sin stock aunque casi no rote.
//   opcional   → puede esperar.
// Los dos casos de "ya no hay nada" son pisos del puntaje, no reglas aparte:
// así el nivel y el orden nunca se contradicen (ver `urgencia_compra.js`).
function urgenciaDe(a, coberturaObj) {
  const auto = !!a.auto;
  const stockUnidades = Number.isFinite(Number(a.stock_total_unidades))
    ? Number(a.stock_total_unidades)
    : (Number(a.stock) || 0);
  return puntajeUrgencia({
    diasCobertura: a.dias_cobertura,
    coberturaObjetivo: coberturaObj,
    stock: Number(a.stock) || 0,
    // Las variedades auto-detectadas no tienen mínimo cargado: el 2 que traen
    // es el umbral con el que se las detecta, no una decisión del dueño.
    stockMin: auto ? 0 : (Number(a.stock_min) || 0),
    sinStock: stockUnidades <= 0,
    rankMes: Number(a.rank_mes) || 0,
    rankReciente: Number(a.rank_reciente) || 0,
    unidadesMes: Number(a.unidades_ventana) || 0,
  });
}

// Fuentes de la lista: alertas activas (bajo mínimo / por agotarse) + candidatos
// por cobertura (rotan pero el stock no llega a los días objetivo — ej: las
// hojas que se gastan con cada impresión). Si un producto ya está en alerta
// (global o por variedad), manda la alerta.
//
// Regla de entrada: el stock mínimo manda. Un producto CON mínimo cargado (a
// nivel producto o en alguna variedad) solo figura cuando está por debajo — su
// alerta configurada —; si está bien no aparece, aunque el ritmo diga que
// conviene adelantar la compra. Un producto SIN mínimo figura solo si de
// verdad se vende (rota en la ventana) y el stock no cubre el horizonte.
function tieneMinimoConfigurado(p) {
  if (!p) return false;
  if (Number(p.stock_min) > 0) return true;
  const colores = Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [];
  return colores.some(c => Number(c.stock_min) > 0);
}

function fuentesCompra(alertasBase, comprasCfg) {
  const dias = Number(comprasCfg.cobertura_dias_objetivo) || COBERTURA_DEFAULT;
  const out = [];
  for (const a of (alertasBase || [])) {
    // Variantes auto-detectadas (sin mínimo cargado) que casi no se venden:
    // no son compra pendiente, son ruido en la lista.
    if (a.auto && (Number(a.unidades_ventana) || 0) < MIN_ROTACION) continue;
    // Urgencia por ritmo de un producto que SÍ tiene mínimo y está por encima:
    // el mínimo que cargó el dueño manda, todavía no corresponde comprarlo.
    if (a.origen === 'ritmo' && tieneMinimoConfigurado(a.producto)) continue;
    out.push(a);
  }
  const vistos = new Set(out.map(a => String(a.doc_id)));
  for (const c of obtenerCandidatosCompra(dias)) {
    if (vistos.has(String(c.doc_id))) continue;
    if (tieneMinimoConfigurado(c.producto)) continue;   // el mínimo manda
    out.push(c);
  }
  return out;
}

// Arma las filas comprables: cantidad sugerida × costo, nivel de prioridad y la
// plata que se pierde si no se repone. Se ordena por nivel y, dentro del nivel,
// por pérdida en el horizonte (lo que más se mueve Y más descubierto está va
// primero). Filas sin costo cargado se marcan aparte (no se pueden presupuestar
// hasta cargarles el costo).
// Unidades por pack/rollo de un producto conjunto. Para una variedad usa su
// contenido propio si lo tiene; si no, el global del producto. 0 = no aplica.
function packSizeDe(p, variedad) {
  if (!p || !(p.es_conjunto === true || p.es_conjunto === 1)) return 0;
  if (variedad != null) {
    const c = (Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [])
      .find(x => (x.color || '') === variedad);
    const propio = Number(c?.contenido) || 0;
    if (propio > 0) return propio;
  }
  return Number(p.conjunto_contenido) || 0;
}

// ── Stock real (réplica de la convención de notifications.js) ─────────────────
// Total en unidades sueltas de una variedad: packs × contenido + restante suelto.
// Sin contenido propio ni global, un pack vale 1 unidad (nunca 0: con 0 los
// packs enteros desaparecían del total).
function stockVariedadUnits(c, globalCont) {
  const u = Number(c.unidades) || 0, r = Number(c.restante) || 0;
  const propio = Number(c.contenido) || 0;
  const gl = Number(globalCont) || 0;
  const cc = propio > 0 ? propio : (gl > 0 ? gl : 1);
  return u * cc + r;
}
// Etiqueta del envase de un conjunto (rollo/pack/caja/...), en singular o plural.
function unidadConjunto(p, n) {
  const um = (p?.conjunto_unidad_medida || '').toLowerCase();
  if (um === 'metro' || um === 'metros') return n === 1 ? 'metro' : 'metros';
  const map = {
    rollo: ['rollo', 'rollos'], pack: ['pack', 'packs'], caja: ['caja', 'cajas'],
    bobina: ['bobina', 'bobinas'], bolsa: ['bolsa', 'bolsas'],
  };
  const par = map[(p?.conjunto_tipo || '').toLowerCase()] || ['pack', 'packs'];
  return n === 1 ? par[0] : par[1];
}
// Stock real de una fila, leído del producto del catálogo: para una variedad,
// sus packs + unidades sueltas; para un conjunto con variantes, el total real
// con el desglose por variante en el tooltip; para el resto, el stock plano.
function stockRealDe(r) {
  const p = r.producto;
  if (!p) return { texto: `${fmt(Math.max(0, r.stock), 0)} u.`, title: '', total: r.stock };
  const esConjunto = (p.es_conjunto === true || p.es_conjunto === 1);
  const colores = esConjunto && Array.isArray(p.conjunto_colores) ? p.conjunto_colores : [];
  const globalCont = Number(p.conjunto_contenido) || 0;
  if (r.esVariedad) {
    const c = colores.find(x => (x.color || '') === r.variedad) || null;
    const packs = Number(c?.unidades) || 0;
    const units = c ? stockVariedadUnits(c, globalCont) : (Number(r.stockUnits) || 0);
    const texto = `${fmt(packs, 0)} ${unidadConjunto(p, packs)}${units !== packs ? ` · ${fmt(units, 0)} u.` : ''}`;
    return { texto, title: '', total: units };
  }
  if (colores.length > 0) {
    const total = colores.reduce((s2, c) => s2 + stockVariedadUnits(c, globalCont), 0);
    const title = colores.map(c => {
      const packs = Number(c.unidades) || 0;
      return `${c.color || '(sin nombre)'}: ${fmt(packs, 0)} ${unidadConjunto(p, packs)} · ${fmt(stockVariedadUnits(c, globalCont), 0)} u.`;
    }).join('\n');
    return { texto: `${fmt(total, 0)} u. en ${colores.length} variante${colores.length === 1 ? '' : 's'}`, title, total };
  }
  if (esConjunto) {
    const tot = Number(p.conjunto_total) || 0;
    return { texto: `${fmt(tot, 0)} u.`, title: '', total: tot };
  }
  const st = Number(p.stock) || 0;
  return { texto: `${fmt(st, 0)} u.`, title: '', total: st };
}

// Clave de la marca "anotado en el cuaderno": por producto, o por variante si la
// fila es una variedad (se anotan por separado, cada color se consigue o no).
function keyAnotado(r) {
  return String(r.doc_id) + (r.esVariedad ? `|${r.variedad || ''}` : '');
}

function buildRows(alertas, comprasCfg) {
  const cobertura = Number(comprasCfg.cobertura_dias_objetivo) || COBERTURA_DEFAULT;
  const anotados = comprasCfg.anotados || {};
  const rows = [];
  for (const a of (alertas || [])) {
    const cost = Math.max(0, Number(a.producto?.costo) || 0);
    const precio = Math.max(0, Number(a.producto?.precio_venta ?? a.producto?.precio) || 0);
    const velDia = Number(a.vel_dia) || 0;
    const esVariedad = a.variedad != null;
    const packSize = packSizeDe(a.producto, esVariedad ? a.variedad : null);
    const stockUnits = Number.isFinite(Number(a.stock_total_unidades))
      ? Number(a.stock_total_unidades)
      : (Number(a.stock) || 0);

    let qty;
    let costRow = cost;
    if (esVariedad) {
      // Variedades: la cantidad va en PACKS/rollos (así se compran). El ritmo
      // por color (en unidades sueltas) dice cuántos packs cubren el horizonte;
      // el rango min/max configurado queda como piso. Sin max, volver a 2× min.
      let packsRango = Number(a.sugerencia) || 0;
      if (!(packsRango > 0)) {
        const min = Number(a.stock_min) || 0;
        // `a.stock` viene en packs equivalentes y puede ser fraccionario
        // (0,9 packs = 90 de 100) → se pide el envase entero.
        const stk = Math.max(0, Number(a.stock) || 0);
        packsRango = Math.ceil(Math.max(0, Math.max(min * 2, min + 1) - stk));
      }
      let packsRitmo = 0;
      if (velDia > 0 && packSize > 0) {
        packsRitmo = Math.ceil(Math.max(0, velDia * cobertura - stockUnits) / packSize);
      }
      qty = Math.max(packsRitmo, packsRango);
      // El costo del catálogo es por unidad suelta (misma convención que la
      // valorización de stock) → lo que se paga por pack = costo × contenido.
      if (packSize > 0 && cost > 0) costRow = cost * packSize;
    } else {
      qty = sugerirCantidad(velDia, a.stock, a.stock_min, cobertura);
      if (!(qty > 0)) qty = Number(a.sugerencia) || 0;
      // Conjuntos sin variedades se compran de a packs enteros → redondear arriba.
      if (qty > 0 && packSize > 1) qty = Math.ceil(qty / packSize) * packSize;
    }
    if (!(qty > 0)) continue;   // nada que reponer

    // Plata que se deja de facturar en el horizonte si no se repone: ritmo ×
    // precio × días descubiertos. Combina "se mueve mucho" con "se queda sin
    // stock ya": sin stock pierde el horizonte entero, con 25 días de cobertura
    // pierde solo los 5 del final.
    const diasCob = Number.isFinite(a.dias_cobertura) ? Math.max(0, a.dias_cobertura) : Infinity;
    const perdidaHorizonte = velDia * precio * Math.max(0, cobertura - Math.min(diasCob, cobertura));
    const urg = urgenciaDe(a, cobertura);

    const row = {
      doc_id: a.doc_id,
      nombre: a.nombre || '(sin nombre)',
      codigo: a.codigo || a.producto?.codigo || '',
      rubro: a.rubro || '',
      // Subrubro, proveedor y marca: por lo que se filtra la lista (y se ven
      // apagados debajo del rubro, así se sabe qué se está filtrando).
      sub_rubro: a.sub_rubro || a.producto?.sub_rubro || '',
      proveedor: a.producto?.proveedor || '',
      marca: a.marca || a.producto?.marca || '',
      urgente: !!a.urgente,
      critico: !!a.critico,
      // El puntaje y su cuenta abierta: el orden de la lista y el tooltip que
      // lo explica salen de acá.
      urgencia: urg.score,
      riesgo: urg.riesgo,
      importancia: urg.importancia,
      rank_mes: urg.rank_mes,
      rank_reciente: urg.rank_reciente,
      tier: nivelPorPuntaje(urg.score),
      cobertura_texto: a.cobertura_texto || '',
      stock: Number(a.stock) || 0,
      stock_min: Number(a.stock_min) || 0,
      esVariedad,
      variedad: esVariedad ? (a.variedad || '') : null,
      packSize,
      stockUnits,
      vel_dia: velDia,
      vel_semana: Number(a.vel_semana) || 0,
      // Las dos ventanas por separado, para explicar por qué está donde está.
      unidades_ventana: Number(a.unidades_ventana) || 0,
      ritmo_dias: Number(a.ritmo_dias) || 0,
      unidades_7: Number(a.unidades_7) || 0,
      dias_con_mov_7: Number(a.dias_con_mov_7) || 0,
      vel_dia_30: Number(a.vel_dia_30) || 0,
      vel_dia_7: Number(a.vel_dia_7) || 0,
      dias_cobertura: diasCob,
      perdidaSemana: velDia * 7 * precio,
      perdidaHorizonte,
      producto: a.producto || null,
      busca: '',   // texto normalizado por el que busca la lupa (se arma abajo)
      qty,
      cost: costRow,
      subtotal: qty * costRow,
      sinCosto: !(costRow > 0),
      qtyManual: false,
      fits: false,
      acumulado: 0,
      checked: false,
      registrado: false,
      anotado: null,
    };
    row.anotado = anotados[keyAnotado(row)] || null;
    row.busca = textoBusquedaCompra(row);
    rows.push(row);
  }
  // Del más urgente de comprar al menos urgente. Como el nivel sale del mismo
  // puntaje, ordenar por urgencia deja los tres niveles agrupados y en orden.
  rows.sort(compararUrgencia);
  return rows;
}

// ── Lo que entra a la lista por la ÉPOCA del año ──────────────────────────────
// Un producto puede estar en la lista de compras por tres motivos distintos, y
// el dueño necesita distinguirlos de un vistazo: porque se está acabando,
// porque cayó debajo del mínimo… o porque se viene la fecha en la que vuela.
// Lo tercero es lo que agrega esto (pedido del 21/09/2026, después del 6 de
// septiembre: "vendimos cinta amarilla, limpia pipa amarillo, un montón de
// cosas amarillas" y no estaba previsto).
//
// Las recomendaciones salen de `temporadas.js`. Acá se hacen dos cosas:
//   · a lo que YA está en la lista se le pega la marca de la fecha, y si por la
//     fecha urge más de lo que urgía, sube;
//   · lo que no estaba entra como fila nueva, con la cantidad que falta para
//     llegar a la fecha con lo mismo que se vendió la vez pasada.
function normClave(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Clave de cruce entre una recomendación y una fila: producto + variedad. */
function claveFila(docId, variedad) {
  return `${String(docId ?? '')}|${normClave(variedad)}`;
}

/** El nombre tal cual está escrito en el catálogo para una variedad que las
 *  ventas guardaron normalizada ("amarillo patito" → "Amarillo Patito"). */
function variedadDelCatalogo(producto, color) {
  const c = normClave(color);
  if (!c) return null;
  const colores = Array.isArray(producto?.conjunto_colores) ? producto.conjunto_colores : [];
  const hit = colores.find(x => normClave(x.color) === c);
  return hit ? (hit.color || '') : null;
}

// Mezcla las recomendaciones de época con las filas que ya venían. Devuelve las
// filas nuevas que hay que agregar (las existentes se modifican en el lugar).
function aplicarTemporadas(rows, recomendaciones, comprasCfg) {
  const anotados = comprasCfg.anotados || {};
  const porClave = new Map();
  for (const r of rows) porClave.set(claveFila(r.doc_id, r.variedad), r);

  const nuevas = [];
  for (const rec of (recomendaciones || [])) {
    const prod = rec.producto;
    if (!prod) continue;
    const variedad = variedadDelCatalogo(prod, rec.color);
    const existente = porClave.get(claveFila(rec.docId, variedad));
    if (existente) {
      // Ya estaba en la lista por otro motivo: se le suma el dato de la fecha.
      // La urgencia sube sólo si la época apura más que lo que ya la traía, así
      // nada de lo que hoy se está por agotar queda tapado por una fecha lejana.
      existente.temporada = rec.temporada;
      existente.temporada_empuje = rec.empuje;
      existente.temporada_esperado = rec.esperado;
      existente.temporada_faltan = rec.faltan;
      existente.temporada_por_pista = !!rec.porPista;
      existente.temporada_a_mano = !!rec.aMano;
      existente.temporada_por_mano = !!rec.porMano;
      existente.temporada_urgencia = rec.urgencia;
      if (rec.urgencia > existente.urgencia) {
        existente.urgencia = rec.urgencia;
        existente.tier = nivelPorPuntaje(rec.urgencia);
        existente.porTemporada = true;
      }
      continue;
    }

    // No estaba: entra por la fecha y nada más.
    const esVariedad = variedad != null;
    const packSize = packSizeDe(prod, esVariedad ? variedad : null);
    const costoUnidad = Math.max(0, Number(prod.costo) || 0);
    const faltanUnidades = Math.max(0, Number(rec.faltan) || 0);
    let qty, costRow = costoUnidad;
    if (esVariedad && packSize > 0) {
      qty = Math.ceil(faltanUnidades / packSize);
      if (costoUnidad > 0) costRow = costoUnidad * packSize;
    } else {
      qty = Math.ceil(faltanUnidades);
      if (qty > 0 && packSize > 1) qty = Math.ceil(qty / packSize) * packSize;
    }
    // Lo que el dueño agregó a mano se muestra aunque hoy tenga stock de sobra:
    // lo puso él para verlo, y la cantidad la decide él. El resto, si no falta
    // nada, no tiene por qué ocupar un renglón.
    if (!(qty > 0)) {
      if (!rec.aMano) continue;
      qty = 1;
    }

    const row = {
      doc_id: rec.docId,
      nombre: prod.nombre || rec.nombre || '(sin nombre)',
      codigo: prod.codigo || '',
      rubro: prod.rubro || '',
      sub_rubro: prod.sub_rubro || '',
      proveedor: prod.proveedor || '',
      marca: prod.marca || '',
      urgente: false,
      critico: rec.stock <= 0,
      urgencia: rec.urgencia,
      riesgo: 0,
      importancia: 0,
      rank_mes: 0,
      rank_reciente: 0,
      tier: nivelPorPuntaje(rec.urgencia),
      // Sin texto de cobertura: este producto no está en la lista porque se
      // agote, y poner "se agota en X días" al lado de la fecha confunde los
      // dos motivos, que es justo lo que había que separar.
      cobertura_texto: '',
      stock: esVariedad && packSize > 0 ? rec.stock / packSize : rec.stock,
      stock_min: 0,
      esVariedad,
      variedad: esVariedad ? variedad : null,
      packSize,
      stockUnits: rec.stock,
      vel_dia: 0,
      vel_semana: 0,
      unidades_ventana: 0,
      ritmo_dias: 0,
      unidades_7: 0,
      dias_con_mov_7: 0,
      vel_dia_30: 0,
      vel_dia_7: 0,
      dias_cobertura: Infinity,
      perdidaSemana: 0,
      perdidaHorizonte: 0,
      producto: prod,
      busca: '',
      qty,
      cost: costRow,
      subtotal: qty * costRow,
      sinCosto: !(costRow > 0),
      qtyManual: false,
      fits: false,
      acumulado: 0,
      checked: false,
      registrado: false,
      anotado: null,
      porTemporada: true,
      temporada: rec.temporada,
      temporada_empuje: rec.empuje,
      temporada_esperado: rec.esperado,
      temporada_faltan: rec.faltan,
      temporada_por_pista: !!rec.porPista,
      temporada_a_mano: !!rec.aMano,
      temporada_por_mano: !!rec.porMano,
      temporada_urgencia: rec.urgencia,
    };
    row.anotado = anotados[keyAnotado(row)] || null;
    row.busca = textoBusquedaCompra(row);
    nuevas.push(row);
    porClave.set(claveFila(row.doc_id, row.variedad), row);
  }
  // La cobertura objetivo no entra en la cuenta de estas filas a propósito: lo
  // que manda es cuánto se vende en la fecha, no el horizonte de compra normal.
  return nuevas;
}

// Cantidad sugerida para cubrir `dias` días de venta (respeta el stock_min).
// Variedades: packs para cubrir el horizonte según su ritmo por color; sin
// ritmo/contenido conocido, mantiene la cantidad del rango configurado.
// Conjuntos sin variedades: redondeo a packs enteros.
function qtyADias(r, dias) {
  if (r.esVariedad) {
    if (r.packSize > 0 && r.vel_dia > 0) {
      const faltan = Math.max(0, r.vel_dia * dias - r.stockUnits);
      return Math.ceil(faltan / r.packSize);
    }
    return r.qty;
  }
  let q = sugerirCantidad(r.vel_dia, r.stock, r.stock_min, dias);
  if (q > 0 && r.packSize > 1) q = Math.ceil(q / r.packSize) * r.packSize;
  return q;
}

// Asigna el presupuesto en dos pasadas:
//   1. Lo SÍ O SÍ entra completo. Si a la cobertura objetivo no alcanza, se
//      achica la cobertura (hasta un piso de 7 días) antes de dejar afuera un
//      solo producto imprescindible. Cantidades editadas a mano se respetan.
//   2. Con lo que sobra se marca el resto en orden de prioridad: lo que entra,
//      entra, aunque haya algo más caro antes que no entró (relleno greedy).
//      Excepción: si ni lo SÍ O SÍ entró completo, no se gasta en niveles
//      menores — esa plata es de los imprescindibles.
// Deja en cada fila subtotal / fits / acumulado y devuelve corte + totales para
// los avisos.
function asignarPresupuesto(rows, budget, coberturaObj) {
  const sisi = rows.filter(r => r.tier === 'sisi' && !r.sinCosto && !r.registrado);
  const costoSisiA = dias => sisi.reduce((t, r) => t + (r.qtyManual ? r.qty : qtyADias(r, dias)) * r.cost, 0);

  const costoSisiObjetivo = costoSisiA(coberturaObj);
  let diasUsados = coberturaObj;
  if (sisi.length && costoSisiObjetivo > budget) {
    diasUsados = MIN_COBERTURA_DIAS;
    for (let d = coberturaObj - 1; d > MIN_COBERTURA_DIAS; d--) {
      if (costoSisiA(d) <= budget) { diasUsados = d; break; }
    }
  }
  for (const r of sisi) {
    if (!r.qtyManual) r.qty = qtyADias(r, diasUsados);
  }
  const costoSisiUsado = costoSisiA(diasUsados);
  const sisiCorto = costoSisiUsado > budget;

  let running = 0;
  rows.forEach(r => {
    r.subtotal = r.qty * r.cost;
    r.fits = false;
    if (r.sinCosto || r.registrado || !(r.subtotal > 0)) { r.acumulado = running; return; }
    const bloqueado = sisiCorto && r.tier !== 'sisi';
    if (!bloqueado && running + r.subtotal <= budget) {
      running += r.subtotal;
      r.fits = true;
    }
    r.acumulado = running;
  });
  return {
    totalFit: running,
    diasUsados,
    degradado: sisi.length > 0 && diasUsados < coberturaObj,
    costoSisiUsado,
    costoSisiObjetivo,
    sisiCorto,
  };
}

// ── Estado del módulo ─────────────────────────────────────────────────────────
let _db = null;
let _state = null;

export async function renderCentroCompras(container, db) {
  _db = db;
  cerrarDropdown();   // un panel abierto de la visita anterior no puede quedar colgado
  ocultarTip();
  // Shell sincrónico (cancela el skeleton diferido de main.js y da feedback ya).
  container.innerHTML = shellHtml();

  const ym = hoyAR().slice(0, 7);
  let alertas, balCfg, diasDoc, comprasCfg, temporadas;
  try {
    [alertas, balCfg, diasDoc, comprasCfg, temporadas] = await Promise.all([
      refrescarAlertas({ silent: true }),
      loadBalanceConfig(db),
      loadDiasMes(db, ym),
      loadComprasConfig(db),
      // El estudio de épocas es UN documento. Si nunca se hizo vuelve null y la
      // página funciona igual: aparece el cartel para hacerlo.
      cargarEstudio(db).catch(e => {
        console.warn('[centro_compras] no se pudo leer el estudio de épocas:', e);
        return { estudio: null, vigente: false };
      }),
    ]);
  } catch (e) {
    console.error('[centro_compras] error cargando datos:', e);
    // Si #cc-root ya no está, el usuario navegó a otra página mientras cargaba:
    // no pisar el contenido de esa página con nuestro error.
    const host = container.querySelector('#cc-root');
    if (host) host.innerHTML = `<div class="empty-state"><span class="material-icons">error_outline</span>
      <p>No se pudieron cargar los datos. Reintentá.</p></div>`;
    return;
  }

  comprasCfg = comprasCfg || {};
  const budget = computeBudget(balCfg || {}, diasDoc, comprasCfg, ym);
  const rows = buildRows(fuentesCompra(alertas, comprasCfg), comprasCfg);
  // Filtros y búsqueda de la última visita en esta pestaña: al ir al Catálogo
  // a corregir una ficha y volver, la lista sigue acotada a lo mismo.
  const guardado = leerFiltrosGuardados();

  _state = {
    ym,
    alertasBase: alertas,
    balCfg: balCfg || {},
    diasDoc: diasDoc || { ym, dias: {} },
    comprasCfg,
    budget,
    rows,
    period: 'mes',        // 'mes' | 'semana'
    filtroAnotados: false,   // true = la tabla muestra solo lo marcado "en el cuaderno"
    busqueda: guardado.busqueda,   // texto del buscador de la lista (se filtra sin acentos)
    filtros: guardado.filtros,     // rubro / subrubro / proveedor / marca / nivel elegidos
    topeManual: null,
    medio: fuenteValida(comprasCfg.medio_default),
    proveedor: comprasCfg.proveedor_default || '',
    fecha: hoyAR(),
    ajustesOpen: false,
    // Lo que se viene por almanaque + lo que el sistema aprendió de las ventas
    // viejas sobre esas fechas.
    estudio: temporadas?.estudio || null,
    ajustes: temporadas?.ajustes || {},   // lo que el dueño corrigió a mano
    buscarFecha: '',                      // texto del buscador de "agregar a esta fecha"
    verSacados: '',                       // id de la fecha cuyo listado de sacados está desplegado
    estudioVigente: !!temporadas?.vigente,
    proximas: [],
    estudiando: false,
    temporadaFiltro: '',     // id de la fecha por la que está filtrada la lista
    fechasOpen: false,       // panel "Próximas fechas" desplegado
    fechasAbiertas: [],      // fechas lejanas que el dueño pidió ver igual
  };
  mezclarTemporadas();

  const root = container.querySelector('#cc-root');
  if (!root) return;   // navegaron a otra página mientras cargaban los datos
  root.innerHTML = pageHtml();
  bindEvents(root);
  recalc(true);
  limpiarAnotadosViejos();

  // Se llegó acá desde el aviso "se viene tal fecha": abrir esa fecha con todo
  // lo suyo, que es lo que el dueño fue a buscar al tocar el aviso.
  const pedida = window.__ccAbrirFecha;
  if (pedida) {
    window.__ccAbrirFecha = null;
    _state.fechasOpen = true;
    abrirFecha(pedida);
    // Acomodar la vista es lo último y lo menos importante: si falla no puede
    // llevarse puesta la pantalla entera, que es lo que el dueño vino a ver.
    try { document.getElementById('cc-fechas')?.scrollIntoView?.({ block: 'nearest' }); } catch (_) {}
  }
}

// ── Época: calcular y mezclar con la lista ────────────────────────────────────
// Se llama al entrar, al actualizar y después de rehacer el estudio. El catálogo
// sale de la cache que acaba de llenar `refrescarAlertas` (el mismo listener del
// store: no agrega lecturas), y el ritmo de venta, de las ventanas que
// notifications.js ya computó para las alertas.
function mezclarTemporadas() {
  const s = _state;
  s.proximas = [];
  try {
    const productos = peekCacheValue('catalogo:all') || [];
    if (!productos.length) return;
    const { proximas, recomendaciones } = recomendacionesDeTemporada({
      estudio: s.estudio,
      productos,
      ventanas: obtenerVentanasVenta(),
      hoy: hoyAR(),
      // Las fechas lejanas que el dueño abrió a mano desde "Próximas fechas".
      extraIds: s.fechasAbiertas,
      ajustes: s.ajustes,
    });
    s.proximas = proximas;
    const nuevas = aplicarTemporadas(s.rows, recomendaciones, s.comprasCfg);
    if (nuevas.length) s.rows.push(...nuevas);
    // El orden se rearma entero: las filas nuevas y las que subieron por la
    // fecha tienen que quedar en su lugar.
    s.rows.sort(compararUrgencia);
  } catch (e) {
    console.warn('[centro_compras] no se pudieron calcular las épocas:', e);
  }
}

// Rehace el estudio leyendo TODO el histórico de ventas. Es la única lectura
// cara de la pantalla y por eso la dispara el usuario a mano (o el cartel de
// "está viejo"): son 36.000 renglones.
async function estudiarEpocas() {
  const s = _state;
  if (s.estudiando) return;
  s.estudiando = true;
  paintTemporadas();
  try {
    const productos = peekCacheValue('catalogo:all') || [];
    s.estudio = await rehacerEstudio(_db, { productos });
    s.estudioVigente = true;
    // Las filas que habían entrado por época se rehacen desde cero: con el
    // estudio nuevo pueden ser otras.
    s.rows = buildRows(fuentesCompra(s.alertasBase, s.comprasCfg), s.comprasCfg);
    mezclarTemporadas();
    recalc(true);
  } catch (e) {
    console.error('[centro_compras] estudiar épocas:', e);
    await alertDialog({
      title: 'No se pudo estudiar',
      message: 'No se pudieron leer las ventas para estudiar las fechas. Revisá la conexión e intentá de nuevo.',
      type: 'error',
    });
  } finally {
    s.estudiando = false;
    paintTemporadas();
  }
}

// ── Corregir a mano qué va en cada fecha ──────────────────────────────────────
// El sistema mide y adivina; el que atiende el mostrador sabe cosas que no
// están en ningún dato. Lo que se corrige acá gana sobre lo calculado y queda
// para las próximas veces: es lo único del almanaque que no se recalcula.

/** Aplica el cambio en memoria, repinta y guarda. Si el guardado falla, avisa
 *  y vuelve atrás: no puede quedar en pantalla algo que no se guardó. */
async function guardarAjuste(idFecha, clave, accion, datos) {
  const s = _state;
  const antes = JSON.parse(JSON.stringify(s.ajustes || {}));
  const aj = s.ajustes[idFecha] || { suma: {}, saca: {} };
  const suma = { ...(aj.suma || {}) };
  const saca = { ...(aj.saca || {}) };
  if (accion === 'sacar') { saca[clave] = true; delete suma[clave]; }
  else if (accion === 'sumar') { suma[clave] = datos; delete saca[clave]; }
  else { delete suma[clave]; delete saca[clave]; }
  s.ajustes = { ...s.ajustes, [idFecha]: { suma, saca } };

  // Recalcular la lista entera: un producto agregado puede no estar todavía.
  s.rows = buildRows(fuentesCompra(s.alertasBase, s.comprasCfg), s.comprasCfg);
  mezclarTemporadas();
  recalc(false);

  try {
    if (accion === 'borrar') await borrarAjusteManual(_db, idFecha, clave);
    else await guardarAjusteManual(_db, idFecha, clave, { accion, datos });
  } catch (e) {
    console.error('[centro_compras] guardar ajuste de fecha:', e);
    s.ajustes = antes;
    s.rows = buildRows(fuentesCompra(s.alertasBase, s.comprasCfg), s.comprasCfg);
    mezclarTemporadas();
    recalc(false);
    await alertDialog({
      title: 'No se pudo guardar',
      message: 'El cambio no llegó a la nube. Revisá la conexión e intentá de nuevo.',
      type: 'error',
    });
  }
}

function sacarDeFecha(i) {
  const r = _state.rows[i];
  if (!r || !r.temporada) return;
  guardarAjuste(r.temporada.id, claveProducto(r.producto?.nombre || r.nombre, r.variedad || ''), 'sacar');
}

function sumarAFecha(idFecha, clave, nombre) {
  if (!idFecha || !clave) return;
  const [n, c] = String(clave).split('||');
  _state.buscarFecha = '';
  guardarAjuste(idFecha, clave, 'sumar', { n: n || nombre, c: c || '' });
}

function devolverAFecha(idFecha, clave) {
  if (!idFecha || !clave) return;
  guardarAjuste(idFecha, clave, 'borrar');
}

// ── Marca "ya lo anoté en el cuaderno" ────────────────────────────────────────
// El dueño lleva la lista de compras en un cuaderno de papel. La marca dice "este
// ya está en el cuaderno": la fila queda resaltada y NO se saca de la lista (si
// el proveedor no lo tiene, el faltante sigue vivo semanas). Queda guardada en
// control_config/compras, así se ve igual desde cualquier PC.
/**
 * La fila se va viendo hacia el cuaderno antes de que la tabla se reacomode.
 *
 * Sin esto el producto se esfuma: la tabla se repinta entera y la fila
 * reaparece cientos de filas más abajo, fuera de la pantalla. En una lista de
 * mil y pico, el dueño toca el cuaderno y lo que ve es que algo desapareció.
 *
 * Un cuarto de segundo alcanza para entender que se fue para abajo y no molesta
 * al que ya lo sabe y va marcando de a varios seguidos. Con las animaciones
 * apagadas en el sistema no se espera nada: el repintado sale igual de bien,
 * sólo que instantáneo.
 */
function verLaFilaIrse(i) {
  const fila = document.querySelector(`#cc-tbody tr[data-idx="${i}"]`);
  if (!fila) return Promise.resolve();
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return Promise.resolve();
  } catch (_) { /* sin matchMedia (jsdom): se anima igual, no molesta a nadie */ }
  fila.classList.add('cc-row-yendose');
  return new Promise(listo => {
    let cerrado = false;
    const terminar = () => { if (!cerrado) { cerrado = true; listo(); } };
    // El `transitionend` puede no llegar (la fila se saca antes, la pestaña
    // está en segundo plano): el plazo lo cierra igual, así el repintado nunca
    // queda colgado esperando un evento.
    fila.addEventListener('transitionend', terminar, { once: true });
    setTimeout(terminar, 260);
  });
}

async function toggleAnotado(i) {
  const s = _state;
  const r = s.rows[i];
  if (!r) return;
  const k = keyAnotado(r);
  r.anotado = r.anotado ? null : hoyAR();
  const mapa = { ...(s.comprasCfg.anotados || {}) };
  if (r.anotado) mapa[k] = r.anotado; else delete mapa[k];
  s.comprasCfg = { ...s.comprasCfg, anotados: mapa };
  if (r.anotado) await verLaFilaIrse(i);
  paintTable();
  paintResumen();
  try {
    await saveComprasConfig(_db, { anotados: { [k]: r.anotado ? r.anotado : deleteField() } });
  } catch (e) {
    console.warn('[centro_compras] no se pudo guardar la marca de anotado:', e);
  }
}

// Limpieza silenciosa: marcas de productos que ya no figuran en la lista (se
// repusieron o dejaron de rotar) se borran pasados ANOTADO_CADUCA_DIAS. Las de
// productos que siguen en la lista no se tocan nunca.
function limpiarAnotadosViejos() {
  const s = _state;
  const mapa = s.comprasCfg.anotados || {};
  const claves = Object.keys(mapa);
  if (!claves.length) return;
  const vivos = new Set(s.rows.map(keyAnotado));
  const limite = new Date(Date.now() - ANOTADO_CADUCA_DIAS * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const borrar = claves.filter(k => !vivos.has(k) && String(mapa[k] || '') < limite);
  if (!borrar.length) return;
  const nuevo = { ...mapa };
  const partial = {};
  for (const k of borrar) { delete nuevo[k]; partial[k] = deleteField(); }
  s.comprasCfg = { ...s.comprasCfg, anotados: nuevo };
  saveComprasConfig(_db, { anotados: partial })
    .catch(e => console.warn('[centro_compras] limpiar anotados viejos:', e));
}

function fuenteValida(f) { return MEDIOS.some(m => m.k === f) ? f : 'efectivo'; }

// ── Presupuesto activo según período / tope ───────────────────────────────────
function budgetActivo() {
  const s = _state;
  if (s.topeManual != null) return s.topeManual;
  return s.period === 'semana' ? s.budget.gastableSemana : s.budget.gastableMes;
}

function coberturaObjetivo() {
  return Number(_state.comprasCfg.cobertura_dias_objetivo) || COBERTURA_DEFAULT;
}

// Reasigna el presupuesto, (opcional) resetea la selección a lo que entra, y
// repinta gauge + resumen + avisos + tabla + plan.
function recalc(resetSelection) {
  const s = _state;
  const budget = budgetActivo();
  s.alloc = asignarPresupuesto(s.rows, budget, coberturaObjetivo());
  if (resetSelection) {
    s.rows.forEach(r => { r.checked = r.fits; });
  }
  paintGauge();
  paintResumen();
  paintWarn();
  paintTemporadas();
  paintFechas();
  paintTable();
  paintPlan();
}

function planSeleccionado() {
  const items = _state.rows.filter(r => r.checked && !r.registrado && r.qty > 0 && r.cost > 0);
  const total = items.reduce((sum, r) => sum + r.qty * r.cost, 0);
  return { items, total };
}

// ── HTML: shell + página ──────────────────────────────────────────────────────
function shellHtml() {
  return `
    <div id="cc-root">
      <div class="cc-loading">
        <div class="skel" style="height:120px;border-radius:14px;margin-bottom:16px"></div>
        <div class="skel" style="height:44px;border-radius:10px;margin-bottom:8px"></div>
        <div class="skel" style="height:280px;border-radius:12px"></div>
      </div>
    </div>`;
}

function pageHtml() {
  const s = _state;
  return `
    ${gaugeShell()}
    <div class="cc-controls">
      <div class="cc-period">
        <button class="cc-seg" data-action="period" data-period="mes">Mes</button>
        <button class="cc-seg" data-action="period" data-period="semana">Semana</button>
      </div>
      <div class="cc-tope">
        <span class="material-icons">local_shipping</span>
        <input id="cc-tope" type="text" inputmode="numeric" placeholder="Tope de este viaje (ej 500.000)"
               value="${s.topeManual != null ? fmt(s.topeManual, 0) : ''}" />
        <button class="cc-icon-btn" data-action="tope-clear" title="Quitar tope">
          <span class="material-icons">close</span>
        </button>
      </div>
      <div class="cc-spacer"></div>
      <button class="cc-btn-fechas" data-action="fechas"
              title="Todas las fechas del año que mueven venta: abrí una y mirá qué convendría comprar">
        <span class="material-icons">event</span> Próximas fechas
      </button>
      <button class="cc-icon-btn" data-action="actualizar" title="Actualizar stock y ritmo">
        <span class="material-icons">refresh</span>
      </button>
      <button class="cc-icon-btn" data-action="ajustes" title="Ajustes de rentabilidad">
        <span class="material-icons">tune</span>
      </button>
    </div>
    <div id="cc-ajustes" class="cc-ajustes" style="display:none"></div>
    <div id="cc-fechas" class="cc-fechas" style="display:none"></div>
    <div id="cc-epocas" class="cc-epocas"></div>
    <div id="cc-warn"></div>
    <div id="cc-tiers" class="cc-tiers"></div>

    <div class="cc-registrar">
      <div class="cc-reg-field">
        <label>Proveedor / viaje</label>
        <input id="cc-prov" type="text" placeholder="Mayorista..." value="${esc(s.proveedor)}" />
      </div>
      <div class="cc-reg-field">
        <label>Medio</label>
        <select id="cc-medio">
          ${MEDIOS.map(m => `<option value="${m.k}"${m.k === s.medio ? ' selected' : ''}>${m.label}</option>`).join('')}
        </select>
      </div>
      <div class="cc-reg-field">
        <label>Fecha</label>
        <input id="cc-fecha" type="date" value="${s.fecha}" />
      </div>
      <div class="cc-spacer"></div>
      <div id="cc-plan" class="cc-plan"></div>
      <button class="cc-btn-primary" data-action="registrar">
        <span class="material-icons">shopping_cart_checkout</span> Registrar compra
      </button>
    </div>

    <div class="table-card cc-table-card">
      <div class="table-card-header">
        <h3>Lista de compra priorizada</h3>
        <div class="cc-buscar">
          <span class="material-icons">search</span>
          <input id="cc-buscar" type="text" autocomplete="off" placeholder="Buscar en la lista…"
                 value="${esc(s.busqueda)}" />
          <button type="button" class="cc-buscar-x" data-action="buscar-clear" title="Limpiar búsqueda">
            <span class="material-icons">close</span>
          </button>
        </div>
        <span class="cc-hint">Del más urgente al que puede esperar: conjuga lo que más se vende en el mes, lo que más se movió estos días y el stock mínimo · Registrar descuenta el presupuesto, no el stock · La lapicera marca lo que ya está en el cuaderno.</span>
      </div>
      <div class="cc-filtros" id="cc-filtros">
        <span class="material-icons cc-filtros-ico" title="Los filtros se combinan entre sí y con la lupa">filter_list</span>
        ${CAMPOS_FILTRO.map(ddHtml).join('')}
        <button type="button" class="cc-filtros-clear" data-action="filtros-clear" hidden
                title="Sacar todos los filtros (la búsqueda queda)">
          <span class="material-icons">filter_alt_off</span> Limpiar filtros
        </button>
        <span class="cc-filtros-count" id="cc-filtros-count"></span>
      </div>
      <div class="table-wrap">
        <table class="cc-table">
          <thead><tr>
            <th style="width:34px"></th>
            <th style="text-align:center;width:78px" class="cc-tip-ancla"
                data-tip="Urgencia de compra, de 0 a 100&#10;Junta lo que más se vende en el mes, lo que más se movió estos últimos días y el stock mínimo, contra lo que le queda de stock.">Urgencia</th>
            <th>Producto</th>
            <th>Rubro</th>
            <th style="text-align:right">Stock</th>
            <th style="text-align:right">Ritmo</th>
            <th style="text-align:center;width:92px">Cantidad</th>
            <th style="text-align:right">Costo</th>
            <th style="text-align:right">Subtotal</th>
            <th style="text-align:right">Acumulado</th>
          </tr></thead>
          <tbody id="cc-tbody"></tbody>
        </table>
      </div>
    </div>`;
}

function gaugeShell() {
  return `<div id="cc-gauge" class="cc-gauge"></div>`;
}

// ── Pintado: gauge ────────────────────────────────────────────────────────────
function paintGauge() {
  const s = _state;
  const b = s.budget;
  const disp = budgetActivo();
  const gastado = b.manual ? b.manual.compradoDesde : b.comprasProductoMes;
  const colchon = b.manual ? b.manual.monto : gastado + b.gastableMes;   // presupuesto total (antes de gastar)
  const usadoPct = colchon > 0 ? Math.min(100, (gastado / colchon) * 100) : (gastado > 0 ? 100 : 0);
  const librePct = Math.max(0, 100 - usadoPct);
  const color = librePct <= 0 ? 'var(--danger)' : librePct < 30 ? 'var(--warning)' : 'var(--success)';
  const periodoLabel = s.topeManual != null
    ? 'para este viaje'
    : s.period === 'semana' ? `esta semana (quedan ${b.semanasRestantes})` : `este mes · ${labelFromYm(s.ym)}`;

  const negativo = b.presupuestoMes < 0;
  const advertencia = negativo
    ? `<div class="cc-gauge-alert">Ya te pasaste del colchón del mes por ${money(Math.abs(b.presupuestoMes))}. Frená las compras.</div>`
    : '';

  // Desglose: con monto manual, la cuenta es monto fijado − comprado desde que
  // se fijó; sin manual, la fórmula automática desde el Balance.
  const fechaMan = b.manual?.fecha ? `${b.manual.fecha.slice(8, 10)}/${b.manual.fecha.slice(5, 7)}` : '';
  const breakdown = b.manual
    ? `<span class="cc-chip cc-chip-manual" title="Este monto lo cargaste vos, no sale del cálculo automático">monto fijado a mano${fechaMan ? ` el ${fechaMan}` : ''}</span>
       ${money(b.manual.monto)}
       <span class="cc-op">−</span> Comprado desde entonces ${money(b.manual.compradoDesde)}
       <span class="cc-op">=</span> <b>${money(b.gastableMes)}</b> del mes
       <button type="button" class="cc-plata-auto" data-action="plata-auto" title="Descartar el monto manual y volver a calcular desde el Balance">Usar cálculo automático</button>`
    : `Ingresos ${money(b.ingresosMes)}
       <span class="cc-op">−</span> Fijos ${money(b.gastosFijosMes)}
       <span class="cc-op">−</span> Rentabilidad ${money(b.rentabilidad)}
       <span class="cc-op">−</span> Comprado ${money(b.comprasProductoMes)}
       <span class="cc-op">=</span> <b>${money(b.gastableMes)}</b> del mes`;

  s.dataFresca = tieneIngresosHoy(s.diasDoc);
  const freshHint = (s.dataFresca || b.manual) ? '' :
    `<div class="cc-gauge-hint"><span class="material-icons">info</span>
       El día de hoy no tiene caja cargada en el Balance — el número puede quedar corto.</div>`;

  document.getElementById('cc-gauge').innerHTML = `
    <div class="cc-gauge-head">
      <div class="cc-gauge-label">Podés gastar en producto <span class="cc-gauge-periodo">${periodoLabel}</span></div>
      <div class="cc-gauge-actions">
        <button type="button" class="cc-icon-btn" data-action="editar-plata" title="Cargar a mano la plata real que tenés para gastar este mes (se guarda)">
          <span class="material-icons">edit</span>
        </button>
      </div>
    </div>
    <div class="cc-gauge-value" style="color:${color}">${money(Math.max(0, disp))}</div>
    <div id="cc-plata-form" class="cc-plata-form" style="display:none">
      <label>Plata real para gastar en producto este mes</label>
      <div class="cc-plata-row">
        <input id="cc-plata-input" type="text" inputmode="numeric" placeholder="ej 2.000.000"
               value="${fmt(b.manual ? b.manual.monto : b.gastableMes, 0)}" />
        <button type="button" class="cc-btn-primary" data-action="plata-save"><span class="material-icons">save</span> Guardar</button>
        <button type="button" class="cc-btn-ghost" data-action="plata-cancel">Cancelar</button>
      </div>
      <div class="cc-plata-hint">Queda guardado para ${labelFromYm(s.ym)} y baja solo con cada compra que registres.</div>
    </div>
    <div class="cc-bar"><div class="cc-bar-fill" style="width:${librePct.toFixed(1)}%;background:${color}"></div></div>
    <div class="cc-gauge-breakdown">${breakdown}</div>
    ${advertencia}
    ${freshHint}`;
  // Mantener el botón activo del segmento en sync
  document.querySelectorAll('.cc-seg').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.period === s.period && s.topeManual == null);
  });
}

// Guarda (o borra, con monto null) el presupuesto manual del mes en
// control_config/compras y recalcula todo con el número nuevo.
async function guardarPlataManual(monto) {
  const s = _state;
  const partial = monto == null
    ? { presupuesto_manual: null, presupuesto_manual_ym: null, presupuesto_manual_base: null, presupuesto_manual_fecha: null }
    : { presupuesto_manual: monto, presupuesto_manual_ym: s.ym, presupuesto_manual_base: s.budget.comprasProductoMes, presupuesto_manual_fecha: hoyAR() };
  s.comprasCfg = { ...s.comprasCfg, ...partial };
  try {
    await saveComprasConfig(_db, partial);
  } catch (e) {
    console.error('[centro_compras] guardar plata manual:', e);
    await alertDialog({ title: 'No se pudo guardar', message: 'Revisá la conexión e intentá de nuevo.', type: 'error' });
    return;
  }
  s.budget = computeBudget(s.balCfg, s.diasDoc, s.comprasCfg, s.ym);
  recalc(true);
}

function tieneIngresosHoy(diasDoc) {
  const hoy = hoyAR();
  if (diasDoc?.ym && diasDoc.ym !== hoy.slice(0, 7)) return true;   // no aplica a meses viejos
  const dia = diasDoc?.dias?.[hoy.slice(8, 10)];
  return !!(dia && (dia.ingresos || []).some(x => Number(x.monto) > 0));
}

// ── Pintado: tabla ────────────────────────────────────────────────────────────
// ── Filtros de la lista (rubro / subrubro / proveedor / marca / nivel) ────────
// La lógica de qué pasa y qué opciones tiene cada select vive en
// filtros_compras.js; acá solo se pintan los selects y se guarda lo elegido.
const FILTROS_STORAGE_KEY = 'cc_filtros_lista';

function criteriosLista() {
  const s = _state;
  return {
    filtros: s.filtros,
    busqueda: s.busqueda,
    soloAnotados: s.filtroAnotados,
    soloTemporada: s.temporadaFiltro || '',
  };
}

function leerFiltrosGuardados() {
  let raw = null;
  try { raw = JSON.parse(sessionStorage.getItem(FILTROS_STORAGE_KEY) || 'null'); } catch (_) { raw = null; }
  return {
    filtros: sanearFiltros(raw?.filtros),
    busqueda: typeof raw?.busqueda === 'string' ? raw.busqueda.trim() : '',
  };
}

function guardarFiltros() {
  const s = _state;
  try {
    if (!cantidadFiltros(s.filtros) && !s.busqueda) sessionStorage.removeItem(FILTROS_STORAGE_KEY);
    else sessionStorage.setItem(FILTROS_STORAGE_KEY, JSON.stringify({ filtros: s.filtros, busqueda: s.busqueda }));
  } catch (_) { /* sin storage (modo privado): los filtros viven solo en memoria */ }
}

// ── Desplegables de los filtros ───────────────────────────────────────────────
// El <select> nativo no se puede estilar ni buscar adentro, así que cada
// filtro es un botón (campo + lo elegido) que abre un panel propio: lupa
// arriba, la lista con la cuenta de cada opción y el tilde en la elegida.
// Uno solo abierto a la vez; se cierra al elegir, con Escape o clickeando
// afuera. Enter en la lupa elige la primera opción que quedó.
const _dd = { abierto: null };

function ddHtml(c) {
  return `<div class="cc-dd" data-campo="${c.k}">
    <button type="button" class="cc-dd-btn" data-action="dd-toggle" data-campo="${c.k}"
            aria-haspopup="listbox" aria-expanded="false">
      <span class="cc-dd-label">${esc(c.label)}</span>
      <span class="cc-dd-value"></span>
      <span class="material-icons">expand_more</span>
    </button>
    <div class="cc-dd-panel" hidden>
      <div class="cc-dd-buscar">
        <span class="material-icons">search</span>
        <input type="text" class="cc-dd-input" data-campo="${c.k}" autocomplete="off"
               placeholder="Buscar ${esc(c.label.toLowerCase())}…" aria-label="Buscar ${esc(c.label.toLowerCase())}" />
      </div>
      <div class="cc-dd-lista" role="listbox" aria-label="${esc(c.label)}"></div>
    </div>
  </div>`;
}

function ddDe(campo) {
  return campo ? document.querySelector(`.cc-dd[data-campo="${campo}"]`) : null;
}

// La lista del panel: "Todos" arriba (con el total de lo que pasa los demás
// criterios), las opciones que coinciden con la lupa, y "Sin proveedor" al
// final separado. Con texto en la lupa, "Todos" no se muestra.
function pintarListaDd(dd, campo, opts, elegido, texto) {
  const def = CAMPOS_FILTRO.find(c => c.k === campo);
  const lista = dd.querySelector('.cc-dd-lista');
  if (!def || !lista) return;
  const item = (valor, label, n, extra = '') => {
    const sel = valor === elegido;
    return `<button type="button" class="cc-dd-opt${sel ? ' is-sel' : ''}${extra}" role="option" aria-selected="${sel}"
              data-action="dd-opt" data-campo="${campo}" data-valor="${esc(valor)}">
      <span class="material-icons">${sel ? 'check' : ''}</span>
      <span class="cc-dd-txt">${esc(label)}</span><span class="cc-dd-n">${n}</span></button>`;
  };
  const visibles = filtrarOpciones(opts, texto);
  const parts = [];
  if (!tokensDd(texto)) parts.push(item('', def.todos, opts.reduce((t, o) => t + o.n, 0)));
  parts.push(...visibles.filter(o => o.valor !== SIN_VALOR).map(o => item(o.valor, o.label, o.n)));
  const sin = visibles.find(o => o.valor === SIN_VALOR);
  if (sin) parts.push('<div class="cc-dd-sep"></div>', item(sin.valor, sin.label, sin.n, ' cc-dd-sin'));
  if (!visibles.length) parts.push(`<div class="cc-dd-vacio">Nada coincide con "${esc(texto)}"</div>`);
  lista.innerHTML = parts.join('');
}
function tokensDd(texto) { return String(texto || '').trim().length > 0; }

function repintarListaDd(campo) {
  const dd = ddDe(campo);
  if (!dd) return;
  const opts = opcionesCompras(_state.rows, criteriosLista(), campo);
  const input = dd.querySelector('.cc-dd-input');
  pintarListaDd(dd, campo, opts, _state.filtros[campo] || '', input ? input.value : '');
}

function abrirDropdown(campo) {
  if (_dd.abierto === campo) return;
  cerrarDropdown();
  const dd = ddDe(campo);
  if (!dd || dd.hidden) return;
  _dd.abierto = campo;
  dd.classList.add('is-open');
  const panel = dd.querySelector('.cc-dd-panel');
  panel.hidden = false;
  dd.querySelector('.cc-dd-btn').setAttribute('aria-expanded', 'true');
  repintarListaDd(campo);
  // Si el panel se sale por la derecha de la pantalla, se cuelga del borde
  // derecho del botón.
  const r = panel.getBoundingClientRect();
  const ancho = window.innerWidth || document.documentElement.clientWidth || 0;
  panel.classList.toggle('is-right', ancho > 0 && r.right > ancho - 8);
  const input = dd.querySelector('.cc-dd-input');
  if (input) input.focus();
  document.addEventListener('mousedown', onDocMouseDown);
}

function cerrarDropdown() {
  document.removeEventListener('mousedown', onDocMouseDown);
  const campo = _dd.abierto;
  _dd.abierto = null;
  const dd = ddDe(campo);
  if (!dd) return;
  dd.classList.remove('is-open');
  const panel = dd.querySelector('.cc-dd-panel');
  if (panel) panel.hidden = true;
  const btn = dd.querySelector('.cc-dd-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  const input = dd.querySelector('.cc-dd-input');
  if (input) input.value = '';
}

function onDocMouseDown(e) {
  const dd = ddDe(_dd.abierto);
  if (!dd || !dd.contains(e.target)) cerrarDropdown();
}

function elegirOpcionDd(campo, valor) {
  const s = _state;
  if (!(campo in s.filtros)) return;
  s.filtros[campo] = valor || '';
  cerrarDropdown();
  guardarFiltros();
  paintTable();
  const btn = ddDe(campo)?.querySelector('.cc-dd-btn');
  if (btn) btn.focus({ preventScroll: true });
}

// Teclado adentro del panel: Escape cierra y vuelve al botón; flechas
// recorren las opciones; Enter en la lupa elige la primera que quedó.
function onKeydown(e) {
  const campo = _dd.abierto;
  if (!campo) return;
  const dd = ddDe(campo);
  if (!dd || !dd.contains(e.target)) return;
  const opciones = [...dd.querySelectorAll('.cc-dd-opt')];
  if (e.key === 'Escape') {
    e.preventDefault();
    cerrarDropdown();
    dd.querySelector('.cc-dd-btn')?.focus();
    return;
  }
  if (e.key === 'Enter' && e.target.classList.contains('cc-dd-input')) {
    e.preventDefault();
    const primera = opciones.find(o => !o.classList.contains('is-sel')) || opciones[0];
    if (primera) elegirOpcionDd(campo, primera.dataset.valor || '');
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!opciones.length) return;
    e.preventDefault();
    const i = opciones.indexOf(e.target);
    let sig;
    if (i < 0) sig = e.key === 'ArrowDown' ? opciones[0] : opciones[opciones.length - 1];
    else sig = opciones[(i + (e.key === 'ArrowDown' ? 1 : opciones.length - 1)) % opciones.length];
    sig.focus();
  }
}

// Pinta el botón de cada filtro (campo + lo elegido) y, si está abierto, su
// panel. La cuenta de cada opción se calcula con los demás criterios puestos:
// si ya filtraste por proveedor, en rubro se ven solo los rubros de ese
// proveedor. Los campos que nadie tiene cargado (sin marcas en toda la lista)
// no se muestran. Al final, "N de M" para saber cuánto quedó afuera.
function paintFiltros(visibles) {
  const s = _state;
  const host = document.getElementById('cc-filtros');
  if (!host) return;
  const crit = criteriosLista();
  for (const dd of host.querySelectorAll('.cc-dd[data-campo]')) {
    const campo = dd.dataset.campo;
    const def = CAMPOS_FILTRO.find(c => c.k === campo);
    if (!def) continue;
    const mostrar = campoTieneValores(s.rows, campo);
    dd.hidden = !mostrar;
    if (!mostrar) {
      if (_dd.abierto === campo) cerrarDropdown();
      if (s.filtros[campo]) s.filtros[campo] = '';
      continue;
    }
    const opts = opcionesCompras(s.rows, crit, campo);
    const elegido = s.filtros[campo] || '';
    const sel = elegido ? opts.find(o => o.valor === elegido) : null;
    if (elegido && !sel) s.filtros[campo] = '';
    dd.classList.toggle('is-on', !!sel);
    dd.querySelector('.cc-dd-value').textContent = sel ? sel.label : def.todos.split(' ')[0];
    dd.querySelector('.cc-dd-btn').title = sel ? `${def.label}: ${sel.label} (${sel.n})` : def.todos;
    if (_dd.abierto === campo) {
      const input = dd.querySelector('.cc-dd-input');
      pintarListaDd(dd, campo, opts, sel ? elegido : '', input ? input.value : '');
    }
  }
  const nFiltros = cantidadFiltros(s.filtros);
  const btn = host.querySelector('[data-action="filtros-clear"]');
  if (btn) btn.hidden = nFiltros === 0;
  const cnt = document.getElementById('cc-filtros-count');
  if (cnt) {
    const total = s.rows.length;
    const acotada = nFiltros > 0 || !!s.busqueda || s.filtroAnotados || !!s.temporadaFiltro;
    cnt.textContent = !total ? '' : (acotada ? `${visibles} de ${total}` : `${total} en la lista`);
    cnt.classList.toggle('is-on', acotada && visibles < total);
  }
}

// El scroll no salta cuando la lista se achica. Al filtrar, la tabla puede
// pasar de cientos de filas a tres: el documento se acorta, el navegador
// recorta la posición de scroll y la página entera pega un salto. Se mide
// dónde quedó la fila de filtros antes y después de repintar; si se movió,
// se reserva justo esa altura debajo de la tabla y se vuelve al mismo lugar.
// La reserva se recalcula en cada pintado, así nunca sobra más de lo que
// hace falta para el scroll actual.
function paintTable() {
  const fila = document.getElementById('cc-filtros');
  const wrap = fila?.parentElement?.querySelector('.table-wrap') || null;
  const antes = fila ? fila.getBoundingClientRect().top : 0;
  if (wrap) wrap.style.minHeight = '';
  pintarFilas();
  if (!fila || !wrap || !fila.isConnected) return;
  const delta = fila.getBoundingClientRect().top - antes;
  if (delta <= 1) return;
  wrap.style.minHeight = `${Math.ceil(wrap.getBoundingClientRect().height + delta)}px`;
  window.scrollBy(0, delta);
}

function pintarFilas() {
  const s = _state;
  const tbody = document.getElementById('cc-tbody');
  if (!tbody) return;
  ocultarTip();   // las filas se reemplazan: el tooltip quedaría colgado de una que ya no está
  if (!s.rows.length) {
    paintFiltros(0);
    tbody.innerHTML = `<tr><td colspan="10" class="cc-empty">
      <span class="material-icons">check_circle</span> No hay faltantes que reponer ahora mismo.</td></tr>`;
    return;
  }
  const disp = budgetActivo();
  // Filtro "en el cuaderno" (click en la píldora de arriba): la tabla muestra
  // solo lo anotado. Si no queda nada anotado, el filtro se apaga solo (la
  // píldora desaparece y no habría forma de sacarlo).
  if (s.filtroAnotados && !s.rows.some(r => r.anotado && !r.registrado)) s.filtroAnotados = false;
  // Selects (rubro, subrubro, proveedor, marca, nivel), lupa y cuaderno se
  // combinan en Y: cada uno achica lo que dejó el anterior.
  const crit = criteriosLista();
  const visible = r => coincideCompra(r, crit);
  // El plan (lo que entra en la plata + lo ya registrado) va arriba; después la
  // línea de corte y abajo SOLO lo que no entra (o no tiene costo). data-idx
  // siempre apunta al índice real en s.rows, así los handlers no dependen del
  // orden visual. Las variantes consecutivas del mismo producto se marcan como
  // "continuación" para que se vea que van juntas.
  //
  // Lo que ya está anotado en el cuaderno se va al fondo, en su propio bloque.
  // Pedido del dueño (21/09/2026): "los que ya fui marcando que vayan para
  // abajo y arriba los que no revisé todavía". Recorrer la lista es ir
  // decidiendo producto por producto, y lo ya decidido ocupando las primeras
  // filas obliga a saltearlo de nuevo en cada pasada.
  //
  // Sigue en la lista (no se esconde) porque la marca se saca desde ahí, y
  // sigue contando para el presupuesto: `fits` se calculó antes, sobre el orden
  // por urgencia, así que anotar algo no lo empuja fuera de la plata. Acá sólo
  // cambia dónde se lo dibuja.
  //
  // Con el filtro "en el cuaderno" puesto no se separa nada: ahí TODO lo que se
  // ve está anotado, y el bloque quedaría con la lista entera adentro.
  const arriba = [], abajo = [], enElCuaderno = [];
  const revisado = r => !!r.anotado && !r.registrado && !s.filtroAnotados;
  s.rows.forEach((r, i) => {
    if (!visible(r)) return;
    if (revisado(r)) enElCuaderno.push(i);
    else ((r.registrado || r.fits) ? arriba : abajo).push(i);
  });
  paintFiltros(arriba.length + abajo.length + enElCuaderno.length);
  if (!arriba.length && !abajo.length && !enElCuaderno.length) {
    const nFiltros = cantidadFiltros(s.filtros);
    const epoca = s.temporadaFiltro
      ? (s.proximas.find(p => p.id === s.temporadaFiltro)?.nombre || 'la fecha elegida') : '';
    const que = [
      s.busqueda ? `la búsqueda "${esc(s.busqueda)}"` : '',
      nFiltros ? (nFiltros === 1 ? 'el filtro puesto' : 'los filtros puestos') : '',
      s.filtroAnotados ? 'lo del cuaderno' : '',
      epoca ? `lo de ${esc(epoca)}` : '',
    ].filter(Boolean).join(' y ');
    tbody.innerHTML = `<tr><td colspan="10" class="cc-empty">
      <span class="material-icons">search_off</span> Nada en la lista coincide con ${que}.
      ${(nFiltros || s.busqueda) ? `<button type="button" class="cc-btn-ghost cc-empty-btn" data-action="filtros-clear-todo">Ver la lista completa</button>` : ''}
    </td></tr>`;
    return;
  }
  const parts = [];
  let prevDoc = null;
  const emit = (i) => {
    const r = s.rows[i];
    parts.push(rowHtml(r, i, r.esVariedad && String(r.doc_id) === prevDoc));
    prevDoc = String(r.doc_id);
  };
  arriba.forEach(emit);
  if (abajo.length) {
    // El corte separa lo que entra en la plata de lo que no. Sin nada arriba no
    // hay nada que separar y la línea quedaba pegada al encabezado, cortando el
    // vacío. Eso pasa por dos motivos distintos y el cartel tiene que decir
    // cuál es: o la plata no alcanza para nada de la lista, o alcanza pero lo
    // que entraba ya está anotado y se fue al fondo. Decir "no entra nada"
    // cuando entran veintisiete y están más abajo es peor que no decir nada.
    const anotadosQueEntran = enElCuaderno.filter(i => s.rows[i].fits).length;
    parts.push(arriba.length
      ? `<tr class="cc-cutoff"><td colspan="10">
          <span class="material-icons">content_cut</span>
          Acá se acaba la plata (${money(disp)}) · lo de abajo no entra en el presupuesto</td></tr>`
      : anotadosQueEntran
      ? `<tr class="cc-sinplata"><td colspan="10">
          <span class="material-icons">edit_note</span>
          Todo lo que entra en ${money(disp)} ya lo anotaste · está abajo, en el cuaderno</td></tr>`
      : `<tr class="cc-sinplata"><td colspan="10">
          <span class="material-icons">info</span>
          Con ${money(disp)} no entra nada de esta lista</td></tr>`);
    prevDoc = null;
    abajo.forEach(emit);
  }
  if (enElCuaderno.length) {
    // Cuántos de los anotados entran en la plata. Sin esto quedan dibujados
    // debajo del corte del presupuesto y parece que se quedaron afuera, cuando
    // el reparto los cuenta igual: son los que ya decidió comprar.
    const contados = enElCuaderno.filter(i => s.rows[i].fits).length;
    const nota = contados
      ? `${contados === enElCuaderno.length ? 'ya están' : `${contados} ya ${contados === 1 ? 'está' : 'están'}`} contados en el presupuesto`
      : 'queda abajo para no taparte lo que falta mirar';
    parts.push(`<tr class="cc-cutoff cc-cutoff-cuaderno"><td colspan="10">
      <span class="material-icons">edit_note</span>
      Esto ya lo anotaste en el cuaderno (${enElCuaderno.length}) · ${nota}</td></tr>`);
    prevDoc = null;
    enElCuaderno.forEach(emit);
  }
  tbody.innerHTML = parts.join('');
}

// ── Tooltip propio ────────────────────────────────────────────────────────────
// El `title` del navegador tarda casi un segundo en aparecer y sale como el
// cuadro negro del sistema, pegado al cursor y sin formato. Este sale al toque
// y con el estilo del panel. Va colgado del <body> porque la tabla scrollea:
// adentro lo recortaría el `overflow` del contenedor.
const _tip = { anchor: null };

function tipEl() {
  let t = document.getElementById('cc-tip');
  if (!t) {
    t = document.createElement('div');
    t.id = 'cc-tip';
    t.className = 'cc-tip';
    t.style.display = 'none';
    document.body.appendChild(t);
  }
  return t;
}

// Cada renglón del texto es una línea: la primera es el título, las que
// empiezan con "·" son los números de la cuenta y el resto queda como nota.
function tipHtml(texto) {
  const lineas = String(texto || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lineas.length) return '';
  const partes = [`<div class="cc-tip-head">${esc(lineas[0])}</div>`];
  for (const l of lineas.slice(1)) {
    const dato = l.startsWith('·');
    partes.push(`<div class="${dato ? 'cc-tip-dato' : 'cc-tip-nota'}">${esc(dato ? l.slice(1).trim() : l)}</div>`);
  }
  return partes.join('');
}

function mostrarTip(el) {
  const texto = el.dataset.tip || '';
  if (!texto) return;
  const t = tipEl();
  t.innerHTML = tipHtml(texto);
  t.style.display = 'block';
  _tip.anchor = el;
  // Centrado sobre lo que se está mirando, y abajo si arriba no entra.
  const r = el.getBoundingClientRect();
  const ancho = t.offsetWidth;
  const left = Math.max(8, Math.min(r.left + r.width / 2 - ancho / 2, window.innerWidth - ancho - 8));
  const arriba = r.top - t.offsetHeight - 8;
  t.style.left = `${Math.round(left)}px`;
  t.style.top = `${Math.round(arriba < 8 ? r.bottom + 8 : arriba)}px`;
  window.addEventListener('scroll', ocultarTip, true);
}

function ocultarTip() {
  if (!_tip.anchor) return;
  _tip.anchor = null;
  window.removeEventListener('scroll', ocultarTip, true);
  const t = document.getElementById('cc-tip');
  if (t) { t.style.display = 'none'; t.innerHTML = ''; }
}

function onMouseOver(e) {
  const el = e.target.closest ? e.target.closest('[data-tip]') : null;
  if (!el || el === _tip.anchor) return;
  mostrarTip(el);
}

function onMouseOut(e) {
  if (!_tip.anchor) return;
  const el = e.target.closest ? e.target.closest('[data-tip]') : null;
  if (el !== _tip.anchor) return;
  if (e.relatedTarget && el.contains(e.relatedTarget)) return;
  ocultarTip();
}

// Flecha de tendencia al lado del ritmo. Solo cuando la semana se despegó del
// mes Y hubo movimiento en más de un día: con una sola venta no hay tendencia
// que mostrar, hay una venta.
function tendenciaDe(r) {
  if (!(r.vel_dia_30 > 0) || Number(r.dias_con_mov_7) < 2) return '';
  const rel = r.vel_dia_7 / r.vel_dia_30;
  if (rel >= 1.4) {
    return `<span class="material-icons cc-tend cc-tend-up" title="Se está vendiendo más rápido que el promedio del mes">trending_up</span>`;
  }
  if (rel <= 0.6) {
    return `<span class="material-icons cc-tend cc-tend-down" title="Se está vendiendo más lento que el promedio del mes">trending_down</span>`;
  }
  return '';
}

function rowHtml(r, i, esContinuacion) {
  // Atenuada solo si quedó fuera del plan y el usuario tampoco la marcó a mano.
  const espera = !r.registrado && !r.sinCosto && !r.fits && !r.checked;
  const anotado = !r.registrado && !!r.anotado;
  // Lo que está por la fecha del año se pinta distinto: era el pedido del
  // dueño, poder ver de un vistazo que ese producto no figura porque se esté
  // acabando sino porque se viene el Día de la Madre.
  const porEpoca = !r.registrado && !!r.temporada;
  const cls = [
    r.registrado ? 'cc-row-reg' : '',
    anotado ? 'cc-row-anotado' : '',
    porEpoca ? 'cc-row-epoca' : '',
    espera ? 'cc-row-espera' : '',
    esContinuacion ? 'cc-row-varcont' : '',
  ].filter(Boolean).join(' ');

  // Un solo chip por fila. El nivel ya lo dice el orden de la lista y las
  // píldoras de arriba; "sin stock" ya se ve en la columna Stock (0 en rojo)
  // y en el texto de cobertura. Repetirlo en cada fila era puro ruido.
  // Dos grupos: lo que el producto ES (su nivel, su variante) va al lado del
  // nombre; lo que se puede HACER con él va en su propia línea. Todo junto, el
  // acomodo cambiaba en cada fila según el largo del nombre.
  let chipNivel = '';
  let chip = '';
  if (r.registrado) chipNivel = `<span class="cc-chip cc-chip-ok">registrado</span>`;
  else if (r.tier === 'sisi') chipNivel = `<span class="cc-chip cc-chip-sisi">sí o sí</span>`;

  // El chip de la fecha va SIEMPRE que la haya, aunque el producto ya estuviera
  // en la lista por otra cosa: son dos motivos distintos y los dos importan.
  if (porEpoca) {
    const t = r.temporada;
    const cuando = t.diasFaltan <= 0 ? 'hoy' : t.diasFaltan === 1 ? 'mañana' : `en ${t.diasFaltan} días`;
    chip += `<span class="cc-chip cc-chip-epoca${r.temporada_por_pista ? ' es-corazonada' : ''}${r.temporada_a_mano ? ' es-amano' : ''}"
      data-tip="${esc(explicarTemporada({
        temporada: t, empuje: r.temporada_empuje, esperado: r.temporada_esperado,
        stock: r.stockUnits, faltan: r.temporada_faltan, porPista: r.temporada_por_pista,
        porMano: r.temporada_por_mano,
      }) + (r.temporada_a_mano && !r.temporada_por_mano ? '\nLo agregaste vos a esta fecha.' : ''))}"><span class="material-icons">event</span>${esc(t.nombre)} · ${cuando}</span>`;
    // Sacarlo de la fecha, pegado al chip: es la acción de ESE chip y así se
    // entiende sin explicación. El dueño sabe cuándo el sistema se equivocó, y
    // la corrección queda para las próximas veces.
    chip += `<button type="button" class="cc-quitar-fecha" data-action="sacar-de-fecha"
      data-idx="${i}" aria-label="Sacar de ${esc(t.nombre)}"
      title="Sacar este producto de ${esc(t.nombre)}. Queda guardado para la próxima.">
      <span class="material-icons">close</span><span class="cc-quitar-txt">sacar</span></button>`;
  }

  // Marca "ya lo anoté en el cuaderno": chip con la fecha + botón para prender
  // o sacar la marca. No toca la selección ni el presupuesto: es solo para no
  // volver a anotar lo mismo cada vez que se repasa la lista.
  const fAnot = anotado ? `${r.anotado.slice(8, 10)}/${r.anotado.slice(5, 7)}` : '';
  if (anotado) chip += `<span class="cc-chip cc-chip-anotado" title="Lo anotaste en el cuaderno el ${fAnot}. Sigue en la lista hasta que lo compres o le saques la marca.">en el cuaderno ${fAnot}</span>`;
  const btnAnotar = r.registrado ? '' :
    `<button type="button" class="cc-anotar${anotado ? ' is-on' : ''}" data-action="anotar" data-idx="${i}"
       title="${anotado ? 'Sacar la marca del cuaderno' : 'Marcar que ya lo anotaste en el cuaderno'}">
       <span class="material-icons">edit_note</span></button>`;
  const chipAcciones = chip + btnAnotar;

  const checkbox = r.sinCosto || r.registrado
    ? `<span class="material-icons cc-check-off" title="${r.sinCosto ? 'Sin costo cargado' : 'Ya registrado'}">${r.sinCosto ? 'block' : 'check_circle'}</span>`
    : `<input type="checkbox" class="cc-check" data-idx="${i}"${r.checked ? ' checked' : ''} />`;

  // Ritmo: el número con el que se decide (mes corregido por estos días) y, en
  // el tooltip, las dos ventanas por separado. La flecha aparece solo cuando la
  // semana se despegó del mes lo suficiente como para cambiar la decisión.
  const ritmoTxt = r.vel_semana >= 1
    ? `~${fmt(Math.round(r.vel_semana), 0)}/sem`
    : (r.vel_semana > 0 ? '<1/sem' : '—');
  const ritmoTitle = r.vel_dia > 0
    ? [
        `Ritmo con el que se decide: ~${fmt(r.vel_semana, 1)} por semana`,
        `Últimos 30 días: ${fmt(r.unidades_ventana, 0)} unidades`,
        `Últimos ${VENTANA_CORTA_DIAS} días: ${fmt(r.unidades_7, 0)} unidades en ${fmt(r.dias_con_mov_7, 0)} día(s) distintos`,
        r.dias_con_mov_7 <= 1 && r.unidades_7 > 0
          ? 'Una sola venta en la semana no cuenta como ritmo: manda el promedio del mes.'
          : '',
      ].filter(Boolean).join('\n')
    : 'Sin ventas registradas en el último mes';
  const tendencia = tendenciaDe(r);
  const ritmo = `<span class="cc-tip-ancla" data-tip="${esc(ritmoTitle)}">${ritmoTxt}${tendencia}</span>`;

  const esPack = r.esVariedad && r.packSize > 0;
  const costo = r.sinCosto
    ? `<input type="text" inputmode="numeric" class="cc-cost" data-idx="${i}" placeholder="${esPack ? 'costo pack' : 'costo'}"
         title="Cargá el costo ${esPack ? `del pack (${r.packSize} u)` : 'unitario'} acá — se guarda también en el Catálogo" />`
    : `<span title="${esPack ? `Costo por pack de ${r.packSize} u` : 'Costo unitario'}">${money(r.cost, 0)}</span>`;
  const qtyTitle = esPack
    ? `Packs/rollos de ${r.packSize} unidades`
    : (r.packSize > 1 ? `Se redondea a packs de ${r.packSize} unidades` : 'Unidades a comprar');
  const subtotal = r.sinCosto ? '—' : money(r.subtotal, 0);
  const acumulado = r.fits ? money(r.acumulado, 0) : '—';   // solo tiene sentido dentro del plan

  // Cobertura, por qué está donde está y plata en riesgo, en UNA línea apagada:
  // con una fila por producto se lee igual, y la página deja de ser una pared
  // de texto rojo repetido.
  const detalles = [];
  if (r.cobertura_texto) detalles.push(esc(r.cobertura_texto));
  for (const m of motivosUrgencia(r)) detalles.push(esc(m));
  if (porEpoca) {
    // Sin repetir la fecha ni los días: eso ya está en el chip de arriba.
    detalles.push(esc(motivoTemporada({
      temporada: r.temporada, empuje: r.temporada_empuje, porPista: r.temporada_por_pista,
      porMano: r.temporada_por_mano,
    }, { conFecha: false })));
    if (!r.temporada_por_pista && r.temporada_faltan > 0) {
      detalles.push(`faltan ~${fmt(Math.ceil(r.temporada_faltan), 0)} para llegar igual que la vez pasada`);
    }
  }
  if (!r.registrado && r.tier !== 'opcional' && r.perdidaSemana > 0) {
    detalles.push(`dejás de vender ~${money(r.perdidaSemana)}/sem si falta`);
  }

  const stk = stockRealDe(r);
  const stockTitle = [stk.title, 'Stock real leído del Catálogo'].filter(Boolean).join('\n');

  // Variantes: nombre BASE del producto + chip violeta con la variante, así se
  // ve de qué producto es. Consecutivas del mismo producto van con ↳ enganchado.
  const nombreBase = r.esVariedad && r.producto?.nombre ? r.producto.nombre : r.nombre;
  const varChip = r.esVariedad
    ? `<span class="cc-chip cc-chip-varnt" title="Variante de ${esc(nombreBase)}"><span class="material-icons">palette</span>${esc(r.variedad || '(sin nombre)')}</span>`
    : '';

  return `<tr class="${cls}" data-idx="${i}">
    <td style="text-align:center">${checkbox}</td>
    <td style="text-align:center">
      <span class="cc-urg cc-urg-${r.tier}" data-tip="${esc(explicarUrgencia(r))}">${fmt(Math.round(r.urgencia), 0)}</span>
    </td>
    <td>
      <div class="cc-prod">
        ${esContinuacion ? '<span class="material-icons cc-var-arrow" title="Otra variante del producto de arriba">subdirectory_arrow_right</span>' : ''}
        <button type="button" class="cc-prod-btn" data-action="ver-catalogo" data-doc="${esc(String(r.doc_id))}"
                title="Abrir este producto en el Catálogo">${esc(nombreBase)}<span class="material-icons">open_in_new</span></button>
        ${varChip}${chipNivel}
      </div>
      ${chipAcciones ? `<div class="cc-prod-acc">${chipAcciones}</div>` : ''}
      ${detalles.length ? `<div class="cc-cob">${detalles.join(' · ')}</div>` : ''}
    </td>
    <td>
      <span class="badge badge-gray"${r.marca ? ` title="Marca: ${esc(r.marca)}"` : ''}>${esc(r.rubro || 'Sin rubro')}</span>
      ${(r.sub_rubro || r.proveedor) ? `<div class="cc-rubro-sub">${[r.sub_rubro, r.proveedor].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
    </td>
    <td class="cc-stock${stk.total <= 0 ? ' is-cero' : ''}" data-tip="${esc(stockTitle)}">${esc(stk.texto)}</td>
    <td style="text-align:right">${ritmo}</td>
    <td style="text-align:center">
      <input type="text" inputmode="numeric" class="cc-qty" data-idx="${i}" value="${r.qty}" title="${qtyTitle}"${r.registrado ? ' disabled' : ''} />
    </td>
    <td style="text-align:right">${costo}</td>
    <td style="text-align:right">${subtotal}</td>
    <td style="text-align:right;color:var(--text-muted)">${acumulado}</td>
  </tr>`;
}

// ── Pintado: resumen del plan ─────────────────────────────────────────────────
function paintPlan() {
  const el = document.getElementById('cc-plan');
  if (!el) return;
  const { items, total } = planSeleccionado();
  const disp = budgetActivo();
  const restante = disp - total;
  const pasado = restante < 0;
  el.innerHTML = `
    <div class="cc-plan-line"><span>Seleccionados</span><b>${items.length}</b></div>
    <div class="cc-plan-line"><span>Total plan</span><b>${money(total)}</b></div>
    <div class="cc-plan-line ${pasado ? 'cc-plan-over' : 'cc-plan-ok'}">
      <span>${pasado ? 'Te pasás por' : 'Te queda'}</span><b>${money(Math.abs(restante))}</b>
    </div>`;
}

// ── Ajustes de rentabilidad ───────────────────────────────────────────────────
function paintAjustes() {
  const el = document.getElementById('cc-ajustes');
  if (!el) return;
  if (!_state.ajustesOpen) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const c = _state.comprasCfg;
  el.style.display = 'block';
  el.innerHTML = `
    <div class="cc-ajustes-grid">
      <div class="cc-reg-field">
        <label>Rentabilidad a separar (monto fijo)</label>
        <input id="cc-aj-monto" type="text" inputmode="numeric" value="${c.rentabilidad_monto != null ? fmt(c.rentabilidad_monto, 0) : ''}" placeholder="ej 250.000" />
      </div>
      <div class="cc-reg-field">
        <label>Piso % de las ventas</label>
        <input id="cc-aj-piso" type="text" inputmode="numeric" value="${c.rentabilidad_piso_pct != null ? c.rentabilidad_piso_pct : ''}" placeholder="ej 20" />
      </div>
      <div class="cc-reg-field">
        <label>Cobertura objetivo (días)</label>
        <input id="cc-aj-cob" type="text" inputmode="numeric" value="${c.cobertura_dias_objetivo != null ? c.cobertura_dias_objetivo : COBERTURA_DEFAULT}" placeholder="${COBERTURA_DEFAULT}" />
      </div>
    </div>
    <div class="cc-ajustes-actions">
      <button class="cc-btn-ghost" data-action="ajustes-cancel">Cancelar</button>
      <button class="cc-btn-primary" data-action="ajustes-save">
        <span class="material-icons">save</span> Guardar
      </button>
    </div>
    <div class="cc-ajustes-hint">La rentabilidad efectiva es la mayor entre el monto fijo y el piso % de los ingresos del mes.</div>
    <div class="cc-ajustes-hint">La cobertura objetivo es hasta dónde mirás para adelante: con ${COBERTURA_DEFAULT} días, lo que tenga stock para más que eso no urge todavía. Subila para comprar con más anticipación (lo que más se vende sube en la lista y las cantidades sugeridas crecen); bajala para viajes más chicos y más seguidos.</div>`;
}

// ── Resumen por nivel ─────────────────────────────────────────────────────────
// Píldoras con cuánta plata pide cada nivel (a las cantidades actuales) y el
// aviso de productos sin costo cargado, que no se pueden presupuestar.
function paintResumen() {
  const el = document.getElementById('cc-tiers');
  if (!el) return;
  const act = _state.rows.filter(r => !r.registrado);
  const totalDe = tier => {
    const list = act.filter(r => r.tier === tier && !r.sinCosto);
    return { n: list.length, total: list.reduce((t, r) => t + r.qty * r.cost, 0) };
  };
  const sisi = totalDe('sisi');
  const imp = totalDe('importante');
  const opc = totalDe('opcional');
  const sinCosto = act.filter(r => r.sinCosto);
  const sinCostoImp = sinCosto.filter(r => r.tier !== 'opcional').length;

  const pill = (cls, label, g) => g.n === 0 ? '' :
    `<div class="cc-tier-pill ${cls}">${label} <span>${g.n} · ${money(g.total)}</span></div>`;
  const warnCosto = sinCosto.length === 0 ? '' :
    `<div class="cc-tier-pill cc-tier-nocost" title="Cargales el costo en la columna Costo de la tabla — se guarda en el Catálogo">
       ${sinCosto.length} sin costo${sinCostoImp ? ` (${sinCostoImp} importante${sinCostoImp === 1 ? '' : 's'})` : ''}</div>`;
  const anotados = act.filter(r => r.anotado).length;
  if (anotados === 0) _state.filtroAnotados = false;
  const filtroOn = _state.filtroAnotados;
  const pillAnotados = anotados === 0 ? '' :
    `<button type="button" class="cc-tier-pill cc-tier-anotado${filtroOn ? ' is-on' : ''}" data-action="filtro-anotados"
       title="${filtroOn ? 'Mostrando solo lo del cuaderno. Click para ver la lista completa.' : 'Click para ver solo lo que ya está en el cuaderno'}">
       En el cuaderno <span>${anotados}</span>
       <span class="material-icons">${filtroOn ? 'filter_alt_off' : 'filter_alt'}</span></button>`;
  // Con el filtro del cuaderno puesto aparece la impresión: la hoja para llevar
  // al mayorista y anotar a mano cuánto se compró y se pagó de cada cosa.
  const btnImprimir = (anotados === 0 || !filtroOn) ? '' :
    `<button type="button" class="cc-tier-pill cc-tier-print" data-action="imprimir-cuaderno"
       title="La lista del cuaderno en una hoja para imprimir o guardar como PDF, con columnas para anotar a mano lo comprado y lo pagado">
       <span class="material-icons">print</span> Imprimir lista</button>`;

  // Lo que está por la fecha del año, en su propia píldora: es plata aparte, de
  // otra decisión. Click para ver sólo eso.
  const epoca = act.filter(r => r.temporada);
  const totalEpoca = epoca.filter(r => !r.sinCosto).reduce((t, r) => t + r.qty * r.cost, 0);
  const epocaOn = !!_state.temporadaFiltro;
  const pillEpoca = epoca.length === 0 ? '' :
    `<button type="button" class="cc-tier-pill cc-tier-epoca${epocaOn ? ' is-on' : ''}" data-action="filtro-epoca"
       data-id="${esc(epocaOn ? _state.temporadaFiltro : (epoca[0].temporada?.id || ''))}"
       title="${epocaOn ? 'Mostrando solo lo de esa fecha. Click para ver la lista completa.' : 'Productos que están acá por la fecha del año que se viene'}">
       <span class="material-icons">event</span> Por la época <span>${epoca.length} · ${money(totalEpoca)}</span></button>`;

  el.innerHTML = pill('cc-tier-sisi', 'Sí o sí', sisi)
    + pill('cc-tier-imp', 'Importante', imp)
    + pill('cc-tier-opc', 'Puede esperar', opc)
    + pillEpoca
    + pillAnotados
    + btnImprimir
    + warnCosto;
}

// ── Imprimir la lista del cuaderno ────────────────────────────────────────────
// La hoja A4 para llevar al mayorista: lo anotado agrupado por rubro, con las
// cantidades y costos del plan, y columnas en blanco para tildar y anotar a
// mano cuánto se compró y cuánto se pagó. El armado del HTML es lógica pura
// (lista_cuaderno.js); acá solo se juntan los renglones y se abre la ventana.
function imprimirCuaderno() {
  const items = _state.rows
    .filter(r => r.anotado && !r.registrado)
    .map(r => {
      const stk = stockRealDe(r);
      return {
        nombre: r.esVariedad && r.producto?.nombre ? r.producto.nombre : r.nombre,
        variedad: r.variedad,
        esVariedad: !!r.esVariedad,
        rubro: r.rubro,
        tier: r.tier,
        qty: r.qty,
        cost: r.cost,
        sinCosto: !!r.sinCosto,
        packSize: r.packSize,
        stockTexto: stk.texto,
        ritmo: r.vel_semana >= 1 ? `~${fmt(Math.round(r.vel_semana), 0)}/sem` : '',
      };
    });
  if (!items.length) return;
  const html = listaCuadernoHtml({ items, fecha: hoyAR() });
  const w = window.open('', '_blank');
  if (!w) {
    alertDialog({ title: 'Popups bloqueados', message: 'No se pudo abrir la hoja de impresión. Habilitá los popups para este sitio.', type: 'warning' });
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

// ── Pintado: lo que se viene por almanaque ────────────────────────────────────
// La franja de arriba del todo: qué fecha se aproxima, cuántos días faltan y
// cuántos productos de la lista son por eso. Aparece a dos meses (lo que pidió
// el dueño) porque el mayorista no viene todas las semanas.
function paintTemporadas() {
  const el = document.getElementById('cc-epocas');
  if (!el) return;
  const s = _state;
  // Con el panel de fechas abierto, la franja diría lo mismo dos veces.
  if (s.fechasOpen) { el.innerHTML = ''; return; }
  const proximas = s.proximas || [];

  // Nunca se estudiaron las ventas: no hay nada que mostrar todavía, pero sí
  // algo para ofrecer.
  if (!proximas.length) {
    el.innerHTML = s.estudio ? '' : botonEstudiarHtml('Todavía no miré tus ventas viejas para saber qué se vende en cada fecha del año.');
    return;
  }

  const partes = [];
  for (const p of proximas.slice(0, 3)) {
    const n = s.rows.filter(r => r.temporada?.id === p.id && !r.registrado).length;
    const cuando = p.diasFaltan <= 0 ? 'es hoy'
      : p.diasFaltan === 1 ? 'es mañana'
      : `faltan ${p.diasFaltan} días`;
    const activo = s.temporadaFiltro === p.id;
    const ideas = ideasQueFaltan(p.id, peekCacheValue('catalogo:all') || []);
    partes.push(`
      <div class="cc-epoca${activo ? ' is-on' : ''}${p.enVenta ? ' cc-epoca-ya' : ''}">
        <div class="cc-epoca-head">
          ${taquitoHtml(p.fecha)}
          <button type="button" class="cc-epoca-tit" data-action="abrir-fecha" data-id="${esc(p.id)}"
                  title="Abrir ${esc(p.nombre)} y ver qué conviene comprar">
            <b>${esc(p.nombre)}</b>
            <span class="cc-epoca-cuando">${esc(fechaLinda(p.fecha))} · ${cuando}</span>
          </button>
          ${n > 0 ? `<button type="button" class="cc-epoca-filtro${activo ? ' is-on' : ''}" data-action="filtro-epoca" data-id="${esc(p.id)}"
             title="${activo ? 'Ver la lista completa' : 'Ver solo lo de esta fecha'}">
             <span class="material-icons">${activo ? 'filter_alt_off' : 'filter_alt'}</span> ${n} en la lista</button>`
            : '<span class="cc-epoca-vacio">nada que reponer para esta fecha</span>'}
        </div>
        ${p.nota ? `<div class="cc-epoca-nota">${esc(p.nota)}</div>` : ''}
        ${(!p.medida && n > 0) ? `<div class="cc-epoca-nota cc-epoca-corazonada">
            <span class="material-icons">lightbulb</span>
            Todavía no tengo ventas tuyas de esta fecha para medirla: lo que ves es por el tipo de producto, no por lo que vendiste.
          </div>` : ''}
        ${ideas.length ? `<div class="cc-epoca-ideas">
            <span class="material-icons">shopping_bag</span>
            <span>Para esta fecha se suele vender, y no lo encontré en tu catálogo:
              <b>${ideas.slice(0, 6).map(esc).join(' · ')}</b></span>
          </div>` : ''}
      </div>`);
  }

  const viejo = s.estudio && !s.estudioVigente
    ? botonEstudiarHtml(`Lo que sé de las fechas es de hace un tiempo (última vez, hasta el ${fechaLinda(s.estudio.hasta || '')}).`)
    : (!s.estudio ? botonEstudiarHtml('Todavía no miré tus ventas viejas para saber qué se vende en cada fecha.') : '');

  el.innerHTML = `<div class="cc-epocas-wrap">${partes.join('')}</div>${viejo}`;
}

// ── Panel "Próximas fechas" ───────────────────────────────────────────────────
// Todas las fechas del año que mueven venta, como botones. Pedido del dueño
// (21/09): además del aviso automático a dos meses, quiso poder abrir cualquier
// fecha —aunque falte medio año— y ver qué convendría comprar y cuánto falta.
//
// El color dice de un vistazo en qué está cada una:
//   · naranja → ya se está vendiendo, la fecha es inminente;
//   · azul    → entra en los dos meses de aviso: es hora de encargar;
//   · gris    → todavía falta; se puede abrir igual, para ir mirando.
// Y el contorno punteado, que de esa fecha todavía no hay ventas para medirla.
function paintFechas() {
  const el = document.getElementById('cc-fechas');
  if (!el) return;
  const s = _state;
  if (!s.fechasOpen) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'block';

  const todas = fechasDelAnio(hoyAR());
  const porFecha = new Map();
  for (const r of s.rows) {
    if (r.registrado || !r.temporada) continue;
    const e = porFecha.get(r.temporada.id) || { n: 0, plata: 0 };
    e.n++;
    if (!r.sinCosto) e.plata += r.qty * r.cost;
    porFecha.set(r.temporada.id, e);
  }

  // Agrupadas por mes, con el mes escrito: es lo que el dueño mira para armar
  // el viaje al mayorista — no compra "para el Día de la Madre", compra "lo de
  // octubre".
  const botonHtml = (t) => {
    const est = estadoDeFecha(s.estudio, t);
    const datos = porFecha.get(t.id);
    const abierta = s.fechasAbiertas.includes(t.id);
    const elegida = s.temporadaFiltro === t.id;
    const cerca = t.diasFaltan <= t.plazoAviso;
    const clase = [
      'cc-fecha',
      t.enVenta ? 'is-ya' : (cerca ? 'is-cerca' : 'is-lejos'),
      est.medida ? '' : 'is-corazonada',
      elegida ? 'is-on' : '',
    ].filter(Boolean).join(' ');
    const cuando = t.diasFaltan <= 0 ? 'es hoy'
      : t.diasFaltan === 1 ? 'es mañana'
      : `faltan ${t.diasFaltan} días`;
    const pie = datos
      ? `${datos.n} para comprar${datos.plata > 0 ? ` · ${money(datos.plata)}` : ''}`
      : (abierta || cerca ? 'nada para reponer' : 'tocá para ver');
    return `<button type="button" class="${clase}" data-action="abrir-fecha" data-id="${esc(t.id)}"
        title="${esc(est.medida
          ? `Medido con tus ventas${est.veces > 1 ? ` (${est.veces} pasadas)` : ''}${est.colores?.length ? ` · colores que vuelan: ${est.colores.join(', ')}` : ''}`
          : 'Todavía no hay ventas tuyas de esta fecha: lo que salga es por el tipo de producto')}">
      ${taquitoHtml(t.fecha)}
      <span class="cc-fecha-txt">
        <span class="cc-fecha-nom">${esc(t.nombre)}</span>
        <span class="cc-fecha-cuando">${cuando}</span>
        <span class="cc-fecha-pie">${esc(pie)}</span>
      </span>
    </button>`;
  };

  const porMes = [];
  for (const t of todas) {
    const mes = mesDe(t.fecha);
    const ultimo = porMes[porMes.length - 1];
    if (ultimo && ultimo.mes === mes) ultimo.items.push(t);
    else porMes.push({ mes, anio: t.fecha.slice(0, 4), items: [t] });
  }
  const anioHoy = hoyAR().slice(0, 4);
  const botones = porMes.map(g => `
    <div class="cc-mes">
      <div class="cc-mes-tit">${esc(g.mes)}${g.anio !== anioHoy ? ` <span>${esc(g.anio)}</span>` : ''}</div>
      <div class="cc-mes-grid">${g.items.map(botonHtml).join('')}</div>
    </div>`).join('');

  const elegida = s.temporadaFiltro
    ? todas.find(t => t.id === s.temporadaFiltro) : null;

  el.innerHTML = `
    <div class="cc-fechas-head">
      <span class="material-icons">event</span>
      <b>Las fechas que mueven venta</b>
      <span class="cc-fechas-hint">Tocá una para ver qué convendría comprar. El aviso solo sale a dos meses; acá podés mirar cualquiera.</span>
      <button type="button" class="cc-icon-btn" data-action="fechas" title="Cerrar">
        <span class="material-icons">close</span>
      </button>
    </div>
    ${elegida ? detalleFechaHtml(elegida, porFecha.get(elegida.id)) : ''}
    <div class="cc-fechas-meses">${botones}</div>
    <div class="cc-fechas-leyenda">
      <span><i class="cc-pt is-ya"></i> ya se está vendiendo</span>
      <span><i class="cc-pt is-cerca"></i> hay que encargarlo</span>
      <span><i class="cc-pt is-lejos"></i> todavía falta</span>
      <span><i class="cc-pt is-corazonada"></i> sin ventas para medirla</span>
    </div>`;
}

// El renglón de abajo cuando hay una fecha abierta: qué es, qué se vende y qué
// se suele vender que el catálogo no tiene.
function detalleFechaHtml(t, datos) {
  const s = _state;
  const est = estadoDeFecha(s.estudio, t);
  const ideas = ideasQueFaltan(t.id, peekCacheValue('catalogo:all') || []);
  const partes = [];
  if (est.medida) {
    partes.push(`<div class="cc-fecha-det-linea"><span class="material-icons">insights</span>
      Sale de tus ventas${est.veces > 1 ? ` (medida ${est.veces} veces)` : ''}${
        est.colores?.length ? `. Lo que vuela: <b>${est.colores.map(esc).join(' · ')}</b>` : ''}</div>`);
  } else {
    partes.push(`<div class="cc-fecha-det-linea"><span class="material-icons">lightbulb</span>
      Todavía no tengo ventas tuyas de esta fecha: lo que aparece es por el tipo de producto, no por lo que vendiste.</div>`);
  }
  if (t.nota) partes.push(`<div class="cc-fecha-det-linea"><span class="material-icons">info</span>${esc(t.nota)}</div>`);
  if (ideas.length) {
    partes.push(`<div class="cc-fecha-det-linea"><span class="material-icons">shopping_bag</span>
      Se suele vender y no lo encontré en tu catálogo: <b>${ideas.slice(0, 8).map(esc).join(' · ')}</b></div>`);
  }
  const n = datos?.n || 0;
  const aj = ajustesDeFecha(s.ajustes, t.id);
  const nSuma = Object.keys(aj.suma).length;
  const nSaca = Object.keys(aj.saca).length;
  const sacados = Object.entries(aj.saca).map(([clave]) => clave);
  return `<div class="cc-fecha-det">
    <div class="cc-fecha-det-head">
      <b>${esc(t.nombre)}</b>
      <span>${esc(fechaLinda(t.fecha))} · ${t.diasFaltan <= 0 ? 'es hoy' : `faltan ${t.diasFaltan} días`}</span>
      ${n > 0
        ? `<span class="cc-fecha-det-n">${n} producto${n === 1 ? '' : 's'} en la lista${datos.plata > 0 ? ` · ${money(datos.plata)}` : ''}</span>`
        : '<span class="cc-fecha-det-n">no encontré nada que reponer para esta fecha</span>'}
      <button type="button" class="cc-btn-ghost" data-action="abrir-fecha" data-id="${esc(t.id)}">
        <span class="material-icons">filter_alt_off</span> Ver la lista completa
      </button>
    </div>
    ${partes.join('')}
    ${(nSuma || nSaca) ? `<div class="cc-fecha-det-linea">
      <span class="material-icons">edit</span>
      <span>Lo corregiste vos: ${nSuma ? `<b>${nSuma}</b> agregado${nSuma === 1 ? '' : 's'}` : ''}${(nSuma && nSaca) ? ' · ' : ''}${nSaca ? `<b>${nSaca}</b> sacado${nSaca === 1 ? '' : 's'}` : ''}.
      ${nSaca ? `<button type="button" class="cc-linkcito" data-action="ver-sacados" data-id="${esc(t.id)}">ver lo sacado</button>` : ''}</span>
    </div>` : ''}
    ${s.verSacados === t.id && sacados.length ? `<div class="cc-sacados">
      ${sacados.map(clave => `<span class="cc-sacado">${esc(nombreDeClave(clave))}
        <button type="button" data-action="devolver-a-fecha" data-id="${esc(t.id)}" data-clave="${esc(clave)}"
                title="Devolverlo a esta fecha">Devolver</button></span>`).join('')}
    </div>` : ''}
    ${agregarAFechaHtml(t)}
  </div>`;
}

// La clave es "nombre||color": para mostrarla alcanza con darla vuelta.
function nombreDeClave(clave) {
  const [nombre, color] = String(clave || '').split('||');
  return color ? `${nombre} · ${color}` : nombre;
}

// Buscador para sumar un producto a esta fecha. Busca en el catálogo entero,
// no sólo en la lista de compras: lo que hay que agregar es justamente lo que
// el sistema no trajo.
function agregarAFechaHtml(t) {
  const s = _state;
  const texto = s.buscarFecha.trim();
  const productos = peekCacheValue('catalogo:all') || [];
  const aj = ajustesDeFecha(s.ajustes, t.id);
  // Lo que ya está en la lista de esa fecha: no tiene sentido ofrecerlo.
  const enLaFecha = new Set(s.rows
    .filter(r => r.temporada?.id === t.id)
    .map(r => claveProducto(r.producto?.nombre || r.nombre, '')));

  const opcion = (p) => {
    const clave = claveProducto(p.nombre, '');
    return {
      nombre: p.nombre, clave, rubro: p.rubro || '',
      ya: !!aj.suma[clave] || enLaFecha.has(clave),
    };
  };

  let resultados = [];
  let sugeridas = false;
  if (texto.length >= 2) {
    const toks = normClave(texto).split(' ').filter(Boolean);
    for (const p of productos) {
      const hay = normClave([p.nombre, p.codigo, p.rubro, p.sub_rubro].filter(Boolean).join(' '));
      if (!toks.every(x => hay.includes(x))) continue;
      resultados.push(opcion(p));
      if (resultados.length >= 10) break;
    }
  } else {
    // Sin escribir nada ya hay algo para tocar. Se ofrece lo que se parece a lo
    // que la fecha ya mueve, del más vendido para abajo.
    //
    // Por SUBRUBRO, no por rubro: los rubros del local son LIBRERÍA (3.592
    // fichas) y MERCERÍA (1.866), así que sugerir "del mismo rubro" para el Día
    // de la Madre devolvía palitos de helado y folios. El subrubro —
    // PORTARETRATOS, BOLSA ORGANZA, TAZA— sí dice algo. El rubro sólo entra
    // cuando la fecha lo declara en sus pistas, y esos son los chicos y
    // específicos: REGALERÍA, JUGUETERÍA, COTILLON, NAVIDAD.
    sugeridas = true;
    const subrubros = new Set();
    for (const r of s.rows) {
      if (r.temporada?.id === t.id && r.sub_rubro) subrubros.add(normClave(r.sub_rubro));
    }
    const rubros = new Set((temporadaPorId(t.id)?.pistas?.rubros || []).map(normClave));
    const ventanas = obtenerVentanasVenta();
    // El rubro que la fecha declara manda sobre el subrubro heredado: para el
    // Día de la Madre, REGALERÍA antes que el papel que entró por PAPELERÍA.
    const delRubro = [], delSubrubro = [];
    const temp = temporadaPorId(t.id);
    for (const p of productos) {
      if (!p?.nombre) continue;
      // Lo que la fecha veta no se ofrece: un mouse no deja de ser un mouse
      // porque lo esté sugiriendo otra pantalla.
      if (estaExcluido(temp, { nombre: p.nombre, subRubro: p.sub_rubro || '' })) continue;
      const esRubro = rubros.has(normClave(p.rubro));
      const esSub = !esRubro && p.sub_rubro && subrubros.has(normClave(p.sub_rubro));
      if (!esRubro && !esSub) continue;
      const clave = claveProducto(p.nombre, '');
      if (enLaFecha.has(clave) || aj.suma[clave] || aj.saca[clave]) continue;
      const r = ritmoDe(ventanas, { nombre: normClave(p.nombre), color: '', docId: String(p.doc_id ?? '') });
      // Del rubro propio de la fecha entra aunque no haya vendido este mes: la
      // regalería rota despacio y el dueño igual la quiere a la vista. Del
      // subrubro heredado, sólo lo que se está vendiendo.
      if (esRubro) delRubro.push({ p, uds: r.unidades });
      else if (r.unidades > 0) delSubrubro.push({ p, uds: r.unidades });
    }
    const porVenta = (a, b) => b.uds - a.uds;
    delRubro.sort(porVenta);
    delSubrubro.sort(porVenta);
    resultados = [...delRubro, ...delSubrubro].slice(0, 6).map(x => opcion(x.p));
  }

  const lista = resultados.length ? `<div class="cc-agregar-res">
      ${resultados.map(r => `<button type="button" class="cc-agregar-opt" data-action="sumar-a-fecha"
          data-id="${esc(t.id)}" data-clave="${esc(r.clave)}" data-nombre="${esc(r.nombre)}"${r.ya ? ' disabled' : ''}>
          <span class="material-icons">${r.ya ? 'check' : 'add'}</span>
          <span class="cc-agregar-nom">${esc(r.nombre)}</span>
          <span class="cc-agregar-rub">${esc(r.rubro)}</span>
        </button>`).join('')}
    </div>`
    : (texto.length >= 2
        ? `<div class="cc-agregar-vacio">Nada del catálogo coincide con "${esc(texto)}"</div>`
        : '');

  return `<div class="cc-agregar">
    <div class="cc-agregar-tope">
      <span class="et-agregar">Sumale productos a esta fecha</span>
      ${sugeridas && resultados.length ? '<span class="cc-agregar-hint">lo que más se vende de los rubros de esta fecha</span>' : ''}
    </div>
    <div class="cc-agregar-campo">
      <span class="material-icons">search</span>
      <input id="cc-buscar-fecha" type="text" autocomplete="off" value="${esc(s.buscarFecha)}"
             placeholder="Buscar en el catálogo…" aria-label="Buscar producto para agregar a ${esc(t.nombre)}" />
      ${s.buscarFecha ? `<button type="button" class="cc-buscar-x" data-action="buscar-fecha-clear"
          aria-label="Limpiar"><span class="material-icons">close</span></button>` : ''}
    </div>
    ${lista}
  </div>`;
}

// Abre (o cierra) una fecha: calcula sus recomendaciones aunque todavía falte
// mucho, y deja la lista filtrada a eso.
function abrirFecha(id) {
  const s = _state;
  if (!id) return;
  if (s.temporadaFiltro === id) {      // ya estaba abierta: se cierra
    s.temporadaFiltro = '';
    paintFechas();
    paintTemporadas();
    paintTable();
    paintResumen();
    return;
  }
  // Abrir una fecha muestra lo que recomienda para ella, venga el click del
  // panel o del nombre en la franja de arriba: si el panel está cerrado, se
  // abre. Sin esto, tocar el nombre filtraba la lista y no se veía por qué.
  s.fechasOpen = true;
  s.temporadaFiltro = id;
  // Una fecha lejana no se calcula sola: recién cuando se la pide.
  if (!s.fechasAbiertas.includes(id) && !s.proximas.some(p => p.id === id)) {
    s.fechasAbiertas = [...s.fechasAbiertas, id];
    mezclarTemporadas();
    recalc(false);
  }
  paintFechas();
  paintTemporadas();
  paintTable();
  paintResumen();
  bajarALaLista();
}

// Al abrir una fecha, llevar la vista a la lista: el dueño toca el nombre para
// VER los productos, y si la tabla queda tres pantallas más abajo no los ve.
function bajarALaLista() {
  // Dos frames después de pintar, no antes: `paintTable` corrige el scroll por
  // su cuenta cuando la lista se achica (`window.scrollBy`), y si se scrollea
  // primero, esa corrección pisa el movimiento y la página no se mueve.
  const ir = () => {
    try {
      // A la tabla: el dueño toca la fecha para VER los productos.
      document.querySelector('.cc-table-card')
        ?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    } catch (_) { /* sin scroll no pasa nada grave */ }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(ir));
  } else {
    setTimeout(ir, 0);
  }
}

function botonEstudiarHtml(texto) {
  const estudiando = _state.estudiando;
  return `<div class="cc-epoca-estudio">
    <span class="material-icons">auto_graph</span>
    <span>${esc(texto)}</span>
    <button type="button" class="cc-btn-ghost" data-action="estudiar-epocas"${estudiando ? ' disabled' : ''}>
      ${estudiando ? '<span class="material-icons cc-spin">sync</span> Mirando tus ventas…'
                   : '<span class="material-icons">auto_graph</span> Estudiar mis ventas'}
    </button>
  </div>`;
}

const MESES_LARGOS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function fechaLinda(ymdStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymdStr || ''));
  if (!m) return String(ymdStr || '');
  return `${Number(m[3])} de ${MESES_LARGOS[Number(m[2]) - 1] || ''}`;
}
function mesDe(ymdStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymdStr || ''));
  return m ? MESES_LARGOS[Number(m[2]) - 1] || '' : '';
}

// Taquito de almanaque: el mes arriba y el día abajo. El dueño pidió ver "para
// qué mes son" de un vistazo, y una línea de texto que dice "18 de octubre ·
// faltan 27 días" se lee, no se ve. Esto se ve de lejos.
function taquitoHtml(ymdStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymdStr || ''));
  if (!m) return '<span class="material-icons">event</span>';
  return `<span class="cc-taco" aria-hidden="true">
    <span class="cc-taco-mes">${esc(MESES_CORTOS[Number(m[2]) - 1] || '')}</span>
    <span class="cc-taco-dia">${Number(m[3])}</span>
  </span>`;
}

// ── Avisos: tope manual + presupuesto corto para lo SÍ O SÍ ───────────────────
function paintWarn() {
  const el = document.getElementById('cc-warn');
  if (!el) return;
  const s = _state;
  const partes = [];
  if (s.topeManual != null && s.topeManual > s.budget.gastableMes) {
    partes.push(`<div class="cc-warn"><span class="material-icons">warning_amber</span>
      El tope (${money(s.topeManual)}) supera lo que el colchón del mes permite gastar (${money(s.budget.gastableMes)}).</div>`);
  }
  const a = s.alloc;
  if (a && a.sisiCorto) {
    partes.push(`<div class="cc-warn cc-warn-danger"><span class="material-icons">priority_high</span>
      La plata no cubre ni ${MIN_COBERTURA_DIAS} días de lo SÍ O SÍ: necesitás como mínimo
      ${money(a.costoSisiUsado)} y hay ${money(budgetActivo())}. Comprá en orden, de arriba hacia abajo,
      hasta donde llegues.</div>`);
  } else if (a && a.degradado) {
    partes.push(`<div class="cc-warn"><span class="material-icons">content_cut</span>
      Para ${coberturaObjetivo()} días de lo SÍ O SÍ hacen falta ${money(a.costoSisiObjetivo)} y hay
      ${money(budgetActivo())}. Ajusté las cantidades para cubrir ~${a.diasUsados} días
      (${money(a.costoSisiUsado)}) sin dejar ningún imprescindible afuera.</div>`);
  }
  el.innerHTML = partes.join('');
}

// ── Eventos (delegados en el root, que se recrea en cada render completo) ──────
function bindEvents(root) {
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('mouseover', onMouseOver);
  root.addEventListener('mouseout', onMouseOut);
}

function onClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const s = _state;
  switch (action) {
    case 'period':
      s.period = btn.dataset.period;
      s.topeManual = null;
      { const t = document.getElementById('cc-tope'); if (t) t.value = ''; }
      recalc(true);
      break;
    case 'tope-clear':
      s.topeManual = null;
      { const t = document.getElementById('cc-tope'); if (t) t.value = ''; }
      recalc(true);
      break;
    case 'actualizar':
      actualizar(btn);
      break;
    case 'ajustes':
      s.ajustesOpen = !s.ajustesOpen;
      paintAjustes();
      break;
    case 'ajustes-cancel':
      s.ajustesOpen = false;
      paintAjustes();
      break;
    case 'ajustes-save':
      guardarAjustes();
      break;
    case 'registrar':
      registrarCompra(btn);
      break;
    case 'editar-plata': {
      const form = document.getElementById('cc-plata-form');
      if (!form) break;
      const abierto = form.style.display !== 'none';
      form.style.display = abierto ? 'none' : '';
      if (!abierto) {
        const inp = document.getElementById('cc-plata-input');
        if (inp) { inp.focus(); inp.select(); }
      }
      break;
    }
    case 'plata-save': {
      const v = parseNum((document.getElementById('cc-plata-input') || {}).value);
      if (v == null || v < 0) break;
      guardarPlataManual(v);
      break;
    }
    case 'plata-cancel': {
      const form = document.getElementById('cc-plata-form');
      if (form) form.style.display = 'none';
      break;
    }
    case 'plata-auto':
      guardarPlataManual(null);
      break;
    case 'anotar':
      toggleAnotado(Number(btn.dataset.idx));
      break;
    case 'filtro-anotados':
      s.filtroAnotados = !s.filtroAnotados;
      paintTable();
      paintResumen();
      break;
    case 'filtro-epoca': {
      const id = btn.dataset.id || '';
      s.temporadaFiltro = s.temporadaFiltro === id ? '' : id;
      paintTemporadas();
      paintFechas();
      paintTable();
      paintResumen();
      break;
    }
    case 'fechas':
      s.fechasOpen = !s.fechasOpen;
      paintFechas();
      break;
    case 'abrir-fecha':
      abrirFecha(btn.dataset.id || '');
      break;
    case 'sacar-de-fecha':
      sacarDeFecha(Number(btn.dataset.idx));
      break;
    case 'sumar-a-fecha':
      sumarAFecha(btn.dataset.id || '', btn.dataset.clave || '', btn.dataset.nombre || '');
      break;
    case 'devolver-a-fecha':
      devolverAFecha(btn.dataset.id || '', btn.dataset.clave || '');
      break;
    case 'ver-sacados':
      s.verSacados = s.verSacados === btn.dataset.id ? '' : btn.dataset.id;
      paintFechas();
      break;
    case 'buscar-fecha-clear':
      s.buscarFecha = '';
      paintFechas();
      document.getElementById('cc-buscar-fecha')?.focus();
      break;
    case 'estudiar-epocas':
      estudiarEpocas();
      break;
    case 'imprimir-cuaderno':
      imprimirCuaderno();
      break;
    case 'buscar-clear': {
      s.busqueda = '';
      const inp = document.getElementById('cc-buscar');
      if (inp) { inp.value = ''; inp.focus(); }
      guardarFiltros();
      paintTable();
      break;
    }
    case 'dd-toggle':
      if (_dd.abierto === btn.dataset.campo) cerrarDropdown();
      else abrirDropdown(btn.dataset.campo);
      break;
    case 'dd-opt':
      elegirOpcionDd(btn.dataset.campo, btn.dataset.valor || '');
      break;
    case 'filtros-clear':
      cerrarDropdown();
      s.filtros = filtrosVacios();
      guardarFiltros();
      paintTable();
      break;
    case 'filtros-clear-todo': {
      // Desde el "nada coincide": saca los selects Y la búsqueda de una.
      s.filtros = filtrosVacios();
      s.busqueda = '';
      const inp = document.getElementById('cc-buscar');
      if (inp) inp.value = '';
      guardarFiltros();
      paintTable();
      break;
    }
    case 'ver-catalogo':
      window.__pendingCatalogoOpen = btn.dataset.doc;
      window.__catalogoVolverA = 'centro_compras';
      if (typeof window.navigateToPage === 'function') window.navigateToPage('catalogo');
      break;
  }
}

function onChange(e) {
  const s = _state;
  if (e.target.classList.contains('cc-check')) {
    const i = Number(e.target.dataset.idx);
    if (s.rows[i]) s.rows[i].checked = e.target.checked;
    paintPlan();
    return;
  }
  if (e.target.classList.contains('cc-qty')) {
    const i = Number(e.target.dataset.idx);
    const r = s.rows[i];
    if (!r) return;
    const v = parseNum(e.target.value);
    r.qty = v != null && v >= 0 ? Math.round(v) : 0;
    r.qtyManual = true;    // la asignación de presupuesto ya no le pisa la cantidad
    recalc(false);         // recomputa acumulado/corte sin tocar la selección manual
    return;
  }
  if (e.target.classList.contains('cc-cost')) {
    const i = Number(e.target.dataset.idx);
    const r = s.rows[i];
    if (!r) return;
    const v = parseNum(e.target.value);
    if (!(v > 0)) return;
    r.cost = v;
    r.sinCosto = false;
    // En variedades el input pide el costo del PACK; el catálogo guarda costo
    // por unidad suelta (convención de la valorización de stock).
    const costoUnidad = (r.esVariedad && r.packSize > 0) ? v / r.packSize : v;
    if (r.producto) r.producto.costo = costoUnidad;
    guardarCostoCatalogo(r.doc_id, costoUnidad);
    recalc(false);
    if (r.fits && !r.checked) {
      r.checked = true;
      paintTable();
      paintPlan();
    }
    return;
  }
  if (e.target.id === 'cc-medio') { s.medio = fuenteValida(e.target.value); return; }
  if (e.target.id === 'cc-fecha') { s.fecha = e.target.value || hoyAR(); return; }
}

let _topeTimer = null;
let _buscarTimer = null;
let _buscarFechaTimer = null;
function onInput(e) {
  const s = _state;
  if (e.target.id === 'cc-tope') {
    clearTimeout(_topeTimer);
    _topeTimer = setTimeout(() => {
      const v = parseNum(e.target.value);
      s.topeManual = (v != null && v > 0) ? v : null;
      recalc(true);
    }, 250);
    return;
  }
  if (e.target.id === 'cc-buscar') {
    clearTimeout(_buscarTimer);
    _buscarTimer = setTimeout(() => {
      s.busqueda = e.target.value.trim();
      guardarFiltros();
      paintTable();
    }, 150);
    return;
  }
  if (e.target.id === 'cc-buscar-fecha') {
    clearTimeout(_buscarFechaTimer);
    _buscarFechaTimer = setTimeout(() => {
      s.buscarFecha = e.target.value;
      paintFechas();
      // El repintado reemplaza el input: hay que devolverle el foco y el cursor.
      const inp = document.getElementById('cc-buscar-fecha');
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }, 200);
    return;
  }
  if (e.target.id === 'cc-prov') { s.proveedor = e.target.value; return; }
  // Lupa adentro del desplegable: filtra las opciones del panel abierto.
  if (e.target.classList.contains('cc-dd-input')) {
    if (_dd.abierto === e.target.dataset.campo) repintarListaDd(e.target.dataset.campo);
  }
}

// ── Actualizar (re-fetch stock/ritmo + Balance) ───────────────────────────────
async function actualizar(btn) {
  const s = _state;
  btn.classList.add('cc-spin');
  try {
    const [alertas, diasDoc, balCfg] = await Promise.all([
      refrescarAlertas({ silent: true }),
      loadDiasMes(_db, s.ym),
      loadBalanceConfig(_db),
    ]);
    s.alertasBase = alertas;
    s.diasDoc = diasDoc || { ym: s.ym, dias: {} };
    s.balCfg = balCfg || {};
    s.budget = computeBudget(s.balCfg, s.diasDoc, s.comprasCfg, s.ym);
    s.rows = buildRows(fuentesCompra(alertas, s.comprasCfg), s.comprasCfg);
    mezclarTemporadas();
    recalc(true);
  } catch (e) {
    console.error('[centro_compras] actualizar:', e);
  } finally {
    btn.classList.remove('cc-spin');
  }
}

// ── Guardar ajustes ───────────────────────────────────────────────────────────
async function guardarAjustes() {
  const s = _state;
  const monto = parseNum((document.getElementById('cc-aj-monto') || {}).value) || 0;
  const piso = parseNum((document.getElementById('cc-aj-piso') || {}).value) || 0;
  const cob = Math.max(1, Math.round(parseNum((document.getElementById('cc-aj-cob') || {}).value) || COBERTURA_DEFAULT));
  const partial = {
    rentabilidad_monto: monto,
    rentabilidad_piso_pct: piso,
    cobertura_dias_objetivo: cob,
  };
  s.comprasCfg = { ...s.comprasCfg, ...partial };
  try {
    await saveComprasConfig(_db, partial);
  } catch (e) {
    console.error('[centro_compras] guardar ajustes:', e);
    await alertDialog({ title: 'No se pudo guardar', message: 'Revisá la conexión e intentá de nuevo.', type: 'error' });
    return;
  }
  // La cobertura cambia las cantidades sugeridas → reconstruir filas.
  s.budget = computeBudget(s.balCfg, s.diasDoc, s.comprasCfg, s.ym);
  s.rows = buildRows(fuentesCompra(s.alertasBase, s.comprasCfg), s.comprasCfg);
  mezclarTemporadas();
  s.ajustesOpen = false;
  paintAjustes();
  recalc(true);
}

// Persiste el costo cargado desde la tabla en el producto del Catálogo, para que
// quede para siempre (acá, en Catálogo y en la próxima compra). Falla en silencio:
// la fila ya quedó presupuestada en memoria igual.
function guardarCostoCatalogo(docId, costo) {
  if (!_db || !docId) return;
  updateDoc(doc(_db, 'catalogo', String(docId)), { costo, ultima_actualizacion: serverTimestamp() })
    .catch(e => console.warn('[centro_compras] no se pudo guardar el costo en catálogo:', e));
}

// ── Registrar compra ──────────────────────────────────────────────────────────
async function registrarCompra(btn) {
  const s = _state;
  const { items, total } = planSeleccionado();
  if (!items.length) {
    await alertDialog({ title: 'Nada seleccionado', message: 'Marcá al menos un producto con costo cargado.', type: 'warning' });
    return;
  }
  const fecha = s.fecha || hoyAR();
  const proveedor = (document.getElementById('cc-prov')?.value || s.proveedor || '').trim();
  const medio = fuenteValida((document.getElementById('cc-medio') || {}).value || s.medio);

  const ok = await confirmDialog({
    title: 'Registrar compra',
    message: `Vas a registrar <b>${items.length}</b> producto(s) por <b>${money(total)}</b>`
      + `${proveedor ? ` en <b>${esc(proveedor)}</b>` : ''} (${MEDIOS.find(m => m.k === medio)?.label}) el ${fecha}.`
      + `<br><br>Queda como gasto de inversión en el Balance del día y baja el presupuesto.`,
    confirmText: 'Registrar',
    cancelText: 'Cancelar',
  });
  if (!ok) return;

  const ymF = fecha.slice(0, 7);
  const DD = fecha.slice(8, 10);
  const lineas = items.map(r => ({
    proveedor: proveedor || 'Compra',
    rubro: r.rubro || '',
    medio,
    monto: r.qty * r.cost,
    origen: 'centro_compras',
    doc_id: r.doc_id,
  }));

  btn.disabled = true;
  try {
    // Re-leer el día justo antes de escribir (el array se reemplaza entero, no se
    // mergea) para no pisar una edición hecha desde el Balance.
    const mesDoc = await loadDiasMes(_db, ymF);
    const dia = (mesDoc?.dias?.[DD]) || { fecha, ingresos: [], compras: [] };
    dia.compras = [...(dia.compras || []), ...lineas];
    await saveDiasMes(_db, ymF, { dias: { [DD]: dia } });
  } catch (e) {
    console.error('[centro_compras] registrar:', e);
    btn.disabled = false;
    await alertDialog({ title: 'No se pudo registrar', message: 'Revisá la conexión e intentá de nuevo.', type: 'error' });
    return;
  }
  btn.disabled = false;

  // Update en vivo: marcar filas registradas, subir lo comprado, bajar el semáforo.
  // La marca del cuaderno se limpia sola: si se registró la compra, ya no hay
  // nada pendiente de conseguir.
  const idsReg = new Set(items.map(r => r.doc_id));
  const anotDel = {};
  s.rows.forEach(r => {
    if (idsReg.has(r.doc_id)) {
      r.registrado = true;
      r.checked = false;
      if (r.anotado) { anotDel[keyAnotado(r)] = deleteField(); r.anotado = null; }
    }
  });
  if (Object.keys(anotDel).length) {
    const mapa = { ...(s.comprasCfg.anotados || {}) };
    for (const k of Object.keys(anotDel)) delete mapa[k];
    s.comprasCfg = { ...s.comprasCfg, anotados: mapa };
    saveComprasConfig(_db, { anotados: anotDel })
      .catch(e => console.warn('[centro_compras] limpiar anotados comprados:', e));
  }
  // Reflejar la compra en el diasDoc en memoria (por si se registra otra en la
  // sesión) — solo si la fecha cae en el mes del semáforo.
  if (ymF === s.ym) {
    if (!s.diasDoc.dias) s.diasDoc.dias = {};
    const diaMem = s.diasDoc.dias[DD] || { fecha, ingresos: [], compras: [] };
    diaMem.compras = [...(diaMem.compras || []), ...lineas];
    s.diasDoc.dias[DD] = diaMem;
  }
  // Recomputar el presupuesto completo (respeta el monto manual si está activo).
  s.budget = computeBudget(s.balCfg, s.diasDoc, s.comprasCfg, s.ym);

  // Reset de selección: con el presupuesto que quedó, el plan se rearma con lo
  // que todavía entra (si no, quedan tildadas filas que ya no alcanza a pagar).
  recalc(true);
}
