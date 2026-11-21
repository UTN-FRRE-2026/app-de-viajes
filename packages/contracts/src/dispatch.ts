import { z } from 'zod';

// Lista blanca: `strictObject` rechaza cualquier clave no declarada (incluidas `__proto__` y `constructor`).

export const Coordenada = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const CrearSolicitudBody = z.strictObject({
  origen: Coordenada,
  destino: Coordenada,
});
export type CrearSolicitudBody = z.infer<typeof CrearSolicitudBody>;

export const ParamsId = z.strictObject({ id: z.uuid() });

export const SinBody = z.strictObject({});

/** El motivo es opcional para pasajero y chofer; el operador lo tiene que mandar (lo exige el dominio). */
export const CancelarBody = z.strictObject({
  motivo: z.string().trim().min(3).max(200).optional(),
});
export type CancelarBody = z.infer<typeof CancelarBody>;

export const EstadoSolicitud = z.enum([
  'BUSCANDO',
  'ASIGNADO',
  'EN_CAMINO',
  'EN_CURSO',
  'COMPLETADA',
  'CANCELADO_PASAJERO',
  'CANCELADO_CHOFER',
  'CANCELADO_OPERADOR',
  'SIN_CHOFERES',
]);

// En la query todo llega como texto (y un parámetro repetido llega como lista: se rechaza).
const entero = (min: number, max: number) =>
  z.string().trim().min(1).pipe(z.coerce.number()).pipe(z.number().int().min(min).max(max));

export const LIMITE_LISTADO_MAX = 50;

/** Paginación por desplazamiento: `desde` es cuántos viajes saltear. */
const Pagina = {
  limite: entero(1, LIMITE_LISTADO_MAX).default(20),
  desde: entero(0, 10_000).default(0),
};

export const HistorialQuery = z.strictObject(Pagina);
export type HistorialQuery = z.infer<typeof HistorialQuery>;

/**
 * Panel del operador. Sin `estado`, muestra los viajes activos. `q` busca, sin distinguir
 * mayúsculas, en el id del viaje, del pasajero y del chofer, y en el motivo de cancelación.
 */
export const PanelQuery = z.strictObject({
  ...Pagina,
  estado: EstadoSolicitud.optional(),
  q: z.string().trim().min(1).max(100).optional(),
});
export type PanelQuery = z.infer<typeof PanelQuery>;

const PartesDelViaje =z.strictObject({ solicitudId: z.uuid(), pasajeroId: z.uuid(), choferId: z.uuid() });

// Payloads de los eventos que dispatch escribe en su outbox.
export const EventosDispatch = {
  RideRequested: z.strictObject({ solicitudId: z.uuid(), pasajeroId: z.uuid(), origen: Coordenada, destino: Coordenada }),
  OfferCreated: z.strictObject({ ofertaId: z.uuid(), solicitudId: z.uuid(), choferId: z.uuid(), venceEn: z.iso.datetime() }),
  OfferExpired: z.strictObject({ ofertaId: z.uuid(), solicitudId: z.uuid(), choferId: z.uuid() }),
  TripAssigned: z.strictObject({ solicitudId: z.uuid(), pasajeroId: z.uuid(), choferId: z.uuid(), origen: Coordenada, destino: Coordenada }),
  DriverEnRoute: PartesDelViaje,
  TripStarted: PartesDelViaje,
  RideCancelled: z.strictObject({
    solicitudId: z.uuid(),
    pasajeroId: z.uuid(),
    choferId: z.uuid().nullable(),
    estabaAsignada: z.boolean(),
    canceladoPor: z.enum(['pasajero', 'chofer', 'operador']),
    motivo: z.string().nullable(),
  }),
  NoDriversFound: z.strictObject({ solicitudId: z.uuid(), pasajeroId: z.uuid() }),
  RideCompleted: PartesDelViaje,
} as const;

export type TipoEventoDispatch = keyof typeof EventosDispatch;
export type PayloadEventoDispatch<T extends TipoEventoDispatch> = z.infer<(typeof EventosDispatch)[T]>;
