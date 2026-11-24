import { describe, expect, it } from 'vitest';
import { EsquemaConfig } from '../../src/config/index.js';
import { semillaDesdeConfig } from '../../src/infra/tarifas/tarifas-config.js';
import { PARAMETROS_PRUEBA } from '../soporte/mapas-falso.js';
import { DESTINO, ORIGEN, sistemaEnMemoria } from '../soporte/memoria.js';

describe('estimarTarifa', () => {
  it('pide el recorrido a mapas con el origen y el destino, y calcula con la tarifa vigente', async () => {
    const { casos, mapas } = sistemaEnMemoria();
    mapas.modo = { recorrido: { metros: 5000, segundos: 600 } };

    const e = await casos.estimarTarifa({ origen: ORIGEN, destino: DESTINO });

    expect(mapas.llamadas).toEqual([{ origen: ORIGEN, destino: DESTINO }]);
    expect(e).toEqual({
      tarifaCentavos: 450_000,
      moneda: 'ARS',
      distanciaMetros: 5000,
      duracionSegundos: 600,
      desglose: {
        bajadaCentavos: 100_000,
        recorridoCentavos: 350_000,
        subtotalCentavos: 450_000,
        minimoCentavos: 200_000,
        minimoAplicado: false,
      },
      tarifaVersion: PARAMETROS_PRUEBA.version,
    });
  });

  it('un recorrido más largo que el máximo no se estima: 422 VIAJE_FUERA_DE_RANGO', async () => {
    const { casos, mapas } = sistemaEnMemoria();
    mapas.modo = { recorrido: { metros: PARAMETROS_PRUEBA.maxMetros + 1, segundos: 3600 } };
    await expect(casos.estimarTarifa({ origen: ORIGEN, destino: DESTINO })).rejects.toMatchObject({
      codigo: 'VIAJE_FUERA_DE_RANGO',
    });
  });

  it('si mapas falla, no hay estimación (no se inventa un recorrido)', async () => {
    const { casos, mapas } = sistemaEnMemoria();
    mapas.modo = 'falla';
    await expect(casos.estimarTarifa({ origen: ORIGEN, destino: DESTINO })).rejects.toThrow('mapas caído');
  });

  it('no escribe nada: la estimación no tiene efectos', async () => {
    const { casos, repo } = sistemaEnMemoria();
    await casos.estimarTarifa({ origen: ORIGEN, destino: DESTINO });
    expect(repo.solicitudes.size).toBe(0);
    expect(repo.eventos).toEqual([]);
  });
});

describe('tarifa desde la configuración', () => {
  const base = {
    DISPATCH_PERSISTENCIA: 'memoria',
    JWKS_URL: 'http://identity.invalid/.well-known/jwks.json',
    JWT_ISSUER: 'viajes-identity',
    JWT_AUDIENCE: 'viajes',
    DISPATCH_BUSCADOR: 'fijo',
    METRICAS_TOKEN: 'm'.repeat(40),
    IDENTITY_URL: 'http://identity.invalid',
    IDENTITY_TOKEN_SERVICIO: 's'.repeat(40),
  };
  const variablesConError = (extra: Record<string, string>) => {
    const r = EsquemaConfig.safeParse({ ...base, ...extra });
    return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
  };

  it('sin variables de tarifa arranca con los valores de ejemplo, en centavos enteros', () => {
    expect(EsquemaConfig.parse(base)).toMatchObject({
      TARIFA_BAJADA_CENTAVOS: 150_000,
      TARIFA_CENTAVOS_POR_KM: 80_000,
      TARIFA_CENTAVOS_POR_MINUTO: 15_000,
      TARIFA_MINIMO_CENTAVOS: 250_000,
      TARIFA_MAX_METROS: 100_000,
      MAPAS_TIMEOUT_MS: 1000,
    });
  });

  it('una variable vacía (Compose la pasa así si no está en el .env) usa el valor por defecto, nunca 0', () => {
    const vacias = Object.fromEntries(
      [
        'TARIFA_BAJADA_CENTAVOS',
        'TARIFA_CENTAVOS_POR_KM',
        'TARIFA_CENTAVOS_POR_MINUTO',
        'TARIFA_MINIMO_CENTAVOS',
        'TARIFA_MAX_METROS',
        'MAPAS_FACTOR_DESVIO',
        'MAPAS_VELOCIDAD_KMH',
        'MAPAS_TIMEOUT_MS',
        'MAPAS_LATENCIA_SIMULADA_MS',
        'OFERTAS_SIMULTANEAS',
        'OFERTA_TTL_SEGUNDOS',
      ].map((v) => [v, '']),
    );
    expect(EsquemaConfig.parse({ ...base, ...vacias })).toMatchObject({
      TARIFA_BAJADA_CENTAVOS: 150_000,
      TARIFA_CENTAVOS_POR_KM: 80_000,
      TARIFA_CENTAVOS_POR_MINUTO: 15_000,
      TARIFA_MINIMO_CENTAVOS: 250_000,
      TARIFA_MAX_METROS: 100_000,
      MAPAS_FACTOR_DESVIO: 1.3,
      MAPAS_VELOCIDAD_KMH: 25,
      MAPAS_TIMEOUT_MS: 1000,
      MAPAS_LATENCIA_SIMULADA_MS: 0,
      OFERTAS_SIMULTANEAS: 3,
      OFERTA_TTL_SEGUNDOS: 15,
    });
  });

  it.each([' ', '   ', '\t', ' \n '])('solo espacios (%j) también usa el valor por defecto, nunca 0', (blanco) => {
    expect(
      EsquemaConfig.parse({ ...base, TARIFA_BAJADA_CENTAVOS: blanco, TARIFA_MAX_METROS: blanco, MAPAS_TIMEOUT_MS: blanco }),
    ).toMatchObject({ TARIFA_BAJADA_CENTAVOS: 150_000, TARIFA_MAX_METROS: 100_000, MAPAS_TIMEOUT_MS: 1000 });
  });

  it('un "0" escrito a propósito sigue valiendo 0 en los importes que lo admiten', () => {
    const c = EsquemaConfig.parse({
      ...base,
      TARIFA_BAJADA_CENTAVOS: '0',
      TARIFA_CENTAVOS_POR_KM: '0',
      TARIFA_CENTAVOS_POR_MINUTO: '0',
      TARIFA_MINIMO_CENTAVOS: '0',
      MAPAS_LATENCIA_SIMULADA_MS: '0',
    });
    expect(c).toMatchObject({
      TARIFA_BAJADA_CENTAVOS: 0,
      TARIFA_CENTAVOS_POR_KM: 0,
      TARIFA_CENTAVOS_POR_MINUTO: 0,
      TARIFA_MINIMO_CENTAVOS: 0,
      MAPAS_LATENCIA_SIMULADA_MS: 0,
    });
    // El máximo no admite 0: un "0" explícito se rechaza, no se reemplaza por el valor por defecto.
    expect(variablesConError({ TARIFA_MAX_METROS: '0' })).toEqual(['TARIFA_MAX_METROS']);
  });

  it('un valor explícito pisa el de por defecto', () => {
    expect(EsquemaConfig.parse({ ...base, TARIFA_BAJADA_CENTAVOS: '123400' }).TARIFA_BAJADA_CENTAVOS).toBe(123_400);
  });

  it.each([
    ['TARIFA_BAJADA_CENTAVOS', '1500.50'],
    ['TARIFA_CENTAVOS_POR_KM', '-1'],
    ['TARIFA_MINIMO_CENTAVOS', 'mucho'],
    ['TARIFA_MAX_METROS', '0'],
    ['MAPAS_TIMEOUT_MS', '10'],
  ])('%s = %s no deja arrancar y nombra la variable', (variable, valor) => {
    expect(variablesConError({ [variable]: valor })).toEqual([variable]);
  });

  it('la semilla son los cinco valores del entorno, sin versión: la versión la pone la base', () => {
    const valores = { bajadaCentavos: 1, centavosPorKm: 2, centavosPorMinuto: 3, minimoCentavos: 4, maxMetros: 5 };
    expect(semillaDesdeConfig(valores)).toEqual(valores);
  });

  it('una semilla que no cumple los invariantes no deja componer', () => {
    expect(() =>
      semillaDesdeConfig({ bajadaCentavos: -1, centavosPorKm: 0, centavosPorMinuto: 0, minimoCentavos: 0, maxMetros: 1 }),
    ).toThrow(/bajadaCentavos/);
  });
});
