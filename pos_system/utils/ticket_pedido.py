"""
El ticket de un pedido de la tienda, desde la caja.

Mismo papel que imprime el panel (`webapp/src/ticket_pedido.js`): qué juntar,
para quién es, a dónde va y cuánto se cobra. Pensado para la térmica del
mostrador (72 mm). Se muestra con la vista previa del POS, que imprime directo
al diálogo de Windows sin pasar por un navegador.
"""
import html
from datetime import datetime

from pos_system.models import pedido_tienda as reglas

ANCHO_MM = 72


def _esc(texto):
    return html.escape(str('' if texto is None else texto), quote=True)


def pesos(n):
    """$12.345, sin centavos, como en la tienda."""
    return '$' + f'{round(reglas.num(n)):,}'.replace(',', '.')


def _cantidad(item):
    if (item or {}).get('unidad') == 'metro':
        return f"{reglas.num(item.get('cantidad')):.1f}".replace('.', ',') + ' m'
    return str(int(round(reglas.num((item or {}).get('cantidad')))))


def _fecha(marca):
    f = reglas._fecha(marca) or datetime.now(reglas.TZ_AR)
    return f.astimezone(reglas.TZ_AR).strftime('%d/%m/%Y %H:%M')


def html_del_pedido(pedido, cfg=None):
    p = pedido or {}
    cfg = cfg or {}
    entrega = p.get('entrega') or {}
    envio = entrega.get('modo') == 'delivery'
    cupon = p.get('cupon') if isinstance(p.get('cupon'), dict) else {}

    renglones = ''.join(f'''
      <tr>
        <td class="cant">{_esc(_cantidad(i))}</td>
        <td>{_esc(i.get('nombre'))}
          {f'<span class="detalle">{_esc(i.get("variedad"))}</span>' if i.get('variedad') else ''}
          {f'<span class="detalle">pack de {_esc(i.get("pack_contenido"))}</span>' if i.get('es_pack') else ''}
        </td>
        <td class="importe">{pesos(i.get('subtotal') if i.get('subtotal') is not None else reglas.num(i.get('precio')) * reglas.num(i.get('cantidad')))}</td>
      </tr>''' for i in (p.get('items') or []) if isinstance(i, dict))

    if envio:
        destino = f'''
          <p class="grande">{_esc(entrega.get('direccion') or 'Sin dirección')}</p>
          {f'<p>{_esc(entrega.get("referencia"))}</p>' if entrega.get('referencia') else ''}
          {f'<p>{str(entrega.get("distancia_km")).replace(".", ",")} km del local</p>' if entrega.get('distancia_km') else ''}'''
        costo_envio = ('sin cargo (cupón)' if entrega.get('envio_gratis')
                       else 'a confirmar' if entrega.get('envio_a_confirmar')
                       else pesos(p.get('envio')))
    else:
        destino = '<p>El cliente lo pasa a buscar</p>'
        costo_envio = 'sin cargo'

    linea_cupon = ''
    if reglas.num(p.get('descuento')) > 0 and not entrega.get('envio_gratis'):
        linea_cupon = (f'<div><span>Cupón {_esc(cupon.get("codigo"))}</span>'
                       f'<span>-{pesos(p.get("descuento"))}</span></div>')

    pago = 'transferencia' if (p.get('pago') or {}).get('modo') == 'transferencia' else 'efectivo'
    nota = f'<div class="nota"><strong>Nota:</strong> {_esc(p.get("nota"))}</div>' if p.get('nota') else ''
    confirmar = ('<div class="nota">Confirmar el envío antes de salir.</div>'
                 if envio and entrega.get('envio_a_confirmar') else '')

    return f'''<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Pedido {_esc(p.get('codigo'))}</title>
<style>
  @page {{ size: {ANCHO_MM}mm auto; margin: 4mm; }}
  * {{ box-sizing: border-box; }}
  body {{ width: {ANCHO_MM}mm; margin: 0 auto; padding: 2mm 0;
         font: 12px/1.35 "Segoe UI", sans-serif; color: #000; background: #fff; }}
  h1 {{ font-size: 13px; margin: 0; }}
  .local {{ text-align: center; margin-bottom: 3mm; }}
  .local p {{ margin: 1px 0; font-size: 10px; }}
  .codigo {{ text-align: center; font-size: 26px; font-weight: 800; letter-spacing: 3px;
            font-family: "Courier New", monospace; padding: 2mm 0;
            border-top: 1px dashed #000; border-bottom: 1px dashed #000; }}
  .cuando {{ text-align: center; font-size: 10px; margin: 1.5mm 0 3mm; }}
  .bloque {{ margin-bottom: 3mm; }}
  .bloque h2 {{ font-size: 10px; text-transform: uppercase; letter-spacing: .08em; margin: 0 0 1mm; }}
  .bloque p {{ margin: 0; font-size: 12px; }}
  .grande {{ font-size: 14px; font-weight: 700; }}
  table {{ width: 100%; border-collapse: collapse; margin-bottom: 2mm; }}
  th {{ font-size: 9px; text-transform: uppercase; text-align: left; border-bottom: 1px solid #000; }}
  td {{ padding: 1.2mm 0; vertical-align: top; border-bottom: 1px dotted #bbb; }}
  .cant {{ width: 12mm; font-weight: 700; }}
  .importe {{ text-align: right; white-space: nowrap; }}
  .detalle {{ display: block; font-size: 10px; color: #444; }}
  .totales div {{ display: flex; justify-content: space-between; padding: .6mm 0; }}
  .totales .total {{ border-top: 1px solid #000; margin-top: 1mm; padding-top: 1.5mm;
                    font-size: 16px; font-weight: 800; }}
  .nota {{ border: 1px solid #000; padding: 2mm; margin-top: 3mm; font-size: 11px; }}
  .pie {{ margin-top: 4mm; text-align: center; font-size: 10px; }}
</style>
</head>
<body>
  <div class="local">
    <h1>{_esc(cfg.get('nombre') or 'Librería Liceo')}</h1>
    {f'<p>{_esc(cfg.get("direccion"))}</p>' if cfg.get('direccion') else ''}
    {f'<p>{_esc(cfg.get("telefono"))}</p>' if cfg.get('telefono') else ''}
  </div>
  <div class="codigo">{_esc(p.get('codigo') or '—')}</div>
  <p class="cuando">{_esc(_fecha(p.get('creado')))}</p>
  <div class="bloque">
    <h2>Cliente</h2>
    <p class="grande">{_esc((p.get('cliente') or {}).get('nombre') or 'Sin nombre')}</p>
    <p>{_esc((p.get('cliente') or {}).get('telefono') or 'sin teléfono')}</p>
  </div>
  <div class="bloque">
    <h2>{'Envío a domicilio' if envio else 'Retira en el local'}</h2>
    {destino}
  </div>
  <table>
    <thead><tr><th>Cant</th><th>Producto</th><th class="importe">Importe</th></tr></thead>
    <tbody>{renglones}</tbody>
  </table>
  <div class="totales">
    <div><span>Productos</span><span>{pesos(p.get('subtotal'))}</span></div>
    <div><span>Envío</span><span>{costo_envio}</span></div>
    {linea_cupon}
    <div class="total"><span>TOTAL</span><span>{pesos(p.get('total'))}</span></div>
    <div><span>Paga con</span><span>{pago}</span></div>
  </div>
  {nota}
  {confirmar}
  <p class="pie">¡Gracias!</p>
</body>
</html>'''


def imprimir_pedido(pedido, parent=None, cfg=None) -> bool:
    """Abre la vista previa del POS con el ticket. Devuelve si se mostró."""
    from PyQt5.QtWidgets import QMessageBox
    from pos_system.utils import ticket_printer as tp
    if not tp._qweb_available():
        QMessageBox.warning(parent, 'Falta dependencia',
                            'PyQtWebEngine no está instalado: no se puede mostrar el ticket.')
        return False
    try:
        codigo = str((pedido or {}).get('codigo') or '')
        dlg = tp.TicketPreviewDialog(html_del_pedido(pedido, cfg), sale_id=codigo, parent=parent,
                                     doc_label='Pedido', pdf_name=f'pedido_{codigo}.pdf')
        dlg.exec_()
        return True
    except Exception as e:
        QMessageBox.critical(parent, 'Ticket del pedido', f'No se pudo abrir el ticket:\n{e}')
        return False
