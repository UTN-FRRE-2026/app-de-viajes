import { describe, expect, it } from 'vitest';
import { distanciaMetros, exigirCoordenadaValida, seleccionarCercanos } from '../../src/dominio/entidades/index.js';
import { CoordenadaInvalida } from '../../src/dominio/errores/index.js';
import { alNorte, OBELISCO } from '../soporte/memoria.js';

const ping = (choferId: string, posicion: { lat: number; lng: number }) => ({ choferId, posicion, registradoEn: new Date() });

describe('distancia (haversine)', () => {
  it('es cero entre un punto y sí mismo', () => {
    expect(distanciaMetros(OBELISCO, OBELISCO)).toBe(0);
  });

  it('un grado de latitud mide unos 111,2 km', () => {
    expect(distanciaMetros({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111_195, -1);
  });

  it('en el ecuador, un grado de longitud mide lo mismo; cerca de los polos, mucho menos', () => {
    expect(distanciaMetros({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111_195, -1);
    expect(distanciaMetros({ lat: 80, lng: 0 }, { lat: 80, lng: 1 })).toBeLessThan(20_000);
  });

  it('Obelisco a Plaza de Mayo: alrededor de 1 km', () => {
    const d = distanciaMetros(OBELISCO, { lat: -34.6083, lng: -58.3712 });
    expect(d).toBeGreaterThan(900);
    expect(d).toBeLessThan(1_200);
  });

  it('es simétrica y cruza el antimeridiano por el camino corto', () => {
    expect(distanciaMetros(OBELISCO, alNorte(500))).toBeCloseTo(distanciaMetros(alNorte(500), OBELISCO), 6);
    expect(distanciaMetros({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 })).toBeLessThan(25_000);
  });
});

describe('selección de cercanos', () => {
  const posiciones = [ping('c', alNorte(3000)), ping('a', alNorte(100)), ping('b', alNorte(800)), ping('lejos', alNorte(9000))];

  it('ordena del más cercano al más lejano', () => {
    const r = seleccionarCercanos(posiciones, OBELISCO, { radioMetros: 5000, limite: 10 });
    expect(r.map((c) => c.choferId)).toEqual(['a', 'b', 'c']);
  });

  it('respeta el radio y el límite', () => {
    expect(seleccionarCercanos(posiciones, OBELISCO, { radioMetros: 1000, limite: 10 }).map((c) => c.choferId)).toEqual(['a', 'b']);
    expect(seleccionarCercanos(posiciones, OBELISCO, { radioMetros: 50_000, limite: 2 }).map((c) => c.choferId)).toEqual(['a', 'b']);
  });

  it('a igual distancia el orden es estable, por id', () => {
    const empatados = [ping('z', alNorte(500)), ping('m', alNorte(500))];
    expect(seleccionarCercanos(empatados, OBELISCO, { radioMetros: 1000, limite: 10 }).map((c) => c.choferId)).toEqual(['m', 'z']);
  });
});

describe('coordenadas', () => {
  it.each([
    [{ lat: 91, lng: 0 }],
    [{ lat: -90.1, lng: 0 }],
    [{ lat: 0, lng: 181 }],
    [{ lat: Number.NaN, lng: 0 }],
    [{ lat: 0, lng: Number.POSITIVE_INFINITY }],
  ])('rechaza %j', (c) => {
    expect(() => exigirCoordenadaValida(c)).toThrow(CoordenadaInvalida);
  });

  it('acepta los bordes y el cero', () => {
    for (const c of [{ lat: 90, lng: 180 }, { lat: -90, lng: -180 }, { lat: 0, lng: 0 }]) {
      expect(() => exigirCoordenadaValida(c)).not.toThrow();
    }
  });
});
