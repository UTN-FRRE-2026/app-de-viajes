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
 * Lo que se guarda: los datos públicos más `creadaEn`, que es interno (no sale en las respuestas).
 * `creadaEn` es el momento en que el pasajero pidió el viaje, tomado antes de buscar candidatos:
 * de ahí se mide el tiempo hasta la asignación.
 */
export interface RegistroSolicitud extends DatosSolicitud {
  creadaEn: Date;
}

/**
 * Transiciones válidas:
 *   BUSCANDO → ASIGNADO | CANCELADO_PASAJERO | SIN_CHOFERES
 *   ASIGNADO → CANCELADO_PASAJERO | COMPLETADA
 * Cualquier otra lanza un error de dominio.
 */
export class SolicitudViaje {
  private constructor(
    private datos: DatosSolicitud,
    readonly creadaEn: Date,
  ) {}

  static nueva(id: string, pasajeroId: string, origen: Coordenada, destino: Coordenada, creadaEn: Date): SolicitudViaje {
    return new SolicitudViaje({ id, pasajeroId, origen, destino, estado: 'BUSCANDO', choferId: null, version: 0 }, creadaEn);
  }

  static reconstruir({ creadaEn, ...datos }: RegistroSolicitud): SolicitudViaje {
    return new SolicitudViaje(datos, new Date(creadaEn));
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

  /** Lo que ve el cliente: sin `creadaEn`. */
  aDatos(): DatosSolicitud {
    return { ...this.datos };
  }

  /** Lo que se guarda: con `creadaEn`. */
  aRegistro(): RegistroSolicitud {
    return { ...this.datos, creadaEn: new Date(this.creadaEn) };
  }

  private cambiar(cambios: Partial<DatosSolicitud>): void {
    this.datos = { ...this.datos, ...cambios, version: this.datos.version + 1 };
  }
}
