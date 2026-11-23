import { z } from 'zod';
import { Coordenada, EstadoSolicitud } from './dispatch.js';
import { ChoferFlotaRespuesta } from './flotas.js';

// Respuestas que lee el frontend. dispatch las tipa con estos esquemas (y los tests de integración
// las validan con `parse`): si el servidor y la web se separan, falla el typecheck o el test.

const centavos = z.number().int().min(0);
const Recorrido = z.strictObject({ metros: z.number().int().min(0), segundos: z.number().int().min(0) });

export const TarifaViajeRespuesta = z.strictObject({
  version: z.string().min(1),
  moneda: z.literal('ARS'),
  estimadaCentavos: centavos,
  recorridoEstimado: Recorrido,
  finalCentavos: centavos.nullable(),
  recorridoFinal: Recorrido.nullable(),
  motivosDiferencia: z.array(z.enum(['DISTANCIA', 'DURACION'])),
});

/** Una solicitud, como la devuelven `GET /solicitudes/:id`, aceptar una oferta y las acciones del viaje. */
export const SolicitudRespuesta = z.strictObject({
  id: z.uuid(),
  pasajeroId: z.uuid(),
  origen: Coordenada,
  destino: Coordenada,
  estado: EstadoSolicitud,
  choferId: z.uuid().nullable(),
  motivoCancelacion: z.string().nullable(),
  tarifa: TarifaViajeRespuesta.nullable(),
  /** Crece con cada cambio de la solicitud: entre dos lecturas del mismo viaje, la mayor es la más nueva. */
  version: z.number().int().min(0),
});
export type SolicitudRespuesta = z.infer<typeof SolicitudRespuesta>;

/** Una oferta todavía aceptable, con lo que el chofer necesita para decidir. */
export const OfertaPendiente = z.strictObject({
  ofertaId: z.uuid(),
  solicitudId: z.uuid(),
  venceEn: z.iso.datetime(),
  origen: Coordenada,
  destino: Coordenada,
  /** null solo en una solicitud creada antes de que se guardara la estimación. */
  tarifaEstimadaCentavos: centavos.nullable(),
});
export type OfertaPendiente = z.infer<typeof OfertaPendiente>;

/**
 * `GET /chofer/estado`: todo lo que la pantalla del chofer necesita releer, del chofer del token.
 * - `ahora`: la hora del servidor, para contar el vencimiento de las ofertas con su reloj;
 * - `registro`: su registro en la flota, o null si todavía no está en ninguna;
 * - `viaje`: el viaje activo (ASIGNADO, EN_CAMINO o EN_CURSO), o null;
 * - `ofertas`: las pendientes y sin vencer de solicitudes que siguen buscando, la que vence primero adelante.
 */
export const EstadoChoferRespuesta = z.strictObject({
  ahora: z.iso.datetime(),
  registro: ChoferFlotaRespuesta.nullable(),
  viaje: SolicitudRespuesta.nullable(),
  ofertas: z.array(OfertaPendiente),
});
export type EstadoChoferRespuesta = z.infer<typeof EstadoChoferRespuesta>;
