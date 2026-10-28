import { SolicitudNoCancelable, SolicitudNoDisponible } from '../errores/index.js';

export type EstadoSolicitud = 'BUSCANDO' | 'ASIGNADO' | 'CANCELADO_PASAJERO' | 'SIN_CHOFERES' | 'COMPLETADA';

export interface Coordenada {
  lat: number;
  lng: number;
}

export interface DatosSolicitud {
  id: string;
  pasajeroId: string;
  origen: Coordenada;
  destino: Coordenada;
  estado: EstadoSolicitud;
  choferId: string | null;
  version: number;
}

/**
 * Transiciones válidas:
 *   BUSCANDO → ASIGNADO | CANCELADO_PASAJERO | SIN_CHOFERES
 *   ASIGNADO → CANCELADO_PASAJERO | COMPLETADA
 * Cualquier otra lanza un error de dominio.
 */
export class SolicitudViaje {
  private constructor(private datos: DatosSolicitud) {}

  static nueva(id: string, pasajeroId: string, origen: Coordenada, destino: Coordenada): SolicitudViaje {
    return new SolicitudViaje({ id, pasajeroId, origen, destino, estado: 'BUSCANDO', choferId: null, version: 0 });
  }

  static reconstruir(datos: DatosSolicitud): SolicitudViaje {
    return new SolicitudViaje({ ...datos });
  }

  get id() {
    return this.datos.id;
  }
  get pasajeroId() {
    return this.datos.pasajeroId;
  }
  get origen() {
    return this.datos.origen;
  }
  get destino() {
    return this.datos.destino;
  }
  get estado() {
    return this.datos.estado;
  }
  get choferId() {
    return this.datos.choferId;
  }
  get version() {
    return this.datos.version;
  }

  asignar(choferId: string): void {
    if (this.datos.estado !== 'BUSCANDO') throw new SolicitudNoDisponible(this.datos.estado);
    this.cambiar({ estado: 'ASIGNADO', choferId });
  }

  /** Devuelve el chofer que hay que liberar si la solicitud ya estaba asignada. */
  cancelarPorPasajero(): { estabaAsignada: boolean; choferLiberado: string | null } {
    const { estado, choferId } = this.datos;
    if (estado === 'BUSCANDO') {
      this.cambiar({ estado: 'CANCELADO_PASAJERO' });
      return { estabaAsignada: false, choferLiberado: null };
    }
    if (estado === 'ASIGNADO') {
      this.cambiar({ estado: 'CANCELADO_PASAJERO' });
      return { estabaAsignada: true, choferLiberado: choferId };
    }
    throw new SolicitudNoCancelable(estado);
  }

  marcarSinChoferes(): void {
    if (this.datos.estado !== 'BUSCANDO') throw new SolicitudNoDisponible(this.datos.estado);
    this.cambiar({ estado: 'SIN_CHOFERES' });
  }

  completar(): void {
    if (this.datos.estado !== 'ASIGNADO') throw new SolicitudNoDisponible(this.datos.estado);
    this.cambiar({ estado: 'COMPLETADA' });
  }

  aDatos(): DatosSolicitud {
    return { ...this.datos };
  }

  private cambiar(cambios: Partial<DatosSolicitud>): void {
    this.datos = { ...this.datos, ...cambios, version: this.datos.version + 1 };
  }
}
