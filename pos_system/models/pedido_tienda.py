"""
Los pedidos de la tienda online, vistos desde la caja.

Sin Qt ni Firebase: recibe el pedido (y el catálogo cuando hace falta) y decide.
Quien escribe es `pos_system/utils/pedidos_tienda_nube.py`, adentro de una
transacción que vuelve a leer el pedido; lo que se decide acá es qué escribir o
por qué no. Así las reglas se prueban solas y la transacción queda finita.

El recorrido de un pedido y quién hace cada cosa:

    nuevo → preparando → listo → (en_camino) → entregado → cobrado
                                                    │
      el stock sale al ENTREGAR ────────────────────┘   la plata entra al COBRAR

  · Entregar descuenta el stock del catálogo (la mercadería ya salió). Lo hace
    la caja al marcarlo, el panel con su botón, o cualquier PC abierta cuando
    lo entrega el repartidor (`venta_pendiente`).
  · Cobrar registra la venta en la caja del día, con la pantalla de cobro de
    siempre. Una sola vez por pedido: la transacción del cobro es el único
    lugar donde nace la venta.

Campos del pedido que se usan (los viejos se respetan tal cual):

  venta_pendiente     lo pone `reparto-mover` al entregar: falta descontar el
                      stock. Mientras esté en true la tienda lo sigue apartando
                      (`stockComprometido`), así que se apaga al descontar.
  stock_descontado    el stock ya salió.
  venta_registrada    "el panel no tiene que registrar nada". Hasta el 16-09 lo
                      ponía el panel junto con la venta TIENDA; ahora lo pone
                      también el descuento de stock. Es lo que frena a un panel
                      con la versión vieja: su transacción mira este campo y,
                      si está, no descuenta ni registra otra vez.
  venta_id            `TIENDA_<codigo>` si la registró el panel viejo;
                      `<pc_id>_<sale_id>` si se cobró en una caja.
  cobro_pendiente     entregado y con el stock afuera, falta cobrarlo.
  cobro               {estado: en_curso|hecho, pc_id, pc_nombre, cajero, ...}.
                      En curso es la marca de "lo está cobrando esta caja".
  factura             {estado: en_curso|emitida, tipo, numero, cae, ...}.
"""
import math
import re
import unicodedata
from datetime import datetime, timedelta, timezone

TZ_AR = timezone(timedelta(hours=-3))

ESTADOS_EN_CURSO = ('nuevo', 'preparando', 'listo', 'en_camino')

ETIQUETAS = {
    'nuevo':      'Nuevo',
    'preparando': 'Preparando',
    'listo':      'Listo',
    'en_camino':  'En camino',
    'entregado':  'Entregado',
    'cancelado':  'Cancelado',
}

# Cuánto dura la marca de "lo está cobrando / facturando otra caja". Pasado
# este tiempo se puede tomar, pero preguntando: la otra PC pudo haberse colgado
# con la pantalla de cobro abierta. Tomarla nunca duplica la venta (la
# transacción del cobro exige la marca propia), solo evita que dos cajeros
# tipeen el mismo cobro a la vez.
MINUTOS_MARCA = 5

PREFIJO_VENTA_PANEL = 'TIENDA_'


# ── Números como los lee el panel ───────────────────────────────────────────

def num(valor, por_defecto=0.0):
    """`num()` de webapp/src/conjunto.js: lo que no es un número finito vale el
    valor por defecto (vacío, None, texto, infinito)."""
    if valor is None or valor == '' or isinstance(valor, (list, dict)):
        return por_defecto
    try:
        n = float(valor)
    except (TypeError, ValueError):
        return por_defecto
    return n if math.isfinite(n) else por_defecto


def _redondear(n):
    """Math.round(n * 10000) / 10000, que redondea el .5 para arriba."""
    return math.floor(n * 10000 + 0.5) / 10000


def _limpio(n):
    """Un entero se escribe como entero. Firestore guarda 59.0 como double y
    59 como entero, y el panel escribe enteros: mezclar tipos en el mismo campo
    es lo que dejó stocks como "60.0" el 15-09."""
    if isinstance(n, float) and n.is_integer():
        return int(n)
    return n


def _texto_num(n):
    """Cómo se ve un número dentro de un texto en JavaScript: 2 y no 2.0."""
    n = float(n)
    return str(int(n)) if n.is_integer() else repr(n)


def repartir_total(total, contenido):
    """`repartirTotal` del panel, con su redondeo a cuatro decimales. La cuenta
    de `models/conjunto.py` no redondea; para el stock de un pedido manda la
    del panel, que es la que se compara en `casos_pedido_venta.json`."""
    t = max(0.0, _redondear(num(total)))
    c = num(contenido)
    if not c > 0:
        return {'unidades': 0, 'restante': t, 'total': t}
    cerrados = math.floor(t / c)
    resto = _redondear(t - cerrados * c)
    if resto < 1e-9:
        return {'unidades': cerrados, 'restante': 0, 'total': t}
    return {'unidades': cerrados, 'restante': resto, 'total': t}


def descontar_de_total(total, delta, contenido):
    return repartir_total(max(0.0, num(total) - num(delta)), contenido)


def contenido_de(variedad, contenido_producto):
    propio = num((variedad or {}).get('contenido'))
    return propio if propio > 0 else num(contenido_producto)


def total_variedad(variedad, contenido_producto):
    v = variedad or {}
    return num(v.get('unidades')) * contenido_de(v, contenido_producto) + num(v.get('restante'))


def total_conjunto(colores, contenido_producto):
    return sum(total_variedad(c, contenido_producto)
               for c in (colores if isinstance(colores, list) else [])
               if isinstance(c, dict))


# ── La regla del stock (gemela de webapp/src/pedido_venta.js) ───────────────

def normalizar_nombre(texto):
    t = unicodedata.normalize('NFD', str('' if texto is None else texto).lower())
    t = ''.join(ch for ch in t if not (0x300 <= ord(ch) <= 0x36F))
    return re.sub(r'\s+', ' ', t).strip()


def unidades_base(item):
    """Cuántas unidades base del producto se lleva el renglón."""
    cantidad = num((item or {}).get('cantidad'))
    if (item or {}).get('es_pack'):
        return cantidad * max(1.0, num(item.get('pack_contenido')) or 1.0)
    return cantidad


def variedad_del_catalogo(datos, nombre_vendido):
    buscado = normalizar_nombre(nombre_vendido)
    if not buscado:
        return None
    colores = (datos or {}).get('conjunto_colores')
    colores = colores if isinstance(colores, list) else []
    for c in colores:
        if isinstance(c, dict) and normalizar_nombre(c.get('color')) == buscado:
            return c
    ajustes = (datos or {}).get('tienda_variedades')
    ajustes = ajustes if isinstance(ajustes, dict) else {}
    for clave, ajuste in ajustes.items():
        if normalizar_nombre((ajuste or {}).get('nombre') if isinstance(ajuste, dict) else None) == buscado:
            for c in colores:
                if isinstance(c, dict) and normalizar_nombre(c.get('color')) == normalizar_nombre(clave):
                    return c
    return None


def _es_si(valor):
    return valor is True or valor == 1


def plan_descuento(items, catalogo_por_id, devolver=False):
    """Qué le pasa al stock de cada producto del pedido.

    Con `devolver` hace la cuenta al revés (la mercadería vuelve): es lo que usa
    `scripts/revisar_pedidos_tienda.py` para deshacer un descuento. El panel no
    tiene esa variante; la devolución de una venta borrada es `stock_revert.js`.

    Misma cuenta que `planDescuento` del panel, renglón por renglón:
      · suelto: la cantidad; pack: cantidad × contenido.
      · conjunto: se descuenta del total y se vuelve a repartir en cerrados +
        sueltos; con variedades, de la variedad que corresponda.
      · el stock de un producto común puede quedar negativo, como en el POS.

    Devuelve {'productos': [{id, nombre, campos, movimientos, saltado}],
              'saltados': [{idx, id?, motivo}]}. No toca lo que recibe.
    """
    trabajo = {}
    saltados = []

    def tomar(pid):
        if pid not in trabajo:
            base = (catalogo_por_id or {}).get(pid)
            trabajo[pid] = {
                'id': pid,
                'nombre': str((base or {}).get('nombre') or ''),
                'datos': _copia(base) if base else None,
                'campos': {},
                'movimientos': [],
                'saltado': None,
            }
        return trabajo[pid]

    for idx, item in enumerate(items or []):
        item = item or {}
        pid = str(item.get('id') or '').strip()
        if not pid:
            saltados.append({'idx': idx, 'motivo': 'renglón sin producto'})
            continue
        p = tomar(pid)
        base = unidades_base(item)
        if not p['datos']:
            p['saltado'] = 'no está en el catálogo'
            saltados.append({'idx': idx, 'id': pid, 'motivo': p['saltado']})
            continue
        if _es_si(p['datos'].get('stock_ilimitado')):
            p['saltado'] = 'servicio sin stock'
            saltados.append({'idx': idx, 'id': pid, 'motivo': p['saltado']})
            continue
        if not base > 0:
            saltados.append({'idx': idx, 'id': pid, 'motivo': 'cantidad en cero'})
            continue
        delta = -base if devolver else base
        if not p['nombre']:
            p['nombre'] = str(item.get('nombre') or '')

        d = p['datos']
        cantidad = num(item.get('cantidad'))
        detalle_pack = ''
        if item.get('es_pack'):
            plural = '' if cantidad == 1 else 's'
            detalle_pack = f" ({_texto_num(cantidad)} {item.get('pack_nombre') or 'pack'}{plural})"

        if _es_si(d.get('es_conjunto')):
            cont_global = num(d.get('conjunto_contenido'))
            colores = d.get('conjunto_colores') if isinstance(d.get('conjunto_colores'), list) else []
            if colores:
                v = variedad_del_catalogo(d, item.get('variedad'))
                if v is None:
                    saltados.append({'idx': idx, 'id': pid,
                                     'motivo': f'variedad "{item.get("variedad") or ""}" no encontrada'})
                    continue
                cont = contenido_de(v, cont_global)
                antes_var = total_variedad(v, cont_global)
                r = descontar_de_total(antes_var, delta, cont)
                antes_total = total_conjunto(colores, cont_global)
                nuevos = [dict(c, unidades=r['unidades'], restante=r['restante']) if c is v else c
                          for c in colores]
                total = total_conjunto(nuevos, cont_global)
                d['conjunto_colores'] = nuevos
                d['conjunto_total'] = total
                d['conjunto_unidades'] = sum(num(c.get('unidades')) for c in nuevos if isinstance(c, dict))
                d['conjunto_restante'] = sum(num(c.get('restante')) for c in nuevos if isinstance(c, dict))
                d['stock'] = max(0, math.floor(total))
                p['campos'].update({
                    'conjunto_colores': nuevos, 'conjunto_total': total,
                    'conjunto_unidades': d['conjunto_unidades'],
                    'conjunto_restante': d['conjunto_restante'], 'stock': d['stock'],
                })
                p['movimientos'].append({
                    'antes': antes_total, 'despues': total, 'cantidad': -(antes_var - r['total']),
                    'detalle': f"Variedad {v.get('color')}{detalle_pack}",
                })
            else:
                antes = num(d.get('conjunto_total'))
                r = descontar_de_total(antes, delta, cont_global)
                d['conjunto_total'] = r['total']
                d['conjunto_unidades'] = r['unidades']
                d['conjunto_restante'] = r['restante']
                d['stock'] = max(0, math.floor(r['total']))
                p['campos'].update({
                    'conjunto_total': r['total'], 'conjunto_unidades': r['unidades'],
                    'conjunto_restante': r['restante'], 'stock': d['stock'],
                })
                p['movimientos'].append({'antes': antes, 'despues': r['total'],
                                         'cantidad': -(antes - r['total']),
                                         'detalle': detalle_pack.strip()})
        else:
            antes = num(d.get('stock'))
            despues = antes - delta
            d['stock'] = despues
            p['campos']['stock'] = despues
            p['movimientos'].append({'antes': antes, 'despues': despues,
                                     'cantidad': -delta, 'detalle': detalle_pack.strip()})

    productos = []
    for p in trabajo.values():
        productos.append({
            'id': p['id'], 'nombre': p['nombre'], 'saltado': p['saltado'],
            'campos': _campos_limpios(p['campos']), 'movimientos': p['movimientos'],
        })
    return {'productos': productos, 'saltados': saltados}


def _copia(valor):
    if isinstance(valor, dict):
        return {k: _copia(v) for k, v in valor.items()}
    if isinstance(valor, list):
        return [_copia(v) for v in valor]
    return valor


def _campos_limpios(campos):
    salida = {}
    for clave, valor in campos.items():
        if clave == 'conjunto_colores':
            salida[clave] = [
                {k: _limpio(v) for k, v in c.items()} if isinstance(c, dict) else c
                for c in valor
            ]
        else:
            salida[clave] = _limpio(valor)
    return salida


def cambios_para_la_tienda(plan, catalogo_por_id):
    """Lo que el aviso a la tienda del POS (`_avisar_a_la_tienda`) necesita para
    dejar la vidriera con el stock nuevo, en su mismo formato de tuplas."""
    salida = []
    for p in plan.get('productos') or []:
        if p.get('saltado') or not p.get('campos'):
            continue
        base = (catalogo_por_id or {}).get(p['id']) or {}
        campos = p['campos']
        if 'conjunto_colores' in campos:
            salida.append((p['id'], float(campos.get('conjunto_total') or 0),
                           campos['conjunto_colores'], num(base.get('conjunto_contenido')),
                           base.get('tienda_variedades') or {}))
        elif 'conjunto_total' in campos:
            salida.append((p['id'], float(campos.get('conjunto_total') or 0)))
        else:
            salida.append((p['id'], float(campos.get('stock') or 0)))
    return salida


# ── Quién puede hacer qué ───────────────────────────────────────────────────

def dia_argentina(fecha):
    return fecha.astimezone(TZ_AR).strftime('%Y-%m-%d')


def _fecha(marca):
    """Fecha con zona de lo que venga de Firestore (datetime) o de un texto."""
    if isinstance(marca, datetime):
        return marca if marca.tzinfo else marca.replace(tzinfo=timezone.utc)
    if isinstance(marca, str) and marca:
        try:
            f = datetime.fromisoformat(marca)
            return f if f.tzinfo else f.replace(tzinfo=TZ_AR)
        except ValueError:
            return None
    return None


def whatsapp_de_telefono(telefono):
    """El número como lo quiere wa.me (549 + área + número). Gemela de
    `whatsappDeTelefono` en tienda/src/telefono.js."""
    d = re.sub(r'\D', '', str(telefono or ''))
    if len(d) < 8:
        return None
    if d.startswith('00'):
        d = d[2:]
    if d.startswith('54'):
        d = d[2:]
    d = re.sub(r'^0', '', d)
    if d.startswith('9') and len(d) > 10:
        d = d[1:]
    if len(d) == 12:
        d = re.sub(r'^(\d{2,4})15', r'\1', d)
    return f'549{d}' if len(d) >= 8 else None


DIRECCION_LOCAL = 'Av. Alfonsina Storni 168'


def nombre_corto(pedido):
    """Solo el primer nombre: "Hola María Fernanda Gómez" no lo dice nadie."""
    partes = str(((pedido or {}).get('cliente') or {}).get('nombre') or '').strip().split()
    return partes[0] if partes else ''


def mensaje_whatsapp(pedido, direccion_local=''):
    """Lo que se le escribe al cliente según en qué anda el pedido. Gemela de
    `mensajeDe` en webapp/src/avisos_pedido.js (la prueba de la tienda las
    compara); None en un estado sin mensaje."""
    p = pedido or {}
    n, codigo = nombre_corto(p), p.get('codigo')
    estado = p.get('estado')
    if estado == 'preparando':
        return f'Hola {n}, estamos preparando tu pedido {codigo}. Te avisamos apenas esté.'
    if estado == 'listo':
        if (p.get('entrega') or {}).get('modo') == 'delivery':
            return f'Hola {n}, tu pedido {codigo} ya está listo y sale para tu casa.'
        return (f'Hola {n}, tu pedido {codigo} ya está listo para que lo retires.'
                + (f' Te esperamos en {direccion_local}.' if direccion_local else ''))
    if estado == 'en_camino':
        return f'Hola {n}, tu pedido {codigo} salió para tu casa. Llega en un rato.'
    if estado == 'entregado':
        return f'Hola {n}, gracias por tu compra. Cualquier cosa que necesites, escribinos por acá.'
    if estado == 'cancelado':
        return f'Hola {n}, tuvimos que cancelar tu pedido {codigo}. Cualquier duda, escribinos.'
    return None


def diferencias_de_devolucion(plan, movimientos):
    """Lo que una devolución de stock pondría contra lo que salió de verdad.

    La devolución se calcula con el catálogo de hoy; si entre la entrega y la
    devolución cambió algo (variedad renombrada o creada, contenido del pack,
    producto que pasó a sin stock, un renglón que al entregar se salteó),
    devolvería otra cantidad. Cada diferencia es
    {producto_id, detalle, salio, devolveria}; vacío es que coinciden.
    """
    devuelve, salio = {}, {}
    for p in (plan or {}).get('productos') or []:
        if p.get('saltado') or not p.get('campos'):
            continue
        for m in p.get('movimientos') or []:
            k = (str(p.get('id') or ''), str(m.get('detalle') or ''))
            devuelve[k] = devuelve.get(k, 0.0) + num(m.get('cantidad'))
    for m in movimientos or []:
        k = (str(m.get('firebase_id') or ''), str(m.get('detalle') or ''))
        salio[k] = salio.get(k, 0.0) - num(m.get('cantidad'))
    return [{'producto_id': k[0], 'detalle': k[1], 'salio': round(salio.get(k, 0.0), 4),
             'devolveria': round(devuelve.get(k, 0.0), 4)}
            for k in sorted(set(devuelve) | set(salio))
            if abs(devuelve.get(k, 0.0) - salio.get(k, 0.0)) > 0.001]


def marca_publica(quien):
    """Quién hizo algo, tal como puede quedar en el pedido.

    El documento del pedido lo lee cualquiera que tenga el enlace de
    seguimiento. Ahí va la caja y el primer nombre del cajero, nunca un mail ni
    el nombre completo: el detalle entero queda en `tienda_pedidos_eventos`,
    que solo lee el local.
    """
    quien = quien or {}
    cajero = str(quien.get('cajero') or '').strip()
    if '@' in cajero:
        cajero = ''
    return {
        'pc_id': str(quien.get('pc_id') or ''),
        'pc_nombre': str(quien.get('pc_nombre') or ''),
        'cajero': cajero.split()[0] if cajero else '',
    }


def es_envio(pedido):
    return ((pedido or {}).get('entrega') or {}).get('modo') == 'delivery'


def quien_texto(marca):
    """"Caja 2 (Mari)" para decirle al cajero quién tiene el pedido."""
    marca = marca or {}
    pc = str(marca.get('pc_nombre') or marca.get('pc_id') or 'otra PC')
    cajero = str(marca.get('cajero') or '').strip()
    return f'{pc} ({cajero})' if cajero else pc


def cobrado(pedido):
    return ((pedido or {}).get('cobro') or {}).get('estado') == 'hecho'


def registrado_por_el_panel(pedido):
    """Venta TIENDA que registró el panel viejo (stock y venta juntos). No se
    cobra en la caja: la plata ya está contada. Solo se puede facturar."""
    p = pedido or {}
    return (p.get('venta_registrada') is True
            and str(p.get('venta_id') or '').startswith(PREFIJO_VENTA_PANEL)
            and not cobrado(p))


def stock_afuera(pedido):
    p = pedido or {}
    return p.get('stock_descontado') is True or p.get('venta_registrada') is True


def a_cobrar(pedido):
    p = pedido or {}
    return (p.get('estado') == 'entregado'
            and not cobrado(p)
            and not registrado_por_el_panel(p))


def marca_vigente(marca, ahora, pc_id=None):
    """Una marca de "en curso" de OTRA PC que todavía no venció."""
    marca = marca or {}
    if marca.get('estado') != 'en_curso':
        return False
    if pc_id is not None and marca.get('pc_id') == pc_id:
        return False
    desde = _fecha(marca.get('desde'))
    if desde is None:
        return True
    return (ahora - desde) < timedelta(minutes=MINUTOS_MARCA)


def siguientes(pedido):
    """Pasos a los que se puede mover un pedido desde la caja, en orden."""
    p = pedido or {}
    estado = p.get('estado')
    if estado == 'nuevo':
        return ['preparando']
    if estado == 'preparando':
        return ['listo']
    if estado == 'listo':
        return ['en_camino', 'entregado'] if es_envio(p) else ['entregado']
    if estado == 'en_camino':
        return ['entregado']
    return []


def _rechazo_base(pedido):
    if pedido is None:
        return 'el pedido ya no existe'
    if pedido.get('estado') == 'cancelado':
        return 'lo cancelaron'
    return None


def decidir_mover(pedido, desde, hacia, quien, ahora):
    """Preparando, listo o en camino. Entregar tiene su propia decisión porque
    descuenta stock.

    `desde` es el estado que el cajero tenía a la vista: si en la base ya es
    otro, alguien lo movió desde otra PC y el botón que se tocó está viejo.
    """
    rechazo = _rechazo_base(pedido)
    if rechazo:
        return {'rechazo': rechazo}
    if stock_afuera(pedido) or pedido.get('estado') == 'entregado':
        return {'rechazo': 'ya se entregó'}
    actual = pedido.get('estado')
    if actual != desde:
        movido = pedido.get('movido_por') or {}
        por = f' desde {quien_texto(movido)}' if movido.get('estado') == actual else ''
        return {'rechazo': f'ya lo pasaron a "{ETIQUETAS.get(actual, actual)}"{por}'}
    if hacia == 'entregado' or hacia not in siguientes(pedido):
        return {'rechazo': 'ese paso no corresponde'}
    marca = {**marca_publica(quien), 'en': ahora}
    campos = {'estado': hacia, 'visto': True, 'movido_por': {**marca, 'estado': hacia}}
    if actual == 'nuevo':
        campos['tomado_por'] = marca
    return {'campos': campos}


def decidir_entrega(pedido, catalogo_por_id, quien, ahora, origen='pos'):
    """Marca entregado (si hace falta) y descuenta el stock una sola vez.

    Devuelve {'rechazo'} o {'campos', 'plan'}; `plan` es None cuando el stock ya
    había salido (lo descontó otra PC, el panel, o es una venta TIENDA vieja).
    """
    rechazo = _rechazo_base(pedido)
    if rechazo:
        return {'rechazo': rechazo}
    estado = pedido.get('estado')
    if estado not in ('listo', 'en_camino', 'entregado'):
        return {'rechazo': 'todavía no está listo para entregar'}

    campos = {'venta_pendiente': False}
    if estado != 'entregado':
        campos.update({
            'estado': 'entregado', 'visto': True,
            'entregado_en': ahora, 'entregado_dia': dia_argentina(ahora),
            'entregado_por': origen,
            'movido_por': {**marca_publica(quien), 'en': ahora, 'estado': 'entregado'},
        })
    if stock_afuera(pedido):
        return {'campos': campos, 'plan': None}

    plan = plan_descuento(pedido.get('items') or [], catalogo_por_id)
    campos.update({
        'stock_descontado': True,
        'venta_registrada': True,
        'cobro_pendiente': True,
        # Lo que no salió del stock (variedad renombrada, producto borrado) se
        # anota en el pedido para que la caja y el panel lo muestren: antes
        # solo quedaba en el log de la PC que lo descontó.
        'stock_saltados': [
            {'renglon': x.get('idx'), 'producto_id': x.get('id') or '', 'motivo': x.get('motivo') or '',
             'nombre': str(((pedido.get('items') or [])[x['idx']] or {}).get('nombre') or '')
             if isinstance(x.get('idx'), int) and x['idx'] < len(pedido.get('items') or []) else ''}
            for x in plan['saltados']
        ],
        'stock_descontado_por': {**marca_publica(quien), 'en': ahora, 'origen': origen},
    })
    return {'campos': campos, 'plan': plan}


def decidir_tomar_cobro(pedido, quien, ahora, intento, forzar=False):
    """La caja toma el pedido para cobrarlo.

    Devuelve {'rechazo', 'motivo'} o {'campos'}. `motivo` distingue lo que se
    puede resolver preguntando ('vencida': la otra caja lleva rato sin
    terminar) de lo que no.
    """
    rechazo = _rechazo_base(pedido)
    if rechazo:
        return {'rechazo': rechazo, 'motivo': 'estado'}
    if cobrado(pedido):
        return {'rechazo': f"ya lo cobró {quien_texto(pedido.get('cobro'))}", 'motivo': 'cobrado'}
    if registrado_por_el_panel(pedido):
        return {'rechazo': 'la venta ya la registró el panel', 'motivo': 'panel'}
    if pedido.get('estado') not in ('listo', 'en_camino', 'entregado'):
        return {'rechazo': 'todavía no está listo para entregar', 'motivo': 'estado'}
    marca = pedido.get('cobro') or {}
    if marca.get('estado') == 'en_curso' and marca.get('pc_id') != quien.get('pc_id'):
        if marca_vigente(marca, ahora):
            return {'rechazo': f'lo está cobrando {quien_texto(marca)}', 'motivo': 'ocupado'}
        if not forzar:
            return {'rechazo': f'{quien_texto(marca)} empezó a cobrarlo y no terminó',
                    'motivo': 'vencida'}
    return {'campos': {'cobro': {'estado': 'en_curso', **marca_publica(quien), 'desde': ahora,
                                 'intento': intento}}}


def decidir_soltar_cobro(pedido, intento):
    marca = (pedido or {}).get('cobro') or {}
    if marca.get('estado') == 'en_curso' and marca.get('intento') == intento:
        return {'soltar': True}
    return {'soltar': False}


def decidir_cobro(pedido, catalogo_por_id, quien, ahora, intento, pago, origen='pos'):
    """Registra el cobro. Es el único lugar donde nace la venta de un pedido.

    Exige la marca propia: si otra caja la tomó (porque esta venció), o si otra
    caja o el panel ya lo resolvieron, rechaza. Si el pedido todavía no estaba
    entregado ("entregar y cobrar" en el mostrador), la entrega y el stock van
    en la misma transacción.
    """
    rechazo = _rechazo_base(pedido)
    if rechazo:
        return {'rechazo': rechazo}
    if cobrado(pedido):
        return {'rechazo': f"ya lo cobró {quien_texto(pedido.get('cobro'))}"}
    if registrado_por_el_panel(pedido):
        return {'rechazo': 'la venta ya la registró el panel'}
    marca = pedido.get('cobro') or {}
    if marca.get('estado') != 'en_curso' or marca.get('intento') != intento:
        otra = f' ({quien_texto(marca)})' if marca.get('estado') == 'en_curso' else ''
        return {'rechazo': f'otra caja tomó el pedido para cobrarlo{otra}'}

    entrega = decidir_entrega(pedido, catalogo_por_id, quien, ahora, origen)
    if 'rechazo' in entrega:
        return entrega
    campos = dict(entrega['campos'])
    campos['cobro_pendiente'] = False
    campos['cobro'] = {
        'estado': 'hecho', **marca_publica(quien), 'en': ahora, 'intento': intento,
        'desde': marca.get('desde'),
        # Lo que se cobró de verdad: con envío a confirmar puede ser otro total.
        'total': _limpio(num((pago or {}).get('total'), num(pedido.get('total')))),
        'pago': {k: (pago or {}).get(k) for k in ('payment_type', 'payment_subtype') if (pago or {}).get(k)},
    }
    return {'campos': campos, 'plan': entrega['plan']}


def decidir_anotar_venta(pedido, intento, pc_id, sale_id):
    cobro = (pedido or {}).get('cobro') or {}
    if cobro.get('estado') != 'hecho' or cobro.get('intento') != intento or cobro.get('pc_id') != pc_id:
        return {'rechazo': 'el cobro no es de esta caja'}
    return {'campos': {'venta_id': f'{pc_id}_{int(sale_id)}', 'cobro.venta_local': int(sale_id)}}


def decidir_cancelar(pedido, quien, ahora):
    rechazo = _rechazo_base(pedido)
    if rechazo:
        return {'rechazo': 'ya estaba cancelado' if pedido else rechazo}
    if pedido.get('estado') == 'entregado' or stock_afuera(pedido) or cobrado(pedido):
        return {'rechazo': 'ya se entregó'}
    marca = pedido.get('cobro') or {}
    if marca_vigente(marca, ahora):
        return {'rechazo': f'lo está cobrando {quien_texto(marca)}'}
    return {'campos': {'estado': 'cancelado', 'visto': True,
                       'cancelado_por': {**marca_publica(quien), 'en': ahora}}}


def decidir_anular_entrega(pedido, catalogo_por_id, quien, ahora, motivo):
    """El pedido se entregó pero no va: lo devolvieron o se marcó por error.

    Devuelve el stock con la misma cuenta al revés y deja el pedido cancelado
    (el cupón recupera su uso, como con cualquier cancelación). Un pedido
    cobrado se puede anular igual: la venta de la caja NO se toca desde acá;
    si se devolvió la plata, se borra esa venta aparte.
    """
    rechazo = _rechazo_base(pedido)
    if rechazo:
        return {'rechazo': 'ya estaba cancelado' if pedido else rechazo}
    if pedido.get('estado') != 'entregado':
        return {'rechazo': 'todavía no se entregó: se cancela con Cancelar pedido'}
    if registrado_por_el_panel(pedido):
        return {'rechazo': 'la venta la registró el panel: se anula borrando esa venta en el panel'}
    if not str(motivo or '').strip():
        return {'rechazo': 'falta el motivo'}
    marca = pedido.get('cobro') or {}
    if marca_vigente(marca, ahora):
        return {'rechazo': f'lo está cobrando {quien_texto(marca)}'}
    plan = (plan_descuento(pedido.get('items') or [], catalogo_por_id, devolver=True)
            if pedido.get('stock_descontado') is True else None)
    campos = {
        'estado': 'cancelado', 'visto': True,
        'stock_descontado': False, 'venta_registrada': False,
        'cobro_pendiente': False, 'venta_pendiente': False,
        'anulado': {**marca_publica(quien), 'en': ahora, 'motivo': str(motivo).strip()[:200],
                    'estaba_cobrado': cobrado(pedido)},
    }
    return {'campos': campos, 'plan': plan}


def decidir_tomar_factura(pedido, quien, ahora, intento, forzar=False):
    rechazo = _rechazo_base(pedido)
    if rechazo:
        return {'rechazo': rechazo, 'motivo': 'estado'}
    factura = pedido.get('factura') or {}
    if factura.get('estado') == 'emitida':
        return {'rechazo': f"ya está facturado ({factura.get('tipo') or ''} "
                           f"{factura.get('numero') or ''}) en {quien_texto(factura)}".replace('  ', ' '),
                'motivo': 'emitida'}
    if not (cobrado(pedido) or registrado_por_el_panel(pedido)):
        return {'rechazo': 'primero hay que cobrarlo', 'motivo': 'estado'}
    if factura.get('estado') == 'en_curso':
        # Una factura empezada y sin terminar puede haber salido en ARCA (la PC
        # se cortó después del CAE). Se pregunta siempre, también si la empezó
        # esta misma caja: retomarla en silencio es la forma de facturar dos veces.
        propia = factura.get('pc_id') == quien.get('pc_id')
        if not propia and marca_vigente(factura, ahora):
            return {'rechazo': f'lo está facturando {quien_texto(factura)}', 'motivo': 'ocupado'}
        if not forzar:
            quien_la = 'esta caja' if propia else quien_texto(factura)
            return {'rechazo': f'{quien_la} empezó a facturarlo y no terminó',
                    'motivo': 'vencida'}
    return {'campos': {'factura': {'estado': 'en_curso', **marca_publica(quien), 'desde': ahora,
                                   'intento': intento}}}


def decidir_anotar_factura(pedido, intento, datos, quien, ahora):
    """La factura salió: queda escrita aunque la marca haya vencido, porque el
    comprobante ya existe en ARCA y esconderlo sería peor."""
    factura = (pedido or {}).get('factura') or {}
    if factura.get('estado') == 'emitida' and factura.get('intento') != intento:
        return {'rechazo': 'ya había otra factura anotada', 'duplicada': True}
    return {'campos': {'factura': {
        'estado': 'emitida', **marca_publica(quien), 'en': ahora, 'intento': intento,
        'tipo': str(datos.get('tipo_comprobante') or ''),
        'punto_venta': int(num(datos.get('punto_venta'), 1)),
        'numero': int(num(datos.get('nro_comprobante'))),
        'cae': str(datos.get('cae') or ''),
        'total': _limpio(num(datos.get('total'))),
    }}}


def decidir_soltar_factura(pedido, intento):
    marca = (pedido or {}).get('factura') or {}
    return {'soltar': marca.get('estado') == 'en_curso' and marca.get('intento') == intento}


# ── Los renglones de la venta ───────────────────────────────────────────────

def _clave_cupon(r):
    return f"{r.get('id')}|{r.get('variedad') or ''}|{'p' if r.get('es_pack') else 's'}"


def _qty_texto(q):
    """Como escribe la cantidad el carrito del POS (`_fmt_qty`): 2, 2.5."""
    q = float(q or 0)
    return str(int(q)) if q == int(q) else f'{q:.2f}'.rstrip('0').rstrip('.')


def _colores_locales(producto):
    crudo = (producto or {}).get('conjunto_colores')
    if isinstance(crudo, str):
        try:
            import json
            crudo = json.loads(crudo)
        except ValueError:
            return []
    return crudo if isinstance(crudo, list) else []


def _nombre_y_cantidad(item, local, cantidad, subtotal):
    """Nombre, cantidad y precio unitario del renglón, escritos como los escribe
    el carrito del POS para un producto vendido en el mostrador.

    El panel cruza cada renglón de `ventas_por_dia` contra el catálogo POR
    NOMBRE para el costo, el margen, la urgencia de compra y la velocidad de
    venta (`webapp/src/nombre_item.js`). Con el nombre público de la tienda
    ("Acrílico Eterna x 250ml") o con un "pack x10" inventado no cruzaba con
    nada y la venta quedaba sin costo. Por eso:

      · producto común: el nombre del catálogo, y la cantidad en unidades base
        (un pack de 12 lápices son 12 lápices);
      · conjunto: "[Color]  NOMBRE  ·  2 pack(s)", "NOMBRE  ·  3 u" o
        "NOMBRE  ·  2.5 m", y con una cantidad con decimales va 1 × el total,
        que es lo que el panel espera para leer los metros del nombre.

    Sin el producto en la base local de esta PC se deja el nombre del pedido.
    """
    from pos_system.models.conjunto import TIPOS

    if not local or not str(local.get('name') or '').strip():
        nombre = str(item.get('nombre') or 'Producto').upper()
        partes = [nombre]
        if item.get('variedad'):
            partes.append(str(item['variedad']))
        if item.get('es_pack'):
            partes.append(f"{item.get('pack_nombre') or 'pack'} x{_texto_num(num(item.get('pack_contenido'), 1))}")
        return '  ·  '.join(partes), cantidad, str(item.get('variedad') or '')

    nombre = str(local['name']).strip()
    if _es_si(local.get('es_conjunto')):
        variedad = str(item.get('variedad') or '').strip()
        color = variedad
        if variedad:
            for c in _colores_locales(local):
                if isinstance(c, dict) and normalizar_nombre(c.get('color')) == normalizar_nombre(variedad):
                    color = str(c.get('color'))
                    break
        if item.get('es_pack'):
            etiqueta = (TIPOS.get(str(local.get('conjunto_tipo') or ''), {}) or {}).get('label', 'Pack')
            descripcion = f'{_qty_texto(cantidad)} {etiqueta.lower()}(s)'
        else:
            unidad = 'm' if str(item.get('unidad') or '') == 'metro' else 'u'
            descripcion = f'{_qty_texto(cantidad)} {unidad}'
        prefijo = f'[{color}]  ' if color else ''
        return f'{prefijo}{nombre}  ·  {descripcion}', cantidad, color

    return nombre, unidades_base(item), ''


def renglones_de_cobro(pedido, pedido_id, productos_locales=None):
    """El carrito que va a la pantalla de cobro y a `Sale.create`.

    `productos_locales` es {id del catálogo: fila de `products` de esta PC} (o
    solo el id local, que alcanza para atar la venta al producto).

    Todas las líneas llevan `stock_descontado`: el stock salió al entregar, el
    cobro solo registra la plata (mismo mecanismo que el cobro de un fiado).

    El cupón va adentro de cada línea, como el descuento con nombre del POS:
    la venta, el ticket y la factura muestran lo que se cobró. `tienda` viaja a
    `ventas_por_dia` con el pedido, el producto y las unidades base.
    """
    pedido = pedido or {}
    locales = productos_locales or {}
    cupon = pedido.get('cupon') if isinstance(pedido.get('cupon'), dict) else None
    descuento = max(0.0, num(pedido.get('descuento')) or num((cupon or {}).get('descuento')))
    rebajas = {_clave_cupon(r): num(r.get('descuento'))
               for r in ((cupon or {}).get('renglones') or []) if isinstance(r, dict)}
    valor_cupon = num((cupon or {}).get('valor'))
    codigo_cupon = str((cupon or {}).get('codigo') or '')
    entrega = pedido.get('entrega') or {}
    envio_gratis = descuento > 0 and ((cupon or {}).get('envio_gratis') is True
                                      or entrega.get('envio_gratis') is True)

    lineas = []
    for it in pedido.get('items') or []:
        it = it or {}
        pid = str(it.get('id') or '')
        cantidad = num(it.get('cantidad'))
        precio = num(it.get('precio'))
        bruto = num(it.get('subtotal')) or precio * cantidad
        rebaja = min(bruto, rebajas.get(_clave_cupon(it), 0.0))
        subtotal = round(bruto - rebaja, 2)
        local = locales.get(pid)
        if local is not None and not isinstance(local, dict):
            local = {'id': local}
        nombre, cantidad_venta, color = _nombre_y_cantidad(it, local, cantidad, subtotal)
        if cantidad_venta > 0 and cantidad_venta != int(cantidad_venta):
            cantidad_venta, unitario = 1, subtotal
        else:
            cantidad_venta = int(cantidad_venta)
            # Sin redondear: la venta guarda cantidad × unitario, y con el
            # unitario a 4 decimales 1000 / 3 volvía como 999,9999.
            unitario = subtotal / cantidad_venta if cantidad_venta > 0 else subtotal
        linea = {
            'product_id': int((local or {}).get('id') or 0),
            'product_name': nombre,
            'quantity': cantidad_venta,
            'unit_price': unitario,
            'original_price': round(bruto / cantidad_venta, 4) if cantidad_venta > 0 else precio,
            'subtotal': subtotal,
            'conjunto_color': color,
            'stock_descontado': True,
            'tienda': {
                'origen': 'tienda', 'pedido_id': str(pedido_id), 'producto_id': pid,
                'es_pack': bool(it.get('es_pack')),
                'pack_contenido': num(it.get('pack_contenido')) if it.get('es_pack') else None,
                'unidad': str(it.get('unidad') or 'unidad'),
                'cantidad': cantidad,
            },
        }
        if rebaja > 0:
            linea.update({'discount_type': 'cupon', 'discount_value': valor_cupon,
                          'discount_amount': round(rebaja, 2), 'descuento_nombre': codigo_cupon})
        lineas.append(linea)

    envio = num(pedido.get('envio'))
    if envio > 0:
        linea = {
            'product_id': 0,
            'product_name': 'ENVIO A DOMICILIO',
            'quantity': 1,
            'unit_price': 0.0 if envio_gratis else envio,
            'original_price': envio,
            'subtotal': 0.0 if envio_gratis else envio,
            'conjunto_color': '',
            'is_varios': True,
            'category': 'SERVICIOS',
            'stock_descontado': True,
            'tienda': {'origen': 'tienda', 'pedido_id': str(pedido_id), 'producto_id': '',
                       'es_pack': False, 'pack_contenido': None, 'unidad': 'unidad'},
        }
        if envio_gratis:
            linea.update({'discount_type': 'cupon', 'discount_value': 0,
                          'discount_amount': envio, 'descuento_nombre': codigo_cupon})
        lineas.append(linea)
    return lineas


def con_envio(pedido, envio):
    """El pedido con el costo de envío que se confirmó al cobrar.

    "Envío a confirmar" quiere decir que el cliente no pagó el envío real: se
    cobra en la caja. Se recalcula el total con la misma cuenta que
    `crear-pedido` (subtotal + envío − descuento, sin bajar de cero) y el
    envío deja de estar gratis o a confirmar.
    """
    p = dict(pedido or {})
    entrega = dict(p.get('entrega') or {})
    entrega['envio_a_confirmar'] = False
    p['entrega'] = entrega
    envio = max(0.0, num(envio))
    p['envio'] = envio
    descuento = num(p.get('descuento'))
    cupon = p.get('cupon') if isinstance(p.get('cupon'), dict) else {}
    if entrega.get('envio_gratis') or cupon.get('envio_gratis'):
        # El cupón era el envío gratis: el descuento es el envío.
        descuento = envio
        p['descuento'] = envio
    p['total'] = round(max(0.0, num(p.get('subtotal')) + envio - descuento), 2)
    return p


def total_a_cobrar(pedido):
    """El total del pedido manda: es el que vio y pagó el cliente."""
    p = pedido or {}
    total = num(p.get('total'))
    if total > 0:
        return round(total, 2)
    lineas = renglones_de_cobro(p, '')
    return round(sum(l['subtotal'] for l in lineas), 2)


def pago_sugerido(pedido):
    """'cash' si lo paga en efectivo, 'transfer' en cualquier otro caso: la
    tienda solo ofrece esos dos y transferencia es el valor por defecto."""
    modo = str(((pedido or {}).get('pago') or {}).get('modo') or '').lower()
    return 'cash' if modo == 'efectivo' else 'transfer'


# ── Para mostrar ────────────────────────────────────────────────────────────

def grupo(pedido):
    """En qué lista de la pestaña va: 'hacer', 'cobrar', 'hechos' u 'otros'."""
    p = pedido or {}
    if p.get('estado') in ESTADOS_EN_CURSO:
        return 'hacer'
    if a_cobrar(p):
        return 'cobrar'
    if p.get('estado') == 'entregado':
        return 'hechos'
    return 'otros'


def resumen_pestana(pedidos):
    """Los números del título de la pestaña: nuevos sin ver y a cobrar."""
    nuevos = sum(1 for p in pedidos if p.get('estado') == 'nuevo' and p.get('visto') is not True)
    cobrar = sum(1 for p in pedidos if grupo(p) == 'cobrar')
    return {'nuevos': nuevos, 'cobrar': cobrar}


def titulo_pestana(pedidos, base='Pedidos web'):
    r = resumen_pestana(pedidos)
    partes = []
    if r['nuevos']:
        partes.append(f"{r['nuevos']} nuevo{'s' if r['nuevos'] != 1 else ''}")
    if r['cobrar']:
        partes.append(f"{r['cobrar']} a cobrar")
    return f"{base} ({' · '.join(partes)})" if partes else base
