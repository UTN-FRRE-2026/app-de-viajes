import { SolicitudViaje, type Coordenada, type DatosSolicitud } from '../entidades/index.js';
import { OrigenFueraDeZona, SolicitudActivaExistente } from '../errores/index.js';
import { buscarAptos } from './buscar-aptos.js';
import type { DependenciasDespacho } from './dependencias.js';
import { estimarTarifa } from './estimar-tarifa.js';
import { ofrecerACandidatos } from './ofrecer.js';

export interface Entrada {
  pasajeroId: string;
  origen: Coordenada;
  destino: Coordenada;
}

export function crearSolicitud(deps: DependenciasDespacho) {
  const estimar = estimarTarifa(deps);
  return async ({ pasajeroId, origen, destino }: Entrada): Promise<DatosSolicitud> => {
    // El tiempo hasta la asignación se mide desde acá: incluye la estimación y la búsqueda en location.
    const creadaEn = deps.reloj.ahora();
    // La zona del origen, una vez por solicitud. Fuera de toda zona no opera ninguna flota: 422 y no
    // se crea nada (antes de estimar y de buscar, así no se gasta ninguna consulta externa).
    const zonaId = await deps.elegibilidad.zonaDelOrigen(origen);
    if (!zonaId) throw new OrigenFueraDeZona();
    // La misma estimación que GET /tarifas/estimacion: un recorrido fuera de rango da 422 y, si mapas
    // no responde, 503. En los dos casos no se crea nada (falla cerrado: no hay viaje sin precio).
    const estimacion = await estimar({ origen, destino });
    // La búsqueda va FUERA de la transacción: no tiene sentido tener una transacción
    // abierta mientras esperamos a otro servicio. Solo quedan los aptos de esta zona.
    const { aptos: candidatos } = await buscarAptos(deps, origen, zonaId, []);
    const solicitud = SolicitudViaje.nueva(
      deps.ids.nuevo(),
      pasajeroId,
      origen,
      destino,
      creadaEn,
      {
        version: estimacion.tarifaVersion,
        moneda: estimacion.moneda,
        centavos: estimacion.tarifaCentavos,
        recorrido: { metros: estimacion.distanciaMetros, segundos: estimacion.duracionSegundos },
      },
      zonaId,
    );

    const datos = await deps.repo.enTransaccion(async (tx) => {
      if (!(await tx.insertarSolicitud(solicitud))) throw new SolicitudActivaExistente();
      await tx.registrarEvento({
        tipo: 'RideRequested',
        payload: { solicitudId: solicitud.id, pasajeroId, origen, destino },
      });
      await ofrecerACandidatos(tx, solicitud, candidatos, deps);
      return solicitud.aDatos();
    });
    deps.metricas?.solicitudCreada(datos.estado === 'SIN_CHOFERES' ? 'sin_choferes' : 'con_ofertas');
    return datos;
  };
}
