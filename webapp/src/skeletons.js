/**
 * Skeletons por página. Cada función devuelve HTML que imita la estructura
 * real (KPIs, charts, tablas, filtros) para que cuando el render real entre
 * con fade-in, no haya saltos de layout.
 *
 * Las clases skel-* viven en src/styles/skeleton.css.
 */

const skelRow = (n = 6) => Array(n).fill('<div class="skel skel-row"></div>').join('');
const skelKpi = (n = 9) => Array(n).fill(`
  <div class="skel-kpi">
    <div class="skel skel-line sm" style="width:60%"></div>
    <div class="skel skel-line lg" style="width:80%"></div>
    <div class="skel skel-line sm" style="width:40%"></div>
  </div>`).join('');
const skelChart = (h = 300) => `
  <div class="skel-card-wrap">
    <div class="skel skel-line lg" style="width:240px"></div>
    <div class="skel skel-line sm" style="width:160px;margin-top:6px"></div>
    <div class="skel" style="height:${h}px;margin-top:14px;border-radius:8px"></div>
  </div>`;
const skelTableCard = (rows = 6, title = '220px') => `
  <div class="skel-card-wrap">
    <div class="skel skel-line lg" style="width:${title};margin-bottom:14px"></div>
    ${skelRow(rows)}
  </div>`;
const skelFilterBar = () => `
  <div class="skel-filter-bar">
    <div class="skel" style="width:240px"></div>
    <div class="skel" style="width:160px"></div>
    <div class="skel" style="width:140px"></div>
  </div>`;

const SKELETONS = {
  dashboard: () => `
    <div class="dash-kpis" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;margin-bottom:18px">
      ${skelKpi(9)}
    </div>
    <div class="skel-card-wrap" style="margin-bottom:16px">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px">
        ${Array(6).fill('<div class="skel skel-line lg"></div>').join('')}
      </div>
    </div>
    <div class="skel-charts-2-1">
      ${skelChart(300)}
      ${skelChart(300)}
    </div>
    <div class="skel-charts-2">
      ${skelChart(260)}
      ${skelChart(260)}
    </div>
    <div class="skel-charts-2">
      ${skelChart(340)}
      ${skelChart(340)}
    </div>`,

  control_total: () => `
    ${skelFilterBar()}
    <div class="skel-stats">
      ${skelKpi(6)}
    </div>
    <div class="skel-charts-2-1">
      ${skelChart(280)}
      ${skelChart(280)}
    </div>
    <div class="skel-charts-2">
      ${skelChart(260)}
      ${skelChart(260)}
    </div>`,

  productos: () => `
    <div class="skel-stats" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr))">
      ${skelKpi(3)}
    </div>
    ${skelFilterBar()}
    ${skelTableCard(10, '280px')}`,

  historial: () => `
    ${skelTableCard(4, '180px')}
    <div style="height:16px"></div>
    ${skelFilterBar()}
    ${skelTableCard(8, '200px')}`,

  ventas: () => `
    ${skelFilterBar()}
    ${skelTableCard(10, '200px')}`,

  cierres: () => `
    ${skelFilterBar()}
    ${skelTableCard(8, '220px')}`,

  resumenes: () => `
    ${Array(4).fill(`
      <div class="skel-card-wrap" style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="skel skel-line lg" style="width:200px"></div>
          <div class="skel skel-line" style="width:120px"></div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:14px">
          ${Array(4).fill('<div class="skel" style="height:64px;border-radius:10px"></div>').join('')}
        </div>
      </div>`).join('')}`,

  catalogo: () => `
    <div class="skel-stats" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">
      ${skelKpi(6)}
    </div>
    <div class="skel-filter-bar">
      <div class="skel" style="flex:1;min-width:240px"></div>
      <div class="skel" style="width:140px"></div>
      <div class="skel" style="width:140px"></div>
      <div class="skel" style="width:120px"></div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px">
      ${Array(10).fill('<div class="skel skel-card" style="height:190px"></div>').join('')}
    </div>`,

  promociones: () => `
    ${skelFilterBar()}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px">
      ${Array(6).fill('<div class="skel skel-card" style="height:160px"></div>').join('')}
    </div>`,

  articulos_unicos: () => `
    ${skelFilterBar()}
    ${skelTableCard(8, '240px')}`,

  facturas: () => `
    <div class="skel-stats">
      ${skelKpi(4)}
    </div>
    ${skelTableCard(8, '240px')}`,

  perfiles: () => skelTableCard(6, '200px'),
  clientes: () => skelTableCard(8, '200px'),
  observaciones: () => skelTableCard(6, '200px'),
  presupuestos: () => skelTableCard(6, '220px'),
  turnos: () => skelTableCard(6, '180px'),
  notificaciones: () => skelTableCard(8, '220px'),
  lab_productos: () => `
    ${skelFilterBar()}
    ${skelTableCard(8, '240px')}`,
  pcs: () => `
    <div class="skel-stats">
      ${skelKpi(4)}
    </div>
    ${skelTableCard(4, '180px')}`,
};

export function renderSkeleton(page) {
  const fn = SKELETONS[page];
  if (fn) return fn();
  // Fallback genérico para páginas no listadas
  return `
    <div class="skel skel-line lg" style="width:240px;margin-bottom:16px"></div>
    ${skelTableCard(6)}`;
}
