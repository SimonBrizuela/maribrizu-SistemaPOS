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
import math
import os
import re
import sys
import unicodedata
from datetime import datetime, timedelta, timezone

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

# Cuantos destacados elegir solos cuando no hay ninguno marcado a mano. Doce
# llenan las dos tiras de la portada sin que se repita nada.
DESTACADOS_AUTOMATICOS = 12

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


def medidas_de(datos):
    """
    Traduce el modelo de "conjunto" del POS a lo que necesita una tienda.

    En el catalogo, un producto que se vende fraccionado guarda DOS precios:

      precio_venta            lo que sale el rollo / la caja entera
      conjunto_precio_unidad  lo que sale UNO: un metro, un boligrafo

    La tienda mostraba `precio_venta` para todos, asi que un metro de media
    perla figuraba a $23.800 cuando vale $1.200, y un boligrafo suelto a
    $14.900 cuando vale $1.400. Con esos precios no se vende nada.

    Devuelve el precio de una unidad, el del pack cuando existe de verdad, y en
    que se mide el producto.

    Lo que decide el panel (campos `tienda_*` del catalogo) pisa lo que se
    deduce del POS. El precio y el stock NO: esos salen del catalogo y solo del
    catalogo, porque son los mismos con los que se cobra en el mostrador.
    """
    es_conjunto = datos.get('es_conjunto') is True
    tipo = str(datos.get('conjunto_tipo') or '').strip().lower()
    um = str(datos.get('conjunto_unidad_medida') or '').strip().lower()

    def numero(clave, por_defecto=0):
        try:
            return float(datos.get(clave) or por_defecto)
        except (TypeError, ValueError):
            return por_defecto

    precio_venta = numero('precio_venta')
    precio_unidad = numero('conjunto_precio_unidad')
    contenido = int(numero('conjunto_contenido'))

    # Como se vende de cara al cliente. El POS lo deduce de la unidad de medida
    # y a veces se equivoca (un cordon cargado sin "metros" se ofrecia por
    # unidad); desde el panel se corrige sin tocar el catalogo del POS.
    forzada = str(datos.get('tienda_unidad') or '').strip().lower()
    unidad = forzada if forzada in ('metro', 'unidad') else ('metro' if um == 'metros' else 'unidad')

    variedades = variedades_de(datos)

    if not es_conjunto:
        return {
            'unidad': unidad, 'precio': round(precio_venta), 'precio_pack': None,
            'pack_tipo': None, 'pack_nombre': None, 'pack_contenido': None,
            'stock': max(0, int(numero('stock'))), 'variedades': [],
            **venta_minima(datos, unidad),
        }

    # `conjunto_tipo: unidad` con contenido 1 no es un pack: es un producto
    # suelto que quedo marcado como conjunto. No se le ofrece "llevar el pack".
    hay_pack = contenido > 1 and tipo in ('rollo', 'caja', 'pack', 'bolsa', 'bobina', 'carton')

    # El panel puede apagar la venta del pack entero aunque exista (no siempre
    # se quiere ofrecer el rollo de 50 metros por la web) o encenderla cuando el
    # POS no la dedujo. Encenderla sin contenido ni precio no tiene sentido:
    # seria ofrecer "el pack" sin saber de cuanto es ni cuanto sale.
    ofrecer = datos.get('tienda_ofrecer_pack')
    if ofrecer is False:
        hay_pack = False
    elif ofrecer is True:
        hay_pack = contenido > 1 and precio_venta > 0

    # El stock en unidades sale de `conjunto_total`, no del campo `stock`: ese
    # ultimo cuenta packs cerrados y queda desfasado. Medido sobre el catalogo:
    # un producto con stock 225 tenia 246 unidades reales para vender.
    if variedades:
        stock = sum(v['stock'] for v in variedades)
    else:
        stock = int(numero('conjunto_total') or numero('stock'))

    return {
        'unidad': unidad,
        'precio': round(precio_unidad or precio_venta),
        'precio_pack': round(precio_venta) if hay_pack else None,
        'pack_tipo': tipo if hay_pack else None,
        # Como se llama el pack en la tienda: "Rollo", "Caja de 12". El nombre
        # del POS es una clave interna y a veces no dice nada ("carton").
        'pack_nombre': (str(datos.get('tienda_pack_nombre') or '').strip()
                        or nombre_bonito(tipo)) if hay_pack else None,
        'pack_contenido': contenido if hay_pack else None,
        'stock': max(0, stock),
        'variedades': variedades,
        **venta_minima(datos, unidad),
    }


def venta_minima(datos, unidad):
    """
    De a cuanto se vende esto en la tienda.

    En el mostrador atender una venta cuesta cero: la persona ya esta ahi. Un
    pedido online no: hay que leerlo, recorrer el local juntando las cosas,
    embalarlo y despacharlo. Vender un mapa de $100 que deja $40 no paga ni el
    minuto de ir a buscarlo.

    Dos numeros, los dos configurables desde el panel por producto:

      minimo — cuanto hay que llevar como poco
      paso   — de a cuanto se suma o se resta

    Van en la unidad del producto: para una cinta que se corta del rollo son
    metros, para lo demas unidades. Sin configurar, queda como estaba: de a uno,
    y medio metro para lo que se mide. `scripts/estudio_minimos.py` calcula que
    valor le corresponde a cada producto segun lo que deja.
    """
    paso_natural = 0.5 if unidad == 'metro' else 1

    def numero(clave, por_defecto):
        try:
            v = float(datos.get(clave))
            return v if v > 0 else por_defecto
        except (TypeError, ValueError):
            return por_defecto

    paso = numero('tienda_paso', paso_natural)
    minimo = numero('tienda_minimo', paso)

    # El minimo tiene que caer justo en un paso, o el cliente no puede llegar a
    # el con los botones: con minimo 3 y paso 2 se pasa de 2 a 4 y el 3 no
    # existe. Se sube al paso siguiente.
    if minimo % paso:
        minimo = math.ceil(minimo / paso) * paso

    return {'minimo': round(minimo, 2), 'paso': round(paso, 2)}


def variedades_de(datos):
    """
    Traduce conjunto_colores a la forma publica.

    En el catalogo cada color trae `unidades` (packs cerrados) y `restante`
    (sueltas del pack abierto). El stock real de esa variedad es
    unidades * contenido_del_pack + restante.

    El panel puede esconder variedades y renombrarlas: eso vive en
    `tienda_variedades`, un mapa con el nombre del catalogo normalizado como
    clave. Se guarda normalizado porque el nombre visible cambia (el panel
    muestra "Celeste", el catalogo dice "CELESTE") y una clave que depende de
    como se escribio el color se pierde al primer retoque.
    """
    colores = datos.get('conjunto_colores') or []
    if not isinstance(colores, list):
        return []

    contenido = datos.get('conjunto_contenido') or 0
    try:
        contenido = int(contenido)
    except (TypeError, ValueError):
        contenido = 0

    ajustes = datos.get('tienda_variedades')
    if not isinstance(ajustes, dict):
        ajustes = {}

    salida = []
    for color in colores:
        if not isinstance(color, dict):
            continue
        nombre = str(color.get('color') or '').strip()
        if not nombre:
            continue

        ajuste = ajustes.get(normalizar(nombre))
        if isinstance(ajuste, dict) and ajuste.get('publicar') is False:
            continue

        try:
            unidades = float(color.get('unidades') or 0)
            restante = float(color.get('restante') or 0)
        except (TypeError, ValueError):
            unidades, restante = 0, 0

        stock = int(unidades * contenido + restante)
        precio = color.get('precio')
        publico = ''
        if isinstance(ajuste, dict):
            publico = str(ajuste.get('nombre') or '').strip()

        salida.append({
            'nombre': publico or nombre_bonito(nombre),
            'stock': max(0, stock),
            'precio': round(float(precio)) if precio else None,
        })
    return salida


def se_publica(datos, rubros_habilitados, subrubros_excluidos=None):
    """Reglas de curado. El interruptor por producto gana sobre el rubro.

    El rubro manda: apagado no sale nada de el; prendido sale todo menos los
    subrubros que el panel dejo afuera en `subrubros_excluidos`. Gemelo de
    motivoDeNoPublicar() en webapp/src/tienda_espejo.js: si una de las dos
    cambia sin la otra, el sync vuelve a subir lo que el panel saco.
    """
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

    # Sin stock no sale a la web.
    #
    # De 7.648 productos publicables solo 2.315 tenian stock: Regaleria mostraba
    # 599 y se podian comprar 53. Una tienda donde siete de cada diez productos
    # dicen "sin stock" se lee como un local que cerro, no como uno surtido.
    #
    # El stock se cuenta en unidades vendibles (metros sueltos, boligrafos
    # sueltos), no en packs cerrados. medidas_de() ya resuelve las tres formas
    # que usa el catalogo.
    if medidas_de(datos)['stock'] <= 0:
        return False, 'sin stock'

    if marca_manual is True:
        return True, 'incluido a mano'

    rubro = str(datos.get('rubro') or '').strip().upper()
    if rubro not in rubros_habilitados:
        return False, 'rubro no habilitado'

    sub = str(datos.get('sub_rubro') or '').strip().upper()
    if sub and sub in (subrubros_excluidos or {}).get(rubro, set()):
        return False, 'subrubro excluido'

    return True, 'rubro habilitado'


def armar_documento(doc_id, datos):
    nombre_publico = str(datos.get('tienda_nombre') or '').strip()
    nombre = nombre_publico or nombre_bonito(datos.get('nombre'))

    marca = str(datos.get('marca') or '').strip()
    if marca.upper() == 'SIN MARCA':
        marca = ''

    m = medidas_de(datos)

    imagenes = datos.get('tienda_imagenes')
    if not isinstance(imagenes, list):
        imagenes = []

    return {
        'nombre': nombre,
        'descripcion': str(datos.get('tienda_descripcion') or '').strip(),
        # Aviso propio del producto. Gemelo de `aviso` en documentoEspejo() de
        # webapp/src/tienda_espejo.js: si uno cambia sin el otro, el sync le
        # pisa al panel lo que acaba de guardar.
        'aviso': str(datos.get('tienda_aviso') or '').strip() or None,
        # Precio de UNA unidad: un metro de cinta, un boligrafo suelto.
        'precio': m['precio'],
        'precio_anterior': None,
        # Precio del rollo o la caja entera, cuando llevarse el pack tiene
        # sentido. Sale mas barato por unidad que comprar de a uno, asi que la
        # tienda lo ofrece como alternativa en la ficha del producto.
        'precio_pack': m['precio_pack'],
        'pack_tipo': m['pack_tipo'],
        # Como se llama de cara al cliente: "Rollo", "Caja de 12".
        'pack_nombre': m['pack_nombre'],
        'pack_contenido': m['pack_contenido'],
        # En que se mide: 'metro' para cintas, cordones y elastico; 'unidad'
        # para el resto.
        'unidad': m['unidad'],
        # De a cuanto se vende: lo minimo que se puede llevar y de a cuanto
        # sube. Un pedido online cuesta trabajo aunque sea de $100.
        'minimo': m['minimo'],
        'paso': m['paso'],
        'stock': m['stock'],
        'rubro': str(datos.get('rubro') or '').strip().upper(),
        'categoria': nombre_bonito(datos.get('categoria')),
        'sub_rubro': nombre_bonito(datos.get('sub_rubro')),
        'marca': marca,
        'imagenes': [str(u) for u in imagenes if u],
        'variedades': m['variedades'],
        'destacado': datos.get('tienda_destacado') is True,
        'tokens': tokenizar(nombre, marca, datos.get('categoria'), datos.get('sub_rubro')),
        # Nombre normalizado para las sugerencias mientras se escribe.
        # `tokens` sirve para buscar palabras completas, pero no para prefijos:
        # array-contains compara exacto, asi que "abro" no encuentra "abrojo".
        # Con el nombre entero en minusculas y sin acentos se puede pedir el
        # rango [texto, texto + ], que es como se hace un "empieza con"
        # en Firestore.
        'nombre_busqueda': normalizar(nombre),
        'codigo': str(datos.get('codigo') or ''),
        'actualizado': firestore.SERVER_TIMESTAMP,
    }


def clave_de_orden(doc):
    """
    Orden del catalogo: primero lo destacado, despues lo que hay en stock,
    despues lo que mas se vende, y recien al final alfabetico.

    Ordenar alfabetico era ordenar por nada. El catalogo real arranca con
    Abecedario, Abrojal, Abrochadora, Abrochadora: la primera pantalla de la
    tienda mostraba cuatro abrochadoras y parecia rota. Medido sobre cuatro
    meses de ventas, 100 productos hacen la mitad de la facturacion y 500 hacen
    el 78%: esos son los que tienen que estar arriba.

    `vendidos` son las unidades de los ultimos meses. Se ordena descendente, y
    empatados en cero —que son la mayoria— queda el alfabetico de siempre.
    """
    return (
        0 if doc['destacado'] else 1,
        0 if doc['stock'] > 0 else 1,
        -doc.get('vendidos', 0),
        normalizar(doc['nombre']),
    )


# Cada cuanto se vuelve a contar lo vendido. El ranking mueve el orden de la
# vidriera, no los precios ni el stock: que sea de esta manana alcanza y sobra.
HORAS_DE_RANKING = 12


def leer_ventas_cacheado(db, dias=120, horas=HORAS_DE_RANKING):
    """El ranking de ventas, releido solo cuando ya esta viejo.

    Contar cuatro meses de renglones son ~26.000 lecturas de Firestore, y hasta
    ahora eso pasaba en CADA corrida del sync. Corriendo cada 15 minutos son 2,5
    millones de lecturas por dia contra un limite gratuito de 50.000: la parte
    mas cara del sistema, y para reordenar una vidriera que casi no cambia.

    El resultado queda en `tienda_config/ranking`. Si tiene menos de `horas`,
    se reusa; si no, se recalcula y se guarda.
    """
    ref = db.collection('tienda_config').document('ranking')
    try:
        doc = ref.get()
        if doc.exists:
            datos = doc.to_dict() or {}
            calculado = datos.get('calculado_at')
            if isinstance(calculado, datetime):
                edad = datetime.now(timezone.utc) - calculado.astimezone(timezone.utc)
                if edad < timedelta(hours=horas):
                    unidades = {k: float(v) for k, v in (datos.get('unidades') or {}).items()}
                    importe = {k: float(v) for k, v in (datos.get('importe') or {}).items()}
                    if unidades:
                        print(f'  ranking de ventas: reusado, {edad.total_seconds()/3600:.1f} h de antiguedad '
                              f'({len(unidades)} productos, 0 lecturas)')
                        return unidades, importe
    except Exception as e:
        print(f'  ranking de ventas: no se pudo reusar ({e}), se recalcula')

    unidades, importe = leer_ventas(db, dias)

    # Firestore no acepta puntos en las claves de un mapa.
    def limpiar(d):
        return {k.replace('.', '_'): round(v, 2) for k, v in d.items() if v}

    try:
        ref.set({
            'calculado_at': datetime.now(timezone.utc),
            'dias': dias,
            'unidades': limpiar(unidades),
            'importe': limpiar(importe),
        })
    except Exception as e:
        # Si no entra (limite de 1 MB por doc), se sigue sin cache: el sync
        # tiene que publicar igual.
        print(f'  ranking de ventas: no se pudo guardar el cache ({e})')
    return unidades, importe


def leer_ventas(db, dias=120):
    """
    Cuanto se vendio de cada producto, para ordenar la tienda por eso.

    El renglon de venta no guarda el codigo del producto: guarda el nombre, y
    encima decorado con lo que se eligio al vender ("[Celeste] CARTULINA · 1 u",
    "PAPEL OBRA · 10 pack(s)"). Cruzar por el nombre crudo pierde el 38% de las
    ventas, y no cualquier 38%: los productos con variedad y los que se venden
    por pack, que son los que mas rotan. Por eso se limpia antes de comparar.

    Devuelve unidades e importe por nombre normalizado.
    """
    desde = datetime.now(timezone.utc) - timedelta(days=dias)
    unidades = {}
    importe = {}

    for d in db.collection('ventas_por_dia').where('fecha_dt', '>=', desde).stream():
        x = d.to_dict() or {}
        if x.get('deleted') is True:
            continue
        clave = clave_de_venta(x.get('producto'))
        if not clave:
            continue
        unidades[clave] = unidades.get(clave, 0) + float(x.get('cantidad') or 0)
        importe[clave] = importe.get(clave, 0) + float(x.get('subtotal') or 0)

    return unidades, importe


def clave_de_venta(nombre):
    """El nombre de un renglon de venta, sin la variedad ni el pack pegados."""
    limpio = str(nombre or '')
    if limpio.lstrip().startswith('['):
        cierre = limpio.find(']')
        if cierre != -1:
            limpio = limpio[cierre + 1:]
    return normalizar(limpio.split('·')[0])


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
    subrubros_excluidos = {
        str(rubro).strip().upper(): {str(s).strip().upper() for s in (subs or [])}
        for rubro, subs in (datos_cfg.get('subrubros_excluidos') or {}).items()
    }

    if not rubros_habilitados:
        print('Ningun rubro habilitado en tienda_config/publicacion.')
        print('Se publican solo los productos marcados uno por uno.\n')
    else:
        print(f'Rubros habilitados: {", ".join(sorted(rubros_habilitados))}')
        for rubro, subs in sorted(subrubros_excluidos.items()):
            if subs:
                print(f'  {rubro}: sin publicar {", ".join(sorted(subs))}')
        print()

    # ── Leer el catalogo ──────────────────────────────────────────────────
    print('Leyendo catalogo...')
    publicables = {}
    descartes = {}
    total = 0

    for doc in db.collection('catalogo').stream():
        total += 1
        datos = doc.to_dict() or {}
        ok, motivo = se_publica(datos, rubros_habilitados, subrubros_excluidos)
        if ok:
            publicables[doc.id] = armar_documento(doc.id, datos)
        else:
            descartes[motivo] = descartes.get(motivo, 0) + 1

    print(f'  {total} productos en el catalogo')
    print(f'  {len(publicables)} van a la tienda')
    for motivo, cantidad in sorted(descartes.items(), key=lambda x: -x[1]):
        print(f'    {cantidad:5d} descartados: {motivo}')

    # ── Que se vende, para ordenar la tienda por eso ──────────────────────
    print('\nLeyendo ventas de los ultimos 4 meses...')
    unidades, importe = leer_ventas_cacheado(db)
    print(f'  {len(unidades)} productos con movimiento')

    for doc_id, doc in publicables.items():
        clave = normalizar(doc['nombre'])
        doc['vendidos'] = unidades.get(clave, 0)
        doc['facturado'] = importe.get(clave, 0)

    # Los destacados de la portada.
    #
    # Si nadie marco ninguno a mano, se eligen los que mas se venden: sin esto
    # la portada dice "Del catalogo" y muestra una tanda al azar. Un destacado
    # puesto a mano desde el panel gana siempre, y con uno solo que haya se
    # respeta esa eleccion y no se agrega nada.
    a_mano = [d for d in publicables.values() if d['destacado']]
    if not a_mano:
        candidatos = sorted(
            (d for d in publicables.values() if d['stock'] > 0 and d['imagenes']),
            key=lambda d: -d['vendidos'])
        for doc in candidatos[:DESTACADOS_AUTOMATICOS]:
            if doc['vendidos'] > 0:
                doc['destacado'] = True
        elegidos = [d for d in publicables.values() if d['destacado']]
        print(f'  {len(elegidos)} destacados elegidos por lo que se vende:')
        for doc in sorted(elegidos, key=lambda d: -d['vendidos']):
            print(f'      {doc["vendidos"]:7.0f} vendidos  {doc["nombre"][:48]}')
    else:
        print(f'  {len(a_mano)} destacados marcados a mano en el panel')

    # ── Numerar para el orden del catalogo ────────────────────────────────
    ordenados = sorted(publicables, key=lambda k: clave_de_orden(publicables[k]))

    # `orden` es global: sirve para el listado completo del catalogo.
    for i, doc_id in enumerate(ordenados):
        publicables[doc_id]['orden'] = i

    # `orden_rubro` numera de nuevo dentro de cada rubro. Sin esto no se puede
    # pedir "seis productos de Libreria a partir del numero 340": el orden
    # global tiene los rubros entremezclados, asi que saltar a un punto al azar
    # cae casi siempre en otro rubro. Y sin poder saltar, las tiras de la portada
    # muestran siempre los primeros alfabeticamente, que en Libreria son seis
    # abrochadoras seguidas.
    contador = {}
    for doc_id in ordenados:
        rubro = publicables[doc_id]['rubro']
        publicables[doc_id]['orden_rubro'] = contador.get(rubro, 0)
        contador[rubro] = contador.get(rubro, 0) + 1

    # ── Que hay hoy en el espejo ──────────────────────────────────────────
    espejo = {d.id for d in db.collection('tienda_productos').select([]).stream()}
    dar_de_baja = espejo - set(publicables)

    print(f'\n  {len(espejo)} productos hoy en la tienda')
    print(f'  {len(dar_de_baja)} se dan de baja')

    # ── Rubros con su conteo, para la portada ─────────────────────────────
    conteo = {}
    con_stock = {}
    factura = {}
    # Los subrubros que quedaron publicados en cada rubro. Es la segunda fila de
    # filtros de la tienda: sacarlos del catalogo entero mostraria filtros que
    # no devuelven nada.
    subrubros = {}
    for doc in publicables.values():
        if not doc['rubro']:
            continue
        conteo[doc['rubro']] = conteo.get(doc['rubro'], 0) + 1
        factura[doc['rubro']] = factura.get(doc['rubro'], 0) + doc['facturado']
        if doc['stock'] > 0:
            con_stock[doc['rubro']] = con_stock.get(doc['rubro'], 0) + 1
        sub = str(doc.get('sub_rubro') or '').strip().upper()
        if sub:
            dentro = subrubros.setdefault(doc['rubro'], {})
            dentro[sub] = dentro.get(sub, 0) + 1

    # Los rubros salen ordenados por lo que facturan, no por cuantos productos
    # tienen. Son dos ordenes muy distintos: Regaleria tiene 594 productos y
    # vende $947 mil; Papelera tiene 244 y vende $2,3 millones. La portada
    # mostraba primero el que mas cosas tiene, que es el que mas espacio ocupa
    # en el deposito y no el que mas le interesa a quien entra.
    #
    # El numero de facturacion NO se publica: se usa para ordenar y se descarta.
    # `tienda_config` lo lee cualquiera sin sesion.
    lista_rubros = [{'nombre': nombre_bonito(r), 'clave': r,
                     'cantidad': conteo[r], 'con_stock': con_stock.get(r, 0),
                     'subrubros': [
                         {'nombre': nombre_bonito(s), 'clave': s, 'cantidad': n}
                         for s, n in sorted(subrubros.get(r, {}).items(),
                                            key=lambda x: -x[1])
                     ]}
                    for r, _ in sorted(factura.items(), key=lambda x: -x[1])]

    print('\nRubros publicados (ordenados por lo que venden):')
    for r in lista_rubros:
        print(f'  {r["cantidad"]:5d}  {r["nombre"]:<14} ({r["con_stock"]} con stock)')

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
        # Cuanto se vendio de cada cosa no sale a la web: `tienda_productos` lo
        # lee cualquiera sin sesion, y son las ventas del local. Se usaron para
        # ordenar y se descartan acá.
        doc.pop('vendidos', None)
        doc.pop('facturado', None)
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
