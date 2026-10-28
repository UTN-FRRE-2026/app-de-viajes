import { OfertaVencida } from '../errores/index.js';

export type EstadoOferta = 'PENDIENTE' | 'ACEPTADA' | 'VENCIDA' | 'CANCELADA';

export interface DatosOferta {
  id: string;
  solicitudId: string;
  choferId: string;
  estado: EstadoOferta;
  venceEn: Date;
}

export class Oferta {
  private constructor(private datos: DatosOferta) {}

  static nueva(id: string, solicitudId: string, choferId: string, venceEn: Date): Oferta {
    return new Oferta({ id, solicitudId, choferId, estado: 'PENDIENTE', venceEn });
  }

  static reconstruir(datos: DatosOferta): Oferta {
    return new Oferta({ ...datos });
  }

  get id() {
    return this.datos.id;
  }
  get solicitudId() {
    return this.datos.solicitudId;
  }
  get choferId() {
    return this.datos.choferId;
  }
  get estado() {
    return this.datos.estado;
  }
  get venceEn() {
    return this.datos.venceEn;
  }

  /** El vencimiento se decide con el reloj del servidor, aunque el barrido todavía no haya pasado. */
  estaVigente(ahora: Date): boolean {
    return this.datos.estado === 'PENDIENTE' && ahora < this.datos.venceEn;
  }

  aceptar(ahora: Date): void {
    if (!this.estaVigente(ahora)) throw new OfertaVencida();
    this.datos = { ...this.datos, estado: 'ACEPTADA' };
  }

  /** Devuelve true si la oferta pasó a VENCIDA en esta llamada. */
  vencerSiCorresponde(ahora: Date): boolean {
    if (this.datos.estado !== 'PENDIENTE' || ahora < this.datos.venceEn) return false;
    this.datos = { ...this.datos, estado: 'VENCIDA' };
    return true;
  }

  /** Devuelve true si la oferta estaba pendiente y se canceló. */
  cancelarSiPendiente(): boolean {
    if (this.datos.estado !== 'PENDIENTE') return false;
    this.datos = { ...this.datos, estado: 'CANCELADA' };
    return true;
  }

  aDatos(): DatosOferta {
    return { ...this.datos };
  }
}
