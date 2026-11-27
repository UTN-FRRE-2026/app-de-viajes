import type { ModuloRol } from './index';
import { PanelHabilitacion } from './admin/Panel';
import { PanelOperador } from './operador/Panel';
import { RequiereRol } from '../sesion/guardias';

/**
 * El admin de la plataforma usa las mismas pantallas que el operador y, además, las suyas: la
 * habilitación de choferes (`/operador/choferes`), que el operador no ve en el menú ni puede abrir.
 */
export const operador: ModuloRol = {
  roles: ['operador', 'admin'],
  base: '/operador',
  titulo: 'Operador',
  menu: [
    { ruta: '/operador', texto: 'Panel' },
    { ruta: '/operador/choferes', texto: 'Choferes', roles: ['admin'] },
  ],
  rutas: [
    { index: true, element: <PanelOperador /> },
    { path: 'choferes', element: <RequiereRol roles={['admin']} />, children: [{ index: true, element: <PanelHabilitacion /> }] },
  ],
};
