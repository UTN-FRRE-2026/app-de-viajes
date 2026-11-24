import { lazy, Suspense } from 'react';
import type { ModuloRol } from './index';
import { HistorialPasajero } from './pasajero/Historial';

// Leaflet (el mapa) solo lo usa el pasajero: va en su propio archivo y se baja al entrar.
const PanelPasajero = lazy(() => import('./pasajero/Panel').then((m) => ({ default: m.PanelPasajero })));

export const pasajero: ModuloRol = {
  roles: ['pasajero'],
  base: '/pasajero',
  titulo: 'Pasajero',
  menu: [
    { ruta: '/pasajero', texto: 'Mi viaje' },
    { ruta: '/pasajero/historial', texto: 'Historial' },
  ],
  rutas: [
    {
      index: true,
      element: (
        <Suspense fallback={<p className="cargando">Cargando…</p>}>
          <PanelPasajero />
        </Suspense>
      ),
    },
    { path: 'historial', element: <HistorialPasajero /> },
  ],
};
