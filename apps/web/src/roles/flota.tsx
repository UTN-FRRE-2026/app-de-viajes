import type { ModuloRol } from './index';
import { PanelFlota } from './flota/Panel';

export const flota: ModuloRol = {
  roles: ['admin_flota'],
  base: '/flota',
  titulo: 'Admin de flota',
  menu: [{ ruta: '/flota', texto: 'Choferes' }],
  rutas: [{ index: true, element: <PanelFlota /> }],
};
