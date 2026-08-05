"""
Sincroniza el catalogo del POS con el espejo publico de la tienda online.

Por que existe un espejo y no se lee `catalogo` directo: los documentos de
`catalogo` traen costo, margen y proveedor. Abrir esa coleccion a lectura
publica seria publicar la estructura de costos de la libreria. El espejo lleva
unicamente lo que un cliente puede ver.

Que publica:
  1. Todo producto de un rubro habilitado en tienda_config/publicacion.
  2. Mas los productos sueltos marcados con tienda_publicar = True.
  3. Menos los marcados con tienda_publicar = False, que gana sobre el rubro.

Corre con el Admin SDK, asi que salta las reglas. Pensado para el Programador de
tareas de Windows en la PC del local, cada 15 minutos.

    python scripts/sync_tienda.py            # sincroniza
    python scripts/sync_tienda.py --simular  # muestra que haria, sin escribir
"""
import argparse
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import firebase_admin
from firebase_admin import credentials, firestore

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Productos internos del POS que no son mercaderia y no deben salir a la web.
NOMBRES_EXCLUIDOS = (
    'DESCUENTO POR CANTIDAD',
    'VARIOS 1',
    'VARIOS 2',
    'SIN NOMBRE',
    'PRUEBA',
)

MENORES = {'de', 'del', 'la', 'las', 'el', 'los', 'y', 'con', 'sin',
           'para', 'por', 'a', 'en'}

# Palabras que no distinguen nada al buscar y solo engordan el indice.
VACIAS = {'de', 'del', 'la', 'las', 'el', 'los', 'y', 'con', 'sin', 'para',
          'por', 'a', 'en', 'un', 'una', 'sin', 'marca'}


def conectar():
    clave = os.path.join(RAIZ, 'firebase_key.json')
    if not os.path.exists(clave):
        sys.exit(f'No encuentro las credenciales en {clave}')
    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app(credentials.Certificate(clave))
    return firestore.client()


def normalizar(texto):
    """Minusculas y sin acentos, para buscar y comparar."""
    s = unicodedata.normalize('NFD', str(texto or '').lower())
    return ''.join(c for c in s if unicodedata.category(c) != 'Mn').strip()


def nombre_bonito(texto):
    """
    El catalogo guarda todo en mayusculas porque el POS lo muestra asi en
    pantalla chica. Gritado en una tienda se ve agresivo y barato.

    Lo que trae numeros mezclados (C12-003, A4, 500ML) se deja como vino: suele
    ser un codigo o una medida y en formato titulo queda peor.
    """
    palabras = str(texto or '').strip().split()
    if not palabras:
        return ''
    salida = []
    for i, palabra in enumerate(palabras):
        if any(c.isdigit() for c in palabra):
            salida.append(palabra.upper())
            continue
        baja = palabra.lower()
        if i > 0 and baja in MENORES:
            salida.append(baja)
        else:
            salida.append(baja[:1].upper() + baja[1:])
    return ' '.join(salida)


def tokenizar(*textos):
    """Palabras normalizadas para la busqueda, sin repetir ni palabras vacias."""
    vistas = []
    for texto in textos:
        for palabra in re.split(r'[^0-9a-z]+', normalizar(texto)):
            if len(palabra) >= 2 and palabra not in VACIAS and palabra not in vistas:
                vistas.append(palabra)
    # Firestore limita a 100 valores por consulta array-contains-any, y un
    # arreglo enorme encarece cada lectura. Con 25 palabras sobra para el
    # nombre de un producto.
    return vistas[:25]


def variedades_de(datos):
    """
    Traduce conjunto_colores a la forma publica.

    En el catalogo cada color trae `unidades` (packs cerrados) y `restante`
    (sueltas del pack abierto). El stock real de esa variedad es
    unidades * contenido_del_pack + restante.
    """
    colores = datos.get('conjunto_colores') or []
    if not isinstance(colores, list):
        return []

    contenido = datos.get('conjunto_contenido') or 0
    try:
        contenido = int(contenido)
    except (TypeError, ValueError):
        contenido = 0

    salida = []
    for color in colores:
        if not isinstance(color, dict):
            continue
        nombre = str(color.get('color') or '').strip()
        if not nombre:
            continue
        try:
            unidades = float(color.get('unidades') or 0)
            restante = float(color.get('restante') or 0)
        except (TypeError, ValueError):
            unidades, restante = 0, 0

        stock = int(unidades * contenido + restante)
        precio = color.get('precio')
        salida.append({
            'nombre': nombre_bonito(nombre),
            'stock': max(0, stock),
            'precio': round(float(precio)) if precio else None,
        })
    return salida


def se_publica(datos, rubros_habilitados):
    """Reglas de curado. El interruptor por producto gana sobre el rubro."""
    marca_manual = datos.get('tienda_publicar')
    if marca_manual is False:
        return False, 'excluido a mano'

    if str(datos.get('estado') or '').lower() != 'activo':
        return False, 'no esta activo'
    if datos.get('duplicado') is True:
        return False, 'marcado como duplicado'

    nombre = str(datos.get('nombre') or '').strip().upper()
    if not nombre:
        return False, 'sin nombre'
    for prohibido in NOMBRES_EXCLUIDOS:
        if nombre.startswith(prohibido):
            return False, 'producto interno del POS'

    try:
        precio = float(datos.get('precio_venta') or 0)
    except (TypeError, ValueError):
        precio = 0
    if precio <= 0:
        return False, 'sin precio'

    if marca_manual is True:
        return True, 'incluido a mano'

    rubro = str(datos.get('rubro') or '').strip().upper()
    if rubro in rubros_habilitados:
        return True, 'rubro habilitado'

    return False, 'rubro no habilitado'


def armar_documento(doc_id, datos):
    nombre_publico = str(datos.get('tienda_nombre') or '').strip()
    nombre = nombre_publico or nombre_bonito(datos.get('nombre'))

    marca = str(datos.get('marca') or '').strip()
    if marca.upper() == 'SIN MARCA':
        marca = ''

    variedades = variedades_de(datos)
    try:
        stock = int(float(datos.get('stock') or 0))
    except (TypeError, ValueError):
        stock = 0
    # Con variedades manda la suma de las variedades: el campo `stock` del
    # producto padre cuenta packs cerrados y no lo que hay para vender suelto.
    if variedades:
        stock = sum(v['stock'] for v in variedades)

    imagenes = datos.get('tienda_imagenes')
    if not isinstance(imagenes, list):
        imagenes = []

    return {
        'nombre': nombre,
        'descripcion': str(datos.get('tienda_descripcion') or '').strip(),
        'precio': round(float(datos.get('precio_venta') or 0)),
        'precio_anterior': None,
        'stock': max(0, stock),
        'rubro': str(datos.get('rubro') or '').strip().upper(),
        'categoria': nombre_bonito(datos.get('categoria')),
        'sub_rubro': nombre_bonito(datos.get('sub_rubro')),
        'marca': marca,
        'imagenes': [str(u) for u in imagenes if u],
        'variedades': variedades,
        'destacado': datos.get('tienda_destacado') is True,
        'tokens': tokenizar(nombre, marca, datos.get('categoria'), datos.get('sub_rubro')),
        'codigo': str(datos.get('codigo') or ''),
        'actualizado': firestore.SERVER_TIMESTAMP,
    }


def clave_de_orden(doc):
    """
    Orden del catalogo: primero lo destacado, despues lo que hay en stock, y
    dentro de cada grupo alfabetico.

    Mostrar productos agotados arriba es la forma mas rapida de que alguien
    cierre la pagina.
    """
    return (
        0 if doc['destacado'] else 1,
        0 if doc['stock'] > 0 else 1,
        normalizar(doc['nombre']),
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--simular', action='store_true',
                    help='muestra el resumen sin escribir nada')
    args = ap.parse_args()

    db = conectar()

    # ── Que rubros se publican ────────────────────────────────────────────
    cfg = db.collection('tienda_config').document('publicacion').get()
    datos_cfg = cfg.to_dict() if cfg.exists else {}
    rubros_habilitados = {str(r).strip().upper()
                          for r in (datos_cfg.get('rubros') or [])}

    if not rubros_habilitados:
        print('Ningun rubro habilitado en tienda_config/publicacion.')
        print('Se publican solo los productos marcados uno por uno.\n')
    else:
        print(f'Rubros habilitados: {", ".join(sorted(rubros_habilitados))}\n')

    # ── Leer el catalogo ──────────────────────────────────────────────────
    print('Leyendo catalogo...')
    publicables = {}
    descartes = {}
    total = 0

    for doc in db.collection('catalogo').stream():
        total += 1
        datos = doc.to_dict() or {}
        ok, motivo = se_publica(datos, rubros_habilitados)
        if ok:
            publicables[doc.id] = armar_documento(doc.id, datos)
        else:
            descartes[motivo] = descartes.get(motivo, 0) + 1

    print(f'  {total} productos en el catalogo')
    print(f'  {len(publicables)} van a la tienda')
    for motivo, cantidad in sorted(descartes.items(), key=lambda x: -x[1]):
        print(f'    {cantidad:5d} descartados: {motivo}')

    # ── Numerar para el orden del catalogo ────────────────────────────────
    for i, doc_id in enumerate(sorted(publicables, key=lambda k: clave_de_orden(publicables[k]))):
        publicables[doc_id]['orden'] = i

    # ── Que hay hoy en el espejo ──────────────────────────────────────────
    espejo = {d.id for d in db.collection('tienda_productos').select([]).stream()}
    dar_de_baja = espejo - set(publicables)

    print(f'\n  {len(espejo)} productos hoy en la tienda')
    print(f'  {len(dar_de_baja)} se dan de baja')

    # ── Rubros con su conteo, para la portada ─────────────────────────────
    conteo = {}
    for doc in publicables.values():
        if doc['rubro']:
            conteo[doc['rubro']] = conteo.get(doc['rubro'], 0) + 1
    lista_rubros = [{'nombre': nombre_bonito(r), 'clave': r, 'cantidad': c}
                    for r, c in sorted(conteo.items(), key=lambda x: -x[1])]

    print('\nRubros publicados:')
    for r in lista_rubros:
        print(f'  {r["cantidad"]:5d}  {r["nombre"]}')

    if args.simular:
        print('\n(simulacion: no se escribio nada)')
        return

    # ── Escribir ──────────────────────────────────────────────────────────
    print('\nEscribiendo...')
    escritos = 0
    lote = db.batch()
    pendientes = 0

    def cerrar_lote(lote, pendientes):
        if pendientes:
            lote.commit()
        return db.batch(), 0

    for doc_id, doc in publicables.items():
        lote.set(db.collection('tienda_productos').document(doc_id), doc)
        pendientes += 1
        escritos += 1
        # Firestore corta los lotes en 500 operaciones.
        if pendientes >= 450:
            lote, pendientes = cerrar_lote(lote, pendientes)
            print(f'  {escritos} escritos...')

    for doc_id in dar_de_baja:
        lote.delete(db.collection('tienda_productos').document(doc_id))
        pendientes += 1
        if pendientes >= 450:
            lote, pendientes = cerrar_lote(lote, pendientes)

    cerrar_lote(lote, pendientes)

    db.collection('tienda_config').document('rubros').set({
        'lista': lista_rubros,
        'actualizado': firestore.SERVER_TIMESTAMP,
    })

    print(f'\nListo: {escritos} publicados, {len(dar_de_baja)} dados de baja.')
    print(f'{datetime.now(timezone.utc).astimezone():%d/%m/%Y %H:%M}')


if __name__ == '__main__':
    main()
