"""
Ventana de alta para PCs nuevas.

El instalador es publico, asi que el secreto que lleva adentro tambien lo es:
cualquiera puede bajar el Setup y extraerlo. Por eso la Netlify Function no se
conforma con el secreto — solo entrega tokens a PCs cuyo `pc_id` ya figura en
la coleccion `pcs`, es decir maquinas que ya venian sincronizando.

Las 5 PCs actuales entran solas y para siempre: su pc_id vive en
%APPDATA%\\SistemaPOS\\machine_id.txt y sobrevive a las actualizaciones.

Para dar de alta una PC nueva hay que abrir una ventana temporal:

    python scripts/provisioning.py abrir --minutos 30
    (instalas el POS en la maquina nueva y lo abris una vez)
    python scripts/provisioning.py cerrar

Otros comandos:
    python scripts/provisioning.py estado
    python scripts/provisioning.py pcs
"""

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone

import firebase_admin
from firebase_admin import credentials, firestore

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_PATH = os.path.join(REPO_ROOT, "firebase_key.json")

DOC = ("control_config", "provisioning")


def init():
    if not os.path.exists(KEY_PATH):
        sys.exit(f"[ERROR] No se encontro {KEY_PATH}")
    firebase_admin.initialize_app(credentials.Certificate(KEY_PATH))
    return firestore.client()


def cmd_abrir(db, args):
    hasta = datetime.now(timezone.utc) + timedelta(minutes=args.minutos)
    db.collection(DOC[0]).document(DOC[1]).set(
        {"enrollment_open_until": hasta.isoformat()}, merge=True
    )
    local = hasta.astimezone(timezone(timedelta(hours=-3)))
    print(f"Ventana de alta abierta por {args.minutos} minutos.")
    print(f"Cierra a las {local.strftime('%H:%M:%S')} (hora Argentina).")
    print("\nAbri el POS en la PC nueva ahora. Despues corre:")
    print("  python scripts/provisioning.py cerrar")


def cmd_cerrar(db, _args):
    db.collection(DOC[0]).document(DOC[1]).set(
        {"enrollment_open_until": None}, merge=True
    )
    print("Ventana de alta cerrada. Solo las PCs ya conocidas reciben tokens.")


def cmd_estado(db, _args):
    snap = db.collection(DOC[0]).document(DOC[1]).get()
    valor = (snap.to_dict() or {}).get("enrollment_open_until") if snap.exists else None

    if not valor:
        print("Ventana de alta: CERRADA")
        return

    try:
        hasta = datetime.fromisoformat(str(valor))
    except ValueError:
        print(f"Ventana de alta: valor ilegible ({valor})")
        return

    if hasta.tzinfo is None:
        hasta = hasta.replace(tzinfo=timezone.utc)

    restante = (hasta - datetime.now(timezone.utc)).total_seconds()
    if restante <= 0:
        print("Ventana de alta: CERRADA (vencida)")
    else:
        print(f"Ventana de alta: ABIERTA, quedan {int(restante // 60)} min")


def cmd_pcs(db, _args):
    docs = list(db.collection("pcs").stream())
    if not docs:
        print("No hay PCs registradas.")
        return
    print(f"{len(docs)} PC(s) habilitadas para pedir tokens:\n")
    for d in docs:
        x = d.to_dict()
        print(f"  {x.get('hostname', '?')}")
        print(f"     pc_id      : {d.id}")
        print(f"     version    : {x.get('app_version', '?')}")
        print(f"     last_seen  : {str(x.get('last_seen', '?'))[:19]}\n")


def main():
    parser = argparse.ArgumentParser(description="Alta de PCs nuevas en el POS")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("abrir", help="Abrir ventana de alta")
    p.add_argument("--minutos", type=int, default=30)
    p.set_defaults(func=cmd_abrir)

    sub.add_parser("cerrar", help="Cerrar ventana").set_defaults(func=cmd_cerrar)
    sub.add_parser("estado", help="Ver estado").set_defaults(func=cmd_estado)
    sub.add_parser("pcs", help="Listar PCs habilitadas").set_defaults(func=cmd_pcs)

    args = parser.parse_args()
    db = init()
    args.func(db, args)


if __name__ == "__main__":
    main()
