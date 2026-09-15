"""
El orden de la vidriera de la tienda: lo que se vende arriba y el resto de la
A a la Z.

    python -m pytest pos_system/tests/test_orden_tienda.py -q

Pedido del 2026-09-15: "que estén los tops primero y después todo en alfabeto,
y que también use la lógica de ventas: un equilibrio entre las dos". Antes todo
el catálogo iba por ventas, y como casi todo lo publicado vende algo, el orden
alfabético no aparecía nunca: buscar algo por su letra era imposible. Con todo
alfabético, en cambio, Librería arrancaba con nueve abrochadoras seguidas.

La regla, en cada lista (el catálogo entero y cada rubro por separado):

  1. Los destacados ("Más pedido"), por lo que se venden.
  2. La franja de lo que más se vende: el 10% de la lista, entre 6 y 48.
  3. Todo lo demás, de la A a la Z.
"""
import importlib.util
import os

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_spec = importlib.util.spec_from_file_location(
    'sync_tienda', os.path.join(RAIZ, 'scripts', 'sync_tienda.py'))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

ordenar_publicables = _mod.ordenar_publicables
franja_de_ventas = _mod.franja_de_ventas
cupo_de_ventas = _mod.cupo_de_ventas
numerar_orden = _mod.numerar_orden


def _doc(nombre, vendidos=0, stock=10, rubro='LIBRERIA', destacado=False,
         grupo=None, tamano=None):
    return {
        'nombre': nombre, 'rubro': rubro, 'sub_rubro': '', 'stock': stock,
        'destacado': destacado, 'vendidos': vendidos, 'facturado': 0,
        'grupo': grupo, 'grupo_clave': grupo.lower() if grupo else None, 'tamano': tamano,
    }


def test_el_cupo_es_el_diez_por_ciento_entre_seis_y_cuarenta_y_ocho():
    assert cupo_de_ventas(10) == 6
    assert cupo_de_ventas(37) == 6
    assert cupo_de_ventas(300) == 30
    assert cupo_de_ventas(1009) == 48
    assert cupo_de_ventas(0) == 0


def test_destacados_primero_y_entre_ellos_por_ventas():
    publicables = {
        'abrojo': _doc('ABROJO', vendidos=900),
        'cuaderno': _doc('CUADERNO', vendidos=50, destacado=True),
        'boligrafo': _doc('BOLIGRAFO', vendidos=700, destacado=True),
    }
    assert ordenar_publicables(publicables)[:2] == ['boligrafo', 'cuaderno']


def test_la_franja_de_ventas_va_por_ventas_y_el_resto_alfabetico():
    # Cuarenta productos: el cupo es 6. Los seis que más venden van primero,
    # por ventas; los demás, aunque vendan algo, de la A a la Z.
    nombres = [f'PRODUCTO {chr(90 - i)}' for i in range(26)] + [f'ARTICULO {i:02d}' for i in range(14)]
    publicables = {n: _doc(n, vendidos=i) for i, n in enumerate(nombres)}
    orden = ordenar_publicables(publicables)

    por_ventas = sorted(nombres, key=lambda n: -publicables[n]['vendidos'])[:6]
    assert orden[:6] == por_ventas
    resto = orden[6:]
    assert resto == sorted(resto, key=lambda n: n.lower())


def test_lo_que_no_se_vendio_nunca_entra_a_la_franja():
    publicables = {
        'z': _doc('ZAPATO', vendidos=3),
        'a': _doc('ABROCHADORA', vendidos=0),
        'b': _doc('BORRADOR', vendidos=0),
    }
    assert franja_de_ventas(publicables) == {'z'}
    assert ordenar_publicables(publicables) == ['z', 'a', 'b']


def test_la_franja_tiene_tope():
    publicables = {f'p{i:04d}': _doc(f'PRODUCTO {i:04d}', vendidos=i + 1) for i in range(1000)}
    assert len(franja_de_ventas(publicables)) == 48


def test_un_grupo_de_tamanos_sigue_junto_y_entra_donde_rankea_su_mejor_tamano():
    publicables = {
        'z': _doc('ZAPATO', vendidos=500),
        'c16': _doc('CIERRE 16 CM', vendidos=300, grupo='cierre', tamano='16 cm'),
        'c10': _doc('CIERRE 10 CM', vendidos=0, grupo='cierre', tamano='10 cm'),
        'a': _doc('ABROJO', vendidos=0),
    }
    assert ordenar_publicables(publicables) == ['z', 'c10', 'c16', 'a']


def test_cada_rubro_tiene_su_propia_franja():
    # Papelera vende mucho menos que Librería: con una sola franja para todo el
    # catálogo, la de Papelera quedaba vacía y su tira arrancaba en la A.
    publicables = {}
    for i in range(80):
        publicables[f'l{i}'] = _doc(f'LIBRO {i:02d}', vendidos=1000 + i, rubro='LIBRERIA')
    publicables['pa'] = _doc('ABANICO DE PAPEL', vendidos=0, rubro='PAPELERA')
    publicables['pb'] = _doc('BOLSA DE PAPEL', vendidos=0, rubro='PAPELERA')
    publicables['pz'] = _doc('ZIGZAG DE PAPEL', vendidos=4, rubro='PAPELERA')

    numerar_orden(publicables)
    papelera = sorted(['pa', 'pb', 'pz'], key=lambda k: publicables[k]['orden_rubro'])
    assert papelera == ['pz', 'pa', 'pb']
    assert [publicables[k]['orden_rubro'] for k in papelera] == [0, 1, 2]


def test_orden_global_numera_todo_de_cero_sin_huecos():
    publicables = {
        'a': _doc('ABROJO', vendidos=0),
        'b': _doc('BOTON', vendidos=9),
        'c': _doc('CINTA', vendidos=0, rubro='MERCERIA'),
    }
    numerar_orden(publicables)
    assert sorted(d['orden'] for d in publicables.values()) == [0, 1, 2]
    assert publicables['b']['orden'] == 0
