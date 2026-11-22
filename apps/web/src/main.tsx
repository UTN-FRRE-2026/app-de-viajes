import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { recuperarSesion } from './api/cliente';
import { router } from './router';
import './estilos.css';

// Si quedó una sesión guardada, se recupera antes de que las rutas protegidas decidan (estado `cargando`).
void recuperarSesion();

const raiz = document.getElementById('raiz');
if (!raiz) throw new Error('falta #raiz en index.html');
createRoot(raiz).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
