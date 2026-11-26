import { describe, expect, it } from 'vitest';
import { claveRuta, hayQuePedir, UMBRAL_AUTO_METROS } from '../src/mapa/useRuta';
import { distanciaMetros } from '../src/viaje/viaje';

// Cuándo se vuelve a pedir la ruta del mapa (src/mapa/useRuta.ts).
const PLAZA = { lat: -27.4511, lng: -58.9865 };
const TERMINAL = { lat: -27.4562, lng: -59.0224 };
/** Unos 60 m al norte de la plaza: la otra esquina. */
const ESQUINA = { lat: -27.45056, lng: -58.9865 };
/** Unos 200 m al norte de la plaza. */
const CUADRAS = { lat: -27.4493, lng: -58.9865 };

describe('ruta de puntos elegidos (el origen y el destino del pasajero)', () => {
  it('mover el origen a la otra esquina (menos de 120 m) pide la ruta de nuevo', () => {
    expect(distanciaMetros(PLAZA, ESQUINA)).toBeLessThan(UMBRAL_AUTO_METROS);
    const anterior = { desde: PLAZA, clave: claveRuta(PLAZA, TERMINAL, false) };
    expect(hayQuePedir(anterior, ESQUINA, claveRuta(ESQUINA, TERMINAL, false), false)).toBe(true);
  });

  it('la ruta del origen anterior deja de valer: la clave incluye el origen', () => {
    expect(claveRuta(ESQUINA, TERMINAL, false)).not.toBe(claveRuta(PLAZA, TERMINAL, false));
  });

  it('los mismos dos puntos no piden de nuevo', () => {
    const anterior = { desde: PLAZA, clave: claveRuta(PLAZA, TERMINAL, false) };
    expect(hayQuePedir(anterior, { ...PLAZA }, claveRuta({ ...PLAZA }, TERMINAL, false), false)).toBe(false);
  });

  it('sin pedido anterior, pide', () => {
    expect(hayQuePedir(null, PLAZA, claveRuta(PLAZA, TERMINAL, false), false)).toBe(true);
  });
});

describe('ruta que sale del auto (auto: true)', () => {
  it('moverse menos de 120 m no pide (cada segundo llega una posición)', () => {
    const anterior = { desde: PLAZA, clave: claveRuta(PLAZA, TERMINAL, true) };
    expect(hayQuePedir(anterior, ESQUINA, claveRuta(ESQUINA, TERMINAL, true), true)).toBe(false);
  });

  it('moverse 120 m o más pide de nuevo', () => {
    expect(distanciaMetros(PLAZA, CUADRAS)).toBeGreaterThanOrEqual(UMBRAL_AUTO_METROS);
    const anterior = { desde: PLAZA, clave: claveRuta(PLAZA, TERMINAL, true) };
    expect(hayQuePedir(anterior, CUADRAS, claveRuta(CUADRAS, TERMINAL, true), true)).toBe(true);
  });

  it('otro destino pide de nuevo aunque el auto no se haya movido', () => {
    const anterior = { desde: PLAZA, clave: claveRuta(PLAZA, TERMINAL, true) };
    expect(hayQuePedir(anterior, PLAZA, claveRuta(PLAZA, ESQUINA, true), true)).toBe(true);
  });

  it('la clave es solo el destino: la ruta de hace unos metros sigue mientras llega la nueva', () => {
    expect(claveRuta(ESQUINA, TERMINAL, true)).toBe(claveRuta(PLAZA, TERMINAL, true));
  });
});
