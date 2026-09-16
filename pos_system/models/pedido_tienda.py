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


def plan_descuento(items, catalogo_por_id):
    """Qué le pasa al stock de cada producto del pedido.

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
                r = descontar_de_total(antes_var, base, cont)
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
                r = descontar_de_total(antes, base, cont_global)
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
            despues = antes - base
            d['stock'] = despues
            p['campos']['stock'] = despues
            p['movimientos'].append({'antes': antes, 'despues': despues,
                                     'cantidad': -base, 'detalle': detalle_pack.strip()})

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
    marca = {**quien, 'en': ahora}
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
            'movido_por': {**quien, 'en': ahora, 'estado': 'entregado'},
        })
    if stock_afuera(pedido):
        return {'campos': campos, 'plan': None}

    plan = plan_descuento(pedido.get('items') or [], catalogo_por_id)
    campos.update({
        'stock_descontado': True,
        'venta_registrada': True,
        'cobro_pendiente': True,
        'stock_descontado_por': {**quien, 'en': ahora, 'origen': origen},
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
    return {'campos': {'cobro': {'estado': 'en_curso', **quien, 'desde': ahora,
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
        'estado': 'hecho', **quien, 'en': ahora, 'intento': intento,
        'desde': marca.get('desde'),
        'total': _limpio(num(pedido.get('total'))),
        'pago': dict(pago or {}),
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
                       'cancelado_por': {**quien, 'en': ahora}}}


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
    if factura.get('estado') == 'en_curso' and factura.get('pc_id') != quien.get('pc_id'):
        if marca_vigente(factura, ahora):
            return {'rechazo': f'lo está facturando {quien_texto(factura)}', 'motivo': 'ocupado'}
        if not forzar:
            return {'rechazo': f'{quien_texto(factura)} empezó a facturarlo y no terminó',
                    'motivo': 'vencida'}
    return {'campos': {'factura': {'estado': 'en_curso', **quien, 'desde': ahora,
                                   'intento': intento}}}


def decidir_anotar_factura(pedido, intento, datos, quien, ahora):
    """La factura salió: queda escrita aunque la marca haya vencido, porque el
    comprobante ya existe en ARCA y esconderlo sería peor."""
    factura = (pedido or {}).get('factura') or {}
    if factura.get('estado') == 'emitida' and factura.get('intento') != intento:
        return {'rechazo': 'ya había otra factura anotada', 'duplicada': True}
    return {'campos': {'factura': {
        'estado': 'emitida', **quien, 'en': ahora, 'intento': intento,
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


def renglones_de_cobro(pedido, pedido_id, id_local_por_firebase=None):
    """El carrito que va a la pantalla de cobro y a `Sale.create`.

    Todas las líneas llevan `stock_descontado`: el stock salió al entregar, el
    cobro solo registra la plata (mismo mecanismo que el cobro de un fiado).

    El cupón va adentro de cada línea, como el descuento con nombre del POS:
    la venta, el ticket y la factura muestran lo que se cobró. `tienda` viaja a
    `ventas_por_dia` para que borrar la venta desde el panel sepa que es de un
    pedido.
    """
    pedido = pedido or {}
    locales = id_local_por_firebase or {}
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
        nombre = str(it.get('nombre') or 'Producto').upper()
        partes = [nombre]
        if it.get('variedad'):
            partes.append(str(it['variedad']))
        if it.get('es_pack'):
            partes.append(f"{it.get('pack_nombre') or 'pack'} x{_texto_num(num(it.get('pack_contenido'), 1))}")
        linea = {
            'product_id': int(locales.get(pid) or 0),
            'product_name': '  ·  '.join(partes),
            'quantity': cantidad,
            'unit_price': round(subtotal / cantidad, 4) if cantidad > 0 else subtotal,
            'original_price': precio,
            'subtotal': subtotal,
            'conjunto_color': str(it.get('variedad') or ''),
            'stock_descontado': True,
            'tienda': {
                'origen': 'tienda', 'pedido_id': str(pedido_id), 'producto_id': pid,
                'es_pack': bool(it.get('es_pack')),
                'pack_contenido': num(it.get('pack_contenido')) if it.get('es_pack') else None,
                'unidad': str(it.get('unidad') or 'unidad'),
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
            'stock_descontado': True,
            'tienda': {'origen': 'tienda', 'pedido_id': str(pedido_id), 'producto_id': '',
                       'es_pack': False, 'pack_contenido': None, 'unidad': 'unidad'},
        }
        if envio_gratis:
            linea.update({'discount_type': 'cupon', 'discount_value': 0,
                          'discount_amount': envio, 'descuento_nombre': codigo_cupon})
        lineas.append(linea)
    return lineas


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
