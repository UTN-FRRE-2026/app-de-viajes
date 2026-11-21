import { EventEmitter } from 'node:events';
import type { BusEventos, EventoEntregable } from './tipos.js';

/** Para correr sin Redis (DISPATCH_PERSISTENCIA=memoria): un solo proceso, así que alcanza un EventEmitter. */
export class BusEventosMemoria implements BusEventos {
  private readonly emisor = new EventEmitter().setMaxListeners(0);

  async publicar(evento: EventoEntregable): Promise<void> {
    for (const u of evento.destinatarios) this.emisor.emit(u, evento);
  }

  async suscribir(usuarioId: string, alRecibir: (e: EventoEntregable) => void) {
    this.emisor.on(usuarioId, alRecibir);
    return async () => {
      this.emisor.off(usuarioId, alRecibir);
    };
  }

  async cerrar(): Promise<void> {
    this.emisor.removeAllListeners();
  }
}
