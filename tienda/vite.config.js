import { defineConfig } from 'vite';

export default defineConfig({
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
