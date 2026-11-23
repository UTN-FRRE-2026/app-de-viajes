/** Un evento del outbox, listo para entregar por SSE. */
export interface EventoEntregable {
  /** El `id:` del stream SSE: crece con cada evento, y el cliente lo devuelve en `Last-Event-ID`. */
  seq: number;
  tipo: string;
  payload: Record<string, unknown>;
  /** Los usuarios que lo reciben. */
  destinatarios: string[];
}

/** Publicación en vivo (Redis Pub/Sub o, en memoria, un EventEmitter). Lo que no se escucha, se pierde. */
export interface BusEventos {
  publicar(evento: EventoEntregable): Promise<void>;
  /** Devuelve la función para dejar de escuchar. */
  suscribir(usuarioId: string, alRecibir: (evento: EventoEntregable) => void): Promise<() => Promise<void>>;
  cerrar(): Promise<void>;
}

/** Lo que queda guardado: para reponer lo que el cliente se perdió mientras estaba desconectado. */
export interface HistorialEventos {
  /** Los eventos de un usuario con `seq` mayor que `desde`, en orden. */
  desde(usuarioId: string, desde: number, limite: number): Promise<EventoEntregable[]>;
}

/** De quién es una posición en vivo: location publica las dos, cada una en su canal y con su contrato. */
export type Seguido = 'chofer' | 'pasajero';

/**
 * Una posición en vivo ya validada con su contrato (`PosicionChoferPublicada` o
 * `PosicionPasajeroPublicada`): `id` es el del chofer o el del pasajero, según el canal.
 */
export interface PosicionEnVivo {
  id: string;
  lat: number;
  lng: number;
  actualizadaEn: string;
}

/**
 * Las posiciones en vivo que publica location, un canal por chofer y uno por pasajero. Solo entrega
 * mensajes válidos para el contrato de ese canal y de la persona del canal. Lo que no se escucha, se
 * pierde: no hay historial.
 */
export interface FuentePosiciones {
  /** Devuelve la función para dejar de escuchar. */
  suscribir(de: Seguido, id: string, alRecibir: (posicion: PosicionEnVivo) => void): Promise<() => Promise<void>>;
  cerrar(): Promise<void>;
}

/** El relay: publica en el bus lo que el outbox tiene sin publicar. Devuelve cuántos publicó. */
export type RelayEventos = () => Promise<number>;

/**
 * A quién se le entrega cada evento: al pasajero y al chofer que figuran en su payload, y a nadie
 * más. Así una oferta llega solo a su chofer, y un cobro solo a su pasajero.
 */
export function destinatariosDe(payload: Record<string, unknown>): string[] {
  const ids = [payload['pasajeroId'], payload['choferId']].filter((v): v is string => typeof v === 'string');
  return [...new Set(ids)];
}
