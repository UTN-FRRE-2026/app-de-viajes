import type { DatosSolicitud } from '../entidades/index.js';
import { ChoferConViajeActivo, OfertaNoEncontrada, SolicitudNoEncontrada } from '../errores/index.js';
import type { DependenciasDespacho } from './dependencias.js';

export interface Entrada {
  ofertaId: string;
  /** Sale del token, nunca del body. */
  choferId: string;
}

/**
 * Problema 6.3: exactamente un chofer gana la solicitud y un chofer nunca queda con dos viajes.
 *
 * 1. Lock de la solicitud (FOR UPDATE): las aceptaciones de una misma solicitud se ejecutan
 *    de a una. La segunda ve ASIGNADO y recibe 409.
 * 2. Reserva del chofer contra una restricción única: si el mismo chofer acepta dos solicitudes
 *    distintas a la vez (dos locks distintos, no se esperan), la base deja pasar solo una.
 * Orden fijo: siempre solicitud → chofer. El chofer no es un lock de fila, así que no hay ciclo posible.
 */
export function aceptarOferta(deps: DependenciasDespacho) {
  return async ({ ofertaId, choferId }: Entrada): Promise<DatosSolicitud> => {
    // Lectura previa sin lock, solo para saber qué solicitud bloquear (request_id no cambia nunca).
    const previa = await deps.repo.obtenerOferta(ofertaId);
    if (!previa || previa.choferId !== choferId) throw new OfertaNoEncontrada();

    return deps.repo.enTransaccion(async (tx) => {
      const solicitud = await tx.obtenerSolicitudParaActualizar(previa.solicitudId);
      if (!solicitud) throw new SolicitudNoEncontrada();

      // Releer DESPUÉS del lock: mientras esperábamos, otra transacción pudo cancelarla o vencerla.
      const ofertas = await tx.ofertasDeSolicitud(solicitud.id);
      const oferta = ofertas.find((o) => o.id === ofertaId);
      if (!oferta) throw new OfertaNoEncontrada();

      const ahora = deps.reloj.ahora();
      // Primero el estado de la solicitud: si otro ganó, el error correcto es "no disponible",
      // no "oferta vencida" (que también sería cierto, porque su aceptación canceló esta oferta).
      solicitud.asignar(choferId);
      oferta.aceptar(ahora);

      if (!(await tx.reservarChofer(choferId, solicitud.id))) throw new ChoferConViajeActivo();

      const otras = ofertas.filter((o) => o.id !== oferta.id && o.cancelarSiPendiente());
      await tx.guardarSolicitud(solicitud);
      await tx.guardarOfertas([oferta, ...otras]);
      await tx.registrarEvento({
        tipo: 'TripAssigned',
        payload: {
          solicitudId: solicitud.id,
          pasajeroId: solicitud.pasajeroId,
          choferId,
          origen: solicitud.origen,
          destino: solicitud.destino,
        },
      });
      return solicitud.aDatos();
    });
  };
}
