"""
Qué hay en la góndola que la tienda online no está mostrando.

Recorre el catálogo y, para cada producto CON stock, pregunta por qué no está
publicado. No reimplementa la regla: importa `se_publica()` de
`scripts/sync_tienda.py`, que es la misma que corre el sync (y gemela de
`motivoDeNoPublicar()` en la webapp). Si la regla cambia, este diagnóstico
cambia con ella.

    python diag_tienda_faltantes.py
    python diag_tienda_faltantes.py --csv faltan_en_la_tienda.csv
    python diag_tienda_faltantes.py --motivo "sin foto"

Solo lee. No escribe nada.
"""
import argparse
import collections
import csv
import os
import sys

RAIZ = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, RAIZ)
sys.path.insert(0, os.path.join(RAIZ, 'scripts'))
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

from scripts.sync_tienda import conectar, medidas_de, se_publica


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv')
    ap.add_argument('--motivo', help='listar solo los de este motivo')
    args = ap.parse_args()

    db = conectar()

    # Misma fuente que lee el sync: si esto se saca de otro lado, el
    # diagnóstico miente y culpa al rubro de todo.
    cfg = db.collection('tienda_config').document('publicacion').get()
    datos_cfg = cfg.to_dict() if cfg.exists else {}
    rubros_habilitados = {str(r).strip().upper()
                          for r in (datos_cfg.get('rubros') or [])}
    subrubros_excluidos = {
        str(rubro).strip().upper(): {str(s).strip().upper() for s in (subs or [])}
        for rubro, subs in (datos_cfg.get('subrubros_excluidos') or {}).items()
    }

    print(f'Rubros publicados: {", ".join(sorted(rubros_habilitados)) or "ninguno"}')

    print('Leyendo el espejo de la tienda...')
    en_tienda = {d.id for d in db.collection('tienda_productos').stream()}

    print('Leyendo catálogo...')
    motivos = collections.Counter()
    plata_parada = collections.Counter()
    filas = []
    con_stock = 0

    for d in db.collection('catalogo').stream():
        x = d.to_dict() or {}
        stock = medidas_de(x)['stock']
        if stock <= 0:
            continue
        con_stock += 1
        if d.id in en_tienda:
            continue

        ok, motivo = se_publica(x, rubros_habilitados, subrubros_excluidos)
        if ok:
            # Pasa la regla y aun así no está: el sync no corrió desde que se
            # cargó, o falló en ese producto.
            motivo = 'deberia estar (falta correr el sync)'
        try:
            precio = float(x.get('precio_venta') or 0)
        except (TypeError, ValueError):
            precio = 0.0

        motivos[motivo] += 1
        plata_parada[motivo] += precio * stock
        filas.append({
            'doc_id': d.id, 'nombre': x.get('nombre') or '',
            'rubro': x.get('rubro') or '', 'sub_rubro': x.get('sub_rubro') or '',
            'stock': stock, 'precio': precio,
            'valor_en_gondola': round(precio * stock, 2),
            'motivo': motivo,
        })

    faltan = len(filas)
    print(f'\nCon stock en el catálogo: {con_stock}')
    print(f'Publicados en la tienda:  {con_stock - faltan}')
    print(f'CON STOCK Y SIN PUBLICAR: {faltan}\n')

    print(f'{"Motivo":<44}{"Productos":>10}{"Valor en góndola":>20}')
    print('─' * 74)
    for motivo, cant in motivos.most_common():
        print(f'{motivo[:44]:<44}{cant:>10}{plata_parada[motivo]:>20,.0f}')

    if args.motivo:
        elegidos = [f for f in filas if args.motivo.lower() in f['motivo'].lower()]
        elegidos.sort(key=lambda f: -f['valor_en_gondola'])
        print(f'\nLos 30 más caros de "{args.motivo}":\n')
        print(f'{"Producto":<46}{"Rubro":<14}{"Stock":>7}{"Valor":>12}')
        print('─' * 80)
        for f in elegidos[:30]:
            print(f'{f["nombre"][:46]:<46}{f["rubro"][:14]:<14}'
                  f'{f["stock"]:>7,.0f}{f["valor_en_gondola"]:>12,.0f}')

    if args.csv and filas:
        filas.sort(key=lambda f: -f['valor_en_gondola'])
        with open(args.csv, 'w', newline='', encoding='utf-8-sig') as fh:
            w = csv.DictWriter(fh, fieldnames=list(filas[0].keys()))
            w.writeheader()
            w.writerows(filas)
        print(f'\nDetalle completo en {args.csv}')


if __name__ == '__main__':
    main()
