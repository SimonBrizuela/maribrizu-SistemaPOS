"""
Corre las reglas del descuento de papel sobre los casos de prueba y las escupe
como JSON.

Existe para que `tienda/pruebas/consumibles.test.js` pueda comparar lo que
decide `scripts/reconciliar_consumibles.py` (Python, corre en GitHub Actions
cada 6 h) con lo que decide `webapp/src/consumibles_watcher.js` (JavaScript,
corre en la pestaña del panel que esté abierta).

Las dos miran el MISMO item de `ventas_por_dia` y deciden de qué producto
descontar el papel. Son dos de las tres manos que se reparten ese item — la
tercera es el POS — y las tres marcan `consumibles_procesado` adentro de una
transaccion para no pisarse. Pero si deciden distinto, el papel se descuenta de
un lado y no del otro segun quien llegue primero, y eso no lo ve nadie.

    python scripts/casos_consumibles.py

No toca Firestore ni necesita credenciales.
"""
import json
import os
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)
sys.path.insert(0, os.path.join(RAIZ, 'scripts'))

from reconciliar_consumibles import links_de, links_del_item  # noqa: E402

CASOS = os.path.join(RAIZ, 'tienda', 'pruebas', 'casos_consumibles.json')


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass

    with open(CASOS, encoding='utf-8') as f:
        casos = json.load(f)

    salida = []
    for c in casos:
        links = links_del_item(c.get('item') or {}, c.get('producto'))
        salida.append({
            'que_prueba': c['que_prueba'],
            # Solo el destino y cuanto: el contexto es texto para el log y cada
            # lado lo arma a su manera.
            'links': [{'doc_id': l['doc_id'], 'cantidad': l['cantidad']} for l in links],
        })

    # `links_de` suelto, sobre las formas del campo.
    formas = [
        {'que_prueba': 'formato nuevo',
         'obj': {'vinculaciones': [{'doc_id': 'papel', 'cantidad': 2}]}},
        {'que_prueba': 'formato viejo',
         'obj': {'vinculado_a': 'papel', 'vinculado_cantidad': 3}},
        {'que_prueba': 'el nuevo le gana al viejo',
         'obj': {'vinculaciones': [{'doc_id': 'nuevo', 'cantidad': 1}],
                 'vinculado_a': 'viejo', 'vinculado_cantidad': 9}},
        {'que_prueba': 'cantidad en cero se descarta',
         'obj': {'vinculaciones': [{'doc_id': 'papel', 'cantidad': 0}]}},
        {'que_prueba': 'sin doc_id se descarta',
         'obj': {'vinculaciones': [{'cantidad': 2}]}},
        {'que_prueba': 'array vacio cae al viejo',
         'obj': {'vinculaciones': [], 'vinculado_a': 'papel', 'vinculado_cantidad': 4}},
        {'que_prueba': 'sin vinculos',
         'obj': {}},
        {'que_prueba': 'objeto nulo',
         'obj': None},
    ]
    formas_out = [{'que_prueba': f['que_prueba'], 'obj': f['obj'],
                   'links': [{'doc_id': l['doc_id'], 'cantidad': l['cantidad']}
                             for l in links_de(f['obj'])]}
                  for f in formas]

    print(json.dumps({'items': salida, 'formas': formas_out}, ensure_ascii=False))


if __name__ == '__main__':
    main()
