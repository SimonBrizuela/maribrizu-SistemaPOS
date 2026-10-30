"""
Los carritos vivos en Firestore: publicar el propio, pedir la venta de otra
caja, entregar la propia cuando la piden, y escuchar.

Todas las operaciones son transacciones que vuelven a leer y deciden con
`pos_system/models/carrito_vivo.py`. Si dos cajas tocan el mismo documento a la
vez, Firestore repite la transacción con lo nuevo y la regla decide de vuelta.

La venta la mueve SOLO la caja que la tiene (`entregar`): la otra deja una
solicitud (`pedir`) y espera. La hora con la que vence una solicitud es la del
servidor (`pedida_en` y el `read_time` de la transacción que la cumple), no la
de ninguna PC.

Este módulo importa el cliente de Firestore: la pantalla no lo importa, se lo
pasa `main_window` ya armado (ver `CarritoCompartido.conectar`).
"""
import logging
import random
import time
from typing import Callable, Dict, Optional

from google.cloud import firestore
from google.cloud.firestore_v1.transaction import transactional

from pos_system.models import carrito_vivo as reglas
from pos_system.utils.pedidos_tienda_nube import Resultado, _es_choque

logger = logging.getLogger(__name__)

# Tope para cada lectura: sin internet, el cajero se entera en segundos y no en
# el minuto que tarda el cliente en rendirse.
LECTURA_SEGUNDOS = 8
VUELTAS_POR_CHOQUE = 6


class NubeCarritos:
    def __init__(self, db):
        self.db = db

    def _ref(self, pc_id):
        return self.db.collection(reglas.COLECCION).document(pc_id)

    def _sol(self, origen_pc):
        return self.db.collection(reglas.SOLICITUDES).document(origen_pc)

    # ── Publicar el carrito propio ──────────────────────────────────────────
    def publicar(self, pc_id: str, pc_nombre: str, epoch: Optional[str],
                 estado: Optional[Dict], forzar_vacio: bool = False) -> Resultado:
        ref = self._ref(pc_id)

        @transactional
        def _tx(tx):
            snap = ref.get(transaction=tx, timeout=LECTURA_SEGUNDOS)
            doc = snap.to_dict() if snap.exists else None
            d = reglas.decidir_publicacion(doc, epoch, estado, forzar_vacio)
            if d['accion'] == 'escribir':
                tx.set(ref, {**estado, 'actualizado': firestore.SERVER_TIMESTAMP})
            elif d['accion'] == 'vaciar':
                tx.set(ref, {**reglas.estado_vacio(pc_id, pc_nombre),
                             'entregada_epoch': (doc or {}).get('entregada_epoch') or '',
                             'entregada_a': (doc or {}).get('entregada_a'),
                             'actualizado': firestore.SERVER_TIMESTAMP})
            return d

        d = self._correr('publicar', _tx)
        if d is None:
            return Resultado(ok=False, accion='error', epoch=epoch)
        return Resultado(ok=True, epoch=epoch, **d)

    # ── Pedir la venta de otra caja ─────────────────────────────────────────
    def pedir(self, origen_pc: str, epoch_visto: str, quien: Dict, sol_id: str) -> Resultado:
        ref_o, ref_s = self._ref(origen_pc), self._sol(origen_pc)

        @transactional
        def _tx(tx):
            snap = ref_o.get(transaction=tx, timeout=LECTURA_SEGUNDOS)
            snap_s = ref_s.get(transaction=tx, timeout=LECTURA_SEGUNDOS)
            origen = snap.to_dict() if snap.exists else None
            if origen is not None:
                origen.setdefault('pc_id', origen_pc)
            sol = snap_s.to_dict() if snap_s.exists else None
            d = reglas.decidir_pedido(origen, sol, epoch_visto, quien['pc_id'],
                                      getattr(snap, 'read_time', None))
            if 'rechazo' not in d:
                tx.set(ref_s, {**reglas.solicitud_nueva(sol_id, epoch_visto, quien),
                               'pedida_en': firestore.SERVER_TIMESTAMP})
            return d

        d = self._correr('pedir', _tx)
        if d is None:
            return Resultado(ok=False, motivo='error',
                             rechazo='No hay conexión con la nube. No se movió nada: probá de nuevo en un rato.')
        if 'rechazo' in d:
            return Resultado(ok=False, rechazo=d['rechazo'], motivo=d.get('motivo'))
        return Resultado(ok=True)

    def leer_solicitud(self, origen_pc: str) -> Optional[Dict]:
        snap = self._sol(origen_pc).get(timeout=LECTURA_SEGUNDOS)
        return snap.to_dict() if snap.exists else None

    def cancelar(self, origen_pc: str, sol_id: str) -> Resultado:
        """La caja que pidió dejó de esperar. Devuelve accion 'cancelar' (se
        canceló: la venta sigue allá) o 'llego' (justo se entregó)."""
        ref_s = self._sol(origen_pc)
        salida = {}

        @transactional
        def _tx(tx):
            snap = ref_s.get(transaction=tx, timeout=LECTURA_SEGUNDOS)
            sol = snap.to_dict() if snap.exists else None
            d = reglas.decidir_cancelacion(sol, sol_id)
            salida.clear()
            salida.update(d, sol=sol)
            if d['accion'] == 'cancelar':
                tx.update(ref_s, {'estado': 'cancelada', 'motivo': 'sin respuesta'})
            return d

        d = self._correr('cancelar', _tx)
        if d is None:
            return Resultado(ok=False, accion='error')
        return Resultado(ok=True, accion=salida.get('accion'), sol=salida.get('sol'))

    # ── Entregar la venta propia ────────────────────────────────────────────
    def entregar(self, pc_id: str, pc_nombre: str, sol_id: str, epoch: str,
                 estado: Dict) -> Resultado:
        """La caja de origen cumple la solicitud con `estado`, su carrito tal
        como está ahora."""
        ref_o, ref_s = self._ref(pc_id), self._sol(pc_id)

        @transactional
        def _tx(tx):
            snap_s = ref_s.get(transaction=tx, timeout=LECTURA_SEGUNDOS)
            sol = snap_s.to_dict() if snap_s.exists else None
            destino_pc = ((sol or {}).get('de') or {}).get('pc_id') or ''
            doc_d = None
            if destino_pc:
                snap_d = self._ref(destino_pc).get(transaction=tx, timeout=LECTURA_SEGUNDOS)
                doc_d = snap_d.to_dict() if snap_d.exists else None
            d = reglas.decidir_entrega(sol, sol_id, epoch, doc_d, getattr(snap_s, 'read_time', None))
            if 'rechazo' in d:
                return d
            nuevo = reglas.doc_entregado(estado, sol)
            tx.set(self._ref(destino_pc), {**nuevo, 'actualizado': firestore.SERVER_TIMESTAMP})
            tx.set(ref_o, {**reglas.doc_origen_entregado(estado, sol),
                           'actualizado': firestore.SERVER_TIMESTAMP})
            tx.update(ref_s, {'estado': 'entregada', 'entrega': nuevo,
                              'entregada_en': firestore.SERVER_TIMESTAMP})
            return {'ok': True, 'destino': sol.get('de') or {}}

        d = self._correr('entregar', _tx)
        if d is None:
            return Resultado(ok=False, motivo='error', rechazo='Sin conexión con la nube.')
        if 'rechazo' in d:
            return Resultado(ok=False, rechazo=d['rechazo'], motivo=d.get('motivo'))
        return Resultado(ok=True, destino=d['destino'])

    def rechazar(self, pc_id: str, sol_id: str, motivo: str) -> Resultado:
        ref_s = self._sol(pc_id)

        @transactional
        def _tx(tx):
            snap = ref_s.get(transaction=tx, timeout=LECTURA_SEGUNDOS)
            sol = snap.to_dict() if snap.exists else None
            if sol and sol.get('id') == sol_id and sol.get('estado') == 'pedida':
                tx.update(ref_s, {'estado': 'rechazada', 'motivo': motivo})
                return {'accion': 'rechazada'}
            return {'accion': 'nada'}

        d = self._correr('rechazar', _tx)
        return Resultado(ok=d is not None, **(d or {'accion': 'error'}))

    def _correr(self, accion, tx_fn):
        for vuelta in range(VUELTAS_POR_CHOQUE):
            try:
                return tx_fn(self.db.transaction())
            except Exception as e:
                if _es_choque(e) and vuelta + 1 < VUELTAS_POR_CHOQUE:
                    time.sleep(random.uniform(0.05, 0.25) * (2 ** vuelta))
                    continue
                logger.warning(f'Carritos vivos: {accion} falló: {type(e).__name__}: {e}')
                return None
        return None

    # ── Escuchar ────────────────────────────────────────────────────────────
    def escuchar(self, al_cambiar: Callable[[Dict[str, Dict], object], None]):
        """`al_cambiar(docs, hora_del_servidor)` corre en el hilo de Firestore."""
        def _cb(docs, _cambios, hora):
            try:
                al_cambiar({d.id: (d.to_dict() or {}) for d in docs}, hora)
            except Exception as e:
                logger.warning(f'Carritos vivos: error leyendo la escucha: {e}')
        return self.db.collection(reglas.COLECCION).on_snapshot(_cb)

    def escuchar_solicitudes(self, pc_id: str, al_pedir: Callable[[Optional[Dict], object], None]):
        """Las solicitudes de la venta de ESTA caja. `al_pedir(sol, hora)`."""
        def _cb(docs, _cambios, hora):
            try:
                for d in docs:
                    al_pedir(d.to_dict() if d.exists else None, hora)
            except Exception as e:
                logger.warning(f'Carritos vivos: error leyendo solicitudes: {e}')
        return self._sol(pc_id).on_snapshot(_cb)

    @staticmethod
    def escucha_caida(escucha) -> bool:
        return escucha is None or bool(getattr(escucha, '_closed', False))

    def probar(self, pc_id: str):
        """Lectura chica para saber si hay internet. Devuelve la hora del
        servidor o levanta la excepción."""
        snap = self._ref(pc_id).get(timeout=LECTURA_SEGUNDOS)
        return getattr(snap, 'read_time', None)

    # ── Nombre de la caja ───────────────────────────────────────────────────
    def guardar_nombre(self, pc_id: str, nombre: str):
        self.db.collection('pcs').document(pc_id).set({'nombre_caja': nombre}, merge=True)

    def nombres_en_uso(self, pc_id: str) -> Dict[str, str]:
        """{nombre: nombre de Windows} de las otras cajas que ya tienen nombre."""
        salida = {}
        for d in self.db.collection('pcs').stream(timeout=LECTURA_SEGUNDOS):
            if d.id == pc_id:
                continue
            datos = d.to_dict() or {}
            nombre = str(datos.get('nombre_caja') or '').strip()
            if nombre:
                salida[nombre] = str(datos.get('hostname') or d.id)
        return salida
