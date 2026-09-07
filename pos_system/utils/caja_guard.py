"""
Si esta PC está guardando las ventas en la caja que corresponde.

Existe por el sábado 05/09/2026. El viernes se cerró la caja 126 a las 20:29 y
el sábado nadie abrió una nueva. Ninguna PC se quejó: cada una tenía todavía
marcada como abierta en su SQLite una caja de días atrás —la 113, la 123, la
125— así que siguieron vendiendo normal y le pegaron ese número viejo a las 127
ventas del día. En el panel el sábado directamente no existía como cierre.

El agujero estaba en el arranque y en el listener de `caja_activa/current`: los
dos comparan el id remoto contra el local y, cuando el remoto está cerrado con
OTRO número, no hacen nada. Es la guarda que evita que un cierre viejo mate una
caja recién abierta en otra PC — está bien que esté— pero deja viva para
siempre a la caja fantasma de esta PC.

Cerrarla sola no es la respuesta: sin caja abierta el POS deja de subir las
ventas a Firebase (ver `_upload_sale_to_firebase` en sales_view), así que
arreglar el número perdería el día entero. Lo que se hace es avisar, fuerte y
en pantalla, para que alguien abra la caja.

Este módulo es solo la decisión, sin Qt ni Firebase, para poder probarla:
`pos_system/tests/test_caja_guard.py`.
"""
from datetime import datetime, timedelta, timezone

# Todas las noches pasan unos segundos entre el cierre de una caja y la apertura
# de la siguiente. Avisar ahí sería ruido: se espera este rato antes de hablar.
GRACIA = timedelta(minutes=10)

_TZ_AR = timezone(timedelta(hours=-3))


def _id_de(doc):
    if not doc:
        return None
    for campo in ('id', 'register_id'):
        val = doc.get(campo)
        if val is None or val == '':
            continue
        try:
            return int(val)
        except (TypeError, ValueError):
            continue
    return None


def _a_dt(val):
    """Un campo de fecha de Firestore/SQLite a datetime con zona, o None."""
    if val is None or val == '':
        return None
    if isinstance(val, datetime):
        return val if val.tzinfo else val.replace(tzinfo=_TZ_AR)
    if hasattr(val, 'timestamp'):
        try:
            return datetime.fromtimestamp(val.timestamp(), tz=_TZ_AR)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(val, str):
        try:
            dt = datetime.fromisoformat(val.strip().replace('Z', '+00:00'))
        except ValueError:
            return None
        return dt if dt.tzinfo else dt.replace(tzinfo=_TZ_AR)
    return None


def estado_de_caja(local, remoto, ahora=None, puede_abrir=True):
    """Qué está mal con la caja de esta PC, si algo está mal.

    `local`  es la fila de `cash_register` abierta en esta PC (o None).
    `remoto` es el doc `caja_activa/current` de Firestore (o None).
    `puede_abrir` es si quien está sentado tiene con qué abrir una caja. Un
    cajero no: a él se le avisa y nada más, mandarlo a abrirla es pedirle algo
    que el POS no le deja hacer.

    Devuelve None cuando está todo bien, o un dict con:
        tipo    'sin_caja' | 'fantasma' | 'caja_ajena' | 'sin_local'
        titulo  una línea para el cartel
        detalle qué hacer
        caja    el número de la caja que corresponde (o None)
    """
    ahora = ahora or datetime.now(_TZ_AR)
    if ahora.tzinfo is None:
        ahora = ahora.replace(tzinfo=_TZ_AR)

    id_local = _id_de(local)
    abierta_remota = (remoto or {}).get('status') == 'open'
    id_remoto = _id_de(remoto) if abierta_remota else None

    if abierta_remota:
        if id_local is None:
            return {
                'tipo': 'sin_local',
                'caja': id_remoto,
                'titulo': 'Esta PC no tomó la caja del día',
                'detalle': f'La caja abierta es la #{id_remoto} y esta computadora no la tiene. '
                           'Cerrá y volvé a abrir el programa antes de seguir vendiendo.',
            }
        if id_local != id_remoto:
            return {
                'tipo': 'caja_ajena',
                'caja': id_remoto,
                'titulo': f'Esta PC está usando la caja #{id_local}, vieja',
                'detalle': f'La caja de hoy es la #{id_remoto}. Todo lo que se venda acá no va a '
                           'aparecer en el cierre. Cerrá y volvé a abrir el programa.',
            }
        return None

    # Sin caja abierta en ningún lado. Se espera la gracia para no hablar
    # arriba de la rotación normal de cada noche.
    cerrada_hace = _a_dt((remoto or {}).get('updated_at'))
    if cerrada_hace is not None and (ahora - cerrada_hace) < GRACIA:
        return None

    que_hacer = ('Abrí la caja del día.' if puede_abrir
                 else 'Avisale al encargado para que abra la caja del día.')

    if id_local is not None:
        return {
            'tipo': 'fantasma',
            'caja': id_local,
            'titulo': 'No hay ninguna caja abierta',
            'detalle': f'Esta PC sigue anotando las ventas en la caja #{id_local}, que ya está '
                       f'cerrada, y así el cierre del día va a salir mal. {que_hacer}',
        }
    return {
        'tipo': 'sin_caja',
        'caja': None,
        'titulo': 'No hay ninguna caja abierta',
        'detalle': 'Mientras no haya caja abierta, las ventas de esta PC no se suben al '
                   f'sistema. {que_hacer}',
    }
