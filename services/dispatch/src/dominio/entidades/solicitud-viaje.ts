import {
  MotivoRequerido,
  SolicitudNoCancelable,
  SolicitudNoDisponible,
  TransicionInvalida,
} from '../errores/index.js';
import { calcularTarifa } from '../tarifas/calculo.js';
import type { ParametrosTarifa } from '../tarifas/parametros.js';

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

/** Activos y con chofer: mientras tanto, el pasajero ve la posición de su chofer en vivo. */
export const ESTADOS_CON_CHOFER: readonly EstadoSolicitud[] = ['ASIGNADO', 'EN_CAMINO', 'EN_CURSO'];

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

export interface RecorridoViaje {
  metros: number;
  segundos: number;
}

/**
 * Qué difiere entre el recorrido estimado y el final, cuando el importe cambió. La versión de tarifa
 * nunca es un motivo: el final se calcula con la misma versión que la estimación (precio congelado).
 */
export type MotivoDiferencia = 'DISTANCIA' | 'DURACION';

/** La estimación con la que se pidió el viaje y, al finalizar, la tarifa final. Todo en centavos enteros. */
export interface TarifaViaje {
  version: string;
  moneda: 'ARS';
  estimadaCentavos: number;
  recorridoEstimado: RecorridoViaje;
  finalCentavos: number | null;
  recorridoFinal: RecorridoViaje | null;
  /** Vacío si el importe final es igual al estimado, o si el viaje todavía no terminó. */
  motivosDiferencia: MotivoDiferencia[];
}

/** Lo que se sabe al crear la solicitud: sale de la misma estimación que `GET /tarifas/estimacion`. */
export interface TarifaEstimada {
  version: string;
  moneda: 'ARS';
  centavos: number;
  recorrido: RecorridoViaje;
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
  /** null solo en las solicitudes creadas antes de que se guardara la estimación. */
  tarifa: TarifaViaje | null;
  version: number;
}

/**
 * Lo que se guarda: los datos públicos más dos fechas internas (no salen en las respuestas).
 * `creadaEn` es el momento en que el pasajero pidió el viaje, tomado antes de buscar candidatos:
 * de ahí se mide el tiempo hasta la asignación.
 */
export interface RegistroSolicitud extends DatosSolicitud {
  creadaEn: Date;
  /** Cuándo subió el pasajero (iniciar). De acá se mide la duración real del viaje. */
  iniciadoEn: Date | null;
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
    private iniciadoEn: Date | null,
  ) {}

  static nueva(
    id: string,
    pasajeroId: string,
    origen: Coordenada,
    destino: Coordenada,
    creadaEn: Date,
    estimada: TarifaEstimada,
  ): SolicitudViaje {
    const tarifa: TarifaViaje = {
      version: estimada.version,
      moneda: estimada.moneda,
      estimadaCentavos: estimada.centavos,
      recorridoEstimado: { ...estimada.recorrido },
      finalCentavos: null,
      recorridoFinal: null,
      motivosDiferencia: [],
    };
    return new SolicitudViaje(
      { id, pasajeroId, origen, destino, estado: 'BUSCANDO', choferId: null, motivoCancelacion: null, tarifa, version: 0 },
      creadaEn,
      null,
    );
  }

  static reconstruir({ creadaEn, iniciadoEn, ...datos }: RegistroSolicitud): SolicitudViaje {
    return new SolicitudViaje(datos, new Date(creadaEn), iniciadoEn ? new Date(iniciadoEn) : null);
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
  get tarifa() {
    return this.datos.tarifa;
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

  /** El pasajero subió: empieza el viaje, y desde acá se mide su duración. */
  iniciar(ahora: Date): void {
    this.avanzar('EN_CAMINO', 'EN_CURSO');
    this.iniciadoEn = new Date(ahora);
  }

  /**
   * Llegaron a destino. El llamador libera al chofer en la misma transacción.
   *
   * Tarifa final: la misma `calcularTarifa` que la estimación y **la misma versión**. El precio que
   * vio el pasajero queda congelado: si el admin cambia la tarifa durante el viaje, no lo afecta.
   * - Duración: la real, de iniciar a finalizar, redondeada al segundo.
   * - Distancia: la de mapas entre origen y destino, que es la de la estimación (no cambian). Cuando
   *   haya un recorrido medido (location), entra acá y puede aparecer el motivo DISTANCIA.
   */
  finalizar(ahora: Date, parametros: ParametrosTarifa | null): void {
    if (this.datos.estado !== 'EN_CURSO') throw new TransicionInvalida(this.datos.estado, 'COMPLETADA');
    const tarifa = this.datos.tarifa;
    if (!tarifa) {
      this.cambiar({ estado: 'COMPLETADA' });
      return;
    }
    if (parametros?.version !== tarifa.version) {
      throw new Error(`la tarifa final tiene que usar la versión de la estimación (${tarifa.version})`);
    }

    const estimado = tarifa.recorridoEstimado;
    const segundos = this.iniciadoEn
      ? Math.max(0, Math.round((ahora.getTime() - this.iniciadoEn.getTime()) / 1000))
      : estimado.segundos;
    const recorridoFinal = { metros: estimado.metros, segundos };
    const { totalCentavos } = calcularTarifa(parametros, recorridoFinal);

    const motivosDiferencia: MotivoDiferencia[] = [];
    if (totalCentavos !== tarifa.estimadaCentavos) {
      if (recorridoFinal.metros !== estimado.metros) motivosDiferencia.push('DISTANCIA');
      if (recorridoFinal.segundos !== estimado.segundos) motivosDiferencia.push('DURACION');
    }
    this.cambiar({
      estado: 'COMPLETADA',
      tarifa: { ...tarifa, finalCentavos: totalCentavos, recorridoFinal, motivosDiferencia },
    });
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

  /** Lo que ve el cliente: sin las fechas internas. */
  aDatos(): DatosSolicitud {
    return structuredClone(this.datos);
  }

  /** Lo que se guarda: con `creadaEn` e `iniciadoEn`. */
  aRegistro(): RegistroSolicitud {
    return {
      ...structuredClone(this.datos),
      creadaEn: new Date(this.creadaEn),
      iniciadoEn: this.iniciadoEn ? new Date(this.iniciadoEn) : null,
    };
  }

  private avanzar(desde: EstadoSolicitud, hacia: EstadoSolicitud): void {
    if (this.datos.estado !== desde) throw new TransicionInvalida(this.datos.estado, hacia);
    this.cambiar({ estado: hacia });
  }

  private cambiar(cambios: Partial<DatosSolicitud>): void {
    this.datos = { ...this.datos, ...cambios, version: this.datos.version + 1 };
  }
}
