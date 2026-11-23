import type { ChoferFlotaRespuesta, EstadoSolicitud, PayloadEventoDispatch } from '@viajes/contracts';
import { ErrorApi } from '../../api/errores';
import { ESTADOS_CON_CHOFER, type EstadoChoferRespuesta, type OfertaPendiente, type Solicitud } from '../../viaje/viaje';

// La lógica de la pantalla del chofer, sin React ni red: cómo se aplican las lecturas de
// `GET /chofer/estado`, las respuestas de las acciones y los eventos del SSE. Se testea sola.

export type AccionViaje = 'en-camino' | 'iniciar' | 'finalizar';

/** El único botón de cada estado del viaje. */
export const SIGUIENTE: Partial<Record<EstadoSolicitud, { accion: AccionViaje; texto: string }>> = {
  ASIGNADO: { accion: 'en-camino', texto: 'Voy en camino' },
  EN_CAMINO: { accion: 'iniciar', texto: 'Inició el viaje' },
  EN_CURSO: { accion: 'finalizar', texto: 'Finalizar' },
};

/**
 * Una operación con efecto, con su `Idempotency-Key`. `incierta`: falló sin respuesta definitiva (red,
 * 5xx, la misma clave en curso) y no se sabe si se aplicó. Se conserva, con su clave, hasta que una
 * lectura muestre el resultado o un reintento con la MISMA clave dé una respuesta.
 */
interface Operacion {
  clave: string;
  fase: 'enviando' | 'incierta';
  error: unknown;
}

/** Aceptar una oferta. Guarda la oferta: la tarjeta puede desaparecer (vence) y la operación sigue. */
export interface Aceptacion extends Operacion {
  oferta: OfertaPendiente;
}

export interface OperacionViaje extends Operacion {
  accion: AccionViaje;
  solicitudId: string;
  /** El estado desde el que se pidió: si una lectura muestra otro, la acción ya se aplicó. */
  desde: EstadoSolicitud;
}

/** `PassengerLocationUpdated` en el stream del chofer (docs/eventos.md): sin `id:`, efímera. */
export interface PosicionPasajero {
  solicitudId: string;
  pasajeroId: string;
  lat: number;
  lng: number;
  actualizadaEn: string;
}

export interface EstadoChofer {
  /** Ya llegó la primera lectura. */
  cargado: boolean;
  errorLectura: unknown;
  registro: ChoferFlotaRespuesta | null;
  viaje: Solicitud | null;
  ofertas: OfertaPendiente[];
  /** Hora del servidor menos la del navegador: el vencimiento de las ofertas se cuenta con el reloj del servidor. */
  desfaseMs: number;
  posicionPasajero: PosicionPasajero | null;
  /** Un aviso para el chofer: la oferta venció, el pasajero canceló, el viaje ya había cambiado. */
  aviso: string | null;
  /** El viaje que el chofer acaba de finalizar, para el resumen con la tarifa final. */
  terminado: Solicitud | null;
  aceptacion: Aceptacion | null;
  operacion: OperacionViaje | null;
  /**
   * La marca de la última respuesta de una acción (aceptar, avanzar, cambiar la disponibilidad). Las
   * marcas salen de un contador creciente: una lectura que empezó antes que esta es vieja.
   */
  ultimaMutacion: number;
}

export const ESTADO_INICIAL: EstadoChofer = {
  cargado: false,
  errorLectura: null,
  registro: null,
  viaje: null,
  ofertas: [],
  desfaseMs: 0,
  posicionPasajero: null,
  aviso: null,
  terminado: null,
  aceptacion: null,
  operacion: null,
  ultimaMutacion: 0,
};

const conChofer = (s: Solicitud) => ESTADOS_CON_CHOFER.includes(s.estado);

/** Entre dos versiones del MISMO viaje se queda con la más nueva. De viajes distintos, con `nuevo`. */
function masNuevo(actual: Solicitud | null, nuevo: Solicitud | null): Solicitud | null {
  if (nuevo && actual && nuevo.id === actual.id && nuevo.version < actual.version) return actual;
  return nuevo;
}

export interface Momento {
  /** La marca con la que empezó la lectura. */
  inicio: number;
  /** `Date.now()` al enviarla y al recibirla. */
  enviadaEn: number;
  recibidaEn: number;
}

/**
 * Aplica una lectura de `GET /chofer/estado`.
 * - **Lectura atrasada:** si empezó antes de la última respuesta de una acción, se descarta entera
 *   (`descartada`: hay que pedir otra). Si no, un GET lento que salió antes de aceptar podría volver
 *   con `viaje: null` y borrar el viaje recién aceptado.
 * - Una lectura que empezó después se aplica tal cual: puede mostrar que el viaje terminó o cambió.
 *   El `version` solo se compara dentro del mismo viaje.
 * - Una aceptación incierta se resuelve si el viaje de su solicitud aparece; si no, se conserva.
 */
export function aplicarLectura(e: EstadoChofer, r: EstadoChoferRespuesta, m: Momento): { estado: EstadoChofer; descartada: boolean } {
  if (m.inicio < e.ultimaMutacion) return { estado: e, descartada: true };

  const viaje = masNuevo(e.viaje, r.viaje);
  let aviso = e.aviso;
  if (e.viaje && viaje?.id !== e.viaje.id && e.terminado?.id !== e.viaje.id && !aviso) {
    aviso = 'El viaje ya no está activo: se canceló o terminó.';
  }

  let aceptacion = e.aceptacion;
  if (aceptacion && viaje?.id === aceptacion.oferta.solicitudId) aceptacion = null;

  let operacion = e.operacion;
  if (operacion?.fase === 'incierta' && (viaje?.id !== operacion.solicitudId || viaje.estado !== operacion.desde)) {
    // La acción se aplicó (el viaje cambió de estado o terminó): no hay nada que reintentar.
    if (operacion.accion === 'finalizar' && !viaje) aviso = 'Viaje finalizado.';
    operacion = null;
  }

  const posicionPasajero = viaje && e.posicionPasajero?.solicitudId === viaje.id ? e.posicionPasajero : null;
  return {
    descartada: false,
    estado: {
      ...e,
      cargado: true,
      errorLectura: null,
      registro: r.registro,
      viaje,
      ofertas: viaje ? [] : r.ofertas,
      desfaseMs: Date.parse(r.ahora) - (m.enviadaEn + m.recibidaEn) / 2,
      posicionPasajero,
      aviso,
      aceptacion,
      operacion,
    },
  };
}

/** Aplica la respuesta de aceptar o de una acción del viaje, con la marca de cuando llegó. */
export function aplicarRespuesta(e: EstadoChofer, s: Solicitud, marca: number): EstadoChofer {
  const base = { ...e, ultimaMutacion: marca };
  if (conChofer(s)) {
    const viaje = masNuevo(e.viaje, s);
    return { ...base, viaje, ofertas: [], terminado: null, posicionPasajero: viaje?.id === e.posicionPasajero?.solicitudId ? e.posicionPasajero : null };
  }
  if (s.estado === 'COMPLETADA') return { ...base, viaje: null, terminado: s, posicionPasajero: null };
  return { ...base, viaje: e.viaje?.id === s.id ? null : e.viaje };
}

/** Lo que el stream avisa que cambió: la pantalla relee (`releer`) o, con la posición, la aplica directo. */
const RELEEN = new Set(['OfferCreated', 'OfferExpired', 'TripAssigned', 'DriverEnRoute', 'TripStarted', 'RideCompleted', 'RideCancelled']);

const QUIEN: Record<PayloadEventoDispatch<'RideCancelled'>['canceladoPor'], string> = {
  pasajero: 'El pasajero canceló el viaje',
  operador: 'Un operador canceló el viaje',
  chofer: 'Cancelaste el viaje',
};

export function aplicarEvento(e: EstadoChofer, tipo: string, datos: unknown): { estado: EstadoChofer; releer: boolean } {
  if (tipo === 'PassengerLocationUpdated') {
    const p = datos as PosicionPasajero;
    const vieja = e.posicionPasajero && Date.parse(p.actualizadaEn) <= Date.parse(e.posicionPasajero.actualizadaEn);
    if (!e.viaje || p.solicitudId !== e.viaje.id || vieja) return { estado: e, releer: false };
    return { estado: { ...e, posicionPasajero: p }, releer: false };
  }
  if (!RELEEN.has(tipo)) return { estado: e, releer: false };
  if (tipo === 'OfferExpired') {
    const { ofertaId } = datos as PayloadEventoDispatch<'OfferExpired'>;
    return { estado: { ...e, ofertas: e.ofertas.filter((o) => o.ofertaId !== ofertaId) }, releer: true };
  }
  if (tipo === 'RideCancelled') {
    const d = datos as PayloadEventoDispatch<'RideCancelled'>;
    if (e.viaje?.id === d.solicitudId) {
      return { estado: { ...e, aviso: `${QUIEN[d.canceladoPor]}${d.motivo ? `: ${d.motivo}` : '.'}` }, releer: true };
    }
  }
  return { estado: e, releer: true };
}

/** Cuánto le falta a la oferta, medido con el reloj del servidor. */
export const restanteMs = (o: OfertaPendiente, ahora: number, desfaseMs: number) => Date.parse(o.venceEn) - (ahora + desfaseMs);

/** Una oferta vencida se sigue mostrando un momento, como «Venció», y después sale. */
export const MOSTRAR_VENCIDA_MS = 2_000;

/** Las ofertas para la lista: sin la que se está aceptando (va aparte) y sin las vencidas hace rato. */
export function ofertasVisibles(e: EstadoChofer, ahora: number): OfertaPendiente[] {
  return e.ofertas.filter(
    (o) => o.ofertaId !== e.aceptacion?.oferta.ofertaId && restanteMs(o, ahora, e.desfaseMs) > -MOSTRAR_VENCIDA_MS,
  );
}

/** El texto de un rechazo definitivo al aceptar, o null si no es uno conocido. */
export function textoRechazoAceptacion(err: unknown): string | null {
  if (!(err instanceof ErrorApi)) return null;
  switch (err.codigo) {
    case 'OFERTA_VENCIDA':
      return 'La oferta venció antes de que se aceptara.';
    case 'SOLICITUD_NO_DISPONIBLE':
      return 'Otro chofer tomó el viaje o el pasajero lo canceló.';
    case 'CHOFER_CON_VIAJE_ACTIVO':
      return 'Ya tenés un viaje activo.';
    case 'OFERTA_NO_ENCONTRADA':
      return 'La oferta ya no existe.';
    default:
      return null;
  }
}
