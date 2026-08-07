"""
Busca, elige y sube fotos de producto sola, y las muestra en vivo para revisar.

    python scripts/fotos_auto.py --cantidad 300 --solo-con-marca
    -> abre http://localhost:8770

Corre dos cosas a la vez: un trabajador que va producto por producto buscando,
eligiendo, achicando y subiendo, y un servidor local que muestra lo que va
subiendo a medida que pasa. Desde ahi se descarta una foto o se pide la
siguiente candidata, y el cambio se aplica en Firestore en el momento.

Sobre elegir sola. El circuito original no asignaba nada a proposito: el
catalogo casi no tiene codigo de barras (7 productos de 2.315), asi que la
busqueda va por nombre y una foto equivocada le llega al cliente. La red de
seguridad no desaparecio, se movio: en vez de aprobar de a una antes de subir,
se sube todo y se descarta despues, viendolas juntas, que para 300 productos es
mucho mas rapido y deja el mismo resultado.

Para bajar el ruido, se elige con puntaje y hay un piso: lo que no llega no se
sube y queda listado como "sin foto". Es preferible un producto sin foto que uno
con la foto de otro.
"""
import argparse
import json
import os
import re
import ssl
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.request
import webbrowser
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import buscar_fotos as bf
import importar_fotos as imp

NAVEGADOR = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
             '(KHTML, like Gecko) Chrome/126.0 Safari/537.36')

SIN_VERIFICAR = ssl.create_default_context()
SIN_VERIFICAR.check_hostname = False
SIN_VERIFICAR.verify_mode = ssl.CERT_NONE

# Palabras que aparecen en casi todos los nombres y no ayudan a decidir si una
# candidata es del producto correcto.
VACIAS = {'de', 'del', 'la', 'las', 'el', 'los', 'con', 'sin', 'para', 'por',
          'y', 'a', 'en', 'x', 'un', 'una', 'cm', 'mm'}

ESTADO = {
    'total': 0,
    'procesados': 0,
    'con_foto': 0,
    'sin_foto': 0,
    'corriendo': True,
    'actual': '',
    'items': [],
}
CANDADO = threading.Lock()

# Sitios que estampan su logo sobre la foto.
#
# No hay forma confiable de detectar una marca de agua mirando la imagen, asi
# que la decide una persona: en la pagina, "Nunca de este sitio" agrega el
# dominio aca y cambia de una todas las fotos que hayan salido de el. La lista
# queda en disco y se aplica desde la primera busqueda de la corrida siguiente.
BLOQUEADOS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          'sitios_bloqueados.txt')
_bloqueados = set()


def cargar_bloqueados():
    if not os.path.exists(BLOQUEADOS):
        return
    with open(BLOQUEADOS, encoding='utf-8') as f:
        for linea in f:
            linea = linea.strip().lower()
            if linea and not linea.startswith('#'):
                _bloqueados.add(linea)


def bloquear_sitio(dominio):
    dominio = (dominio or '').strip().lower()
    if not dominio or dominio in _bloqueados:
        return False
    _bloqueados.add(dominio)
    nuevo = not os.path.exists(BLOQUEADOS)
    with open(BLOQUEADOS, 'a', encoding='utf-8') as f:
        if nuevo:
            f.write('# Sitios que estampan marca de agua. Uno por linea.\n'
                    '# Los agrega el boton "Nunca de este sitio" de fotos_auto.py.\n')
        f.write(dominio + '\n')
    return True


def esta_bloqueado(origen):
    o = (origen or '').lower()
    return any(b in o for b in _bloqueados)


# Una sola subida a la vez. El trabajador y los botones de la pagina escriben
# sobre lo mismo, y dos escrituras cruzadas sobre el mismo producto dejarian la
# foto de una y la URL de la otra.
CANDADO_SUBIDA = threading.Lock()


def normalizar(t):
    s = unicodedata.normalize('NFD', str(t or '').lower())
    return ''.join(c for c in s if unicodedata.category(c) != 'Mn')


def palabras_de(texto):
    limpio = re.sub(r'[^a-z0-9]+', ' ', normalizar(texto))
    return [p for p in limpio.split() if p and p not in VACIAS]


# ── Juguetes que se llaman como un arma ─────────────────────────────────────
#
# El catalogo tiene "Ametralladora 639", "Pistola Lanza Corcho" y una decena
# mas. Son juguetes de plastico, pero el nombre no lo dice y la busqueda por
# nombre devuelve armas de verdad: fusiles negros fotografiados sobre una mesa y
# una escopeta arriba de una cama, sacada de un clasificado. En el catalogo
# publico de una libreria de barrio eso no puede pasar.
#
# Poner "juguete" adelante de la consulta mejora los resultados pero no alcanza,
# porque el buscador igual mezcla. Asi que ademas se le exige a la candidata que
# lo diga: o el titulo tiene una palabra de juguete, o la foto sale de una
# jugueteria. La que no lo dice se descarta, no se penaliza: un puntaje bajo
# igual gana cuando no hay nada mejor, y aca lo correcto es quedarse sin foto.
DE_FUEGO = {
    'pistola', 'pistolita', 'revolver', 'escopeta', 'rifle', 'fusil', 'subfusil',
    'ametralladora', 'metralleta', 'uzi', 'ak47', 'arma', 'armas', 'armamento',
    'bala', 'balas', 'balin', 'balines', 'municion', 'municiones', 'cartucho',
    'granada', 'bazuca', 'francotirador', 'sniper',
}

# Se comparan contra las palabras del titulo ya normalizadas, asi que van sin
# acentos, sin guiones y en singular y plural: "x-shot" llega partido en "shot".
SENAL_JUGUETE = {
    'juguete', 'juguetes', 'jugueteria', 'jugueteria', 'juguetera', 'toy', 'toys',
    'infantil', 'infantiles', 'nino', 'ninos', 'nina', 'ninas', 'chicos', 'kids',
    'juego', 'juegos', 'jugar', 'nerf', 'shot', 'blaster', 'dardo', 'dardos',
    'plastico', 'didactico', 'didactica',
}

SENAL_JUGUETE_DOMINIO = ('juguet', 'toys', 'kids', 'bebe', 'chicos', 'jugar',
                         'peques', 'ludico')


def nombra_un_arma(producto):
    """Si el producto es de jugueteria y su nombre nombra un arma de fuego."""
    if not normalizar(producto.get('rubro') or '').startswith('juguet'):
        return False
    return any(p in DE_FUEGO for p in palabras_de(producto.get('nombre')))


def parece_juguete(candidata):
    """Si la candidata se presenta como juguete, por el titulo o por el sitio."""
    if any(p in SENAL_JUGUETE for p in palabras_de(candidata.get('titulo'))):
        return True
    origen = normalizar(candidata.get('origen') or '')
    return any(s in origen for s in SENAL_JUGUETE_DOMINIO)


def puntuar(candidata, producto):
    """
    Que tan probable es que esta imagen sea de este producto.

    Manda cuantas palabras del nombre aparecen en el titulo de la candidata: es
    lo unico que relaciona de verdad la imagen con el producto. El resto son
    desempates, y pesan poco a proposito, para que una foto grande y cuadrada de
    otra cosa nunca le gane a una foto justa del producto correcto.
    """
    titulo = palabras_de(candidata.get('titulo'))
    if not titulo:
        return 0.0

    esperadas = palabras_de(producto['nombre'])
    if not esperadas:
        return 0.0

    presentes = sum(1 for p in esperadas if any(t.startswith(p) or p.startswith(t) for t in titulo))
    puntaje = presentes / len(esperadas)

    marca = normalizar(producto.get('marca') or '')
    if marca:
        # Que la marca este en el titulo importa mas que una palabra cualquiera,
        # y que la foto salga del sitio de la marca es la mejor senal que hay.
        if any(m in titulo for m in palabras_de(marca)):
            puntaje += 0.15
        if marca.replace(' ', '') in normalizar(candidata.get('origen') or ''):
            puntaje += 0.25

    ancho = int(candidata.get('ancho') or 0)
    alto = int(candidata.get('alto') or 0)
    if ancho >= 500 and alto >= 500:
        puntaje += 0.1
    elif ancho and (ancho < 250 or alto < 250):
        # Miniaturas: se ven mal apenas la card crece.
        puntaje -= 0.3

    if ancho and alto:
        proporcion = max(ancho, alto) / min(ancho, alto)
        if proporcion > 2.2:
            # Banners y fotos de gondola, no de producto.
            puntaje -= 0.2

    return round(puntaje, 3)


def variantes_de_consulta(producto):
    """
    La consulta principal y sus planes B, en orden de mas precisa a mas amplia.

    Los que se quedan sin foto casi siempre fallan por lo mismo: el nombre trae
    un codigo interno ("Agenda Em Cosida A5 Tapa Entelada MB-2627"), una
    abreviatura que solo se usa en el local ("Sobre Paperland Color / Fsia") o
    una medida escrita raro ("12.5X 19"). Ninguna de las tres aparece en la
    pagina de un fabricante, y con una sola de ellas adentro la busqueda vuelve
    vacia.

    Se prueban de a una y se corta apenas alguna trae algo que sirva, asi el
    caso normal sigue costando una sola consulta.
    """
    principal = bf.armar_consulta(producto)

    # "Ametralladora 639" y "Pistola Lanza Dardos" son juguetes, pero la
    # busqueda no lo sabe y trae armas de verdad. Decir el rubro lo resuelve, y
    # de paso mejora todo lo demas de jugueteria: "Espada con Luz y Sonido"
    # tambien trae mejores resultados con la palabra juguete adelante.
    if normalizar(producto.get('rubro') or '').startswith('juguet'):
        principal = f'juguete {principal}'

    palabras = principal.split()

    # Sin codigos: lo que mezcla letras y numeros o tiene guion en el medio.
    sin_codigos = [p for p in palabras
                   if not (re.search(r'\d', p) and re.search(r'[a-zA-Z]', p))]

    marca = (producto.get('marca') or '').strip()
    sin_marca = [p for p in palabras if normalizar(p) not in normalizar(marca).split()]

    variantes = [
        principal,
        ' '.join(sin_codigos),
        ' '.join(sin_codigos[:4]),
        ' '.join(sin_marca[:4]),
    ]

    # Se sacan las repetidas y las que quedaron demasiado cortas para
    # significar algo.
    vistas, salida = set(), []
    for v in variantes:
        v = ' '.join(v.split())
        if len(v) < 6 or v.lower() in vistas:
            continue
        vistas.add(v.lower())
        salida.append(v)
    return salida


def bajar(url):
    """
    Baja la imagen.

    Si el certificado del sitio no valida se reintenta sin verificarlo. Es una
    concesion consciente y acotada: se estan bajando bytes de una imagen publica
    que despues Pillow vuelve a codificar, no se manda ninguna credencial ni se
    ejecuta nada de lo que llega. Muchas tiendas argentinas tienen el
    certificado vencido y sin esto se pierden fotos que estan bien.
    """
    pedido = urllib.request.Request(url, headers={'User-Agent': NAVEGADOR})
    try:
        with urllib.request.urlopen(pedido, timeout=25) as r:
            return r.read()
    except urllib.error.URLError as e:
        if not isinstance(getattr(e, 'reason', None), ssl.SSLError):
            raise
        with urllib.request.urlopen(pedido, timeout=25, context=SIN_VERIFICAR) as r:
            return r.read()


def publicar(db, bucket, producto, candidata, simular=False):
    """Baja la imagen, la achica, la sube y deja la URL en las dos colecciones."""
    datos = bajar(candidata['url'])
    webp, tam = imp.preparar(datos)

    codigo = producto['codigo']
    ruta = f'tienda/{codigo}/1.webp'
    url = imp.url_publica(ruta)

    if simular:
        # Nada llega a Storage, asi que la pagina muestra la imagen original:
        # apuntar a una URL que no existe daria una grilla de rotos y no
        # dejaria juzgar si la eleccion fue buena.
        return candidata['url'], len(webp), tam

    blob = bucket.blob(ruta)
    blob.cache_control = 'public, max-age=31536000, immutable'
    blob.upload_from_string(webp, content_type='image/webp')

    db.collection('catalogo').document(producto['doc_id']).set(
        {'tienda_imagenes': [url]}, merge=True)
    db.collection('tienda_productos').document(producto['doc_id']).set(
        {'imagenes': [url]}, merge=True)

    # El nombre del archivo en Storage es siempre el mismo, asi que al cambiar
    # de candidata el navegador seguiria mostrando la anterior de su cache.
    return f'{url}&v={int(time.time())}', len(webp), tam


def quitar(db, producto, simular=False):
    if simular:
        return
    db.collection('catalogo').document(producto['doc_id']).set(
        {'tienda_imagenes': []}, merge=True)
    db.collection('tienda_productos').document(producto['doc_id']).set(
        {'imagenes': []}, merge=True)


# ── Trabajador ──────────────────────────────────────────────────────────────

def rastrear(producto, clave, minimo):
    """
    Busca con la consulta principal y, si no trae nada que sirva, con sus
    planes B. Devuelve (consulta que se uso, candidatas puntuadas).
    """
    mejores, consulta_usada = [], ''
    solo_juguetes = nombra_un_arma(producto)

    for consulta in variantes_de_consulta(producto):
        crudas = bf.buscar(consulta, clave, cantidad=8)
        candidatas = [c for c in crudas if not esta_bloqueado(c['origen'])]
        if solo_juguetes:
            candidatas = [c for c in candidatas if parece_juguete(c)]
        for c in candidatas:
            c['puntaje'] = puntuar(c, producto)
        candidatas.sort(key=lambda c: -c['puntaje'])

        if not consulta_usada:
            consulta_usada, mejores = consulta, candidatas

        if candidatas and candidatas[0]['puntaje'] >= minimo:
            return consulta, candidatas

        # La variante trajo algo mejor que la anterior, aunque no alcance el
        # piso: se guarda como la mejor apuesta hasta ahora.
        if candidatas and (not mejores or candidatas[0]['puntaje'] > mejores[0]['puntaje']):
            consulta_usada, mejores = consulta, candidatas

    return consulta_usada, mejores


def avanzar(item, db, bucket, clave, simular, piso=None):
    """
    Sube la siguiente candidata que sirva y deja el item apuntando a ella.

    Salta las de sitios bloqueados y las que no se pueden bajar, que son
    bastantes: certificados vencidos, hotlink cerrado, enlaces muertos.

    `piso` corta cuando la candidata no llega a ese puntaje. Como estan
    ordenadas de mejor a peor, la primera que no llega garantiza que las
    siguientes tampoco. Ese caso no consume la candidata, asi un segundo
    intento con el piso mas bajo la vuelve a considerar.

    Devuelve (subio algo, motivos de lo que fallo).
    """
    if not item.get('buscada'):
        consulta, candidatas = rastrear(item, clave, piso if piso is not None else 0.55)
        with CANDADO:
            item.update({'consulta': consulta, 'candidatas': candidatas,
                         'buscada': True, 'indice': -1})

    fallos = []
    while True:
        with CANDADO:
            siguiente = item['indice'] + 1
            candidata = (item['candidatas'][siguiente]
                         if siguiente < len(item['candidatas']) else None)

        if not candidata:
            return False, fallos
        if piso is not None and candidata['puntaje'] < piso:
            return False, fallos

        with CANDADO:
            item['indice'] = siguiente

        if esta_bloqueado(candidata['origen']):
            continue

        try:
            with CANDADO_SUBIDA:
                url, peso, tam = publicar(db, bucket, item, candidata, simular)
        except Exception as e:
            fallos.append(f'{candidata["origen"]}: {str(e)[:70]}')
            continue

        with CANDADO:
            if item['estado'] != 'ok':
                ESTADO['con_foto'] += 1
                ESTADO['sin_foto'] -= 1
            item.update({
                'url': url, 'origen': candidata['origen'], 'titulo': candidata['titulo'],
                'puntaje': candidata['puntaje'], 'peso': peso,
                'medidas': f'{tam[0]}x{tam[1]}', 'estado': 'ok',
            })
        return True, fallos


def trabajar(productos, clave, db, bucket, minimo, simular):
    for p in productos:
        with CANDADO:
            ESTADO['actual'] = p['nombre']

        consulta, candidatas = rastrear(p, clave, minimo)

        item = {
            'doc_id': p['doc_id'],
            'codigo': p['codigo'],
            'nombre': p['nombre'],
            'marca': p.get('marca', ''),
            # El rubro viaja con el item porque el boton "Otra" vuelve a buscar
            # desde aca, y sin el se pierden el prefijo "juguete" y el filtro de
            # armas de verdad.
            'rubro': p.get('rubro', ''),
            'importe': p.get('importe', 0),
            'consulta': consulta,
            'candidatas': candidatas,
            'buscada': True,
            'indice': -1,
            'url': None,
            'origen': '',
            'titulo': '',
            'puntaje': 0,
            'peso': 0,
            'dudosa': False,
            'estado': 'sin_candidata',
        }

        # Entra a la lista antes de subir para que avanzar() mueva los
        # contadores una sola vez y desde un estado conocido.
        with CANDADO:
            ESTADO['items'].append(item)
            ESTADO['procesados'] += 1
            ESTADO['sin_foto'] += 1

        subio, _ = avanzar(item, db, bucket, clave, simular, piso=minimo)

        # Segunda pasada con el piso mas bajo. Sube igual pero queda marcada:
        # para un producto que si no se queda sin nada, una foto floja
        # senalada es mejor que un hueco, y la decision final es de quien
        # revisa.
        if not subio and candidatas:
            subio, _ = avanzar(item, db, bucket, clave, simular, piso=minimo * 0.55)
            if subio:
                with CANDADO:
                    item['dudosa'] = True

        marca = 'OK ' if item['estado'] == 'ok' and not item['dudosa'] else \
                ('~~ ' if item['dudosa'] else '-- ')
        print(f'[{ESTADO["procesados"]}/{ESTADO["total"]}] {marca}'
              f'{p["nombre"][:44]:<46} {item["puntaje"]:.2f}  {item["origen"][:28]}')

        time.sleep(0.3)

    with CANDADO:
        ESTADO['corriendo'] = False
        ESTADO['actual'] = ''
    print(f'\nTerminado. {ESTADO["con_foto"]} con foto, {ESTADO["sin_foto"]} sin foto.')
    print('La pagina sigue abierta para revisar.')


# ── Servidor local ──────────────────────────────────────────────────────────

def buscar_item(doc_id):
    for it in ESTADO['items']:
        if it['doc_id'] == doc_id:
            return it
    return None


def quedan_de(item):
    """
    Cuantas candidatas de repuesto le quedan.

    Las que todavia no se buscaron cuentan como que tienen: el boton "Otra"
    tiene que estar habilitado para poder disparar esa busqueda. Cuantas van a
    aparecer no se sabe hasta pedirlas.
    """
    if not item.get('buscada'):
        return 8
    return max(0, len(item['candidatas']) - item['indice'] - 1)


class Manejador(BaseHTTPRequestHandler):
    db = None
    bucket = None
    clave = ''
    simular = False

    def log_message(self, *_):
        pass  # sin ruido: la consola es del trabajador

    def _responder(self, cuerpo, tipo='application/json'):
        datos = cuerpo if isinstance(cuerpo, bytes) else cuerpo.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', f'{tipo}; charset=utf-8')
        self.send_header('Content-Length', str(len(datos)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(datos)

    def do_GET(self):
        if self.path.startswith('/estado'):
            with CANDADO:
                self._responder(json.dumps({
                    'total': ESTADO['total'],
                    'procesados': ESTADO['procesados'],
                    'con_foto': ESTADO['con_foto'],
                    'sin_foto': ESTADO['sin_foto'],
                    'corriendo': ESTADO['corriendo'],
                    'actual': ESTADO['actual'],
                    # Lo ultimo primero: es lo que la persona esta esperando ver.
                    'items': [{k: v for k, v in it.items() if k != 'candidatas'}
                              | {'quedan': quedan_de(it)}
                              for it in reversed(ESTADO['items'])],
                }, ensure_ascii=False))
            return
        self._responder(PAGINA, 'text/html')

    def do_POST(self):
        largo = int(self.headers.get('Content-Length') or 0)
        try:
            cuerpo = json.loads(self.rfile.read(largo) or b'{}')
        except Exception:
            cuerpo = {}

        doc_id = cuerpo.get('doc_id')
        with CANDADO:
            item = buscar_item(doc_id)

        if not item:
            self._responder(json.dumps({'ok': False}))
            return

        if self.path.startswith('/quitar'):
            with CANDADO_SUBIDA:
                quitar(self.db, item, self.simular)
            with CANDADO:
                if item['estado'] == 'ok':
                    ESTADO['con_foto'] -= 1
                    ESTADO['sin_foto'] += 1
                item.update({'url': None, 'estado': 'quitada', 'puntaje': 0})
            self._responder(json.dumps({'ok': True}))
            return

        if self.path.startswith('/otra'):
            subio, fallos = avanzar(item, self.db, self.bucket, self.clave, self.simular)
            if not subio:
                self._responder(json.dumps({
                    'ok': False,
                    'motivo': fallos[-1] if fallos else 'No quedan candidatas.',
                }))
                return
            with CANDADO:
                item['dudosa'] = False
            self._responder(json.dumps({'ok': True, 'saltadas': len(fallos)}))
            return

        if self.path.startswith('/bloquear'):
            dominio = (item.get('origen') or '').strip()
            if not dominio:
                self._responder(json.dumps({'ok': False, 'motivo': 'Esta foto no tiene sitio.'}))
                return

            bloquear_sitio(dominio)

            # Se cambian todas las que hayan salido de ese sitio, no solo la que
            # se estaba mirando: si estampa el logo, lo estampa en todas.
            with CANDADO:
                afectados = [i for i in ESTADO['items']
                             if i['estado'] == 'ok' and i.get('origen') == dominio]

            cambiados = 0
            for otro in afectados:
                subio, _ = avanzar(otro, self.db, self.bucket, self.clave, self.simular)
                if subio:
                    cambiados += 1
                else:
                    with CANDADO:
                        quitar(self.db, otro, self.simular)
                        if otro['estado'] == 'ok':
                            ESTADO['con_foto'] -= 1
                            ESTADO['sin_foto'] += 1
                        otro.update({'url': None, 'estado': 'quitada', 'puntaje': 0})

            print(f'  bloqueado {dominio}: {cambiados} de {len(afectados)} cambiadas')
            self._responder(json.dumps({
                'ok': True, 'dominio': dominio,
                'afectados': len(afectados), 'cambiados': cambiados,
            }))
            return

        self._responder(json.dumps({'ok': False}))


PAGINA = r"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fotos de la tienda</title>
<style>
  :root {
    --fondo: #F7F5FA; --sup: #FFF; --texto: #1A1720; --texto2: #6B6478;
    --borde: #E4DFEA; --primario: #7B3FA6; --ok: #2F7A3D; --alerta: #9A5B00;
  }
  @media (prefers-color-scheme: dark) {
    :root { --fondo:#131118; --sup:#1C1924; --texto:#F0EDF5; --texto2:#A69FB3;
            --borde:#2E2938; --primario:#C08FE0; --ok:#6FBF7C; --alerta:#E8A94A; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--fondo); color:var(--texto);
         font:15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
  header { position:sticky; top:0; z-index:5; background:var(--sup);
           border-bottom:1px solid var(--borde); padding:14px 20px; }
  .fila { display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
  h1 { font-size:17px; margin:0; font-weight:700; letter-spacing:-.01em; }
  .contadores { display:flex; gap:16px; font-size:13px; color:var(--texto2); }
  .contadores b { color:var(--texto); font-variant-numeric:tabular-nums; }
  .barra { height:4px; background:var(--borde); border-radius:99px; overflow:hidden; margin-top:12px; }
  .barra i { display:block; height:100%; background:var(--primario); width:0; transition:width .3s; }
  .actual { font-size:12.5px; color:var(--texto2); margin-top:8px; min-height:18px; }

  main { padding:20px; }
  .grilla { display:grid; gap:14px;
            grid-template-columns:repeat(auto-fill, minmax(230px, 1fr)); }
  .card { background:var(--sup); border:1px solid var(--borde); border-radius:12px;
          overflow:hidden; display:flex; flex-direction:column;
          animation:entra .25s ease backwards; }
  @keyframes entra { from { opacity:0; transform:translateY(8px); } }
  .foto { aspect-ratio:1; background:#fff; display:grid; place-items:center; position:relative; }
  .foto img { width:100%; height:100%; object-fit:contain; }
  .foto .nada { color:var(--texto2); font-size:12.5px; text-align:center; padding:0 16px; }
  .puntaje { position:absolute; top:8px; left:8px; background:rgba(0,0,0,.72); color:#fff;
             font-size:11px; font-weight:700; padding:2px 7px; border-radius:99px; }
  .cuerpo { padding:10px 12px; display:flex; flex-direction:column; gap:4px; flex:1; }
  .nombre { font-size:13px; font-weight:600; line-height:1.3; }
  .meta { font-size:11.5px; color:var(--texto2); word-break:break-all; }
  .acciones { display:flex; gap:6px; padding:0 12px 12px; }
  button { flex:1; padding:7px 8px; border-radius:8px; border:1px solid var(--borde);
           background:transparent; color:var(--texto); font:inherit; font-size:12px;
           font-weight:600; cursor:pointer; }
  button:hover:not(:disabled) { border-color:var(--primario); color:var(--primario); }
  button:disabled { opacity:.4; cursor:default; }
  .aviso:not(:empty) { font-size:11.5px; color:var(--alerta); line-height:1.35; margin-top:2px; }
  .bloquear { font-size:11.5px; color:var(--texto2); }
  .bloquear:hover:not(:disabled) { border-color:#c0392b; color:#c0392b; }
  .card[data-estado="quitada"] .foto, .card[data-estado="sin_candidata"] .foto { background:var(--fondo); }
  /* Las de la segunda pasada: ninguna candidata llegaba al piso, se subio la
     mejor de todas formas. Van senaladas para mirarlas primero. */
  .card[data-dudosa="1"] { border-color:var(--alerta); }
  .dudosa-marca { position:absolute; top:8px; right:8px; background:var(--alerta); color:#fff;
                  font-size:10.5px; font-weight:700; padding:2px 7px; border-radius:99px; }
  .vacio { color:var(--texto2); padding:40px 0; text-align:center; }
</style>
</head>
<body>
<header>
  <div class="fila">
    <h1>Fotos de la tienda</h1>
    <div class="contadores">
      <span><b id="c-proc">0</b> de <b id="c-total">0</b></span>
      <span style="color:var(--ok)"><b id="c-ok">0</b> con foto</span>
      <span style="color:var(--alerta)"><b id="c-no">0</b> sin foto</span>
    </div>
  </div>
  <div class="barra"><i id="barra"></i></div>
  <div class="actual" id="actual"></div>
</header>

<main><div class="grilla" id="grilla"></div>
<div class="vacio" id="vacio">Esperando el primer producto…</div></main>

<script>
const grilla = document.getElementById('grilla');
let pintados = new Map();

function card(it) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.estado = it.estado;
  el.dataset.dudosa = it.dudosa ? '1' : '0';
  el.innerHTML = `
    <div class="foto">
      ${it.url
        ? `<img src="${it.url}" alt="" loading="lazy">
           <span class="puntaje">${it.puntaje.toFixed(2)}</span>
           ${it.dudosa ? '<span class="dudosa-marca">revisar</span>' : ''}`
        : `<span class="nada">${it.estado === 'quitada' ? 'Quitada'
             : it.estado === 'error' ? ('Error: ' + (it.error || ''))
             : 'Sin candidata que sirva'}</span>`}
    </div>
    <div class="cuerpo">
      <div class="nombre"></div>
      <div class="meta origen"></div>
      <div class="meta consulta"></div>
      <div class="aviso"></div>
    </div>
    <div class="acciones">
      <button data-act="otra">Otra${it.quedan ? ` (${it.quedan})` : ''}</button>
      <button data-act="quitar">Quitar</button>
    </div>
    <div class="acciones" style="padding-top:0">
      <button data-act="bloquear" class="bloquear" title="Cambia todas las fotos que salieron de este sitio">
        Nunca de este sitio
      </button>
    </div>`;

  // textContent y no innerHTML: los nombres y los títulos vienen de páginas
  // ajenas y no tienen por qué ser HTML válido ni inofensivo.
  el.querySelector('.nombre').textContent = it.nombre;
  el.querySelector('.origen').textContent = it.origen || '';
  el.querySelector('.consulta').textContent = it.consulta;

  el.querySelector('[data-act="otra"]').disabled = !it.quedan;
  el.querySelector('[data-act="quitar"]').disabled = !it.url;
  el.querySelector('[data-act="bloquear"]').disabled = !it.origen;

  el.addEventListener('click', async ev => {
    const act = ev.target.closest('[data-act]');
    if (!act) return;

    const etiqueta = act.textContent;
    act.disabled = true;
    act.textContent = act.dataset.act === 'quitar' ? '…' : 'Buscando…';

    let r = {};
    try {
      r = await (await fetch('/' + act.dataset.act, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_id: it.doc_id }),
      })).json();
    } catch (e) {
      r = { ok: false, motivo: 'No se pudo hablar con el servidor.' };
    }

    // Sin esto, cuando falla la tarjeta queda igual, no se repinta y el botón
    // se queda deshabilitado para siempre: parece que la página se colgó.
    if (!r.ok) {
      act.disabled = false;
      act.textContent = etiqueta;
      el.querySelector('.aviso').textContent = r.motivo || 'No se pudo cambiar.';
      return;
    }
    refrescar();
  });

  return el;
}

async function refrescar() {
  let e;
  try { e = await (await fetch('/estado')).json(); } catch { return; }

  document.getElementById('c-proc').textContent = e.procesados;
  document.getElementById('c-total').textContent = e.total;
  document.getElementById('c-ok').textContent = e.con_foto;
  document.getElementById('c-no').textContent = e.sin_foto;
  document.getElementById('barra').style.width =
    (e.total ? (e.procesados / e.total * 100) : 0) + '%';
  document.getElementById('actual').textContent =
    e.corriendo ? (e.actual ? 'Buscando: ' + e.actual : 'Buscando…')
                : 'Listo. Ya podés cerrar la consola.';

  if (e.items.length) document.getElementById('vacio').remove?.();

  // Se repinta solo lo que cambió: con 300 tarjetas, rehacer la grilla entera
  // en cada refresco corta el scroll y hace parpadear las imágenes.
  for (const it of e.items) {
    const firma = `${it.estado}|${it.url}|${it.quedan}|${it.dudosa}`;
    const previo = pintados.get(it.doc_id);
    if (previo && previo.firma === firma) continue;

    const nuevo = card(it);
    if (previo) previo.el.replaceWith(nuevo);
    else grilla.prepend(nuevo);
    pintados.set(it.doc_id, { firma, el: nuevo });
  }
}

refrescar();
setInterval(refrescar, 1500);
</script>
</body>
</html>
"""


# ── Arranque ────────────────────────────────────────────────────────────────

def elegir_productos(db, cantidad, solo_con_marca, meses=4, rehacer=False, contiene=None):
    """
    Los que hay que buscar y los que ya tienen foto, ordenados por lo que
    facturan.

    Los que ya la tienen se devuelven aparte para que la pagina los muestre
    igual. Si no, al reiniciar el script se perderia de vista todo lo subido en
    la corrida anterior y no habria forma de descartar una foto mala mas que
    volviendo a mirar la tienda producto por producto.
    """
    desde = datetime.now(timezone.utc) - timedelta(days=meses * 30)
    importe = defaultdict(float)
    for d in db.collection('ventas_por_dia').where('fecha_dt', '>=', desde).stream():
        x = d.to_dict() or {}
        if x.get('deleted') is True:
            continue
        importe[bf.normalizar(x.get('producto') or x.get('product_name'))] += \
            float(x.get('subtotal') or 0)

    nombre_original = {d.id: (d.to_dict() or {}).get('nombre') or ''
                       for d in db.collection('catalogo').select(['nombre']).stream()}

    productos, con_foto = [], []
    for d in db.collection('tienda_productos').stream():
        x = d.to_dict() or {}
        if solo_con_marca and not (x.get('marca') or '').strip():
            continue
        p = {
            'doc_id': d.id,
            'codigo': x.get('codigo') or d.id,
            'nombre': x.get('nombre') or '',
            'marca': (x.get('marca') or '').strip(),
            'rubro': x.get('rubro') or '',
            'importe': round(importe.get(bf.normalizar(nombre_original.get(d.id, '')), 0)),
        }
        # `contiene` acota a los productos cuyo nombre incluya alguno de los
        # terminos. Sirve para rehacer un grupo puntual sin volver a buscar el
        # catalogo entero: las armas de jugueteria, una marca, un rubro.
        if contiene and not any(t in normalizar(p['nombre']) for t in contiene):
            continue

        imagenes = x.get('imagenes') or []
        if imagenes and not rehacer:
            p['imagen'] = imagenes[0]
            con_foto.append(p)
        else:
            if imagenes:
                p['imagen'] = imagenes[0]
            productos.append(p)

    productos.sort(key=lambda p: -p['importe'])
    con_foto.sort(key=lambda p: -p['importe'])
    return productos[:cantidad], con_foto


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--cantidad', type=int, default=100)
    ap.add_argument('--solo-con-marca', action='store_true',
                    help='solo los que tienen marca: la busqueda acierta mucho mas')
    ap.add_argument('--minimo', type=float, default=0.55,
                    help='puntaje minimo para subir una foto (0 a 1.5, por defecto 0.55)')
    ap.add_argument('--puerto', type=int, default=8770)
    ap.add_argument('--rehacer', action='store_true',
                    help='vuelve a buscar tambien los que ya tienen foto')
    ap.add_argument('--contiene', metavar='TEXTO',
                    help='solo los productos cuyo nombre incluya alguno de estos '
                         'terminos, separados por coma')
    ap.add_argument('--simular', action='store_true',
                    help='busca y puntua, pero no sube ni escribe nada')
    args = ap.parse_args()

    contiene = [normalizar(t) for t in args.contiene.split(',') if t.strip()] if args.contiene else None

    clave = bf.claves_serper()
    if not clave:
        sys.exit('Falta SERPER_API_KEY en claves_google.txt')
    print(f'{len(clave)} clave{"s" if len(clave) > 1 else ""} de Serper cargada'
          f'{"s" if len(clave) > 1 else ""}.')

    cargar_bloqueados()
    if _bloqueados:
        print(f'{len(_bloqueados)} sitios bloqueados por marca de agua.')

    db, bucket = imp.conectar()

    print('Buscando productos sin foto...')
    productos, ya = elegir_productos(db, args.cantidad, args.solo_con_marca,
                                     rehacer=args.rehacer, contiene=contiene)
    if not productos and not ya:
        sys.exit('No hay productos que cumplan el filtro.')

    # Las de corridas anteriores entran a la pagina ya resueltas, sin candidatas:
    # se buscan recien si alguien pide otra.
    for p in ya:
        ESTADO['items'].append({
            **p, 'consulta': '', 'candidatas': [], 'buscada': False, 'indice': -1,
            'url': p['imagen'], 'origen': '', 'titulo': '', 'puntaje': 0,
            'peso': 0, 'dudosa': False, 'estado': 'ok',
        })
    ESTADO['procesados'] = len(ya)
    ESTADO['con_foto'] = len(ya)
    ESTADO['total'] = len(productos) + len(ya)

    print(f'{len(productos)} para buscar' +
          (f', {len(ya)} ya tienen foto y se muestran para revisar' if ya else '') +
          ('  (SIMULACION: no se sube nada)' if args.simular else '') + '\n')

    Manejador.db = db
    Manejador.bucket = bucket
    Manejador.clave = clave
    Manejador.simular = args.simular

    servidor = ThreadingHTTPServer(('127.0.0.1', args.puerto), Manejador)
    threading.Thread(target=servidor.serve_forever, daemon=True).start()

    direccion = f'http://localhost:{args.puerto}'
    print(f'Mirando en {direccion}\n')
    webbrowser.open(direccion)

    hilo = threading.Thread(
        target=trabajar,
        args=(productos, clave, db, bucket, args.minimo, args.simular),
        daemon=True)
    hilo.start()

    # El servidor tiene que seguir vivo despues de terminar de subir: la
    # revision empieza recien cuando el trabajador termino.
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print('\nCerrado.')


if __name__ == '__main__':
    main()
