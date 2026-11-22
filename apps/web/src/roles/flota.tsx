import type { ModuloRol } from './index';
import { InicioRol } from './InicioRol';

export const flota: ModuloRol = {
  roles: ['admin_flota'],
  base: '/flota',
  titulo: 'Admin de flota',
  menu: [{ ruta: '/flota', texto: 'Inicio' }],
  rutas: [
    {
      index: true,
      element: <InicioRol titulo="Admin de flota" descripcion="Acá van a estar los choferes de la flota, activarlos hasta el límite y el reporte." />,
    },
  ],
};
