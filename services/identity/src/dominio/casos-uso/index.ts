import type { DependenciasIdentidad } from './dependencias.js';
import { iniciarSesion } from './iniciar-sesion.js';
import { registrarUsuario } from './registrar-usuario.js';
import { renovarSesion } from './renovar-sesion.js';

export type { DependenciasIdentidad } from './dependencias.js';
export type { Sesion } from './sesion.js';

export function crearCasosDeUso(deps: DependenciasIdentidad) {
  return {
    registrarUsuario: registrarUsuario(deps),
    iniciarSesion: iniciarSesion(deps),
    renovarSesion: renovarSesion(deps),
    clavesPublicas: () => deps.emisor.clavesPublicas(),
  };
}

export type CasosDeUso = ReturnType<typeof crearCasosDeUso>;
