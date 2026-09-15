/**
 * La sesión del repartidor con Firebase.
 *
 * El link trae la clave en el fragmento (`/reparto#k=...`): lo que va después
 * del numeral no viaja al servidor ni queda en los registros de Netlify. Se
 * guarda en el celular y se saca de la barra de direcciones.
 *
 * Con la clave, `reparto-sesion` devuelve un token con el permiso de repartidor
 * y se entra con él en una app de Firebase propia (`reparto`), con la sesión en
 * memoria: al recargar se vuelve a pedir, así un link anulado deja de servir en
 * la próxima apertura aunque el celular siga prendido.
 */
import { initializeApp, getApps } from 'firebase/app';
import { initializeAuth, inMemoryPersistence, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, collection, query, where, onSnapshot, doc, getDoc } from 'firebase/firestore';
import { config } from '../firebase_config.js';
import { ESTADOS_EN_CURSO, diaArgentina } from '../reparto.js';

const LLAVE = 'liceo.reparto.clave';

export function tomarClave({ ventana = window } = {}) {
  const fragmento = new URLSearchParams(String(ventana.location.hash || '').replace(/^#/, ''));
  const nueva = fragmento.get('k');
  if (nueva) {
    try { ventana.localStorage.setItem(LLAVE, nueva); } catch { /* sin almacenamiento: vale para esta visita */ }
    ventana.history.replaceState(null, '', ventana.location.pathname);
    return nueva;
  }
  try { return ventana.localStorage.getItem(LLAVE); } catch { return null; }
}

export function olvidarClave({ ventana = window } = {}) {
  try { ventana.localStorage.removeItem(LLAVE); } catch { /* nada que olvidar */ }
}

let _app = null;
let _auth = null;
let _db = null;

function conectar() {
  if (!_app) {
    _app = getApps().find(a => a.name === 'reparto') || initializeApp(config, 'reparto');
    _auth = initializeAuth(_app, { persistence: inMemoryPersistence });
    _db = getFirestore(_app);
  }
  return { auth: _auth, db: _db };
}

/**
 * @returns {Promise<{ok: false, motivo: 'link'|'red'} |
 *                   {ok: true, config: object, escuchar: Function}>}
 */
export async function abrir(clave) {
  let respuesta;
  try {
    respuesta = await fetch('/.netlify/functions/reparto-sesion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clave }),
    });
  } catch {
    return { ok: false, motivo: 'red' };
  }
  if (respuesta.status === 401 || respuesta.status === 400) return { ok: false, motivo: 'link' };
  if (!respuesta.ok) return { ok: false, motivo: 'red' };

  const { auth, db } = conectar();
  try {
    const { token } = await respuesta.json();
    await signInWithCustomToken(auth, token);
  } catch (err) {
    console.warn('[reparto] no se pudo entrar:', err?.code || err);
    return { ok: false, motivo: 'red' };
  }

  let ajustes = {};
  try {
    const snap = await getDoc(doc(db, 'tienda_config', 'settings'));
    ajustes = snap.exists() ? snap.data() : {};
  } catch { /* sin config: sin el local en el mapa, el resto anda igual */ }

  return {
    ok: true,
    config: { origen: ajustes.origen || null, whatsapp: ajustes.whatsapp || '', direccion: ajustes.direccion || '' },
    escuchar: (alCambiar, alFallar) => escuchar(db, alCambiar, alFallar),
  };
}

/**
 * Los pedidos con envío en curso y los entregados hoy, en vivo. Las dos
 * consultas filtran por `entrega.modo`: las reglas solo dejan leer al
 * repartidor los pedidos con envío, y una consulta que no lo pida la rechazan.
 */
function escuchar(db, alCambiar, alFallar) {
  const pedidos = collection(db, 'tienda_pedidos');
  let enCurso = null;
  let entregadosHoy = null;
  const avisar = () => {
    if (enCurso && entregadosHoy) alCambiar({ enCurso, entregadosHoy });
  };
  const aLista = (snap) => snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const cortes = [
    onSnapshot(
      query(pedidos, where('entrega.modo', '==', 'delivery'), where('estado', 'in', ESTADOS_EN_CURSO)),
      snap => { enCurso = aLista(snap); avisar(); },
      alFallar,
    ),
    onSnapshot(
      query(pedidos, where('entrega.modo', '==', 'delivery'), where('entregado_dia', '==', diaArgentina())),
      snap => { entregadosHoy = aLista(snap); avisar(); },
      alFallar,
    ),
  ];
  return () => cortes.forEach(cortar => cortar());
}
