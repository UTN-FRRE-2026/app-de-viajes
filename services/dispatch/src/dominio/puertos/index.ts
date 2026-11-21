import type { PayloadEventoDispatch, TipoEventoDispatch } from '@viajes/contracts';
import type { Coordenada, EstadoSolicitud, Oferta, SolicitudViaje } from '../entidades/index.js';

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
  /**
   * Solicitudes que cumplen TODOS los filtros dados, de la más nueva a la más vieja.
   * `texto` es literal: `%` y `_` no son comodines.
   */
  listarSolicitudes(filtro: FiltroSolicitudes, pagina: Pagina): Promise<SolicitudViaje[]>;
}

export interface FiltroSolicitudes {
  pasajeroId?: string;
  choferId?: string;
  estados?: readonly EstadoSolicitud[];
  /** Busca en el id del viaje, del pasajero y del chofer, y en el motivo de cancelación. */
  texto?: string;
}

export interface Pagina {
  limite: number;
  desde: number;
}

export interface BuscadorCandidatos {
  /** Choferes disponibles cerca del origen, del más conveniente al menos. */
  buscar(origen: Coordenada, opciones: { excluir: string[]; limite: number }): Promise<string[]>;
}

/**
 * Métricas de negocio. Los casos de uso las registran **después** de que la transacción confirmó:
 * lo que hace rollback no se cuenta.
 */
export interface MetricasDespacho {
  /** Solicitud creada: con ofertas, o directamente SIN_CHOFERES. */
  solicitudCreada(resultado: 'con_ofertas' | 'sin_choferes'): void;
  /** Asignación confirmada, con el tiempo desde que el pasajero la pidió (antes de buscar candidatos). */
  asignacion(msDesdeSolicitud: number): void;
  /** Ofertas que el barrido marcó como vencidas. */
  ofertasVencidas(cantidad: number): void;
}

export interface ParametrosDespacho {
  ofertasSimultaneas: number;
  ttlOfertaMs: number;
}
