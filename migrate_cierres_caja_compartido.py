"""
Migracion one-shot: pasa cierres_caja del esquema per-PC al esquema compartido.

ANTES (per-PC, 1 doc por PC por caja):
  cierres_caja/DESKTOPS-xxx_15
  cierres_caja/DESKTOPT-yyy_15
  cierres_caja/DESKTOPU-zzz_15

DESPUES (compartido, 1 doc por caja):
  cierres_caja/15

Solo migra cajas ABIERTAS (sin fecha_cierre). Los cierres historicos quedan intactos.

Correr UNA VEZ despues de actualizar el POS en todas las PCs con el codigo nuevo.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

import firebase_admin
from firebase_admin import credentials, firestore
from datetime import datetime, timezone, timedelta

AR_TZ = timezone(timedelta(hours=-3))


def to_dt(val):
    if not val:
        return None
    if isinstance(val, datetime):
        if val.tzinfo is None:
            val = val.replace(tzinfo=timezone.utc)
        return val.astimezone(AR_TZ)
    if isinstance(val, str) and val:
        try:
            s = val.replace('Z', '+00:00')
            d = datetime.fromisoformat(s)
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
            return d.astimezone(AR_TZ)
        except Exception:
            return None
    return None


def main():
    try:
        firebase_admin.get_app()
    except ValueError:
        cred = credentials.Certificate('firebase_key.json')
        firebase_admin.initialize_app(cred)
    db = firestore.client()

    print("Leyendo cierres_caja...")
    docs = list(db.collection('cierres_caja').stream())

    abiertas_per_pc = []   # docs viejos formato pc_id_id, abiertos
    abiertas_compartidas = {}  # register_id -> doc nuevo (ya migrado o creado por codigo nuevo)

    for d in docs:
        data = d.to_dict() or {}
        fc = data.get('fecha_cierre')
        if fc:
            continue  # ya cerrada, no tocar
        rid = data.get('register_id')
        if rid is None:
            continue
        if '_' in d.id:
            # formato viejo: pc_id_register_id
            abiertas_per_pc.append((d.id, data, rid))
        else:
            # formato nuevo: solo register_id
            abiertas_compartidas[str(rid)] = (d.id, data)

    print(f"Per-PC abiertas: {len(abiertas_per_pc)}")
    print(f"Compartidas abiertas: {len(abiertas_compartidas)}\n")

    if not abiertas_per_pc:
        print("Nada para migrar.")
        return

    # Agrupar per-PC por register_id
    grupos = {}
    for doc_id, data, rid in abiertas_per_pc:
        key = str(rid)
        grupos.setdefault(key, []).append((doc_id, data))

    print(f"Cajas a consolidar: {len(grupos)}\n")
    print("=" * 70)
    for rid, items in grupos.items():
        print(f"register_id={rid}  ({len(items)} doc(s) per-PC):")
        for doc_id, _ in items:
            print(f"  - {doc_id}")
        if rid in abiertas_compartidas:
            print(f"  (ya existe doc compartido: {abiertas_compartidas[rid][0]})")
        print()

    confirm = input("Consolidar y borrar los docs per-PC? [s/N]: ").strip().lower()
    if confirm != 's':
        print("Cancelado.")
        return

    for rid, items in grupos.items():
        # Tomar como base el doc compartido si ya existe, sino el primero per-PC
        if rid in abiertas_compartidas:
            base_id, base_data = abiertas_compartidas[rid]
            consolidated = dict(base_data)
        else:
            base_id = None
            base_data = items[0][1]
            consolidated = dict(base_data)

        # Apertura mas temprana
        ap_min = to_dt(consolidated.get('fecha_apertura'))
        cajeros = set()
        if consolidated.get('cajero'):
            for c in str(consolidated['cajero']).split(','):
                c = c.strip()
                if c:
                    cajeros.add(c)
        retiros = list(consolidated.get('retiros') or [])
        total_retiros = float(consolidated.get('total_retiros', 0) or 0)
        monto_inicial = float(consolidated.get('monto_inicial', 0) or 0)

        for doc_id, data in items:
            ap = to_dt(data.get('fecha_apertura'))
            if ap and (not ap_min or ap < ap_min):
                ap_min = ap
                consolidated['fecha_apertura'] = data.get('fecha_apertura')
            if data.get('cajero'):
                for c in str(data['cajero']).split(','):
                    c = c.strip()
                    if c:
                        cajeros.add(c)
            for r in (data.get('retiros') or []):
                retiros.append(r)
            total_retiros += float(data.get('total_retiros', 0) or 0)
            if not monto_inicial:
                monto_inicial = float(data.get('monto_inicial', 0) or 0)

        consolidated['cajero'] = ', '.join(sorted(cajeros)) if cajeros else ''
        consolidated['retiros'] = retiros
        consolidated['total_retiros'] = total_retiros
        consolidated['monto_inicial'] = monto_inicial
        consolidated['register_id'] = int(rid)
        consolidated['fecha_cierre'] = ''  # asegurar abierta
        consolidated.pop('pc_id', None)    # ya no aplica al compartido

        # Escribir doc compartido
        db.collection('cierres_caja').document(rid).set(consolidated, merge=True)
        print(f"  OK escrito cierres_caja/{rid}")

        # Borrar los per-PC
        for doc_id, _ in items:
            db.collection('cierres_caja').document(doc_id).delete()
            print(f"     borrado {doc_id}")

    print("\nMigracion completada.")
    print("La webapp ahora va a mostrar 1 sola tarjeta de Caja Abierta por register_id.")


if __name__ == '__main__':
    main()
