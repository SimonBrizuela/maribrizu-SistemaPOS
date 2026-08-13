/**
 * DEPRECADO — el inventario vive ahora como pestaña dentro de Catálogo
 * (catalogo.js → renderTabInventario), que usa el store realtime + el resumen
 * pinneado `inv:resumen` (ver inventario_resumen.js) y carga al instante.
 *
 * Esta página suelta tenía una copia divergente que reescaneaba ventas_por_dia
 * con su propio getDocs. Se reemplazó por un redirect para no mantener dos
 * implementaciones que se desincronizan. No está ruteada en main.js; el stub
 * existe sólo por compatibilidad si algo la importa.
 */
export async function renderInventario(container, db) {
  if (container) {
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;gap:14px;text-align:center">
        <span class="material-icons" style="font-size:40px;color:var(--tint-blue-fg)">insights</span>
        <div style="font-size:15px;font-weight:600;color:var(--text)">El inventario ahora está dentro de Catálogo</div>
        <div style="font-size:13px;color:var(--text-muted)">Abriendo la pestaña Inventario…</div>
      </div>`;
  }

  // Navegar a Catálogo y activar la pestaña Inventario una vez montada.
  try {
    if (typeof window.navigateToPage === 'function') window.navigateToPage('catalogo');
  } catch (_) {}

  // El tab del catálogo se renderiza async: esperamos a que aparezca el botón.
  let intentos = 0;
  const timer = setInterval(() => {
    intentos += 1;
    const btn = document.querySelector('.tab-btn[data-tab="inventario"]');
    if (btn) { clearInterval(timer); btn.click(); }
    else if (intentos > 40) clearInterval(timer); // ~6s máx, evitar loop infinito
  }, 150);
}
