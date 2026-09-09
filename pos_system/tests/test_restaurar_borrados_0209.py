"""La logica de restaurar_borrados_0209.py sin tocar Firestore.

    python -m pytest pos_system/tests/test_restaurar_borrados_0209.py -q
"""
import importlib.util
import os
import sys
from datetime import datetime, timezone

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, RAIZ)

_spec = importlib.util.spec_from_file_location(
    'restaurar_borrados_0209', os.path.join(RAIZ, 'restaurar_borrados_0209.py'))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

siguiente_codigo_libre = _mod.siguiente_codigo_libre
armar_doc_restaurado = _mod.armar_doc_restaurado
aplicar_umbrales = _mod.aplicar_umbrales
espejo_inventario = _mod.espejo_inventario
desde_backup = _mod.desde_backup

AHORA = datetime(2026, 9, 2, 13, 0, tzinfo=timezone.utc)

VINILO = {
    'codigo': '988067', 'cod_barra': '988067', 'id': 13777, 'nombre': 'IMPRESION VINILO A4 TRANSPARENTE',
    'rubro': 'SERVICIOS', 'sub_rubro': 'IMPRESION', 'precio_venta': 1500, 'costo': 445.26, 'stock': 0,
    'vinculado_a': '988062', 'vinculado_cantidad': 1,
    'vinculaciones': [{'doc_id': '988062', 'cantidad': 1, 'nombre': 'PAPEL VINILO AUTOADHESIVO PET TRANSPARENTE PS'}],
    'fecha_creacion': {'__fecha__': '2026-08-31T23:02:47.900000+00:00'},
    'ultima_actualizacion': {'__fecha__': '2026-08-31T23:02:47.900000+00:00'},
    'conjunto_colores': None, 'estado': 'activo',
}

PAPEL = {
    'codigo': '988066', 'cod_barra': '988066', 'id': 13776, 'nombre': 'PAPEL OBRA CARTA 75 GR AUTOR',
    'rubro': 'PAPELERA', 'precio_venta': 12000, 'costo': 1, 'stock': 531, 'es_conjunto': True,
    'conjunto_total': 531, 'stock_min': 500, 'stock_alerta_um': 'bulto', 'vinculado_a': None,
    'fecha_creacion': {'__fecha__': '2026-08-31T20:12:56.299000+00:00'},
}


# ── siguiente_codigo_libre ───────────────────────────────────────────────────

def test_arranca_en_el_mayor_usado_mas_uno():
    usados = {'988072', '988071', '190500000106', 'AUTO-33'}
    assert siguiente_codigo_libre(usados, lambda c: False) == '988073'


def test_saltea_lo_que_existe_en_la_nube_o_tiene_lapida():
    usados = {'988072'}
    en_nube = {'988073', '988074'}
    assert siguiente_codigo_libre(usados, lambda c: c in en_nube) == '988075'


def test_dos_codigos_seguidos_no_se_repiten():
    usados = {'988072'}
    a = siguiente_codigo_libre(usados, lambda c: False)
    usados.add(a)
    b = siguiente_codigo_libre(usados, lambda c: False)
    assert (a, b) == ('988073', '988074')


def test_ignora_codigos_que_no_son_de_seis_digitos():
    assert siguiente_codigo_libre({'2504086', '17055', '12345'}, lambda c: False) == '100000'


# ── armar_doc_restaurado ─────────────────────────────────────────────────────

def test_servicio_de_impresion_vuelve_con_codigo_nuevo_y_stock_ilimitado():
    doc = armar_doc_restaurado(VINILO, '988074', AHORA)
    assert doc['codigo'] == '988074' and doc['cod_barra'] == '988074'
    assert doc['id'] == 13777                      # mismo id: el espejo sigue valiendo
    assert doc['stock_ilimitado'] is True
    assert doc['vinculado_a'] == '988062'
    assert doc['vinculaciones'][0]['doc_id'] == '988062'
    assert doc['ultima_actualizacion'] == AHORA
    assert doc['fecha_creacion'] == datetime.fromisoformat('2026-08-31T23:02:47.900000+00:00')
    assert 'doc_id' not in doc


def test_el_papel_no_es_servicio_y_conserva_su_minimo_a_mano():
    doc = armar_doc_restaurado(PAPEL, '988073', AHORA)
    assert 'stock_ilimitado' not in doc
    assert doc['stock_min'] == 500 and doc['stock_alerta_um'] == 'bulto'
    assert doc['stock'] == 531 and doc['conjunto_total'] == 531


def test_no_modifica_el_original_del_backup():
    copia = dict(VINILO)
    armar_doc_restaurado(VINILO, '988074', AHORA)
    assert VINILO == copia
    assert VINILO['codigo'] == '988067'


def test_desde_backup_convierte_fechas_anidadas():
    v = desde_backup({'a': {'__fecha__': '2026-01-01T00:00:00+00:00'}, 'b': [{'__fecha__': '2026-01-02T00:00:00+00:00'}], 'c': 3})
    assert v['a'] == datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert v['b'][0] == datetime(2026, 1, 2, tzinfo=timezone.utc)
    assert v['c'] == 3


# ── espejo_inventario ────────────────────────────────────────────────────────

def test_espejo_lleva_lo_que_el_pos_lee():
    doc = armar_doc_restaurado(VINILO, '988074', AHORA)
    esp = espejo_inventario(doc, AHORA)
    assert esp == {'id': 13777, 'nombre': 'IMPRESION VINILO A4 TRANSPARENTE', 'precio': 1500,
                   'costo': 445.26, 'stock': 0, 'ultima_actualizacion': AHORA}


# ── aplicar_umbrales ─────────────────────────────────────────────────────────

def test_agrega_solo_los_campos_que_faltan():
    colores = [{'color': 'x30 ml', 'unidades': 8, 'restante': 9, 'precio': 800},
               {'color': 'x50 ml', 'unidades': 3, 'restante': 2, 'precio': 1000}]
    nuevos, cambios = aplicar_umbrales(colores, {'x30 ml': {'stock_min': 1, 'stock_max': 2, 'stock_min_um': 'pack'}})
    assert nuevos[0] == {'color': 'x30 ml', 'unidades': 8, 'restante': 9, 'precio': 800,
                         'stock_min': 1, 'stock_max': 2, 'stock_min_um': 'pack'}
    assert nuevos[1] == colores[1]
    assert cambios == ['[x30 ml] +stock_min=1', '[x30 ml] +stock_max=2', '[x30 ml] +stock_min_um=pack']


def test_no_pisa_lo_que_el_dueno_cargo():
    colores = [{'color': 'Rojo Cadmio', 'stock_min': 1, 'unidades': 2}]
    nuevos, cambios = aplicar_umbrales(colores, {'Rojo Cadmio': {'stock_min': 9, 'stock_max': 4, 'stock_min_um': 'unidad'}})
    assert nuevos[0]['stock_min'] == 1
    assert nuevos[0]['stock_max'] == 4 and nuevos[0]['stock_min_um'] == 'unidad'
    assert cambios == ['[Rojo Cadmio] +stock_max=4', '[Rojo Cadmio] +stock_min_um=unidad']


def test_sin_cambios_cuando_ya_esta_todo():
    colores = [{'color': 'Rayado', 'stock_min': 4, 'stock_max': 13, 'stock_min_um': 'unidad'}]
    nuevos, cambios = aplicar_umbrales(colores, {'Rayado': {'stock_min': 4, 'stock_max': 13, 'stock_min_um': 'unidad'}})
    assert nuevos == colores and cambios == []


def test_no_toca_el_array_original():
    colores = [{'color': 'Rayado', 'unidades': 1}]
    aplicar_umbrales(colores, {'Rayado': {'stock_min': 4}})
    assert colores == [{'color': 'Rayado', 'unidades': 1}]
