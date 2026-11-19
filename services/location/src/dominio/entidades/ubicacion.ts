import { CoordenadaInvalida } from '../errores/index.js';

export interface Coordenada {
  lat: number;
  lng: number;
}

/** Una posición informada por un chofer, con la hora del servidor. */
export interface Ping {
  choferId: string;
  posicion: Coordenada;
  registradoEn: Date;
}

export interface Cercano {
  choferId: string;
  distanciaMetros: number;
  registradoEn: Date;
}

/** Radio medio de la Tierra (IUGG), en metros. */
const RADIO_TIERRA_METROS = 6_371_008.8;
const radianes = (grados: number) => (grados * Math.PI) / 180;

/** Segunda barrera, independiente del esquema HTTP: ninguna posición imposible llega a guardarse. */
export function exigirCoordenadaValida({ lat, lng }: Coordenada): void {
  const valida =
    Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  if (!valida) throw new CoordenadaInvalida();
}

/** Distancia sobre la superficie terrestre (haversine). Error menor al 0,5 % a escala de una ciudad. */
export function distanciaMetros(a: Coordenada, b: Coordenada): number {
  const dLat = radianes(b.lat - a.lat);
  const dLng = radianes(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radianes(a.lat)) * Math.cos(radianes(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_METROS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * La parte "ingenua" de la búsqueda: calcula la distancia a cada posición, descarta las que están
 * fuera del radio, ordena y corta. Recorre todas las posiciones vigentes en cada búsqueda.
 * A igual distancia ordena por choferId, para que el resultado sea estable.
 */
export function seleccionarCercanos(
  posiciones: Ping[],
  origen: Coordenada,
  { radioMetros, limite }: { radioMetros: number; limite: number },
): Cercano[] {
  return posiciones
    .map((p) => ({ choferId: p.choferId, distanciaMetros: distanciaMetros(origen, p.posicion), registradoEn: p.registradoEn }))
    .filter((c) => c.distanciaMetros <= radioMetros)
    .sort((a, b) => a.distanciaMetros - b.distanciaMetros || a.choferId.localeCompare(b.choferId))
    .slice(0, limite);
}
