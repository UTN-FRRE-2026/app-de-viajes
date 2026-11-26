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
export type EstadoSolicitud = z.infer<typeof EstadoSolicitud>;

// En la query todo llega como texto (y un parámetro repetido llega como lista: se rechaza).
const entero = (min: number, max: number) =>
  z.string().trim().min(1).pipe(z.coerce.number()).pipe(z.number().int().min(min).max(max));

export const LIMITE_LISTADO_MAX = 50;

/** Paginación por desplazamiento: `desde` es cuántos viajes saltear. */
export const Pagina = {
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

// Un número decimal en la query (llega como texto). Vacío, no numérico o repetido: se rechaza.
const decimal = (min: number, max: number) =>
  z.string().trim().min(1).pipe(z.coerce.number()).pipe(z.number().finite().min(min).max(max));

/** Estimación de tarifa: es una consulta sin efectos, por eso va por GET y sin Idempotency-Key. */
export const EstimacionQuery = z.strictObject({
  origenLat: decimal(-90, 90),
  origenLng: decimal(-180, 180),
  destinoLat: decimal(-90, 90),
  destinoLng: decimal(-180, 180),
});
export type EstimacionQuery = z.infer<typeof EstimacionQuery>;

const centavos = z.number().int().min(0);

export const EstimacionRespuesta = z.strictObject({
  tarifaCentavos: centavos,
  moneda: z.literal('ARS'),
  distanciaMetros: z.number().int().min(0),
  duracionSegundos: z.number().int().min(0),
  desglose: z.strictObject({
    bajadaCentavos: centavos,
    recorridoCentavos: centavos,
    subtotalCentavos: centavos,
    minimoCentavos: centavos,
    minimoAplicado: z.boolean(),
  }),
  tarifaVersion: z.string().min(1),
});
export type EstimacionRespuesta = z.infer<typeof EstimacionRespuesta>;

/** La ruta por las calles entre dos puntos, para dibujarla en el mapa. Consulta sin efectos: GET. */
export const RutaQuery = EstimacionQuery;
export type RutaQuery = EstimacionQuery;

export const RutaRespuesta = z.strictObject({
  distanciaMetros: z.number().int().min(0),
  duracionSegundos: z.number().int().min(0),
  /** El recorrido, en orden: pares [lat, lng]. Al menos el origen y el destino. */
  puntos: z.array(z.tuple([z.number(), z.number()])).min(2),
  /** `calles`: el ruteo real. `recta`: el ruteo no respondió y la ruta es la línea recta aproximada. */
  fuente: z.enum(['calles', 'recta']),
});
export type RutaRespuesta = z.infer<typeof RutaRespuesta>;

/**
 * Límites de la tarifa: dejan todos los cálculos holgadamente dentro de los enteros seguros de
 * JavaScript. Los usan el contrato del admin, el dominio de dispatch y su configuración.
 */
export const TOPE_IMPORTE_CENTAVOS = 100_000_000; // $1.000.000
export const TOPE_MAX_METROS = 1_000_000; // 1000 km

const importe = z.number().int().min(0).max(TOPE_IMPORTE_CENTAVOS);

/**
 * PUT /admin/tarifas: reemplaza la tarifa completa. Los cinco campos son obligatorios, enteros y
 * dentro de los límites; cualquier otro campo (moneda, versión, autor) se rechaza: los pone el servidor.
 */
export const ConfigurarTarifaBody = z.strictObject({
  bajadaCentavos: importe,
  centavosPorKm: importe,
  centavosPorMinuto: importe,
  minimoCentavos: importe,
  maxMetros: z.number().int().min(1).max(TOPE_MAX_METROS),
});
export type ConfigurarTarifaBody = z.infer<typeof ConfigurarTarifaBody>;

/** GET y PUT /admin/tarifas: la tarifa vigente con su versión y quién la dejó así. */
export const TarifaAdminRespuesta = z.strictObject({
  version: z.string().regex(/^v[1-9][0-9]*$/),
  moneda: z.literal('ARS'),
  ...ConfigurarTarifaBody.shape,
  /** El `sub` del admin que la configuró, o `semilla` para la versión inicial tomada del entorno. */
  actualizadaPor: z.string().min(1),
  actualizadaEn: z.iso.datetime(),
});
export type TarifaAdminRespuesta = z.infer<typeof TarifaAdminRespuesta>;

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
  // null solo en un viaje creado antes de que se guardara la estimación.
  RideCompleted: PartesDelViaje.extend({ tarifaFinalCentavos: z.number().int().min(0).nullable() }),
  PaymentCaptured: z.strictObject({
    cobroId: z.uuid(),
    solicitudId: z.uuid(),
    pasajeroId: z.uuid(),
    montoCentavos: z.number().int().min(0),
    moneda: z.literal('ARS'),
    referencia: z.string(),
  }),
  PaymentDeclined: z.strictObject({
    cobroId: z.uuid(),
    solicitudId: z.uuid(),
    pasajeroId: z.uuid(),
    montoCentavos: z.number().int().min(0),
    moneda: z.literal('ARS'),
    referencia: z.string(),
    motivo: z.string(),
  }),
} as const;

export type TipoEventoDispatch = keyof typeof EventosDispatch;
export type PayloadEventoDispatch<T extends TipoEventoDispatch> = z.infer<(typeof EventosDispatch)[T]>;

// --- Tramos de viaje, para la retención del historial de location (docs/location.md#retención-del-historial) ---

/** Tope de choferes por consulta: acota el pedido y la consulta; location parte sus lotes en grupos así. */
export const TRAMOS_CHOFERES_MAX = 1000;

const InstanteTramo = z.iso.datetime({ offset: true });

/**
 * `POST /interno/tramos-viaje` (location → dispatch, con token de servicio): los viajes de esos choferes
 * que se superponen con [desde, hasta]. Es una consulta: no tiene efecto ni Idempotency-Key.
 */
export const TramosViajeBody = z
  .strictObject({
    choferes: z.array(z.uuid()).min(1).max(TRAMOS_CHOFERES_MAX),
    desde: InstanteTramo,
    hasta: InstanteTramo,
  })
  .refine(({ desde, hasta }) => Date.parse(desde) < Date.parse(hasta), { message: 'desde tiene que ser anterior a hasta', path: ['hasta'] });
export type TramosViajeBody = z.infer<typeof TramosViajeBody>;

/**
 * Un tramo: desde que el chofer recibió la oferta que aceptó hasta que el viaje terminó (completado o
 * cancelado). `fin` es null si el viaje sigue activo.
 */
export const TramoViaje = z.strictObject({ choferId: z.uuid(), inicio: InstanteTramo, fin: InstanteTramo.nullable() });
export type TramoViaje = z.infer<typeof TramoViaje>;

export const TramosViajeRespuesta = z.strictObject({ tramos: z.array(TramoViaje) });
export type TramosViajeRespuesta = z.infer<typeof TramosViajeRespuesta>;
