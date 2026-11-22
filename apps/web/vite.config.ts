import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

/**
 * En desarrollo (`npm run dev:web`), el mismo enrutamiento que nginx (infra/web/default.conf): el
 * código usa siempre rutas relativas `/api/...`, igual en desarrollo que en el contenedor.
 */
const servicio = (prefijo: string, puerto: number): ProxyOptions => ({
  target: `http://127.0.0.1:${puerto}`,
  rewrite: (ruta) => ruta.replace(new RegExp(`^/api/${prefijo}`), ''),
});

export default defineConfig({
  plugins: [react()],
  build: {
    // Nada embebido como `data:`: la CSP solo lo permite en img-src, no en fuentes ni en scripts.
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api/identity': servicio('identity', 3001),
      '/api/viajes': servicio('viajes', 3005),
      '/api/ubicacion': servicio('ubicacion', 3004),
    },
  },
});
