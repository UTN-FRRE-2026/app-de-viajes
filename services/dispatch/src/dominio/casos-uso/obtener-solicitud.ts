import type { DatosSolicitud } from '../entidades/index.js';
import { SolicitudNoEncontrada } from '../errores/index.js';
import type { DependenciasDespacho } from './dependencias.js';

export interface Entrada {
  solicitudId: string;
  usuarioId: string;
  /** Operador y admin ven cualquier solicitud. */
  veTodas: boolean;
}

export function obtenerSolicitud(deps: DependenciasDespacho) {
  return async ({ solicitudId, usuarioId, veTodas }: Entrada): Promise<DatosSolicitud> => {
    const solicitud = await deps.repo.obtenerSolicitud(solicitudId);
    const esParte = solicitud && (solicitud.pasajeroId === usuarioId || solicitud.choferId === usuarioId);
    if (!solicitud || (!esParte && !veTodas)) throw new SolicitudNoEncontrada();
    return solicitud.aDatos();
  };
}
