import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { recuperarSesion } from './api/cliente';
import { router } from './router';
// Barlow, la grotesca de señalización, servida desde el mismo origen (la CSP no deja traer fuentes de
// afuera). Solo el subconjunto latino, que trae los acentos y la ñ.
import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';
import './estilos.css';

// Si quedó una sesión guardada, se recupera antes de que las rutas protegidas decidan (estado `cargando`).
void recuperarSesion();

// La PWA: el service worker (public/sw.js) solo en el build. En desarrollo guardaría módulos de Vite.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Sin service worker la app anda igual: solo no se instala ni abre sin red.
    });
  });
}

const raiz = document.getElementById('raiz');
if (!raiz) throw new Error('falta #raiz en index.html');
createRoot(raiz).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
