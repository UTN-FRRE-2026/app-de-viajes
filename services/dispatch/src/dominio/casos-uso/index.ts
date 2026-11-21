import { aceptarOferta } from './aceptar-oferta.js';
import { finalizarViaje, iniciarViaje, marcarEnCamino } from './avanzar-viaje.js';
import { cancelarSolicitud } from './cancelar-solicitud.js';
import { crearSolicitud } from './crear-solicitud.js';
import type { DependenciasDespacho } from './dependencias.js';
import { estimarTarifa } from './estimar-tarifa.js';
import { historial, panelOperador } from './listar-viajes.js';
import { obtenerSolicitud } from './obtener-solicitud.js';
import { vencerOfertas } from './vencer-ofertas.js';

export type { DependenciasDespacho } from './dependencias.js';

export function crearCasosDeUso(deps: DependenciasDespacho) {
  return {
    crearSolicitud: crearSolicitud(deps),
    aceptarOferta: aceptarOferta(deps),
    cancelarSolicitud: cancelarSolicitud(deps),
    marcarEnCamino: marcarEnCamino(deps),
    iniciarViaje: iniciarViaje(deps),
    finalizarViaje: finalizarViaje(deps),
    vencerOfertas: vencerOfertas(deps),
    obtenerSolicitud: obtenerSolicitud(deps),
    historial: historial(deps),
    panelOperador: panelOperador(deps),
    estimarTarifa: estimarTarifa(deps),
  };
}

export type CasosDeUso = ReturnType<typeof crearCasosDeUso>;
