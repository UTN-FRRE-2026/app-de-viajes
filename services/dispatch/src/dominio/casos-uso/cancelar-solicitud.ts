import type { DatosSolicitud, QuienCancela, SolicitudViaje } from '../entidades/index.js';
import { SolicitudNoEncontrada } from '../errores/index.js';
import type { DependenciasDespacho } from './dependencias.js';

export interface Entrada {
  solicitudId: string;
  /** Sale del token, nunca del body. */
  usuarioId: string;
  quien: QuienCancela;
  motivo?: string | null;
}

/** El pasajero solo cancela lo suyo, el chofer solo el viaje que tiene asignado; el operador, cualquiera. */
function puedeVer(solicitud: SolicitudViaje, { usuarioId, quien }: Entrada): boolean {
  if (quien === 'pasajero') return solicitud.pasajeroId === usuarioId;
  if (quien === 'chofer') return solicitud.choferId === usuarioId;
  return true;
}

/**
 * Toma el MISMO lock que aceptarOferta y que los avances del chofer, así que nunca corren a la vez
 * sobre la misma solicitud:
 * - si gana la cancelación, la aceptación encuentra CANCELADO_* y recibe 409;
 * - si gana la aceptación, esto cancela un viaje asignado y libera al chofer en la misma transacción.
 */
export function cancelarSolicitud(deps: DependenciasDespacho) {
  return async (entrada: Entrada): Promise<DatosSolicitud> =>
    deps.repo.enTransaccion(async (tx) => {
      const solicitud = await tx.obtenerSolicitudParaActualizar(entrada.solicitudId);
      // La solicitud ajena responde igual que una inexistente.
      if (!solicitud || !puedeVer(solicitud, entrada)) throw new SolicitudNoEncontrada();

      const { estabaAsignada, choferLiberado } = solicitud.cancelar(entrada.quien, entrada.motivo ?? null);
      const canceladas = (await tx.ofertasDeSolicitud(solicitud.id)).filter((o) => o.cancelarSiPendiente());

      if (estabaAsignada) await tx.liberarChofer(solicitud.id);
      await tx.guardarSolicitud(solicitud);
      await tx.guardarOfertas(canceladas);
      await tx.registrarEvento({
        tipo: 'RideCancelled',
        payload: {
          solicitudId: solicitud.id,
          pasajeroId: solicitud.pasajeroId,
          choferId: choferLiberado,
          estabaAsignada,
          canceladoPor: entrada.quien,
          motivo: solicitud.motivoCancelacion,
        },
      });
      return solicitud.aDatos();
    });
}
