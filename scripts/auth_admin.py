"""
Administracion de cuentas de la webapp (Firebase Auth).

Las reglas de Firestore (firestore.rules) distinguen dos niveles:
  - signedIn()  -> cualquier cuenta valida: catalogo, stock, presupuestos.
  - isAdmin()   -> custom claim `admin`: terminal remota, perfiles ARCA,
                   cierres de caja, gastos y configuracion.

El claim `admin` solo se puede setear desde aca (Admin SDK). No hay forma de
que el cliente se lo asigne a si mismo: viaja firmado dentro del ID token.

Uso:
    python scripts/auth_admin.py list
    python scripts/auth_admin.py create <email> --nombre "Simon" --admin
    python scripts/auth_admin.py promote <email>
    python scripts/auth_admin.py demote  <email>
    python scripts/auth_admin.py reset   <email>
    python scripts/auth_admin.py disable <email>

`create` no fija una contrasena: genera un enlace de un solo uso para que la
persona elija la suya. Asi la contrasena nunca pasa por la consola ni queda en
el historial de comandos.
"""

import argparse
import os
import secrets
import sys

import firebase_admin
from firebase_admin import auth, credentials

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_PATH = os.path.join(REPO_ROOT, "firebase_key.json")


def init():
    if not os.path.exists(KEY_PATH):
        sys.exit(f"[ERROR] No se encontro {KEY_PATH}")
    firebase_admin.initialize_app(credentials.Certificate(KEY_PATH))


def find_user(email):
    try:
        return auth.get_user_by_email(email)
    except auth.UserNotFoundError:
        return None


def cmd_list(_args):
    users = list(auth.list_users().iterate_all())
    if not users:
        print("No hay cuentas creadas.")
        return
    print(f"{len(users)} cuenta(s):\n")
    for u in users:
        rol = "admin" if (u.custom_claims or {}).get("admin") else "operativo"
        estado = "DESHABILITADA" if u.disabled else "activa"
        print(f"  {u.email}")
        print(f"     nombre : {u.display_name or '-'}")
        print(f"     rol    : {rol}")
        print(f"     estado : {estado}")
        print(f"     uid    : {u.uid}\n")


def cmd_create(args):
    if find_user(args.email):
        sys.exit(f"[ERROR] Ya existe una cuenta con {args.email}. "
                 f"Usa 'promote' o 'reset'.")

    # Contrasena temporal aleatoria que nadie llega a usar: se descarta apenas
    # la persona abre el enlace y elige la suya.
    user = auth.create_user(
        email=args.email,
        email_verified=False,
        password=secrets.token_urlsafe(32),
        display_name=args.nombre or args.email.split("@")[0],
        disabled=False,
    )

    if args.admin:
        auth.set_custom_user_claims(user.uid, {"admin": True})

    link = auth.generate_password_reset_link(args.email)

    print(f"Cuenta creada: {args.email}")
    print(f"  rol: {'admin' if args.admin else 'operativo'}")
    print(f"  uid: {user.uid}\n")
    print("Enlace para que elija su contrasena (vence en 1 hora):\n")
    print(f"  {link}\n")


def cmd_promote(args):
    user = find_user(args.email)
    if not user:
        sys.exit(f"[ERROR] No existe {args.email}")
    auth.set_custom_user_claims(user.uid, {"admin": True})
    # Fuerza a que el navegador pida un token nuevo: el claim viejo seguiria
    # vigente hasta una hora si no se revoca.
    auth.revoke_refresh_tokens(user.uid)
    print(f"{args.email} ahora es admin. Debe volver a iniciar sesion.")


def cmd_demote(args):
    user = find_user(args.email)
    if not user:
        sys.exit(f"[ERROR] No existe {args.email}")
    auth.set_custom_user_claims(user.uid, {"admin": False})
    auth.revoke_refresh_tokens(user.uid)
    print(f"{args.email} pasa a operativo. Debe volver a iniciar sesion.")


def cmd_reset(args):
    if not find_user(args.email):
        sys.exit(f"[ERROR] No existe {args.email}")
    print("Enlace para restablecer la contrasena (vence en 1 hora):\n")
    print(f"  {auth.generate_password_reset_link(args.email)}\n")


def cmd_disable(args):
    user = find_user(args.email)
    if not user:
        sys.exit(f"[ERROR] No existe {args.email}")
    auth.update_user(user.uid, disabled=True)
    auth.revoke_refresh_tokens(user.uid)
    print(f"{args.email} deshabilitada y sesiones cerradas.")


def main():
    parser = argparse.ArgumentParser(description="Cuentas de la webapp POS")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="Listar cuentas").set_defaults(func=cmd_list)

    p = sub.add_parser("create", help="Crear cuenta")
    p.add_argument("email")
    p.add_argument("--nombre", default=None)
    p.add_argument("--admin", action="store_true", help="Otorgar el claim admin")
    p.set_defaults(func=cmd_create)

    for name, fn, helptext in (
        ("promote", cmd_promote, "Dar el claim admin"),
        ("demote",  cmd_demote,  "Quitar el claim admin"),
        ("reset",   cmd_reset,   "Generar enlace de nueva contrasena"),
        ("disable", cmd_disable, "Deshabilitar la cuenta"),
    ):
        sp = sub.add_parser(name, help=helptext)
        sp.add_argument("email")
        sp.set_defaults(func=fn)

    args = parser.parse_args()
    init()
    args.func(args)


if __name__ == "__main__":
    main()
