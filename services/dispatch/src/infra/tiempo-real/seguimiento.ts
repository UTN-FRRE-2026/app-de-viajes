import type { Logger } from '@viajes/platform';
import type { FuentePosiciones, PosicionEnVivo, Seguido } from './tipos.js';

/** Después de estos eventos puede haber cambiado a quién seguir (o dejado de haber alguien). */
export const EVENTOS_DEL_SEGUIDO: ReadonlySet<string> = new Set([
  'TripAssigned',
  'DriverEnRoute',
  'TripStarted',
  'RideCompleted',
  'RideCancelled',
]);

/** El viaje activo del usuario del stream, y a quién seguir en él: su chofer, o su pasajero. */
export interface ViajeSeguido {
  solicitudId: string;
  id: string;
}

export interface DependenciasSeguimiento {
  posiciones: FuentePosiciones;
  /** A quién se sigue: el pasajero sigue al chofer, y el chofer al pasajero. */
  de: Seguido;
  /** El viaje activo del usuario del stream, leído de la base. */
  viajeActivo: (usuarioId: string) => Promise<ViajeSeguido | null>;
  logger: Logger;
}

const mensaje = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * La posición en vivo de la otra parte del viaje, en el stream de un usuario (PLAN 3.5): el pasajero
 * ve a su chofer y el chofer a su pasajero, solo del viaje activo con chofer (ASIGNADO, EN_CAMINO o
 * EN_CURSO), y nadie más.
 *
 * A quién seguir no sale de interpretar los eventos, sino de **volver a leer la base** cada vez que
 * llega uno que puede cambiarlo (`EVENTOS_DEL_SEGUIDO`), y al conectar. Así no importa el orden en que
 * lleguen, ni si son de la reposición o de un viaje anterior: la base dice el viaje de ahora. Las
 * lecturas van de a una, y las que se piden mientras otra espera se juntan en una sola.
 *
 * Las posiciones no tienen `id`: no se reponen con `Last-Event-ID` (vale la última, y la próxima llega
 * con el siguiente ping) ni mueven el `Last-Event-ID` del cliente. Una más vieja que la última enviada
 * se descarta. Si Redis o la base fallan, el stream sigue con los eventos del viaje: la posición es
 * lo único que se pierde, y se reintenta con el próximo evento.
 */
export class Seguimiento {
  private actual: (ViajeSeguido & { baja: () => Promise<void> }) | null = null;
  private ultimaMs = -Infinity;
  private cola: Promise<void> = Promise.resolve();
  private encolada = false;
  private terminado = false;

  constructor(
    private readonly usuarioId: string,
    private readonly deps: DependenciasSeguimiento,
    private readonly entregar: (viaje: ViajeSeguido, posicion: PosicionEnVivo) => void,
  ) {}

  /** Vuelve a leer a quién seguir y ajusta la suscripción. */
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
    let viaje: ViajeSeguido | null;
    try {
      viaje = await this.deps.viajeActivo(this.usuarioId);
    } catch (err) {
      this.deps.logger.warn({ err: mensaje(err), de: this.deps.de }, 'eventos: no se pudo leer el viaje para la posición en vivo');
      return;
    }
    if (this.terminado) return;
    if (viaje && viaje.solicitudId === this.actual?.solicitudId && viaje.id === this.actual.id) return;

    const anterior = this.actual;
    this.actual = null;
    await anterior?.baja().catch(() => {});
    if (!viaje) return;

    const seguido = viaje;
    this.ultimaMs = -Infinity;
    let baja: () => Promise<void>;
    try {
      baja = await this.deps.posiciones.suscribir(this.deps.de, seguido.id, (p) => this.recibir(seguido, p));
    } catch (err) {
      this.deps.logger.warn({ err: mensaje(err), de: this.deps.de }, 'eventos: no se pudo seguir la posición en vivo');
      return;
    }
    if (this.terminado) {
      await baja().catch(() => {});
      return;
    }
    this.actual = { ...seguido, baja };
  }

  private recibir(viaje: ViajeSeguido, p: PosicionEnVivo): void {
    // Solo del viaje que se sigue ahora, y de la persona de ese viaje.
    if (this.terminado || this.actual?.solicitudId !== viaje.solicitudId || p.id !== viaje.id) return;
    const ms = Date.parse(p.actualizadaEn);
    if (!(ms > this.ultimaMs)) return;
    this.ultimaMs = ms;
    this.entregar(viaje, p);
  }
}
