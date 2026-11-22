import { EventEmitter } from 'node:events';
import type { PosicionChoferPublicada } from '@viajes/contracts';
import type { FuentePosiciones } from './tipos.js';

/** Para correr sin Redis y para los tests: lo que se publica acá lo reciben los suscriptos a ese chofer. */
export class PosicionesMemoria implements FuentePosiciones {
  private readonly emisor = new EventEmitter().setMaxListeners(0);

  publicar(posicion: PosicionChoferPublicada): void {
    this.emisor.emit(posicion.choferId, posicion);
  }

  /** Cuántos siguen a este chofer. */
  oyentes(choferId: string): number {
    return this.emisor.listenerCount(choferId);
  }

  async suscribir(choferId: string, alRecibir: (p: PosicionChoferPublicada) => void) {
    this.emisor.on(choferId, alRecibir);
    return async () => {
      this.emisor.off(choferId, alRecibir);
    };
  }

  async cerrar(): Promise<void> {
    this.emisor.removeAllListeners();
  }
}
