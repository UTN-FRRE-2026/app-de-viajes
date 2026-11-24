import { distanciaMetros, textoPunto, type Punto } from '../../viaje/viaje';

/**
 * Lugares conocidos para la demo y para Playwright, todos dentro de la zona «CABA» que arma
 * `npm run demo:flotas`: con un clic se elige origen o destino sin cargar coordenadas.
 */
export const LUGARES: readonly ({ id: string; nombre: string } & Punto)[] = [
  { id: 'obelisco', nombre: 'Obelisco', lat: -34.6037, lng: -58.3816 },
  { id: 'plaza-de-mayo', nombre: 'Plaza de Mayo', lat: -34.6083, lng: -58.3712 },
  { id: 'retiro', nombre: 'Estación Retiro', lat: -34.5912, lng: -58.3747 },
  { id: 'planetario', nombre: 'Planetario Galileo Galilei', lat: -34.5696, lng: -58.4116 },
  { id: 'parque-centenario', nombre: 'Parque Centenario', lat: -34.6066, lng: -58.4357 },
  { id: 'caminito', nombre: 'Caminito, La Boca', lat: -34.6393, lng: -58.3626 },
  { id: 'aeroparque', nombre: 'Aeroparque', lat: -34.5592, lng: -58.4156 },
];

/** A menos de esto, un punto es ese lugar. */
const CERCA_METROS = 60;

/** El nombre del lugar de la demo que está en ese punto, o null. */
export function lugarEn(p: Punto): string | null {
  return LUGARES.find((l) => distanciaMetros(l, p) <= CERCA_METROS)?.nombre ?? null;
}

/**
 * Para mostrar un punto: el nombre del lugar si es uno conocido; si no, «Punto en el mapa» (las
 * coordenadas van en el `title`, con `textoPunto`).
 */
export const nombrePunto = (p: Punto) => lugarEn(p) ?? 'Punto en el mapa';

/** «Obelisco → Punto en el mapa», y las coordenadas de los dos para el `title`. */
export function textoRecorrido(origen: Punto, destino: Punto): { texto: string; detalle: string } {
  return { texto: `${nombrePunto(origen)} → ${nombrePunto(destino)}`, detalle: `${textoPunto(origen)} → ${textoPunto(destino)}` };
}
