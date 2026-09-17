"""
Revisa los pedidos de la tienda: qué pasó con cada uno, qué se duplicó o quedó
trabado, qué errores hubo. Y lo arregla, con simulacro primero.

Mirar (no escribe nada):

    python scripts/revisar_pedidos_tienda.py                  # últimos 7 días
    python scripts/revisar_pedidos_tienda.py --dias 30
    python scripts/revisar_pedidos_tienda.py --pedido K7M2    # la historia de un pedido (código o id)
    python scripts/revisar_pedidos_tienda.py --errores        # errores y rechazos

Arreglar (sin --aplicar muestra qué haría; con --aplicar guarda una copia en
backups/pedidos_tienda/ antes de escribir):

    --soltar-cobro K7M2       una caja se colgó con la pantalla de cobro abierta
    --soltar-factura K7M2     idem con la factura (antes: mirar en ARCA que no se emitió)
    --reabrir-cobro K7M2      el cobro quedó anotado pero hay que cobrarlo de nuevo
        [--anular-venta ID]   y además sacar de las ventas esa venta (sin tocar stock)
    --devolver-stock K7M2 --intento ID
                              deshace UN descuento de stock (el repetido); si el
                              catálogo cambió y no volvería lo mismo que salió, se
                              niega y muestra la diferencia
        [--reabrir-entrega]   si era el único: el pedido vuelve a "listo"
    --descontar-pendiente K7M2
                              descuenta lo que entregó el repartidor si ninguna caja
                              lo hizo (no hay PCs prendidas)

Lo que mira:

  grave   stock descontado dos veces · dos ventas para un pedido · dos facturas ·
          venta de una caja que el pedido no tiene anotada · cobro sin venta ·
          cancelado con el stock afuera · entregado sin descontar
  aviso   lo del repartidor sin descontar hace rato (¿no hay cajas prendidas?) ·
          renglones que al entregar no salieron del stock ·
          cobro o factura "en curso" de una caja que no terminó ·
          errores anotados por las cajas
  info    entregados sin cobrar de más de un día · rechazos por caja

Las cajas y el panel anotan cada paso en `tienda_pedidos_eventos`; los
movimientos de stock de un pedido llevan `pedido_id` e `intento`. Todo lo que
escribe este script queda anotado igual, con origen `script`.
"""
import argparse
import json
import os
import socket
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)

from pos_system.models import pedido_tienda as reglas  # noqa: E402

TZ = reglas.TZ_AR
MINUTOS_REPARTO_TRABADO = 30
MINUTOS_MARCA_TRABADA = 15
MINUTOS_COBRO_SIN_VENTA = 15
HORAS_SIN_COBRAR = 24


# ══════════════════════════════════════════════════════════════════════════
#  Lo que se revisa (sin Firebase)
# ══════════════════════════════════════════════════════════════════════════

def _fecha(v):
    return reglas._fecha(v)


def _hace_mas_de(marca, minutos, ahora):
    f = _fecha(marca)
    return f is not None and (ahora - f) > timedelta(minutes=minutos)


def es_nota_de_credito(factura):
    tipo = str((factura or {}).get('tipo_comprobante') or '').upper()
    return tipo.startswith('NOTA') or bool((factura or {}).get('cbte_asoc_nro'))


def grupos_de_stock(pedido_id, movimientos):
    """Los descuentos de stock de un pedido, agrupados por intento.

    Cada vez que alguien descuenta (una caja, el panel, este script) escribe sus
    movimientos con un `intento` propio. Una devolución (`motivo: anulacion`)
    lleva `revierte_intento`. Los movimientos del panel de antes del 16-09 no
    tienen intento y se agrupan como `panel-viejo`.
    """
    grupos = {}
    for m in movimientos:
        if m.get('pedido_id') != pedido_id:
            continue
        if m.get('motivo') == 'anulacion' and m.get('revierte_intento'):
            continue
        clave = m.get('intento') or 'panel-viejo'
        g = grupos.setdefault(clave, {'intento': clave, 'movimientos': [], 'revertido': False,
                                      'origen': m.get('origen'), 'usuario': m.get('usuario'),
                                      'pc_id': m.get('pc_id'), 'ts': m.get('ts')})
        g['movimientos'].append(m)
    for m in movimientos:
        if m.get('pedido_id') == pedido_id and m.get('revierte_intento') in grupos:
            grupos[m['revierte_intento']]['revertido'] = True
    return grupos


def _problema(tipo, gravedad, pedido_id, pedido, detalle, arreglo=''):
    return {'tipo': tipo, 'gravedad': gravedad, 'pedido_id': pedido_id,
            'codigo': str((pedido or {}).get('codigo') or ''), 'detalle': detalle, 'arreglo': arreglo}


def revisar(pedidos, eventos, movimientos, ventas, facturas, ahora):
    """Devuelve la lista de problemas encontrados, los graves primero."""
    problemas = []
    ventas_por_pedido = defaultdict(list)
    for v in ventas:
        if v.get('deleted') is True:
            continue
        pid = v.get('pedido_id')
        if pid:
            ventas_por_pedido[pid].append(v)
    facturas_por_pedido = defaultdict(list)
    for f in facturas:
        # Un comprobante sin CAE no es una factura en ARCA: no cuenta como repetida.
        if f.get('pedido_id') and not es_nota_de_credito(f) and str(f.get('cae') or '').strip():
            facturas_por_pedido[f['pedido_id']].append(f)

    for pid, p in pedidos.items():
        codigo = p.get('codigo') or pid
        grupos = [g for g in grupos_de_stock(pid, movimientos).values() if not g['revertido']]

        if len(grupos) > 1:
            lista = ', '.join(f"{g['intento']} ({g.get('origen') or '?'} {g.get('pc_id') or ''})".strip()
                              for g in grupos)
            problemas.append(_problema(
                'stock_duplicado', 'grave', pid, p,
                f'el stock salió {len(grupos)} veces: {lista}',
                f'--devolver-stock {codigo} --intento <uno de los repetidos>'))

        vs = ventas_por_pedido.get(pid, [])
        if len(vs) > 1:
            problemas.append(_problema(
                'venta_duplicada', 'grave', pid, p,
                'hay ' + str(len(vs)) + ' ventas: ' + ', '.join(str(v.get('id')) for v in vs),
                f'--reabrir-cobro {codigo} --anular-venta <la repetida> (y cobrar de nuevo si hace falta)'))
        for v in vs:
            es_de_caja = str(v.get('pc_id') or '') != 'TIENDA'
            if es_de_caja and str(p.get('venta_id') or '') != str(v.get('id')):
                problemas.append(_problema(
                    'venta_sin_anotar', 'grave', pid, p,
                    f"la venta {v.get('id')} es de este pedido pero el pedido anota "
                    f"{p.get('venta_id') or 'ninguna'}",
                    f"si la venta sobra: --anular-venta {v.get('id')} con --reabrir-cobro {codigo}"))

        fs = facturas_por_pedido.get(pid, [])
        if len(fs) > 1:
            problemas.append(_problema(
                'factura_duplicada', 'grave', pid, p,
                'hay ' + str(len(fs)) + ' facturas: ' + ', '.join(
                    f"{f.get('tipo_comprobante')} {f.get('punto_venta')}-{f.get('nro_comprobante')}" for f in fs),
                'emitir nota de crédito por la repetida desde Fiscal AFIP'))

        cobro = p.get('cobro') or {}
        # Un cobro de $0 (todo con cupón) no crea venta en la caja.
        cobro_con_plata = reglas.num(cobro.get('total'), reglas.num(p.get('total'))) > 0
        if reglas.cobrado(p) and cobro_con_plata and _hace_mas_de(cobro.get('en'), MINUTOS_COBRO_SIN_VENTA, ahora):
            if not p.get('venta_id'):
                problemas.append(_problema(
                    'cobro_sin_venta', 'grave', pid, p,
                    f"cobrado en {reglas.quien_texto(cobro)} sin venta anotada: esa caja la crea al "
                    "volver a abrir el POS",
                    f"si esa PC no vuelve: --reabrir-cobro {codigo} y cobrarlo en otra caja"))
            elif not vs:
                problemas.append(_problema(
                    'venta_sin_subir', 'aviso', pid, p,
                    f"la venta {p.get('venta_id')} no está en la nube (se sube sola cuando esa caja tenga internet)"))

        if p.get('estado') == 'cancelado' and reglas.stock_afuera(p) and not str(p.get('venta_id') or '').startswith('TIENDA_'):
            problemas.append(_problema(
                'cancelado_con_stock', 'grave', pid, p, 'está cancelado y el stock salió',
                f'--devolver-stock {codigo} --intento <el del descuento> (sigue cancelado)'))

        if (p.get('estado') == 'entregado' and not reglas.stock_afuera(p)
                and p.get('venta_pendiente') is not True):
            problemas.append(_problema(
                'entregado_sin_descontar', 'grave', pid, p,
                'está entregado y el stock nunca salió', f'--descontar-pendiente {codigo}'))

        if p.get('venta_pendiente') is True and _hace_mas_de(p.get('entregado_en'), MINUTOS_REPARTO_TRABADO, ahora):
            problemas.append(_problema(
                'reparto_sin_descontar', 'aviso', pid, p,
                'lo entregó el repartidor y ninguna caja descontó el stock (¿no hay POS prendidos?)',
                f'abrir un POS, o --descontar-pendiente {codigo}'))

        if cobro.get('estado') == 'en_curso' and _hace_mas_de(cobro.get('desde'), MINUTOS_MARCA_TRABADA, ahora):
            problemas.append(_problema(
                'cobro_trabado', 'aviso', pid, p,
                f"{reglas.quien_texto(cobro)} empezó a cobrarlo y no terminó",
                f'--soltar-cobro {codigo}'))

        factura = p.get('factura') or {}
        if factura.get('estado') == 'en_curso' and _hace_mas_de(factura.get('desde'), MINUTOS_MARCA_TRABADA, ahora):
            problemas.append(_problema(
                'factura_trabada', 'aviso', pid, p,
                f"{reglas.quien_texto(factura)} empezó a facturarlo y no terminó",
                f'mirar en ARCA si se emitió; si no: --soltar-factura {codigo}'))

        saltados = p.get('stock_saltados') or []
        if saltados and p.get('estado') != 'cancelado':
            problemas.append(_problema(
                'stock_sin_descontar', 'aviso', pid, p,
                f'{len(saltados)} renglón(es) no salieron del stock al entregar: ' + '; '.join(
                    f"{x.get('nombre') or x.get('producto_id') or 'renglón'} ({x.get('motivo')})" for x in saltados),
                'corregir el stock de esos productos a mano en el catálogo'))

        if reglas.a_cobrar(p) and _hace_mas_de(p.get('entregado_en'), HORAS_SIN_COBRAR * 60, ahora):
            problemas.append(_problema('sin_cobrar', 'info', pid, p,
                                       'entregado hace más de un día y sin cobrar'))

    for e in eventos:
        if e.get('resultado') == 'error':
            p = pedidos.get(e.get('pedido_id'))
            problemas.append(_problema(
                'error', 'aviso', e.get('pedido_id'), p or {'codigo': e.get('codigo')},
                f"{e.get('accion')}: {e.get('detalle')} ({reglas.quien_texto(e)})"))

    orden = {'grave': 0, 'aviso': 1, 'info': 2}
    return sorted(problemas, key=lambda x: (orden.get(x['gravedad'], 9), x['codigo'], x['tipo']))


def rechazos_por_caja(eventos):
    cuenta = defaultdict(int)
    for e in eventos:
        if e.get('resultado') == 'rechazado':
            cuenta[(reglas.quien_texto(e), e.get('accion'), e.get('detalle'))] += 1
    return sorted(cuenta.items(), key=lambda x: -x[1])


def historia(pedido_id, pedido, eventos, movimientos, ventas, facturas):
    """Todo lo que pasó con un pedido, en orden."""
    lineas = []
    if pedido:
        lineas.append((_fecha(pedido.get('creado')), 'pedido',
                       f"entró · {(pedido.get('cliente') or {}).get('nombre', '')} · "
                       f"${reglas.num(pedido.get('total')):,.0f} · "
                       f"{'envío' if reglas.es_envio(pedido) else 'retiro'} · "
                       f"{(pedido.get('pago') or {}).get('modo', '')}"))
    for e in eventos:
        if e.get('pedido_id') != pedido_id:
            continue
        marca = {'hecho': '', 'rechazado': 'RECHAZADO · ', 'error': 'ERROR · '}.get(e.get('resultado'), '')
        extra = f" [intento {e.get('intento')}]" if e.get('accion') in ('entregar', 'cobrar') else ''
        lineas.append((_fecha(e.get('en')), e.get('accion'),
                       f"{marca}{e.get('detalle') or ''} · {reglas.quien_texto(e)} ({e.get('origen')}){extra}"))
    for g in grupos_de_stock(pedido_id, movimientos).values():
        detalle = '; '.join(f"{m.get('producto_nombre')} {m.get('cantidad')} ({m.get('stock_antes')}→{m.get('stock_despues')})"
                            for m in g['movimientos'])
        estado = ' · DEVUELTO' if g['revertido'] else ''
        lineas.append((_fecha(g.get('ts')), 'stock', f"intento {g['intento']}{estado}: {detalle}"))
    for m in movimientos:
        if m.get('pedido_id') == pedido_id and m.get('revierte_intento'):
            lineas.append((_fecha(m.get('ts')), 'stock',
                           f"devolución de {m.get('revierte_intento')}: {m.get('producto_nombre')} +{m.get('cantidad')}"))
    for v in ventas:
        if v.get('pedido_id') == pedido_id:
            borrada = ' · BORRADA' if v.get('deleted') else ''
            lineas.append((_fecha(v.get('created_at')), 'venta',
                           f"{v.get('id')} · ${reglas.num(v.get('total_amount')):,.0f} · {v.get('payment_type')}{borrada}"))
    for f in facturas:
        if f.get('pedido_id') == pedido_id:
            lineas.append((_fecha(f.get('created_at')), 'factura',
                           f"{f.get('tipo_comprobante')} {f.get('punto_venta')}-{f.get('nro_comprobante')} "
                           f"CAE {f.get('cae') or '(sin CAE)'}"))
    minimo = datetime(1970, 1, 1, tzinfo=timezone.utc)
    return sorted(lineas, key=lambda x: x[0] or minimo)


# ══════════════════════════════════════════════════════════════════════════
#  Firestore
# ══════════════════════════════════════════════════════════════════════════

def conectar():
    import firebase_admin
    from firebase_admin import credentials, firestore
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))
    return firestore.client()


def _datos(snap):
    return {'id': snap.id, **(snap.to_dict() or {})}


def _en_tandas(valores, n=30):
    valores = list(valores)
    for i in range(0, len(valores), n):
        yield valores[i:i + n]


def leer(db, desde, codigo=None):
    from google.cloud.firestore_v1.base_query import FieldFilter
    col = db.collection('tienda_pedidos')
    pedidos = {}
    if codigo:
        # El código o el id: dos pedidos pueden compartir código y la revisión
        # muestra el id para esos casos.
        directo = col.document(codigo).get()
        if directo.exists:
            pedidos[directo.id] = _datos(directo)
        for s in col.where(filter=FieldFilter('codigo', '==', codigo.upper())).stream():
            pedidos[s.id] = _datos(s)
    else:
        for s in col.where(filter=FieldFilter('creado', '>=', desde)).stream():
            pedidos[s.id] = _datos(s)
        for campo in ('venta_pendiente', 'cobro_pendiente'):
            for s in col.where(filter=FieldFilter(campo, '==', True)).stream():
                pedidos[s.id] = _datos(s)
        for s in col.where(filter=FieldFilter('cobro.estado', '==', 'en_curso')).stream():
            pedidos[s.id] = _datos(s)
        for s in col.where(filter=FieldFilter('factura.estado', '==', 'en_curso')).stream():
            pedidos[s.id] = _datos(s)

    ids = list(pedidos)
    eventos, movimientos, ventas, facturas = [], [], [], []
    for tanda in _en_tandas(ids):
        eventos += [_datos(s) for s in db.collection('tienda_pedidos_eventos')
                    .where(filter=FieldFilter('pedido_id', 'in', tanda)).stream()]
        movimientos += [_datos(s) for s in db.collection('stock_movimientos')
                        .where(filter=FieldFilter('pedido_id', 'in', tanda)).stream()]
        ventas += [_datos(s) for s in db.collection('ventas')
                   .where(filter=FieldFilter('pedido_id', 'in', tanda)).stream()]
        facturas += [_datos(s) for s in db.collection('facturas')
                     .where(filter=FieldFilter('pedido_id', 'in', tanda)).stream()]
    # Movimientos del panel de antes del 16-09: sin pedido_id, con la referencia.
    referencias = {f"Pedido tienda {p.get('codigo') or pid}": pid for pid, p in pedidos.items()}
    vistos = {m['id'] for m in movimientos}
    for tanda in _en_tandas(referencias):
        for s in db.collection('stock_movimientos').where(filter=FieldFilter('referencia', 'in', tanda)).stream():
            if s.id not in vistos:
                m = _datos(s)
                m['pedido_id'] = referencias[m.get('referencia')]
                movimientos.append(m)
    # Ventas TIENDA viejas: su id es TIENDA_<codigo>.
    for pid, p in pedidos.items():
        s = db.collection('ventas').document(f"TIENDA_{p.get('codigo')}").get()
        if s.exists and not any(v['id'] == s.id for v in ventas):
            v = _datos(s)
            v.setdefault('pedido_id', pid)
            ventas.append(v)
    return pedidos, eventos, movimientos, ventas, facturas


def _quien():
    return {'pc_id': 'script', 'pc_nombre': socket.gethostname(), 'cajero': os.environ.get('USERNAME', '')}


def _respaldar(carpeta, accion, codigo, contenido):
    os.makedirs(carpeta, exist_ok=True)
    nombre = f"{datetime.now(TZ).strftime('%Y%m%d_%H%M%S')}_{accion}_{codigo}.json"
    ruta = os.path.join(carpeta, nombre)
    with open(ruta, 'w', encoding='utf-8') as f:
        json.dump(contenido, f, ensure_ascii=False, indent=2, default=str)
    return ruta


def _evento(tx, db, pedido_id, pedido, accion, intento, detalle, extra=None):
    from google.cloud import firestore
    ahora = datetime.now(TZ)
    doc = {
        'pedido_id': pedido_id, 'codigo': str((pedido or {}).get('codigo') or ''),
        'accion': accion, 'resultado': 'hecho', 'detalle': detalle, 'origen': 'script',
        **_quien(), 'intento': intento, 'en': firestore.SERVER_TIMESTAMP,
        'dia': reglas.dia_argentina(ahora), 'estado_antes': (pedido or {}).get('estado'),
        **(extra or {}),
    }
    tx.set(db.collection('tienda_pedidos_eventos').document(f'{pedido_id}__{accion}__{intento}'), doc)


def _buscar_pedido(db, codigo):
    """El id del pedido por su código, o el id directo: dos pedidos pueden
    compartir código (y alguno viejo no tiene), y ahí se usa el id que muestra
    la revisión."""
    from google.cloud.firestore_v1.base_query import FieldFilter
    col = db.collection('tienda_pedidos')
    if col.document(codigo).get().exists:
        return codigo
    encontrados = list(col.where(filter=FieldFilter('codigo', '==', codigo.upper())).stream())
    if len(encontrados) != 1:
        ids = ', '.join(d.id for d in encontrados)
        raise SystemExit(f'No hay un único pedido con código {codigo} ({len(encontrados)} encontrados'
                         + (f': {ids}; usá el id' if ids else '') + ').')
    return encontrados[0].id


def arreglar(db, accion, codigo, aplicar, intento_a_revertir=None, reabrir_entrega=False,
             anular_venta=None, carpeta_copias=None):
    """Hace (o simula) un arreglo. Devuelve el texto de lo que hizo o haría."""
    from google.cloud import firestore
    from google.cloud.firestore_v1.transaction import transactional

    carpeta_copias = carpeta_copias or os.path.join(RAIZ, 'backups', 'pedidos_tienda')
    pid = _buscar_pedido(db, codigo)
    ref = db.collection('tienda_pedidos').document(pid)
    intento = uuid.uuid4().hex[:16]
    salida = {}

    if accion == 'descontar-pendiente':
        from pos_system.utils.pedidos_tienda_nube import NubePedidos
        pedido = ref.get().to_dict() or {}
        if reglas.stock_afuera(pedido):
            return 'El stock de ese pedido ya salió: no hay nada que descontar.'
        if pedido.get('estado') != 'entregado':
            return 'El pedido no está entregado.'
        if not aplicar:
            return f'Descontaría el stock de {codigo} como lo hace una caja (simulacro).'
        _respaldar(carpeta_copias, accion, codigo, {'pedido': pedido})
        r = NubePedidos(db, quien=_quien, avisar_cliente=False).entregar(pid, origen='script')
        return 'Stock descontado.' if r.ok else f'No se descontó: {r.rechazo}'

    @transactional
    def tx_fn(tx):
        snap = ref.get(transaction=tx)
        pedido = snap.to_dict() or {}
        salida['pedido'] = pedido

        if accion == 'soltar-cobro':
            if (pedido.get('cobro') or {}).get('estado') != 'en_curso':
                return 'El pedido no tiene un cobro en curso.'
            if aplicar:
                tx.update(ref, {'cobro': firestore.DELETE_FIELD})
                _evento(tx, db, pid, pedido, 'soltar_cobro', intento, 'marca de cobro liberada a mano',
                        {'marca_anterior': json.loads(json.dumps(pedido.get('cobro'), default=str))})
            return f"Libera el cobro de {reglas.quien_texto(pedido.get('cobro'))}."

        if accion == 'soltar-factura':
            if (pedido.get('factura') or {}).get('estado') != 'en_curso':
                return 'El pedido no tiene una factura en curso.'
            if aplicar:
                tx.update(ref, {'factura': firestore.DELETE_FIELD})
                _evento(tx, db, pid, pedido, 'soltar_factura', intento, 'marca de factura liberada a mano')
            return f"Libera la factura de {reglas.quien_texto(pedido.get('factura'))}."

        if accion == 'reabrir-cobro':
            if not reglas.cobrado(pedido):
                return 'El pedido no está cobrado.'
            venta_ref = db.collection('ventas').document(anular_venta) if anular_venta else None
            venta = None
            renglones = []
            if venta_ref is not None:
                vs = venta_ref.get(transaction=tx)
                if not vs.exists:
                    return f'No existe la venta {anular_venta}.'
                venta = vs.to_dict() or {}
                if venta.get('pedido_id') != pid:
                    return f'La venta {anular_venta} no es de este pedido.'
                salida['venta'] = venta
                # Los renglones cuentan en los cierres por su propio `deleted`:
                # marcar solo la venta la sacaba de la lista pero no de la caja.
                from google.cloud.firestore_v1.base_query import FieldFilter
                prefijo = f"{venta.get('pc_id') or ''}_"
                renglones = [r for r in db.collection('ventas_por_dia')
                             .where(filter=FieldFilter('num_venta', '==', venta.get('sale_id'))).get(transaction=tx)
                             if r.id.startswith(prefijo)]
            if aplicar:
                tx.update(ref, {'cobro_pendiente': True, 'cobro': firestore.DELETE_FIELD,
                                'venta_id': firestore.DELETE_FIELD})
                if venta_ref is not None:
                    tx.update(venta_ref, {'deleted': True, 'deleted_at': firestore.SERVER_TIMESTAMP})
                    for r in renglones:
                        tx.update(r.reference, {'deleted': True})
                _evento(tx, db, pid, pedido, 'reabrir_cobro', intento,
                        'cobro reabierto a mano' + (f' y venta {anular_venta} anulada' if anular_venta else ''),
                        {'cobro_anterior': json.loads(json.dumps(pedido.get('cobro'), default=str))})
            texto = f"Vuelve a 'a cobrar' (estaba cobrado en {reglas.quien_texto(pedido.get('cobro'))})."
            if anular_venta:
                texto += (f" Marca borrada la venta {anular_venta}; OJO: la caja de esa PC todavía la tiene "
                          "en su base local, hay que corregir el cierre a mano.")
            return texto

        if accion == 'devolver-stock':
            if not intento_a_revertir:
                return 'Falta --intento (se ve en --pedido).'
            from google.cloud.firestore_v1.base_query import FieldFilter
            movs = [s.to_dict() | {'id': s.id} for s in
                    db.collection('stock_movimientos')
                    .where(filter=FieldFilter('pedido_id', '==', pid)).get(transaction=tx)]
            grupos = grupos_de_stock(pid, movs)
            grupo = grupos.get(intento_a_revertir)
            if not grupo:
                return f'No hay descuento con intento {intento_a_revertir} en este pedido.'
            if grupo['revertido']:
                return 'Ese descuento ya se devolvió.'
            vivos = [g for g in grupos.values() if not g['revertido']]
            cancelado = pedido.get('estado') == 'cancelado'
            if reabrir_entrega and len(vivos) != 1:
                return (f'Hay {len(vivos)} descuentos activos: primero devolvé los repetidos sin '
                        '--reabrir-entrega; la entrega se reabre solo con el último.')
            if len(vivos) == 1 and not reabrir_entrega and not cancelado:
                return ('Es el único descuento del pedido: devolverlo deja el pedido entregado sin stock. '
                        'Si es lo que querés (se entregó por error), agregá --reabrir-entrega.')
            if reabrir_entrega and cancelado:
                return 'El pedido está cancelado: se devuelve sin --reabrir-entrega y sigue cancelado.'
            if reabrir_entrega and reglas.cobrado(pedido):
                return 'El pedido está cobrado: primero --reabrir-cobro.'
            ids = sorted({str((i or {}).get('id') or '') for i in pedido.get('items') or []} - {''})
            catalogo = {}
            for prod in ids:
                s = db.collection('catalogo').document(prod).get(transaction=tx)
                catalogo[prod] = s.to_dict() if s.exists else None
            salida['catalogo'] = catalogo
            plan = reglas.plan_descuento(pedido.get('items') or [], catalogo, devolver=True)
            salida['plan'] = plan
            if intento_a_revertir != 'panel-viejo':
                # La devolución se arma con el catálogo de hoy: si cambió desde
                # el descuento (variedad renombrada, renglón que se salteó,
                # contenido del pack), no devolvería lo que salió.
                difs = reglas.diferencias_de_devolucion(plan, grupo['movimientos'])
                if difs:
                    salida['plan'] = None
                    return ('No se devuelve: el catálogo cambió y no volvería lo mismo que salió. ' + '; '.join(
                        f"{d['producto_id']} {d['detalle']}: salió {d['salio']:g}, volvería {d['devolveria']:g}"
                        for d in difs) + '. Corregí esos productos a mano.')
            if aplicar:
                n = 0
                for prod in plan['productos']:
                    if prod['saltado'] or not prod['campos']:
                        continue
                    tx.set(db.collection('catalogo').document(prod['id']),
                           {**prod['campos'], 'ultima_actualizacion': firestore.SERVER_TIMESTAMP}, merge=True)
                    for m in prod['movimientos']:
                        tx.set(db.collection('stock_movimientos').document(f'tienda_{pid}_{intento}_{n}'), {
                            'ts': firestore.SERVER_TIMESTAMP, 'origen': 'script', 'pc_id': 'script',
                            'usuario': _quien()['cajero'], 'producto_id': None, 'firebase_id': prod['id'],
                            'producto_nombre': prod['nombre'], 'motivo': 'anulacion',
                            'cantidad': reglas._limpio(round(float(m['cantidad']), 4)),
                            'stock_antes': reglas._limpio(round(float(m['antes']), 4)),
                            'stock_despues': reglas._limpio(round(float(m['despues']), 4)),
                            'referencia': f"Pedido tienda {pedido.get('codigo') or pid} (devolución)",
                            'detalle': m.get('detalle') or '', 'pedido_id': pid, 'intento': intento,
                            'revierte_intento': intento_a_revertir,
                        })
                        n += 1
                if reabrir_entrega:
                    tx.update(ref, {
                        'estado': 'listo', 'stock_descontado': False, 'venta_registrada': False,
                        'cobro_pendiente': False, 'venta_pendiente': False,
                        'entregado_en': firestore.DELETE_FIELD, 'entregado_dia': firestore.DELETE_FIELD,
                        'entregado_por': firestore.DELETE_FIELD,
                    })
                elif cancelado and len(vivos) == 1:
                    tx.update(ref, {'stock_descontado': False, 'venta_registrada': False,
                                    'cobro_pendiente': False, 'venta_pendiente': False})
                _evento(tx, db, pid, pedido, 'devolver_stock', intento,
                        f'devuelto el descuento {intento_a_revertir}' + (' y entrega reabierta' if reabrir_entrega else ''),
                        {'revierte_intento': intento_a_revertir})
            detalle = '; '.join(f"{p['nombre']} +{sum(m['cantidad'] for m in p['movimientos'])}"
                                for p in plan['productos'] if p['campos'])
            return f"Devuelve: {detalle}." + (' El pedido vuelve a "listo".' if reabrir_entrega else '')

        return f'Acción desconocida: {accion}'

    if aplicar:
        # La copia se toma con lo que hay antes de escribir: el pedido y, si se
        # va a tocar stock, las fichas de sus productos.
        previo = ref.get().to_dict() or {}
        copia = {'pedido': previo}
        if accion == 'devolver-stock':
            ids = sorted({str((i or {}).get('id') or '') for i in previo.get('items') or []} - {''})
            copia['catalogo'] = {prod: db.collection('catalogo').document(prod).get().to_dict() for prod in ids}
        _respaldar(carpeta_copias, accion, codigo, copia)
    texto = tx_fn(db.transaction())
    if aplicar and accion == 'devolver-stock' and salida.get('plan'):
        try:
            db.collection('config').document('catalogo_meta').set(
                {'last_updated': datetime.now(TZ).strftime('%Y-%m-%dT%H:%M:%S%z')}, merge=True)
        except Exception:
            pass
    return texto if aplicar else f'(simulacro) {texto}'


# ══════════════════════════════════════════════════════════════════════════
#  Pantalla
# ══════════════════════════════════════════════════════════════════════════

def _hora(f):
    return f.astimezone(TZ).strftime('%d/%m %H:%M') if f else '--/-- --:--'


def mostrar_problemas(problemas):
    if not problemas:
        print('Sin problemas: nada duplicado, trabado ni con errores.')
        return
    for p in problemas:
        print(f"[{p['gravedad'].upper():5}] {p['codigo']:>6}  {p['tipo']}: {p['detalle']}")
        if p['arreglo']:
            print(f"               arreglo: {p['arreglo']}")


ACCIONES = ('soltar-cobro', 'soltar-factura', 'reabrir-cobro', 'devolver-stock', 'descontar-pendiente')


def banderas_sueltas(args):
    """La combinación de banderas que no tiene sentido, o '' si está bien."""
    accion = next((a for a in ACCIONES if getattr(args, a.replace('-', '_'), None)), None)
    if accion is None:
        sueltas = [n for n, v in (('--aplicar', args.aplicar), ('--intento', args.intento),
                                  ('--reabrir-entrega', args.reabrir_entrega),
                                  ('--anular-venta', args.anular_venta)) if v]
        return f"{', '.join(sueltas)} sin una acción" if sueltas else ''
    if (args.intento or args.reabrir_entrega) and accion != 'devolver-stock':
        return '--intento y --reabrir-entrega van solo con --devolver-stock'
    if args.anular_venta and accion != 'reabrir-cobro':
        return '--anular-venta va solo con --reabrir-cobro'
    if accion == 'devolver-stock' and not args.intento:
        return '--devolver-stock necesita --intento (se ve con --pedido)'
    if accion and (args.pedido or args.errores):
        return '--pedido y --errores son para mirar, no van con una acción'
    return ''


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dias', type=int, default=7)
    ap.add_argument('--pedido')
    ap.add_argument('--errores', action='store_true')
    ap.add_argument('--json', help='guarda el informe en este archivo')
    acciones = ap.add_mutually_exclusive_group()
    for accion in ACCIONES:
        acciones.add_argument(f'--{accion}', metavar='CODIGO')
    ap.add_argument('--intento')
    ap.add_argument('--reabrir-entrega', action='store_true')
    ap.add_argument('--anular-venta')
    ap.add_argument('--aplicar', action='store_true')
    args = ap.parse_args(argv)
    problema = banderas_sueltas(args)
    if problema:
        # Antes una bandera de más o sin su acción se ignoraba callada y corría
        # la revisión de solo lectura: parecía que se había arreglado algo.
        ap.error(problema)
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

    db = conectar()
    for accion in ACCIONES:
        codigo = getattr(args, accion.replace('-', '_'))
        if codigo:
            print(arreglar(db, accion, codigo, args.aplicar, intento_a_revertir=args.intento,
                           reabrir_entrega=args.reabrir_entrega, anular_venta=args.anular_venta))
            return

    ahora = datetime.now(TZ)
    desde = ahora - timedelta(days=args.dias)
    pedidos, eventos, movimientos, ventas, facturas = leer(db, desde, args.pedido)

    if args.pedido:
        if not pedidos:
            print(f'No hay pedido con código o id {args.pedido}.')
            return
        for pid, p in pedidos.items():
            print(f"Pedido {p.get('codigo')} ({pid}) · estado {p.get('estado')}")
            for f, tipo, texto in historia(pid, p, eventos, movimientos, ventas, facturas):
                print(f"  {_hora(f)}  {tipo:<14} {texto}")
        mostrar_problemas(revisar(pedidos, eventos, movimientos, ventas, facturas, ahora))
        return

    problemas = revisar(pedidos, eventos, movimientos, ventas, facturas, ahora)
    print(f'{len(pedidos)} pedidos revisados desde {_hora(desde)}.')
    if args.errores:
        problemas = [p for p in problemas if p['tipo'] == 'error']
    mostrar_problemas(problemas)
    rechazos = rechazos_por_caja(eventos)
    if rechazos:
        print('\nRechazos (un botón viejo que otra caja ya había resuelto; es normal que haya algunos):')
        for (quien, accion, detalle), n in rechazos[:15]:
            print(f'  {n:>3} · {quien} · {accion}: {detalle}')
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump({'problemas': problemas, 'rechazos': [[list(k), n] for k, n in rechazos]},
                      f, ensure_ascii=False, indent=2, default=str)


if __name__ == '__main__':
    main()
