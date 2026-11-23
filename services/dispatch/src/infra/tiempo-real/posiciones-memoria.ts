import { EventEmitter } from 'node:events';
import { TIPO_POSICION_CHOFER, type PosicionChoferPublicada, type PosicionPasajeroPublicada } from '@viajes/contracts';
import type { FuentePosiciones, PosicionEnVivo, Seguido } from './tipos.js';

/** Para correr sin Redis y para los tests: lo que se publica acá lo reciben los suscriptos a esa persona. */
export class PosicionesMemoria implements FuentePosiciones {
  private readonly emisor = new EventEmitter().setMaxListeners(0);

  publicar(posicion: PosicionChoferPublicada | PosicionPasajeroPublicada): void {
    const [de, id] = posicion.tipo === TIPO_POSICION_CHOFER ? (['chofer', posicion.choferId] as const) : (['pasajero', posicion.pasajeroId] as const);
    const enVivo: PosicionEnVivo = { id, lat: posicion.lat, lng: posicion.lng, actualizadaEn: posicion.actualizadaEn };
    this.emisor.emit(`${de}:${id}`, enVivo);
  }

  /** Cuántos siguen a esta persona. */
  oyentes(de: Seguido, id: string): number {
    return this.emisor.listenerCount(`${de}:${id}`);
  }

  async suscribir(de: Seguido, id: string, alRecibir: (p: PosicionEnVivo) => void) {
    this.emisor.on(`${de}:${id}`, alRecibir);
    return async () => {
      this.emisor.off(`${de}:${id}`, alRecibir);
    };
  }

  async cerrar(): Promise<void> {
    this.emisor.removeAllListeners();
  }
}
