import type { PayloadEventoDispatch, TipoEventoDispatch } from '@viajes/contracts';
import type { Coordenada, Oferta, SolicitudViaje } from '../entidades/index.js';

export type EventoDispatch = {
  [T in TipoEventoDispatch]: { tipo: T; payload: PayloadEventoDispatch<T> };
}[TipoEventoDispatch];

/**
 * Operaciones disponibles dentro de una transacción. Todo lo que se escribe acá
 * se confirma junto o no se confirma.
 */
export interface TransaccionDespacho {
  /**
   * Lee la solicitud y la BLOQUEA hasta que termine la transacción (SELECT ... FOR UPDATE).
   * Regla de orden: todo caso de uso que modifique una solicitud la bloquea primero, antes que nada.
   */
  obtenerSolicitudParaActualizar(id: string): Promise<SolicitudViaje | null>;
  ofertasDeSolicitud(solicitudId: string): Promise<Oferta[]>;
  /** false si el pasajero ya tiene una solicitud activa (índice único parcial). */
  insertarSolicitud(solicitud: SolicitudViaje): Promise<boolean>;
  guardarSolicitud(solicitud: SolicitudViaje): Promise<void>;
  /** Inserta las nuevas y actualiza el estado de las existentes. */
  guardarOfertas(ofertas: Oferta[]): Promise<void>;
  /** Toma el "lock" del chofer. false si ya tiene un viaje activo (restricción única). */
  reservarChofer(choferId: string, solicitudId: string): Promise<boolean>;
  liberarChofer(solicitudId: string): Promise<void>;
  /** Outbox: el evento se publica después, solo si la transacción confirmó. */
  registrarEvento(evento: EventoDispatch): Promise<void>;
}

export interface RepositorioDespacho {
  enTransaccion<T>(trabajo: (tx: TransaccionDespacho) => Promise<T>): Promise<T>;
  /** Lecturas sin bloqueo (pueden quedar viejas en cuanto se devuelven). */
  obtenerSolicitud(id: string): Promise<SolicitudViaje | null>;
  obtenerOferta(id: string): Promise<Oferta | null>;
  solicitudesConOfertasVencidas(ahora: Date, limite: number): Promise<string[]>;
  /** Choferes que ya recibieron una oferta para esta solicitud (para no volver a ofrecerles). */
  choferesOfrecidos(solicitudId: string): Promise<string[]>;
}

export interface BuscadorCandidatos {
  /** Choferes disponibles cerca del origen, del más conveniente al menos. */
  buscar(origen: Coordenada, opciones: { excluir: string[]; limite: number }): Promise<string[]>;
}

export interface ParametrosDespacho {
  ofertasSimultaneas: number;
  ttlOfertaMs: number;
}
