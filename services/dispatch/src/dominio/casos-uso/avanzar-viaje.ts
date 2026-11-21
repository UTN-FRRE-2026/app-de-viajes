import type { DatosSolicitud, SolicitudViaje } from '../entidades/index.js';
import { SolicitudNoEncontrada } from '../errores/index.js';
import type { EventoDispatch, TransaccionDespacho } from '../puertos/index.js';
import type { DependenciasDespacho } from './dependencias.js';

export interface Entrada {
  solicitudId: string;
  /** Sale del token, nunca del body. */
  choferId: string;
}

type Paso = (solicitud: SolicitudViaje, tx: TransaccionDespacho) => Promise<EventoDispatch>;

/**
 * Las tres acciones del chofer (en camino, iniciar, finalizar) siguen el mismo molde:
 * lock de la solicitud, solo el chofer asignado, transición en la entidad y evento en el outbox.
 * Como toman el mismo lock que la cancelación, dos acciones sobre el mismo viaje nunca se pisan:
 * la segunda ve el estado nuevo y recibe 409.
 */
function accionDelChofer(deps: DependenciasDespacho, paso: Paso) {
  return async ({ solicitudId, choferId }: Entrada): Promise<DatosSolicitud> =>
    deps.repo.enTransaccion(async (tx) => {
      const solicitud = await tx.obtenerSolicitudParaActualizar(solicitudId);
      // El viaje de otro chofer responde igual que uno inexistente.
      if (!solicitud || solicitud.choferId !== choferId) throw new SolicitudNoEncontrada();
      const evento = await paso(solicitud, tx);
      await tx.guardarSolicitud(solicitud);
      await tx.registrarEvento(evento);
      return solicitud.aDatos();
    });
}

const partes = (s: SolicitudViaje) => ({ solicitudId: s.id, pasajeroId: s.pasajeroId, choferId: s.choferId as string });

/** ASIGNADO → EN_CAMINO */
export function marcarEnCamino(deps: DependenciasDespacho) {
  return accionDelChofer(deps, async (s) => {
    s.marcarEnCamino();
    return { tipo: 'DriverEnRoute', payload: partes(s) };
  });
}

/** EN_CAMINO → EN_CURSO */
export function iniciarViaje(deps: DependenciasDespacho) {
  return accionDelChofer(deps, async (s) => {
    s.iniciar();
    return { tipo: 'TripStarted', payload: partes(s) };
  });
}

/**
 * EN_CURSO → COMPLETADA. Libera al chofer en la MISMA transacción: si algo falla, el viaje
 * no queda completado con el chofer bloqueado, ni el chofer libre con el viaje en curso.
 * Una segunda finalización (doble clic, reintento) ve COMPLETADA y recibe 409: no hay doble efecto.
 */
export function finalizarViaje(deps: DependenciasDespacho) {
  return accionDelChofer(deps, async (s, tx) => {
    s.finalizar();
    await tx.liberarChofer(s.id);
    return { tipo: 'RideCompleted', payload: partes(s) };
  });
}
