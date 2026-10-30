"""
Doble en memoria de `NubeCarritos` para las pruebas de pantalla.

Se comporta como Firestore en lo que importa acá:
  - Transacciones optimistas: se lee, se decide y al confirmar se compara la
    versión de cada documento leído. Si otro escribió en el medio, se repite
    con lo nuevo (como el SDK). `entre_lectura_y_escritura` mete una operación
    de otra caja justo en ese hueco para probar las carreras.
  - `actualizado`, `pedida_en` y `entregada_en` los pone el "servidor" (reloj
    inyectable), no la caja.
  - Las escuchas reciben las noticias en orden, desde otro hilo, igual que
    `on_snapshot`.
  - Internet por caja: `nube.para('pc1')` es la conexión de la Compu 1;
    `desconectar('pc1')` la deja sin red (sus operaciones fallan y no recibe
    noticias) y `reconectar('pc1')` le manda lo último, como hace Firestore al
    volver. `sin_internet = True` corta a todas.

Las decisiones son las de `pos_system/models/carrito_vivo.py`, las mismas que
usa la nube de verdad: lo que se prueba acá es la regla, no una copia.
"""
import copy
import queue
import threading
from datetime import datetime, timedelta, timezone

from pos_system.models import carrito_vivo as reglas

C, S = 'carritos', 'solicitudes'


class Resultado(dict):
    """Igual que el de `pedidos_tienda_nube`, sin importar Firestore: el gRPC
    cargado entre ventanas de Qt tira el proceso de pruebas."""

    def __getattr__(self, clave):
        return self.get(clave)


class SinInternet(Exception):
    pass


class NubeCarritosMemoria:
    def __init__(self, reloj=None):
        self._lock = threading.RLock()
        self.docs = {}            # carritos_vivos
        self.solicitudes = {}     # carritos_vivos_solicitudes
        self._datos = {C: self.docs, S: self.solicitudes}
        self.versiones = {}
        self.pcs = {}
        self._escuchas = []       # (pc, tipo, objetivo, cb)
        self._reloj = reloj or (lambda: datetime.now(timezone.utc))
        self.sin_internet = False
        self.desconectadas = set()
        self.entre_lectura_y_escritura = None   # fn(accion) que corre una vez
        self.hueco_en = None                     # solo en esa acción ('entregar'...)
        self.transacciones = []                  # (accion, pc) en orden
        self.choques = 0
        self._noticias = queue.Queue()
        threading.Thread(target=self._repartir, daemon=True, name='doble-escucha').start()

    # ── "Servidor" ──────────────────────────────────────────────────────────
    def ahora(self):
        return self._reloj()

    def adelantar(self, segundos):
        base = self._reloj()
        self._reloj = lambda: base + timedelta(seconds=segundos)

    def para(self, pc_id):
        return _Conexion(self, pc_id)

    def desconectar(self, pc_id):
        self.desconectadas.add(pc_id)

    def reconectar(self, pc_id):
        self.desconectadas.discard(pc_id)
        with self._lock:
            fotos = {C: copy.deepcopy(self.docs), S: copy.deepcopy(self.solicitudes)}
        for esc in list(self._escuchas):
            if esc[0] == pc_id:
                self._encolar_noticia(esc, fotos)

    def _red(self, pc):
        if self.sin_internet or pc in self.desconectadas:
            raise SinInternet('sin internet')

    def _correr(self, pc, accion, claves, cuerpo):
        """Lee `claves` [(col, id)], decide con `cuerpo(docs) -> (escrituras,
        resultado)` y confirma solo si nadie tocó lo leído; si no, repite.
        Las escrituras son {(col, id): datos}; los datos con '__update__'
        se mezclan con lo que hay."""
        for _ in range(10):
            self._red(pc)
            with self._lock:
                leidos = {k: (copy.deepcopy(self._datos[k[0]].get(k[1])), self.versiones.get(k, 0))
                          for k in claves}
            escrituras, resultado = cuerpo({k: d for k, (d, _v) in leidos.items()})
            hueco = self.entre_lectura_y_escritura
            if hueco is not None and self.hueco_en in (None, accion):
                self.entre_lectura_y_escritura = None
                hueco(accion)
            self._red(pc)
            with self._lock:
                if any(self.versiones.get(k, 0) != v for k, (_d, v) in leidos.items()):
                    self.choques += 1
                    continue
                ahora = self.ahora()
                for (col, ident), datos in escrituras.items():
                    datos = copy.deepcopy(datos)
                    for campo, valor in list(datos.items()):
                        if valor == '__ahora__':
                            datos[campo] = ahora
                    if datos.pop('__update__', False):
                        self._datos[col][ident] = {**(self._datos[col].get(ident) or {}), **datos}
                    else:
                        if col == C:
                            datos['actualizado'] = ahora
                        self._datos[col][ident] = datos
                    self.versiones[(col, ident)] = self.versiones.get((col, ident), 0) + 1
                self.transacciones.append((accion, claves[0][1]))
                fotos = {C: copy.deepcopy(self.docs), S: copy.deepcopy(self.solicitudes)}
            if escrituras:
                for esc in list(self._escuchas):
                    if esc[0] not in self.desconectadas and not self.sin_internet:
                        self._encolar_noticia(esc, fotos)
            return resultado
        raise RuntimeError('demasiados choques')

    def _encolar_noticia(self, esc, fotos):
        _pc, tipo, objetivo, cb = esc
        hora = self.ahora()
        if tipo == C:
            self._noticias.put((cb, (fotos[C], hora)))
        else:
            self._noticias.put((cb, (fotos[S].get(objetivo), hora)))

    def _repartir(self):
        while True:
            cb, args = self._noticias.get()
            try:
                cb(*args)
            except Exception:
                pass

    # ── API de NubeCarritos (por caja) ──────────────────────────────────────
    def publicar(self, pc_id, pc_nombre, epoch, estado, forzar_vacio=False, _pc=None):
        def cuerpo(docs):
            doc = docs[(C, pc_id)]
            d = reglas.decidir_publicacion(doc, epoch, estado, forzar_vacio)
            if d['accion'] == 'escribir':
                return {(C, pc_id): estado}, d
            if d['accion'] == 'vaciar':
                return {(C, pc_id): {**reglas.estado_vacio(pc_id, pc_nombre),
                                     'entregada_epoch': (doc or {}).get('entregada_epoch') or '',
                                     'entregada_a': (doc or {}).get('entregada_a')}}, d
            return {}, d
        try:
            d = self._correr(_pc or pc_id, 'publicar', [(C, pc_id)], cuerpo)
        except SinInternet:
            return Resultado(ok=False, accion='error', epoch=epoch)
        return Resultado(ok=True, epoch=epoch, **d)

    def pedir(self, origen_pc, epoch_visto, quien, sol_id, _pc=None):
        def cuerpo(docs):
            origen = docs[(C, origen_pc)]
            if origen is not None:
                origen.setdefault('pc_id', origen_pc)
            d = reglas.decidir_pedido(origen, docs[(S, origen_pc)], epoch_visto, quien['pc_id'],
                                      self.ahora())
            if 'rechazo' in d:
                return {}, d
            return {(S, origen_pc): {**reglas.solicitud_nueva(sol_id, epoch_visto, quien),
                                     'pedida_en': '__ahora__'}}, d
        try:
            d = self._correr(_pc or quien['pc_id'], 'pedir', [(C, origen_pc), (S, origen_pc)], cuerpo)
        except SinInternet:
            return Resultado(ok=False, motivo='error',
                             rechazo='No hay conexión con la nube. No se movió nada: probá de nuevo en un rato.')
        if 'rechazo' in d:
            return Resultado(ok=False, rechazo=d['rechazo'], motivo=d.get('motivo'))
        return Resultado(ok=True)

    def leer_solicitud(self, origen_pc, _pc=None):
        self._red(_pc)
        with self._lock:
            return copy.deepcopy(self.solicitudes.get(origen_pc))

    def cancelar(self, origen_pc, sol_id, _pc=None):
        salida = {}

        def cuerpo(docs):
            sol = docs[(S, origen_pc)]
            d = reglas.decidir_cancelacion(sol, sol_id)
            salida.clear()
            salida.update(d, sol=sol)
            if d['accion'] == 'cancelar':
                return {(S, origen_pc): {'__update__': True, 'estado': 'cancelada',
                                         'motivo': 'sin respuesta'}}, d
            return {}, d
        try:
            self._correr(_pc, 'cancelar', [(S, origen_pc)], cuerpo)
        except SinInternet:
            return Resultado(ok=False, accion='error')
        return Resultado(ok=True, accion=salida.get('accion'), sol=salida.get('sol'))

    def entregar(self, pc_id, pc_nombre, sol_id, epoch, estado, _pc=None):
        destino = ((self.solicitudes.get(pc_id) or {}).get('de') or {}).get('pc_id') or '_'

        def cuerpo(docs):
            sol = docs[(S, pc_id)]
            d = reglas.decidir_entrega(sol, sol_id, epoch, docs[(C, destino)], self.ahora())
            if 'rechazo' in d:
                return {}, d
            nuevo = reglas.doc_entregado(estado, sol)
            return {
                (C, destino): nuevo,
                (C, pc_id): reglas.doc_origen_entregado(estado, sol),
                (S, pc_id): {'__update__': True, 'estado': 'entregada', 'entrega': nuevo,
                             'entregada_en': '__ahora__'},
            }, {'ok': True, 'destino': sol.get('de') or {}}
        try:
            d = self._correr(_pc or pc_id, 'entregar', [(S, pc_id), (C, destino)], cuerpo)
        except SinInternet:
            return Resultado(ok=False, motivo='error', rechazo='Sin conexión con la nube.')
        if 'rechazo' in d:
            return Resultado(ok=False, rechazo=d['rechazo'], motivo=d.get('motivo'))
        return Resultado(ok=True, destino=d['destino'])

    def rechazar(self, pc_id, sol_id, motivo, _pc=None):
        def cuerpo(docs):
            sol = docs[(S, pc_id)]
            if sol and sol.get('id') == sol_id and sol.get('estado') == 'pedida':
                return {(S, pc_id): {'__update__': True, 'estado': 'rechazada', 'motivo': motivo}}, \
                    {'accion': 'rechazada'}
            return {}, {'accion': 'nada'}
        try:
            d = self._correr(_pc or pc_id, 'rechazar', [(S, pc_id)], cuerpo)
        except SinInternet:
            return Resultado(ok=False, accion='error')
        return Resultado(ok=True, **d)

    def escuchar(self, al_cambiar, _pc=None):
        esc = (_pc, C, None, al_cambiar)
        self._escuchas.append(esc)
        with self._lock:
            foto = copy.deepcopy(self.docs)
        self._noticias.put((al_cambiar, (foto, self.ahora())))
        return _Escucha(self, esc)

    def escuchar_solicitudes(self, pc_id, al_pedir, _pc=None):
        esc = (_pc or pc_id, S, pc_id, al_pedir)
        self._escuchas.append(esc)
        with self._lock:
            sol = copy.deepcopy(self.solicitudes.get(pc_id))
        self._noticias.put((al_pedir, (sol, self.ahora())))
        return _Escucha(self, esc)

    @staticmethod
    def escucha_caida(escucha):
        return escucha is None or escucha.cerrada

    def probar(self, pc_id):
        self._red(pc_id)
        return self.ahora()

    def guardar_nombre(self, pc_id, nombre):
        self._red(pc_id)
        self.pcs.setdefault(pc_id, {})['nombre_caja'] = nombre

    def nombres_en_uso(self, pc_id):
        self._red(pc_id)
        return {d['nombre_caja']: d.get('hostname') or i for i, d in self.pcs.items()
                if i != pc_id and d.get('nombre_caja')}


class _Conexion:
    """La nube vista desde una caja: sus operaciones fallan si esa caja está
    sin internet y sus escuchas no reciben noticias mientras tanto."""

    def __init__(self, nube, pc):
        self._n = nube
        self._pc = pc

    def __getattr__(self, nombre):
        metodo = getattr(self._n, nombre)
        if nombre in ('publicar', 'pedir', 'leer_solicitud', 'cancelar', 'entregar', 'rechazar',
                      'escuchar', 'escuchar_solicitudes'):
            return lambda *a, **k: metodo(*a, _pc=self._pc, **k)
        return metodo


class _Escucha:
    def __init__(self, nube, esc):
        self.nube = nube
        self.esc = esc
        self.cerrada = False

    def unsubscribe(self):
        self.cerrada = True
        if self.esc in self.nube._escuchas:
            self.nube._escuchas.remove(self.esc)
