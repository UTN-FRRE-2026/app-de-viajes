import { SolicitudNoEncontrada } from '../errores/index.js';
import type { DependenciasDespacho } from './dependencias.js';

/**
 * Se llama cuando trips avisa que el viaje terminó (TripFinished / TripCancelled).
 * Idempotente: los eventos llegan at-least-once, así que el segundo aviso no hace nada.
 */
export function liberarChofer(deps: DependenciasDespacho) {
  return async ({ solicitudId }: { solicitudId: string }): Promise<{ liberado: boolean }> =>
    deps.repo.enTransaccion(async (tx) => {
      const solicitud = await tx.obtenerSolicitudParaActualizar(solicitudId);
      if (!solicitud) throw new SolicitudNoEncontrada();
      if (solicitud.estado !== 'ASIGNADO' || !solicitud.choferId) return { liberado: false };

      const choferId = solicitud.choferId;
      solicitud.completar();
      await tx.liberarChofer(solicitud.id);
      await tx.guardarSolicitud(solicitud);
      await tx.registrarEvento({ tipo: 'RideCompleted', payload: { solicitudId, choferId } });
      return { liberado: true };
    });
}
