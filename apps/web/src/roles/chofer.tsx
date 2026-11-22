import type { ModuloRol } from './index';
import { InicioRol } from './InicioRol';

export const chofer: ModuloRol = {
  roles: ['chofer'],
  base: '/chofer',
  titulo: 'Chofer',
  menu: [{ ruta: '/chofer', texto: 'Inicio' }],
  rutas: [
    {
      index: true,
      element: <InicioRol titulo="Chofer" descripcion="Acá van a estar la disponibilidad, las ofertas y los estados del viaje." />,
    },
  ],
};
