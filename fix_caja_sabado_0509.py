"""Crea la caja del sabado 05/09/2026 y le vincula las ventas de ese dia.

Que paso: el viernes 04/09 se cerro la caja 126 a las 20:29 y el sabado nadie
abrio una nueva. Cada PC siguio usando el numero de caja que tenia guardado de
antes (113, 123 y 125, todas cerradas hace dias), asi que las 127 ventas del
sabado quedaron repartidas entre tres cajas viejas y ningun cierre representa
el dia. En "Cierres de Caja" el sabado no existe y esas tres cajas aparecen
con dias mezclados.

Que hace este script:
  1. Crea cierres_caja/128 como la caja del 05/09:
       - apertura sintetica 1 min antes de la primera venta del dia
       - cierre en la hora de la ultima venta (patron auto-orphan)
       - monto_inicial 30000, queda pendiente_conteo (nadie conto esa noche)
       - stats calculados desde los renglones del dia con las mismas reglas
         que usa la web (resumir_items de pos_system/utils/medios_de_pago.py)
  2. ventas del 05/09 (crId 113/123/125 o sin caja) -> cash_register_id 128
  3. ventas_por_dia con fecha=05/09/2026 -> cash_register_id 128

No toca ninguna venta de otro dia: las cajas 113, 123 y 125 se quedan con lo suyo.

Sin argumentos: DRY-RUN (no escribe nada).
Con --aplicar: hace backup JSON y escribe.
"""
import sys, os, json
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import firebase_admin
from firebase_admin import credentials, firestore

from pos_system.utils.medios_de_pago import resumir_items

try:
    firebase_admin.get_app(); db = firestore.client()
except ValueError:
    cred = credentials.Certificate('firebase_key.json')
    firebase_admin.initialize_app(cred); db = firestore.client()

AR = timezone(timedelta(hours=-3))

REG_NUEVA      = 128                 # 127 es la caja abierta de hoy
DIA            = '2026-09-05'
FECHA_VPD      = '05/09/2026'
REGS_FANTASMA  = {113, 123, 125}     # ids viejos que arrastraban las PCs
MONTO_INICIAL  = 30000.0
APLICAR = '--aplicar' in sys.argv


def to_ar(val):
    if val is None:
        return None
    if hasattr(val, 'timestamp') and not isinstance(val, datetime):
        return datetime.fromtimestamp(val.timestamp(), tz=AR)
    if isinstance(val, datetime):
        return val.astimezone(AR) if val.tzinfo else val.replace(tzinfo=AR)
    return None


def fmt(dt):
    return dt.strftime('%Y-%m-%d %H:%M:%S') if dt else '(vacio)'


def es_varios2(it):
    """Gemelo de isItemVarios2 (webapp/src/config.js): no entra en ningun total."""
    if it.get('is_varios_2') is True:
        return True
    nombre = (it.get('producto') or it.get('product_name') or '').upper().strip()
    if nombre == 'VARIOS 2' or nombre.startswith('VARIOS 2 '):
        return True
    return (it.get('categoria') or '').upper().strip() == 'VARIOS 2'


def crid(val):
    if val is None or val == '':
        return None
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


# -- 0. La caja nueva no puede pisar nada --------------------------------
nueva_ref = db.collection('cierres_caja').document(str(REG_NUEVA))
if nueva_ref.get().exists:
    print("ERROR: cierres_caja/%d ya existe - elegir otro id" % REG_NUEVA)
    sys.exit(1)

# -- 1. Ventas del dia ---------------------------------------------------
ini = datetime(2026, 9, 5, 0, 0, tzinfo=AR)
fin = ini + timedelta(days=1)
q = (db.collection('ventas')
       .where(filter=firestore.FieldFilter('created_at', '>=', ini))
       .where(filter=firestore.FieldFilter('created_at', '<', fin)))

ventas = []          # (doc_id, crId original, total, pc_id, cajero)
for v in q.stream():
    d = v.to_dict() or {}
    rid = crid(d.get('cash_register_id'))
    if rid is not None and rid not in REGS_FANTASMA:
        print("ERROR: la venta %s del %s apunta a la caja %s, que no es una de las "
              "arrastradas %s. Revisar antes de seguir." % (v.id, DIA, rid, sorted(REGS_FANTASMA)))
        sys.exit(1)
    ventas.append((v.id, rid, float(d.get('total_amount') or 0),
                   d.get('pc_id') or '', d.get('cajero') or d.get('username') or ''))

if not ventas:
    print("No hay ventas el %s: nada que hacer." % DIA)
    sys.exit(1)

# -- 2. Renglones de ventas_por_dia del dia ------------------------------
renglones = []       # (doc_id, item, crId original)
for r in (db.collection('ventas_por_dia')
            .where(filter=firestore.FieldFilter('fecha', '==', FECHA_VPD)).stream()):
    it = r.to_dict() or {}
    rid = crid(it.get('cash_register_id'))
    if rid is not None and rid not in REGS_FANTASMA:
        print("ERROR: el renglon %s del %s apunta a la caja %s, inesperado." % (r.id, DIA, rid))
        sys.exit(1)
    renglones.append((r.id, it, rid))

# Solo los renglones de ESTE dia entran a los totales; los borrados y los
# VARIOS 2 quedan afuera, igual que en la web.
contables = []
for doc_id, it, _rid in renglones:
    if it.get('deleted') is True:
        continue
    if es_varios2(it):
        continue
    parts = doc_id.split('_')
    pc_id = '_'.join(parts[:-2]) if len(parts) >= 3 else (it.get('pc_id') or '')
    fila = dict(it)
    fila['pc_id'] = pc_id
    contables.append(fila)

# -- 3. Stats con las reglas de la web -----------------------------------
res = resumir_items(contables)
prod_map = {}
primera = ultima = None
for it in contables:
    nombre = (it.get('producto') or it.get('product_name') or '').strip()
    if nombre:
        p = prod_map.setdefault(nombre, {'product_name': nombre, 'total_quantity': 0, 'total_amount': 0})
        p['total_quantity'] += float(it.get('cantidad') or it.get('quantity') or 0)
        p['total_amount']   += float(it.get('subtotal') or 0)
    fdt = it.get('fecha_dt')
    if fdt is not None and hasattr(fdt, 'astimezone'):
        if primera is None or fdt < primera:
            primera = fdt
        if ultima is None or fdt > ultima:
            ultima = fdt

if primera is None or ultima is None:
    print("ERROR: los renglones del dia no traen fecha_dt, no puedo fechar la caja.")
    sys.exit(1)

productos = sorted(prod_map.values(), key=lambda p: -p['total_amount'])
apertura = primera - timedelta(minutes=1)
cierre   = ultima

cajeros = sorted(set(c for _, _, _, _, c in ventas if c))
esperado = MONTO_INICIAL + res['efectivo']
now_iso = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')

doc_nuevo = {
    'register_id':              REG_NUEVA,
    'pc_id':                    '',
    'cajero':                   ', '.join(cajeros),
    'abierto_desde':            'ajuste-sin-caja',
    'cerrado_desde':            'ajuste-sin-caja',
    'estado':                   'cerrada',
    'session_id':               DIA,
    'fecha_apertura':           apertura,
    'fecha_cierre':             cierre,
    'monto_inicial':            MONTO_INICIAL,
    'monto_esperado':           esperado,
    'monto_final':              0,
    'pendiente_conteo':         True,
    'total_retiros':            0.0,
    'retiros':                  [],
    'total_efectivo':           res['efectivo'],
    'total_transferencia':      res['transferencia'],
    'total_ventas':             res['efectivo'] + res['transferencia'],
    'num_ventas_efectivo':      res['num_ventas_efectivo'],
    'num_ventas_transferencia': res['num_ventas_transferencia'],
    'total_transacciones':      res['transacciones'],
    'productos_vendidos':       productos,
    'updated_at':               now_iso,
}

# -- 4. Informe ----------------------------------------------------------
por_reg = {}
for _, rid, total, _, _ in ventas:
    e = por_reg.setdefault(rid, [0, 0.0])
    e[0] += 1
    e[1] += total

print("=" * 74)
print("Caja %d - sabado %s" % (REG_NUEVA, DIA))
print("=" * 74)
print("  apertura : %s  (1 min antes de la primera venta)" % fmt(to_ar(apertura)))
print("  cierre   : %s  (ultima venta del dia)" % fmt(to_ar(cierre)))
print("  cajeros  : %s" % (doc_nuevo['cajero'] or '-'))
print("  efectivo      $%s  (%d ventas)" % (format(res['efectivo'], ',.2f'), res['num_ventas_efectivo']))
print("  transferencia $%s  (%d ventas)" % (format(res['transferencia'], ',.2f'), res['num_ventas_transferencia']))
print("  total         $%s  (%d transacciones, %d productos)"
      % (format(doc_nuevo['total_ventas'], ',.2f'), res['transacciones'], len(productos)))
print("  inicial $%s -> esperado en el cajon $%s  (pendiente de conteo)"
      % (format(MONTO_INICIAL, ',.0f'), format(esperado, ',.2f')))
print("")
print("Ventas del %s a re-vincular: %d" % (DIA, len(ventas)))
for rid in sorted(por_reg, key=lambda x: (x is None, x)):
    c, t = por_reg[rid]
    print("    caja %s: %3d ventas  $%s" % (rid if rid is not None else '(sin caja)', c, format(t, ',.2f')))
print("Renglones ventas_por_dia a re-vincular: %d (%d cuentan para los totales)"
      % (len(renglones), len(contables)))

suma_ventas = sum(t for _, _, t, _, _ in ventas)
print("")
print("Control: ventas del dia vs renglones")
print("    ventas   $%s en %d docs" % (format(suma_ventas, ',.2f'), len(ventas)))
print("    cierre   $%s en %d transacciones" % (format(doc_nuevo['total_ventas'], ',.2f'), res['transacciones']))
if abs(suma_ventas - doc_nuevo['total_ventas']) > 0.01:
    print("    AVISO: no dan igual - puede haber renglones borrados o VARIOS 2")
else:
    print("    OK")

if not APLICAR:
    print("")
    print("DRY-RUN: no se escribio nada. Para aplicar:")
    print("    python fix_caja_sabado_0509.py --aplicar")
    sys.exit(0)

# -- 5. Backup -----------------------------------------------------------
ts = datetime.now(AR).strftime('%Y%m%d_%H%M')
backup_path = "caja_sabado_0509_rollback_%s.json" % ts
backup = {
    'caja_creada': str(REG_NUEVA),
    'ventas': dict((vid, rid) for vid, rid, _, _, _ in ventas),
    'ventas_por_dia': dict((did, rid) for did, _, rid in renglones),
    'nota': ("rollback: borrar cierres_caja/%d y devolver a cada doc el "
             "cash_register_id de este archivo (null = borrar el campo)" % REG_NUEVA),
}
with open(backup_path, 'w', encoding='utf-8') as f:
    json.dump(backup, f, ensure_ascii=False, indent=2, default=str)
print("")
print("Backup: %s" % backup_path)

# -- 6. Escribir ---------------------------------------------------------
print("Aplicando...")
_estado = {'batch': db.batch(), 'pend': 0}


def flush(force=False):
    if _estado['pend'] and (force or _estado['pend'] >= 400):
        _estado['batch'].commit()
        _estado['batch'] = db.batch()
        _estado['pend'] = 0


for did, _, _ in renglones:
    _estado['batch'].update(db.collection('ventas_por_dia').document(did),
                            {'cash_register_id': REG_NUEVA})
    _estado['pend'] += 1
    flush()
flush(force=True)
print("  ventas_por_dia -> %d: %d renglones" % (REG_NUEVA, len(renglones)))

for vid, _, _, _, _ in ventas:
    _estado['batch'].update(db.collection('ventas').document(vid),
                            {'cash_register_id': REG_NUEVA})
    _estado['pend'] += 1
    flush()
flush(force=True)
print("  ventas -> %d: %d" % (REG_NUEVA, len(ventas)))

nueva_ref.set(doc_nuevo)
print("  cierres_caja/%d creado (%s)" % (REG_NUEVA, DIA))
print("")
print("Listo. Refrescar Cierres de Caja en el panel.")
