/*
 * Service worker de los avisos de la tienda.
 *
 * Recibe las notificaciones de cómo va el pedido (las manda la función
 * `avisar-estado` por Firebase Cloud Messaging) y las muestra aunque la tienda
 * esté cerrada. Tocar una abre ese pedido.
 *
 * Hace eso y nada más: no escucha `fetch` ni guarda nada en caché. Un service
 * worker que intercepta la navegación puede dejar a la tienda sirviendo una
 * versión vieja después de un despliegue, y para los avisos no hace falta.
 *
 * Va sin Firebase adentro: el mensaje trae datos y la notificación se arma
 * acá, así se controla que cada aviso del pedido reemplace al anterior.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', evento => evento.waitUntil(self.clients.claim()));

function datosDelAviso(evento) {
  try {
    const crudo = evento.data ? evento.data.json() : null;
    if (!crudo) return null;
    // FCM manda los datos envueltos en `data`; se aceptan también sueltos.
    const datos = crudo.data && typeof crudo.data === 'object' ? crudo.data : crudo;
    return datos && datos.titulo ? datos : null;
  } catch (_) {
    return null;
  }
}

/** Solo rutas de la tienda: un aviso nunca lleva a otro sitio. */
function destinoDe(url) {
  try {
    const destino = new URL(url || '/', self.location.origin);
    return destino.origin === self.location.origin ? destino.href : `${self.location.origin}/`;
  } catch (_) {
    return `${self.location.origin}/`;
  }
}

self.addEventListener('push', evento => {
  const datos = datosDelAviso(evento);
  if (!datos) return;

  evento.waitUntil((async () => {
    const destino = destinoDe(datos.url);
    // Quien ya está mirando su pedido lo ve cambiar en la pantalla: una
    // notificación encima sería avisarle lo que está leyendo.
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (ventanas.some(v => v.url === destino && v.focused)) return;

    await self.registration.showNotification(datos.titulo, {
      body: datos.cuerpo || '',
      icon: '/icono-192.png',
      badge: '/avisos/insignia.png',
      image: datos.imagen || undefined,
      // La misma etiqueta para todos los avisos de un pedido: el nuevo
      // reemplaza al anterior y vuelve a sonar.
      tag: datos.tag || undefined,
      renotify: Boolean(datos.tag),
      lang: 'es-AR',
      data: { url: datos.url || '/' },
    });
  })());
});

self.addEventListener('notificationclick', evento => {
  evento.notification.close();
  const destino = destinoDe(evento.notification.data && evento.notification.data.url);

  evento.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mismo = ventanas.find(v => v.url === destino);
    if (mismo) return mismo.focus();
    const tienda = ventanas.find(v => typeof v.navigate === 'function');
    if (tienda) {
      await tienda.navigate(destino);
      return tienda.focus();
    }
    return self.clients.openWindow(destino);
  })());
});
