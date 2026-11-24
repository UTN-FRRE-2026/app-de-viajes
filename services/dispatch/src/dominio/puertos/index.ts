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
  /**
   * La aceptación revalida al chofer en la transacción: habilitado, activo, disponible y de una flota
   * con la zona habilitada. Bloquea (FOR SHARE) la fila del chofer y la de la habilitación de su flota
   * en la zona: desactivarlo, deshabilitarlo o quitarle la zona a la flota esperan a que la aceptación
   * termine, y una aceptación que llega después los ve. Orden: solicitud → chofer → zona de la flota.
   * Devuelve la flota del chofer, o null si no es apto.
   */
  choferAptoParaAceptar(choferId: string, zonaId: string): Promise<{ flotaId: string } | null>;
  /** La zona del punto, como `ElegibilidadChoferes.zonaDelOrigen`, leída en la transacción. */
  zonaDelOrigen(origen: Coordenada): Promise<string | null>;
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
  /**
   * Las ofertas del chofer que todavía puede aceptar: PENDIENTE, sin vencer según `ahora` y de una
   * solicitud que sigue BUSCANDO. Con su solicitud, la que vence primero adelante. Las que se cancelaron
   * porque otro chofer ganó o porque el pasajero canceló no aparecen.
   */
  ofertasPendientesDelChofer(choferId: string, ahora: Date): Promise<OfertaConSolicitud[]>;
  /**
   * Los tramos de viaje de esos choferes que se superponen con [desde, hasta], para la retención del
   * historial de location. Inicio: cuando se creó la oferta que el chofer aceptó (o la solicitud, si no
   * hay oferta). Fin: el último cambio del viaje si ya terminó (en un estado final no cambia más); null
   * si sigue activo.
   */
  tramosDeViaje(choferes: readonly string[], desde: Date, hasta: Date): Promise<TramoDeViaje[]>;
  /**
   * Reporte de la flota: los viajes COMPLETADA con `fleet_id` = `flotaId` (la flota guardada al aceptar,
   * no la actual del chofer) e inicio en [inicio, fin), y sus cobros por estado. Los viajes sin flota
   * (NULL) no entran. Un viaje completado sin cobro cuenta como viaje y no suma en ningún estado.
   */
  reporteFlota(flotaId: string, periodo: PeriodoReporte): Promise<DatosReporteFlota>;
}

export interface PeriodoReporte {
  /** Incluido. */
  inicio: Date;
  /** Excluido. */
  fin: Date;
}

export interface CobrosDeUnEstado {
  cantidad: number;
  centavos: number;
}

export interface DatosReporteFlota {
  viajesCompletados: number;
  cobros: { aprobados: CobrosDeUnEstado; pendientes: CobrosDeUnEstado; rechazados: CobrosDeUnEstado };
}

export interface TramoDeViaje {
  choferId: string;
  inicio: Date;
  fin: Date | null;
}

export interface OfertaConSolicitud {
  oferta: Oferta;
  solicitud: SolicitudViaje;
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
  /**
   * Los choferes con posición vigente más cercanos al origen, del más cercano al más lejano, hasta
   * `limite`. `completo`: el servicio devolvió tantos como se le pidieron, así que puede haber más
   * (se calcula con su respuesta original, antes de excluir o filtrar a nadie). Falla con su propio
   * error (503) si el servicio no responde.
   */
  buscar(origen: Coordenada, opciones: { limite: number }): Promise<{ candidatos: string[]; completo: boolean }>;
}

/**
 * Quién puede recibir una oferta (variante G). Lo decide dispatch en su base: location solo sabe de
 * posiciones.
 */
export interface ElegibilidadChoferes {
  /**
   * La zona operativa que cubre el punto, o null si no hay ninguna. Las zonas no se superponen; en un
   * borde compartido, la de menor id.
   */
  zonaDelOrigen(origen: Coordenada): Promise<string | null>;
  /**
   * De `ids`, los aptos para una oferta en la zona, en el mismo orden: habilitados, activos,
   * disponibles, sin viaje activo y de una flota con la zona habilitada.
   */
  aptos(ids: readonly string[], zonaId: string): Promise<string[]>;
  /**
   * Aviso de que cambiaron las zonas o las de una flota, después del COMMIT, para el caché de zonas:
   * el próximo pedido ya ve el cambio. No lanza. La aceptación no depende de esto: revalida con
   * Postgres en su transacción.
   */
  zonasCambiadas?(): Promise<void>;
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
  /**
   * Una búsqueda que terminó sin ningún apto: location no devolvió a nadie (`sin_candidatos`), los
   * devolvió pero el filtro los descartó a todos (`filtrados`), o descartó también los 100 más
   * cercanos, el tope por consulta (`tope_agotado`).
   */
  busquedaSinAptos?(motivo: 'sin_candidatos' | 'filtrados' | 'tope_agotado'): void;
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
  /**
   * Crea o cambia una zona. Las escrituras de zonas se serializan (advisory lock): dos zonas no pueden
   * quedar superpuestas aunque se guarden a la vez. `invalida`: PostGIS no acepta el polígono.
   */
  guardarZona(zona: DatosZona): Promise<{ resultado: 'ok' } | { resultado: 'invalida'; motivo: string } | { resultado: 'superpuesta'; con: string }>;
  /**
   * Reemplaza las zonas de la flota. Bloquea la flota (dos reemplazos se serializan). Quitar una zona
   * espera a las aceptaciones en curso que la usan (FOR SHARE). `zona_no_existe` si alguna no existe.
   */
  reemplazarZonasDeFlota(flotaId: string, zonas: readonly string[]): Promise<'ok' | 'flota_no_existe' | 'zona_no_existe'>;
  obtenerZona(id: string): Promise<DatosZona | null>;
  zonasDeFlota(flotaId: string): Promise<string[]>;
}

export interface RepositorioFlotas {
  /** Si el pedido trae Idempotency-Key, el registro va en esta misma transacción. */
  enTransaccion<T>(trabajo: (tx: TransaccionFlotas) => Promise<T>): Promise<T>;
  obtenerFlota(id: string): Promise<Flota | null>;
  obtenerChofer(id: string): Promise<ChoferFlota | null>;
  listarChoferes(flotaId: string, pagina: Pagina): Promise<ChoferFlota[]>;
  listarZonas(): Promise<DatosZona[]>;
  zonasDeFlota(flotaId: string): Promise<string[]>;
}

/** Un polígono simple en lng/lat: un anillo exterior cerrado (el primer punto se repite al final). */
export interface DatosZona {
  id: string;
  nombre: string;
  /** Anillo exterior como pares [lng, lat], igual que GeoJSON. */
  anillo: [number, number][];
}

/**
 * Cuentas de identity. dispatch no tiene la base de identity: le pregunta el rol de un id. null si la
 * cuenta no existe. El adaptador falla cerrado (503) si identity no responde.
 */
export interface DirectorioUsuarios {
  rolDe(usuarioId: string): Promise<string | null>;
}
