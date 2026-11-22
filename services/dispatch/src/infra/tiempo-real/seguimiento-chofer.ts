import type { PosicionChoferPublicada } from '@viajes/contracts';
import type { Logger } from '@viajes/platform';
import type { ViajeConChofer } from '../../dominio/puertos/index.js';
import type { FuentePosiciones } from './tipos.js';

/** El tipo del evento SSE: el mismo `tipo` del contrato de location. */
export const EVENTO_POSICION = 'DriverLocationUpdated';

/** Después de estos eventos puede haber cambiado el chofer a seguir (o dejado de haber uno). */
export const EVENTOS_DEL_CHOFER: ReadonlySet<string> = new Set([
  'TripAssigned',
  'DriverEnRoute',
  'TripStarted',
  'RideCompleted',
  'RideCancelled',
]);

/** Lo que recibe el pasajero: la posición y de qué viaje es. */
export interface PosicionDelViaje {
  solicitudId: string;
  choferId: string;
  lat: number;
  lng: number;
  actualizadaEn: string;
}

export interface DependenciasSeguimiento {
  posiciones: FuentePosiciones;
  /** El viaje activo con chofer del pasajero, leído de la base. */
  viajeConChofer: (pasajeroId: string) => Promise<ViajeConChofer | null>;
  logger: Logger;
}

const mensaje = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * La posición del chofer en el stream de un pasajero (PLAN 3.5): solo la del chofer asignado a su
 * viaje activo, mientras está ASIGNADO, EN_CAMINO o EN_CURSO.
 *
 * Qué chofer seguir no sale de interpretar los eventos, sino de **volver a leer la base** cada vez que
 * llega uno que puede cambiarlo (`EVENTOS_DEL_CHOFER`), y al conectar. Así no importa el orden en que
 * lleguen, ni si son de la reposición o de un viaje anterior: la base dice el viaje de ahora. Las
 * lecturas van de a una, y las que se piden mientras otra espera se juntan en una sola.
 *
 * Las posiciones no tienen `id`: no se reponen con `Last-Event-ID` (vale la última, y la próxima llega
 * con el siguiente ping) ni mueven el `Last-Event-ID` del cliente. Una más vieja que la última enviada
 * se descarta. Si Redis o la base fallan, el stream sigue con los eventos del viaje: la posición es
 * lo único que se pierde, y se reintenta con el próximo evento.
 */
export class SeguimientoChofer {
  private actual: (ViajeConChofer & { baja: () => Promise<void> }) | null = null;
  private ultimaMs = -Infinity;
  private cola: Promise<void> = Promise.resolve();
  private encolada = false;
  private terminado = false;

  constructor(
    private readonly pasajeroId: string,
    private readonly deps: DependenciasSeguimiento,
    private readonly entregar: (posicion: PosicionDelViaje) => void,
  ) {}

  /** Vuelve a leer qué chofer seguir y ajusta la suscripción. */
  sincronizar(): Promise<void> {
    if (this.terminado || this.encolada) return this.cola;
    this.encolada = true;
    this.cola = this.cola.then(() => {
      this.encolada = false;
      return this.paso();
    });
    return this.cola;
  }

  /** Al cerrar el stream: deja de seguir. */
  terminar(): void {
    this.terminado = true;
    const anterior = this.actual;
    this.actual = null;
    void anterior?.baja().catch(() => {});
  }

  private async paso(): Promise<void> {
    if (this.terminado) return;
    let viaje: ViajeConChofer | null;
    try {
      viaje = await this.deps.viajeConChofer(this.pasajeroId);
    } catch (err) {
      this.deps.logger.warn({ err: mensaje(err) }, 'eventos: no se pudo leer el viaje para la posición del chofer');
      return;
    }
    if (this.terminado) return;
    if (viaje && viaje.solicitudId === this.actual?.solicitudId && viaje.choferId === this.actual.choferId) return;

    const anterior = this.actual;
    this.actual = null;
    await anterior?.baja().catch(() => {});
    if (!viaje) return;

    const seguido = viaje;
    this.ultimaMs = -Infinity;
    let baja: () => Promise<void>;
    try {
      baja = await this.deps.posiciones.suscribir(seguido.choferId, (p) => this.recibir(seguido, p));
    } catch (err) {
      this.deps.logger.warn({ err: mensaje(err) }, 'eventos: no se pudo seguir la posición del chofer');
      return;
    }
    if (this.terminado) {
      await baja().catch(() => {});
      return;
    }
    this.actual = { ...seguido, baja };
  }

  private recibir(viaje: ViajeConChofer, p: PosicionChoferPublicada): void {
    // Solo del viaje que se sigue ahora, y del chofer de ese viaje.
    if (this.terminado || this.actual?.solicitudId !== viaje.solicitudId || p.choferId !== viaje.choferId) return;
    const ms = Date.parse(p.actualizadaEn);
    if (!(ms > this.ultimaMs)) return;
    this.ultimaMs = ms;
    this.entregar({ solicitudId: viaje.solicitudId, choferId: p.choferId, lat: p.lat, lng: p.lng, actualizadaEn: p.actualizadaEn });
  }
}
