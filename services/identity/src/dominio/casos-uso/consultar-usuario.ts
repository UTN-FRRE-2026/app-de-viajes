import { UsuarioNoEncontrado } from '../errores/index.js';
import type { Rol } from '../entidades/index.js';
import type { DependenciasIdentidad } from './dependencias.js';

/**
 * Para otros servicios (ruta interna): el id y el rol de una cuenta, nada más. Así dispatch puede
 * comprobar que un `choferId` es de verdad una cuenta de chofer sin conocer la base de identity.
 */
export function consultarUsuario({ repo }: DependenciasIdentidad) {
  return async (id: string): Promise<{ id: string; rol: Rol }> => {
    const usuario = await repo.buscarPorId(id);
    if (!usuario) throw new UsuarioNoEncontrado();
    return { id: usuario.id, rol: usuario.rol };
  };
}
