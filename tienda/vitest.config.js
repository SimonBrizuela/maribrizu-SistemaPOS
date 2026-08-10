import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['pruebas/**/*.test.js'],
    // El navegador aporta localStorage y fetch; en Node hay que ponerlos a mano.
    // Se hace con un archivo de arranque en vez de con jsdom entero: lo unico
    // del navegador que usa esta capa es el almacenamiento del carrito.
    setupFiles: ['pruebas/arranque.js'],
    environment: 'node',
  },
});
