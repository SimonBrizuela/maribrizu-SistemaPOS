"""
bulk_import_catalog.py
──────────────────────
Detecta articulos nuevos desde un CSV contra el catalogo de Firebase,
y genera codigos internos y codigos de barras unicos que no colisionen
con los existentes.

NO sube nada a Firebase: solo genera un archivo de salida listo para
que vos lo revises y subas manualmente.

Uso:
    python bulk_import_catalog.py "Accesorios - ACCESORIOS.csv" ACCESORIOS
    python bulk_import_catalog.py <ruta_csv> <rubro>

Salida:
    bulk_import_preview_<rubro>.csv   - Articulos nuevos con codigos generados
    bulk_import_existentes_<rubro>.csv - Articulos que ya estaban (para revisar)

Requiere:
    firebase_key.json en la raiz
"""
import csv
import os
import re
import sys
import io
import unicodedata
import logging
from datetime import datetime, timezone
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)

BARCODE_RE = re.compile(r'^[A-Za-z0-9\-_]{3,50}$')
CODIGO_RE = re.compile(r'^[A-Za-z0-9\-_]{2,50}$')


def slugify(text):
    text = str(text).strip().upper()
    text = unicodedata.normalize('NFKD', text)
    text = ''.join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r'[^A-Z0-9]+', '-', text)
    return text.strip('-')[:120]


def parse_num(val):
    if not val:
        return 0.0
    val = re.sub(r'[^\d,.\-]', '', str(val).strip())
    if not val or val in ('-', '.', ','):
        return 0.0
    if ',' in val and '.' in val:
        if val.rfind(',') > val.rfind('.'):
            val = val.replace('.', '').replace(',', '.')
        else:
            val = val.replace(',', '')
    elif ',' in val:
        val = val.replace(',', '.')
    elif '.' in val:
        parts = val.split('.')
        if len(parts) == 2 and len(parts[1]) == 3 and len(parts[0]) >= 1:
            val = val.replace('.', '')
    try:
        return float(val)
    except ValueError:
        return 0.0


def calc_precio_venta(costo, margen_pct):
    if costo <= 0:
        return 0.0
    return round(costo * (1 + margen_pct / 100), 2)


def limpiar_nombre(nombre):
    if not nombre:
        return ''
    nombre = re.sub(r'[^\x20-\x7E\xC0-\xFF\u00C0-\u024F\u00A0-\u00FF]', '', nombre)
    return nombre.strip().strip('"\'').strip()


def es_fila_valida(nombre):
    if not nombre:
        return False
    invalidos = {'*', '* USAR EN PAPELERA', '-', 'N/A', 'SIN NOMBRE', ''}
    if nombre.upper() in invalidos:
        return False
    if re.match(r'^[\*\-\s]+$', nombre):
        return False
    return True


def parse_csv(filepath, rubro_canonico):
    productos = []
    with open(filepath, encoding='utf-8-sig', errors='replace') as f:
        reader = csv.reader(f)
        headers = [h.strip() for h in next(reader)]
        h = {v: i for i, v in enumerate(headers)}

        idx_cod    = h.get('Codigo', h.get('Cod Producto', -1))
        idx_nombre = h.get('Producto', 1)
        idx_barra  = h.get('Cod Barra', -1)
        idx_subrub = h.get('Sub Rubro', -1)
        idx_prov   = h.get('Proveedor', -1)
        idx_marca  = h.get('Marca', -1)
        idx_costo  = h.get('Costo', -1)
        idx_margen = h.get('Porc. Utilidad', -1)

        for row in reader:
            if not any(c.strip() for c in row):
                continue

            def get(idx, default=''):
                if idx < 0 or idx >= len(row):
                    return default
                return row[idx].strip()

            nombre = limpiar_nombre(get(idx_nombre))
            if not es_fila_valida(nombre):
                continue

            costo = parse_num(get(idx_costo))
            margen = parse_num(get(idx_margen))
            precio = calc_precio_venta(costo, margen)

            productos.append({
                'codigo':       get(idx_cod),
                'nombre':       nombre.upper(),
                'cod_barra':    get(idx_barra),
                'rubro':        rubro_canonico,
                'sub_rubro':    get(idx_subrub).upper(),
                'proveedor':    (get(idx_prov) or 'SIN PROVEEDOR').strip(),
                'marca':        (get(idx_marca).upper() or 'SIN MARCA').strip(),
                'moneda':       'PESOS',
                'costo':        costo,
                'margen':       margen,
                'precio_venta': precio,
            })
    return productos


def cargar_catalogo_existente(db):
    logger.info("Leyendo catalogo existente de Firebase...")
    docs = list(db.collection('catalogo').stream())
    logger.info(f"  {len(docs)} documentos en catalogo")

    codigos_usados = set()
    barcodes_usados = set()
    nombres_slug_map = {}

    for doc in docs:
        d = doc.to_dict()
        cod = str(d.get('codigo') or '').strip()
        if cod:
            codigos_usados.add(cod.upper())
        cod_interno = str(d.get('codigo_interno') or '').strip()
        if cod_interno:
            codigos_usados.add(cod_interno.upper())
        barra = str(d.get('cod_barra') or '').strip()
        if barra:
            barcodes_usados.add(barra)
        nombre = d.get('nombre') or ''
        if nombre:
            nombres_slug_map[slugify(nombre)] = doc.id

    return codigos_usados, barcodes_usados, nombres_slug_map


def siguiente_pos_id(barcodes_usados, start_from=1):
    n = start_from
    usados_pos = set()
    for b in barcodes_usados:
        m = re.match(r'^POS(\d+)$', b)
        if m:
            try:
                usados_pos.add(int(m.group(1)))
            except ValueError:
                pass
    if usados_pos:
        n = max(usados_pos) + 1
    return n


def siguiente_auto_id(codigos_usados, start_from=1):
    n = start_from
    usados_auto = set()
    for c in codigos_usados:
        m = re.match(r'^AUTO-(\d+)$', c)
        if m:
            try:
                usados_auto.add(int(m.group(1)))
            except ValueError:
                pass
    if usados_auto:
        n = max(usados_auto) + 1
    return n


def escribir_preview(productos_nuevos, rubro):
    out_path = f'bulk_import_preview_{slugify(rubro)}.csv'
    headers = [
        'codigo', 'nombre', 'cod_barra', 'rubro', 'sub_rubro',
        'proveedor', 'marca', 'moneda', 'costo', 'margen', 'precio_venta',
        'generado_codigo', 'generado_barra', 'doc_id_propuesto',
    ]
    with open(out_path, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for p in productos_nuevos:
            w.writerow(p)
    logger.info(f"  Escrito: {out_path}")
    return out_path


def escribir_existentes(existentes, rubro):
    out_path = f'bulk_import_existentes_{slugify(rubro)}.csv'
    headers = ['codigo', 'nombre', 'cod_barra', 'motivo', 'doc_id_existente']
    with open(out_path, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for p in existentes:
            w.writerow(p)
    logger.info(f"  Escrito: {out_path}")
    return out_path


def main():
    if len(sys.argv) < 3:
        print("Uso: python bulk_import_catalog.py <archivo.csv> <rubro>")
        print("Ejemplo: python bulk_import_catalog.py \"Accesorios - ACCESORIOS.csv\" ACCESORIOS")
        sys.exit(1)

    csv_path = sys.argv[1]
    rubro = sys.argv[2].upper().strip()

    if not os.path.exists(csv_path):
        logger.error(f"No existe el archivo: {csv_path}")
        sys.exit(1)

    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
    except ImportError:
        logger.error("Instalar: pip install firebase-admin")
        sys.exit(1)

    key_candidates = ['firebase_key.json', os.path.join(os.path.dirname(__file__), 'firebase_key.json')]
    key_path = next((p for p in key_candidates if os.path.exists(p)), None)
    if not key_path:
        logger.error("No se encontro firebase_key.json")
        sys.exit(1)

    try:
        firebase_admin.get_app()
    except ValueError:
        cred = credentials.Certificate(key_path)
        firebase_admin.initialize_app(cred)

    db = firestore.client()
    logger.info("Firebase conectado OK")

    codigos_usados, barcodes_usados, nombres_slug_map = cargar_catalogo_existente(db)
    logger.info(f"  Codigos usados:   {len(codigos_usados)}")
    logger.info(f"  Barcodes usados:  {len(barcodes_usados)}")
    logger.info(f"  Nombres unicos:   {len(nombres_slug_map)}")

    print(f"\nParsing CSV: {csv_path}")
    productos = parse_csv(csv_path, rubro)
    print(f"  {len(productos)} filas validas")

    nuevos = []
    existentes = []
    contador_auto = siguiente_auto_id(codigos_usados)
    contador_pos = siguiente_pos_id(barcodes_usados)

    nombres_slug_nuevos = set()
    codigos_nuevos = set()
    barras_nuevos = set()

    for p in productos:
        nombre = p['nombre']
        nombre_slug = slugify(nombre)
        codigo_csv = (p['codigo'] or '').strip().upper()
        barra_csv = (p['cod_barra'] or '').strip()

        if nombre_slug in nombres_slug_map:
            existentes.append({
                'codigo': p['codigo'],
                'nombre': nombre,
                'cod_barra': p['cod_barra'],
                'motivo': 'nombre_ya_existe',
                'doc_id_existente': nombres_slug_map[nombre_slug],
            })
            continue

        if codigo_csv and codigo_csv in codigos_usados:
            existentes.append({
                'codigo': p['codigo'],
                'nombre': nombre,
                'cod_barra': p['cod_barra'],
                'motivo': 'codigo_ya_existe',
                'doc_id_existente': '',
            })
            continue

        if nombre_slug in nombres_slug_nuevos:
            existentes.append({
                'codigo': p['codigo'],
                'nombre': nombre,
                'cod_barra': p['cod_barra'],
                'motivo': 'duplicado_en_csv',
                'doc_id_existente': '',
            })
            continue

        codigo_final = codigo_csv
        genero_codigo = False
        if not codigo_final or not CODIGO_RE.match(codigo_final) or codigo_final in codigos_nuevos:
            while True:
                candidato = f'AUTO-{contador_auto}'
                contador_auto += 1
                if candidato not in codigos_usados and candidato not in codigos_nuevos:
                    codigo_final = candidato
                    genero_codigo = True
                    break

        barra_final = barra_csv
        genero_barra = False
        if not barra_final or not BARCODE_RE.match(barra_final) or barra_final in barcodes_usados or barra_final in barras_nuevos:
            while True:
                candidato = f'POS{contador_pos}'
                contador_pos += 1
                if candidato not in barcodes_usados and candidato not in barras_nuevos:
                    barra_final = candidato
                    genero_barra = True
                    break

        doc_id = slugify(codigo_final) or slugify(nombre)

        nuevos.append({
            'codigo':           codigo_final,
            'nombre':           nombre,
            'cod_barra':        barra_final,
            'rubro':            p['rubro'],
            'sub_rubro':        p['sub_rubro'],
            'proveedor':        p['proveedor'],
            'marca':            p['marca'],
            'moneda':           p['moneda'],
            'costo':            p['costo'],
            'margen':           p['margen'],
            'precio_venta':     p['precio_venta'],
            'generado_codigo':  'SI' if genero_codigo else 'NO',
            'generado_barra':   'SI' if genero_barra else 'NO',
            'doc_id_propuesto': doc_id,
        })

        codigos_nuevos.add(codigo_final)
        barras_nuevos.add(barra_final)
        nombres_slug_nuevos.add(nombre_slug)

    print("\n=== RESUMEN ===")
    print(f"  Nuevos a cargar:  {len(nuevos)}")
    print(f"  Ya existentes:    {len(existentes)}")
    if nuevos:
        con_cod_generado = sum(1 for n in nuevos if n['generado_codigo'] == 'SI')
        con_barra_generada = sum(1 for n in nuevos if n['generado_barra'] == 'SI')
        print(f"    con codigo generado:  {con_cod_generado}")
        print(f"    con barra generada:   {con_barra_generada}")

    print("\nEscribiendo archivos de preview...")
    if nuevos:
        escribir_preview(nuevos, rubro)
    if existentes:
        escribir_existentes(existentes, rubro)
    print("\nListo. Revisa los CSV y subilos vos a Firebase cuando quieras.\n")


if __name__ == '__main__':
    main()
