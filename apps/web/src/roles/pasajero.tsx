import type { ModuloRol } from './index';
import { InicioRol } from './InicioRol';

export const pasajero: ModuloRol = {
  roles: ['pasajero'],
  base: '/pasajero',
  titulo: 'Pasajero',
  menu: [{ ruta: '/pasajero', texto: 'Inicio' }],
  rutas: [
    {
      index: true,
      element: <InicioRol titulo="Pasajero" descripcion="Acá van a estar estimar, pedir un viaje, seguirlo en vivo y el historial." />,
    },
  ],
};
