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

const PartesDelViaje = z.strictObject({ solicitudId: z.uuid(), pasajeroId: z.uuid(), choferId: z.uuid() });

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
