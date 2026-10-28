import type { DatosSolicitud } from '../entidades/index.js';
import { SolicitudNoEncontrada } from '../errores/index.js';
import type { DependenciasDespacho } from './dependencias.js';

export interface Entrada {
  solicitudId: string;
  pasajeroId: string;
}

/**
 * Toma el MISMO lock que aceptarOferta, así que nunca corren a la vez sobre la misma solicitud:
 * - si gana la cancelación, la aceptación encuentra CANCELADO_PASAJERO y recibe 409;
 * - si gana la aceptación, esto cancela un viaje asignado y libera al chofer en la misma transacción.
 */
export function cancelarSolicitud(deps: DependenciasDespacho) {
  return async ({ solicitudId, pasajeroId }: Entrada): Promise<DatosSolicitud> =>
    deps.repo.enTransaccion(async (tx) => {
      const solicitud = await tx.obtenerSolicitudParaActualizar(solicitudId);
      // La solicitud de otro pasajero responde igual que una inexistente.
      if (!solicitud || solicitud.pasajeroId !== pasajeroId) throw new SolicitudNoEncontrada();

      const { estabaAsignada, choferLiberado } = solicitud.cancelarPorPasajero();
      const canceladas = (await tx.ofertasDeSolicitud(solicitud.id)).filter((o) => o.cancelarSiPendiente());

      if (estabaAsignada) await tx.liberarChofer(solicitud.id);
      await tx.guardarSolicitud(solicitud);
      await tx.guardarOfertas(canceladas);
      await tx.registrarEvento({
        tipo: 'RideCancelled',
        payload: { solicitudId: solicitud.id, pasajeroId, choferId: choferLiberado, estabaAsignada },
      });
      return solicitud.aDatos();
    });
}
