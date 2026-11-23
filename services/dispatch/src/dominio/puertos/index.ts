import type { PayloadEventoDispatch, TipoEventoDispatch } from '@viajes/contracts';
import type { Cobro, Coordenada, EstadoSolicitud, Oferta, SolicitudViaje } from '../entidades/index.js';
import type { ChoferFlota, DatosFlota, Flota } from '../flotas/index.js';
import type { Recorrido } from '../tarifas/calculo.js';
import type { ParametrosTarifa, TarifaVigente, ValoresTarifa } from '../tarifas/parametros.js';

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
  /** Un cobro por viaje: la base lo exige con una restricción única sobre la solicitud. */
  insertarCobro(cobro: Cobro): Promise<void>;
  /**
   * Lee el cobro del viaje y lo BLOQUEA hasta el final de la transacción. Así, si el barrido y un
   * pedido procesan el mismo cobro a la vez, uno solo registra el resultado.
   */
  obtenerCobroParaActualizar(solicitudId: string): Promise<Cobro | null>;
  guardarCobro(cobro: Cobro): Promise<void>;
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
  obtenerCobro(solicitudId: string): Promise<Cobro | null>;
  /**
   * Viajes con el cobro todavía PENDIENTE, primero los que hace más que no se intentan: un cobro que
   * falla pasa al final de la cola y no traba a los demás.
   */
  cobrosPendientes(limite: number): Promise<string[]>;
  /**
   * Suma un intento fallido, fuera de una transacción. No usa `enTransaccion` a propósito: esa
   * transacción registraría la Idempotency-Key del pedido como si hubiera salido bien.
   */
  registrarFalloCobro(cobroId: string, motivo: string): Promise<void>;
  /**
   * El viaje activo del pasajero que ya tiene chofer (ASIGNADO, EN_CAMINO o EN_CURSO), o null. Hay
   * como mucho uno: el índice único parcial no deja que un pasajero tenga dos activos.
   */
  viajeConChoferDelPasajero(pasajeroId: string): Promise<ViajeConChofer | null>;
  /**
   * El viaje activo del chofer (ASIGNADO, EN_CAMINO o EN_CURSO) y su pasajero, o null. Hay como mucho
   * uno: la asignación activa es una fila por chofer.
   */
  viajeConPasajeroDelChofer(choferId: string): Promise<ViajeConPasajero | null>;
}

export interface ViajeConChofer {
  solicitudId: string;
  choferId: string;
}

export interface ViajeConPasajero {
  solicitudId: string;
  pasajeroId: string;
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

/**
 * Mapas: distancia y tiempo de manejo entre dos puntos, en enteros no negativos (metros y segundos).
 * El adaptador corta por timeout y falla cerrado: si no hay recorrido, no hay estimación.
 */
export interface ServicioMapas {
  recorrido(origen: Coordenada, destino: Coordenada): Promise<Recorrido>;
}

/** Los parámetros de tarifa vigentes, para estimar. Puede tener caché: tiene que reflejar el último cambio. */
export interface ProveedorTarifas {
  vigente(): Promise<ParametrosTarifa>;
  /** Los parámetros de una versión (no cambian nunca), o null si no existe. Lo usa la tarifa final. */
  porVersion(version: string): Promise<ParametrosTarifa | null>;
  /**
   * Aviso de que cambió la tarifa, después del COMMIT. Es solo higiene del caché: la corrección no
   * puede depender de esto (si falla, la próxima lectura igual ve la versión nueva). No lanza.
   */
  tarifaCambiada?(anterior: string | null, nueva: ParametrosTarifa): Promise<void>;
}

/**
 * Tarifa global versionada. Las versiones no se modifican nunca: un cambio crea una versión nueva,
 * la marca vigente y deja auditoría con los valores anteriores y los nuevos.
 */
export interface RepositorioTarifas {
  /** Solo la versión vigente (`v3`), o null si todavía no hay tarifa. Es la lectura barata de cada estimación. */
  versionVigente(): Promise<string | null>;
  porVersion(version: string): Promise<TarifaVigente | null>;
  vigente(): Promise<TarifaVigente | null>;
  /**
   * Crea la versión 1 con estos valores **solo si todavía no hay ninguna**. Seguro ante reinicios y
   * arranques simultáneos: una vez creada, otros valores (por ejemplo, un `.env` distinto) no la pisan.
   */
  sembrar(valores: ValoresTarifa): Promise<void>;
  /**
   * Nueva versión vigente con su auditoría, en una transacción. Dos ediciones simultáneas se
   * serializan: cada una parte de la vigente de verdad y el historial queda encadenado.
   * Devuelve también `anterior`: la versión que estaba vigente según la lectura hecha **dentro** de la
   * transacción, bajo el lock. Es la que hay que invalidar en el caché, no una leída antes.
   */
  reemplazar(valores: ValoresTarifa, autor: string): Promise<{ nueva: TarifaVigente; anterior: string | null }>;
}

export interface PedidoDeCobro {
  /** Clave de idempotencia del proveedor (el id del cobro): reintentar con la misma nunca cobra dos veces. */
  clave: string;
  montoCentavos: number;
  moneda: 'ARS';
  pasajeroId: string;
}

export interface ResultadoCobro {
  aprobado: boolean;
  /** El id de la operación en el proveedor. */
  referencia: string;
  /** Solo si no aprobó. */
  motivo: string | null;
}

/**
 * Pagos. El adaptador corta por timeout y falla cerrado (503): si el proveedor no contesta, el cobro
 * sigue PENDIENTE y se reintenta con la misma clave. Con la misma clave, el proveedor devuelve el
 * resultado de la primera vez, como hacen los proveedores reales con su clave de idempotencia.
 */
export interface ProcesadorPagos {
  cobrar(pedido: PedidoDeCobro): Promise<ResultadoCobro>;
}

/**
 * Flotas (variante G). Todo lo que cambia el cupo va en una transacción; el orden de los locks es
 * siempre chofer → flota, así activar y liberar no se bloquean entre sí.
 */
export interface TransaccionFlotas {
  /**
   * Lee el chofer y lo BLOQUEA hasta el final de la transacción (SELECT ... FOR UPDATE). Dos pedidos
   * sobre el mismo chofer se serializan acá: el segundo ve lo que dejó el primero.
   */
  obtenerChoferParaActualizar(id: string): Promise<ChoferFlota | null>;
  guardarChofer(chofer: ChoferFlota): Promise<void>;
  /** El chofer ya en alguna flota, o la patente repetida: lo deciden las restricciones únicas de la base. */
  insertarChofer(chofer: ChoferFlota): Promise<'ok' | 'chofer_existe' | 'patente_existe'>;
  /**
   * Carrera G: ocupa un cupo con un UPDATE condicional (`active_count < max_active`), atómico en la
   * base. false si la flota está llena. Con N activaciones a la vez, solo `max_active` lo logran.
   */
  ocuparCupo(flotaId: string): Promise<boolean>;
  liberarCupo(flotaId: string): Promise<void>;
  /**
   * Crea la flota o cambia su nombre y su límite. `limite_menor` si el límite nuevo queda por debajo
   * de los activos: no se cambia nada.
   */
  guardarFlota(flota: DatosFlota): Promise<'ok' | 'limite_menor'>;
  obtenerFlota(id: string): Promise<Flota | null>;
}

export interface RepositorioFlotas {
  /** Si el pedido trae Idempotency-Key, el registro va en esta misma transacción. */
  enTransaccion<T>(trabajo: (tx: TransaccionFlotas) => Promise<T>): Promise<T>;
  obtenerFlota(id: string): Promise<Flota | null>;
  obtenerChofer(id: string): Promise<ChoferFlota | null>;
  listarChoferes(flotaId: string, pagina: Pagina): Promise<ChoferFlota[]>;
}

/**
 * Cuentas de identity. dispatch no tiene la base de identity: le pregunta el rol de un id. null si la
 * cuenta no existe. El adaptador falla cerrado (503) si identity no responde.
 */
export interface DirectorioUsuarios {
  rolDe(usuarioId: string): Promise<string | null>;
}
