/**
 * El ticket del pedido, para imprimir.
 *
 * Sirve para dos momentos distintos y por eso es uno solo: el papel que se
 * lleva quien arma el pedido por el local, y el que va con el reparto. Lleva lo
 * que hace falta en los dos casos — qué juntar, para quién es, a dónde va y
 * cuánto se cobra — y nada más.
 *
 * Se abre en una ventana aparte y se imprime desde ahí, en vez de esconder el
 * panel entero con `@media print`. Dos motivos: el panel tiene barra lateral,
 * avisos y modales que habría que ocultar uno por uno, y desde una ventana
 * propia se puede imprimir con el pedido abierto atrás sin perder el lugar.
 *
 * Ancho pensado para la impresora térmica del mostrador (72 mm de área
 * imprimible en un rollo de 80). En una hoja A4 sale igual, como una columna
 * angosta arriba a la izquierda, que es lo que se recorta y se grapa al pedido.
 */

const ANCHO_MM = 72;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pesos(n) {
  return '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}

function cantidad(item) {
  return item.unidad === 'metro'
    ? `${Number(item.cantidad).toFixed(1).replace('.', ',')} m`
    : `${Math.round(item.cantidad)}`;
}

function fechaDe(marca) {
  const f = marca?.toDate ? marca.toDate() : (marca ? new Date(marca) : new Date());
  // 24 horas: en un ticket "03:40 p. m." se lee peor que "15:40", y con el
  // papel en la mano nadie quiere interpretar un a. m./p. m.
  return f.toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/**
 * El papel.
 *
 * Sin logo ni adornos: una térmica imprime en blanco y negro a 203 puntos por
 * pulgada y todo lo que no sea texto sale sucio. Lo que se lee de un vistazo
 * tiene que ser el código y a dónde va.
 */
function papel(p, cfg) {
  const entrega = p.entrega || {};
  const esDelivery = entrega.modo === 'delivery';
  const items = p.items || [];

  const renglones = items.map(i => `
    <tr>
      <td class="cant">${esc(cantidad(i))}</td>
      <td>
        ${esc(i.nombre)}
        ${i.variedad ? `<span class="detalle">${esc(i.variedad)}</span>` : ''}
        ${i.es_pack ? `<span class="detalle">pack de ${esc(i.pack_contenido)}</span>` : ''}
      </td>
      <td class="importe">${pesos(i.subtotal ?? i.precio * i.cantidad)}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Pedido ${esc(p.codigo || '')}</title>
<style>
  @page { size: ${ANCHO_MM}mm auto; margin: 4mm; }
  * { box-sizing: border-box; }
  body {
    width: ${ANCHO_MM}mm;
    margin: 0;
    padding: 2mm 0;
    font: 12px/1.35 -apple-system, "Segoe UI", system-ui, sans-serif;
    color: #000;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1 { font-size: 13px; margin: 0; letter-spacing: .02em; }
  .local { text-align: center; margin-bottom: 3mm; }
  .local p { margin: 1px 0; font-size: 10px; }

  /* El código se dicta por teléfono y se busca en el tablero: es lo único que
     tiene que leerse desde lejos, con el papel sobre el mostrador. */
  .codigo {
    text-align: center;
    font-size: 26px;
    font-weight: 800;
    letter-spacing: 3px;
    font-family: ui-monospace, "Courier New", monospace;
    padding: 2mm 0;
    border-top: 1px dashed #000;
    border-bottom: 1px dashed #000;
  }
  .cuando { text-align: center; font-size: 10px; margin: 1.5mm 0 3mm; }

  .bloque { margin-bottom: 3mm; }
  .bloque h2 {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: .08em;
    margin: 0 0 1mm;
    font-weight: 700;
  }
  .bloque p { margin: 0; font-size: 12px; }
  .grande { font-size: 14px; font-weight: 700; }

  table { width: 100%; border-collapse: collapse; margin-bottom: 2mm; }
  th {
    font-size: 9px; text-transform: uppercase; letter-spacing: .06em;
    text-align: left; border-bottom: 1px solid #000; padding-bottom: 1mm;
  }
  td { padding: 1.2mm 0; vertical-align: top; border-bottom: 1px dotted #bbb; }
  .cant { width: 12mm; font-weight: 700; font-variant-numeric: tabular-nums; }
  .importe { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .detalle { display: block; font-size: 10px; color: #444; }

  .totales { margin-top: 2mm; font-variant-numeric: tabular-nums; }
  .totales div { display: flex; justify-content: space-between; padding: .6mm 0; }
  .totales .total {
    border-top: 1px solid #000;
    margin-top: 1mm; padding-top: 1.5mm;
    font-size: 16px; font-weight: 800;
  }

  .nota {
    border: 1px solid #000;
    padding: 2mm;
    margin-top: 3mm;
    font-size: 11px;
  }
  .pie { margin-top: 4mm; text-align: center; font-size: 10px; }

  @media screen {
    body { margin: 24px auto; box-shadow: 0 2px 16px rgba(0,0,0,.18); padding: 6mm; }
  }
</style>
</head>
<body>
  <div class="local">
    <h1>${esc(cfg.nombre || 'Librería Liceo')}</h1>
    ${cfg.direccion ? `<p>${esc(cfg.direccion)}</p>` : ''}
    ${cfg.telefono ? `<p>${esc(cfg.telefono)}</p>` : ''}
  </div>

  <div class="codigo">${esc(p.codigo || '—')}</div>
  <p class="cuando">${esc(fechaDe(p.creado))}</p>

  <div class="bloque">
    <h2>Cliente</h2>
    <p class="grande">${esc(p?.cliente?.nombre || 'Sin nombre')}</p>
    <p>${esc(p?.cliente?.telefono || 'sin teléfono')}</p>
  </div>

  <div class="bloque">
    <h2>${esDelivery ? 'Envío a domicilio' : 'Retira en el local'}</h2>
    ${esDelivery ? `
      <p class="grande">${esc(entrega.direccion || 'Sin dirección')}</p>
      ${entrega.referencia ? `<p>${esc(entrega.referencia)}</p>` : ''}
      ${entrega.distancia_km ? `<p>${String(entrega.distancia_km).replace('.', ',')} km del local</p>` : ''}
    ` : '<p>El cliente lo pasa a buscar</p>'}
  </div>

  <table>
    <thead>
      <tr><th>Cant</th><th>Producto</th><th class="importe">Importe</th></tr>
    </thead>
    <tbody>${renglones}</tbody>
  </table>

  <div class="totales">
    <div><span>Productos</span><span>${pesos(p.subtotal)}</span></div>
    <div>
      <span>Envío</span>
      <span>${esDelivery
        ? (entrega.envio_a_confirmar ? 'a confirmar' : pesos(p.envio))
        : 'sin cargo'}</span>
    </div>
    <div class="total"><span>TOTAL</span><span>${pesos(p.total)}</span></div>
    <div><span>Paga con</span><span>${p?.pago?.modo === 'transferencia' ? 'transferencia' : 'efectivo'}</span></div>
  </div>

  ${p.nota ? `<div class="nota"><strong>Nota:</strong> ${esc(p.nota)}</div>` : ''}

  ${esDelivery && entrega.envio_a_confirmar
    ? '<div class="nota">Confirmar el envío antes de salir.</div>' : ''}

  <p class="pie">¡Gracias!</p>
</body>
</html>`;
}

/**
 * Abre el ticket e imprime.
 *
 * El diálogo de impresión se lanza recién con la ventana cargada; pedirlo antes
 * imprime una hoja en blanco en algunos navegadores. La ventana no se cierra
 * sola: si la impresora falla, cerrarla dejaría al vendedor sin nada, y desde
 * ahí puede reintentar o guardarlo como PDF.
 */
export function imprimirPedido(pedido, cfg = {}) {
  const ventana = window.open('', `ticket-${pedido.id || pedido.codigo || ''}`,
                              'width=420,height=760');

  if (!ventana) {
    alert('El navegador bloqueó la ventana del ticket. Permití las ventanas '
        + 'emergentes para este sitio y probá de nuevo.');
    return false;
  }

  ventana.document.write(papel(pedido, cfg));
  ventana.document.close();
  ventana.focus();

  const imprimir = () => { try { ventana.print(); } catch (err) { console.warn('[ticket]', err); } };
  if (ventana.document.readyState === 'complete') setTimeout(imprimir, 120);
  else ventana.addEventListener('load', () => setTimeout(imprimir, 120));

  return true;
}

/** El HTML del ticket, para poder probarlo sin abrir una ventana. */
export const ticketHtml = papel;
