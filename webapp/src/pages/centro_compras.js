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
// tiene mínimo y está bien NO figura (ver fuentesCompra). Después se clasifica
// en tres niveles: SÍ O SÍ (se agota o ya no hay Y rota),
// IMPORTANTE (sin stock aunque venda poco, o top vendido bajo mínimo) y PUEDE
// ESPERAR. Dentro de cada nivel se ordena por la plata que se deja de facturar
// si falta (ritmo × precio de venta). El presupuesto se asigna en dos pasadas:
// primero lo SÍ O SÍ — si no entra completo a la cobertura objetivo, se achica
// la cobertura hasta un piso de 7 días ANTES de dejar productos afuera — y con
// lo que sobra se va marcando el resto en orden (lo que entra, entra, aunque
// esté después del corte). Al registrar una compra se escribe una línea en el
// libro diario del Balance, así el semáforo baja y el gasto queda contabilizado
// en un solo lugar.

import { doc, updateDoc, serverTimestamp, deleteField } from 'firebase/firestore';
import { loadBalanceConfig, loadDiasMes, saveDiasMes, loadComprasConfig, saveComprasConfig } from '../config.js';
import { refrescarAlertas, obtenerCandidatosCompra } from '../notifications.js';
import { sugerirCantidad } from '../inventario_resumen.js';
import { confirmDialog, alertDialog } from '../components/dialogs.js';
import { listaCuadernoHtml } from '../lista_cuaderno.js';
import {
  CAMPOS_FILTRO, SIN_VALOR, filtrosVacios, sanearFiltros, cantidadFiltros,
  coincideCompra, opcionesCompras, filtrarOpciones, campoTieneValores, textoBusquedaCompra,
} from '../filtros_compras.js';

const MEDIOS = [
  { k: 'efectivo', label: 'Efectivo' },
  { k: 'mp',       label: 'Mercado Pago' },
  { k: 'lapos',    label: 'Lapos' },
];
// Rubros que NO son inversión en producto (se cubren como gasto fijo aparte) y por
// eso no descuentan del presupuesto de compras. Normalizados (sin acento, minúscula).
const RUBROS_FIJOS_DEFAULT = ['sueldos', 'gastos fijos'];
const COBERTURA_DEFAULT = 30;    // días de venta a cubrir al sugerir cantidad
const MIN_COBERTURA_DIAS = 7;    // piso al achicar cantidades de lo SÍ O SÍ cuando la plata no alcanza
const MIN_ROTACION = 3;          // unidades vendidas en la ventana para considerar que "rota"
const TIER_RANK = { sisi: 0, importante: 1, opcional: 2 };
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
// Nivel de una alerta:
//   sisi       → se agota ya (o ya no hay) Y el producto rota → no comprarlo es
//                perder ventas seguro.
//   importante → sin stock (aunque venda poco), o top vendido bajo mínimo.
//   opcional   → stock bajo configurado, variantes auto, etc. Puede esperar.
function tierDe(a) {
  const rota = (Number(a.unidades_ventana) || 0) >= MIN_ROTACION;
  if (!a.auto && rota && (a.urgente || a.critico)) return 'sisi';
  if (a.critico || a.es_top || a.urgente) return 'importante';
  if (rota && a.dias_cobertura <= 14) return 'importante';   // rota y le quedan ~2 semanas
  return 'opcional';
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
      tier: tierDe(a),
      cobertura_texto: a.cobertura_texto || '',
      stock: Number(a.stock) || 0,
      stock_min: Number(a.stock_min) || 0,
      esVariedad,
      variedad: esVariedad ? (a.variedad || '') : null,
      packSize,
      stockUnits,
      vel_dia: velDia,
      vel_semana: Number(a.vel_semana) || 0,
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
  rows.sort((a, b) => {
    if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if ((b.perdidaHorizonte || 0) !== (a.perdidaHorizonte || 0)) return (b.perdidaHorizonte || 0) - (a.perdidaHorizonte || 0);
    if ((b.vel_dia || 0) !== (a.vel_dia || 0)) return (b.vel_dia || 0) - (a.vel_dia || 0);
    if (a.dias_cobertura !== b.dias_cobertura) return a.dias_cobertura - b.dias_cobertura;
    return a.nombre.localeCompare(b.nombre);
  });
  return rows;
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
  // Shell sincrónico (cancela el skeleton diferido de main.js y da feedback ya).
  container.innerHTML = shellHtml();

  const ym = hoyAR().slice(0, 7);
  let alertas, balCfg, diasDoc, comprasCfg;
  try {
    [alertas, balCfg, diasDoc, comprasCfg] = await Promise.all([
      refrescarAlertas({ silent: true }),
      loadBalanceConfig(db),
      loadDiasMes(db, ym),
      loadComprasConfig(db),
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
  };

  const root = container.querySelector('#cc-root');
  if (!root) return;   // navegaron a otra página mientras cargaban los datos
  root.innerHTML = pageHtml();
  bindEvents(root);
  recalc(true);
  limpiarAnotadosViejos();
}

// ── Marca "ya lo anoté en el cuaderno" ────────────────────────────────────────
// El dueño lleva la lista de compras en un cuaderno de papel. La marca dice "este
// ya está en el cuaderno": la fila queda resaltada y NO se saca de la lista (si
// el proveedor no lo tiene, el faltante sigue vivo semanas). Queda guardada en
// control_config/compras, así se ve igual desde cualquier PC.
async function toggleAnotado(i) {
  const s = _state;
  const r = s.rows[i];
  if (!r) return;
  const k = keyAnotado(r);
  r.anotado = r.anotado ? null : hoyAR();
  const mapa = { ...(s.comprasCfg.anotados || {}) };
  if (r.anotado) mapa[k] = r.anotado; else delete mapa[k];
  s.comprasCfg = { ...s.comprasCfg, anotados: mapa };
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
      <button class="cc-icon-btn" data-action="actualizar" title="Actualizar stock y ritmo">
        <span class="material-icons">refresh</span>
      </button>
      <button class="cc-icon-btn" data-action="ajustes" title="Ajustes de rentabilidad">
        <span class="material-icons">tune</span>
      </button>
    </div>
    <div id="cc-ajustes" class="cc-ajustes" style="display:none"></div>
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
        <span class="cc-hint">Ordenada por prioridad y plata en riesgo · Registrar descuenta el presupuesto, no el stock · La lapicera marca lo que ya está en el cuaderno.</span>
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
  return { filtros: s.filtros, busqueda: s.busqueda, soloAnotados: s.filtroAnotados };
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
  if (btn) btn.focus();
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
    const acotada = nFiltros > 0 || !!s.busqueda || s.filtroAnotados;
    cnt.textContent = !total ? '' : (acotada ? `${visibles} de ${total}` : `${total} en la lista`);
    cnt.classList.toggle('is-on', acotada && visibles < total);
  }
}

function paintTable() {
  const s = _state;
  const tbody = document.getElementById('cc-tbody');
  if (!tbody) return;
  if (!s.rows.length) {
    paintFiltros(0);
    tbody.innerHTML = `<tr><td colspan="9" class="cc-empty">
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
  const arriba = [], abajo = [];
  s.rows.forEach((r, i) => { if (visible(r)) ((r.registrado || r.fits) ? arriba : abajo).push(i); });
  paintFiltros(arriba.length + abajo.length);
  if (!arriba.length && !abajo.length) {
    const nFiltros = cantidadFiltros(s.filtros);
    const que = [
      s.busqueda ? `la búsqueda "${esc(s.busqueda)}"` : '',
      nFiltros ? (nFiltros === 1 ? 'el filtro puesto' : 'los filtros puestos') : '',
      s.filtroAnotados ? 'lo del cuaderno' : '',
    ].filter(Boolean).join(' y ');
    tbody.innerHTML = `<tr><td colspan="9" class="cc-empty">
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
    parts.push(`<tr class="cc-cutoff"><td colspan="9">
      <span class="material-icons">content_cut</span>
      Acá se acaba la plata (${money(disp)}) · lo de abajo no entra en el presupuesto</td></tr>`);
    prevDoc = null;
    abajo.forEach(emit);
  }
  tbody.innerHTML = parts.join('');
}

function rowHtml(r, i, esContinuacion) {
  // Atenuada solo si quedó fuera del plan y el usuario tampoco la marcó a mano.
  const espera = !r.registrado && !r.sinCosto && !r.fits && !r.checked;
  const anotado = !r.registrado && !!r.anotado;
  const cls = [
    r.registrado ? 'cc-row-reg' : '',
    anotado ? 'cc-row-anotado' : '',
    espera ? 'cc-row-espera' : '',
    esContinuacion ? 'cc-row-varcont' : '',
  ].filter(Boolean).join(' ');

  // Un solo chip por fila. El nivel ya lo dice el orden de la lista y las
  // píldoras de arriba; "sin stock" ya se ve en la columna Stock (0 en rojo)
  // y en el texto de cobertura. Repetirlo en cada fila era puro ruido.
  let chip = '';
  if (r.registrado) chip = `<span class="cc-chip cc-chip-ok">registrado</span>`;
  else if (r.tier === 'sisi') chip = `<span class="cc-chip cc-chip-sisi">sí o sí</span>`;

  // Marca "ya lo anoté en el cuaderno": chip con la fecha + botón para prender
  // o sacar la marca. No toca la selección ni el presupuesto: es solo para no
  // volver a anotar lo mismo cada vez que se repasa la lista.
  const fAnot = anotado ? `${r.anotado.slice(8, 10)}/${r.anotado.slice(5, 7)}` : '';
  if (anotado) chip += `<span class="cc-chip cc-chip-anotado" title="Lo anotaste en el cuaderno el ${fAnot}. Sigue en la lista hasta que lo compres o le saques la marca.">en el cuaderno ${fAnot}</span>`;
  const btnAnotar = r.registrado ? '' :
    `<button type="button" class="cc-anotar${anotado ? ' is-on' : ''}" data-action="anotar" data-idx="${i}"
       title="${anotado ? 'Sacar la marca del cuaderno' : 'Marcar que ya lo anotaste en el cuaderno'}">
       <span class="material-icons">edit_note</span></button>`;

  const checkbox = r.sinCosto || r.registrado
    ? `<span class="material-icons cc-check-off" title="${r.sinCosto ? 'Sin costo cargado' : 'Ya registrado'}">${r.sinCosto ? 'block' : 'check_circle'}</span>`
    : `<input type="checkbox" class="cc-check" data-idx="${i}"${r.checked ? ' checked' : ''} />`;

  const ritmo = r.vel_semana >= 1
    ? `~${fmt(Math.round(r.vel_semana), 0)}/sem`
    : (r.vel_semana > 0 ? '<1/sem' : '—');

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

  // Cobertura y plata en riesgo en UNA línea apagada: con una fila por producto
  // se lee igual, y la página deja de ser una pared de texto rojo repetido.
  const detalles = [];
  if (r.cobertura_texto) detalles.push(esc(r.cobertura_texto));
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
    <td>
      <div class="cc-prod">
        ${esContinuacion ? '<span class="material-icons cc-var-arrow" title="Otra variante del producto de arriba">subdirectory_arrow_right</span>' : ''}
        <button type="button" class="cc-prod-btn" data-action="ver-catalogo" data-doc="${esc(String(r.doc_id))}"
                title="Abrir este producto en el Catálogo">${esc(nombreBase)}<span class="material-icons">open_in_new</span></button>
        ${varChip}${chip}${btnAnotar}
      </div>
      ${detalles.length ? `<div class="cc-cob">${detalles.join(' · ')}</div>` : ''}
    </td>
    <td>
      <span class="badge badge-gray"${r.marca ? ` title="Marca: ${esc(r.marca)}"` : ''}>${esc(r.rubro || 'Sin rubro')}</span>
      ${(r.sub_rubro || r.proveedor) ? `<div class="cc-rubro-sub">${[r.sub_rubro, r.proveedor].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
    </td>
    <td class="cc-stock${stk.total <= 0 ? ' is-cero' : ''}" title="${esc(stockTitle)}">${esc(stk.texto)}</td>
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
        <input id="cc-aj-cob" type="text" inputmode="numeric" value="${c.cobertura_dias_objetivo != null ? c.cobertura_dias_objetivo : COBERTURA_DEFAULT}" placeholder="30" />
      </div>
    </div>
    <div class="cc-ajustes-actions">
      <button class="cc-btn-ghost" data-action="ajustes-cancel">Cancelar</button>
      <button class="cc-btn-primary" data-action="ajustes-save">
        <span class="material-icons">save</span> Guardar
      </button>
    </div>
    <div class="cc-ajustes-hint">La rentabilidad efectiva es la mayor entre el monto fijo y el piso % de los ingresos del mes.</div>`;
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

  el.innerHTML = pill('cc-tier-sisi', 'Sí o sí', sisi)
    + pill('cc-tier-imp', 'Importante', imp)
    + pill('cc-tier-opc', 'Puede esperar', opc)
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
