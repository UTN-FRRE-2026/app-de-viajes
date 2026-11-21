import { randomUUID } from 'node:crypto';
import { EstimacionRespuesta } from '@viajes/contracts';
import { crearLogger, type Rol } from '@viajes/platform';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { componer, type Sistema } from '../../src/composicion.js';
import { MapasFalso, PARAMETROS_PRUEBA, tarifasFijas } from '../soporte/mapas-falso.js';
import { configTest } from '../soporte/sistema-postgres.js';
import { crearEmisorTokens } from '../soporte/tokens.js';

// La estimación no toca la base: dispatch en memoria alcanza, con el mapas falso detrás del timeout real.
const mapas = new MapasFalso();
let sistema: Sistema;
let auth: Awaited<ReturnType<typeof crearEmisorTokens>>['auth'];

beforeAll(async () => {
  const tokens = await crearEmisorTokens();
  auth = tokens.auth;
  sistema = componer(
    configTest({ DISPATCH_PERSISTENCIA: 'memoria', MAPAS_TIMEOUT_MS: '100' }),
    crearLogger('dispatch-test', 'silent'),
    { verificador: tokens.verificador, mapas, tarifas: tarifasFijas() },
  );
});
afterAll(async () => {
  await sistema.cerrar();
});
beforeEach(() => {
  mapas.modo = { recorrido: { metros: 5000, segundos: 600 } };
  mapas.llamadas.length = 0;
});

const QUERY = { origenLat: '-34.6037', origenLng: '-58.3816', destinoLat: '-34.5875', destinoLng: '-58.4207' };
const estimar = async (rol: Rol = 'pasajero', query: Record<string, string> | string = QUERY) =>
  request(sistema.app).get('/tarifas/estimacion').query(query).set(await auth(randomUUID(), rol));

const formatoDeError = (code: string) => ({ error: { code, message: expect.any(String), requestId: expect.any(String) } });

describe('GET /tarifas/estimacion', () => {
  it('sin token → 401', async () => {
    const res = await request(sistema.app).get('/tarifas/estimacion').query(QUERY);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(formatoDeError('NO_AUTENTICADO'));
  });

  it('el chofer no estima → 403', async () => {
    const res = await estimar('chofer');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROL_NO_PERMITIDO');
    expect(mapas.llamadas).toHaveLength(0);
  });

  it.each(['pasajero', 'operador', 'admin'] as const)('%s → 200 con el contrato exacto y sin Idempotency-Key', async (rol) => {
    const res = await estimar(rol);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(EstimacionRespuesta.parse(res.body)).toEqual({
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
    expect(mapas.llamadas).toEqual([{ origen: { lat: -34.6037, lng: -58.3816 }, destino: { lat: -34.5875, lng: -58.4207 } }]);
  });

  it.each([
    ['falta un parámetro', { origenLat: '-34.6', origenLng: '-58.3', destinoLat: '-34.5' }],
    ['un parámetro de más', { ...QUERY, pasajeroId: randomUUID() }],
    ['latitud fuera de rango', { ...QUERY, origenLat: '91' }],
    ['longitud fuera de rango', { ...QUERY, destinoLng: '-180.01' }],
    ['no numérico', { ...QUERY, destinoLat: 'abc' }],
    ['vacío', { ...QUERY, origenLng: '' }],
    ['infinito', { ...QUERY, origenLat: 'Infinity' }],
  ])('%s → 400 y no se llama a mapas', async (_caso, query) => {
    const res = await estimar('pasajero', query);
    expect(res.status).toBe(400);
    expect(mapas.llamadas).toHaveLength(0);
  });

  it('un parámetro repetido → 400', async () => {
    const res = await estimar('pasajero', 'origenLat=-34.6&origenLat=-34.7&origenLng=-58.38&destinoLat=-34.58&destinoLng=-58.42');
    expect(res.status).toBe(400);
  });

  it('un recorrido más largo que el máximo → 422 VIAJE_FUERA_DE_RANGO', async () => {
    mapas.modo = { recorrido: { metros: PARAMETROS_PRUEBA.maxMetros + 1, segundos: 3600 } };
    const res = await estimar();
    expect(res.status).toBe(422);
    expect(res.body).toEqual(formatoDeError('VIAJE_FUERA_DE_RANGO'));
  });

  it.each(['colgado', 'falla', 'fuera-de-contrato'] as const)(
    'mapas %s → 503 MAPAS_NO_DISPONIBLE, sin estimación y sin detalles internos',
    async (modo) => {
      mapas.modo = modo;
      const inicio = Date.now();
      const res = await estimar();
      expect(res.status).toBe(503);
      expect(res.body).toEqual(formatoDeError('MAPAS_NO_DISPONIBLE'));
      expect(res.body).not.toHaveProperty('tarifaCentavos');
      expect(JSON.stringify(res.body)).not.toMatch(/caído|contrato|timeout|ms/i);
      expect(Date.now() - inicio).toBeLessThan(2000);
    },
  );
});

describe('GET /tarifas/estimacion con los adaptadores reales (mapas simulado y tarifa sembrada desde el .env)', () => {
  it('estima con la tarifa de ejemplo, que queda como versión 1', async () => {
    const tokens = await crearEmisorTokens();
    const conTokens = componer(configTest({ DISPATCH_PERSISTENCIA: 'memoria' }), crearLogger('dispatch-test', 'silent'), {
      verificador: tokens.verificador,
    });
    try {
      const res = await request(conTokens.app)
        .get('/tarifas/estimacion')
        .query(QUERY)
        .set(await tokens.auth(randomUUID(), 'pasajero'));
      expect(res.status).toBe(200);
      const e = EstimacionRespuesta.parse(res.body);
      expect(e.tarifaVersion).toBe('v1');
      expect(e.distanciaMetros).toBeGreaterThan(4000);
      expect(e.tarifaCentavos).toBe(e.desglose.minimoAplicado ? e.desglose.minimoCentavos : e.desglose.subtotalCentavos);

      // Origen igual a destino: 0 m y 0 s, total = max(mínimo, bajada). Con los valores de ejemplo, el mínimo.
      const mismo = await request(conTokens.app)
        .get('/tarifas/estimacion')
        .query({ ...QUERY, destinoLat: QUERY.origenLat, destinoLng: QUERY.origenLng })
        .set(await tokens.auth(randomUUID(), 'pasajero'));
      expect(mismo.status).toBe(200);
      expect(mismo.body).toMatchObject({ distanciaMetros: 0, tarifaCentavos: 250_000, desglose: { minimoAplicado: true } });
    } finally {
      await conTokens.cerrar();
    }
  });
});
