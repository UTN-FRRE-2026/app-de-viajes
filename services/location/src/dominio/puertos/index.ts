import type { Cercano, Coordenada, Ping, PingPasajero } from '../entidades/index.js';

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
/** Un viaje de un chofer, según dispatch: `fin` null si sigue activo. */
export interface TramoDeViaje {
  choferId: string;
  inicio: Date;
  fin: Date | null;
}

/**
 * Los viajes que conoce dispatch, para la retención del historial. Falla (lanza) si dispatch no
 * contesta o la respuesta no cumple el contrato: quien llama conserva los pings.
 */
export interface TramosDeViaje {
  tramos(choferes: readonly string[], desde: Date, hasta: Date): Promise<TramoDeViaje[]>;
}

export interface PublicadorPosiciones {
  publicar(ping: Ping): Promise<'publicada' | 'atrasada'>;
  /** Lo mismo en el canal del pasajero (`posicion-pasajero:`), con su propia marca de orden. */
  publicarPasajero(ping: PingPasajero): Promise<'publicada' | 'atrasada'>;
}

/** De quién es la posición publicada: etiqueta `de` de la métrica. */
export type QuienPublica = 'chofer' | 'pasajero';

/**
 * Qué pasó con la publicación de un ping. `vencida`: cuando se iba a publicar, ya superaba la vigencia
 * (no se anuncia una posición fantasma). `error`: falló o no se confirmó a tiempo; el ping igual quedó
 * guardado.
 */
export type ResultadoPublicacion = 'publicada' | 'atrasada' | 'vencida' | 'error';
