"""
Busca fotos candidatas para los productos de la tienda, por nombre.

Usa la API de Custom Search de Google en modo imagenes. Es la via oficial: se
consulta con una clave propia, devuelve la URL de la imagen y de que sitio
salio, y no rompe los terminos de nadie. Raspar los resultados de Google a mano
si los rompe, ademas de cortarse a las pocas consultas.

Por que hace falta revisar a mano lo que devuelve: el catalogo no tiene codigo
de barras real (7 productos de 2.315), asi que la unica forma de buscar es por
nombre. "ABROCHADORA MAPED VIVO N10" encuentra el producto exacto; "CONO DE HILO
2000MTS IMPORTADO" puede traer cualquier cosa. Por eso este script NO asigna
nada: junta candidatas y arma una pagina para que una persona elija. Una foto
equivocada llega al cliente y se transforma en una devolucion.

Configuracion (una vez):
  1. Google Cloud, mismo proyecto que Maps: habilitar "Custom Search API".
  2. https://programmablesearchengine.google.com  -> crear buscador,
     activar "Buscar en toda la web" y "Busqueda de imagenes".
     Anotar el ID del buscador (cx).
  3. Variables de entorno:
       GOOGLE_CSE_KEY=...     (clave de API)
       GOOGLE_CSE_CX=...      (ID del buscador)

    python scripts/buscar_fotos.py --cantidad 50
    python scripts/buscar_fotos.py --cantidad 200 --solo-con-marca
"""
import argparse
import json
import os
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import firebase_admin
from firebase_admin import credentials, firestore

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CANDIDATAS = os.path.join(RAIZ, 'fotos_candidatas.json')

# Sitios que no se consultan.
#
# Son otras librerias y marketplaces: sus fotos de producto son de ellos, no del
# fabricante. Tomarlas es copiarle el trabajo a un competidor, y ademas suelen
# tener el logo o la marca de agua de la tienda encima.
EXCLUIDOS = [
    'mercadolibre.com', 'mercadolibre.com.ar', 'mlstatic.com',
    'shopee.', 'aliexpress.', 'amazon.',
    'pinterest.', 'ebay.',
]


def conectar():
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(
            credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))
    return firestore.client()


def normalizar(t):
    s = unicodedata.normalize('NFD', str(t or '').lower())
    return ' '.join(''.join(c for c in s if unicodedata.category(c) != 'Mn').split())


def armar_consulta(producto):
    """
    La consulta se arma con marca + nombre, sacando lo que solo confunde.

    Los codigos internos ("C12-003", "353011") y las abreviaturas de packaging
    ("E/C", "X 1") no aparecen en ninguna pagina de fabricante y hacen que la
    busqueda no devuelva nada.
    """
    nombre = producto['nombre']
    for basura in (' E/C', ' X 1', ' X1', ' C/U', ' UNID', ' UND'):
        nombre = nombre.replace(basura, ' ')

    partes = [p for p in nombre.split() if len(p) > 1 and not p.isdigit()]
    consulta = ' '.join(partes[:8])

    marca = producto.get('marca') or ''
    if marca and normalizar(marca) not in normalizar(consulta):
        consulta = f'{marca} {consulta}'
    return consulta.strip()


def buscar(consulta, clave, cx, cantidad=6):
    """Una consulta a la API. Devuelve [] si falla, para no cortar el lote."""
    url = 'https://www.googleapis.com/customsearch/v1?' + urllib.parse.urlencode({
        'key': clave, 'cx': cx, 'q': consulta,
        'searchType': 'image', 'num': cantidad,
        'imgSize': 'medium', 'safe': 'active',
        'gl': 'ar', 'hl': 'es',
    })
    try:
        with urllib.request.urlopen(url, timeout=25) as r:
            datos = json.load(r)
    except urllib.error.HTTPError as e:
        cuerpo = e.read().decode('utf-8', 'replace')[:200]
        if e.code == 429:
            print('\n  Se acabo la cuota diaria de la API (100 consultas gratis por dia).')
            print('  Lo buscado hasta aca queda guardado; segui manana o activa facturacion.')
            raise SystemExit(1)
        print(f'    error HTTP {e.code}: {cuerpo}')
        return []
    except Exception as e:
        print(f'    error: {e}')
        return []

    salida = []
    for it in datos.get('items', []):
        origen = it.get('displayLink', '')
        if any(x in origen for x in EXCLUIDOS):
            continue
        salida.append({
            'url': it.get('link'),
            'miniatura': (it.get('image') or {}).get('thumbnailLink'),
            'origen': origen,
            'titulo': it.get('title', '')[:120],
            'ancho': (it.get('image') or {}).get('width'),
            'alto': (it.get('image') or {}).get('height'),
        })
    return salida


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cantidad', type=int, default=50,
                    help='cuantos productos buscar (por defecto 50)')
    ap.add_argument('--meses', type=int, default=4)
    ap.add_argument('--solo-con-marca', action='store_true',
                    help='solo los que tienen marca cargada: la busqueda acierta mucho mas')
    args = ap.parse_args()

    clave = os.environ.get('GOOGLE_CSE_KEY')
    cx = os.environ.get('GOOGLE_CSE_CX')
    if not clave or not cx:
        print(__doc__)
        sys.exit('Faltan GOOGLE_CSE_KEY y GOOGLE_CSE_CX en las variables de entorno.')

    db = conectar()

    # ── Priorizar por lo que se vende ─────────────────────────────────────
    desde = datetime.now(timezone.utc) - timedelta(days=args.meses * 30)
    importe = defaultdict(float)
    for d in db.collection('ventas_por_dia').where('fecha_dt', '>=', desde).stream():
        x = d.to_dict() or {}
        if x.get('deleted') is True:
            continue
        importe[normalizar(x.get('producto') or x.get('product_name'))] += \
            float(x.get('subtotal') or 0)

    nombre_original = {d.id: (d.to_dict() or {}).get('nombre') or ''
                       for d in db.collection('catalogo').select(['nombre']).stream()}

    productos = []
    for d in db.collection('tienda_productos').stream():
        x = d.to_dict() or {}
        if x.get('imagenes'):
            continue
        if args.solo_con_marca and not (x.get('marca') or '').strip():
            continue
        productos.append({
            'doc_id': d.id,
            'codigo': x.get('codigo') or d.id,
            'nombre': x.get('nombre') or '',
            'marca': (x.get('marca') or '').strip(),
            'rubro': x.get('rubro') or '',
            'importe': round(importe.get(normalizar(nombre_original.get(d.id, '')), 0)),
        })

    productos.sort(key=lambda p: -p['importe'])
    productos = productos[:args.cantidad]

    print(f'Buscando fotos para {len(productos)} productos.\n')

    # Se retoma lo ya buscado: la cuota diaria es de 100 consultas, asi que un
    # lote grande se hace en varios dias sin repetir nada.
    ya = {}
    if os.path.exists(CANDIDATAS):
        ya = {p['doc_id']: p for p in json.load(open(CANDIDATAS, encoding='utf-8'))}
        print(f'{len(ya)} productos ya buscados antes, se saltean.\n')

    resultados = list(ya.values())
    nuevos = 0

    for i, p in enumerate(productos, 1):
        if p['doc_id'] in ya:
            continue
        consulta = armar_consulta(p)
        print(f'[{i}/{len(productos)}] {p["nombre"][:48]:<50} <- {consulta[:44]}')

        candidatas = buscar(consulta, clave, cx)
        print(f'    {len(candidatas)} candidatas')

        p['consulta'] = consulta
        p['candidatas'] = candidatas
        resultados.append(p)
        nuevos += 1

        json.dump(resultados, open(CANDIDATAS, 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)
        time.sleep(0.4)  # no atropellar la API

    print(f'\n{nuevos} productos buscados. Total acumulado: {len(resultados)}')
    print(f'Guardado en {CANDIDATAS}')
    print('\nAhora abri scripts/revisar_fotos.html en el navegador para elegir cuales sirven.')


if __name__ == '__main__':
    main()
