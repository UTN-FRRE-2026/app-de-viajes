import { ChoferNoActivo, ChoferNoEncontrado, ChoferNoHabilitado, FlotaNoAsignada } from '../errores/index.js';

export interface Vehiculo {
  patente: string;
  marca: string;
  modelo: string;
}

export interface DatosChoferFlota {
  /** El `sub` del chofer en identity. */
  id: string;
  flotaId: string;
  vehiculo: Vehiculo;
  /** La habilitación la da el admin de la plataforma (vehículo y documentación en regla). */
  habilitado: boolean;
  /** Activo en su flota: ocupa uno de los `maxActivos`. Lo decide el admin de la flota. */
  activo: boolean;
  /** Si está tomando viajes ahora. Lo decide el chofer, y solo si está activo. */
  disponible: boolean;
}

/** Quién opera sobre la flota: sale del token, nunca del pedido. */
export interface ActorFlota {
  fleetId?: string;
}

/** El `fleetId` del token del admin_flota. Sin él, no tiene flota que administrar. */
export function flotaDelActor({ fleetId }: ActorFlota): string {
  if (!fleetId) throw new FlotaNoAsignada();
  return fleetId;
}

/**
 * Alcance por flota, en el caso de uso: un chofer de otra flota responde igual que uno que no
 * existe (404), así no se revela que existe.
 */
export function exigirMismaFlota(chofer: ChoferFlota | null, flotaId: string): ChoferFlota {
  if (!chofer || chofer.flotaId !== flotaId) throw new ChoferNoEncontrado();
  return chofer;
}

/**
 * Un chofer dentro de su flota. Las reglas de estado viven acá; el cupo de la flota no: lo cuenta la
 * base con un UPDATE condicional (ver `TransaccionFlotas.ocuparCupo`). Los métodos que cambian el
 * estado avisan si ocupan o liberan un cupo, para que el caso de uso mueva el contador en la misma
 * transacción.
 * - habilitado ← admin; activo ← admin_flota (exige habilitado); disponible ← chofer (exige activo).
 * - Desactivar o deshabilitar deja al chofer no disponible.
 */
export class ChoferFlota {
  private constructor(private datos: DatosChoferFlota) {}

  static nuevo(id: string, flotaId: string, vehiculo: Vehiculo): ChoferFlota {
    return new ChoferFlota({ id, flotaId, vehiculo: { ...vehiculo }, habilitado: false, activo: false, disponible: false });
  }

  static reconstruir(datos: DatosChoferFlota): ChoferFlota {
    return new ChoferFlota({ ...datos, vehiculo: { ...datos.vehiculo } });
  }

  get id() {
    return this.datos.id;
  }
  get flotaId() {
    return this.datos.flotaId;
  }
  get activo() {
    return this.datos.activo;
  }

  habilitar(): void {
    this.datos.habilitado = true;
  }

  /** Devuelve true si estaba activo: libera su cupo. */
  deshabilitar(): boolean {
    const liberaCupo = this.datos.activo;
    this.datos = { ...this.datos, habilitado: false, activo: false, disponible: false };
    return liberaCupo;
  }

  /**
   * `ocupa_cupo` si pasa de inactivo a activo. Si ya estaba activo, no cambia nada y no ocupa otro
   * cupo: así dos pedidos para el mismo chofer no cuentan dos veces.
   */
  activar(): 'ocupa_cupo' | 'ya_activo' {
    if (this.datos.activo) return 'ya_activo';
    if (!this.datos.habilitado) throw new ChoferNoHabilitado();
    this.datos.activo = true;
    return 'ocupa_cupo';
  }

  /** Devuelve true si estaba activo: libera su cupo. */
  desactivar(): boolean {
    const liberaCupo = this.datos.activo;
    this.datos = { ...this.datos, activo: false, disponible: false };
    return liberaCupo;
  }

  /** Disponible solo si está activo. Dejar de estar disponible siempre se puede. */
  cambiarDisponibilidad(disponible: boolean): void {
    if (disponible && !this.datos.activo) throw new ChoferNoActivo();
    this.datos.disponible = disponible;
  }

  aDatos(): DatosChoferFlota {
    return { ...this.datos, vehiculo: { ...this.datos.vehiculo } };
  }
}
