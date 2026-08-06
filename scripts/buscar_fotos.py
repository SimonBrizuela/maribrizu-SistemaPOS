"""
Busca fotos candidatas para los productos de la tienda, por nombre.

Usa Serper, que devuelve resultados de imagenes de Google por API. Antes esto
iba contra la Custom Search JSON API de Google y quedo descartada: da
`403 PERMISSION_DENIED` desde tres proyectos distintos, dos cuentas, con y sin
organizacion, y con dos motores de busqueda. Lo unico que compartian los tres
proyectos era no tener facturacion vinculada. Serper no depende de Google Cloud
y las primeras 2.500 consultas son gratis, que es mas de lo que hace falta.

Por que hace falta revisar a mano lo que devuelve: el catalogo no tiene codigo
de barras real (7 productos de 2.315), asi que la unica forma de buscar es por
nombre. "ABROCHADORA MAPED VIVO N10" encuentra el producto exacto; "CONO DE HILO
2000MTS IMPORTADO" puede traer cualquier cosa. Por eso este script NO asigna
nada: junta candidatas y arma una pagina para que una persona elija. Una foto
equivocada llega al cliente y se transforma en una devolucion.

Configuracion (una sola vez):

  1. serper.dev, entrar con Google. La cuenta gratis trae 2.500 consultas.

  2. Copiar la clave del panel y agregarla a `claves_google.txt`, en la raiz
     del proyecto:

       SERPER_API_KEY=...

     Ese archivo esta en .gitignore y no se sube a ningun lado. Ahi conviven
     las claves locales; las de Places y Routes siguen siendo de Google.

Cuota: 2.500 consultas gratis por unica vez, una por producto. Los 2.315
productos publicados entran casi justo, pero conviene arrancar por los que
tienen marca, que son los que la busqueda acierta.

    python scripts/buscar_fotos.py --cantidad 50
    python scripts/buscar_fotos.py --cantidad 200 --solo-con-marca
"""
import argparse
import json
import os
import sys
import time
import unicodedata
import urllib.error
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


def leer_claves():
    """
    Las claves salen de claves_google.txt o, si no esta, de las variables de
    entorno. El archivo evita tener que exportarlas en cada terminal nueva, que
    es donde siempre se olvidan.
    """
    valores = {
        'SERPER_API_KEY': os.environ.get('SERPER_API_KEY', ''),
    }
    ruta = os.path.join(RAIZ, 'claves_google.txt')
    if os.path.exists(ruta):
        with open(ruta, encoding='utf-8') as f:
            for linea in f:
                linea = linea.strip()
                if not linea or linea.startswith('#') or '=' not in linea:
                    continue
                nombre, _, valor = linea.partition('=')
                valores[nombre.strip()] = valor.strip().strip('"').strip("'")
    return valores


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


# Abreviaturas de packaging del POS. No aparecen en ninguna pagina de
# fabricante y solo ensucian la busqueda.
#
# Se descartan por palabra y no por texto: sacar la cadena ' X 1' de
# "Silicona Cbx X 100 Cc" dejaba "Silicona Cbx 00 Cc", y como despues los
# numeros sueltos tambien se descartaban, el error pasaba desapercibido.
BASURA = {'e/c', 'c/u', 'x1', 'unid', 'und', 'un', 'uds'}

# Unidades de medida que le dan sentido al numero que tienen delante.
UNIDADES = {
    'gr', 'grs', 'gramos', 'kg', 'cc', 'ml', 'lt', 'litros',
    'gb', 'tb', 'mb', 'mts', 'mt', 'metros', 'cm', 'mm',
    'hjs', 'hojas', 'hs', 'folios', 'pag', 'pags',
    'w', 'v', 'un', 'uds',
}


def armar_consulta(producto):
    """
    La consulta se arma con marca + nombre, sacando lo que solo confunde.

    Los codigos internos ("C12-003", "353011") y las abreviaturas de packaging
    ("E/C", "X 1") no aparecen en ninguna pagina de fabricante y hacen que la
    busqueda no devuelva nada.

    Los numeros sueltos se descartan por eso mismo, pero no todos: el que viene
    pegado a una unidad de medida y el de dos a cuatro cifras se quedan. En
    "Silicona Liquida CBX X 100 Cc" el 100 es lo que separa ese producto del de
    30 cc, y en "Pila Energizer 2032" el 2032 es el modelo. Sacarlos traia el
    envase o la pila equivocada. Los codigos internos del POS son mas largos
    (`1000015`, `900420`), asi que el largo alcanza para distinguirlos.
    """
    palabras = producto['nombre'].split()

    partes = []
    for i, p in enumerate(palabras):
        # La 'X' suelta de "X 100 Cc" cae sola por tener una letra, pero se mira
        # la palabra siguiente sobre la lista original para que el numero
        # todavia vea su unidad.
        if normalizar(p) in BASURA or len(p) <= 1:
            continue
        if p.isdigit():
            siguiente = normalizar(palabras[i + 1]) if i + 1 < len(palabras) else ''
            if siguiente.strip('.') in UNIDADES or 2 <= len(p) <= 4:
                partes.append(p)
            continue
        partes.append(p)

    consulta = ' '.join(partes[:8])

    marca = producto.get('marca') or ''
    if marca and normalizar(marca) not in normalizar(consulta):
        consulta = f'{marca} {consulta}'
    return consulta.strip()


def dominio_de(candidata):
    """
    De donde salio la imagen.

    Serper manda a veces `domain` y a veces solo el enlace a la pagina. Se
    prueba primero el campo y si no esta se saca del enlace, porque de esto
    depende el filtro de sitios excluidos: sin dominio no hay filtro.
    """
    dominio = (candidata.get('domain') or '').strip()
    if dominio:
        return dominio.lower()
    enlace = candidata.get('link') or candidata.get('imageUrl') or ''
    try:
        return urllib.parse.urlparse(enlace).netloc.lower()
    except Exception:
        return ''


def buscar(consulta, clave, cantidad=6):
    """Una consulta a la API. Devuelve [] si falla, para no cortar el lote."""
    peticion = urllib.request.Request(
        'https://google.serper.dev/images',
        data=json.dumps({
            'q': consulta,
            'gl': 'ar',
            'hl': 'es',
            'num': max(cantidad * 2, 10),  # se piden de mas: el filtro descarta
        }).encode('utf-8'),
        headers={'X-API-KEY': clave, 'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(peticion, timeout=25) as r:
            datos = json.load(r)
    except urllib.error.HTTPError as e:
        cuerpo = e.read().decode('utf-8', 'replace')[:200]
        if e.code in (401, 403):
            print(f'\n  La clave de Serper no sirve o se agoto el saldo: {cuerpo}')
            print('  Lo buscado hasta aca queda guardado.')
            raise SystemExit(1)
        if e.code == 429:
            print('\n  Serper esta limitando el ritmo. Lo buscado hasta aca queda guardado.')
            raise SystemExit(1)
        print(f'    error HTTP {e.code}: {cuerpo}')
        return []
    except Exception as e:
        print(f'    error: {e}')
        return []

    salida = []
    for it in datos.get('images', []):
        origen = dominio_de(it)
        if any(x in origen for x in EXCLUIDOS):
            continue
        if not it.get('imageUrl'):
            continue
        salida.append({
            'url': it.get('imageUrl'),
            # Cuando no viene miniatura se usa la imagen entera: la pagina de
            # revision muestra algo igual, solo que tarda un poco mas.
            'miniatura': it.get('thumbnailUrl') or it.get('imageUrl'),
            'origen': origen,
            'titulo': (it.get('title') or '')[:120],
            'ancho': it.get('imageWidth'),
            'alto': it.get('imageHeight'),
        })
        if len(salida) >= cantidad:
            break
    return salida


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cantidad', type=int, default=50,
                    help='cuantos productos buscar (por defecto 50)')
    ap.add_argument('--meses', type=int, default=4)
    ap.add_argument('--solo-con-marca', action='store_true',
                    help='solo los que tienen marca cargada: la busqueda acierta mucho mas')
    ap.add_argument('--rehacer', action='store_true',
                    help='vuelve a buscar los que ya estaban, en vez de saltearlos')
    args = ap.parse_args()

    claves = leer_claves()
    clave = claves.get('SERPER_API_KEY')
    if not clave:
        print(__doc__)
        sys.exit('Falta SERPER_API_KEY. Ver los pasos de configuracion de arriba.')

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

    # Se retoma lo ya buscado. La cuota es de 2.500 consultas por unica vez, y
    # gastarlas dos veces en el mismo producto por cortar el script a la mitad
    # seria tirar la mitad del presupuesto.
    ya = {}
    if os.path.exists(CANDIDATAS):
        ya = {p['doc_id']: p for p in json.load(open(CANDIDATAS, encoding='utf-8'))}
        print(f'{len(ya)} productos ya buscados antes, '
              f'{"se rehacen" if args.rehacer else "se saltean"}.\n')

    # Con --rehacer se reemplazan los de esta tanda y se dejan intactos los que
    # no entran en ella, en vez de borrar el archivo entero.
    a_rehacer = {p['doc_id'] for p in productos} if args.rehacer else set()
    resultados = [p for p in ya.values() if p['doc_id'] not in a_rehacer]
    nuevos = 0

    for i, p in enumerate(productos, 1):
        if p['doc_id'] in ya and not args.rehacer:
            continue
        consulta = armar_consulta(p)
        print(f'[{i}/{len(productos)}] {p["nombre"][:48]:<50} <- {consulta[:44]}')

        candidatas = buscar(consulta, clave)
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
