"""
Historial de movimientos de stock de un producto, desde la terminal.

Contesta la pregunta de siempre: por qué el sistema dice 12 si en el mostrador
hay 10. Cada fila es una entrada o una salida con el antes, el después, quién la
hizo y desde qué PC.

    python diag_movimientos.py 987025
    python diag_movimientos.py "formulario moto 12"
    python diag_movimientos.py 987025 --dias 60
    python diag_movimientos.py --sospechosos

`--sospechosos` recorre el catálogo y marca los productos cuyo stock actual no
coincide con el que dejó su último movimiento: ahí hubo un cambio que no pasó por
el registro (una PC vieja, un script suelto) y es lo primero para mirar.

Solo lee. No escribe nada.
"""
import argparse
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

import firebase_admin
from firebase_admin import credentials, firestore

RAIZ = os.path.dirname(os.path.abspath(__file__))

MOTIVOS = {
    'venta': 'Venta', 'anulacion': 'Venta anulada', 'fiado': 'Cargado a fiado',
    'fiado_quitado': 'Quitado de un fiado', 'vinculacion': 'Consumido por otro',
    'edicion_manual': 'Editado a mano', 'reposicion': 'Reposición',
    'conteo': 'Ajuste por conteo', 'importacion': 'Importación',
    'variante': 'Variante / conjunto', 'correccion': 'Corrección de auditoría',
}


def conectar():
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(
            credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))
    return firestore.client()


def stock_que_manda(x):
    """El número de stock que vale para el producto.

    En un conjunto (packs, rollos, variedades) es `conjunto_total`: eso es lo que
    mueve la venta y lo que anota el historial. El campo `stock` de un conjunto es
    un espejo entero (floor del total) y compararlo daba falsos sospechosos: 730
    de 752 el 29-10.
    """
    if x.get('es_conjunto') and x.get('conjunto_total') is not None:
        return float(x.get('conjunto_total') or 0)
    return float(x.get('stock') or 0)


def _orden(doc_id, m):
    """Orden de los movimientos: por hora y, en empate, por el número de fila de la PC.

    Una venta de varios colores deja una fila por renglón con la MISMA hora; el id
    es `{pc_id}_{fila}` y comparado como texto ordena 9999 después de 10000. Sin
    esto se tomaba como "último" un renglón intermedio de la venta.
    """
    ts = m.get('ts') or datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)
    n = str(doc_id).rsplit('_', 1)[-1]
    return (ts, int(n) if n.isdigit() else 0)


def _anota_otra_escala(m):
    """Las filas de la migración del 28-08 anotaron el stock PLANO de un conjunto."""
    return str(m.get('detalle') or '').startswith('fix_stock_catalogo: descuadre')


def _solo_decimales(m, dif):
    """La PC guarda el stock entero (trunca al bajarlo de la nube), así que en lo
    que se vende por metro su historial anota sin decimales. Una diferencia menor
    a 1 contra un movimiento de una PC no es un cambio por afuera."""
    return m.get('origen') == 'pos' and abs(dif) < 1


def resolver_producto(db, termino):
    """Acepta el código exacto o un pedazo del nombre."""
    doc = db.collection('catalogo').document(termino).get()
    if doc.exists:
        x = doc.to_dict() or {}
        return doc.id, x

    t = termino.lower()
    candidatos = []
    for d in db.collection('catalogo').stream():
        x = d.to_dict() or {}
        if t in str(x.get('nombre') or '').lower():
            candidatos.append((d.id, x))
    if not candidatos:
        return None, None
    if len(candidatos) > 1:
        print(f'{len(candidatos)} productos coinciden con "{termino}":\n')
        for doc_id, x in candidatos[:15]:
            print(f'  {doc_id:<16} {str(x.get("nombre"))[:52]:<52} stock={x.get("stock")}')
        print('\nRepetí con el código exacto.')
        sys.exit(0)
    return candidatos[0]


def fmt_fecha(ts):
    if isinstance(ts, datetime.datetime):
        return ts.astimezone().strftime('%d/%m/%y %H:%M')
    return str(ts or '')[:16]


def historial(db, args):
    doc_id, prod = resolver_producto(db, args.producto)
    if not doc_id:
        print(f'No encontré ningún producto que coincida con "{args.producto}".')
        return

    print(f'\n{prod.get("nombre")}')
    print(f'código {doc_id} · stock hoy: {stock_que_manda(prod):g}'
          + (' (total del conjunto)' if prod.get('es_conjunto') else ''))
    print('─' * 100)

    q = db.collection('stock_movimientos').where(
        filter=firestore.FieldFilter('firebase_id', '==', str(doc_id)))
    pares = [(d.id, d.to_dict() or {}) for d in q.stream()]
    pares.sort(key=lambda par: _orden(*par))
    movs = [m for _, m in pares]

    if args.dias:
        corte = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=args.dias)
        movs = [m for m in movs if isinstance(m.get('ts'), datetime.datetime) and m['ts'] >= corte]

    if not movs:
        print('\nSin movimientos registrados.')
        print('El historial arranca desde que se instaló la versión que lo escribe;')
        print('lo anterior a eso no quedó guardado en ningún lado.')
        return

    print(f'{"Cuándo":<16}{"Motivo":<24}{"Cant.":>8}{"Quedó":>16}  Quién / dónde')
    print('─' * 100)
    for m in movs:
        cant = float(m.get('cantidad') or 0)
        antes, despues = m.get('stock_antes'), m.get('stock_despues')
        paso = f'{antes:g} → {despues:g}' if antes is not None and despues is not None else '—'
        quien = f'{m.get("usuario") or "?"} · {"panel" if m.get("origen") == "webapp" else (m.get("pc_id") or "POS")}'
        print(f'{fmt_fecha(m.get("ts")):<16}'
              f'{MOTIVOS.get(m.get("motivo"), m.get("motivo") or "?")[:23]:<24}'
              f'{cant:>+8g}{paso:>16}  {quien}')
        detalle = ' · '.join(x for x in (m.get('referencia'), m.get('detalle')) if x)
        if detalle:
            print(f'{"":<16}{detalle}')

    entradas = sum(float(m.get('cantidad') or 0) for m in movs if float(m.get('cantidad') or 0) > 0)
    salidas = sum(float(m.get('cantidad') or 0) for m in movs if float(m.get('cantidad') or 0) < 0)
    print('─' * 100)
    print(f'Entró: {entradas:+g} · salió: {salidas:+g} · neto: {entradas + salidas:+g}')

    validos = [m for m in movs if not _anota_otra_escala(m)]
    ultimo = validos[-1].get('stock_despues') if validos else None
    actual = stock_que_manda(prod)
    if ultimo is not None and abs(float(ultimo) - actual) > 0.001             and not _solo_decimales(validos[-1], actual - float(ultimo)):
        print(f'\nOJO: el último movimiento dejó {ultimo:g} y hoy el catálogo dice {actual}.')
        print('Ese salto no pasó por el registro — alguien lo cambió por afuera.')


def sospechosos(db, args):
    """Productos donde el stock actual no coincide con el último movimiento."""
    print('Leyendo movimientos...')
    ultimo_por_producto = {}
    for d in db.collection('stock_movimientos').stream():
        m = d.to_dict() or {}
        fid = str(m.get('firebase_id') or '')
        ts = m.get('ts')
        if not fid or not isinstance(ts, datetime.datetime) or _anota_otra_escala(m):
            continue
        clave = _orden(d.id, m)
        prev = ultimo_por_producto.get(fid)
        if prev is None or clave > prev[0]:
            ultimo_por_producto[fid] = (clave, m.get('stock_despues'), m)
    print(f'Productos con historial: {len(ultimo_por_producto)}')

    filas = []
    for d in db.collection('catalogo').stream():
        x = d.to_dict() or {}
        reg = ultimo_por_producto.get(d.id)
        if not reg or reg[1] is None:
            continue
        try:
            actual = stock_que_manda(x)
        except (TypeError, ValueError):
            continue
        dif = actual - float(reg[1])
        if abs(dif) > 0.001 and not _solo_decimales(reg[2], dif):
            filas.append((abs(dif), d.id, str(x.get('nombre'))[:44], float(reg[1]), actual, dif, reg[0][0]))

    filas.sort(reverse=True)
    print(f'\nCon el stock cambiado por fuera del registro: {len(filas)}\n')
    print(f'{"Producto":<46}{"Dejó":>8}{"Hoy":>8}{"Salto":>8}  Último movimiento')
    print('─' * 96)
    for f in filas[:30]:
        print(f'{f[2]:<46}{f[3]:>8g}{f[4]:>8g}{f[5]:>+8g}  {fmt_fecha(f[6])}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('producto', nargs='?', help='código exacto o parte del nombre')
    ap.add_argument('--dias', type=int, help='limitar a los últimos N días')
    ap.add_argument('--sospechosos', action='store_true',
                    help='productos cuyo stock no coincide con su último movimiento')
    args = ap.parse_args()

    db = conectar()
    if args.sospechosos:
        sospechosos(db, args)
    elif args.producto:
        historial(db, args)
    else:
        ap.print_help()


if __name__ == '__main__':
    main()
