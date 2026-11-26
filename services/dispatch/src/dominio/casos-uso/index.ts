import { aceptarOferta } from './aceptar-oferta.js';
import { finalizarViaje, iniciarViaje, marcarEnCamino } from './avanzar-viaje.js';
import { cancelarSolicitud } from './cancelar-solicitud.js';
import { cobrarPendientes, cobrarViaje } from './cobrar.js';
import { crearSolicitud } from './crear-solicitud.js';
import type { DependenciasDespacho } from './dependencias.js';
import { situacionChofer } from './estado-chofer.js';
import { estimarTarifa, rutaEntre } from './estimar-tarifa.js';
import { configurarTarifa, obtenerTarifa } from './tarifas-admin.js';
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
    cobrarViaje: cobrarViaje(deps),
    cobrarPendientes: cobrarPendientes(deps),
    vencerOfertas: vencerOfertas(deps),
    obtenerSolicitud: obtenerSolicitud(deps),
    historial: historial(deps),
    situacionChofer: situacionChofer(deps),
    panelOperador: panelOperador(deps),
    estimarTarifa: estimarTarifa(deps),
    rutaEntre: rutaEntre(deps),
    obtenerTarifa: obtenerTarifa(deps),
    configurarTarifa: configurarTarifa(deps),
    /** Para la retención del historial de location (ruta interna, con token de servicio). */
    tramosDeViaje: (choferes: readonly string[], desde: Date, hasta: Date) => deps.repo.tramosDeViaje(choferes, desde, hasta),
  };
}

export type CasosDeUso = ReturnType<typeof crearCasosDeUso>;
