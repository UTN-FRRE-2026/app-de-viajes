import { Cobro, type DatosSolicitud, type SolicitudViaje } from '../entidades/index.js';
import { SolicitudNoEncontrada } from '../errores/index.js';
import type { EventoDispatch, TransaccionDespacho } from '../puertos/index.js';
import type { ParametrosTarifa } from '../tarifas/parametros.js';
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
function accionDelChofer(deps: DependenciasDespacho, { solicitudId, choferId }: Entrada, paso: Paso): Promise<DatosSolicitud> {
  return deps.repo.enTransaccion(async (tx) => {
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
  return (entrada: Entrada) =>
    accionDelChofer(deps, entrada, async (s) => {
      s.marcarEnCamino();
      return { tipo: 'DriverEnRoute', payload: partes(s) };
    });
}

/** EN_CAMINO → EN_CURSO. Guarda cuándo empezó: de ahí sale la duración real para la tarifa final. */
export function iniciarViaje(deps: DependenciasDespacho) {
  return (entrada: Entrada) =>
    accionDelChofer(deps, entrada, async (s) => {
      s.iniciar(deps.reloj.ahora());
      return { tipo: 'TripStarted', payload: partes(s) };
    });
}

/**
 * EN_CURSO → COMPLETADA, todo en la MISMA transacción:
 * - la tarifa final (con la versión de la estimación) y por qué difiere de la estimada;
 * - el chofer queda libre;
 * - el cobro, PENDIENTE: lo procesa el barrido o `POST /solicitudes/:id/cobrar`, nunca dentro de esta
 *   transacción, para no tener el lock tomado mientras se espera al proveedor de pagos.
 * Si algo falla, no queda nada a medias. Una segunda finalización (doble clic, reintento sin la
 * misma Idempotency-Key) ve COMPLETADA y recibe 409: no hay segundo cobro.
 */
export function finalizarViaje(deps: DependenciasDespacho) {
  return async (entrada: Entrada): Promise<DatosSolicitud> => {
    // La versión de la tarifa de un viaje no cambia nunca: se lee antes, sin lock, para no buscar los
    // parámetros (Redis o Postgres) con la solicitud bloqueada.
    const previa = await deps.repo.obtenerSolicitud(entrada.solicitudId);
    let parametros: ParametrosTarifa | null = null;
    if (previa?.tarifa) {
      parametros = await deps.tarifas.porVersion(previa.tarifa.version);
      if (!parametros) throw new Error(`tarifas: no existe la versión ${previa.tarifa.version} de la estimación`);
    }

    return accionDelChofer(deps, entrada, async (s, tx) => {
      s.finalizar(deps.reloj.ahora(), parametros);
      await tx.liberarChofer(s.id);
      const final = s.tarifa?.finalCentavos ?? null;
      if (final !== null) await tx.insertarCobro(Cobro.nuevo(deps.ids.nuevo(), s.id, s.pasajeroId, final));
      return { tipo: 'RideCompleted', payload: { ...partes(s), tarifaFinalCentavos: final } };
    });
  };
}
