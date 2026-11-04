import { normalizarEmail, type UsuarioPublico } from '../entidades/index.js';
import { CredencialesInvalidas } from '../errores/index.js';
import type { TokenEmitido } from '../puertos/index.js';
import type { DependenciasIdentidad } from './dependencias.js';

export interface EntradaLogin {
  email: string;
  contrasena: string;
}

export interface Sesion extends TokenEmitido {
  usuario: UsuarioPublico;
}

export function iniciarSesion(deps: DependenciasIdentidad) {
  return async ({ email, contrasena }: EntradaLogin): Promise<Sesion> => {
    const usuario = await deps.repo.buscarPorEmail(normalizarEmail(email));
    if (!usuario) {
      await deps.hasher.simularVerificacion(contrasena);
      throw new CredencialesInvalidas();
    }
    if (!(await deps.hasher.verificar(usuario.hashContrasena, contrasena))) throw new CredencialesInvalidas();

    const token = await deps.emisor.emitir({
      sub: usuario.id,
      rol: usuario.rol,
      // Solo `admin_flota` tiene flota: el resto de los tokens no lleva el claim.
      ...(usuario.fleetId ? { fleetId: usuario.fleetId } : {}),
    });
    return { ...token, usuario: usuario.aPublico() };
  };
}
