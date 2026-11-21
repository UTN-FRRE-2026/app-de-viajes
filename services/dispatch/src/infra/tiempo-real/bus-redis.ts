import type { Logger } from '@viajes/platform';
import type { Redis } from 'ioredis';
import type { BusEventos, EventoEntregable } from './tipos.js';

/**
 * Redis Pub/Sub, un canal por usuario (`<prefijo><usuarioId>`). El relay publica cada evento en el
 * canal de cada destinatario; cada instancia de dispatch escucha los canales de los usuarios que
 * tienen un stream abierto en ella. Así el pedido que cambió el viaje y el stream del pasajero pueden
 * estar en instancias distintas.
 *
 * Una sola conexión de suscripción por proceso (en modo suscriptor no acepta otros comandos), con
 * todos los canales; se suscribe al primer stream de un usuario y se da de baja con el último.
 */
export class BusEventosRedis implements BusEventos {
  private readonly suscriptor: Redis;
  private readonly oyentes = new Map<string, Set<(e: EventoEntregable) => void>>();

  constructor(
    private readonly redis: Redis,
    private readonly prefijo: string,
    logger: Logger,
  ) {
    // Sin timeout por comando: la conexión queda esperando mensajes a propósito.
    this.suscriptor = redis.duplicate({ commandTimeout: undefined });
    this.suscriptor.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis (eventos): error de conexión'));
    this.suscriptor.on('message', (canal: string, texto: string) => {
      const oyentes = this.oyentes.get(canal);
      if (!oyentes) return;
      let evento: EventoEntregable;
      try {
        evento = JSON.parse(texto) as EventoEntregable;
      } catch {
        logger.warn({ canal }, 'eventos: mensaje que no es JSON, se descarta');
        return;
      }
      for (const oyente of oyentes) oyente(evento);
    });
  }

  async publicar(evento: EventoEntregable): Promise<void> {
    const texto = JSON.stringify(evento);
    await Promise.all(evento.destinatarios.map((u) => this.redis.publish(`${this.prefijo}${u}`, texto)));
  }

  async suscribir(usuarioId: string, alRecibir: (e: EventoEntregable) => void) {
    const canal = `${this.prefijo}${usuarioId}`;
    let oyentes = this.oyentes.get(canal);
    if (!oyentes) {
      oyentes = new Set();
      this.oyentes.set(canal, oyentes);
      await this.suscriptor.subscribe(canal);
    }
    oyentes.add(alRecibir);
    return async () => {
      const actuales = this.oyentes.get(canal);
      if (!actuales) return;
      actuales.delete(alRecibir);
      if (actuales.size === 0) {
        this.oyentes.delete(canal);
        await this.suscriptor.unsubscribe(canal).catch(() => {});
      }
    };
  }

  async cerrar(): Promise<void> {
    this.oyentes.clear();
    this.suscriptor.disconnect();
  }
}
