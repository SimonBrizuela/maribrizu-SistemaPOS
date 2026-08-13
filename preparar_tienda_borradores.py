"""
Deja listos, pero apagados, los productos que todavía no salen a la tienda.

El caso: hay 497 productos con stock que no se publican porque su rubro está
apagado en el panel (ACCESORIOS, COTILLÓN, LENCERÍA, TELGOPOR, NAVIDAD,
SERVICIOS). Están armados y se venden en el mostrador, pero la vidriera no los
muestra.

Este script les arma la ficha exactamente igual que el sync —misma función
`armar_documento`, mismos precios, packs, mínimos y fotos— y la guarda en
`tienda_borradores`. La tienda NO lee esa colección: nadie los ve hasta que se
decida prender el rubro.

Por qué una colección aparte y no un `activo: false` en `tienda_productos`: la
vidriera consulta ese espejo de ocho formas distintas (por rubro, por
destacados, por tokens, por prefijo del nombre). Agregarle un filtro obliga a
recrear los índices compuestos de cada una, y hasta que Firestore termina de
construirlos las consultas fallan y la tienda queda en blanco.

    python preparar_tienda_borradores.py            # simula
    python preparar_tienda_borradores.py --aplicar

Para activarlos después: prender el rubro en el panel y correr
`python scripts/sync_tienda.py`. El sync los publica de verdad y el borrador
queda obsoleto (se puede volver a correr esto para limpiarlo).
"""
import argparse
import collections
import os
import sys

RAIZ = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, RAIZ)
sys.path.insert(0, os.path.join(RAIZ, 'scripts'))
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

from scripts.sync_tienda import (
    conectar, armar_documento, medidas_de, se_publica,
)

# Un servicio del mostrador (fotocopia, anillado, plastificado) no es un
# producto que se pueda despachar: no tiene sentido ni como borrador.
RUBROS_QUE_NO_VAN = {'SERVICIOS'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--aplicar', action='store_true')
    args = ap.parse_args()

    db = conectar()

    cfg = db.collection('tienda_config').document('publicacion').get()
    datos_cfg = cfg.to_dict() if cfg.exists else {}
    rubros_habilitados = {str(r).strip().upper()
                          for r in (datos_cfg.get('rubros') or [])}
    subrubros_excluidos = {
        str(rubro).strip().upper(): {str(s).strip().upper() for s in (subs or [])}
        for rubro, subs in (datos_cfg.get('subrubros_excluidos') or {}).items()
    }

    print(f'Rubros ya publicados: {", ".join(sorted(rubros_habilitados))}\n')
    print('Leyendo catálogo...')

    borradores = []
    por_rubro = collections.Counter()
    for d in db.collection('catalogo').stream():
        x = d.to_dict() or {}
        if medidas_de(x)['stock'] <= 0:
            continue
        ok, motivo = se_publica(x, rubros_habilitados, subrubros_excluidos)
        if ok:
            continue                       # ya sale por el sync normal
        if motivo != 'rubro no habilitado':
            continue                       # sin precio, inactivo, excluido a mano
        rubro = str(x.get('rubro') or '').strip().upper()
        if rubro in RUBROS_QUE_NO_VAN:
            continue

        doc = armar_documento(d.id, x)
        if not doc:
            continue
        doc['activo'] = False
        doc['motivo_apagado'] = 'rubro no habilitado'
        borradores.append((d.id, doc))
        por_rubro[rubro or 'SIN RUBRO'] += 1

    print(f'\nFichas listas para publicar: {len(borradores)}\n')
    print(f'{"Rubro":<20}{"Productos":>10}')
    print('─' * 30)
    for rubro, cant in por_rubro.most_common():
        print(f'{rubro:<20}{cant:>10}')

    if not args.aplicar:
        print('\n(simulación: no se escribió nada)')
        return

    print('\nEscribiendo en tienda_borradores...')
    col = db.collection('tienda_borradores')
    batch = db.batch()
    n = 0
    for doc_id, doc in borradores:
        batch.set(col.document(doc_id), doc)
        n += 1
        if n % 400 == 0:
            batch.commit()
            batch = db.batch()
            print(f'  {n} escritos...')
    if n % 400:
        batch.commit()

    # Sacar los borradores de productos que mientras tanto se publicaron.
    publicados = {d.id for d in db.collection('tienda_productos').stream()}
    vivos = {doc_id for doc_id, _ in borradores}
    sobran = [d.id for d in col.stream()
              if d.id not in vivos or d.id in publicados]
    if sobran:
        batch = db.batch()
        for i, doc_id in enumerate(sobran, 1):
            batch.delete(col.document(doc_id))
            if i % 400 == 0:
                batch.commit()
                batch = db.batch()
        batch.commit()

    print(f'\nListo: {n} fichas guardadas, {len(sobran)} borradas por obsoletas.')
    print('La tienda no las muestra. Para activarlas: prender el rubro en el '
          'panel y correr scripts/sync_tienda.py')


if __name__ == '__main__':
    main()
