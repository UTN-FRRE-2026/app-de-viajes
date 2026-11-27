import { describe, expect, it } from 'vitest';
import {
  armarRecorrido,
  avanzar,
  LLEGADA_METROS,
  llego,
  PARTIDA_SIMULADA,
  polilineaDelTramo,
  puntoEn,
  restante,
  VELOCIDAD_SIMULADA_KMH,
  yaEsta,
} from '../src/ubicacion/simulacion';
import { distanciaMetros } from '../src/viaje/viaje';

// La conducción simulada del chofer (src/ubicacion/simulacion.ts).
const PLAZA = { lat: -27.4511, lng: -58.9865 };
/** Unos 200 m al norte de la plaza. */
const NORTE = { lat: -27.4493, lng: -58.9865 };
/** Desde NORTE, unos 200 m al este: una ruta en L de unos 400 m. */
const ESQUINA = { lat: -27.4493, lng: -58.98448 };

describe('avanzar sobre la polilínea', () => {
  const r = armarRecorrido([PLAZA, NORTE, ESQUINA]);

  it('el largo es la suma de los tramos', () => {
    expect(r.total).toBeCloseTo(distanciaMetros(PLAZA, NORTE) + distanciaMetros(NORTE, ESQUINA), 6);
    expect(r.total).toBeGreaterThan(390);
    expect(r.total).toBeLessThan(410);
  });

  it('a 120 km/h (la de la demo), cada segundo son 33,3 m; a 40, 11,1 m', () => {
    expect(VELOCIDAD_SIMULADA_KMH).toBe(120);
    expect(avanzar(r, 0, VELOCIDAD_SIMULADA_KMH, 1)).toBeCloseTo(33.333, 3);
    expect(avanzar(r, 0, 40, 1)).toBeCloseTo(11.111, 3);
    expect(avanzar(r, 100, 40, 9)).toBeCloseTo(200, 6);
  });

  it('no se pasa del final ni va para atrás', () => {
    expect(avanzar(r, r.total - 5, 40, 1)).toBe(r.total);
    expect(avanzar(r, 50, 40, -3)).toBe(50);
    expect(avanzar(r, 50, -40, 3)).toBe(50);
  });

  it('el punto sale del tramo que corresponde, aunque el paso cruce la esquina', () => {
    const primero = distanciaMetros(PLAZA, NORTE);
    expect(puntoEn(r, 0)).toEqual(PLAZA);
    expect(puntoEn(r, primero)).toEqual(NORTE);
    const mitadPrimero = puntoEn(r, primero / 2);
    expect(mitadPrimero.lng).toBeCloseTo(PLAZA.lng, 9);
    expect(distanciaMetros(PLAZA, mitadPrimero)).toBeCloseTo(primero / 2, 0);
    // 10 m después de la esquina: ya va hacia el este, sobre el segundo tramo.
    const pasada = puntoEn(r, primero + 10);
    expect(pasada.lat).toBeCloseTo(NORTE.lat, 9);
    expect(distanciaMetros(NORTE, pasada)).toBeCloseTo(10, 0);
    expect(puntoEn(r, r.total + 50)).toEqual(ESQUINA);
  });

  it('una polilínea de un solo punto ya terminó', () => {
    const quieto = armarRecorrido([PLAZA]);
    expect(quieto.total).toBe(0);
    expect(puntoEn(quieto, 10)).toEqual(PLAZA);
    expect(llego(quieto, 0)).toBe(true);
  });
});

describe('llegar', () => {
  const r = armarRecorrido([PLAZA, NORTE]);

  it('llega al terminar la polilínea o a 20 m o menos del final', () => {
    expect(LLEGADA_METROS).toBeGreaterThanOrEqual(15);
    expect(LLEGADA_METROS).toBeLessThanOrEqual(20);
    expect(llego(r, r.total)).toBe(true);
    expect(llego(r, r.total - LLEGADA_METROS + 1)).toBe(true);
    expect(llego(r, r.total - 40)).toBe(false);
    expect(restante(r, r.total - 40)).toBeCloseTo(40, 6);
  });

  it('se mide sobre el camino: una ruta que da la vuelta y pasa cerca del final no llega antes de tiempo', () => {
    // Ida y vuelta: el final queda a 10 m de donde empezó, pero falta recorrer los 400 m.
    const final = { lat: PLAZA.lat, lng: PLAZA.lng + 0.0001 };
    const vuelta = armarRecorrido([PLAZA, NORTE, final]);
    expect(yaEsta(PLAZA, final)).toBe(true);
    expect(llego(vuelta, 0)).toBe(false);
    expect(llego(vuelta, 100)).toBe(false);
    expect(llego(vuelta, vuelta.total - 5)).toBe(true);
  });

  it('ya está si en línea recta queda a 20 m o menos (al recargar en el origen)', () => {
    expect(yaEsta(PLAZA, PLAZA)).toBe(true);
    expect(yaEsta(PLAZA, NORTE)).toBe(false);
  });

  it('a 120 km/h, 200 m se hacen en unos 6 pasos de 1 s (frena a 20 m o menos del final)', () => {
    let andados = 0;
    let pasos = 0;
    while (!llego(r, andados) && pasos < 100) {
      andados = avanzar(r, andados, VELOCIDAD_SIMULADA_KMH, 1);
      pasos++;
    }
    expect(pasos).toBeGreaterThanOrEqual(5);
    expect(pasos).toBeLessThanOrEqual(7);
  });
});

describe('la polilínea del tramo', () => {
  it('empieza en el auto y termina en el punto exacto, aunque la ruta vaya por la calle más cercana', () => {
    const calle: [number, number][] = [
      [-27.45125, -58.98655],
      [-27.4501, -58.98655],
      [-27.44935, -58.98652],
    ];
    const puntos = polilineaDelTramo(PLAZA, NORTE, calle);
    expect(puntos[0]).toEqual(PLAZA);
    expect(puntos[puntos.length - 1]).toEqual(NORTE);
    expect(puntos).toHaveLength(5);
  });

  it('sin ruta (o recta), va de un punto al otro; no repite puntos iguales', () => {
    expect(polilineaDelTramo(PLAZA, NORTE, null)).toEqual([PLAZA, NORTE]);
    expect(
      polilineaDelTramo(PLAZA, NORTE, [
        [PLAZA.lat, PLAZA.lng],
        [NORTE.lat, NORTE.lng],
      ]),
    ).toEqual([PLAZA, NORTE]);
  });

  it('el punto de partida por defecto es el del script de la demo', () => {
    expect(PARTIDA_SIMULADA).toEqual({ lat: -27.462, lng: -58.996 });
  });
});
