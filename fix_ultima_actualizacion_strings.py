"""
Convierte los campos 'ultima_actualizacion' que estan guardados como STRING
(ej: '31/3/2026') a Timestamp real en las colecciones 'inventario' y 'catalogo'.

- Backup automatico en backup_ts_strings_YYYYMMDD_HHMMSS.json
- DRY-RUN por defecto. Pasa --ejecutar para escribir.

Por que: el listener filtrado con where('ultima_actualizacion','>', X) solo matchea
docs cuyo campo sea del mismo tipo que X (datetime). Strings quedan invisibles para
el listener y no se sincronizan en tiempo real.
"""
import sys, os, json, argparse
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(__file__))

import firebase_admin
from firebase_admin import credentials, firestore


def init_db():
    try:
        firebase_admin.get_app()
    except ValueError:
        cred = credentials.Certificate('firebase_key.json')
        firebase_admin.initialize_app(cred)
    return firestore.client()


def parse_to_datetime(raw):
    """Intenta parsear distintos formatos de fecha string a datetime UTC."""
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s:
        return None
    formatos = [
        '%Y-%m-%dT%H:%M:%S.%f%z',   # ISO con micro y tz
        '%Y-%m-%dT%H:%M:%S%z',       # ISO con tz
        '%Y-%m-%dT%H:%M:%S.%f',      # ISO sin tz
        '%Y-%m-%dT%H:%M:%S',         # ISO sin tz simple
        '%Y-%m-%d %H:%M:%S.%f%z',    # space-separated con micro y tz
        '%Y-%m-%d %H:%M:%S%z',       # space-separated con tz
        '%Y-%m-%d %H:%M:%S.%f',      # space-separated con micro
        '%Y-%m-%d %H:%M:%S',         # formato SQL
        '%d/%m/%Y %H:%M:%S',         # DD/MM/YYYY HH:MM:SS
        '%d/%m/%Y',                  # DD/MM/YYYY
        '%d/%m/%y',                  # DD/MM/YY
        '%Y-%m-%d',                  # YYYY-MM-DD
        '%d-%m-%Y',                  # DD-MM-YYYY
    ]
    for fmt in formatos:
        try:
            dt = datetime.strptime(s, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    return None


def procesar_coleccion(db, nombre_col):
    print(f"\n=== Coleccion '{nombre_col}' ===")
    docs = list(db.collection(nombre_col).stream())
    print(f"  Total docs: {len(docs)}")

    a_convertir = []
    sin_campo   = 0
    ya_ok       = 0
    no_parseable = []

    for d in docs:
        data = d.to_dict() or {}
        raw = data.get('ultima_actualizacion')
        if raw is None:
            sin_campo += 1
            continue
        if isinstance(raw, str):
            dt = parse_to_datetime(raw)
            if dt is None:
                no_parseable.append((d.id, raw))
            else:
                a_convertir.append({
                    'doc_id': d.id,
                    'nombre': data.get('nombre') or data.get('name') or '',
                    'antes':  raw,
                    'nuevo':  dt,
                })
        else:
            ya_ok += 1

    print(f"  Ya en formato correcto:    {ya_ok}")
    print(f"  Sin campo:                 {sin_campo}")
    print(f"  String parseable:          {len(a_convertir)}")
    print(f"  String NO parseable:       {len(no_parseable)}")
    if no_parseable[:5]:
        print(f"  Ejemplos no parseables:")
        for did, raw in no_parseable[:5]:
            print(f"    {did}: {raw!r}")

    return a_convertir, no_parseable


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ejecutar', action='store_true', help='Aplicar cambios reales')
    args = ap.parse_args()

    db = init_db()

    todos_cambios = {}
    for col in ('inventario', 'catalogo'):
        a_convertir, no_parseable = procesar_coleccion(db, col)
        todos_cambios[col] = {
            'a_convertir':  a_convertir,
            'no_parseable': no_parseable,
        }

    # Backup en JSON
    ts_label = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_file = f'backup_ts_strings_{ts_label}.json'
    backup_data = {
        col: {
            'a_convertir': [
                {'doc_id': x['doc_id'], 'nombre': x['nombre'], 'antes': x['antes'], 'nuevo_iso': x['nuevo'].isoformat()}
                for x in info['a_convertir']
            ],
            'no_parseable': [{'doc_id': did, 'raw': raw} for did, raw in info['no_parseable']],
        }
        for col, info in todos_cambios.items()
    }
    with open(backup_file, 'w', encoding='utf-8') as f:
        json.dump(backup_data, f, ensure_ascii=False, indent=2, default=str)
    print(f"\nBackup: {backup_file}")

    total_a_convertir = sum(len(info['a_convertir']) for info in todos_cambios.values())
    if total_a_convertir == 0:
        print("\nNo hay nada para convertir.")
        return

    print(f"\nTotal a convertir: {total_a_convertir} docs")

    if not args.ejecutar:
        print("[DRY-RUN] No se escribio nada. Para ejecutar: python fix_ultima_actualizacion_strings.py --ejecutar")
        return

    # Escribir
    BATCH = 400
    for col, info in todos_cambios.items():
        a_convertir = info['a_convertir']
        if not a_convertir:
            continue
        print(f"\nEscribiendo {col} ({len(a_convertir)} docs)...")
        col_ref = db.collection(col)
        total = 0
        for i in range(0, len(a_convertir), BATCH):
            chunk = a_convertir[i:i+BATCH]
            batch = db.batch()
            for x in chunk:
                ref = col_ref.document(x['doc_id'])
                batch.update(ref, {'ultima_actualizacion': x['nuevo']})
            batch.commit()
            total += len(chunk)
            print(f"  Batch {i//BATCH + 1}: {len(chunk)} (total {total})")

    print(f"\nLISTO. Backup en {backup_file}.")


if __name__ == '__main__':
    main()
