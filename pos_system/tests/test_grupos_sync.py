"""
Los grupos de tamaños en el sync de la tienda.

    python -m pytest pos_system/tests/test_grupos_sync.py -q

Tres cosas que el sync tiene que hacer con un grupo ("Cierre Común" en 10, 12,
14 cm...): publicar los campos del grupo en el espejo (eso lo compara
tienda/pruebas/espejo.test.js contra el panel), ordenar la vidriera con los
tamaños JUNTOS, y contar el grupo UNA vez en el rubro, porque la tienda lo
muestra como una sola card.
"""
import importlib.util
import os

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_spec = importlib.util.spec_from_file_location(
    'sync_tienda', os.path.join(RAIZ, 'scripts', 'sync_tienda.py'))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
valor_de_tamano = _mod.valor_de_tamano
ordenar_publicables = _mod.ordenar_publicables
contar_rubros = _mod.contar_rubros


def _doc(nombre, vendidos=0, grupo=None, tamano=None, stock=10, rubro='MERCERIA',
         sub_rubro='', destacado=False):
    return {
        'nombre': nombre,
        'rubro': rubro,
        'sub_rubro': sub_rubro,
        'stock': stock,
        'destacado': destacado,
        'vendidos': vendidos,
        'facturado': 0,
        'grupo': grupo,
        'grupo_clave': grupo.lower() if grupo else None,
        'tamano': tamano,
    }


def test_valor_de_tamano():
    assert valor_de_tamano('10 cm') == (10.0,)
    assert valor_de_tamano('9 cm') < valor_de_tamano('10 cm')
    assert valor_de_tamano('10x15') < valor_de_tamano('10x20')
    assert valor_de_tamano('0,5 mm') == (0.5,)
    # Sin numeros queda al final de cualquier lista con numeros.
    assert valor_de_tamano('Grande') > valor_de_tamano('999 cm')


def test_el_grupo_viaja_junto_al_mejor_tamano():
    publicables = {
        'a': _doc('ABROJO', vendidos=500),
        'c16': _doc('CIERRE COMUN 16 CM', vendidos=300, grupo='cierre comun', tamano='16 cm'),
        'b': _doc('BOTON', vendidos=100),
        'c10': _doc('CIERRE COMUN 10 CM', vendidos=1, grupo='cierre comun', tamano='10 cm'),
        'c12': _doc('CIERRE COMUN 12 CM', vendidos=0, grupo='cierre comun', tamano='12 cm'),
    }
    orden = ordenar_publicables(publicables)
    # El grupo entra donde rankea su mejor tamaño (el 16, con 300 ventas) y
    # adentro va del mas chico al mas grande.
    assert orden == ['a', 'c10', 'c12', 'c16', 'b']


def test_sin_grupos_el_orden_es_el_de_siempre():
    publicables = {
        'a': _doc('ABROJO', vendidos=10),
        'b': _doc('BOTON', vendidos=500),
        'c': _doc('CINTA', vendidos=0),
    }
    assert ordenar_publicables(publicables) == ['b', 'a', 'c']


def test_el_grupo_cuenta_una_vez_por_rubro_y_subrubro():
    publicables = {
        'c10': _doc('CIERRE COMUN 10 CM', grupo='cierre comun', tamano='10 cm',
                    sub_rubro='Cierre Fijo'),
        'c12': _doc('CIERRE COMUN 12 CM', grupo='cierre comun', tamano='12 cm',
                    sub_rubro='Cierre Fijo'),
        'boton': _doc('BOTON', sub_rubro='Botones'),
    }
    conteo, con_stock, _factura, subrubros = contar_rubros(publicables)
    assert conteo == {'MERCERIA': 2}
    assert con_stock == {'MERCERIA': 2}
    assert subrubros == {'MERCERIA': {'CIERRE FIJO': 1, 'BOTONES': 1}}


def test_lo_facturado_suma_todos_los_tamanos():
    publicables = {
        'c10': dict(_doc('CIERRE 10', grupo='cierre', tamano='10'), facturado=100),
        'c12': dict(_doc('CIERRE 12', grupo='cierre', tamano='12'), facturado=250),
    }
    _conteo, _stock, factura, _subs = contar_rubros(publicables)
    assert factura == {'MERCERIA': 350}
