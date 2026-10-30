"""
Historial de facturas de todas las cajas, separado por emisor.

Cada caja guarda sus facturas en su base local y además las sube a la
colección `facturas` de Firestore. La pestaña Fiscal AFIP leía solo la base
local, así que cada PC veía únicamente lo que había facturado ella, y el
selector "Perfil ARCA" no filtraba nada.

Acá vive la lógica sin Qt ni Firebase (la importan las pruebas):
  - pasar una factura de la nube o de la base local a una fila común,
  - juntar las dos fuentes sin repetir comprobantes,
  - reconocer a qué emisor pertenece cada una,
  - filtrar y sumar.

El emisor se reconoce por CUIT + punto de venta. El nombre no sirve: 206
facturas de Agustín se emitieron con la razón social "DI FILIPPO JOSE LUIS"
antes de corregir el perfil (06-10-2026).
"""
from __future__ import annotations

import re
import unicodedata
from datetime import date, datetime, timedelta, timezone

_TZ_AR = timezone(timedelta(hours=-3))


# ── Datos sueltos ──────────────────────────────────────────────────────────

def solo_digitos(valor) -> str:
    return re.sub(r'\D', '', str(valor or ''))


def formatear_documento(valor) -> str:
    """CUIT con guiones (20-14921040-8); DNI o lo que sea, tal cual."""
    d = solo_digitos(valor)
    if len(d) == 11:
        return f'{d[:2]}-{d[2:10]}-{d[10]}'
    if d and d != '0':
        return d
    return ''


def es_nota_de_credito(tipo) -> bool:
    t = str(tipo or '').upper()
    return 'NOTA' in t and 'CRED' in t


_PAGOS = {
    'EFECTIVO': 'Efectivo',
    'TRANSFERENCIA': 'Transferencia',
    'TARJETA': 'Tarjeta',
    'CREDITO': 'Crédito',
    'CRÉDITO': 'Crédito',
    'DEBITO': 'Débito',
    'DÉBITO': 'Débito',
    'MERCADO PAGO': 'Mercado Pago',
    'MIXTO': 'Mixto',
}


def nombre_de_pago(valor) -> str:
    s = str(valor or '').strip()
    if not s:
        return ''
    return _PAGOS.get(s.upper(), s[:1].upper() + s[1:].lower())


def es_transferencia(valor) -> bool:
    s = str(valor or '').upper()
    return 'TRANSF' in s or 'MERCADO' in s


def _normalizar_texto(s) -> str:
    s = unicodedata.normalize('NFD', str(s or ''))
    return ''.join(c for c in s if unicodedata.category(c) != 'Mn').lower()


def a_hora_ar(valor) -> datetime | None:
    """Fecha guardada (ISO con o sin zona, o el 'dd/mm/aaaa hh:mm:ss AM' del
    PDF) → datetime en hora argentina, sin zona. None si no se entiende."""
    if valor is None or valor == '':
        return None
    if isinstance(valor, datetime):
        dt = valor
    else:
        s = str(valor).strip()
        dt = None
        try:
            dt = datetime.fromisoformat(s)
        except ValueError:
            for fmt in ('%d/%m/%Y %I:%M:%S %p', '%d/%m/%Y %H:%M:%S', '%d/%m/%Y %H:%M', '%d/%m/%Y'):
                try:
                    dt = datetime.strptime(s, fmt)
                    break
                except ValueError:
                    continue
        if dt is None:
            return None
    if dt.tzinfo is not None:
        return dt.astimezone(_TZ_AR).replace(tzinfo=None)
    return dt


# ── Una fila común para las dos fuentes ───────────────────────────────────

def clave_de(fila: dict) -> tuple:
    """Lo que identifica un comprobante en ARCA: tipo, punto de venta y número."""
    return (str(fila.get('tipo') or '').upper(),
            int(fila.get('pv') or 0),
            int(fila.get('nro') or 0))


def fila_de_nube(doc_id: str, d: dict) -> dict:
    d = d or {}
    fecha = a_hora_ar(d.get('created_at')) or a_hora_ar(d.get('fecha'))
    return {
        'clave_nube':   doc_id,
        'id_local':     None,
        'tipo':         str(d.get('tipo_comprobante') or ''),
        'pv':           int(d.get('punto_venta') or 0),
        'nro':          int(d.get('nro_comprobante') or 0),
        'fecha':        fecha,
        'cuit_emisor':  solo_digitos(d.get('cuit')),
        'razon_social': str(d.get('razon_social') or ''),
        'cliente':      str(d.get('cliente') or '') or 'CONSUMIDOR FINAL',
        'doc_receptor': solo_digitos(d.get('cuit_receptor') or d.get('cuit_cliente')),
        'cond_iva_receptor': str(d.get('condicion_iva_receptor') or ''),
        'domicilio_receptor': str(d.get('domicilio_receptor') or ''),
        'pago':         nombre_de_pago(d.get('pago')),
        'es_varios_2':  bool(d.get('es_varios_2')),
        'total':        float(d.get('total') or 0),
        'iva':          float(d.get('iva_contenido') or 0),
        'otros':        float(d.get('otros_impuestos') or 0),
        'cae':          str(d.get('cae') or ''),
        'vto_cae':      str(d.get('vto_cae') or ''),
        'notas':        str(d.get('notas') or ''),
        'turno':        str(d.get('turno') or ''),
        'items':        list(d.get('items') or []),
        'sale_id':      d.get('sale_id'),
        'pdf_path':     '',
        'solo_local':   False,
        'documento':    dict(d),
    }


def fila_local(r: dict) -> dict:
    r = dict(r or {})
    return {
        'clave_nube':   None,
        'id_local':     r.get('id'),
        'tipo':         str(r.get('tipo_comprobante') or ''),
        'pv':           int(r.get('punto_venta') or 0),
        'nro':          int(r.get('nro_comprobante') or 0),
        'fecha':        a_hora_ar(r.get('created_at')) or a_hora_ar(r.get('fecha')),
        'cuit_emisor':  '',
        'razon_social': '',
        'cliente':      str(r.get('cliente') or '') or 'CONSUMIDOR FINAL',
        'doc_receptor': solo_digitos(r.get('cuit_cliente')),
        'cond_iva_receptor': '',
        'domicilio_receptor': '',
        'pago':         '',
        'es_varios_2':  bool(r.get('es_varios_2')),
        'total':        float(r.get('total') or 0),
        'iva':          float(r.get('iva_contenido') or 0),
        'otros':        float(r.get('otros_impuestos') or 0),
        'cae':          str(r.get('cae') or ''),
        'vto_cae':      str(r.get('vto_cae') or ''),
        'notas':        str(r.get('motivo_nc') or ''),
        'turno':        '',
        'items':        [],
        'sale_id':      r.get('sale_id'),
        'pdf_path':     str(r.get('pdf_path') or ''),
        'solo_local':   True,
        'documento':    None,
    }


def combinar(nube: list, locales: list) -> list:
    """Las facturas de la nube más las de esta PC que no llegaron a subir.

    La subida es "disparar y olvidar": si la PC estaba sin internet al facturar,
    la factura queda solo en la base local. Esas se suman marcadas como
    `solo_local`. Cuando la misma factura está en los dos lados, manda la nube
    (trae cliente, pago y renglones) y se le pega el PDF y el id de esta PC.
    """
    por_clave = {}
    for f in locales:
        por_clave.setdefault(clave_de(f), f)
    salida = []
    usadas = set()
    for f in nube:
        k = clave_de(f)
        loc = por_clave.get(k)
        if loc is not None:
            f = dict(f, id_local=loc['id_local'], pdf_path=loc['pdf_path'],
                     sale_id_local=loc['sale_id'])
            usadas.add(k)
        salida.append(f)
    for k, f in por_clave.items():
        if k not in usadas:
            salida.append(f)
    salida.sort(key=lambda f: (f['fecha'] or datetime.min, f['nro']), reverse=True)
    return salida


# ── Emisores ───────────────────────────────────────────────────────────────

def perfil_de(fila: dict, perfiles: list) -> dict | None:
    """El perfil ARCA que emitió esta factura.

    Con CUIT: tiene que coincidir CUIT y punto de venta. Sin CUIT (las de la
    base local no lo guardan) alcanza el punto de venta si un solo perfil lo usa.
    """
    pv = int(fila.get('pv') or 0)
    cuit = fila.get('cuit_emisor') or ''
    if cuit:
        for p in perfiles:
            if solo_digitos(p.get('cuit')) == cuit and int(p.get('punto_venta') or 0) == pv:
                return p
        return None
    mismos = [p for p in perfiles if int(p.get('punto_venta') or 0) == pv]
    return mismos[0] if len(mismos) == 1 else None


def nombre_de_perfil(p: dict) -> str:
    return str(p.get('razon_social') or p.get('nombre') or '').strip() or 'Sin nombre'


def nombre_de_emisor(fila: dict, perfiles: list) -> str:
    p = perfil_de(fila, perfiles)
    if p:
        return nombre_de_perfil(p)
    if fila.get('cuit_emisor'):
        return f"CUIT {formatear_documento(fila['cuit_emisor'])}"
    return f"PV {fila.get('pv') or '?'}"


def es_del_perfil(fila: dict, perfil: dict, perfiles: list) -> bool:
    p = perfil_de(fila, perfiles)
    return p is not None and p.get('id') == perfil.get('id')


# ── Períodos ───────────────────────────────────────────────────────────────

PERIODOS = [
    ('hoy',         'Hoy'),
    ('ayer',        'Ayer'),
    ('7',           '7 días'),
    ('mes',         'Este mes'),
    ('mes_pasado',  'Mes pasado'),
]


def rango_de(periodo: str, hoy: date) -> tuple:
    """(desde, hasta) inclusive, en días."""
    if periodo == 'hoy':
        return hoy, hoy
    if periodo == 'ayer':
        a = hoy - timedelta(days=1)
        return a, a
    if periodo == '7':
        return hoy - timedelta(days=6), hoy
    if periodo == 'mes':
        return hoy.replace(day=1), hoy
    if periodo == 'mes_pasado':
        fin = hoy.replace(day=1) - timedelta(days=1)
        return fin.replace(day=1), fin
    raise ValueError(f'período desconocido: {periodo}')


def limites_iso(desde: date, hasta: date) -> tuple:
    """Límites para comparar `created_at` (texto ISO) en Firestore:
    desde <= created_at < día siguiente a hasta."""
    return desde.isoformat(), (hasta + timedelta(days=1)).isoformat()


# ── Filtrar y sumar ────────────────────────────────────────────────────────

def filtrar(filas: list, perfiles: list, perfil: dict | None = None,
            desde: date | None = None, hasta: date | None = None,
            texto: str = '') -> list:
    q = _normalizar_texto(texto).strip()
    q_dig = solo_digitos(texto)
    salida = []
    for f in filas:
        if perfil is not None and not es_del_perfil(f, perfil, perfiles):
            continue
        dia = f['fecha'].date() if f.get('fecha') else None
        if desde and (dia is None or dia < desde):
            continue
        if hasta and (dia is None or dia > hasta):
            continue
        if q:
            pajar = _normalizar_texto(f"{f.get('cliente', '')} {f.get('nro', '')}")
            numero = f"{int(f.get('pv') or 0):05d}-{int(f.get('nro') or 0):08d}"
            coincide = q in pajar or q in numero
            if not coincide and q_dig:
                coincide = q_dig in (f.get('doc_receptor') or '') or q_dig == str(f.get('nro'))
            if not coincide:
                continue
        salida.append(f)
    return salida


def importe_con_signo(f: dict) -> float:
    """Las notas de crédito restan."""
    t = float(f.get('total') or 0)
    return -t if es_nota_de_credito(f.get('tipo')) else t


def totales(filas: list) -> dict:
    """Lo que muestran los cuatro recuadros.

    - total: todo lo facturado (las notas de crédito restan).
    - varios_2: las facturas del cierre del día (ítems "Varios 2").
    - clientes: el resto, las facturas a un cliente o empresa.
    - clientes_transferencia: de esas, las cobradas por transferencia. Es lo
      que hay que descontar de lo que entró por Mercado Pago antes de hacer la
      factura del día.
    """
    t = {'total': 0.0, 'cant': 0,
         'varios_2': 0.0, 'cant_varios_2': 0,
         'clientes': 0.0, 'cant_clientes': 0,
         'clientes_transferencia': 0.0, 'cant_clientes_transferencia': 0,
         'notas_credito': 0.0, 'cant_notas_credito': 0,
         'sin_cae': 0}
    for f in filas:
        imp = importe_con_signo(f)
        t['total'] += imp
        t['cant'] += 1
        if not f.get('cae'):
            t['sin_cae'] += 1
        if es_nota_de_credito(f.get('tipo')):
            t['notas_credito'] += imp
            t['cant_notas_credito'] += 1
        elif f.get('es_varios_2'):
            t['varios_2'] += imp
            t['cant_varios_2'] += 1
        else:
            t['clientes'] += imp
            t['cant_clientes'] += 1
            if es_transferencia(f.get('pago')):
                t['clientes_transferencia'] += imp
                t['cant_clientes_transferencia'] += 1
    return t


def por_emisor(filas: list, perfiles: list) -> list:
    """[(nombre, total, cantidad)] ordenado por nombre."""
    acc = {}
    for f in filas:
        n = nombre_de_emisor(f, perfiles)
        tot, cant = acc.get(n, (0.0, 0))
        acc[n] = (tot + importe_con_signo(f), cant + 1)
    return sorted(((n, t, c) for n, (t, c) in acc.items()), key=lambda x: x[0])


def factura_para_nota_de_credito(fila: dict) -> dict:
    """Lo que necesita el diálogo de Nota de Crédito, armado desde la fila.

    `sale_id` va solo si la venta es de esta PC: la tabla local `facturas` lo
    ata a `sales(id)`, y el número de venta de otra caja acá es otra venta (o
    ninguna, y el guardado falla por la clave foránea).
    """
    sale_id = fila.get('sale_id_local') if fila.get('clave_nube') else fila.get('sale_id')
    return {
        'id':               fila.get('id_local'),
        'tipo_comprobante': fila.get('tipo'),
        'punto_venta':      fila.get('pv'),
        'nro_comprobante':  fila.get('nro'),
        'cliente':          fila.get('cliente'),
        'cuit_cliente':     fila.get('doc_receptor') or '',
        'total':            fila.get('total'),
        'iva_contenido':    fila.get('iva'),
        'otros_impuestos':  fila.get('otros'),
        'cae':              fila.get('cae'),
        'created_at':       fila['fecha'].isoformat() if fila.get('fecha') else '',
        'sale_id':          sale_id,
    }
