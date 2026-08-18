"""
Cuándo una lápida de `catalogo_deleted` tiene que borrar un producto local.

Al borrar un producto queda una lápida en `catalogo_deleted/{codigo}`, y cada PC
la usa para sacar ese producto de su base. El problema aparece cuando el código
se reutiliza: los generadores reparten el número de un producto borrado, así que
un producto NUEVO puede nacer con un código que ya tiene lápida. Con la regla
vieja —"si hay lápida, borrar"— el POS bajaba el producto, veía la lápida y lo
borraba. El producto existía en la nube y en el panel, y en la caja no aparecía.

La regla es: **manda el catálogo**. La lápida solo borra si el producto no está
en `catalogo`, o si es posterior a la última señal de vida del producto
(`fecha_creacion` / `ultima_actualizacion`).

Un producto vivo con lápida vieja se queda; una lápida nueva sobre un producto
que no se tocó después sí borra, que es el borrado de verdad.
"""
from datetime import datetime, timezone
from typing import Optional


def _utc(valor) -> Optional[datetime]:
    """Normaliza a datetime con zona. Acepta datetime o ISO string."""
    if isinstance(valor, datetime):
        return valor if valor.tzinfo else valor.replace(tzinfo=timezone.utc)
    if isinstance(valor, str) and valor.strip():
        for formato in ('%Y-%m-%dT%H:%M:%S.%f%z', '%Y-%m-%dT%H:%M:%S%z',
                        '%Y-%m-%dT%H:%M:%S.%f', '%Y-%m-%dT%H:%M:%S',
                        '%Y-%m-%d %H:%M:%S.%f', '%Y-%m-%d %H:%M:%S'):
            try:
                dt = datetime.strptime(valor.strip(), formato)
                return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
            except ValueError:
                continue
    return None


def senal_de_vida(producto: Optional[dict]) -> Optional[datetime]:
    """La fecha más reciente que dice que el producto está en uso."""
    if not producto:
        return None
    fechas = [_utc(producto.get('fecha_creacion')),
              _utc(producto.get('ultima_actualizacion'))]
    fechas = [f for f in fechas if f]
    return max(fechas) if fechas else None


def lapida_manda(deleted_at, producto: Optional[dict]) -> bool:
    """
    True si hay que borrar el producto local por esta lápida.

    deleted_at : `deleted_at` de la lápida (datetime o ISO string).
    producto   : el doc de `catalogo` con ese código, o None si no existe.
    """
    if producto is None:
        return True

    lapida = _utc(deleted_at)
    if lapida is None:
        # Lápida sin fecha sobre un producto que está en el catálogo: el
        # catálogo manda.
        return False

    vida = senal_de_vida(producto)
    if vida is None:
        # El producto está en el catálogo pero no sabemos de cuándo. No se
        # borra: dejar de vender algo que existe cuesta más que tener un
        # producto de más, y la reconciliación contra el catálogo lo cubre.
        return False

    return lapida > vida
