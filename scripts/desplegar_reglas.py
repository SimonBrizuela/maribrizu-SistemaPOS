"""
Publica firestore.rules usando la cuenta de servicio.

    python scripts/desplegar_reglas.py --simular   # compila y no publica
    python scripts/desplegar_reglas.py             # compila y publica

Existe porque el CLI de Firebase pide una sesion interactiva (`firebase login`)
que en esta maquina vence cada tanto, e ignora GOOGLE_APPLICATION_CREDENTIALS.
La API de reglas acepta la misma cuenta de servicio que ya usa todo el resto de
los scripts.

Antes de publicar guarda las reglas que estan vivas en
`reglas_anteriores.rules`. Publicar reglas equivocadas puede abrir la base o
dejar afuera a las PCs del local: tiene que haber una vuelta atras de un
comando.

    python scripts/desplegar_reglas.py --volver
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

from google.oauth2 import service_account
from google.auth.transport.requests import Request

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROYECTO = 'mari-d7c71'
API = 'https://firebaserules.googleapis.com/v1'
RESPALDO = os.path.join(RAIZ, 'reglas_anteriores.rules')


def token():
    clave = os.path.join(RAIZ, 'firebase_key.json')
    if not os.path.exists(clave):
        sys.exit(f'Falta {clave}')
    credenciales = service_account.Credentials.from_service_account_file(
        clave, scopes=['https://www.googleapis.com/auth/cloud-platform'])
    credenciales.refresh(Request())
    return credenciales.token


def pedir(metodo, url, cuerpo=None, tk=None):
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    pedido = urllib.request.Request(url, data=datos, method=metodo, headers={
        'Authorization': f'Bearer {tk}',
        'Content-Type': 'application/json',
    })
    try:
        with urllib.request.urlopen(pedido) as respuesta:
            return respuesta.status, json.loads(respuesta.read() or b'{}')
    except urllib.error.HTTPError as err:
        cuerpo_error = err.read().decode('utf-8', 'replace')
        try:
            return err.code, json.loads(cuerpo_error)
        except json.JSONDecodeError:
            return err.code, {'error': cuerpo_error[:500]}


def release_actual(tk):
    codigo, datos = pedir('GET', f'{API}/projects/{PROYECTO}/releases/cloud.firestore', tk=tk)
    return datos.get('rulesetName') if codigo == 200 else None


def fuente_de(nombre, tk):
    codigo, datos = pedir('GET', f'{API}/{nombre}', tk=tk)
    if codigo != 200:
        return None
    archivos = datos.get('source', {}).get('files', [])
    return archivos[0].get('content') if archivos else None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--simular', action='store_true', help='compila y no publica')
    ap.add_argument('--volver', action='store_true', help='restaura el respaldo')
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

    tk = token()

    if args.volver:
        if not os.path.exists(RESPALDO):
            sys.exit(f'No hay respaldo en {RESPALDO}')
        with open(RESPALDO, encoding='utf-8') as f:
            fuente = f.read()
        print(f'Restaurando {RESPALDO}...')
    else:
        with open(os.path.join(RAIZ, 'firestore.rules'), encoding='utf-8') as f:
            fuente = f.read()

        # Respaldo de lo que esta vivo, antes de tocar nada.
        actual = release_actual(tk)
        if actual:
            viejo = fuente_de(actual, tk)
            if viejo:
                with open(RESPALDO, 'w', encoding='utf-8', newline='\n') as f:
                    f.write(viejo)
                print(f'Reglas actuales guardadas en {RESPALDO}')
                print(f'  ({actual.split("/")[-1]})')

    # ── Compilar ──────────────────────────────────────────────────────────
    print('\nCompilando...')
    codigo, datos = pedir('POST', f'{API}/projects/{PROYECTO}/rulesets', {
        'source': {'files': [{'name': 'firestore.rules', 'content': fuente}]},
    }, tk)

    if codigo != 200:
        problemas = datos.get('error', {})
        print('\nNo compila:')
        for d in (problemas.get('details') or [{'message': problemas.get('message', datos)}]):
            for issue in (d.get('issues') or [d]):
                lugar = issue.get('sourcePosition', {})
                donde = f" (línea {lugar.get('line')})" if lugar.get('line') else ''
                print(f"  · {issue.get('description') or issue.get('message')}{donde}")
        sys.exit(1)

    ruleset = datos['name']
    print(f'  compila bien · {ruleset.split("/")[-1]}')

    if args.simular:
        print('\n(simulación: no se publicó nada)')
        return

    # ── Publicar ──────────────────────────────────────────────────────────
    print('Publicando...')
    codigo, datos = pedir('PATCH',
                          f'{API}/projects/{PROYECTO}/releases/cloud.firestore',
                          {'release': {
                              'name': f'projects/{PROYECTO}/releases/cloud.firestore',
                              'rulesetName': ruleset,
                          }}, tk)

    if codigo != 200:
        print(f'\nNo se pudo publicar ({codigo}):')
        print(json.dumps(datos, ensure_ascii=False, indent=1)[:800])
        sys.exit(1)

    print('\nListo: las reglas nuevas están vivas.')
    print('Verificalas con `python scripts/probar_tienda.py`.')
    if not args.volver:
        print('Para volver atrás: `python scripts/desplegar_reglas.py --volver`')


if __name__ == '__main__':
    main()
