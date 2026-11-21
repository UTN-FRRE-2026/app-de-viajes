import { describe, expect, it } from 'vitest';
import { calcularTarifa, exigirDentroDeRango } from '../../src/dominio/tarifas/calculo.js';
import {
  problemasDeParametros,
  TOPE_IMPORTE_CENTAVOS,
  TOPE_MAX_METROS,
  type ParametrosTarifa,
} from '../../src/dominio/tarifas/parametros.js';
import { PARAMETROS_PRUEBA as P } from '../soporte/mapas-falso.js';

const total = (metros: number, segundos: number, p: ParametrosTarifa = P) => calcularTarifa(p, { metros, segundos }).totalCentavos;

/** Para aislar el redondeo: sin bajada ni mínimo, 1 centavo por km y 1 por minuto. */
const UNITARIO: ParametrosTarifa = { ...P, bajadaCentavos: 0, centavosPorKm: 1, centavosPorMinuto: 1, minimoCentavos: 0 };

describe('calcularTarifa: resultado exacto en centavos', () => {
  // P: bajada $1000, $500/km, $100/min, mínimo $2000. Recorrido = 50 × metros + 500/3 × segundos.
  it.each([
    // metros, segundos, total esperado, cómo se llega
    [5000, 600, 450_000, '100 000 + 250 000 + 100 000'],
    [3000, 0, 250_000, '100 000 + 150 000'],
    [2000, 0, 200_000, '100 000 + 100 000: igual al mínimo, no lo supera'],
    [1, 1, 200_000, '100 000 + 50 + 166,67 → mínimo'],
    [4000, 1, 300_167, '100 000 + 200 000 + 166,67 → 167'],
    [4000, 2, 300_333, '100 000 + 200 000 + 333,33 → 333'],
  ])('%i m y %i s → %i (%s)', (metros, segundos, esperado) => {
    expect(total(metros, segundos)).toBe(esperado);
  });

  it('distancia cero (origen igual a destino) con la bajada por debajo del mínimo cobra el mínimo', () => {
    const t = calcularTarifa(P, { metros: 0, segundos: 0 });
    expect(t.totalCentavos).toBe(P.minimoCentavos);
    expect(t.desglose).toEqual({
      bajadaCentavos: 100_000,
      recorridoCentavos: 0,
      subtotalCentavos: 100_000,
      minimoCentavos: 200_000,
      minimoAplicado: true,
    });
  });

  it('0 m y 0 s dan max(mínimo, bajada): si la bajada supera al mínimo, se cobra la bajada', () => {
    const t = calcularTarifa({ ...P, bajadaCentavos: 300_000 }, { metros: 0, segundos: 0 });
    expect(t.totalCentavos).toBe(300_000);
    expect(t.desglose.minimoAplicado).toBe(false);
  });

  it('el desglose cierra: el total es el subtotal o el mínimo, y el subtotal es bajada más recorrido', () => {
    const { totalCentavos, desglose } = calcularTarifa(P, { metros: 5000, segundos: 600 });
    expect(desglose).toEqual({
      bajadaCentavos: 100_000,
      recorridoCentavos: 350_000,
      subtotalCentavos: 450_000,
      minimoCentavos: 200_000,
      minimoAplicado: false,
    });
    expect(totalCentavos).toBe(desglose.subtotalCentavos);
  });
});

describe('calcularTarifa: redondeo', () => {
  it('mitad exacta sube; apenas por debajo de la mitad baja', () => {
    expect(total(500, 0, UNITARIO)).toBe(1); // 0,5 → 1
    expect(total(483, 1, UNITARIO)).toBe(0); // 0,483 + 0,0167 = 0,4997 → 0
    expect(total(484, 1, UNITARIO)).toBe(1); // 0,484 + 0,0167 = 0,5007 → 1
    expect(total(1499, 0, UNITARIO)).toBe(1); // 1,499 → 1
    expect(total(1500, 0, UNITARIO)).toBe(2); // 1,5 → 2
  });

  it('redondea una sola vez: distancia y tiempo juntos, no cada uno por separado', () => {
    // 0,5 (500 m) + 0,5 (30 s) = 1 centavo. Redondeando cada parte por separado darían 2.
    expect(total(500, 30, UNITARIO)).toBe(1);
  });

  it('siempre devuelve un entero, también con los importes y el recorrido en el tope', () => {
    const tope: ParametrosTarifa = {
      ...P,
      bajadaCentavos: TOPE_IMPORTE_CENTAVOS,
      centavosPorKm: TOPE_IMPORTE_CENTAVOS,
      centavosPorMinuto: TOPE_IMPORTE_CENTAVOS,
      minimoCentavos: TOPE_IMPORTE_CENTAVOS,
      maxMetros: TOPE_MAX_METROS,
    };
    const t = calcularTarifa(tope, { metros: TOPE_MAX_METROS, segundos: 360_000 });
    expect(Number.isSafeInteger(t.totalCentavos)).toBe(true);
    for (const [m, s] of [[0, 0], [1, 1], [12_345, 678], [49_999, 7_199]] as const) {
      expect(Number.isInteger(total(m, s))).toBe(true);
    }
  });

  it('un recorrido más largo o más lento nunca sale más barato', () => {
    let anterior = 0;
    for (let metros = 0; metros <= P.maxMetros; metros += 137) {
      const t = total(metros, 300);
      expect(t).toBeGreaterThanOrEqual(anterior);
      anterior = t;
    }
    anterior = 0;
    for (let segundos = 0; segundos <= 7200; segundos += 7) {
      const t = total(5000, segundos);
      expect(t).toBeGreaterThanOrEqual(anterior);
      anterior = t;
    }
  });

  it('un recorrido que no son enteros no negativos es un error de programación, no una tarifa', () => {
    expect(() => calcularTarifa(P, { metros: -1, segundos: 0 })).toThrow(RangeError);
    expect(() => calcularTarifa(P, { metros: 10.5, segundos: 0 })).toThrow(RangeError);
    expect(() => calcularTarifa(P, { metros: 10, segundos: Number.NaN })).toThrow(RangeError);
  });
});

describe('exigirDentroDeRango', () => {
  it('justo en el máximo se acepta; un metro más, no (422 VIAJE_FUERA_DE_RANGO)', () => {
    expect(() => exigirDentroDeRango(P, { metros: P.maxMetros, segundos: 0 })).not.toThrow();
    expect(() => exigirDentroDeRango(P, { metros: P.maxMetros + 1, segundos: 0 })).toThrow(
      expect.objectContaining({ codigo: 'VIAJE_FUERA_DE_RANGO', tipo: 'INVALIDO' }),
    );
  });

  it('calcularTarifa no rechaza por largo: un viaje que ya terminó siempre se puede cobrar', () => {
    expect(total(P.maxMetros + 10_000, 0)).toBe(100_000 + 50 * (P.maxMetros + 10_000));
  });
});

describe('problemasDeParametros', () => {
  it('los parámetros de prueba son válidos', () => {
    expect(problemasDeParametros(P)).toEqual([]);
  });

  it.each([
    ['bajadaCentavos', -1],
    ['centavosPorKm', 10.5],
    ['centavosPorMinuto', TOPE_IMPORTE_CENTAVOS + 1],
    ['minimoCentavos', Number.NaN],
    ['maxMetros', 0],
    ['maxMetros', TOPE_MAX_METROS + 1],
  ] as const)('%s = %s se rechaza y se nombra el campo', (campo, valor) => {
    const problemas = problemasDeParametros({ ...P, [campo]: valor });
    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toMatch(new RegExp(`^${campo}:`));
  });

  it('una versión vacía se rechaza', () => {
    expect(problemasDeParametros({ ...P, version: ' ' })).toEqual(['version: no puede estar vacía']);
  });
});
