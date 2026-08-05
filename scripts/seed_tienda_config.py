"""
Crea la configuracion inicial de la tienda online.

Se corre una sola vez. Despues todo esto se edita desde el panel; el script deja
los valores de arranque para que la tienda pueda levantar antes de que exista la
pantalla de configuracion.

    python scripts/seed_tienda_config.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import firebase_admin
from firebase_admin import credentials, firestore

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

try:
    firebase_admin.get_app()
except ValueError:
    firebase_admin.initialize_app(
        credentials.Certificate(os.path.join(RAIZ, 'firebase_key.json')))

db = firestore.client()

# Coordenadas del local. Salen de la direccion de la libreria y son el origen de
# todo calculo de distancia; si el local se muda, se cambian aca.
ORIGEN = {'lat': -31.3689, 'lng': -64.2323}

AJUSTES = {
    'abierta': True,
    'nombre': 'Librería Liceo',
    'telefono': '3517046684',
    'whatsapp': '5493517046684',
    'email': 'libreria.liceo@hotmail.com',
    'direccion': 'Av. Alfonsina Storni 168, X5019 Córdoba',
    'origen': ORIGEN,
    'horarios_texto': ('Lunes a viernes de 9 a 13 y de 16:30 a 20:30 · '
                       'Sábados de 9 a 13'),
    'entrega': {
        'retiro_habilitado': True,
        'delivery_habilitado': True,
        'radio_max_km': 12,
        # Tramos de precio por distancia. El cliente ve un numero redondo y
        # puede anticipar cuanto le sale antes de cargar la direccion.
        'tramos': [
            {'hasta_km': 3,  'precio': 1500},
            {'hasta_km': 6,  'precio': 2500},
            {'hasta_km': 12, 'precio': 3500},
        ],
        'envio_gratis_desde': None,
        'demora_texto': '24 a 48 hs',
    },
    'banner': None,
}

# Rubros que salen a la web. Los que quedan afuera son los que no tienen sentido
# vender online: SERVICIOS son trabajos que se hacen en el local, SELLOS se
# fabrican a pedido, y TELGOPOR no se puede repartir en moto.
PUBLICACION = {
    'rubros': [
        'LIBRERÍA',
        'PAPELERA',
        'MERCERÍA',
        'REGALERÍA',
        'JUGUETERÍA',
        'PERFUMERÍA',
    ],
}

db.collection('tienda_config').document('settings').set(AJUSTES, merge=True)
db.collection('tienda_config').document('publicacion').set(PUBLICACION, merge=True)

print('tienda_config/settings y tienda_config/publicacion creados.')
print(f'Rubros habilitados: {", ".join(PUBLICACION["rubros"])}')
print(f'Origen del reparto: {ORIGEN["lat"]}, {ORIGEN["lng"]}')
print('\nOjo: las coordenadas del local son aproximadas. Se ajustan desde el')
print('panel cuando este la pantalla de configuracion, o a mano en Firestore.')
