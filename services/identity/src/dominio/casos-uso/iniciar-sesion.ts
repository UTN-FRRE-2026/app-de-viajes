import { normalizarEmail } from '../entidades/index.js';
import { CredencialesInvalidas } from '../errores/index.js';
import type { DependenciasIdentidad } from './dependencias.js';
import { armarSesion, vencimientoRefresh, type Sesion } from './sesion.js';

export interface EntradaLogin {
  email: string;
  contrasena: string;
}

export function iniciarSesion(deps: DependenciasIdentidad) {
  return async ({ email, contrasena }: EntradaLogin): Promise<Sesion> => {
    const usuario = await deps.repo.buscarPorEmail(normalizarEmail(email));
    if (!usuario) {
      await deps.hasher.simularVerificacion(contrasena);
      throw new CredencialesInvalidas();
    }
    if (!(await deps.hasher.verificar(usuario.hashContrasena, contrasena))) throw new CredencialesInvalidas();

    // Cada login abre una familia nueva: las sesiones de otros dispositivos no se tocan.
    const ahora = deps.reloj.ahora();
    const refresh = deps.refresh.nuevo();
    await deps.sesiones.crear({
      huella: refresh.huella,
      usuarioId: usuario.id,
      familiaId: deps.ids.nuevo(),
      creadoEn: ahora,
      expiraEn: vencimientoRefresh(deps, ahora),
    });
    return armarSesion(deps, usuario, refresh);
  };
}
