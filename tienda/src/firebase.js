/**
 * Conexion a Firestore para la tienda publica.
 *
 * Sin Auth: la tienda solo lee `tienda_productos` y `tienda_config`, que las
 * reglas dejan abiertas a cualquiera, y crea documentos en `tienda_pedidos`,
 * que valida su forma en las reglas. Nadie se loguea para comprar.
 *
 * La apiKey es publica por diseno (viaja en el bundle de cualquier app web de
 * Firebase). Lo que protege la base son las reglas de firestore.rules, no esta
 * clave.
 */
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const config = {
  apiKey: 'AIzaSyDBqPTloSp1MWBFcVMY6mdgyYKoqhTwFRA',
  authDomain: 'mari-d7c71.firebaseapp.com',
  projectId: 'mari-d7c71',
  storageBucket: 'mari-d7c71.firebasestorage.app',
  messagingSenderId: '477197039887',
  appId: '1:477197039887:web:f00b662c87d6eb74d2667a',
};

export const app = initializeApp(config);
export const db = getFirestore(app);

// App Check (reCAPTCHA v3) si esta configurado en el build. Prueba que los
// pedidos salen de esta tienda y no de un script con la apiKey copiada. Sin la
// variable de entorno el modulo ni se carga, asi que el desarrollo local
// funciona igual.
const claveAppCheck = import.meta.env.VITE_APPCHECK_KEY;
if (claveAppCheck) {
  import('firebase/app-check')
    .then(({ initializeAppCheck, ReCaptchaV3Provider }) => {
      initializeAppCheck(app, {
        provider: new ReCaptchaV3Provider(claveAppCheck),
        isTokenAutoRefreshEnabled: true,
      });
    })
    .catch(err => console.warn('[firebase] App Check no disponible:', err));
}
