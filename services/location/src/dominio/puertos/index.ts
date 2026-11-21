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

/**
 * Posición en vivo para el seguimiento (Redis Pub/Sub en producción). Publica en el canal del chofer
 * solo si el ping no es más viejo que la última posición publicada de ese chofer: devuelve
 * `atrasada` si lo descartó por eso. Lo que no se escucha, se pierde: no es un historial.
 */
export interface PublicadorPosiciones {
  publicar(ping: Ping): Promise<'publicada' | 'atrasada'>;
}

/**
 * Qué pasó con la publicación de un ping. `vencida`: cuando se iba a publicar, ya superaba la vigencia
 * (no se anuncia una posición fantasma). `error`: falló o no se confirmó a tiempo; el ping igual quedó
 * guardado.
 */
export type ResultadoPublicacion = 'publicada' | 'atrasada' | 'vencida' | 'error';
