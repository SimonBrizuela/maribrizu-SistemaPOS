"""
Leer una marca de tiempo venga de donde venga.

El mismo campo lo escriben tres manos distintas: el panel guarda
`serverTimestamp()` (una fecha UTC), el POS guarda texto ISO en hora de acá, y
los scripts de mantenimiento a veces una y a veces otra. Comparar eso como
texto sale mal de una forma que no se ve: `str()` de una fecha empieza
"2026-08-18 21:22" con un espacio, y el texto del POS "2026-08-18T18:24" con
una T. Como el espacio va antes que la T, la nube siempre parecía más vieja que
la PC y el sync de arranque decidía "no hay nada nuevo".

Eso dejaba productos cargados desde el panel sin bajar a las cajas hasta que
alguien los volvía a tocar. Acá se normaliza todo a fecha con zona antes de
comparar.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

TZ_AR = timezone(timedelta(hours=-3))

_FORMATOS = (
    '%Y-%m-%dT%H:%M:%S.%f%z', '%Y-%m-%dT%H:%M:%S%z',
    '%Y-%m-%dT%H:%M:%S.%f', '%Y-%m-%dT%H:%M:%S',
    '%Y-%m-%d %H:%M:%S.%f%z', '%Y-%m-%d %H:%M:%S%z',
    '%Y-%m-%d %H:%M:%S.%f', '%Y-%m-%d %H:%M:%S',
    '%Y-%m-%d',
)


def a_fecha(valor, zona_defecto=TZ_AR) -> Optional[datetime]:
    """
    Devuelve una fecha con zona, o None si el valor no se puede leer.

    Acepta lo que guarda Firestore (datetime, ya con zona), el texto ISO del
    POS y variantes con espacio o con microsegundos. Sin zona en el texto se
    asume `zona_defecto`, que es la hora de acá porque así lo escribe el POS.
    """
    if isinstance(valor, datetime):
        return valor if valor.tzinfo else valor.replace(tzinfo=zona_defecto)
    if not isinstance(valor, str):
        return None
    texto = valor.strip()
    if not texto:
        return None
    if texto.endswith('Z'):
        texto = texto[:-1] + '+0000'
    # Python no lee el offset con dos puntos en strptime hasta 3.7 y lo hace
    # de forma despareja despues; sacarlo es mas seguro que confiar.
    if len(texto) > 6 and texto[-3] == ':' and texto[-6] in '+-':
        texto = texto[:-3] + texto[-2:]
    for formato in _FORMATOS:
        try:
            fecha = datetime.strptime(texto, formato)
            return fecha if fecha.tzinfo else fecha.replace(tzinfo=zona_defecto)
        except ValueError:
            continue
    return None


def hay_cambios(en_la_nube, en_la_pc, zona_defecto=TZ_AR) -> bool:
    """
    True si la nube tiene algo más nuevo que la PC.

    Si alguna de las dos no se puede fechar, contesta True: bajar de más
    cuesta unas lecturas, no bajar deja productos sin vender.
    """
    nube = a_fecha(en_la_nube, zona_defecto)
    pc = a_fecha(en_la_pc, zona_defecto)
    if nube is None or pc is None:
        return True
    return nube > pc
