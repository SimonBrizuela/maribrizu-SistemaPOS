import { initializeApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
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
// persistentMultipleTabManager → si la admin tiene varias pestañas abiertas,
// comparten el mismo cache local sin pisarse.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
    cacheSizeBytes: CACHE_SIZE_UNLIMITED,
  }),
});
