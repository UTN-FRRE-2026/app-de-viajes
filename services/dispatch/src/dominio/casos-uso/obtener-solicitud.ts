import type { DatosCobro, DatosSolicitud } from '../entidades/index.js';
import { SolicitudNoEncontrada } from '../errores/index.js';
import type { DependenciasDespacho } from './dependencias.js';

export interface Entrada {
  solicitudId: string;
  usuarioId: string;
  /** Operador y admin ven cualquier solicitud. */
  veTodas: boolean;
}

/** El detalle de un viaje trae su cobro: null hasta que se completa. */
export interface DetalleSolicitud extends DatosSolicitud {
  cobro: DatosCobro | null;
}

export function obtenerSolicitud(deps: DependenciasDespacho) {
  return async ({ solicitudId, usuarioId, veTodas }: Entrada): Promise<DetalleSolicitud> => {
    const solicitud = await deps.repo.obtenerSolicitud(solicitudId);
    const esParte = solicitud && (solicitud.pasajeroId === usuarioId || solicitud.choferId === usuarioId);
    if (!solicitud || (!esParte && !veTodas)) throw new SolicitudNoEncontrada();
    const cobro = solicitud.estado === 'COMPLETADA' ? await deps.repo.obtenerCobro(solicitudId) : null;
    return { ...solicitud.aDatos(), cobro: cobro?.aDatos() ?? null };
  };
}
