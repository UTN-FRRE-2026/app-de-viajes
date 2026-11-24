import type { EstadoSolicitud, PayloadEventoDispatch } from '@viajes/contracts';
import { ErrorApi } from '../../api/errores';
import { ESTADOS_CON_CHOFER, pesos, type Punto, type Solicitud } from '../../viaje/viaje';

// La lógica de la pantalla del pasajero, sin React ni red: la línea de tiempo del viaje, y cómo se
// aplican las lecturas del historial, las respuestas de las acciones y los eventos del SSE.

/** Un viaje del historial (`GET /historial`): la solicitud más cuándo se creó. */
export type ViajeResumen = Solicitud & { creadaEn: string };

export interface ListadoViajes {
  viajes: ViajeResumen[];
  /** `desde` para la página siguiente, o null si no hay más. */
  siguiente: number | null;
}

/** `POST /solicitudes/:id/cobrar` (también devuelve el cobro como está si ya se resolvió). */
export interface Cobro {
  id: string;
  solicitudId: string;
  montoCentavos: number;
  estado: 'PENDIENTE' | 'APROBADO' | 'RECHAZADO';
  motivoRechazo: string | null;
}

/** `DriverLocationUpdated` en el stream del pasajero (docs/eventos.md): sin `id:`, efímera. */
export interface PosicionChofer {
  solicitudId: string;
  choferId: string;
  lat: number;
  lng: number;
  actualizadaEn: string;
}

/** Los pasos de un viaje que sale bien, en orden. */
export const PASOS = [
  { paso: 'pedido', titulo: 'Pedido' },
  { paso: 'asignado', titulo: 'Chofer asignado' },
  { paso: 'en-camino', titulo: 'En camino a buscarte' },
  { paso: 'en-viaje', titulo: 'En viaje' },
  { paso: 'terminado', titulo: 'Terminado' },
  { paso: 'cobrado', titulo: 'Cobrado' },
] as const;

export type Paso = (typeof PASOS)[number]['paso'];

const PASO_DE_ESTADO: Partial<Record<EstadoSolicitud, Paso>> = {
  BUSCANDO: 'pedido',
  ASIGNADO: 'asignado',
  EN_CAMINO: 'en-camino',
  EN_CURSO: 'en-viaje',
  COMPLETADA: 'terminado',
};

/** El evento del SSE que marca cada paso. */
const PASO_DE_EVENTO: Record<string, Paso> = {
  RideRequested: 'pedido',
  TripAssigned: 'asignado',
  DriverEnRoute: 'en-camino',
  TripStarted: 'en-viaje',
  RideCompleted: 'terminado',
  PaymentCaptured: 'cobrado',
};

export const ESTADOS_ACTIVOS: readonly EstadoSolicitud[] = ['BUSCANDO', ...ESTADOS_CON_CHOFER];
export const esActivo = (s: Solicitud) => ESTADOS_ACTIVOS.includes(s.estado);

/** Una operación con efecto y su `Idempotency-Key` (`incierta`: no se sabe si se aplicó). */
export interface Operacion {
  clave: string;
  fase: 'enviando' | 'incierta';
  error: unknown;
}

export interface Pedido extends Operacion {
  origen: Punto;
  destino: Punto;
}

export interface EstadoPasajero {
  /** Ya llegó la primera lectura. */
  cargado: boolean;
  errorLectura: unknown;
  /** El viaje en pantalla: el activo, o el que acaba de terminar hasta que el pasajero lo cierra. */
  viaje: Solicitud | null;
  /** Cuándo se pidió, con el reloj del servidor (del historial), si se sabe. */
  creadaEn: string | null;
  /**
   * Cuándo llegó cada paso en vivo (ms, reloj del navegador), y `final` el de la cancelación o el
   * «sin choferes». Lo que pasó antes de abrir la pantalla no tiene hora.
   */
  horas: Partial<Record<Paso | 'final', number>>;
  posicionChofer: PosicionChofer | null;
  cobro: Cobro | null;
  /** Un aviso: el chofer o un operador canceló, la acción ya no aplicaba. */
  aviso: string | null;
  pedido: Pedido | null;
  cancelacion: (Operacion & { solicitudId: string }) | null;
  /** La marca de la última respuesta de una acción: una lectura que empezó antes es vieja. */
  ultimaMutacion: number;
}

export const ESTADO_INICIAL: EstadoPasajero = {
  cargado: false,
  errorLectura: null,
  viaje: null,
  creadaEn: null,
  horas: {},
  posicionChofer: null,
  cobro: null,
  aviso: null,
  pedido: null,
  cancelacion: null,
  ultimaMutacion: 0,
};

/** Entre dos versiones del MISMO viaje se queda con la más nueva. De viajes distintos, con `nuevo`. */
function masNuevo(actual: Solicitud | null, nuevo: Solicitud | null): Solicitud | null {
  if (nuevo && actual && nuevo.id === actual.id && nuevo.version < actual.version) return actual;
  return nuevo;
}

/** Cambia el viaje en pantalla: si es otro, se descarta lo que era del anterior (horas, posición, cobro). */
function conViaje(e: EstadoPasajero, viaje: Solicitud | null, creadaEn: string | null): EstadoPasajero {
  if (viaje?.id === e.viaje?.id) {
    const sigue = viaje && ESTADOS_CON_CHOFER.includes(viaje.estado);
    return { ...e, viaje, creadaEn: creadaEn ?? e.creadaEn, posicionChofer: sigue ? e.posicionChofer : null };
  }
  return { ...e, viaje, creadaEn, horas: {}, posicionChofer: null, cobro: null };
}

/**
 * Aplica la primera página de `GET /historial` (los más nuevos primero; un pasajero tiene como mucho
 * un viaje activo, así que, si hay, es el primero).
 * - Una lectura que empezó antes de la última respuesta de una acción se descarta (`descartada`).
 * - Si hay uno activo, ese es el viaje.
 * - Si no, y el de la pantalla figura terminado, se queda con su estado final hasta que el pasajero
 *   lo cierre (así ve la tarifa final o el motivo de la cancelación).
 */
export function aplicarLectura(e: EstadoPasajero, viajes: ViajeResumen[], inicio: number): { estado: EstadoPasajero; descartada: boolean } {
  if (inicio < e.ultimaMutacion) return { estado: e, descartada: true };
  const base = { ...e, cargado: true, errorLectura: null };
  const activo = viajes.find(esActivo) ?? null;
  if (activo) {
    const viaje = masNuevo(e.viaje, activo);
    const estado = conViaje(base, viaje, activo.creadaEn);
    // El pedido incierto se resuelve si ya existe el viaje.
    return { estado: { ...estado, pedido: null }, descartada: false };
  }
  const mismo = e.viaje && viajes.find((v) => v.id === e.viaje!.id);
  let estado = mismo ? conViaje(base, masNuevo(e.viaje, mismo), mismo.creadaEn) : conViaje(base, null, null);
  // La cancelación incierta se resuelve si el viaje ya no está activo.
  if (estado.cancelacion && (!estado.viaje || !esActivo(estado.viaje))) estado = { ...estado, cancelacion: null };
  return { estado, descartada: false };
}

/** Aplica la respuesta de pedir o de cancelar, con la marca de cuando llegó. */
export function aplicarRespuesta(e: EstadoPasajero, s: Solicitud, marca: number, ahora: number): EstadoPasajero {
  const estado = conViaje({ ...e, ultimaMutacion: marca }, masNuevo(e.viaje, s), null);
  const paso = PASO_DE_ESTADO[s.estado] ?? (TITULO_FINAL[s.estado] ? 'final' : undefined);
  const horas = paso && estado.horas[paso] === undefined ? { ...estado.horas, [paso]: ahora } : estado.horas;
  return { ...estado, horas };
}

/**
 * Un evento del SSE. Los eventos avisan; la verdad está en la API: los que cambian el viaje piden
 * releer (`releer`). Si son del viaje en pantalla, además marcan la hora de su paso (la cancelación y
 * el «sin choferes», la del paso final: quién canceló y por qué los dice la línea de tiempo). La
 * posición del chofer se aplica directo, solo la de este viaje y si es más nueva que la última.
 */
export function aplicarEvento(e: EstadoPasajero, tipo: string, datos: unknown, ahora: number): { estado: EstadoPasajero; releer: boolean } {
  const solicitudId = (datos as { solicitudId?: unknown } | null)?.solicitudId;
  const delViaje = e.viaje !== null && solicitudId === e.viaje.id;

  if (tipo === 'DriverLocationUpdated') {
    const p = datos as PosicionChofer;
    const vieja = e.posicionChofer && Date.parse(p.actualizadaEn) <= Date.parse(e.posicionChofer.actualizadaEn);
    if (!delViaje || vieja || !ESTADOS_CON_CHOFER.includes(e.viaje!.estado)) return { estado: e, releer: false };
    return { estado: { ...e, posicionChofer: p }, releer: false };
  }

  if (tipo === 'PaymentCaptured' || tipo === 'PaymentDeclined') {
    if (!delViaje) return { estado: e, releer: false };
    const d = datos as PayloadEventoDispatch<'PaymentCaptured'> & { motivo?: string };
    const cobro: Cobro = {
      id: d.cobroId,
      solicitudId: d.solicitudId,
      montoCentavos: d.montoCentavos,
      estado: tipo === 'PaymentCaptured' ? 'APROBADO' : 'RECHAZADO',
      motivoRechazo: d.motivo ?? null,
    };
    const horas = tipo === 'PaymentCaptured' ? { ...e.horas, cobrado: e.horas.cobrado ?? ahora } : e.horas;
    return { estado: { ...e, cobro, horas }, releer: false };
  }

  const paso = PASO_DE_EVENTO[tipo];
  const cambia = paso !== undefined || tipo === 'RideCancelled' || tipo === 'NoDriversFound';
  if (!cambia) return { estado: e, releer: false };
  if (!delViaje) return { estado: e, releer: true };

  const marca = paso ?? 'final';
  const estado = e.horas[marca] === undefined ? { ...e, horas: { ...e.horas, [marca]: ahora } } : e;
  return { estado, releer: true };
}

export type EstadoPaso = 'hecho' | 'actual' | 'pendiente' | 'fallo';

export interface ItemLinea {
  clave: string;
  titulo: string;
  estado: EstadoPaso;
  /** Cuándo llegó (ms), si se vio en vivo. */
  hora: number | null;
  /** Texto chico: «en 7 s», el motivo de una cancelación, el rechazo del cobro. */
  detalle: string | null;
}

const TITULO_FINAL: Partial<Record<EstadoSolicitud, string>> = {
  CANCELADO_PASAJERO: 'Cancelaste el viaje',
  CANCELADO_CHOFER: 'El chofer canceló',
  CANCELADO_OPERADOR: 'Un operador canceló',
  SIN_CHOFERES: 'No hubo choferes disponibles',
};

const segundosEntre = (desde: number | null | undefined, hasta: number | null | undefined) =>
  desde != null && hasta != null && hasta >= desde ? `en ${Math.max(1, Math.round((hasta - desde) / 1000))} s` : null;

/**
 * La línea de tiempo del viaje en pantalla. Un viaje que sale bien recorre los seis pasos; uno
 * cancelado o sin choferes termina en un paso en rojo con el motivo, después de los que alcanzó.
 */
export function lineaDeTiempo(e: EstadoPasajero): ItemLinea[] {
  const v = e.viaje;
  if (!v) return [];
  const horaPedido = e.horas.pedido ?? (e.creadaEn ? Date.parse(e.creadaEn) : null);
  const hora = (p: Paso) => (p === 'pedido' ? horaPedido : (e.horas[p] ?? null));

  const final = TITULO_FINAL[v.estado];
  if (final) {
    // Alcanzó «asignado» si tuvo chofer; los pasos siguientes, solo si se vieron en vivo.
    const alcanzados = PASOS.filter(
      ({ paso }) => paso === 'pedido' || (paso === 'asignado' && v.choferId !== null) || (paso !== 'asignado' && e.horas[paso] !== undefined),
    );
    return [
      ...alcanzados.map(({ paso, titulo }) => ({ clave: paso, titulo, estado: 'hecho' as const, hora: hora(paso), detalle: null })),
      { clave: 'final', titulo: final, estado: 'fallo', hora: e.horas.final ?? null, detalle: v.motivoCancelacion },
    ];
  }

  const actual = PASO_DE_ESTADO[v.estado]!;
  const indiceActual = PASOS.findIndex((p) => p.paso === actual);
  return PASOS.map(({ paso, titulo }, i) => {
    let estado: EstadoPaso = i < indiceActual ? 'hecho' : i === indiceActual ? 'actual' : 'pendiente';
    let detalle: string | null = null;
    if (paso === 'terminado' && estado === 'actual') estado = 'hecho';
    if (paso === 'cobrado' && v.estado === 'COMPLETADA') {
      if (e.cobro?.estado === 'APROBADO') estado = 'hecho';
      else if (e.cobro?.estado === 'RECHAZADO') {
        estado = 'fallo';
        detalle = e.cobro.motivoRechazo ? `Rechazado: ${e.cobro.motivoRechazo}` : 'Rechazado';
      } else estado = 'actual';
    }
    if (paso === 'asignado') detalle = segundosEntre(horaPedido, e.horas.asignado);
    if (paso === 'pedido' && estado === 'actual') detalle = 'Buscando chofer…';
    return { clave: paso, titulo, estado, hora: hora(paso), detalle };
  });
}

/** El importe de un viaje en una lista: el final, o el estimado mientras no terminó. Uno cancelado no se cobra. */
export function textoImporte(v: Solicitud): string {
  if (TITULO_FINAL[v.estado]) return 'Sin cargo';
  if (!v.tarifa) return '—';
  return v.tarifa.finalCentavos !== null ? pesos(v.tarifa.finalCentavos) : `${pesos(v.tarifa.estimadaCentavos)} (estimada)`;
}

/** El texto de un rechazo definitivo al pedir, o null si no es uno conocido. */
export function textoRechazoPedido(err: unknown): string | null {
  if (!(err instanceof ErrorApi)) return null;
  switch (err.codigo) {
    case 'SOLICITUD_ACTIVA_EXISTENTE':
      return 'Ya tenés un viaje en curso.';
    case 'ORIGEN_FUERA_DE_ZONA':
      return 'No hay servicio en ese origen: elegí un punto dentro de la zona de la demo.';
    case 'VIAJE_FUERA_DE_RANGO':
      return err.message;
    default:
      return null;
  }
}
