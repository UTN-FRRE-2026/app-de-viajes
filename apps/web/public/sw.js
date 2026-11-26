// El service worker de Viajes (PWA). Hace que la app se pueda instalar y que abra aunque la red tarde,
// sin guardar nunca nada de la API:
// - /api/* (incluido el tiempo real por SSE) y todo lo de otro origen (las teselas de OpenStreetMap)
//   van siempre a la red: no pasan por acá.
// - /assets/* tiene el hash en el nombre y no cambia nunca: primero el caché.
// - Las páginas, primero la red; sin red, la última copia de la app (la SPA arma la ruta sola).
// Cambiar VERSION descarta los cachés viejos al activarse.
const VERSION = 'viajes-v1';
const ARMAZON = ['/', '/manifest.json', '/icono.svg', '/icono-192.png'];

self.addEventListener('install', (evento) => {
  evento.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(ARMAZON)));
  self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches
      .keys()
      .then((claves) => Promise.all(claves.filter((c) => c !== VERSION).map((c) => caches.delete(c))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (evento) => {
  const pedido = evento.request;
  const url = new URL(pedido.url);
  if (pedido.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/assets/')) {
    evento.respondWith(
      caches.match(pedido).then(
        (guardada) =>
          guardada ??
          fetch(pedido).then((respuesta) => {
            if (respuesta.ok) {
              const copia = respuesta.clone();
              void caches.open(VERSION).then((cache) => cache.put(pedido, copia));
            }
            return respuesta;
          }),
      ),
    );
    return;
  }

  if (pedido.mode === 'navigate') {
    evento.respondWith(
      fetch(pedido)
        .then((respuesta) => {
          if (respuesta.ok) {
            const copia = respuesta.clone();
            void caches.open(VERSION).then((cache) => cache.put('/', copia));
          }
          return respuesta;
        })
        .catch(() => caches.match('/').then((guardada) => guardada ?? Response.error())),
    );
  }
});
