import type { Usuario, UsuarioPublico } from '../entidades/index.js';
import type { SecretoRefresh, TokenEmitido } from '../puertos/index.js';
import type { DependenciasIdentidad } from './dependencias.js';

export interface Sesion extends TokenEmitido {
  refreshToken: string;
  refreshExpiraEnSegundos: number;
  usuario: UsuarioPublico;
}

export function vencimientoRefresh(deps: DependenciasIdentidad, desde: Date): Date {
  return new Date(desde.getTime() + deps.refreshTtlSegundos * 1000);
}

/** Los claims salen siempre del usuario guardado: en un refresh se toma el rol actual, no el del login. */
export async function armarSesion(deps: DependenciasIdentidad, usuario: Usuario, refresh: SecretoRefresh): Promise<Sesion> {
  const token = await deps.emisor.emitir({
    sub: usuario.id,
    rol: usuario.rol,
    // Solo `admin_flota` tiene flota: el resto de los tokens no lleva el claim.
    ...(usuario.fleetId ? { fleetId: usuario.fleetId } : {}),
  });
  return {
    ...token,
    refreshToken: refresh.token,
    refreshExpiraEnSegundos: deps.refreshTtlSegundos,
    usuario: usuario.aPublico(),
  };
}
