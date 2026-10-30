"""
El nombre de esta caja ("Compu 1", "Compu 2"...), puesto por un admin.

Se guarda en un archivo al lado de `machine_id.txt`, así que sobrevive a las
actualizaciones y es de esta PC sola. También se copia a `pcs/{pc_id}` (lo
escribe quien lo cambia y el heartbeat lo repite) para que lo vean las demás
cajas y el panel.
"""
import logging
import re
import socket
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

ARCHIVO = 'nombre_caja.txt'
SUGERIDOS = ('Compu 1', 'Compu 2', 'Compu 3', 'Compu 4')
LARGO_MAXIMO = 20

_cache: Optional[str] = None


def _carpeta(data_dir=None) -> Path:
    if data_dir is not None:
        return Path(data_dir)
    from pos_system.config import DATA_DIR
    return Path(DATA_DIR)


def normalizar(nombre) -> str:
    texto = re.sub(r'\s+', ' ', str(nombre or '')).strip()
    return texto[:LARGO_MAXIMO].strip()


def leer(data_dir=None) -> str:
    """El nombre guardado, o '' si nadie se lo puso todavía."""
    global _cache
    if _cache is not None and data_dir is None:
        return _cache
    try:
        ruta = _carpeta(data_dir) / ARCHIVO
        valor = normalizar(ruta.read_text(encoding='utf-8')) if ruta.exists() else ''
    except OSError as e:
        logger.warning(f'Nombre de la caja: no se pudo leer ({e})')
        valor = ''
    if data_dir is None:
        _cache = valor
    return valor


def guardar(nombre, data_dir=None) -> str:
    global _cache
    valor = normalizar(nombre)
    ruta = _carpeta(data_dir) / ARCHIVO
    ruta.write_text(valor, encoding='utf-8')
    if data_dir is None:
        _cache = valor
    return valor


def para_mostrar(nombre: str = None) -> str:
    """Lo que se ve en la cabecera: el nombre, o el de Windows si no tiene."""
    valor = leer() if nombre is None else nombre
    if valor:
        return valor
    try:
        return socket.gethostname() or 'Esta caja'
    except OSError:
        return 'Esta caja'


def _olvidar_para_pruebas():
    global _cache
    _cache = None
