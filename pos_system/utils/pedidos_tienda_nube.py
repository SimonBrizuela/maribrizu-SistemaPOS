"""
Los pedidos de la tienda en Firestore, desde la caja.

Cada operación es UNA transacción que vuelve a leer el pedido, decide con
`pos_system/models/pedido_tienda.py` y escribe todo junto: el pedido, el stock
del catálogo, los movimientos de stock y el renglón del registro de eventos.
Si otra PC tocó el pedido en el medio, Firestore repite la transacción con lo
nuevo y la regla decide de vuelta; si el cambio de la otra PC hace que ya no
corresponda, la operación vuelve rechazada con el motivo y no escribe nada.

El registro (`tienda_pedidos_eventos`) va adentro de la misma transacción: no
puede quedar un evento de algo que no pasó ni algo que pasó sin evento. Su id
lleva el `intento` de la acción, así que un reintento de Firestore reescribe el
mismo documento en vez de duplicarlo. Los rechazos y los errores se anotan
aparte (no hay transacción que los contenga), también con id fijo.

Los movimientos de stock llevan el `intento` en el id por la misma razón, y a
propósito NO son fijos por pedido: si algún día el mismo pedido descontara dos
veces, tienen que verse dos grupos de movimientos, no uno pisado.

Lo que va después de la transacción es de mejor esfuerzo y no cambia nada si
falla: el semáforo del catálogo, la vidriera de la tienda y el aviso al celular
del cliente.
"""
import json
import logging
import random
import threading
import time
import urllib.request
import uuid
from datetime import datetime
from typing import Callable, Dict, List, Optional

from google.cloud import firestore
from google.cloud.firestore_v1.transaction import transactional

from pos_system.models import pedido_tienda as reglas

logger = logging.getLogger(__name__)

PEDIDOS = 'tienda_pedidos'
EVENTOS = 'tienda_pedidos_eventos'
MOVIMIENTOS = 'stock_movimientos'

URL_AVISO_CLIENTE = 'https://beta.liceolibreria.com/.netlify/functions/avisar-estado'

# Vueltas completas de una operación cuando Firestore aborta por choque con
# otra PC. El SDK reintenta 5 veces seguidas sin esperar; con varias cajas
# descontando el mismo pedido a la vez (lo que entregó el repartidor lo ven
# todas juntas) eso no alcanza y las que pierden devolvían error en vez de
# enterarse de que otra ya lo había hecho. Medido en el emulador con seis PCs.
VUELTAS_POR_CHOQUE = 6

# Tope para cada lectura adentro de una transacción. Sin él, sin internet un
# botón quedaba "Guardando…" el minuto que tarda el cliente en rendirse.
LECTURA_SEGUNDOS = 15

# Firestore corta una transacción en 500 escrituras. Un pedido llega a 100
# renglones (lo limita crear-pedido); con catálogo, movimientos, pedido y
# evento no se acerca, pero se deja el control por si el límite cambia.
MAX_ESCRITURAS = 450


def nuevo_intento() -> str:
    return uuid.uuid4().hex[:16]


class Resultado(dict):
    """{'ok', 'rechazo', 'motivo', 'pedido', 'plan', 'intento'} con acceso por
    atributo, para que la pantalla lea `r.ok` sin preguntar por claves."""

    def __getattr__(self, clave):
        return self.get(clave)


class NubePedidos:
    """
    `db`       cliente de Firestore (el de firebase_admin o uno del emulador).
    `quien`    función que devuelve {'pc_id', 'pc_nombre', 'cajero'} al momento.
    `reloj`    función que devuelve la hora con zona; se inyecta en las pruebas.
    `al_descontar(cambios)`  deja la vidriera al día (`_avisar_a_la_tienda`).
    `avisar_cliente`         False en las pruebas: no sale a internet.
    """

    def __init__(self, db, quien: Callable[[], Dict], reloj: Callable[[], datetime] = None,
                 al_descontar: Callable[[List], None] = None, avisar_cliente: bool = True):
        self.db = db
        self._quien = quien
        # Sin reloj propio, las decisiones usan la hora del servidor de la
        # lectura: la marca de "lo está cobrando" la escribe una PC y la mira
        # otra, y con los relojes corridos una caja colgada quedaba "ocupada"
        # tantas horas como se adelantara su reloj.
        self._reloj_propio = reloj is not None
        self._reloj = reloj or (lambda: datetime.now(reglas.TZ_AR))
        self._al_descontar = al_descontar
        self._avisar_cliente = avisar_cliente

    # ── Lectura ─────────────────────────────────────────────────────────────
    def leer(self, pedido_id: str) -> Optional[Dict]:
        snap = self.db.collection(PEDIDOS).document(pedido_id).get()
        return {'id': snap.id, **(snap.to_dict() or {})} if snap.exists else None

    # ── Operaciones ─────────────────────────────────────────────────────────
    def mover(self, pedido_id: str, desde: str, hacia: str) -> Resultado:
        intento = nuevo_intento()

        def cuerpo(tx, ahora, quien, pedido, _catalogo):
            decision = reglas.decidir_mover(pedido, desde, hacia, quien, ahora)
            if 'rechazo' in decision:
                return decision
            self._escribir_pedido(tx, pedido_id, decision['campos'])
            self._escribir_evento(tx, pedido_id, pedido, 'mover', intento, quien, ahora,
                                  estado_despues=hacia, detalle=f'{desde} → {hacia}')
            return decision

        r = self._correr('mover', pedido_id, intento, cuerpo)
        if r.ok:
            self._avisar(pedido_id)
        return r

    def entregar(self, pedido_id: str, origen: str = 'pos') -> Resultado:
        """Marca entregado (si hace falta) y descuenta el stock una sola vez.

        La usan el botón de la caja y el descuento automático de lo que entregó
        el repartidor, desde todas las PCs a la vez: la segunda relee el pedido
        ya descontado y solo apaga `venta_pendiente`.
        """
        intento = nuevo_intento()

        def cuerpo(tx, ahora, quien, pedido, catalogo):
            decision = reglas.decidir_entrega(pedido, catalogo, quien, ahora, origen)
            if 'rechazo' in decision:
                return decision
            campos = self._con_hora_del_servidor(decision['campos'])
            self._escribir_stock(tx, pedido_id, pedido, decision['plan'], intento, quien)
            self._escribir_pedido(tx, pedido_id, campos)
            if decision['plan'] is not None or pedido.get('estado') != 'entregado':
                self._escribir_evento(
                    tx, pedido_id, pedido, 'entregar', intento, quien, ahora,
                    estado_despues='entregado', plan=decision['plan'],
                    detalle=('descontó el stock' if decision['plan'] is not None
                             else 'el stock ya había salido'),
                    extra={'origen': origen})
            return decision

        r = self._correr('entregar', pedido_id, intento, cuerpo, con_catalogo=True)
        if r.ok:
            self._despues_del_stock(r)
            if r.pedido and r.pedido.get('estado') != 'entregado':
                self._avisar(pedido_id)
        return r

    def tomar_cobro(self, pedido_id: str, forzar: bool = False) -> Resultado:
        intento = nuevo_intento()

        def cuerpo(tx, ahora, quien, pedido, _catalogo):
            decision = reglas.decidir_tomar_cobro(pedido, quien, ahora, intento, forzar)
            if 'rechazo' in decision:
                return decision
            self._escribir_pedido(tx, pedido_id, decision['campos'])
            anterior = (pedido or {}).get('cobro') or {}
            if anterior.get('estado') == 'en_curso' and anterior.get('pc_id') != quien.get('pc_id'):
                # Tomar la marca de otra caja queda escrito con nombre y hora:
                # si algo sale mal después, es lo primero que hay que mirar.
                self._escribir_evento(tx, pedido_id, pedido, 'tomar_cobro', intento, quien, ahora,
                                      detalle=f"tomó el cobro que había empezado {reglas.quien_texto(anterior)}",
                                      extra={'marca_anterior': _sin_fechas(anterior)})
            else:
                self._escribir_evento(tx, pedido_id, pedido, 'tomar_cobro', intento, quien, ahora,
                                      detalle='abrió la pantalla de cobro')
            return decision

        return self._correr('tomar_cobro', pedido_id, intento, cuerpo)

    def soltar_cobro(self, pedido_id: str, intento: str) -> Resultado:
        def cuerpo(tx, ahora, quien, pedido, _catalogo):
            if reglas.decidir_soltar_cobro(pedido, intento)['soltar']:
                self._escribir_pedido(tx, pedido_id, {'cobro': firestore.DELETE_FIELD})
                self._escribir_evento(tx, pedido_id, pedido, 'soltar_cobro', intento, quien, ahora,
                                      detalle='cerró la pantalla de cobro sin cobrar')
            return {}

        return self._correr('soltar_cobro', pedido_id, intento, cuerpo, anotar_rechazo=False)

    def renovar_cobro(self, pedido_id: str, intento: str) -> Resultado:
        """La pantalla de cobro sigue abierta: la marca no vence."""
        def cuerpo(tx, ahora, quien, pedido, _catalogo):
            marca = (pedido or {}).get('cobro') or {}
            if marca.get('estado') == 'en_curso' and marca.get('intento') == intento:
                self._escribir_pedido(tx, pedido_id, {'cobro.desde': ahora})
            return {}

        return self._correr('renovar_cobro', pedido_id, intento, cuerpo, anotar_rechazo=False)

    def cobrar(self, pedido_id: str, intento: str, pago: Dict) -> Resultado:
        """Registra el cobro en el pedido. La venta local se crea DESPUÉS, con
        el pedido ya marcado: si la PC se corta en el medio, al volver
        `ventas_sin_crear()` la encuentra y la crea (ver la vista)."""

        def cuerpo(tx, ahora, quien, pedido, catalogo):
            decision = reglas.decidir_cobro(pedido, catalogo, quien, ahora, intento, pago)
            if 'rechazo' in decision:
                return decision
            campos = self._con_hora_del_servidor(decision['campos'])
            self._escribir_stock(tx, pedido_id, pedido, decision['plan'], intento, quien)
            self._escribir_pedido(tx, pedido_id, campos)
            if decision['plan'] is not None:
                self._escribir_evento(tx, pedido_id, pedido, 'entregar', intento, quien, ahora,
                                      estado_despues='entregado', plan=decision['plan'],
                                      detalle='descontó el stock al cobrar', extra={'origen': 'pos'})
            self._escribir_evento(tx, pedido_id, pedido, 'cobrar', intento, quien, ahora,
                                  estado_despues='entregado',
                                  detalle=f"cobrado ${reglas.num(pedido.get('total')):,.2f}",
                                  extra={'pago': dict(pago or {}),
                                         'total': reglas.num(pedido.get('total'))})
            return decision

        r = self._correr('cobrar', pedido_id, intento, cuerpo, con_catalogo=True)
        if r.ok:
            self._despues_del_stock(r)
            self._avisar(pedido_id)
        return r

    def anotar_venta(self, pedido_id: str, intento: str, sale_id: int) -> Resultado:
        def cuerpo(tx, ahora, quien, pedido, _catalogo):
            decision = reglas.decidir_anotar_venta(pedido, intento, quien.get('pc_id'), sale_id)
            if 'rechazo' in decision:
                return decision
            if (pedido or {}).get('venta_id') == decision['campos']['venta_id']:
                return {'campos': {}}
            self._escribir_pedido(tx, pedido_id, decision['campos'])
            self._escribir_evento(tx, pedido_id, pedido, 'venta_local', intento, quien, ahora,
                                  detalle=f"venta #{int(sale_id)}",
                                  extra={'venta_id': decision['campos']['venta_id']})
            return decision

        return self._correr('venta_local', pedido_id, intento, cuerpo)

    def cancelar(self, pedido_id: str) -> Resultado:
        intento = nuevo_intento()

        def cuerpo(tx, ahora, quien, pedido, _catalogo):
            decision = reglas.decidir_cancelar(pedido, quien, ahora)
            if 'rechazo' in decision:
                return decision
            self._escribir_pedido(tx, pedido_id, decision['campos'])
            self._escribir_evento(tx, pedido_id, pedido, 'cancelar', intento, quien, ahora,
                                  estado_despues='cancelado')
            return decision

        r = self._correr('cancelar', pedido_id, intento, cuerpo)
        if r.ok:
            self._avisar(pedido_id)
        return r

    def anular_entrega(self, pedido_id: str, motivo: str) -> Resultado:
        """Devuelve el stock de un pedido entregado que no va (devolución,
        entregado por error) y lo cancela. La venta de la caja, si la hubo, no se
        toca: se borra aparte si se devolvió la plata."""
        intento = nuevo_intento()

        def cuerpo(tx, ahora, quien, pedido, catalogo):
            decision = reglas.decidir_anular_entrega(pedido, catalogo, quien, ahora, motivo)
            if 'rechazo' in decision:
                return decision
            plan = decision['plan']
            revierte = None
            if plan is not None:
                from google.cloud.firestore_v1.base_query import FieldFilter
                movs = [d.to_dict() or {} for d in self.db.collection(MOVIMIENTOS)
                        .where(filter=FieldFilter('pedido_id', '==', pedido_id)).get(transaction=tx)]
                devueltos = {m.get('revierte_intento') for m in movs if m.get('revierte_intento')}
                activos = [m for m in movs if m.get('intento') and m.get('motivo') != 'anulacion'
                           and m.get('intento') not in devueltos]
                grupos = sorted({m.get('intento') for m in activos})
                if len(grupos) != 1:
                    return {'rechazo': (f'el stock de este pedido salió {len(grupos)} veces: se arregla con '
                                        'scripts/revisar_pedidos_tienda.py' if grupos else
                                        'no están los movimientos de stock de la entrega: corregí el stock '
                                        'a mano y cancelalo'), 'motivo': 'stock'}
                revierte = grupos[0]
                difs = reglas.diferencias_de_devolucion(plan, activos)
                if difs:
                    detalle = '; '.join(f"{d['detalle'] or d['producto_id']}: salieron {d['salio']:g}, "
                                        f"volverían {d['devolveria']:g}" for d in difs[:3])
                    return {'rechazo': f'el catálogo cambió desde la entrega y el stock no volvería igual '
                                       f'({detalle}). Corregilo a mano', 'motivo': 'stock'}
            self._escribir_stock(tx, pedido_id, pedido, plan, intento, quien,
                                 motivo_mov='anulacion', revierte=revierte)
            self._escribir_pedido(tx, pedido_id, decision['campos'])
            self._escribir_evento(tx, pedido_id, pedido, 'anular_entrega', intento, quien, ahora,
                                  estado_despues='cancelado', plan=plan,
                                  detalle=f'entrega anulada: {str(motivo).strip()[:200]}',
                                  extra={'revierte_intento': revierte,
                                         'estaba_cobrado': reglas.cobrado(pedido),
                                         'venta_id': (pedido or {}).get('venta_id')})
            return decision

        r = self._correr('anular_entrega', pedido_id, intento, cuerpo, con_catalogo=True,
                         catalogo_siempre=True)
        if r.ok:
            self._despues_del_stock(r)
            self._avisar(pedido_id)
        return r

    def tomar_factura(self, pedido_id: str, forzar: bool = False) -> Resultado:
        intento = nuevo_intento()

        def cuerpo(tx, ahora, quien, pedido, _catalogo):
            decision = reglas.decidir_tomar_factura(pedido, quien, ahora, intento, forzar)
            if 'rechazo' in decision:
                return decision
            self._escribir_pedido(tx, pedido_id, decision['campos'])
            return decision

        return self._correr('tomar_factura', pedido_id, intento, cuerpo)

    def anotar_factura(self, pedido_id: str, intento: str, datos: Dict) -> Resultado:
        def cuerpo(tx, ahora, quien, pedido, _catalogo):
            decision = reglas.decidir_anotar_factura(pedido, intento, datos, quien, ahora)
            if 'rechazo' in decision:
                return decision
            self._escribir_pedido(tx, pedido_id, decision['campos'])
            f = decision['campos']['factura']
            self._escribir_evento(tx, pedido_id, pedido, 'facturar', intento, quien, ahora,
                                  detalle=f"{f['tipo']} {f['punto_venta']:05d}-{f['numero']:08d}",
                                  extra={'factura': {k: v for k, v in f.items() if k != 'en'}})
            return decision

        return self._correr('facturar', pedido_id, intento, cuerpo)

    def soltar_factura(self, pedido_id: str, intento: str) -> Resultado:
        def cuerpo(tx, ahora, quien, pedido, _catalogo):
            if reglas.decidir_soltar_factura(pedido, intento)['soltar']:
                self._escribir_pedido(tx, pedido_id, {'factura': firestore.DELETE_FIELD})
            return {}

        return self._correr('soltar_factura', pedido_id, intento, cuerpo, anotar_rechazo=False)

    def marcar_visto(self, pedido_ids: List[str]) -> None:
        """Visto no necesita transacción: solo pasa de false a true, y dos PCs
        que lo escriben a la vez escriben lo mismo."""
        for pid in pedido_ids:
            try:
                self.db.collection(PEDIDOS).document(pid).update({'visto': True})
            except Exception as e:
                logger.info(f'Pedidos: no se pudo marcar visto {pid}: {e}')

    def marcar_impreso(self, pedido_id: str) -> None:
        try:
            self.db.collection(PEDIDOS).document(pedido_id).update({'impreso': True})
        except Exception as e:
            logger.info(f'Pedidos: no se pudo marcar impreso {pedido_id}: {e}')

    def anotar_problema(self, pedido_id: str, accion: str, detalle: str, extra: Dict = None) -> None:
        """Deja en el registro algo que salió mal fuera de una transacción (la
        venta local no se pudo crear, la factura no se pudo anotar)."""
        try:
            quien = self._quien()
            ahora = self._reloj()
            doc_id = f'{pedido_id}__{accion}__{nuevo_intento()}'
            self.db.collection(EVENTOS).document(doc_id).set({
                'pedido_id': pedido_id, 'accion': accion, 'resultado': 'error',
                'detalle': str(detalle)[:500], 'origen': 'pos', **_marca(quien),
                'en': firestore.SERVER_TIMESTAMP, 'dia': reglas.dia_argentina(ahora),
                **(extra or {}),
            })
        except Exception as e:
            logger.warning(f'Pedidos: no se pudo anotar el problema de {pedido_id}: {e}')

    # ── Piezas internas ─────────────────────────────────────────────────────
    def _correr(self, accion, pedido_id, intento, cuerpo, con_catalogo=False,
                anotar_rechazo=True, catalogo_siempre=False) -> Resultado:
        ref = self.db.collection(PEDIDOS).document(pedido_id)
        salida = {}

        @transactional
        def _tx(tx):
            quien = self._quien()
            snap = ref.get(transaction=tx, timeout=LECTURA_SEGUNDOS)
            ahora = self._reloj() if self._reloj_propio else _hora_de(snap)
            pedido = snap.to_dict() if snap.exists else None
            catalogo = {}
            if con_catalogo and pedido and (catalogo_siempre or not reglas.stock_afuera(pedido)):
                ids = sorted({str((i or {}).get('id') or '').strip()
                              for i in (pedido.get('items') or [])} - {''})
                for pid in ids:
                    s = self.db.collection('catalogo').document(pid).get(transaction=tx, timeout=LECTURA_SEGUNDOS)
                    catalogo[pid] = s.to_dict() if s.exists else None
            decision = cuerpo(tx, ahora, quien, pedido, catalogo)
            salida.clear()
            salida.update(decision=decision, pedido=pedido, catalogo=catalogo)
            return decision

        decision = None
        for vuelta in range(VUELTAS_POR_CHOQUE):
            try:
                decision = _tx(self.db.transaction())
                break
            except Exception as e:
                if _es_choque(e) and vuelta + 1 < VUELTAS_POR_CHOQUE:
                    # Espera al azar y creciente: si todas las cajas esperan lo
                    # mismo, vuelven a chocar juntas.
                    time.sleep(random.uniform(0.05, 0.25) * (2 ** vuelta))
                    continue
                logger.error(f'Pedidos: {accion} {pedido_id} falló: {e}')
                # En otro hilo: sin red, anotarlo esperaba otro minuto entero con
                # el botón en "Guardando…".
                threading.Thread(target=self.anotar_problema, daemon=True,
                                 args=(pedido_id, accion, f'{type(e).__name__}: {e}')).start()
                return Resultado(ok=False, rechazo='no se pudo hablar con la nube; no se cambió nada',
                                 motivo='error', intento=intento, error=str(e))

        if 'rechazo' in decision:
            if anotar_rechazo:
                self._anotar_rechazo(pedido_id, accion, intento, decision, salida.get('pedido'))
            return Resultado(ok=False, rechazo=decision['rechazo'], motivo=decision.get('motivo'),
                             pedido=_con_id(pedido_id, salida.get('pedido')), intento=intento)
        return Resultado(ok=True, intento=intento, plan=decision.get('plan'),
                         pedido=_con_id(pedido_id, salida.get('pedido')),
                         catalogo=salida.get('catalogo'), campos=decision.get('campos'))

    def _escribir_pedido(self, tx, pedido_id, campos):
        if campos:
            tx.update(self.db.collection(PEDIDOS).document(pedido_id), campos)

    def _escribir_stock(self, tx, pedido_id, pedido, plan, intento, quien, motivo_mov='venta', revierte=None):
        if plan is None:
            return
        productos = [p for p in plan['productos'] if not p.get('saltado') and p.get('campos')]
        movimientos = sum(len(p['movimientos']) for p in productos)
        if len(productos) + movimientos + 4 > MAX_ESCRITURAS:
            raise ValueError('el pedido tiene demasiados renglones para una transacción')
        codigo = str((pedido or {}).get('codigo') or pedido_id)
        n = 0
        for p in productos:
            tx.set(self.db.collection('catalogo').document(p['id']),
                   {**p['campos'], 'ultima_actualizacion': firestore.SERVER_TIMESTAMP}, merge=True)
            for m in p['movimientos']:
                tx.set(self.db.collection(MOVIMIENTOS).document(f'tienda_{pedido_id}_{intento}_{n}'), {
                    'ts': firestore.SERVER_TIMESTAMP,
                    'origen': 'pos',
                    'pc_id': quien.get('pc_id') or '',
                    'usuario': quien.get('cajero') or 'Tienda online',
                    'producto_id': None,
                    'firebase_id': p['id'],
                    'producto_nombre': p.get('nombre') or '',
                    'motivo': motivo_mov,
                    'cantidad': reglas._limpio(round(float(m['cantidad']), 4)),
                    'stock_antes': reglas._limpio(round(float(m['antes']), 4)),
                    'stock_despues': reglas._limpio(round(float(m['despues']), 4)),
                    'referencia': f'Pedido tienda {codigo}' + (' (devolución)' if motivo_mov == 'anulacion' else ''),
                    'detalle': m.get('detalle') or '',
                    'pedido_id': pedido_id,
                    'intento': intento,
                    **({'revierte_intento': revierte} if revierte else {}),
                })
                n += 1

    def _escribir_evento(self, tx, pedido_id, pedido, accion, intento, quien, ahora,
                         estado_despues=None, detalle='', plan=None, extra=None):
        doc = {
            'pedido_id': pedido_id,
            'codigo': str((pedido or {}).get('codigo') or ''),
            'accion': accion,
            'resultado': 'hecho',
            'detalle': detalle,
            'origen': 'pos',
            **_marca(quien),
            'intento': intento,
            'en': firestore.SERVER_TIMESTAMP,
            'dia': reglas.dia_argentina(ahora),
            'estado_antes': (pedido or {}).get('estado'),
            'estado_despues': estado_despues or (pedido or {}).get('estado'),
        }
        if plan is not None:
            doc['stock'] = [
                {'id': p['id'], 'nombre': p.get('nombre') or '', 'movimientos': p['movimientos']}
                for p in plan['productos'] if not p.get('saltado') and p.get('campos')
            ]
            doc['saltados'] = plan['saltados']
        if extra:
            doc.update(extra)
        tx.set(self.db.collection(EVENTOS).document(f'{pedido_id}__{accion}__{intento}'), doc)

    def _anotar_rechazo(self, pedido_id, accion, intento, decision, pedido):
        try:
            quien = self._quien()
            ahora = self._reloj()
            self.db.collection(EVENTOS).document(f'{pedido_id}__{accion}__{intento}__rechazo').set({
                'pedido_id': pedido_id, 'codigo': str((pedido or {}).get('codigo') or ''),
                'accion': accion, 'resultado': 'rechazado',
                'detalle': decision.get('rechazo') or '', 'motivo': decision.get('motivo') or '',
                'origen': 'pos', **_marca(quien), 'intento': intento,
                'en': firestore.SERVER_TIMESTAMP, 'dia': reglas.dia_argentina(ahora),
                'estado_antes': (pedido or {}).get('estado'),
            })
        except Exception as e:
            logger.info(f'Pedidos: no se pudo anotar el rechazo de {accion} {pedido_id}: {e}')

    @staticmethod
    def _con_hora_del_servidor(campos):
        """La hora de la entrega la pone el servidor, no el reloj de la PC; el
        día (`entregado_dia`) sale de la PC porque el servidor no lo calcula."""
        campos = dict(campos)
        if 'entregado_en' in campos:
            campos['entregado_en'] = firestore.SERVER_TIMESTAMP
        return campos

    def _despues_del_stock(self, r: Resultado):
        if not r.plan:
            return
        try:
            self.db.collection('config').document('catalogo_meta').set(
                {'last_updated': self._reloj().strftime('%Y-%m-%dT%H:%M:%S%z')}, merge=True)
        except Exception as e:
            logger.info(f'Pedidos: semáforo del catálogo sin actualizar: {e}')
        if self._al_descontar:
            try:
                self._al_descontar(reglas.cambios_para_la_tienda(r.plan, r.catalogo or {}))
            except Exception as e:
                logger.info(f'Pedidos: la vidriera no se actualizó: {e}')
        if r.plan.get('saltados'):
            logger.warning(f"Pedidos: renglones sin descontar en {(r.pedido or {}).get('codigo')}: "
                           f"{r.plan['saltados']}")

    def _avisar(self, pedido_id):
        """El aviso al celular del cliente, sin esperarlo. La función de la
        tienda no pide credenciales y solo avisa si el estado cambió desde el
        último aviso, así que llamarla de más no molesta a nadie."""
        if not self._avisar_cliente:
            return

        def _post():
            try:
                req = urllib.request.Request(
                    URL_AVISO_CLIENTE, data=json.dumps({'id': pedido_id}).encode('utf-8'),
                    headers={'Content-Type': 'application/json'}, method='POST')
                urllib.request.urlopen(req, timeout=10, context=_contexto_tls()).close()
            except Exception as e:
                logger.info(f'Pedidos: aviso al cliente de {pedido_id} sin enviar: {e}')

        threading.Thread(target=_post, daemon=True, name='aviso-cliente').start()


def _contexto_tls():
    """Las raíces de certifi: una PC recién instalada puede no tener en Windows
    la de Let's Encrypt, y el aviso fallaba callado."""
    import ssl
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def _hora_de(snap):
    leida = getattr(snap, 'read_time', None)
    if isinstance(leida, datetime):
        return leida.astimezone(reglas.TZ_AR)
    return datetime.now(reglas.TZ_AR)


def _es_choque(error):
    """Aborto por concurrencia: se reintenta. Cualquier otra cosa (sin red, sin
    permiso, datos inválidos) sube como error."""
    try:
        from google.api_core import exceptions as gexc
        if isinstance(error, gexc.Aborted):
            return True
    except ImportError:
        pass
    return isinstance(error, ValueError) and 'Failed to commit transaction' in str(error)


def _marca(quien):
    return {'pc_id': quien.get('pc_id') or '', 'pc_nombre': quien.get('pc_nombre') or '',
            'cajero': quien.get('cajero') or ''}


def _con_id(pedido_id, pedido):
    return {'id': pedido_id, **pedido} if pedido is not None else None


def _sin_fechas(marca):
    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in (marca or {}).items()}
