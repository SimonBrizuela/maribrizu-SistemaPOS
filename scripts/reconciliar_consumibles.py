"""
Reconcilia los descuentos por vinculacion que ninguna PC llego a aplicar.

Cuando se vende una impresion, la PC descuenta el papel en su base y lo sube
a Firestore marcando el item de `ventas_por_dia` con `consumibles_procesado`.
Si la PC estaba sin nube en ese momento (o corre una version vieja), la venta
termina subiendo por la cola offline pero el papel no: el item queda sin marca
y la nube con mas hojas que la gondola. Entre el 10 y el 12 de agosto de 2026
asi se fueron 1.264 hojas en todas las PCs a la vez.

Esto corre en GitHub Actions cada 6 horas y no depende de ninguna PC: busca
los items vinculados de los ultimos dias que siguen sin marca y aplica el
descuento con la misma regla que el POS (`vinculos_pendientes.planear` y
`conjunto.descontar_de_total`): el conjunto se descuenta del total que tiene
la nube y se vuelve a repartir, el plano con el numero leido, y el item queda
marcado en la misma transaccion. Si el POS o el panel lo marcan primero, la
transaccion lo ve y no toca nada.

    python scripts/reconciliar_consumibles.py            # solo mira
    python scripts/reconciliar_consumibles.py --aplicar
    python scripts/reconciliar_consumibles.py --dias 3 --aplicar

Lo que no se toca, a proposito:
  · ventas de fiado (`ventas.es_fiado`): sus lineas ya descontaron el dia que
    se cargaron y el POS solo las marca; descontar aca seria contar dos veces.
  · items que no matchean por nombre con un producto vinculado del catalogo.
  · destinos con variedades (no se sabe cual descontar), servicios, borrados.

Lecturas por corrida: los items de la ventana (~300 por dia) mas los ~50
productos vinculados y los papeles que haga falta; no lee el catalogo entero.
"""
import argparse
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

import firebase_admin
from firebase_admin import credentials, firestore

from pos_system.utils.vinculos_pendientes import planear

ORIGEN = 'reconciliador'


def conectar():
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(
            credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))
    return firestore.client()


def _num(v, por_defecto=0.0):
    try:
        return float(v) if v not in (None, '') else por_defecto
    except (TypeError, ValueError):
        return por_defecto


def _nombre(s):
    return str(s or '').upper().strip()


# ── Reglas puras (se prueban sin red en pos_system/tests) ────────────────────

def links_de(obj):
    """[{doc_id, cantidad}] de un producto o de una variedad. Formato nuevo
    (`vinculaciones[]`) o legacy (`vinculado_a` + `vinculado_cantidad`)."""
    out = []
    v = (obj or {}).get('vinculaciones')
    if isinstance(v, list) and v:
        for e in v:
            if isinstance(e, dict) and e.get('doc_id') and _num(e.get('cantidad')) > 0:
                out.append({'doc_id': str(e['doc_id']).strip(), 'cantidad': _num(e['cantidad'])})
        return out
    if (obj or {}).get('vinculado_a') and _num(obj.get('vinculado_cantidad')) > 0:
        out.append({'doc_id': str(obj['vinculado_a']).strip(), 'cantidad': _num(obj['vinculado_cantidad'])})
    return out


def indice_por_nombre(productos):
    """nombre → producto, para matchear el `producto` del item. Si dos docs
    comparten nombre gana el que tiene vinculos (es el que se vende)."""
    idx = {}
    for p in productos:
        n = _nombre(p.get('nombre'))
        if not n:
            continue
        if n not in idx or (links_de(p) and not links_de(idx[n])):
            idx[n] = p
    return idx


def links_del_item(item, producto):
    """Los vinculos que aplican a un item vendido. Un conjunto con variedades y
    un item con color usa los de la variedad (y si no tiene, ninguno): cada
    variedad decide su descuento, como en el watcher del panel."""
    if not producto:
        return []
    color = _nombre(item.get('conjunto_color'))
    if producto.get('es_conjunto') in (True, 1) and color:
        for c in producto.get('conjunto_colores') or []:
            if isinstance(c, dict) and _nombre(c.get('color')) == color:
                return links_de(c)
        return []
    return links_de(producto)


def grupo_del_item(item, producto):
    """Las filas que entiende `planear`, con el delta ya multiplicado por la
    cantidad vendida. Vacio si el item no descuenta nada."""
    cantidad = _num(item.get('cantidad'), 1.0) or 1.0
    contexto = str(producto.get('nombre') or '')
    vistos = set()
    filas = []
    for l in links_del_item(item, producto):
        if l['doc_id'] in vistos:
            continue
        vistos.add(l['doc_id'])
        filas.append({
            'item_idx':   0,
            'target_fid': l['doc_id'],
            'delta':      cantidad * l['cantidad'],
            'contexto':   contexto,
        })
    return filas


def es_candidato(item):
    """Un item que todavia no descontó y no esta borrado."""
    return item.get('consumibles_procesado') is not True and item.get('deleted') is not True


def clave_venta(item, doc_id):
    """`ventas/{pc_id}_{num_venta}`: para saber si la venta es un fiado."""
    pc = item.get('pc_id') or doc_id.rsplit('_', 2)[0]
    num = item.get('num_venta')
    return f'{pc}_{num}' if pc and num is not None else None


# ── Corrida ──────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dias', type=int, default=7, help='ventana hacia atras (default 7)')
    ap.add_argument('--aplicar', action='store_true', help='escribir; sin esto solo muestra')
    args = ap.parse_args()

    db = conectar()
    desde = datetime.now(timezone.utc) - timedelta(days=args.dias)

    vinculados = [dict(d.to_dict() or {}, doc_id=d.id)
                  for d in db.collection('catalogo').where('vinculado_a', '>', '').stream()]
    indice = indice_por_nombre(vinculados)

    candidatos = []
    for d in db.collection('ventas_por_dia').where('fecha_dt', '>=', desde).stream():
        x = d.to_dict() or {}
        if not es_candidato(x):
            continue
        p = indice.get(_nombre(x.get('producto')))
        if not p:
            continue
        grupo = grupo_del_item(x, p)
        if grupo:
            candidatos.append((d.reference, x, grupo))

    # Las ventas de fiado no se descuentan: sus lineas ya salieron el dia que
    # se cargaron. Se lee la venta una sola vez por venta.
    ventas_cache = {}
    fiados = 0
    trabajo = []
    for ref, x, grupo in candidatos:
        cv = clave_venta(x, ref.id)
        if cv and cv not in ventas_cache:
            snap = db.collection('ventas').document(cv).get()
            ventas_cache[cv] = bool((snap.to_dict() or {}).get('es_fiado')) if snap.exists else False
        if cv and ventas_cache[cv]:
            fiados += 1
            continue
        trabajo.append((ref, x, grupo))

    por_papel = defaultdict(float)
    for _, _, grupo in trabajo:
        for f in grupo:
            por_papel[f['target_fid']] += f['delta']
    print(f'Ventana: {args.dias} dias. Items sin descontar: {len(candidatos)} '
          f'(fiados que se saltean: {fiados}). A aplicar: {len(trabajo)}.')
    for fid, q in sorted(por_papel.items(), key=lambda t: -t[1]):
        print(f'   {fid:<14} {q:>8.1f} unidades')
    if not trabajo:
        return
    if not args.aplicar:
        print('\nSin --aplicar no se escribio nada.')
        return

    ahora = datetime.now(timezone.utc)
    col_cat = db.collection('catalogo')
    col_mov = db.collection('stock_movimientos')
    aplicados = 0
    saltados = defaultdict(int)
    hubo_cambio = False

    for ref, x, grupo in trabajo:
        fids = sorted({f['target_fid'] for f in grupo})
        transaccion = db.transaction()

        @firestore.transactional
        def _tx(tx, ref=ref, grupo=grupo, fids=fids):
            item_snap = ref.get(transaction=tx)
            item = item_snap.to_dict() or {}
            if not item_snap.exists or not es_candidato(item):
                return None    # lo marco otro en el medio
            estado = {}
            for fid in fids:
                snap = col_cat.document(fid).get(transaction=tx)
                estado[fid] = (snap.to_dict() or {}) if snap.exists else None
            plan = planear(grupo, estado)
            movs = []
            for fid, c in plan['conjuntos'].items():
                tx.set(col_cat.document(fid), {
                    'conjunto_total':       c['total'],
                    'conjunto_unidades':    c['unidades'],
                    'conjunto_restante':    c['restante'],
                    'stock':                c['stock'],
                    'ultima_actualizacion': ahora,
                }, merge=True)
                movs.append((fid, estado[fid].get('nombre') or '', _num(estado[fid].get('conjunto_total')), c['total']))
            for fid, delta in plan['planos'].items():
                antes = _num(estado[fid].get('stock'))
                despues = max(0.0, antes - delta)
                tx.set(col_cat.document(fid), {'stock': despues, 'ultima_actualizacion': ahora}, merge=True)
                movs.append((fid, estado[fid].get('nombre') or '', antes, despues))
            descuentos = plan['items'].get(0, [])
            tx.set(ref, {
                'consumibles_procesado':    True,
                'consumibles_procesado_at': ahora,
                'consumibles_origen':       ORIGEN,
                'consumibles_descuentos':   descuentos + [
                    {'target_id': fid, 'cantidad': 0, 'skip': motivo} for fid, motivo in plan['saltados']],
            }, merge=True)
            for fid, nombre, antes, despues in movs:
                tx.set(col_mov.document(), {
                    'ts': ahora, 'origen': ORIGEN, 'pc_id': ORIGEN, 'usuario': ORIGEN,
                    'producto_id': None, 'firebase_id': fid, 'producto_nombre': nombre,
                    'motivo': 'vinculacion', 'cantidad': round(despues - antes, 4),
                    'stock_antes': round(antes, 4), 'stock_despues': round(despues, 4),
                    'referencia': f'ventas_por_dia/{ref.id}',
                    'detalle': f"Consumido por {grupo[0]['contexto']} (reconciliado)",
                })
            return plan

        try:
            plan = _tx(transaccion)
        except Exception as e:
            print(f'   [error] {ref.id}: {e}')
            continue
        if plan is None:
            continue
        aplicados += 1
        if plan['conjuntos'] or plan['planos']:
            hubo_cambio = True
        for _, motivo in plan['saltados']:
            saltados[motivo] += 1

    if hubo_cambio:
        db.collection('config').document('catalogo_meta').set(
            {'last_updated': ahora.strftime('%Y-%m-%dT%H:%M:%S%z')}, merge=True)
    print(f'\nListo: {aplicados} items marcados.' +
          (f" Saltados: {dict(saltados)}." if saltados else ''))


if __name__ == '__main__':
    main()
