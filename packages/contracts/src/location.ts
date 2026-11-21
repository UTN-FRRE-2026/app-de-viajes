import { z } from 'zod';
import { Coordenada } from './dispatch.js';

// Contrato de location. Lo usan location (valida lo que recibe) y dispatch (valida lo que le devuelven).

/** El chofer informa su posición. El chofer sale del token, nunca del body. */
export const UbicacionBody = Coordenada;
export type UbicacionBody = z.infer<typeof UbicacionBody>;

/** Encabezado del token de servicio de las rutas `/interno/*` (en minúsculas, como lo lee Express). */
export const ENCABEZADO_TOKEN_SERVICIO = 'x-token-servicio';

export const LIMITE_CANDIDATOS_MAX = 100;
export const RADIO_MAX_METROS = 50_000;

// En la query todo llega como texto. Un valor vacío no puede convertirse en 0: lat=0 es una coordenada válida.
const numero = () => z.string().trim().min(1).pipe(z.coerce.number());

export const CandidatosQuery = z.strictObject({
  lat: numero().pipe(z.number().min(-90).max(90)),
  lng: numero().pipe(z.number().min(-180).max(180)),
  limite: numero().pipe(z.number().int().min(1).max(LIMITE_CANDIDATOS_MAX)).default(10),
  radioMetros: numero().pipe(z.number().int().min(1).max(RADIO_MAX_METROS)).default(5000),
});
export type CandidatosQuery = z.infer<typeof CandidatosQuery>;

export const Candidato = z.strictObject({
  choferId: z.uuid(),
  distanciaMetros: z.number().int().nonnegative(),
  actualizadaEn: z.iso.datetime(),
});

/**
 * Ordenados de menor a mayor distancia. Si vienen menos que `limite`, no hay más choferes vigentes
 * dentro del radio: dispatch puede dejar de pedir.
 */
export const CandidatosRespuesta = z.strictObject({ candidatos: z.array(Candidato) });
export type CandidatosRespuesta = z.infer<typeof CandidatosRespuesta>;

/**
 * Posición en vivo de un chofer. location la publica por Redis Pub/Sub en el canal de ese chofer
 * cada vez que registra un ping, y dispatch la reenvía por SSE al pasajero del viaje activo.
 *
 * - Es efímera: no tiene `seq`, no se guarda y no se repone. Quien se suscribe recibe la próxima.
 * - Orden: en cada canal, `actualizadaEn` no retrocede respecto de la última publicación mientras
 *   exista su marca en Redis (ver docs/location.md, «Posición en vivo»).
 * - `actualizadaEn` es la hora del servidor de location al recibir el ping, como en `Candidato`.
 */
export const TIPO_POSICION_CHOFER = 'DriverLocationUpdated';

export const PosicionChoferPublicada = z.strictObject({
  tipo: z.literal(TIPO_POSICION_CHOFER),
  choferId: z.uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  actualizadaEn: z.iso.datetime(),
});
export type PosicionChoferPublicada = z.infer<typeof PosicionChoferPublicada>;

/**
 * Canal de Redis de un chofer: `<prefijo>posicion:<choferId>`. El prefijo es el `LOCATION_REDIS_PREFIJO`
 * de location (`location:` en desarrollo, `carga:location:` en el entorno de k6): Pub/Sub no separa por
 * número de base, así que sin prefijo los tests y el desarrollo compartirían canales.
 * Hay que suscribirse con SUBSCRIBE al canal de cada chofer, no con PSUBSCRIBE a todos.
 */
export const canalPosicionChofer = (prefijo: string, choferId: string) => `${prefijo}posicion:${choferId}`;
