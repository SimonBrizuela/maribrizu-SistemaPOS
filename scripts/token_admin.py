"""Imprime un token a medida para entrar a Firestore con las reglas de la webapp.

Sirve para correr codigo de la webapp (el mismo, sin copiarlo) contra la base de
produccion desde la terminal: el token lleva el claim `admin`, asi que pasa las
mismas reglas que el panel y no hace falta el Admin SDK del otro lado.

    python scripts/token_admin.py programacion@brizuela.org > token.txt

El token dura una hora y no se guarda en ningun lado: se imprime y listo.
"""
import os
import sys

import firebase_admin
from firebase_admin import auth, credentials

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_PATH = os.path.join(REPO_ROOT, "firebase_key.json")


def main():
    if len(sys.argv) != 2:
        sys.exit("Uso: python scripts/token_admin.py <email>")
    email = sys.argv[1]

    if not os.path.exists(KEY_PATH):
        sys.exit(f"[ERROR] No se encontro {KEY_PATH}")
    firebase_admin.initialize_app(credentials.Certificate(KEY_PATH))

    try:
        user = auth.get_user_by_email(email)
    except auth.UserNotFoundError:
        sys.exit(f"[ERROR] No existe la cuenta {email}")

    claims = user.custom_claims or {}
    if not claims.get("admin"):
        sys.exit(f"[ERROR] {email} no es admin: el token no pasaria las reglas")

    token = auth.create_custom_token(user.uid, {"admin": True})
    print(token.decode("utf-8") if isinstance(token, bytes) else token)


if __name__ == "__main__":
    main()
