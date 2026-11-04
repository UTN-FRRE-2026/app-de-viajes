import type { DependenciasIdentidad } from './dependencias.js';
import { iniciarSesion } from './iniciar-sesion.js';
import { registrarUsuario } from './registrar-usuario.js';

export type { DependenciasIdentidad } from './dependencias.js';
export type { Sesion } from './iniciar-sesion.js';

export function crearCasosDeUso(deps: DependenciasIdentidad) {
  return {
    registrarUsuario: registrarUsuario(deps),
    iniciarSesion: iniciarSesion(deps),
    clavesPublicas: () => deps.emisor.clavesPublicas(),
  };
}

export type CasosDeUso = ReturnType<typeof crearCasosDeUso>;
