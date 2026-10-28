import { SolicitudViaje, type Coordenada, type DatosSolicitud } from '../entidades/index.js';
import { SolicitudActivaExistente } from '../errores/index.js';
import type { DependenciasDespacho } from './dependencias.js';
import { ofrecerACandidatos } from './ofrecer.js';

export interface Entrada {
  pasajeroId: string;
  origen: Coordenada;
  destino: Coordenada;
}

export function crearSolicitud(deps: DependenciasDespacho) {
  return async ({ pasajeroId, origen, destino }: Entrada): Promise<DatosSolicitud> => {
    // La búsqueda va FUERA de la transacción: no tiene sentido tener una transacción
    // abierta mientras esperamos a otro servicio.
    const candidatos = await deps.buscador.buscar(origen, { excluir: [], limite: deps.parametros.ofertasSimultaneas });
    const solicitud = SolicitudViaje.nueva(deps.ids.nuevo(), pasajeroId, origen, destino);

    return deps.repo.enTransaccion(async (tx) => {
      if (!(await tx.insertarSolicitud(solicitud))) throw new SolicitudActivaExistente();
      await tx.registrarEvento({
        tipo: 'RideRequested',
        payload: { solicitudId: solicitud.id, pasajeroId, origen, destino },
      });
      await ofrecerACandidatos(tx, solicitud, candidatos, deps);
      return solicitud.aDatos();
    });
  };
}
