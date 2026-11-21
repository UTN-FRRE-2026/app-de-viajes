import { CobroNoPendiente } from '../errores/index.js';

/**
 * PENDIENTE → APROBADO | RECHAZADO. Los dos últimos son finales.
 * Un cobro que el proveedor no pudo procesar (caído, timeout) **sigue PENDIENTE**: falla cerrado,
 * nunca se lo da por cobrado sin la confirmación del proveedor.
 */
export type EstadoCobro = 'PENDIENTE' | 'APROBADO' | 'RECHAZADO';

export interface DatosCobro {
  /** También es la clave de idempotencia con el proveedor: la misma clave nunca cobra dos veces. */
  id: string;
  solicitudId: string;
  pasajeroId: string;
  montoCentavos: number;
  moneda: 'ARS';
  estado: EstadoCobro;
  /** Intentos en los que el proveedor no contestó. */
  intentosFallidos: number;
  /** El id que devolvió el proveedor, si aprobó o rechazó. */
  referencia: string | null;
  motivoRechazo: string | null;
}

/** Un cobro por viaje completado, por la tarifa final. Lo crea la finalización, en su transacción. */
export class Cobro {
  private constructor(private datos: DatosCobro) {}

  static nuevo(id: string, solicitudId: string, pasajeroId: string, montoCentavos: number): Cobro {
    return new Cobro({
      id,
      solicitudId,
      pasajeroId,
      montoCentavos,
      moneda: 'ARS',
      estado: 'PENDIENTE',
      intentosFallidos: 0,
      referencia: null,
      motivoRechazo: null,
    });
  }

  static reconstruir(datos: DatosCobro): Cobro {
    return new Cobro({ ...datos });
  }

  get id() {
    return this.datos.id;
  }
  get solicitudId() {
    return this.datos.solicitudId;
  }
  get pasajeroId() {
    return this.datos.pasajeroId;
  }
  get montoCentavos() {
    return this.datos.montoCentavos;
  }
  get moneda() {
    return this.datos.moneda;
  }
  get estado() {
    return this.datos.estado;
  }

  aprobar(referencia: string): void {
    this.resolver({ estado: 'APROBADO', referencia });
  }

  rechazar(referencia: string, motivo: string): void {
    this.resolver({ estado: 'RECHAZADO', referencia, motivoRechazo: motivo });
  }

  aDatos(): DatosCobro {
    return { ...this.datos };
  }

  private resolver(cambios: Partial<DatosCobro>): void {
    if (this.datos.estado !== 'PENDIENTE') throw new CobroNoPendiente(this.datos.estado);
    this.datos = { ...this.datos, ...cambios };
  }
}
