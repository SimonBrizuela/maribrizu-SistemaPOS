"""
Carga fotos de producto a la tienda desde una carpeta.

Da lo mismo de donde vengan las fotos (camara del celular, catalogo que mando un
proveedor, escaneo): se dejan todas en una carpeta con el codigo del producto
como nombre de archivo y este script hace el resto.

    105894.jpg
    105894_2.jpg     <- segunda foto del mismo producto
    01GR228.png

Que hace con cada una:
  1. La achica a 900 px de lado mayor y la convierte a WebP.
     Una foto de celular pesa 4 MB. Sin este paso, una grilla de veinte
     productos son 80 MB que el cliente descarga con datos moviles.
  2. La sube a Firebase Storage bajo tienda/<codigo>/.
  3. Deja la URL en el catalogo y en la tienda, asi la foto aparece sin
     esperar al proximo sync.

    python scripts/importar_fotos.py fotos/
    python scripts/importar_fotos.py fotos/ --simular
"""
import argparse
import os
import re
import sys
from urllib.parse import quote

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import firebase_admin
from firebase_admin import credentials, firestore, storage
from PIL import Image, ImageOps

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUCKET = 'mari-d7c71.firebasestorage.app'

LADO_MAYOR = 900
CALIDAD = 82
EXTENSIONES = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff'}


def conectar():
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(
            credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')),
            {'storageBucket': BUCKET})
    return firestore.client(), storage.bucket(BUCKET)


def partir_nombre(archivo):
    """'105894_2.jpg' -> ('105894', 2)   ·   '105894.jpg' -> ('105894', 1)"""
    base = os.path.splitext(os.path.basename(archivo))[0].strip()
    m = re.match(r'^(.+?)_(\d+)$', base)
    if m:
        return m.group(1), int(m.group(2))
    return base, 1


def preparar(ruta):
    """Achica, corrige la orientacion y devuelve los bytes en WebP."""
    from io import BytesIO
    with Image.open(ruta) as im:
        # Las fotos de celular traen la orientacion en los metadatos EXIF. Sin
        # esto, la mitad sale acostada.
        im = ImageOps.exif_transpose(im)

        if im.mode in ('RGBA', 'LA', 'P'):
            # WebP soporta transparencia, pero un PNG de catalogo con fondo
            # transparente sobre la card blanca se ve mejor con fondo blanco
            # solido que con el gris de la superficie.
            fondo = Image.new('RGB', im.size, (255, 255, 255))
            im = im.convert('RGBA')
            fondo.paste(im, mask=im.split()[-1])
            im = fondo
        else:
            im = im.convert('RGB')

        im.thumbnail((LADO_MAYOR, LADO_MAYOR), Image.LANCZOS)

        buf = BytesIO()
        im.save(buf, format='WEBP', quality=CALIDAD, method=6)
        return buf.getvalue(), im.size


def url_publica(ruta_storage):
    """
    URL de descarga sin token.

    storage.rules deja `tienda/` en lectura publica, asi que no hace falta
    generar un token de descarga por archivo ni firmar URLs que vencen.
    """
    return (f'https://firebasestorage.googleapis.com/v0/b/{BUCKET}/o/'
            f'{quote(ruta_storage, safe="")}?alt=media')


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('carpeta', help='carpeta con las fotos')
    ap.add_argument('--simular', action='store_true',
                    help='muestra que haria, sin subir ni escribir')
    args = ap.parse_args()

    carpeta = os.path.abspath(args.carpeta)
    if not os.path.isdir(carpeta):
        sys.exit(f'No existe la carpeta {carpeta}')

    db, bucket = conectar()

    # ── Agrupar los archivos por producto ─────────────────────────────────
    por_producto = {}
    ignorados = []
    for nombre in sorted(os.listdir(carpeta)):
        ruta = os.path.join(carpeta, nombre)
        if not os.path.isfile(ruta):
            continue
        if os.path.splitext(nombre)[1].lower() not in EXTENSIONES:
            ignorados.append(nombre)
            continue
        codigo, orden = partir_nombre(nombre)
        por_producto.setdefault(codigo, []).append((orden, ruta))

    if ignorados:
        print(f'{len(ignorados)} archivos ignorados (no son imagenes)\n')

    if not por_producto:
        sys.exit('No encontre imagenes en la carpeta.')

    print(f'{len(por_producto)} productos con foto en {carpeta}\n')

    # ── Verificar que los codigos existan ─────────────────────────────────
    # Se busca por el campo `codigo`, que es lo que la persona ve en el POS y en
    # la etiqueta, y no por el id del documento.
    encontrados = {}
    for codigo in por_producto:
        docs = list(db.collection('catalogo').where('codigo', '==', codigo).limit(1).stream())
        if not docs:
            doc = db.collection('catalogo').document(codigo).get()
            if doc.exists:
                docs = [doc]
        if docs:
            encontrados[codigo] = docs[0].id

    faltantes = set(por_producto) - set(encontrados)
    if faltantes:
        print(f'{len(faltantes)} codigos que no estan en el catalogo:')
        for c in sorted(faltantes)[:20]:
            print(f'  {c}')
        if len(faltantes) > 20:
            print(f'  ... y {len(faltantes) - 20} mas')
        print()

    if not encontrados:
        sys.exit('Ninguno de los codigos existe en el catalogo.')

    # ── Procesar y subir ──────────────────────────────────────────────────
    total_original = 0
    total_final = 0
    subidos = 0

    for codigo, archivos in sorted(por_producto.items()):
        doc_id = encontrados.get(codigo)
        if not doc_id:
            continue

        urls = []
        for orden, ruta in sorted(archivos):
            datos, tam = preparar(ruta)
            peso_original = os.path.getsize(ruta)
            total_original += peso_original
            total_final += len(datos)

            ruta_storage = f'tienda/{codigo}/{orden}.webp'
            print(f'  {codigo:<14} {os.path.basename(ruta):<28} '
                  f'{peso_original/1024:>7.0f} KB -> {len(datos)/1024:>6.0f} KB  '
                  f'{tam[0]}x{tam[1]}')

            if not args.simular:
                blob = bucket.blob(ruta_storage)
                blob.cache_control = 'public, max-age=31536000, immutable'
                blob.upload_from_string(datos, content_type='image/webp')

            urls.append(url_publica(ruta_storage))
            subidos += 1

        if not args.simular:
            # Se escribe en el catalogo, que es la fuente de verdad, y tambien en
            # el espejo, para que la foto se vea sin esperar al proximo sync.
            db.collection('catalogo').document(doc_id).set(
                {'tienda_imagenes': urls}, merge=True)
            db.collection('tienda_productos').document(doc_id).set(
                {'imagenes': urls}, merge=True)

    ahorro = 100 - (total_final * 100 // max(total_original, 1))
    print(f'\n{subidos} imagenes de {len(encontrados)} productos')
    print(f'{total_original/1048576:.1f} MB -> {total_final/1048576:.1f} MB  ({ahorro}% menos)')

    if args.simular:
        print('\n(simulacion: no se subio ni se escribio nada)')
    else:
        print('\nYa se ven en la tienda. Recarga la pagina.')


if __name__ == '__main__':
    main()
