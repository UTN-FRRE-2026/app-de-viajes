import { distanciaMetros, textoPunto, type Punto } from '../../viaje/viaje';

/**
 * Lugares conocidos para la demo y para Playwright, todos dentro de la zona «Resistencia» (Gran
 * Resistencia) que arma `npm run demo:flotas`: con un clic se elige origen o destino sin cargar
 * coordenadas. Las coordenadas son las de OpenStreetMap.
 */
export const LUGARES: readonly ({ id: string; nombre: string } & Punto)[] = [
  { id: 'plaza-25-de-mayo', nombre: 'Plaza 25 de Mayo', lat: -27.4511, lng: -58.9865 },
  { id: 'utn-frre', nombre: 'UTN Facultad Regional Resistencia', lat: -27.4512, lng: -58.9791 },
  { id: 'domo-del-centenario', nombre: 'Domo del Centenario', lat: -27.4369, lng: -58.9808 },
  { id: 'parque-2-de-febrero', nombre: 'Parque 2 de Febrero', lat: -27.4377, lng: -58.9843 },
  { id: 'terminal', nombre: 'Terminal de Ómnibus', lat: -27.4562, lng: -59.0224 },
  { id: 'aeropuerto', nombre: 'Aeropuerto Internacional Resistencia', lat: -27.4476, lng: -59.0538 },
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

/** «Plaza 25 de Mayo → Punto en el mapa», y las coordenadas de los dos para el `title`. */
export function textoRecorrido(origen: Punto, destino: Punto): { texto: string; detalle: string } {
  return { texto: `${nombrePunto(origen)} → ${nombrePunto(destino)}`, detalle: `${textoPunto(origen)} → ${textoPunto(destino)}` };
}
