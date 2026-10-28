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

export const EstadoSolicitud = z.enum(['BUSCANDO', 'ASIGNADO', 'CANCELADO_PASAJERO', 'SIN_CHOFERES', 'COMPLETADA']);

// Payloads de los eventos que dispatch escribe en su outbox.
export const EventosDispatch = {
  RideRequested: z.strictObject({ solicitudId: z.uuid(), pasajeroId: z.uuid(), origen: Coordenada, destino: Coordenada }),
  OfferCreated: z.strictObject({ ofertaId: z.uuid(), solicitudId: z.uuid(), choferId: z.uuid(), venceEn: z.iso.datetime() }),
  OfferExpired: z.strictObject({ ofertaId: z.uuid(), solicitudId: z.uuid(), choferId: z.uuid() }),
  TripAssigned: z.strictObject({ solicitudId: z.uuid(), pasajeroId: z.uuid(), choferId: z.uuid(), origen: Coordenada, destino: Coordenada }),
  RideCancelled: z.strictObject({ solicitudId: z.uuid(), pasajeroId: z.uuid(), choferId: z.uuid().nullable(), estabaAsignada: z.boolean() }),
  NoDriversFound: z.strictObject({ solicitudId: z.uuid(), pasajeroId: z.uuid() }),
  RideCompleted: z.strictObject({ solicitudId: z.uuid(), choferId: z.uuid() }),
} as const;

export type TipoEventoDispatch = keyof typeof EventosDispatch;
export type PayloadEventoDispatch<T extends TipoEventoDispatch> = z.infer<(typeof EventosDispatch)[T]>;
