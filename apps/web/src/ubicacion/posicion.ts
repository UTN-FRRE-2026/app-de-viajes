/**
 * Cuándo una posición sirve para enviarla. location le pone a cada ping la hora del servidor, así que
 * reenviar un GPS viejo lo haría parecer actual: un chofer quieto en el mapa, o que ya se fue, seguiría
 * siendo candidato. Por eso el reenvío solo manda posiciones recientes.
 */

/** Cada cuánto se reenvía la última posición, aunque el GPS no haya cambiado. */
export const REENVIO_MS = 5_000;

/**
 * Una posición del GPS es reciente si se tomó hace 15 s o menos: la mitad de los 30 s de
 * `UBICACION_VIGENCIA_SEGUNDOS` de location, así llega con margen y la búsqueda todavía la cuenta.
 */
export const RECIENTE_MS = 15_000;

/** Pasado este tiempo sin envíos, location ya no tiene al usuario como candidato (vigencia de location). */
export const VIGENCIA_MS = 30_000;

export type Fuente = 'gps' | 'manual';

export interface Fijacion {
  lat: number;
  lng: number;
  /** Cuándo se tomó (ms desde 1970). En el GPS es el `timestamp` de la posición, no cuándo llegó. */
  tomadaEn: number;
  fuente: Fuente;
}

export type EstadoPosicion =
  | { tipo: 'sin-posicion' }
  | { tipo: 'reciente'; edadMs: number }
  | { tipo: 'vieja'; edadMs: number };

/**
 * El estado de la posición para enviarla. La manual (modo demo) son coordenadas que declara el
 * usuario: valen mientras estén puestas, y cada envío lleva la hora del momento.
 */
export function estadoPosicion(f: Fijacion | null, ahora: number): EstadoPosicion {
  if (!f) return { tipo: 'sin-posicion' };
  if (f.fuente === 'manual') return { tipo: 'reciente', edadMs: 0 };
  const edadMs = Math.max(0, ahora - f.tomadaEn);
  return edadMs <= RECIENTE_MS ? { tipo: 'reciente', edadMs } : { tipo: 'vieja', edadMs };
}

/** Las coordenadas a enviar ahora, o null si no hay una posición reciente. */
export function posicionParaEnviar(f: Fijacion | null, ahora: number): { lat: number; lng: number } | null {
  return f && estadoPosicion(f, ahora).tipo === 'reciente' ? { lat: f.lat, lng: f.lng } : null;
}

/** Coordenadas válidas (lo mismo que exige la API); null si no lo son. */
export function leerCoordenadas(lat: string, lng: string): { lat: number; lng: number } | null {
  const [a, b] = [Number(lat.replace(',', '.')), Number(lng.replace(',', '.'))];
  if (lat.trim() === '' || lng.trim() === '' || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < -90 || a > 90 || b < -180 || b > 180) return null;
  return { lat: a, lng: b };
}
