import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alNorte, OBELISCO } from '../soporte/memoria.js';
import { borrarPrefijo, crearRedisTest } from '../soporte/redis.js';
import { levantarLocation, TOKEN_SERVICIO, type Location } from '../soporte/sistema.js';

let redis: Redis;
beforeAll(() => {
  redis = crearRedisTest();
});
afterAll(() => {
  redis.disconnect();
});

const candidatos = (d: Location) =>
  request(d.url).get('/interno/candidatos').query({ lat: OBELISCO.lat, lng: OBELISCO.lng }).set(d.servicio);

describe('location optimizada por HTTP', () => {
  let d: Location;
  beforeAll(async () => {
    d = await levantarLocation({}, { UBICACION_ESTRATEGIA: 'optimizada' });
    await d.limpiar();
  });
  afterAll(async () => {
    await d.cerrar();
    await borrarPrefijo(redis, d.config.LOCATION_REDIS_PREFIJO);
  });

  it('ping → 204, búsqueda inmediata, y el historial llega a Postgres al vaciar la cola', async () => {
    const chofer = randomUUID();
    await request(d.url).post('/ubicaciones').set(await d.auth(chofer, 'chofer')).send(alNorte(250)).expect(204);
    expect((await candidatos(d)).body.candidatos.map((c: { choferId: string }) => c.choferId)).toEqual([chofer]);
    expect(await d.prisma.ping.count()).toBe(0); // todavía en la cola
    await d.historial?.preparar();
    await d.historial?.procesarNuevos(50);
    expect(await d.prisma.ping.count()).toBe(1);
  });

  it('/ready chequea Postgres, migraciones y Redis', async () => {
    const res = await request(d.url).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.chequeos).toEqual({ postgres: 'ok', migraciones: 'ok', redis: 'ok' });
  });

  it('/metrics exige el token de servicio e informa el lag y la cola', async () => {
    expect((await request(d.url).get('/metrics')).status).toBe(401);
    const res = await request(d.url).get('/metrics').set(d.servicio);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/location_event_loop_lag_ms\{quantile="0.99"\} \d/);
    expect(res.text).toMatch(/location_historial_en_cola \d+/);
    expect(res.text).toMatch(/location_historial_descartados_total \d+/);
    expect(res.text).toContain('location_estrategia{estrategia="optimizada"} 1');
    expect(res.text).not.toContain(TOKEN_SERVICIO);
  });
});

describe('location optimizada con dependencias caídas', () => {
  it('Redis caído → 503 en pings y búsquedas, y /ready lo informa', async () => {
    const d = await levantarLocation({}, { UBICACION_ESTRATEGIA: 'optimizada', REDIS_URL: 'redis://127.0.0.1:1/0' });
    try {
      const ping = await request(d.url).post('/ubicaciones').set(await d.auth(randomUUID(), 'chofer')).send(alNorte(100));
      expect(ping.status).toBe(503);
      expect(ping.body.error).toMatchObject({ code: 'UBICACION_NO_DISPONIBLE' });
      expect((await candidatos(d)).status).toBe(503);
      const listo = await request(d.url).get('/ready');
      expect(listo.status).toBe(503);
      expect(listo.body.chequeos.redis).not.toBe('ok');
    } finally {
      await d.cerrar();
    }
  });

  it('Postgres caído → los pings siguen entrando y la búsqueda funciona; /ready da 503 por postgres', async () => {
    const d = await levantarLocation(
      {},
      { UBICACION_ESTRATEGIA: 'optimizada', LOCATION_DATABASE_URL: 'postgresql://location_svc:x@127.0.0.1:1/location_test' },
    );
    try {
      const chofer = randomUUID();
      expect((await request(d.url).post('/ubicaciones').set(await d.auth(chofer, 'chofer')).send(alNorte(100))).status).toBe(204);
      expect((await candidatos(d)).body.candidatos).toHaveLength(1);
      const listo = await request(d.url).get('/ready');
      expect(listo.status).toBe(503);
      expect(listo.body.chequeos).toMatchObject({ redis: 'ok' });
      expect(listo.body.chequeos.postgres).not.toBe('ok');
      expect(await redis.xlen(`${d.config.LOCATION_REDIS_PREFIJO}historial`)).toBe(1); // esperando a Postgres
    } finally {
      await d.cerrar().catch(() => undefined);
      await borrarPrefijo(redis, d.config.LOCATION_REDIS_PREFIJO);
    }
  });
});
