/**
 * La pantalla del repartidor.
 *
 * Entra con el link que genera el panel (sin usuario ni clave), escucha en vivo
 * los pedidos con envío y le recomienda cuál llevar: siempre el que le queda más
 * cerca a donde está. Mover un pedido pasa por la función `reparto-mover`, que
 * vuelve a revisar el link y las reglas.
 *
 * Todo lo que toca afuera entra por `dependencias` (la sesión con Firebase, el
 * GPS, el mapa, el achicador de fotos), así la pantalla se prueba sin nada de
 * eso.
 */
import { avisar } from '../avisos.js';
import { ordenarRuta, paraLlevar, enPreparacion, distanciaKm, yaLlego } from '../reparto.js';
import * as vista from './vista.js';
import { abrirHojaEntrega, cerrarHojaEntrega } from './hoja_entrega.js';

// Un movimiento del GPS por debajo de esto no cambia la recomendación: no vale
// repintar la lista con cada paso.
const METROS_PARA_REORDENAR = 40;

// Una escucha de Firestore que falla no se vuelve a abrir sola: queda muerta y
// la pantalla dejaría de actualizarse hasta recargar. Se reabre con estas
// esperas, cada vez más largas mientras siga fallando.
const ESPERAS_RECONEXION = [2_000, 5_000, 10_000, 30_000];

const MENSAJES_MOVER = {
  cambio: 'El local cambió este pedido mientras tanto. Ya está actualizado.',
  hacia_atras: 'Ese pedido ya estaba más adelante. Ya está actualizado.',
  terminado: 'Ese pedido ya estaba entregado o cancelado.',
  no_es_envio: 'Ese pedido lo retiran en el local.',
  no_existe: 'Ese pedido ya no existe.',
  foto: 'La foto no se pudo usar. Probá con otra o entregá sin foto.',
};

export async function iniciarReparto(raiz, dependencias) {
  const { sesion, mover, ubicacion, mapa, achicar } = dependencias;

  const estado = {
    clave: null,
    config: {},
    enCurso: [],
    entregadosHoy: [],
    yo: null,
    ordenadoDesde: null,
    ubicacion: 'sin_pedir',
    moviendo: new Set(),
    // Pedido → { destino, listo }: movimientos que esperan ver el cambio en la base.
    esperas: new Map(),
    abiertos: new Set(),
    abierta: null,
    cortar: null,
    reconexion: { intento: 0, temporizador: null },
    soltarUbicacion: null,
    mapa: null,
    recibido: false,
  };

  const zona = (nombre) => raiz.querySelector(`[data-${nombre}]`);

  function dejarDeReconectar() {
    clearTimeout(estado.reconexion.temporizador);
    estado.reconexion.temporizador = null;
  }

  function mostrarAviso(opciones) {
    dejarDeReconectar();
    estado.cortar?.();
    estado.cortar = null;
    estado.mapa?.soltar();
    estado.mapa = null;
    raiz.innerHTML = vista.pantallaAviso(opciones);
  }

  function linkVencido() {
    sesion.olvidarClave();
    cerrarHojaEntrega();
    mostrarAviso({
      titulo: 'Este link ya no sirve',
      texto: 'El local generó uno nuevo o lo anuló. Pedile el link del repartidor actualizado.',
    });
  }

  /* ── Dibujo ─────────────────────────────────────────────────────────────── */

  function calcular() {
    const desde = estado.yo || estado.config.origen || null;
    const ruta = ordenarRuta(paraLlevar(estado.enCurso), desde);
    return { ruta, preparandoLista: enPreparacion(estado.enCurso), entregadosHoy: estado.entregadosHoy };
  }

  // Lo último que se dibujó en cada zona. Solo se reemplaza lo que cambió: si se
  // rearma un botón mientras el dedo está apoyado, el toque se pierde.
  const dibujado = new WeakMap();

  function poner(nombre, html) {
    const nodo = zona(nombre);
    if (!nodo || dibujado.get(nodo) === html) return;
    nodo.innerHTML = html;
    dibujado.set(nodo, html);
  }

  function pintar() {
    if (!zona('zona-proxima')) return;
    const datos = calcular();
    const opciones = {
      moviendo: estado.moviendo,
      abiertos: estado.abiertos,
      conUbicacion: Boolean(estado.yo),
      entregadosAbiertos: Boolean(raiz.querySelector('.reparto-entregados')?.open),
    };
    poner('resumen', vista.resumen(estado));
    poner('aviso-ubicacion', vista.avisoUbicacion(estado.ubicacion));
    poner('zona-proxima', estado.recibido ? vista.proxima(datos.ruta[0], opciones) : vista.esqueleto());
    poner('listas', vista.listas(datos, opciones));
    poner('zona-ruta', vista.enlaceDeRuta(datos.ruta));
    estado.mapa?.actualizar({
      local: estado.config.origen || null,
      yo: estado.yo,
      paradas: datos.ruta
        .filter(p => p.pedido.entrega?.coordenadas)
        .map((p, i) => ({ id: p.pedido.id, numero: i + 1, ...p.pedido.entrega.coordenadas })),
    });
  }

  /* ── Sesión y datos en vivo ─────────────────────────────────────────────── */

  async function entrar() {
    estado.clave = sesion.tomarClave();
    if (!estado.clave) {
      mostrarAviso({
        titulo: 'Falta el link del repartidor',
        texto: 'Esta pantalla se abre con el link que te manda el local. Pedíselo y abrilo desde este celular.',
      });
      return;
    }

    raiz.innerHTML = vista.esqueleto();
    const abierta = await sesion.abrir(estado.clave);
    if (!abierta.ok) {
      if (abierta.motivo === 'link') { linkVencido(); return; }
      mostrarAviso({
        titulo: 'No pudimos conectar',
        texto: 'Revisá que tengas internet y probá de nuevo.',
        reintentar: true,
      });
      return;
    }

    estado.config = abierta.config || {};
    estado.abierta = abierta;
    raiz.innerHTML = vista.armazon();
    estado.mapa = mapa(zona('mapa'));
    pintar();

    estado.reconexion.intento = 0;
    escucharEnVivo();
    arrancarUbicacion();
  }

  function escucharEnVivo() {
    dejarDeReconectar();
    estado.cortar?.();
    estado.cortar = estado.abierta.escuchar(alLlegarDatos, alCortarseEscucha);
  }

  function marcarConexion(conectada) {
    const vivo = zona('vivo');
    const aviso = zona('conexion');
    if (vivo) vivo.hidden = !conectada;
    if (aviso) aviso.hidden = conectada;
  }

  function buscarPedido(id) {
    return estado.enCurso.find(p => p.id === id) || estado.entregadosHoy.find(p => p.id === id) || null;
  }

  function alLlegarDatos({ enCurso, entregadosHoy }) {
    estado.enCurso = enCurso;
    estado.entregadosHoy = entregadosHoy;
    estado.recibido = true;
    estado.reconexion.intento = 0;
    marcarConexion(true);
    // Lo que la base ya muestra hecho no espera la respuesta de la función, que
    // contesta recién después de avisarle al cliente.
    for (const [id, espera] of estado.esperas) {
      if (!yaLlego(buscarPedido(id), espera.destino)) continue;
      estado.esperas.delete(id);
      estado.moviendo.delete(id);
      espera.listo({ ok: true });
    }
    pintar();
  }

  function alCortarseEscucha(err) {
    if (err?.code === 'permission-denied') { linkVencido(); return; }
    // Las dos consultas avisan del mismo corte: se reprograma una sola vez.
    if (estado.reconexion.temporizador) return;
    marcarConexion(false);
    estado.cortar?.();
    estado.cortar = null;
    const { intento } = estado.reconexion;
    estado.reconexion.intento = intento + 1;
    estado.reconexion.temporizador = setTimeout(
      escucharEnVivo,
      ESPERAS_RECONEXION[Math.min(intento, ESPERAS_RECONEXION.length - 1)],
    );
  }

  /* ── Ubicación ──────────────────────────────────────────────────────────── */

  async function arrancarUbicacion({ pedir = false } = {}) {
    const permiso = await ubicacion.permiso();
    if (permiso === 'no_disponible') { estado.ubicacion = 'no_disponible'; pintar(); return; }
    if (permiso === 'denied') { estado.ubicacion = 'denegada'; pintar(); return; }
    if (permiso !== 'granted' && !pedir) { estado.ubicacion = 'sin_pedir'; pintar(); return; }

    estado.ubicacion = 'pidiendo';
    estado.soltarUbicacion?.();
    estado.soltarUbicacion = ubicacion.seguir(
      (punto) => {
        estado.ubicacion = 'activa';
        estado.yo = punto;
        // Se reordena solo si se movió de verdad desde el último orden.
        const lejos = !estado.ordenadoDesde
          || distanciaKm(estado.ordenadoDesde, punto) * 1000 > METROS_PARA_REORDENAR;
        if (lejos) {
          estado.ordenadoDesde = punto;
          pintar();
        } else {
          estado.mapa?.actualizar({ yo: punto });
        }
      },
      (err) => {
        estado.ubicacion = err?.code === 1 ? 'denegada' : 'no_disponible';
        pintar();
      },
    );
    pintar();
  }

  /* ── Botones ────────────────────────────────────────────────────────────── */

  /**
   * Termina con lo primero que llegue: la respuesta de la función o el cambio
   * visto en la base. La función escribe antes de avisarle al cliente, así que
   * en general la base gana por un par de segundos.
   */
  async function moverPedido(id, estadoNuevo, extra = {}) {
    estado.moviendo.add(id);
    pintar();
    const porLaBase = new Promise(listo => estado.esperas.set(id, { destino: estadoNuevo, listo }));
    const porLaFuncion = (async () => {
      try {
        return await mover(estado.clave, id, estadoNuevo, extra);
      } catch {
        return { ok: false, error: 'red' };
      }
    })();
    let resultado = await Promise.race([porLaFuncion, porLaBase]);
    estado.esperas.delete(id);
    estado.moviendo.delete(id);
    if (resultado.error === 'link') { linkVencido(); return resultado; }
    // Se cortó la conexión después de escribir, o el local lo había movido igual:
    // el pedido está donde el repartidor quería.
    if (!resultado.ok && yaLlego(buscarPedido(id), estadoNuevo)) resultado = { ok: true };
    pintar();
    return resultado;
  }

  raiz.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-reintentar]')) { entrar(); return; }
    if (ev.target.closest('[data-activar-ubicacion]')) { arrancarUbicacion({ pedir: true }); return; }

    const abrir = ev.target.closest('[data-abrir]');
    if (abrir) {
      const id = abrir.dataset.abrir;
      if (estado.abiertos.has(id)) estado.abiertos.delete(id);
      else estado.abiertos.add(id);
      pintar();
      return;
    }

    const boton = ev.target.closest('[data-mover]');
    if (!boton || boton.disabled) return;
    const id = boton.dataset.id;
    if (estado.moviendo.has(id)) return;
    const pedido = estado.enCurso.find(p => p.id === id);
    if (!pedido) return;
    const estadoNuevo = boton.dataset.mover;

    if (estadoNuevo === 'entregado') {
      abrirHojaEntrega(pedido, {
        achicar,
        confirmar: async ({ cobrado, foto }) => {
          const r = await moverPedido(id, 'entregado', { cobrado, foto });
          if (r.ok) {
            avisar(`Pedido ${pedido.codigo || ''} entregado`);
            return { ok: true };
          }
          return {
            ok: false,
            mensaje: MENSAJES_MOVER[r.error] || 'No se pudo marcar la entrega. Revisá la conexión y probá de nuevo.',
          };
        },
      });
      return;
    }

    const r = await moverPedido(id, estadoNuevo);
    if (!r.ok && r.error !== 'link') {
      avisar(MENSAJES_MOVER[r.error] || 'No se pudo cambiar el pedido. Revisá la conexión y probá de nuevo.', { tipo: 'error' });
    }
  });

  // Al volver de Google Maps o de WhatsApp con la escucha cortada no se espera
  // al próximo reintento.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && estado.reconexion.temporizador) escucharEnVivo();
  });

  window.addEventListener('pagehide', () => {
    dejarDeReconectar();
    estado.cortar?.();
    estado.cortar = null;
    estado.soltarUbicacion?.();
  });

  await entrar();
}

