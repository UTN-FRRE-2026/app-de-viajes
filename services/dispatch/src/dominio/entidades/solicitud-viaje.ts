import {
  MotivoRequerido,
  SolicitudNoCancelable,
  SolicitudNoDisponible,
  TransicionInvalida,
} from '../errores/index.js';

export type EstadoSolicitud =
  | 'BUSCANDO'
  | 'ASIGNADO'
  | 'EN_CAMINO'
  | 'EN_CURSO'
  | 'COMPLETADA'
  | 'CANCELADO_PASAJERO'
  | 'CANCELADO_CHOFER'
  | 'CANCELADO_OPERADOR'
  | 'SIN_CHOFERES';

/** Estados en los que el viaje sigue vivo: el pasajero no puede pedir otro. */
export const ESTADOS_ACTIVOS: readonly EstadoSolicitud[] = ['BUSCANDO', 'ASIGNADO', 'EN_CAMINO', 'EN_CURSO'];

/** Quién cancela. El admin cancela como operador. */
export type QuienCancela = 'pasajero' | 'chofer' | 'operador';

const ESTADO_CANCELADO: Record<QuienCancela, EstadoSolicitud> = {
  pasajero: 'CANCELADO_PASAJERO',
  chofer: 'CANCELADO_CHOFER',
  operador: 'CANCELADO_OPERADOR',
};

/**
 * Desde qué estados puede cancelar cada uno:
 * - el pasajero, hasta que se sube al auto (EN_CURSO ya no);
 * - el chofer, solo si ya tiene el viaje y todavía no empezó;
 * - el operador, en cualquier estado activo, y siempre con motivo.
 */
const CANCELABLE_DESDE: Record<QuienCancela, readonly EstadoSolicitud[]> = {
  pasajero: ['BUSCANDO', 'ASIGNADO', 'EN_CAMINO'],
  chofer: ['ASIGNADO', 'EN_CAMINO'],
  operador: ['BUSCANDO', 'ASIGNADO', 'EN_CAMINO', 'EN_CURSO'],
};

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
  /** Solo en las canceladas. Obligatorio cuando cancela el operador. */
  motivoCancelacion: string | null;
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

export interface ResultadoCancelacion {
  /** true si había un chofer con el viaje tomado: hay que liberarlo. */
  estabaAsignada: boolean;
  choferLiberado: string | null;
}

/**
 * Máquina de estados del viaje (sección 3.1 del plan):
 *
 *   BUSCANDO  → ASIGNADO | SIN_CHOFERES | CANCELADO_PASAJERO | CANCELADO_OPERADOR
 *   ASIGNADO  → EN_CAMINO | CANCELADO_PASAJERO | CANCELADO_CHOFER | CANCELADO_OPERADOR
 *   EN_CAMINO → EN_CURSO  | CANCELADO_PASAJERO | CANCELADO_CHOFER | CANCELADO_OPERADOR
 *   EN_CURSO  → COMPLETADA | CANCELADO_OPERADOR
 *
 * COMPLETADA, SIN_CHOFERES y los CANCELADO_* son finales. Cualquier otra transición lanza un
 * error de dominio y no cambia nada.
 */
export class SolicitudViaje {
  private constructor(
    private datos: DatosSolicitud,
    readonly creadaEn: Date,
  ) {}

  static nueva(id: string, pasajeroId: string, origen: Coordenada, destino: Coordenada, creadaEn: Date): SolicitudViaje {
    return new SolicitudViaje(
      { id, pasajeroId, origen, destino, estado: 'BUSCANDO', choferId: null, motivoCancelacion: null, version: 0 },
      creadaEn,
    );
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
  get motivoCancelacion() {
    return this.datos.motivoCancelacion;
  }
  get version() {
    return this.datos.version;
  }

  asignar(choferId: string): void {
    if (this.datos.estado !== 'BUSCANDO') throw new SolicitudNoDisponible(this.datos.estado);
    this.cambiar({ estado: 'ASIGNADO', choferId });
  }

  marcarSinChoferes(): void {
    if (this.datos.estado !== 'BUSCANDO') throw new SolicitudNoDisponible(this.datos.estado);
    this.cambiar({ estado: 'SIN_CHOFERES' });
  }

  /** El chofer salió a buscar al pasajero. */
  marcarEnCamino(): void {
    this.avanzar('ASIGNADO', 'EN_CAMINO');
  }

  /** El pasajero subió: empieza el viaje. */
  iniciar(): void {
    this.avanzar('EN_CAMINO', 'EN_CURSO');
  }

  /** Llegaron a destino. El llamador libera al chofer en la misma transacción. */
  finalizar(): void {
    this.avanzar('EN_CURSO', 'COMPLETADA');
  }

  cancelar(quien: QuienCancela, motivo: string | null = null): ResultadoCancelacion {
    const { estado, choferId } = this.datos;
    const motivoLimpio = motivo?.trim() || null;
    if (!CANCELABLE_DESDE[quien].includes(estado)) throw new SolicitudNoCancelable(estado);
    if (quien === 'operador' && !motivoLimpio) throw new MotivoRequerido();

    const estabaAsignada = estado !== 'BUSCANDO';
    this.cambiar({ estado: ESTADO_CANCELADO[quien], motivoCancelacion: motivoLimpio });
    return { estabaAsignada, choferLiberado: estabaAsignada ? choferId : null };
  }

  /** Lo que ve el cliente: sin `creadaEn`. */
  aDatos(): DatosSolicitud {
    return { ...this.datos };
  }

  /** Lo que se guarda: con `creadaEn`. */
  aRegistro(): RegistroSolicitud {
    return { ...this.datos, creadaEn: new Date(this.creadaEn) };
  }

  private avanzar(desde: EstadoSolicitud, hacia: EstadoSolicitud): void {
    if (this.datos.estado !== desde) throw new TransicionInvalida(this.datos.estado, hacia);
    this.cambiar({ estado: hacia });
  }

  private cambiar(cambios: Partial<DatosSolicitud>): void {
    this.datos = { ...this.datos, ...cambios, version: this.datos.version + 1 };
  }
}
