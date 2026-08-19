import { initializeApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  CACHE_SIZE_UNLIMITED,
  setLogLevel,
} from "firebase/firestore";

// Debug del SDK Firestore: agregá `?debug=1` a la URL para activar.
// Loguea cada request, cache hit, snapshot, etc. Muy verboso pero útil
// para diagnosticar cuellos de botella.
try {
  const params = new URLSearchParams(window.location.search);
  if (params.get('debug') === '1') {
    setLogLevel('debug');
    window.__POS_DEBUG__ = true;
    console.log('[firebase] DEBUG MODE ON — logs verbosos del SDK activos');
  }
} catch (_) {}

const firebaseConfig = {
  apiKey: "AIzaSyDBqPTloSp1MWBFcVMY6mdgyYKoqhTwFRA",
  authDomain: "mari-d7c71.firebaseapp.com",
  projectId: "mari-d7c71",
  storageBucket: "mari-d7c71.firebasestorage.app",
  messagingSenderId: "477197039887",
  appId: "1:477197039887:web:f00b662c87d6eb74d2667a",
  measurementId: "G-Q8LZDG6YNV"
};

export const app = initializeApp(firebaseConfig);

// App Check (reCAPTCHA v3): prueba que las peticiones salen de esta webapp y
// no de un script cualquiera con la apiKey copiada del bundle. La apiKey es
// pública por diseño, así que sin App Check las rules son la única barrera.
//
// Se activa solo si VITE_APPCHECK_KEY está definida en el build (variable de
// entorno de Netlify). Sin la clave el módulo ni se carga, así que el
// desarrollo local y los builds viejos siguen funcionando igual.
const appCheckKey = import.meta.env.VITE_APPCHECK_KEY;
if (appCheckKey) {
  import('firebase/app-check').then(({ initializeAppCheck, ReCaptchaV3Provider }) => {
    try {
      initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(appCheckKey),
        isTokenAutoRefreshEnabled: true,
      });
      console.log('[firebase] App Check activo');
    } catch (err) {
      console.warn('[firebase] App Check no pudo inicializarse:', err);
    }
  }).catch(err => console.warn('[firebase] App Check no disponible:', err));
}

// IndexedDB cache persistente: en cada F5 el SDK lee de disco y solo pide al
// server los docs que cambiaron desde la última conexión (delta sync). Hace
// que el primer pintado tras un reload sea instantáneo y el tráfico a
// Firestore sea mínimo.
//
// persistentSingleTabManager → cada pestaña es INDEPENDIENTE. Antes se usaba
// persistentMultipleTabManager (cache compartido entre pestañas), pero en ese
// modo una sola pestaña es la "primaria" que habla con el server y las demás
// dependen de ella vía IndexedDB: con nuestro volumen (~12k docs de catálogo,
// ~17k de ventas) y el throttling de pestañas en background de Chrome, la
// segunda pestaña quedaba esperando a la primaria y no cargaba nunca.
// Con single-tab, la primera pestaña se queda con el cache en disco; las
// siguientes no pueden tomar el lock y el SDK cae solo a cache en memoria
// (avisa con un warning en consola): leen directo del server, sin esperar a
// nadie. La hidratación propia (pos_snapshots en store.js) igual les da el
// primer pintado instantáneo en cualquier pestaña.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentSingleTabManager(),
    cacheSizeBytes: CACHE_SIZE_UNLIMITED,
  }),
});
