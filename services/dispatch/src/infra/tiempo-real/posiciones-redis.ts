import { canalPosicionChofer, PosicionChoferPublicada } from '@viajes/contracts';
import type { Logger } from '@viajes/platform';
import type { Redis } from 'ioredis';
import type { FuentePosiciones } from './tipos.js';

type Oyente = (posicion: PosicionChoferPublicada) => void;

/**
 * Las posiciones que publica location en `<LOCATION_REDIS_PREFIJO>posicion:<choferId>`
 * (docs/location.md, «Posición en vivo»).
 *
 * - `SUBSCRIBE` al canal de cada chofer seguido, no `PSUBSCRIBE` a todos: con un patrón, cada instancia
 *   de dispatch recibiría las posiciones de todos los choferes.
 * - Una sola suscripción por chofer y por proceso, aunque lo sigan varios streams (el pasajero con dos
 *   pestañas): se suscribe con el primero y se da de baja con el último.
 * - Una conexión propia: en modo suscriptor no acepta otros comandos.
 * - Valida cada mensaje con el contrato y que sea del chofer del canal. Lo demás se descarta.
 */
export class PosicionesRedis implements FuentePosiciones {
  private readonly suscriptor: Redis;
  /** canal → chofer y oyentes */
  private readonly canales = new Map<string, { choferId: string; oyentes: Set<Oyente>; listo: Promise<void> }>();

  constructor(
    redis: Redis,
    private readonly prefijo: string,
    private readonly logger: Logger,
  ) {
    // Sin timeout por comando: la conexión queda esperando mensajes a propósito.
    this.suscriptor = redis.duplicate({ commandTimeout: undefined });
    this.suscriptor.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis (posiciones): error de conexión'));
    this.suscriptor.on('message', (canal: string, texto: string) => this.recibir(canal, texto));
  }

  private recibir(canal: string, texto: string): void {
    const suscripto = this.canales.get(canal);
    if (!suscripto) return;
    let posicion: PosicionChoferPublicada;
    try {
      const leida = PosicionChoferPublicada.safeParse(JSON.parse(texto));
      if (!leida.success || leida.data.choferId !== suscripto.choferId) throw new Error('fuera de contrato');
      posicion = leida.data;
    } catch {
      this.logger.warn({ canal }, 'posiciones: mensaje fuera de contrato, se descarta');
      return;
    }
    for (const oyente of suscripto.oyentes) oyente(posicion);
  }

  async suscribir(choferId: string, alRecibir: Oyente) {
    const canal = canalPosicionChofer(this.prefijo, choferId);
    let suscripto = this.canales.get(canal);
    if (!suscripto) {
      const nuevo = { choferId, oyentes: new Set<Oyente>(), listo: this.suscriptor.subscribe(canal).then(() => {}) };
      // Si falla, que el próximo intento vuelva a suscribirse en vez de creer que ya lo está.
      nuevo.listo.catch(() => {
        if (this.canales.get(canal) === nuevo) this.canales.delete(canal);
      });
      this.canales.set(canal, nuevo);
      suscripto = nuevo;
    }
    suscripto.oyentes.add(alRecibir);
    try {
      // El segundo stream que sigue al mismo chofer espera la misma suscripción.
      await suscripto.listo;
    } catch (err) {
      suscripto.oyentes.delete(alRecibir);
      throw err;
    }
    return async () => {
      const actual = this.canales.get(canal);
      if (!actual) return;
      actual.oyentes.delete(alRecibir);
      if (actual.oyentes.size === 0) {
        this.canales.delete(canal);
        await this.suscriptor.unsubscribe(canal).catch(() => {});
      }
    };
  }

  async cerrar(): Promise<void> {
    this.canales.clear();
    this.suscriptor.disconnect();
  }
}
