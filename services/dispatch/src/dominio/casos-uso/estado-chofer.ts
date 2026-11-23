import { ESTADOS_CON_CHOFER, type Coordenada, type DatosSolicitud } from '../entidades/index.js';
import type { DependenciasDespacho } from './dependencias.js';

/** Una oferta que el chofer todavía puede aceptar, con lo que necesita para decidir. */
export interface OfertaParaChofer {
  ofertaId: string;
  solicitudId: string;
  venceEn: Date;
  origen: Coordenada;
  destino: Coordenada;
  tarifaEstimadaCentavos: number | null;
}

export interface SituacionChofer {
  /** La hora del servidor: el cliente cuenta el vencimiento de las ofertas con este reloj. */
  ahora: Date;
  viaje: DatosSolicitud | null;
  ofertas: OfertaParaChofer[];
}

/**
 * Lo que la pantalla del chofer relee al abrir, al reconectar el SSE y con cada evento: su viaje activo
 * y sus ofertas pendientes. La base es la fuente de verdad; los eventos solo avisan que algo cambió.
 *
 * - El viaje sale de la asignación activa (una fila por chofer). Entre esa lectura y la de la solicitud
 *   el viaje pudo terminar: se vuelve a revisar el estado sobre la solicitud leída.
 * - Con un viaje activo no hay ofertas que mostrar: aceptar otra daría `CHOFER_CON_VIAJE_ACTIVO`.
 */
export function situacionChofer(deps: DependenciasDespacho) {
  return async (choferId: string): Promise<SituacionChofer> => {
    const ahora = deps.reloj.ahora();
    const [activo, pendientes] = await Promise.all([
      deps.repo.viajeConPasajeroDelChofer(choferId),
      deps.repo.ofertasPendientesDelChofer(choferId, ahora),
    ]);
    const solicitud = activo ? await deps.repo.obtenerSolicitud(activo.solicitudId) : null;
    const viaje =
      solicitud && solicitud.choferId === choferId && ESTADOS_CON_CHOFER.includes(solicitud.estado) ? solicitud.aDatos() : null;
    if (viaje) return { ahora, viaje, ofertas: [] };

    const ofertas = pendientes.map(({ oferta, solicitud: s }) => {
      const datos = s.aDatos();
      return {
        ofertaId: oferta.id,
        solicitudId: oferta.solicitudId,
        venceEn: oferta.venceEn,
        origen: datos.origen,
        destino: datos.destino,
        tarifaEstimadaCentavos: datos.tarifa?.estimadaCentavos ?? null,
      };
    });
    return { ahora, viaje: null, ofertas };
  };
}
