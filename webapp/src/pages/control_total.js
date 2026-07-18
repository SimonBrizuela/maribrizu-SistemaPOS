// ── Control Total ─────────────────────────────────────────────────────────────
// La página ES el Balance Mensual (balance_mensual.js): Resumen del período,
// Resumen vivo (réplica del Excel), Semana a Semana, Día por día, Meses y Buscar.
//
// El viejo motor de ganancia POS (ventas × costo de catálogo + colección gastos
// + transfer_splits) se retiró a pedido del usuario: el Resumen se calcula 100%
// desde lo anotado en el balance. Si hiciera falta recuperarlo, está en git
// (commit previo a la unificación) y en webapp/backups/.
import { mountBalanceMensual } from './balance_mensual.js';

export async function renderControlTotal(container, db) {
  container.innerHTML = `
    <div class="ct-wrap">
      <div id="ct-balance-mount">
        <div class="ct-loading"><div class="spinner" style="width:24px;height:24px;border-width:3px"></div></div>
      </div>
    </div>`;
  const mount = container.querySelector('#ct-balance-mount');
  try {
    await mountBalanceMensual(mount, db);
  } catch (err) {
    console.error('[control_total] error montando Balance Mensual:', err);
    mount.innerHTML = `<div class="bal-empty"><span class="material-icons">error_outline</span>
      <div class="bal-empty-sub">No se pudo cargar el Balance Mensual.</div></div>`;
  }
}
