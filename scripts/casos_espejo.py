"""
Corre `armar_documento()` del sync sobre los casos de prueba y escupe el
resultado como JSON.

Existe para una sola cosa: que `tienda/pruebas/espejo.test.js` pueda comparar lo
que arma el sync con lo que arma el panel (`webapp/src/tienda_espejo.js`). Son
dos implementaciones de la misma regla, en dos lenguajes, y si se separan la
tienda muestra una cosa hasta que corre el sync y otra despues.

    python scripts/casos_espejo.py

No toca Firestore ni necesita credenciales.
"""
import json
import os
import sys

RAIZ = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, RAIZ)

# sync_tienda importa firebase_admin al abrirse, pero solo lo usa dentro de
# conectar(). El SERVER_TIMESTAMP que mete armar_documento se descarta abajo:
# es un centinela, no un valor.
from sync_tienda import armar_documento, se_publica  # noqa: E402

CASOS = os.path.join(os.path.dirname(RAIZ), 'tienda', 'pruebas', 'casos_espejo.json')

# Casos de la regla rubro / subrubro. El panel corre la suya sobre estos mismos
# datos y compara: si una de las dos implementaciones cambia sola, el sync
# termina republicando lo que el panel saco.
CASOS_PUBLICACION = [
    {
        'que_prueba': 'rubro habilitado, sin subrubros excluidos',
        'datos': {'nombre': 'Cuaderno', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos'},
        'rubros': ['LIBRERIA'], 'excluidos': {},
    },
    {
        'que_prueba': 'subrubro excluido dentro de un rubro habilitado',
        'datos': {'nombre': 'Abrochadora', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'LIBRERIA', 'sub_rubro': 'Abrochadora'},
        'rubros': ['LIBRERIA'], 'excluidos': {'LIBRERIA': ['ABROCHADORA']},
    },
    {
        'que_prueba': 'el subrubro se compara sin importar como este escrito',
        'datos': {'nombre': 'Abrochadora', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'LIBRERIA', 'sub_rubro': '  abrochadora '},
        'rubros': ['LIBRERIA'], 'excluidos': {'LIBRERIA': ['ABROCHADORA']},
    },
    {
        'que_prueba': 'el mismo subrubro en otro rubro no se toca',
        'datos': {'nombre': 'Abrochadora chica', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'PAPELERA', 'sub_rubro': 'Abrochadora'},
        'rubros': ['LIBRERIA', 'PAPELERA'], 'excluidos': {'LIBRERIA': ['ABROCHADORA']},
    },
    {
        'que_prueba': 'el rubro apagado gana sobre todo lo demas',
        'datos': {'nombre': 'Cuaderno', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'JUGUETERIA', 'sub_rubro': 'Cuadernos'},
        'rubros': ['LIBRERIA'], 'excluidos': {},
    },
    {
        'que_prueba': 'incluido a mano le gana al subrubro excluido',
        'datos': {'nombre': 'Abrochadora', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 5, 'rubro': 'LIBRERIA', 'sub_rubro': 'Abrochadora',
                  'tienda_publicar': True},
        'rubros': ['LIBRERIA'], 'excluidos': {'LIBRERIA': ['ABROCHADORA']},
    },
    {
        'que_prueba': 'sin stock no sale, aunque el subrubro este permitido',
        'datos': {'nombre': 'Cuaderno', 'estado': 'activo', 'precio_venta': 100,
                  'stock': 0, 'rubro': 'LIBRERIA', 'sub_rubro': 'Cuadernos'},
        'rubros': ['LIBRERIA'], 'excluidos': {},
    },
]


def publicacion():
    """Corre `se_publica()` sobre los casos de la regla rubro / subrubro."""
    salida = []
    for caso in CASOS_PUBLICACION:
        excluidos = {r: set(s) for r, s in caso['excluidos'].items()}
        ok, _motivo = se_publica(caso['datos'], set(caso['rubros']), excluidos)
        salida.append({'que_prueba': caso['que_prueba'], 'datos': caso['datos'],
                       'rubros': caso['rubros'], 'excluidos': caso['excluidos'],
                       'publica': bool(ok)})
    return salida


def main():
    # En Windows la consola sale en cp1252 y "Cordón" viaja roto. Lo lee otro
    # programa, no una persona: tiene que ser UTF-8 siempre.
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

    with open(CASOS, encoding='utf-8') as f:
        casos = json.load(f)

    salida = []
    for caso in casos:
        doc = armar_documento(caso['doc_id'], caso['datos'])
        doc.pop('actualizado', None)
        salida.append({'doc_id': caso['doc_id'], 'documento': doc})

    print(json.dumps({'documentos': salida, 'publicacion': publicacion()},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
