"""
Prueba las reglas de la tienda desde afuera, como un navegador cualquiera.

    python scripts/probar_tienda.py

La apiKey de Firebase viaja en el bundle publico: cualquiera puede abrir la
consola y pegarle a Firestore con ella. Lo unico que separa la contabilidad, los
telefonos de los clientes y los certificados de ARCA de esa persona son las
reglas de firestore.rules.

Esto no las lee: las prueba. Pega contra la API REST sin ninguna sesion, que es
exactamente lo que puede hacer un desconocido, y verifica que lo publico se lea
y lo demas devuelva PERMISSION_DENIED.

El pedido de prueba se crea de verdad y se borra al final con la clave de
servicio. Si el borrado falla queda dicho, con el codigo, para sacarlo a mano.
"""
import json
import os
import sys
import urllib.error
import urllib.request

PROYECTO = 'mari-d7c71'
BASE = f'https://firestore.googleapis.com/v1/projects/{PROYECTO}/databases/(default)/documents'
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

VERDE = '\033[92m'
ROJO = '\033[91m'
GRIS = '\033[90m'
FIN = '\033[0m'

resultados = []


def pedir(metodo, url, cuerpo=None):
    """Devuelve (codigo, datos). Sin token: somos cualquiera."""
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    pedido = urllib.request.Request(url, data=datos, method=metodo,
                                    headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(pedido) as respuesta:
            return respuesta.status, json.loads(respuesta.read() or b'{}')
    except urllib.error.HTTPError as err:
        try:
            return err.code, json.loads(err.read() or b'{}')
        except json.JSONDecodeError:
            return err.code, {}


def revisar(que, ok, detalle=''):
    resultados.append((que, ok, detalle))
    marca = f'{VERDE}  OK  {FIN}' if ok else f'{ROJO} FALLA{FIN}'
    print(f'{marca} {que}' + (f'{GRIS}  {detalle}{FIN}' if detalle else ''))
    return ok


def se_lee(coleccion):
    codigo, _ = pedir('GET', f'{BASE}/{coleccion}?pageSize=1')
    return codigo


def texto(valor):
    return {'stringValue': valor}


def numero(valor):
    return {'integerValue': str(valor)}


def pedido_de_prueba(**cambios):
    """Un pedido con la forma que exige pedidoValido() en las reglas."""
    campos = {
        'estado': texto('nuevo'),
        'codigo': texto('TEST'),
        'impreso': {'booleanValue': False},
        'visto': {'booleanValue': False},
        'cliente': {'mapValue': {'fields': {
            'nombre': texto('Prueba Automatica'),
            'telefono': texto('3510000000'),
        }}},
        'entrega': {'mapValue': {'fields': {'modo': texto('retiro')}}},
        'items': {'arrayValue': {'values': [
            {'mapValue': {'fields': {
                'id': texto('x'), 'nombre': texto('Producto de prueba'),
                'cantidad': numero(1), 'precio': numero(100),
            }}},
        ]}},
        'subtotal': numero(100),
        'envio': numero(0),
        'total': numero(100),
        'nota': texto('Pedido de prueba de scripts/probar_tienda.py'),
    }
    campos.update(cambios)
    return campos


def crear(campos, doc_id):
    """
    Crea con :commit para poder mandar `creado` como hora del servidor.

    Las reglas exigen `creado == request.time`, y eso no se puede escribir con
    un valor puesto por el cliente: tiene que ser una transformacion, que es lo
    que hace serverTimestamp() en la tienda.
    """
    cuerpo = {'writes': [{
        'update': {'name': f'projects/{PROYECTO}/databases/(default)/documents/tienda_pedidos/{doc_id}',
                   'fields': campos},
        'currentDocument': {'exists': False},
        'updateTransforms': [{'fieldPath': 'creado', 'setToServerValue': 'REQUEST_TIME'}],
    }]}
    url = f'https://firestore.googleapis.com/v1/projects/{PROYECTO}/databases/(default)/documents:commit'
    return pedir('POST', url, cuerpo)


def main():
    print('\nLectura publica')
    revisar('tienda_productos se lee sin sesion', se_lee('tienda_productos') == 200)
    revisar('tienda_config se lee sin sesion', se_lee('tienda_config') == 200)

    print('\nLo que no se puede ver')
    for coleccion in ('catalogo', 'ventas', 'ventas_por_dia', 'perfiles_facturacion',
                      'cierres_caja', 'gastos', 'clientes_facturacion', 'remote_terminal'):
        codigo = se_lee(coleccion)
        revisar(f'{coleccion} da PERMISSION_DENIED', codigo == 403, f'devolvio {codigo}')

    print('\nPedidos')
    codigo = se_lee('tienda_pedidos')
    revisar('no se puede listar la coleccion de pedidos', codigo == 403,
            'listarla seria entregar el telefono y la direccion de todos los clientes')

    codigo, _ = crear(pedido_de_prueba(total=numero(1)), 'zz-prueba-total')
    revisar('rechaza un pedido cuyo total no cierra', codigo == 403, f'devolvio {codigo}')

    codigo, _ = crear(pedido_de_prueba(estado=texto('entregado')), 'zz-prueba-estado')
    revisar('rechaza un pedido que nace entregado', codigo == 403, f'devolvio {codigo}')

    codigo, _ = crear(pedido_de_prueba(cliente={'mapValue': {'fields': {
        'nombre': texto('a'), 'telefono': texto('351')}}}), 'zz-prueba-nombre')
    revisar('rechaza un pedido sin nombre ni telefono de verdad', codigo == 403,
            f'devolvio {codigo}')

    doc_id = 'zz-prueba-valida'
    codigo, _ = crear(pedido_de_prueba(), doc_id)
    creado = revisar('acepta un pedido bien armado', codigo == 200, f'devolvio {codigo}')

    if creado:
        codigo, _ = pedir('GET', f'{BASE}/tienda_pedidos/{doc_id}')
        revisar('el cliente puede leer el suyo sabiendo el id', codigo == 200)

        codigo, _ = pedir('PATCH',
                          f'{BASE}/tienda_pedidos/{doc_id}?updateMask.fieldPaths=estado',
                          {'fields': {'estado': texto('entregado')}})
        revisar('nadie de afuera puede cambiarle el estado', codigo == 403, f'devolvio {codigo}')

    print('\nEscritura del espejo')
    codigo, _ = pedir('PATCH', f'{BASE}/tienda_productos/zz-prueba?updateMask.fieldPaths=precio',
                      {'fields': {'precio': numero(1)}})
    revisar('no se puede tocar un precio de la tienda sin sesion', codigo == 403,
            f'devolvio {codigo}')

    codigo, _ = pedir('PATCH', f'{BASE}/tienda_config/settings?updateMask.fieldPaths=abierta',
                      {'fields': {'abierta': {'booleanValue': False}}})
    revisar('no se puede cerrar la tienda sin sesion', codigo == 403, f'devolvio {codigo}')

    if creado:
        print('\nLimpieza')
        limpiar(doc_id)

    print()
    fallas = [q for q, ok, _ in resultados if not ok]
    if fallas:
        print(f'{ROJO}{len(fallas)} de {len(resultados)} pruebas fallaron{FIN}')
        for q in fallas:
            print(f'  · {q}')
        return 1

    print(f'{VERDE}Las {len(resultados)} pruebas pasaron.{FIN}')
    return 0


def limpiar(doc_id):
    """Borra el pedido de prueba con la clave de servicio."""
    clave = os.path.join(RAIZ, 'firebase_key.json')
    if not os.path.exists(clave):
        print(f'{ROJO}  Falta firebase_key.json: borra a mano tienda_pedidos/{doc_id}{FIN}')
        return
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
        if not firebase_admin._apps:
            firebase_admin.initialize_app(credentials.Certificate(clave))
        firestore.client().collection('tienda_pedidos').document(doc_id).delete()
        revisar('el pedido de prueba quedo borrado', True)
    except Exception as err:                                    # noqa: BLE001
        print(f'{ROJO}  No se pudo borrar tienda_pedidos/{doc_id}: {err}{FIN}')


if __name__ == '__main__':
    sys.exit(main())
