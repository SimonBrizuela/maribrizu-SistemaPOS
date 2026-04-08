"""
csv_to_firebase.py
──────────────────
Carga masiva de todos los CSV de rubros a la colección 'catalogo' de Firestore.
- Lee y limpia los datos de cada CSV
- Calcula precio de venta desde costo + margen
- Evita duplicados por código y por nombre
- Sube en batches PEQUEÑOS con pausas generosas → no explota el free tier
- Primero actualiza 'config/rubros' con la lista maestra de rubros y sub-rubros

Plan Firestore Spark (GRATIS):
  - 20.000 escrituras/día → 4.576 productos = muy por debajo del límite
  - Batches de 100 docs con 2s de pausa = ~1 batch por 2 segundos → sin throttling

Uso:
    python csv_to_firebase.py

Requiere:
    pip install firebase-admin
    firebase_key.json en la raíz del proyecto
"""

import csv
import os
import re
import time
import unicodedata
import logging
from datetime import datetime
from pathlib import Path

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)

# ── Configuración ──────────────────────────────────────────────────────────────
# Conservador para no saturar Firebase ni generar costos inesperados.
# Con 4.576 productos totales y batches de 100:
#   → ~46 batches × 2s pausa = ~92 segundos de carga total (~1.5 min)
#   → Muy por debajo del límite de 20.000 escrituras/día del plan gratuito
BATCH_SIZE            = 100   # docs por batch (conservador, máx permitido: 500)
PAUSE_BETWEEN_BATCHES = 2.0   # segundos entre batches (generoso, evita throttling)
PAUSE_BETWEEN_RUBROS  = 5.0   # segundos entre rubros (respiro extra entre archivos)

# ── Mapa de archivos CSV → rubro canónico ──────────────────────────────────────
CSV_FILES = [
    ("Accesorios - ACCESORIOS.csv",                            "ACCESORIOS"),
    ("Jugueteria - JUGUETERIA.csv",                            "JUGUETERIA"),
    ("Lenceria - LENCERIA.csv",                                "LENCERIA"),
    ("Merceria - MERCERIA.csv",                                "MERCERIA"),
    ("Navidad - NAVIDAD.csv",                                  "NAVIDAD"),
    ("papelera - PAPELERA.csv",                                "PAPELERA"),
    ("Perfumeria - PERFUMERIA.csv",                            "PERFUMERIA"),
    ("Regaleria - REGALERIA.csv",                              "REGALERIA"),
    ("sellos - SELLOS.csv",                                    "SELLOS"),
    ("Servicios Extra - SERVICIOS (Precios Finales).csv",      "SERVICIOS"),
]

# ── Helpers ────────────────────────────────────────────────────────────────────

def slugify(text: str) -> str:
    """Convierte texto a slug seguro para ID de Firestore."""
    text = str(text).strip().upper()
    # Normalizar caracteres unicode (quita acentos)
    text = unicodedata.normalize('NFKD', text)
    text = ''.join(c for c in text if not unicodedata.combining(c))
    # Reemplazar caracteres no alfanuméricos por guión
    text = re.sub(r'[^A-Z0-9]+', '-', text)
    return text.strip('-')[:120]  # máx 120 chars para IDs de Firestore


def parse_num(val: str) -> float:
    """Parsea número con formato español: '1.234,56' o '1234.56' → float."""
    if not val:
        return 0.0
    # Eliminar emojis y caracteres no numéricos excepto , . - 
    val = re.sub(r'[^\d,.\-]', '', str(val).strip())
    if not val or val in ('-', '.', ','):
        return 0.0
    # Detectar formato español: tiene coma como decimal y punto como miles
    # Ej: "1.200,50"
    if ',' in val and '.' in val:
        # El último separador es el decimal
        if val.rfind(',') > val.rfind('.'):
            # Formato: 1.200,50
            val = val.replace('.', '').replace(',', '.')
        else:
            # Formato: 1,200.50 (inglés)
            val = val.replace(',', '')
    elif ',' in val:
        # Solo coma → decimal español: "1200,50"
        val = val.replace(',', '.')
    # Si tiene punto y no coma, podría ser miles o decimal
    # Heurístico: si hay exactamente 3 dígitos después del punto → miles
    elif '.' in val:
        parts = val.split('.')
        if len(parts) == 2 and len(parts[1]) == 3 and len(parts[0]) >= 1:
            val = val.replace('.', '')  # miles
        # else: decimal normal (ya tiene punto)
    try:
        return float(val)
    except ValueError:
        return 0.0


def calc_precio_venta(costo: float, margen_pct: float) -> float:
    """
    Calcula precio de venta dado costo y margen de utilidad porcentual.
    margen_pct = 120 → precio = costo * 2.20 (markup 120%)
    """
    if costo <= 0:
        return 0.0
    return round(costo * (1 + margen_pct / 100), 2)


def limpiar_nombre(nombre: str) -> str:
    """Limpia emojis y caracteres de control del nombre del producto."""
    if not nombre:
        return ''
    # Eliminar emojis y caracteres de control
    nombre = re.sub(r'[^\x20-\x7E\xC0-\xFF\u00C0-\u024F\u00A0-\u00FF]', '', nombre)
    nombre = nombre.strip()
    # Eliminar comillas sueltas al inicio/final
    nombre = nombre.strip('"\'')
    return nombre.strip()


def es_fila_valida(nombre: str, codigo: str) -> bool:
    """Descarta filas sin nombre válido o marcadas como placeholder."""
    if not nombre:
        return False
    invalidos = {'*', '* USAR EN PAPELERA', '-', 'N/A', 'SIN NOMBRE', ''}
    if nombre.upper() in invalidos:
        return False
    # Filas que son solo asteriscos o guiones
    if re.match(r'^[\*\-\s]+$', nombre):
        return False
    return True


def today_str() -> str:
    return datetime.now().strftime('%d/%m/%Y')


# ── Parsers especializados por tipo de CSV ──────────────────────────────────────

def parse_csv_estandar(filepath: str, rubro_canonico: str) -> list:
    """
    Parser para: Accesorios, Jugueteria, Lenceria, Merceria,
                 Papelera, Perfumeria, Regaleria, Sellos
    Columnas: Codigo/Cod Producto, Producto, Cod Barra, Rubro, Sub Rubro,
              Proveedor, Marca, Moneda, Costo, Porc. Utilidad
    """
    productos = []
    seen_codigos = {}   # codigo → índice (para detectar duplicados)
    seen_nombres = {}   # nombre_slug → índice

    with open(filepath, encoding='utf-8-sig', errors='replace') as f:
        reader = csv.reader(f)
        headers = [h.strip() for h in next(reader)]
        h = {v: i for i, v in enumerate(headers)}

        # Detectar columna de código (varía entre archivos)
        idx_cod     = h.get('Codigo', h.get('Cod Producto', -1))
        idx_nombre  = h.get('Producto', 1)
        idx_barra   = h.get('Cod Barra', -1)
        idx_rubro   = h.get('Rubro', -1)
        idx_subrub  = h.get('Sub Rubro', -1)
        idx_prov    = h.get('Proveedor', -1)
        idx_marca   = h.get('Marca', -1)
        idx_costo   = h.get('Costo', -1)
        idx_margen  = h.get('Porc. Utilidad', -1)

        for row_num, row in enumerate(reader, start=2):
            if not any(c.strip() for c in row):
                continue  # fila vacía

            def get(idx, default=''):
                if idx < 0 or idx >= len(row):
                    return default
                return row[idx].strip()

            nombre  = limpiar_nombre(get(idx_nombre))
            codigo  = get(idx_cod)
            if not es_fila_valida(nombre, codigo):
                continue

            nombre_up = nombre.upper()
            costo     = parse_num(get(idx_costo))
            margen    = parse_num(get(idx_margen))
            precio    = calc_precio_venta(costo, margen)
            subrub    = get(idx_subrub).upper().strip()
            proveedor = get(idx_prov) or 'SIN PROVEEDOR'
            marca     = get(idx_marca).upper() or 'SIN MARCA'
            cod_barra = get(idx_barra)

            # Calcular estado
            if costo == 0:
                estado = 'sin_precio'
            else:
                estado = 'activo'

            # Detectar duplicado por código
            dup_cod = False
            if codigo and codigo in seen_codigos:
                dup_cod = True
                productos[seen_codigos[codigo]]['duplicado'] = True

            # Detectar duplicado por nombre
            nombre_slug = slugify(nombre_up)
            dup_nombre = False
            if nombre_slug in seen_nombres:
                dup_nombre = True
                productos[seen_nombres[nombre_slug]]['duplicado'] = True

            duplicado = dup_cod or dup_nombre

            producto = {
                'codigo':               codigo,
                'nombre':               nombre_up,
                'cod_barra':            cod_barra,
                'rubro':                rubro_canonico,
                'sub_rubro':            subrub,
                'proveedor':            proveedor.strip(),
                'marca':                marca.strip(),
                'moneda':               'PESOS',
                'costo':                costo,
                'margen':               margen,
                'precio_venta':         precio,
                'stock':                0,
                'estado':               estado,
                'duplicado':            duplicado,
                'ultima_actualizacion': today_str(),
                'fuente':               'csv_import',
            }

            if codigo and not dup_cod:
                seen_codigos[codigo] = len(productos)
            if not dup_nombre:
                seen_nombres[nombre_slug] = len(productos)

            productos.append(producto)

    return productos


def parse_csv_navidad(filepath: str) -> list:
    """
    Parser especial para Navidad.
    Columnas extra: Venta (precio de venta directo), 2024 (precio anterior)
    Si tiene precio de venta directo, lo usa en vez de calcular desde costo+margen.
    """
    productos = []
    seen_nombres = {}

    with open(filepath, encoding='utf-8-sig', errors='replace') as f:
        reader = csv.reader(f)
        headers = [h.strip() for h in next(reader)]
        h = {v: i for i, v in enumerate(headers)}

        idx_cod    = h.get('Codigo', 0)
        idx_nombre = h.get('Producto', 1)
        idx_barra  = h.get('Cod Barra', 2)
        idx_subrub = h.get('Sub Rubro', 4)
        idx_prov   = h.get('Proveedor', 5)
        idx_marca  = h.get('Marca', 6)
        idx_costo  = h.get('Costo', 8)
        idx_margen = h.get('Porc. Utilidad', 9)
        idx_venta  = h.get('Venta', -1)   # precio de venta directo

        for row in reader:
            if not any(c.strip() for c in row):
                continue

            def get(idx, default=''):
                if idx < 0 or idx >= len(row):
                    return default
                return row[idx].strip()

            nombre = limpiar_nombre(get(idx_nombre))
            if not es_fila_valida(nombre, get(idx_cod)):
                continue

            nombre_up = nombre.upper()
            costo     = parse_num(get(idx_costo))
            margen    = parse_num(get(idx_margen))
            venta_dir = parse_num(get(idx_venta))

            # Precio final: directo si está disponible, sino calcular
            if venta_dir > 0:
                precio = venta_dir
            elif margen > 0:
                precio = calc_precio_venta(costo, margen)
            else:
                precio = costo  # sin margen definido, usar costo

            estado = 'sin_precio' if precio == 0 else 'activo'

            nombre_slug = slugify(nombre_up)
            duplicado = False
            if nombre_slug in seen_nombres:
                duplicado = True
                productos[seen_nombres[nombre_slug]]['duplicado'] = True
            else:
                seen_nombres[nombre_slug] = len(productos)

            productos.append({
                'codigo':               get(idx_cod),
                'nombre':               nombre_up,
                'cod_barra':            get(idx_barra),
                'rubro':                'NAVIDAD',
                'sub_rubro':            get(idx_subrub).upper(),
                'proveedor':            get(idx_prov) or 'SIN PROVEEDOR',
                'marca':                get(idx_marca).upper() or 'SIN MARCA',
                'moneda':               'PESOS',
                'costo':                costo,
                'margen':               margen,
                'precio_venta':         precio,
                'stock':                0,
                'estado':               estado,
                'duplicado':            duplicado,
                'ultima_actualizacion': today_str(),
                'fuente':               'csv_import',
            })

    return productos


def parse_csv_servicios(filepath: str) -> list:
    """
    Parser especial para Servicios Extra.
    Columnas: Cod Producto, Producto, Cod Barra, Rubro, Sub Rubro,
              Tiempo (min), Costo Mano Obra/min, Costo Insumos, ...
              Venta Final (col 16) → precio de venta ya calculado
    Ignora filas con #REF! como precio final.
    """
    productos = []
    seen_nombres = {}

    with open(filepath, encoding='utf-8-sig', errors='replace') as f:
        reader = csv.reader(f)
        headers = [h.strip() for h in next(reader)]
        h = {v: i for i, v in enumerate(headers)}

        idx_cod    = h.get('Cod Producto', 0)
        idx_nombre = h.get('Producto', 1)
        idx_barra  = h.get('Cod Barra', 2)
        idx_subrub = h.get('Sub Rubro', 4)
        # Buscar columna Venta Final (col 16 en este CSV)
        idx_venta_final = -1
        for i, hdr in enumerate(headers):
            if 'Venta Final' in hdr or hdr.strip() == 'Venta Final':
                idx_venta_final = i
                break
        if idx_venta_final < 0:
            idx_venta_final = 16  # fallback por posición

        idx_venta_bruta = -1
        for i, hdr in enumerate(headers):
            if hdr.strip() == 'Venta':
                idx_venta_bruta = i
                break

        for row in reader:
            if not any(c.strip() for c in row):
                continue

            def get(idx, default=''):
                if idx < 0 or idx >= len(row):
                    return default
                return row[idx].strip()

            nombre = limpiar_nombre(get(idx_nombre))
            codigo = get(idx_cod)
            if not es_fila_valida(nombre, codigo):
                continue

            nombre_up = nombre.upper()

            # Precio de venta final (puede tener #REF!)
            precio_str = get(idx_venta_final)
            if '#REF' in precio_str or '#' in precio_str:
                # Intentar con columna Venta
                precio_str = get(idx_venta_bruta)
            if '#REF' in precio_str or '#' in precio_str or not precio_str:
                precio = 0.0
            else:
                precio = parse_num(precio_str)

            estado = 'sin_precio' if precio == 0 else 'activo'

            nombre_slug = slugify(nombre_up)
            duplicado = False
            if nombre_slug in seen_nombres:
                duplicado = True
                productos[seen_nombres[nombre_slug]]['duplicado'] = True
            else:
                seen_nombres[nombre_slug] = len(productos)

            productos.append({
                'codigo':               codigo,
                'nombre':               nombre_up,
                'cod_barra':            get(idx_barra),
                'rubro':                'SERVICIOS',
                'sub_rubro':            get(idx_subrub).upper(),
                'proveedor':            'SIN PROVEEDOR',
                'marca':                'SIN MARCA',
                'moneda':               'PESOS',
                'costo':                0.0,   # costo interno, no relevante para web
                'margen':               0.0,
                'precio_venta':         precio,
                'stock':                -1,    # -1 = servicio (sin límite de stock)
                'estado':               estado,
                'duplicado':            duplicado,
                'tipo':                 'servicio',
                'ultima_actualizacion': today_str(),
                'fuente':               'csv_import',
            })

    return productos


# ── Carga a Firebase ──────────────────────────────────────────────────────────

def subir_a_firebase(db, productos: list, rubro: str):
    """
    Sube lista de productos a colección 'catalogo' en batches de BATCH_SIZE.
    Usa merge=True para no pisar campos editados manualmente en Firebase.
    ID del documento = codigo si existe, sino slugify(nombre).
    """
    from google.cloud import firestore as gc_firestore

    col = db.collection('catalogo')
    total = len(productos)
    subidos = 0
    omitidos = 0

    for i in range(0, total, BATCH_SIZE):
        chunk = productos[i:i + BATCH_SIZE]
        batch = db.batch()
        batch_count = 0

        for p in chunk:
            # Generar ID único y estable
            if p.get('codigo'):
                doc_id = slugify(p['codigo'])
            else:
                doc_id = slugify(p['nombre'])

            if not doc_id:
                omitidos += 1
                continue

            ref = col.document(doc_id)
            doc_data = {**p, 'doc_id': doc_id}
            batch.set(ref, doc_data, merge=True)
            batch_count += 1

        batch.commit()
        subidos += batch_count
        pct = round((i + len(chunk)) / total * 100)
        logger.info(f"  [{rubro}] {subidos}/{total} ({pct}%) ✓")
        time.sleep(PAUSE_BETWEEN_BATCHES)

    return subidos, omitidos


def actualizar_config_rubros(db, rubros_data: dict):
    """
    Actualiza la colección 'config' con:
      - doc 'rubros': lista maestra de rubros
      - doc 'sub_rubros': mapa rubro → lista de sub-rubros
    También crea/actualiza cada rubro en la colección 'rubros' (para el listener).
    """
    # Actualizar config/rubros
    rubros_lista = sorted(rubros_data.keys())
    db.collection('config').document('rubros').set({
        'lista': rubros_lista,
        'actualizado': today_str(),
        'total_rubros': len(rubros_lista),
    }, merge=True)

    # Actualizar config/sub_rubros
    sub_rubros_map = {r: sorted(list(subs)) for r, subs in rubros_data.items()}
    db.collection('config').document('sub_rubros').set({
        'mapa': sub_rubros_map,
        'actualizado': today_str(),
    }, merge=True)

    # Actualizar colección 'rubros' (para listeners del POS)
    batch = db.batch()
    for rubro in rubros_lista:
        ref = db.collection('rubros').document(slugify(rubro))
        batch.set(ref, {
            'nombre': rubro,
            'sub_rubros': sorted(list(rubros_data.get(rubro, set()))),
            'activo': True,
            'actualizado': today_str(),
        }, merge=True)
    batch.commit()

    logger.info(f"Config rubros actualizado: {rubros_lista}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    # Inicializar Firebase Admin SDK
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
    except ImportError:
        logger.error("Instalar: pip install firebase-admin")
        return

    key_candidates = ['firebase_key.json', os.path.join(os.path.dirname(__file__), 'firebase_key.json')]
    key_path = next((p for p in key_candidates if os.path.exists(p)), None)
    if not key_path:
        logger.error("No se encontró firebase_key.json")
        return

    try:
        firebase_admin.get_app()
    except ValueError:
        cred = credentials.Certificate(key_path)
        firebase_admin.initialize_app(cred)

    db = firestore.client()
    logger.info("Firebase conectado ✓")

    # Estadísticas globales
    total_subidos = 0
    total_omitidos = 0
    total_duplicados = 0
    rubros_data = {}  # rubro → set(sub_rubros)

    print("\n" + "="*60)
    print("  CARGA MASIVA CSV → FIRESTORE 'catalogo'")
    print("="*60)

    for filepath, rubro_canonico in CSV_FILES:
        if not os.path.exists(filepath):
            logger.warning(f"Archivo no encontrado: {filepath}")
            continue

        print(f"\n→ Procesando: {filepath}")

        # Seleccionar parser correcto
        if rubro_canonico == 'NAVIDAD':
            productos = parse_csv_navidad(filepath)
        elif rubro_canonico == 'SERVICIOS':
            productos = parse_csv_servicios(filepath)
        else:
            productos = parse_csv_estandar(filepath, rubro_canonico)

        # Recolectar rubros y sub-rubros
        for p in productos:
            r = p.get('rubro', rubro_canonico)
            sr = p.get('sub_rubro', '')
            if r not in rubros_data:
                rubros_data[r] = set()
            if sr:
                rubros_data[r].add(sr)

        # Stats del archivo
        activos    = sum(1 for p in productos if p['estado'] == 'activo' and not p['duplicado'])
        sin_precio = sum(1 for p in productos if p['estado'] == 'sin_precio')
        duplicados = sum(1 for p in productos if p['duplicado'])

        print(f"  Total: {len(productos)} | Activos: {activos} | Sin precio: {sin_precio} | Duplicados: {duplicados}")

        if not productos:
            logger.warning(f"  Sin productos válidos en {filepath}")
            continue

        # Subir a Firebase
        subidos, omitidos = subir_a_firebase(db, productos, rubro_canonico)
        total_subidos    += subidos
        total_omitidos   += omitidos
        total_duplicados += duplicados

        logger.info(f"  ✓ {rubro_canonico}: {subidos} subidos, {omitidos} omitidos")
        time.sleep(PAUSE_BETWEEN_RUBROS)

    # Actualizar configuración de rubros en Firebase
    print("\n→ Actualizando config/rubros y colección 'rubros'...")
    actualizar_config_rubros(db, rubros_data)

    print("\n" + "="*60)
    print("  RESUMEN FINAL")
    print("="*60)
    print(f"  Rubros cargados:      {len(rubros_data)}")
    print(f"  Productos subidos:    {total_subidos}")
    print(f"  Omitidos (sin ID):    {total_omitidos}")
    print(f"  Marcados duplicados:  {total_duplicados}")
    print(f"  Colección:            catalogo")
    print(f"  Config:               config/rubros, config/sub_rubros")
    print(f"  Rubros collection:    rubros/")
    print("="*60)
    print("\n✓ Carga completa. La web estará actualizada en tiempo real.")


if __name__ == '__main__':
    main()
