/**
 * La configuración web del proyecto de Firebase.
 *
 * Aparte de `firebase.js` porque la usan dos aplicaciones: la tienda y la
 * pantalla del repartidor (`reparto.html`), que arma su propia instancia con su
 * propia sesión para no mezclarse con la cuenta de un cliente.
 *
 * La apiKey es publica por diseno (viaja en el bundle de cualquier app web de
 * Firebase). Lo que protege la base son las reglas de firestore.rules.
 */
export const config = {
  apiKey: 'AIzaSyDBqPTloSp1MWBFcVMY6mdgyYKoqhTwFRA',
  authDomain: 'mari-d7c71.firebaseapp.com',
  projectId: 'mari-d7c71',
  storageBucket: 'mari-d7c71.firebasestorage.app',
  messagingSenderId: '477197039887',
  appId: '1:477197039887:web:f00b662c87d6eb74d2667a',
};
