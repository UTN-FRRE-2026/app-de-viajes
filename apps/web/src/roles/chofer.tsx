import type { ModuloRol } from './index';
import { PanelChofer } from './chofer/Panel';

export const chofer: ModuloRol = {
  roles: ['chofer'],
  base: '/chofer',
  titulo: 'Chofer',
  menu: [{ ruta: '/chofer', texto: 'Viajes' }],
  rutas: [{ index: true, element: <PanelChofer /> }],
};
