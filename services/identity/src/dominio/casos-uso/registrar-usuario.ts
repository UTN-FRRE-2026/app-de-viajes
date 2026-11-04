import { exigirRolRegistrable, Usuario, type UsuarioPublico } from '../entidades/index.js';
import { IdentificadorEnUso } from '../errores/index.js';
import type { DependenciasIdentidad } from './dependencias.js';

export interface EntradaRegistro {
  email: string;
  contrasena: string;
  nombre: string;
  /** `string` a propósito: el dominio no confía en que el adaptador ya lo filtró. */
  rol: string;
}

export function registrarUsuario(deps: DependenciasIdentidad) {
  return async ({ email, contrasena, nombre, rol }: EntradaRegistro): Promise<UsuarioPublico> => {
    // Antes de hashear: un rol prohibido no debe costar CPU.
    exigirRolRegistrable(rol);
    const hashContrasena = await deps.hasher.hashear(contrasena);
    const usuario = Usuario.registrar({
      id: deps.ids.nuevo(),
      email,
      hashContrasena,
      nombre,
      rol,
      creadoEn: deps.reloj.ahora(),
    });
    if (!(await deps.repo.insertar(usuario))) throw new IdentificadorEnUso();
    return usuario.aPublico();
  };
}
