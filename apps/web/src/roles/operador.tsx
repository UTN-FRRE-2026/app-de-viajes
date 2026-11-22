import type { ModuloRol } from './index';
import { InicioRol } from './InicioRol';

/** El admin de la plataforma usa las mismas pantallas que el operador (y las suyas, cuando estén). */
export const operador: ModuloRol = {
  roles: ['operador', 'admin'],
  base: '/operador',
  titulo: 'Operador',
  menu: [{ ruta: '/operador', texto: 'Inicio' }],
  rutas: [
    {
      index: true,
      element: <InicioRol titulo="Operador" descripcion="Acá van a estar los viajes en curso y la cancelación con motivo." />,
    },
  ],
};
