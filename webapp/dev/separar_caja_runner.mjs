/**
 * Separar una caja por día desde la terminal, con el MISMO código que el botón.
 *
 * La pantalla de Cierres tiene el botón "Separar por día". Este runner existe
 * para el caso en que hay que hacerlo sin abrir el navegador (una caja vieja,
 * una corrida de verificación, un arreglo puntual): importa `cajas_dias.js` y
 * `cajas_separar.js` tal cual, así no hay una segunda versión de la cuenta que
 * se despegue de la de la app — que es lo que ya pasó con otras reglas.
 *
 * Entra con un token a medida (Admin SDK) para pasar las reglas de Firestore:
 *
 *     python scripts/token_admin.py <email> > token.txt
 *     node dev/separar_caja_runner.mjs --caja 138 --token token.txt
 *     node dev/separar_caja_runner.mjs --caja 138 --token token.txt --aplicar
 *
 * Sin `--aplicar` no escribe nada: imprime los días, el plan y los controles.
 */
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
import { getAuth, signInWithCustomToken } from 'firebase/auth';

// Los módulos de la app dan por sentado que corren en el navegador (el cache
// se apoya en `window` y `localStorage`). Un par de cáscaras vacías alcanzan:
// acá no se usa ni el cache ni el almacenamiento, sólo la cuenta y las
// escrituras.
globalThis.window = globalThis.window || globalThis;
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0,
};

const { diasDeLaCaja, cortesSugeridos, armarGrupos, planDeSeparacion, idsLibres } =
  await import('../src/cajas_dias.js');
const { ejecutarSeparacion, numerosOcupados, separacionPendiente } =
  await import('../src/cajas_separar.js');
const { fechaDMYtoYMD, isItemVarios2 } = await import('../src/config.js');

const CONFIG = {
  apiKey: 'AIzaSyDBqPTloSp1MWBFcVMY6mdgyYKoqhTwFRA',
  authDomain: 'mari-d7c71.firebaseapp.com',
  projectId: 'mari-d7c71',
  storageBucket: 'mari-d7c71.firebasestorage.app',
  messagingSenderId: '477197039887',
  appId: '1:477197039887:web:f00b662c87d6eb74d2667a',
};

const args = process.argv.slice(2);
const valor = (nombre, porDefecto = null) => {
  const i = args.indexOf(nombre);
  return i >= 0 && args[i + 1] ? args[i + 1] : porDefecto;
};
const tiene = (nombre) => args.includes(nombre);

const REG      = Number(valor('--caja'));
const APLICAR  = tiene('--aplicar');
const HEREDAR  = tiene('--heredar-conteo');
const INICIAL  = valor('--inicial', null);
const TOKEN    = readFileSync(valor('--token', 'token.txt'), 'utf-8').trim();

if (!Number.isFinite(REG)) {
  console.error('Falta --caja <numero>');
  process.exit(1);
}

const plata = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// `hour12: false` a mano: en Node, es-AR imprime las 20:27 como 08:27 sin am/pm
// y un cierre de la noche parecía de la mañana.
const cuando = (d) => (d ? new Date(d).toLocaleString('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires', hour12: false,
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
}) : '—');

/** Los renglones de `ventas_por_dia`, con las mismas reglas que la pantalla. */
function normalizar(docs) {
  const salida = [];
  for (const d of docs) {
    const it = d.data();
    if (it.deleted === true) continue;
    if (isItemVarios2(it)) continue;
    const partes = d.id.split('_');
    const pcId = partes.length >= 3 ? partes.slice(0, -2).join('_') : '';
    let dt = null;
    if (it.fecha_dt && typeof it.fecha_dt.toDate === 'function') dt = it.fecha_dt.toDate();
    if (!dt) {
      const ymd = fechaDMYtoYMD(it.fecha);
      const hora = (it.hora || '00:00:00').padEnd(8, ':00').slice(0, 8);
      if (ymd) {
        const parsed = new Date(`${ymd}T${hora}-03:00`);
        if (!isNaN(parsed)) dt = parsed;
      }
    }
    salida.push({
      pc_id: pcId,
      num_venta: it.num_venta,
      subtotal: Number(it.subtotal || 0),
      cantidad: Number(it.cantidad || 0),
      tipo_pago: it.tipo_pago || '',
      monto_efectivo: it.monto_efectivo,
      monto_transferencia: it.monto_transferencia,
      producto: it.producto || it.product_name || '-',
      fecha_dt: dt,
      fecha_ymd: fechaDMYtoYMD(it.fecha),
      cash_register_id: Number(it.cash_register_id),
    });
  }
  return salida;
}

const app = initializeApp(CONFIG);
await signInWithCustomToken(getAuth(app), TOKEN);
const db = getFirestore(app);

// ── La caja y sus renglones ────────────────────────────────────────────────
const cajaSnap = await getDoc(doc(db, 'cierres_caja', String(REG)));
if (!cajaSnap.exists()) { console.error(`No existe cierres_caja/${REG}`); process.exit(1); }
const cajaDoc = { id: cajaSnap.id, ...cajaSnap.data() };

const aMedias = separacionPendiente(cajaDoc);
const ids = [REG, ...(aMedias?.ids_nuevos || [])];

let renglones = [];
for (const id of ids) {
  const snap = await getDocs(query(collection(db, 'ventas_por_dia'), where('cash_register_id', '==', Number(id))));
  renglones = renglones.concat(snap.docs);
}
const items = normalizar(renglones);
const dias = diasDeLaCaja(items, ids);

console.log(`\nCaja #${REG} — ${cuando(cajaDoc.fecha_apertura?.toDate?.())} → ${cuando(cajaDoc.fecha_cierre?.toDate?.())}`);
console.log(`  guardado en el cierre: ${plata(cajaDoc.total_ventas)} · ${cajaDoc.total_transacciones} ventas · `
          + `efectivo ${plata(cajaDoc.total_efectivo)} · transferencia ${plata(cajaDoc.total_transferencia)}`);
console.log(`  renglones leídos: ${renglones.length} (${items.length} cuentan para los totales)\n`);

console.log('Días adentro de la caja:');
for (const d of dias) {
  console.log(`  ${d.ymd || '(sin fecha)'}  ${String(d.tx).padStart(4)} ventas  ${plata(d.total).padStart(16)}  `
            + `ef ${plata(d.efectivo).padStart(14)}  tr ${plata(d.transferencia).padStart(14)}  `
            + `${d.primera ? cuando(d.primera).slice(-8) : '--:--'} a ${d.ultima ? cuando(d.ultima).slice(-8) : '--:--'}`);
}

// `--verificar`: el documento de la caja contra los renglones que hay de verdad.
// Sirve para cualquier caja, separada o no: si el doc quedó viejo, los totales
// de la pantalla mienten.
if (tiene('--verificar')) {
  const ef = dias.reduce((t, d) => t + d.efectivo, 0);
  const tr = dias.reduce((t, d) => t + d.transferencia, 0);
  const tx = new Set(dias.flatMap(d => [...d.ventas])).size;
  const cerca = (a, b) => Math.abs(a - b) < 0.01;
  const bien = cerca(ef, Number(cajaDoc.total_efectivo || 0))
            && cerca(tr, Number(cajaDoc.total_transferencia || 0))
            && tx === Number(cajaDoc.total_transacciones || 0);
  console.log('\nEl documento contra los renglones:');
  console.log(`  efectivo      doc ${plata(cajaDoc.total_efectivo)}  base ${plata(ef)}`);
  console.log(`  transferencia doc ${plata(cajaDoc.total_transferencia)}  base ${plata(tr)}`);
  console.log(`  ventas        doc ${cajaDoc.total_transacciones}  base ${tx}`);
  console.log(`  ${bien ? 'OK' : 'NO COINCIDE'}`);
  process.exit(bien ? 0 : 2);
}

const cortes = aMedias ? null : cortesSugeridos(dias);
if (!cortes || !cortes.some(Boolean)) {
  if (!aMedias) {
    console.log('\nNo hay dos jornadas de verdad adentro: no hay nada para separar.');
    process.exit(0);
  }
}
const grupos = armarGrupos(dias, cortes || []);
if (grupos.length < 2) { console.log('\nUn solo grupo: no hay nada para separar.'); process.exit(0); }

// ── Números libres ─────────────────────────────────────────────────────────
const todosLosCierres = (await getDocs(collection(db, 'cierres_caja'))).docs.map(d => ({ id: d.id, ...d.data() }));
const ocupados = numerosOcupados(todosLosCierres);
(aMedias?.ids_nuevos || []).forEach(id => ocupados.delete(Number(id)));
let max = 0; ocupados.forEach(id => { if (id > max) max = id; });
const nuevos = aMedias?.ids_nuevos?.length
  ? aMedias.ids_nuevos
  : idsLibres(ocupados, max + 1, grupos.length - 1);

const inicial = INICIAL !== null ? Number(INICIAL) : Number(cajaDoc.monto_inicial || 0);
const plan = planDeSeparacion({
  caja: { ...cajaDoc, register_id: REG },
  grupos,
  idsNuevos: nuevos,
  montosIniciales: grupos.map(() => inicial),
  // Por defecto ninguna queda "contada": el único conteo que hubo fue el de la
  // noche del cierre y no se puede repartir entre dos días. Con
  // `--heredar-conteo` se lo queda la última, como venía.
  conteos: HEREDAR ? grupos.map(() => undefined) : grupos.map(() => null),
});

console.log('\nCómo quedaría:');
for (const c of plan.cajas) {
  console.log(`  Caja #${c.id}${c.esNuevo ? ' (nueva)' : ''} — ${c.ymds.join(', ')}`);
  console.log(`      ${cuando(c.fecha_apertura)} → ${cuando(c.fecha_cierre)}`);
  console.log(`      ${c.total_transacciones} ventas · ${plata(c.total_ventas)} · ef ${plata(c.total_efectivo)} · tr ${plata(c.total_transferencia)}`);
  console.log(`      inicial ${plata(c.monto_inicial)} · esperado ${plata(c.monto_esperado)} · `
            + (c.pendiente_conteo ? 'pendiente de conteo' : `contado ${plata(c.monto_final)} (${plata(c.diferencia)})`));
  console.log(`      ${c.productos_vendidos.length} productos distintos`);
}

const ctrl = plan.control;
console.log('\nControl contra lo que dice el cierre:');
console.log(`  efectivo      ${plata(ctrl.efectivo.partes)} vs ${plata(ctrl.efectivo.caja)}`);
console.log(`  transferencia ${plata(ctrl.transferencia.partes)} vs ${plata(ctrl.transferencia.caja)}`);
console.log(`  total         ${plata(ctrl.ventas.partes)} vs ${plata(ctrl.ventas.caja)}`);
console.log(`  ventas        ${ctrl.tx.partes} vs ${ctrl.tx.caja}`);
console.log(`  ${ctrl.ok ? 'OK: las partes suman la caja entera' : 'NO DA: no se puede separar así'}`);
if (!ctrl.ok) process.exit(1);

if (!APLICAR) {
  console.log('\nDRY-RUN: no se escribió nada. Para aplicar, agregá --aplicar');
  process.exit(0);
}

console.log('\nAplicando...');
const r = await ejecutarSeparacion(db, {
  plan,
  idsPropios: aMedias?.ids_nuevos || [],
  onProgreso: (t) => console.log(`  ${t}`),
});
console.log(`\nListo. Cajas ${r.ids.map(i => '#' + i).join(', ')}`);
console.log(`  renglones movidos: ${r.renglones.movidos} de ${r.renglones.mirados}`);
console.log(`  ventas movidas:    ${r.ventas.movidos} de ${r.ventas.mirados}`);
if (r.renglones.sinDia.length || r.ventas.sinDia.length) {
  console.log(`  sin fecha (quedaron en #${REG}): ${r.renglones.sinDia.length} renglones, ${r.ventas.sinDia.length} ventas`);
}
process.exit(0);
