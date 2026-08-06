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

def trabajar(productos, clave, db, bucket, minimo, simular):
    for p in productos:
        with CANDADO:
            ESTADO['actual'] = p['nombre']

        consulta = bf.armar_consulta(p)
        candidatas = bf.buscar(consulta, clave, cantidad=8)

        for c in candidatas:
            c['puntaje'] = puntuar(c, p)
        candidatas.sort(key=lambda c: -c['puntaje'])

        item = {
            'doc_id': p['doc_id'],
            'codigo': p['codigo'],
            'nombre': p['nombre'],
            'marca': p.get('marca', ''),
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
            'estado': 'sin_candidata',
        }

        elegida = candidatas[0] if candidatas and candidatas[0]['puntaje'] >= minimo else None

        if elegida:
            try:
                with CANDADO_SUBIDA:
                    url, peso, tam = publicar(db, bucket, p, elegida, simular)
                item.update({
                    'indice': 0, 'url': url, 'origen': elegida['origen'],
                    'titulo': elegida['titulo'], 'puntaje': elegida['puntaje'],
                    'peso': peso, 'medidas': f'{tam[0]}x{tam[1]}', 'estado': 'ok',
                })
            except Exception as e:
                item['estado'] = 'error'
                item['error'] = str(e)[:120]

        with CANDADO:
            ESTADO['items'].append(item)
            ESTADO['procesados'] += 1
            if item['estado'] == 'ok':
                ESTADO['con_foto'] += 1
            else:
                ESTADO['sin_foto'] += 1

        estado_txt = 'OK ' if item['estado'] == 'ok' else '-- '
        print(f'[{ESTADO["procesados"]}/{ESTADO["total"]}] {estado_txt}'
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
            # Las que ya tenian foto de una corrida anterior entran a la pagina
            # sin candidatas: se buscan recien cuando alguien pide otra, para no
            # gastar una consulta por producto que quiza nadie mire.
            with CANDADO:
                falta_buscar = not item.get('buscada')
            if falta_buscar:
                consulta = item.get('consulta') or bf.armar_consulta(item)
                candidatas = bf.buscar(consulta, self.clave, cantidad=8)
                for c in candidatas:
                    c['puntaje'] = puntuar(c, item)
                candidatas.sort(key=lambda c: -c['puntaje'])
                with CANDADO:
                    item.update({'consulta': consulta, 'candidatas': candidatas,
                                 'buscada': True, 'indice': -1})

            # Se avanza hasta la primera que se pueda bajar y subir. Muchas
            # fallan por certificado vencido, hotlink bloqueado o un enlace que
            # ya no existe, y quedarse en la primera que falla dejaba el boton
            # apretando siempre sobre la misma.
            fallos = []
            while True:
                with CANDADO:
                    siguiente = item['indice'] + 1
                    candidata = (item['candidatas'][siguiente]
                                 if siguiente < len(item['candidatas']) else None)
                if not candidata:
                    self._responder(json.dumps({
                        'ok': False,
                        'motivo': fallos[-1] if fallos else 'No quedan candidatas.',
                    }))
                    return

                try:
                    with CANDADO_SUBIDA:
                        url, peso, tam = publicar(self.db, self.bucket, item,
                                                  candidata, self.simular)
                    break
                except Exception as e:
                    fallos.append(f'{candidata["origen"]}: {str(e)[:70]}')
                    with CANDADO:
                        item['indice'] = siguiente

            with CANDADO:
                if item['estado'] != 'ok':
                    ESTADO['con_foto'] += 1
                    ESTADO['sin_foto'] -= 1
                item.update({
                    'indice': siguiente, 'url': url, 'origen': candidata['origen'],
                    'titulo': candidata['titulo'], 'puntaje': candidata['puntaje'],
                    'peso': peso, 'medidas': f'{tam[0]}x{tam[1]}', 'estado': 'ok',
                })
            self._responder(json.dumps({'ok': True, 'saltadas': len(fallos)}))
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
  .card[data-estado="quitada"] .foto, .card[data-estado="sin_candidata"] .foto { background:var(--fondo); }
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
  el.innerHTML = `
    <div class="foto">
      ${it.url
        ? `<img src="${it.url}" alt="" loading="lazy">
           <span class="puntaje">${it.puntaje.toFixed(2)}</span>`
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
    </div>`;

  // textContent y no innerHTML: los nombres y los títulos vienen de páginas
  // ajenas y no tienen por qué ser HTML válido ni inofensivo.
  el.querySelector('.nombre').textContent = it.nombre;
  el.querySelector('.origen').textContent = it.origen || '';
  el.querySelector('.consulta').textContent = it.consulta;

  const otra = el.querySelector('[data-act="otra"]');
  const quitar = el.querySelector('[data-act="quitar"]');
  otra.disabled = !it.quedan;
  quitar.disabled = !it.url;

  el.addEventListener('click', async ev => {
    const act = ev.target.closest('[data-act]');
    if (!act) return;

    const etiqueta = act.textContent;
    act.disabled = true;
    act.textContent = act.dataset.act === 'otra' ? 'Buscando…' : '…';

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
    const firma = `${it.estado}|${it.url}|${it.quedan}`;
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

def elegir_productos(db, cantidad, solo_con_marca, meses=4):
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
            'importe': round(importe.get(bf.normalizar(nombre_original.get(d.id, '')), 0)),
        }
        imagenes = x.get('imagenes') or []
        if imagenes:
            p['imagen'] = imagenes[0]
            con_foto.append(p)
        else:
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
    ap.add_argument('--simular', action='store_true',
                    help='busca y puntua, pero no sube ni escribe nada')
    args = ap.parse_args()

    clave = bf.claves_serper()
    if not clave:
        sys.exit('Falta SERPER_API_KEY en claves_google.txt')
    print(f'{len(clave)} clave{"s" if len(clave) > 1 else ""} de Serper cargada'
          f'{"s" if len(clave) > 1 else ""}.')

    db, bucket = imp.conectar()

    print('Buscando productos sin foto...')
    productos, ya = elegir_productos(db, args.cantidad, args.solo_con_marca)
    if not productos and not ya:
        sys.exit('No hay productos que cumplan el filtro.')

    # Las de corridas anteriores entran a la pagina ya resueltas, sin candidatas:
    # se buscan recien si alguien pide otra.
    for p in ya:
        ESTADO['items'].append({
            **p, 'consulta': '', 'candidatas': [], 'buscada': False, 'indice': -1,
            'url': p['imagen'], 'origen': '', 'titulo': '', 'puntaje': 0,
            'peso': 0, 'estado': 'ok',
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
