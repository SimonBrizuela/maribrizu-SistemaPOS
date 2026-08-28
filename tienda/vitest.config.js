import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Firebase, una sola vez.
  //
  // Varias pruebas importan modulos del panel (`webapp/src/*`), y el panel
  // tiene su propia copia de `firebase` en `webapp/node_modules`. Sin esto,
  // `firebase/firestore` resuelve a DOS modulos distintos segun quien lo pida:
  // `vi.mock` reemplaza la copia de la tienda y el codigo del panel sigue
  // usando la suya. El sintoma es silencioso — la prueba pasa y el modulo
  // nunca se ejecuto de verdad, o falla con "Expected first argument to
  // collection() to be a CollectionReference".
  //
  // Con `dedupe` las dos puntas resuelven al mismo modulo y el mock alcanza a
  // todo, que es lo que permite probar de verdad lo que escribe en Firestore.
  resolve: {
    dedupe: ['firebase', '@firebase/app', '@firebase/firestore', '@firebase/auth'],
  },
  test: {
    include: ['pruebas/**/*.test.js'],
    // El navegador aporta localStorage y fetch; en Node hay que ponerlos a mano.
    // Se hace con un archivo de arranque en vez de con jsdom entero: lo unico
    // del navegador que usa esta capa es el almacenamiento del carrito.
    setupFiles: ['pruebas/arranque.js'],
    environment: 'node',
  },
});
