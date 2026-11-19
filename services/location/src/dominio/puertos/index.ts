import type { Cercano, Coordenada, Ping } from '../entidades/index.js';

export interface BusquedaCercanos {
  origen: Coordenada;
  radioMetros: number;
  limite: number;
  /** Solo cuenta la última posición de cada chofer, y solo si es de este momento o posterior. */
  desde: Date;
}

/**
 * Las estrategias de 6.6 (ingenua y optimizada) implementan este mismo puerto: cambia cómo se
 * guarda y cómo se busca, no el contrato ni los casos de uso.
 */
export interface RepositorioUbicaciones {
  /** Camino caliente: un ping cada 2 s por chofer. No hace lecturas. */
  guardar(ping: Ping): Promise<void>;
  /** Choferes con posición vigente dentro del radio, del más cercano al más lejano. */
  cercanos(busqueda: BusquedaCercanos): Promise<Cercano[]>;
}
