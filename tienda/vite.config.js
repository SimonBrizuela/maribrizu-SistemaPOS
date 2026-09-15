import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { funcionesEnDesarrollo } from './netlify/dev.js';

// La pantalla del repartidor es una página aparte (`reparto.html`) que se abre
// en /reparto. En Netlify lo resuelve una regla de netlify.toml; en desarrollo,
// esto.
function rutaDelReparto() {
  return {
    name: 'ruta-del-reparto',
    configureServer(servidor) {
      servidor.middlewares.use((peticion, _respuesta, siguiente) => {
        if (/^\/reparto\/?(\?|$)/.test(peticion.url || '')) {
          peticion.url = peticion.url.replace(/^\/reparto\/?/, '/reparto.html');
        }
        siguiente();
      });
    },
  };
}

export default defineConfig({
  // En desarrollo las funciones de Netlify corren adentro de este servidor. Sin
  // eso el checkout no se puede probar: sin funciones no hay autocompletado de
  // direcciones ni cotización de envío, que es casi toda esa pantalla.
  plugins: [funcionesEnDesarrollo(), rutaDelReparto()],

  server: {
    port: 5180,
    open: true,
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        tienda: fileURLToPath(new URL('./index.html', import.meta.url)),
        reparto: fileURLToPath(new URL('./reparto.html', import.meta.url)),
      },
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
