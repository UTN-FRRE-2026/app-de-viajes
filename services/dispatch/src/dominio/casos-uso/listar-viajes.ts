import { ESTADOS_ACTIVOS, type DatosSolicitud, type EstadoSolicitud, type SolicitudViaje } from '../entidades/index.js';
import type { FiltroSolicitudes, Pagina } from '../puertos/index.js';
import type { DependenciasDespacho } from './dependencias.js';

/** En los listados sí va la fecha del pedido: sin ella el historial no se puede leer. */
export interface ResumenViaje extends DatosSolicitud {
  creadaEn: string;
}

export interface Listado {
  viajes: ResumenViaje[];
  /** Valor de `desde` para pedir la página siguiente, o null si no hay más. */
  siguiente: number | null;
}

const resumen = (s: SolicitudViaje): ResumenViaje => ({ ...s.aDatos(), creadaEn: s.creadaEn.toISOString() });

/** Pide uno de más para saber si hay otra página sin contar todas las filas. */
async function listar(deps: DependenciasDespacho, filtro: FiltroSolicitudes, { limite, desde }: Pagina): Promise<Listado> {
  const filas = await deps.repo.listarSolicitudes(filtro, { limite: limite + 1, desde });
  return {
    viajes: filas.slice(0, limite).map(resumen),
    siguiente: filas.length > limite ? desde + limite : null,
  };
}

export interface EntradaHistorial extends Pagina {
  /** Sale del token, nunca de la query. */
  usuarioId: string;
  /** El pasajero ve los viajes que pidió; el chofer, los que tuvo asignados. */
  como: 'pasajero' | 'chofer';
}

export function historial(deps: DependenciasDespacho) {
  return ({ usuarioId, como, ...pagina }: EntradaHistorial): Promise<Listado> =>
    listar(deps, como === 'pasajero' ? { pasajeroId: usuarioId } : { choferId: usuarioId }, pagina);
}

export interface EntradaPanel extends Pagina {
  /** Sin estado, el panel muestra los viajes activos (buscando, asignados, en camino y en curso). */
  estado?: EstadoSolicitud;
  texto?: string;
}

/** Panel del operador: ve todos los viajes. Los roles se controlan en la ruta. */
export function panelOperador(deps: DependenciasDespacho) {
  return ({ estado, texto, ...pagina }: EntradaPanel): Promise<Listado> =>
    listar(deps, { estados: estado ? [estado] : ESTADOS_ACTIVOS, ...(texto ? { texto } : {}) }, pagina);
}
