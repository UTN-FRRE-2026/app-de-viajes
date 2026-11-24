import type { ModuloRol } from './index';
import { PanelOperador } from './operador/Panel';

/** El admin de la plataforma usa las mismas pantallas que el operador (y las suyas, cuando estén). */
export const operador: ModuloRol = {
  roles: ['operador', 'admin'],
  base: '/operador',
  titulo: 'Operador',
  menu: [{ ruta: '/operador', texto: 'Panel' }],
  rutas: [{ index: true, element: <PanelOperador /> }],
};
