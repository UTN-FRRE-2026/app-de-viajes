import { seleccionarCercanos, type Cercano, type Ping } from '../../dominio/entidades/index.js';
import type { BusquedaCercanos, RepositorioUbicaciones } from '../../dominio/puertos/index.js';

/** Para tests de dominio y para correr sin base. Guarda solo la última posición de cada chofer. */
export class RepositorioUbicacionesMemoria implements RepositorioUbicaciones {
  readonly ultimas = new Map<string, Ping>();

  async guardar(ping: Ping): Promise<void> {
    const anterior = this.ultimas.get(ping.choferId);
    // Igual que en Postgres: una posición más vieja no pisa a una más nueva.
    if (!anterior || ping.registradoEn >= anterior.registradoEn) this.ultimas.set(ping.choferId, ping);
  }

  async cercanos({ origen, radioMetros, limite, desde }: BusquedaCercanos): Promise<Cercano[]> {
    const vigentes = [...this.ultimas.values()].filter((p) => p.registradoEn >= desde);
    return seleccionarCercanos(vigentes, origen, { radioMetros, limite });
  }
}
