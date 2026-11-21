import { randomUUID } from 'node:crypto';
import { EstimacionRespuesta } from '@viajes/contracts';
import { crearLogger } from '@viajes/platform';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { componer } from '../../src/composicion.js';
import { calcularTarifa } from '../../src/dominio/tarifas/calculo.js';
import { cacheTarifasRedis, type CacheTarifas } from '../../src/infra/tarifas/proveedor-tarifas.js';
import { CON_METRICAS, clave, configTest, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';
import { crearEmisorTokens } from '../soporte/tokens.js';

type Dispatch = Awaited<ReturnType<typeof levantarDispatch>>;

let d: Dispatch;
beforeAll(async () => {
  d = await levantarDispatch();
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiarTarifas();
});

const NUEVA = { bajadaCentavos: 200_000, centavosPorKm: 90_000, centavosPorMinuto: 10_000, minimoCentavos: 300_000, maxMetros: 120_000 };
const QUERY = { origenLat: ORIGEN.lat, origenLng: ORIGEN.lng, destinoLat: DESTINO.lat, destinoLng: DESTINO.lng };

const verTarifa = async (s: Dispatch) => (await request(s.url).get('/admin/tarifas').set(await s.auth(randomUUID(), 'admin'))).body;
const configurar = async (s: Dispatch, cuerpo: object = NUEVA) =>
  request(s.url).put('/admin/tarifas').set(clave()).set(await s.auth(randomUUID(), 'admin')).send(cuerpo);

/** Estima el mismo recorrido y comprueba que el importe sea el de los valores de la versión que dice. */
async function estimar(s: Dispatch) {
  const res = await request(s.url).get('/tarifas/estimacion').query(QUERY).set(await s.auth(randomUUID(), 'pasajero'));
  expect(res.status).toBe(200);
  return EstimacionRespuesta.parse(res.body);
}

async function esperado(s: Dispatch, e: { tarifaVersion: string; distanciaMetros: number; duracionSegundos: number }) {
  const t = await s.repoTarifas.porVersion(e.tarifaVersion);
  return calcularTarifa(t!, { metros: e.distanciaMetros, segundos: e.duracionSegundos }).totalCentavos;
}

const enCache = (s: Dispatch, version: string) => s.redis.get(`${s.prefijoCache}${version}`);

describe('semilla desde el entorno', () => {
  it('crea la versión 1 con los TARIFA_* del entorno, y un reinicio con otros valores no la pisa', async () => {
    const primero = await levantarDispatch({ tarifas: { config: { TARIFA_BAJADA_CENTAVOS: '111100' } } });
    let reinicio: Dispatch | undefined;
    let otroReinicio: Dispatch | undefined;
    try {
      expect(await verTarifa(primero)).toMatchObject({ version: 'v1', bajadaCentavos: 111_100, actualizadaPor: 'semilla' });

      // "Reinicio" con otro .env: el mismo Postgres, otro valor de bajada.
      reinicio = await levantarDispatch({ tarifas: { config: { TARIFA_BAJADA_CENTAVOS: '999900' } } });
      expect(await verTarifa(reinicio)).toMatchObject({ version: 'v1', bajadaCentavos: 111_100 });
      expect((await estimar(reinicio)).desglose.bajadaCentavos).toBe(111_100);

      // Lo que configura el admin tampoco lo pisa un reinicio.
      expect((await configurar(reinicio)).status).toBe(200);
      otroReinicio = await levantarDispatch({ tarifas: { config: { TARIFA_BAJADA_CENTAVOS: '555500' } } });
      expect(await verTarifa(otroReinicio)).toMatchObject({ version: 'v2', ...NUEVA });
      expect(await d.prisma.tarifaVersion.count()).toBe(2);
    } finally {
      await primero.cerrar();
      await reinicio?.cerrar();
      await otroReinicio?.cerrar();
    }
  });
});

describe('estimación con el caché en Redis', () => {
  it('MISS y después HIT; tras el PUT, la próxima estimación usa la tarifa nueva y su versión', async () => {
    const antes = await estimar(d);
    expect(antes.tarifaVersion).toBe('v1');
    expect(JSON.parse((await enCache(d, 'v1'))!)).toMatchObject({ version: 'v1', bajadaCentavos: 150_000 });
    await estimar(d);
    const metricas = (await request(d.url).get('/metrics').set(CON_METRICAS)).text;
    expect(metricas).toMatch(/^dispatch_tarifas_cache_total\{resultado="hit",servicio="dispatch"\} [1-9]/m);

    expect((await configurar(d)).status).toBe(200);
    const despues = await estimar(d);

    expect(despues.tarifaVersion).toBe('v2');
    expect(despues.desglose.bajadaCentavos).toBe(NUEVA.bajadaCentavos);
    expect(despues.tarifaCentavos).not.toBe(antes.tarifaCentavos);
    expect(despues.tarifaCentavos).toBe(await esperado(d, despues));
    // Invalidación después del COMMIT: la nueva queda cargada y la anterior se borra.
    expect(await enCache(d, 'v2')).not.toBeNull();
    expect(await enCache(d, 'v1')).toBeNull();
  });

  it('si falla el borrado del caché, la v1 queda en Redis pero la estimación igual usa la v2', async () => {
    const sinBorrar = await levantarDispatch({
      tarifas: { cache: (real) => ({ ...real, borrar: () => Promise.reject(new Error('redis no borra')) }) },
    });
    try {
      expect((await estimar(sinBorrar)).tarifaVersion).toBe('v1');
      expect(await enCache(sinBorrar, 'v1')).not.toBeNull();

      expect((await configurar(sinBorrar)).status).toBe(200);
      const despues = await estimar(sinBorrar);
      expect(await enCache(sinBorrar, 'v1')).not.toBeNull();
      expect(despues.tarifaVersion).toBe('v2');
      expect(despues.tarifaCentavos).toBe(await esperado(sinBorrar, despues));
    } finally {
      await sinBorrar.cerrar();
    }
  });

  it('si Redis falla como caché de lectura, estima con Postgres y ve el cambio igual', async () => {
    const caido: CacheTarifas = {
      leer: () => Promise.reject(new Error('ECONNREFUSED')),
      guardar: () => Promise.reject(new Error('ECONNREFUSED')),
      borrar: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const sinCache = await levantarDispatch({ tarifas: { cache: () => caido } });
    try {
      expect((await estimar(sinCache)).tarifaVersion).toBe('v1');
      expect((await configurar(sinCache)).status).toBe(200);
      const despues = await estimar(sinCache);
      expect(despues.tarifaVersion).toBe('v2');
      expect(despues.tarifaCentavos).toBe(await esperado(sinCache, despues));
      const metricas = (await request(sinCache.url).get('/metrics').set(CON_METRICAS)).text;
      expect(metricas).toMatch(/^dispatch_tarifas_cache_total\{resultado="error",servicio="dispatch"\} [1-9]/m);
    } finally {
      await sinCache.cerrar();
    }
  });

  it('con un Redis de verdad que no responde, la estimación no se cuelga: corta en el tiempo límite y usa Postgres', async () => {
    const muerto = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false });
    const sinRedis = await levantarDispatch({
      tarifas: { cache: () => cacheTarifasRedis(muerto, { prefijo: 'x:', ttlSegundos: 60, timeoutMs: 200 }) },
    });
    try {
      const inicio = Date.now();
      expect((await estimar(sinRedis)).tarifaVersion).toBe('v1');
      expect(Date.now() - inicio).toBeLessThan(1500);
    } finally {
      await sinRedis.cerrar();
      muerto.disconnect();
    }
  });

  it('estimaciones concurrentes con un PUT: cada una es coherente con su versión, y la siguiente al PUT ya ve la v2', async () => {
    await estimar(d); // caché cargado con la v1
    const durante = Promise.all(Array.from({ length: 10 }, () => estimar(d)));
    const put = configurar(d);
    const [estimaciones, res] = await Promise.all([durante, put]);
    expect(res.status).toBe(200);
    for (const e of estimaciones) {
      expect(['v1', 'v2']).toContain(e.tarifaVersion);
      expect(e.tarifaCentavos).toBe(await esperado(d, e));
    }
    expect((await estimar(d)).tarifaVersion).toBe('v2');
  });
});

describe('modo memoria', () => {
  it('GET, PUT con Idempotency-Key, reintento y estimación funcionan sin Postgres ni Redis', async () => {
    const tokens = await crearEmisorTokens();
    const s = componer(configTest({ DISPATCH_PERSISTENCIA: 'memoria' }), crearLogger('dispatch-test', 'silent'), {
      verificador: tokens.verificador,
    });
    try {
      const admin = await tokens.auth(randomUUID(), 'admin');
      expect((await request(s.app).get('/admin/tarifas').set(admin)).body).toMatchObject({ version: 'v1', actualizadaPor: 'semilla' });

      const encabezados = clave();
      const primera = await request(s.app).put('/admin/tarifas').set(encabezados).set(admin).send(NUEVA);
      const segunda = await request(s.app).put('/admin/tarifas').set(encabezados).set(admin).send(NUEVA);
      expect(primera.status).toBe(200);
      expect(primera.body.version).toBe('v2');
      expect(segunda.headers['idempotent-replayed']).toBe('true');
      expect(segunda.text).toBe(primera.text);
      expect((await request(s.app).get('/admin/tarifas').set(admin)).body.version).toBe('v2');

      const e = await request(s.app).get('/tarifas/estimacion').query(QUERY).set(await tokens.auth(randomUUID(), 'pasajero'));
      expect(e.body).toMatchObject({ tarifaVersion: 'v2', desglose: { bajadaCentavos: NUEVA.bajadaCentavos } });
    } finally {
      await s.cerrar();
    }
  });
});
