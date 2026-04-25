"""
Asigna nuevos codigos secuenciales (codigo == cod_barra) a productos cuyo nombre empieza con 'A'.
- Backup automatico en backup_codigos_A_YYYYMMDD_HHMMSS.json
- DRY-RUN por defecto: muestra los cambios pero NO escribe.
- Pasa --ejecutar para escribir realmente en Firebase.
- Codigos: 1000001..1000999 (7 digitos numericos), por orden alfabetico de 'nombre'.
"""
import sys, os, json, argparse
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(__file__))

import firebase_admin
from firebase_admin import credentials, firestore

CODIGO_INICIO = 1000001  # primer codigo asignado a la primer 'A'


def init_db():
    try:
        firebase_admin.get_app()
    except ValueError:
        cred = credentials.Certificate('firebase_key.json')
        firebase_admin.initialize_app(cred)
    return firestore.client()


def primera_letra(nombre):
    n = (nombre or '').strip()
    if not n:
        return ''
    import unicodedata
    c = unicodedata.normalize('NFD', n[0])
    c = ''.join(ch for ch in c if unicodedata.category(ch) != 'Mn')
    return c.upper()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ejecutar', action='store_true', help='Escribir cambios reales (sin esto, dry-run)')
    args = ap.parse_args()

    db = init_db()

    print("Leyendo coleccion 'catalogo'...")
    docs = list(db.collection('catalogo').stream())
    print(f"  Total documentos: {len(docs)}")

    productos_a = []
    for d in docs:
        data = d.to_dict()
        if primera_letra(data.get('nombre')) == 'A':
            data['_doc_id'] = d.id
            productos_a.append(data)

    productos_a.sort(key=lambda x: (x.get('nombre') or '').upper())
    print(f"  Productos que empiezan con 'A': {len(productos_a)}")

    if not productos_a:
        print("Nada para procesar.")
        return

    # Backup
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_file = f'backup_codigos_A_{ts}.json'
    backup = []
    for p in productos_a:
        backup.append({
            'doc_id':         p['_doc_id'],
            'nombre':         p.get('nombre'),
            'codigo_anterior':    p.get('codigo'),
            'cod_barra_anterior': p.get('cod_barra'),
        })
    with open(backup_file, 'w', encoding='utf-8') as f:
        json.dump(backup, f, ensure_ascii=False, indent=2)
    print(f"  Backup guardado en: {backup_file}")

    # Asignar nuevos codigos
    plan = []
    for i, p in enumerate(productos_a):
        nuevo = str(CODIGO_INICIO + i)
        plan.append({
            'doc_id':   p['_doc_id'],
            'nombre':   p.get('nombre'),
            'codigo_anterior':    p.get('codigo') or '',
            'cod_barra_anterior': p.get('cod_barra') or '',
            'codigo_nuevo': nuevo,
        })

    print(f"\nRango de codigos a asignar: {plan[0]['codigo_nuevo']} -> {plan[-1]['codigo_nuevo']}")
    print("\nPrimeros 10:")
    for p in plan[:10]:
        print(f"  {p['codigo_nuevo']}  | {p['nombre']:50s} | antes: codigo={p['codigo_anterior']!r:20s} cod_barra={p['cod_barra_anterior']!r}")
    print("Ultimos 5:")
    for p in plan[-5:]:
        print(f"  {p['codigo_nuevo']}  | {p['nombre']:50s} | antes: codigo={p['codigo_anterior']!r:20s} cod_barra={p['cod_barra_anterior']!r}")

    if not args.ejecutar:
        print("\n[DRY-RUN] No se escribio nada. Revisa el backup y el plan.")
        print("         Para ejecutar: python migrate_codigos_A.py --ejecutar")
        return

    # Verificar duplicados con productos NO-A
    print("\nVerificando que los nuevos codigos no choquen con otros productos...")
    nuevos_set = {p['codigo_nuevo'] for p in plan}
    conflictos = []
    for d in docs:
        data = d.to_dict()
        if primera_letra(data.get('nombre')) == 'A':
            continue
        cod  = str(data.get('codigo') or '')
        barra= str(data.get('cod_barra') or '')
        if cod in nuevos_set:
            conflictos.append((d.id, data.get('nombre'), 'codigo', cod))
        if barra in nuevos_set:
            conflictos.append((d.id, data.get('nombre'), 'cod_barra', barra))
    if conflictos:
        print(f"  ATENCION: {len(conflictos)} conflictos con productos NO-A:")
        for c in conflictos[:20]:
            print(f"    - {c}")
        print("\nAbortando para no romper productos ajenos. Cambia CODIGO_INICIO o resolve conflictos.")
        return
    print("  OK, sin conflictos.")

    # Escribir
    ts_fb = datetime.now(timezone.utc)
    BATCH = 400
    col = db.collection('catalogo')
    total = 0
    for i in range(0, len(plan), BATCH):
        chunk = plan[i:i+BATCH]
        b = db.batch()
        for p in chunk:
            ref = col.document(p['doc_id'])
            b.update(ref, {
                'codigo':              p['codigo_nuevo'],
                'cod_barra':           p['codigo_nuevo'],
                'ultima_actualizacion': ts_fb,
            })
        b.commit()
        total += len(chunk)
        print(f"  Batch {i//BATCH + 1}: {len(chunk)} actualizados (total {total})")

    # Tocar catalogo_meta para que el delta_sync del POS detecte los cambios
    db.collection('config').document('catalogo_meta').set(
        {'last_updated': datetime.now(timezone.utc).isoformat()},
        merge=True,
    )

    print(f"\nLISTO: {total} productos 'A' con nuevo codigo unificado en catalogo.")
    print(f"catalogo_meta tocado — el POS va a sincronizar al proximo arranque.")
    print(f"Backup en: {backup_file} (por si necesitas revertir).")


if __name__ == '__main__':
    main()
