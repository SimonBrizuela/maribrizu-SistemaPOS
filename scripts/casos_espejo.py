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
from sync_tienda import armar_documento  # noqa: E402

CASOS = os.path.join(os.path.dirname(RAIZ), 'tienda', 'pruebas', 'casos_espejo.json')


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

    print(json.dumps(salida, ensure_ascii=False))


if __name__ == '__main__':
    main()
