import { distanciaMetros, type Punto } from '../viaje/viaje';

// La conducción simulada del chofer («Simulada (demo)»), sin React ni red: un auto que avanza por una
// polilínea a una velocidad fija y sabe cuándo llegó. El cálculo es el de `scripts/simular-chofer.mjs`.
// Se testea sola (apps/web/tests/simulacion.test.ts).

/** A qué velocidad maneja el auto simulado: la de la ciudad, la misma del script de la demo. */
export const VELOCIDAD_SIMULADA_KMH = 40;

/** Cada cuánto avanza el auto simulado y manda su posición (60 por minuto: location admite 120). */
export const PASO_SIMULADO_MS = 1_000;

/**
 * Llegó: a esta distancia del final, o menos. El auto simulado termina justo en el punto; el margen es
 * para el que llega con el GPS, que nunca da el punto exacto. Lo usa también la pantalla del pasajero
 * («Tu chofer llegó»).
 */
export const LLEGADA_METROS = 20;

/**
 * Dónde queda el auto simulado si no hay una posición guardada: la de `scripts/simular-chofer.mjs`, a
 * 1,5 km de la Plaza 25 de Mayo, dentro de la zona «Resistencia» de `npm run demo:flotas`.
 */
export const PARTIDA_SIMULADA: Punto = { lat: -27.462, lng: -58.996 };

/** Una polilínea con el largo acumulado hasta cada punto, para ubicar un punto por distancia. */
export interface Recorrido {
  puntos: Punto[];
  /** `acumulado[i]`: los metros desde el primer punto hasta `puntos[i]`. */
  acumulado: number[];
  total: number;
}

/** Arma el recorrido de una polilínea (al menos un punto). */
export function armarRecorrido(puntos: Punto[]): Recorrido {
  if (puntos.length === 0) throw new Error('un recorrido necesita al menos un punto');
  const acumulado = [0];
  for (let i = 1; i < puntos.length; i++) acumulado.push(acumulado[i - 1]! + distanciaMetros(puntos[i - 1]!, puntos[i]!));
  return { puntos, acumulado, total: acumulado[acumulado.length - 1]! };
}

/**
 * La polilínea que se maneja de `desde` a `hasta`: los puntos de la ruta con, además, el auto al
 * principio y el punto exacto al final (como el script de la demo). La ruta por las calles empieza y
 * termina en la calle más cercana: sin esto, el auto saltaría a la calle y frenaría lejos del pin.
 */
export function polilineaDelTramo(desde: Punto, hasta: Punto, ruta: [number, number][] | null): Punto[] {
  const medio = (ruta ?? []).map(([lat, lng]) => ({ lat, lng }));
  return [desde, ...medio, hasta].filter((p, i, todos) => i === 0 || distanciaMetros(todos[i - 1]!, p) > 0.01);
}

/** Los metros andados después de `segundos` más a `kmh`, sin pasarse del final. */
export function avanzar(r: Recorrido, andados: number, kmh: number, segundos: number): number {
  return Math.min(r.total, Math.max(0, andados) + (Math.max(0, kmh) / 3.6) * Math.max(0, segundos));
}

/** El punto que está a `metros` del principio, sobre la polilínea (aunque cruce varios tramos cortos). */
export function puntoEn(r: Recorrido, metros: number): Punto {
  const { puntos, acumulado } = r;
  if (metros <= 0) return puntos[0]!;
  if (metros >= r.total) return puntos[puntos.length - 1]!;
  let i = 1;
  while (i < puntos.length - 1 && acumulado[i]! < metros) i++;
  const a = puntos[i - 1]!;
  const b = puntos[i]!;
  const largo = acumulado[i]! - acumulado[i - 1]!;
  const f = largo === 0 ? 1 : (metros - acumulado[i - 1]!) / largo;
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
}

/** Lo que falta por la polilínea. */
export const restante = (r: Recorrido, andados: number) => Math.max(0, r.total - andados);

/**
 * Llegó si terminó la polilínea o si le faltan `LLEGADA_METROS` o menos. Se mide sobre el camino, no en
 * línea recta: una ruta que da la vuelta a la manzana pasa cerca del final antes de llegar.
 */
export const llego = (r: Recorrido, andados: number) => restante(r, andados) <= LLEGADA_METROS;

/** Ya está ahí: a `LLEGADA_METROS` o menos, en línea recta (por ejemplo, al recargar en el origen). */
export const yaEsta = (posicion: Punto, meta: Punto) => distanciaMetros(posicion, meta) <= LLEGADA_METROS;
