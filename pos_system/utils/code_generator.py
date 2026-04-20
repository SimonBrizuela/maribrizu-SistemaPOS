"""
Generador de codigos internos y codigos de barras unicos para productos.

Usa el patron existente:
  - Barcode: POS{n}
  - Codigo interno: AUTO-{n}

Consulta la tabla products para no colisionar con barcodes ya usados.
"""
import re
from typing import Tuple
from pos_system.database.db_manager import DatabaseManager


BARCODE_RE = re.compile(r'^[A-Za-z0-9\-_]{3,50}$')


def _next_pos_barcode(db: DatabaseManager) -> str:
    rows = db.execute_query(
        "SELECT barcode FROM products WHERE barcode LIKE 'POS%'"
    )
    max_n = 0
    for r in rows:
        b = (r.get('barcode') or '').strip()
        m = re.match(r'^POS(\d+)$', b)
        if m:
            try:
                n = int(m.group(1))
                if n > max_n:
                    max_n = n
            except ValueError:
                pass
    candidate_n = max_n + 1
    while True:
        candidate = f'POS{candidate_n}'
        existing = db.execute_query(
            "SELECT 1 FROM products WHERE barcode = ? LIMIT 1", (candidate,)
        )
        if not existing:
            return candidate
        candidate_n += 1


def _next_auto_code(db: DatabaseManager) -> str:
    rows = db.execute_query(
        "SELECT firebase_id FROM products WHERE firebase_id LIKE 'AUTO-%'"
    )
    max_n = 0
    for r in rows:
        c = (r.get('firebase_id') or '').strip()
        m = re.match(r'^AUTO-(\d+)$', c)
        if m:
            try:
                n = int(m.group(1))
                if n > max_n:
                    max_n = n
            except ValueError:
                pass
    candidate_n = max_n + 1
    while True:
        candidate = f'AUTO-{candidate_n}'
        existing = db.execute_query(
            "SELECT 1 FROM products WHERE firebase_id = ? LIMIT 1", (candidate,)
        )
        if not existing:
            return candidate
        candidate_n += 1


def generate_unique_codes(db: DatabaseManager) -> Tuple[str, str]:
    """
    Devuelve (codigo_interno, cod_barra) unicos.
    codigo_interno va al campo firebase_id (doc_id para Firebase).
    cod_barra va al campo barcode.
    """
    return _next_auto_code(db), _next_pos_barcode(db)


def is_valid_barcode(value: str) -> bool:
    if not value:
        return False
    return bool(BARCODE_RE.match(value.strip()))
