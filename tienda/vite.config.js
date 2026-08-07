import { defineConfig } from 'vite';
import { funcionesEnDesarrollo } from './netlify/dev.js';

export default defineConfig({
  // En desarrollo las funciones de Netlify corren adentro de este servidor. Sin
  // eso el checkout no se puede probar: sin funciones no hay autocompletado de
  // direcciones ni cotización de envío, que es casi toda esa pantalla.
  plugins: [funcionesEnDesarrollo()],

  server: {
    port: 5180,
    open: true,
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // El SDK de Firebase pesa mas que toda la tienda junta. Separarlo hace
        // que un cambio en el codigo de la tienda no invalide el cache del
        // navegador para el bundle grande.
        manualChunks: {
          firebase: ['firebase/app', 'firebase/firestore'],
        },
      },
    },
  },
});
