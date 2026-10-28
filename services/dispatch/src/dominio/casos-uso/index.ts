import { aceptarOferta } from './aceptar-oferta.js';
import { cancelarSolicitud } from './cancelar-solicitud.js';
import { crearSolicitud } from './crear-solicitud.js';
import type { DependenciasDespacho } from './dependencias.js';
import { liberarChofer } from './liberar-chofer.js';
import { obtenerSolicitud } from './obtener-solicitud.js';
import { vencerOfertas } from './vencer-ofertas.js';

export type { DependenciasDespacho } from './dependencias.js';

export function crearCasosDeUso(deps: DependenciasDespacho) {
  return {
    crearSolicitud: crearSolicitud(deps),
    aceptarOferta: aceptarOferta(deps),
    cancelarSolicitud: cancelarSolicitud(deps),
    vencerOfertas: vencerOfertas(deps),
    liberarChofer: liberarChofer(deps),
    obtenerSolicitud: obtenerSolicitud(deps),
  };
}

export type CasosDeUso = ReturnType<typeof crearCasosDeUso>;
