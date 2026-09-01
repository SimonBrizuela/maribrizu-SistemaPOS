/**
 * La lista de compras del cuaderno, lista para imprimir (window.print → PDF).
 *
 * Sin DOM ni Firebase: recibe los renglones marcados "en el cuaderno" en el
 * Centro de Compras y devuelve el HTML completo de la hoja A4. La prueba
 * `tienda/pruebas/lista_cuaderno.test.js` fija qué se muestra y cómo suma.
 *
 * La hoja es para llevar al mayorista y completar a mano: cada renglón tiene
 * el tilde de "lo compré", y columnas en blanco para la cantidad real y lo
 * pagado; al pie va el cierre de la compra (cuánto gasté en total, cuántos
 * compré de los que decía la lista) y un renglón de notas.
 */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function fmt(n, dec = 0) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function money(n) { return '$ ' + fmt(n); }

const ORDEN_TIER = { sisi: 0, importante: 1, opcional: 2 };

/**
 * Agrupa por rubro y ordena: rubros alfabéticos; adentro primero lo "sí o sí",
 * después importante y al final lo que puede esperar, por nombre.
 * Cada item: { nombre, variedad?, rubro, tier, qty, cost, sinCosto, packSize?,
 *              esVariedad?, stockTexto?, ritmo? }
 * Devuelve [{ rubro, items, estimado, conCosto }].
 */
export function agruparCuaderno(items) {
  const por = new Map();
  (items || []).forEach(it => {
    const rubro = String(it.rubro || 'Sin rubro');
    if (!por.has(rubro)) por.set(rubro, []);
    por.get(rubro).push(it);
  });
  return [...por.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'es'))
    .map(([rubro, lista]) => {
      lista.sort((a, b) =>
        ((ORDEN_TIER[a.tier] ?? 9) - (ORDEN_TIER[b.tier] ?? 9))
        || String(a.nombre).localeCompare(String(b.nombre), 'es'));
      const conCosto = lista.filter(it => !it.sinCosto);
      return {
        rubro,
        items: lista,
        conCosto: conCosto.length,
        estimado: conCosto.reduce((t, it) => t + (Number(it.qty) || 0) * (Number(it.cost) || 0), 0),
      };
    });
}

/** El HTML completo de la hoja. `fecha` en ISO ('2026-09-01'). */
export function listaCuadernoHtml({ items, fecha }) {
  const grupos = agruparCuaderno(items);
  const total = grupos.reduce((t, g) => t + g.estimado, 0);
  const n = (items || []).length;
  const sinCosto = (items || []).filter(it => it.sinCosto).length;
  const f = String(fecha || '');
  const fechaTxt = f ? `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}` : '';

  let nro = 0;
  const filas = grupos.map(g => {
    const cab = `
      <tr class="grupo">
        <td colspan="5">${esc(g.rubro)} <span class="grupo-n">${g.items.length} producto${g.items.length === 1 ? '' : 's'}</span></td>
        <td class="r">${g.conCosto ? money(g.estimado) : '—'}</td>
        <td colspan="2"></td>
      </tr>`;
    const cuerpo = g.items.map(it => {
      nro++;
      const detalle = [
        it.stockTexto ? `stock ${it.stockTexto}` : null,
        it.ritmo ? `vende ${it.ritmo}` : null,
        it.packSize > 1 ? `packs de ${fmt(it.packSize)} u` : null,
      ].filter(Boolean).join(' · ');
      return `
      <tr>
        <td class="c num">${nro}</td>
        <td class="c"><span class="tilde"></span></td>
        <td>
          <div class="prod">${esc(it.nombre)}${it.esVariedad && it.variedad ? ` <span class="varnt">${esc(it.variedad)}</span>` : ''}${it.tier === 'sisi' ? ' <span class="sisi">sí o sí</span>' : ''}</div>
          ${detalle ? `<div class="det">${esc(detalle)}</div>` : ''}
        </td>
        <td class="c cant">${fmt(it.qty)}</td>
        <td class="r">${it.sinCosto ? '—' : money(it.cost)}</td>
        <td class="r">${it.sinCosto ? '—' : money((Number(it.qty) || 0) * (Number(it.cost) || 0))}</td>
        <td class="mano"></td>
        <td class="mano"></td>
      </tr>`;
    }).join('');
    return cab + cuerpo;
  }).join('');

  return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8" />
<title>Lista de compras ${esc(fechaTxt)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica', 'Arial', sans-serif; color: #1c1e21; margin: 0; line-height: 1.35; font-size: 11px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .brand { font-size: 20px; font-weight: 800; color: #7b3fa6; margin: 0; }
  .tag { font-style: italic; color: #777; font-size: 9.5px; margin-top: 1px; }
  .titulo { text-align: right; }
  .titulo .lbl { font-size: 15px; font-weight: 800; letter-spacing: .4px; }
  .titulo .fecha { font-size: 10px; color: #555; margin-top: 2px; }
  hr.linea { border: none; border-top: 2px solid #7b3fa6; margin: 8px 0 10px; }
  .resumen { display: flex; gap: 18px; font-size: 10.5px; color: #444; margin-bottom: 10px; }
  .resumen b { font-size: 12px; color: #1c1e21; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th { padding: 6px 6px; font-size: 9px; text-transform: uppercase; letter-spacing: .4px;
       color: #fff; background: #7b3fa6; font-weight: 700; text-align: left; }
  th.c, td.c { text-align: center; }
  th.r, td.r { text-align: right; }
  td { padding: 5px 6px; border-bottom: 0.6px solid #ddd; vertical-align: top; }
  tr { page-break-inside: avoid; }
  tr.grupo td { background: #f2ebf7; font-weight: 800; font-size: 10.5px; border-bottom: 1px solid #7b3fa6; padding: 6px; }
  .grupo-n { font-weight: 500; color: #777; font-size: 9px; margin-left: 6px; }
  .num { color: #999; font-size: 9.5px; }
  .prod { font-weight: 700; font-size: 11px; }
  .varnt { font-weight: 600; color: #7b3fa6; border: 0.6px solid #7b3fa6; border-radius: 8px; padding: 0 6px; font-size: 9px; white-space: nowrap; }
  .sisi { font-weight: 800; color: #fff; background: #c0392b; border-radius: 8px; padding: 0 6px; font-size: 8.5px; text-transform: uppercase; white-space: nowrap; }
  .det { color: #777; font-size: 9px; margin-top: 1px; }
  .cant { font-weight: 800; font-size: 12px; }
  .tilde { display: inline-block; width: 12px; height: 12px; border: 1.2px solid #555; border-radius: 3px; }
  td.mano { border-bottom: 0.6px dotted #999; }
  .cierre { margin-top: 16px; border: 1px solid #7b3fa6; border-radius: 6px; padding: 10px 14px; page-break-inside: avoid; }
  .cierre h4 { margin: 0 0 8px; font-size: 10px; color: #7b3fa6; text-transform: uppercase; letter-spacing: .5px; }
  .cierre-row { display: flex; gap: 26px; font-size: 11px; margin-bottom: 8px; flex-wrap: wrap; }
  .raya { display: inline-block; border-bottom: 1px dotted #555; min-width: 110px; }
  .notas { font-size: 10px; color: #555; }
  .notas .raya { display: block; min-width: 100%; margin-top: 14px; }
  .footer { margin-top: 10px; font-size: 8.5px; color: #999; display: flex; justify-content: space-between; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .no-print { display: none; } }
  .no-print { padding: 12px; text-align: center; background: #f5f5f5; border-bottom: 1px solid #ddd; margin-bottom: 10px; }
  .btn-print { background: #7b3fa6; color: #fff; padding: 10px 22px; font-weight: 700; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
</style>
</head>
<body>
  <div class="no-print">
    <button class="btn-print" onclick="window.print()">Imprimir / Guardar como PDF</button>
  </div>

  <div class="header">
    <div>
      <div class="brand">LIBRERIA LICEO</div>
      <div class="tag">Librería · Papelería · Juguetería · Mercería</div>
    </div>
    <div class="titulo">
      <div class="lbl">LISTA DE COMPRAS</div>
      <div class="fecha">${esc(fechaTxt)} · del cuaderno del Centro de Compras</div>
    </div>
  </div>
  <hr class="linea"/>

  <div class="resumen">
    <span><b>${n}</b> producto${n === 1 ? '' : 's'}</span>
    <span><b>${grupos.length}</b> rubro${grupos.length === 1 ? '' : 's'}</span>
    <span>Estimado <b>${money(total)}</b>${sinCosto ? ` <small>(+${sinCosto} sin costo cargado)</small>` : ''}</span>
  </div>

  <table>
    <thead>
      <tr>
        <th class="c" style="width:4%">#</th>
        <th class="c" style="width:4%"></th>
        <th>Producto</th>
        <th class="c" style="width:7%">Cant.</th>
        <th class="r" style="width:11%">Costo est.</th>
        <th class="r" style="width:12%">Est. $</th>
        <th class="c" style="width:9%">Compré</th>
        <th class="c" style="width:13%">Pagué $</th>
      </tr>
    </thead>
    <tbody>${filas || `<tr><td colspan="8" style="text-align:center;color:#777;padding:20px">No hay nada marcado en el cuaderno.</td></tr>`}</tbody>
  </table>

  <div class="cierre">
    <h4>Cierre de la compra</h4>
    <div class="cierre-row">
      <span>Compré <span class="raya" style="min-width:46px"></span> de <b>${n}</b> productos</span>
      <span>Gasté en total $ <span class="raya"></span></span>
      <span>Estimado de la lista: <b>${money(total)}</b></span>
    </div>
    <div class="notas">Notas (qué faltó, qué cambió de precio, qué conviene mirar la próxima):
      <span class="raya"></span><span class="raya"></span>
    </div>
  </div>

  <div class="footer">
    <span>LIBRERIA LICEO · Centro de Compras</span>
    <span>Impreso el ${esc(fechaTxt)} · las cantidades y costos son los del plan, lo real se anota a mano</span>
  </div>
</body></html>`;
}
