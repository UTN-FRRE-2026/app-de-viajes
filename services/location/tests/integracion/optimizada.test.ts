import { randomUUID } from 'node:crypto';
import { ErrorHttp } from '@viajes/platform';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clavesUbicacion } from '../../src/infra/redis/claves.js';
import { crearRedis } from '../../src/infra/redis/cliente.js';
import { LATITUD_MAX_GEO, RepositorioUbicacionesGeo } from '../../src/infra/redis/repositorio-geo.js';
import { probarCasosDeUbicacion } from '../soporte/casos-compartidos.js';
import { alNorte, OBELISCO, RelojFalso, sistemaCon, VIGENCIA_MS } from '../soporte/memoria.js';
import { borrarPrefijo, crearRedisTest, loggerSilencioso, repositorioGeoTest } from '../soporte/redis.js';

let redis: Redis;
const prefijos: string[] = [];

beforeAll(() => {
  redis = crearRedisTest();
});
afterAll(async () => {
  for (const p of prefijos) await borrarPrefijo(redis, p);
  redis.disconnect();
});

/** Repositorio con prefijo propio; anota el prefijo para borrarlo al final. */
function nuevoRepo(maxCola?: number) {
  const r = repositorioGeoTest(redis, maxCola);
  prefijos.push(r.claves.posiciones.replace(/pos$/, ''));
  return r;
}

// Las mismas reglas que memoria e ingenua.
probarCasosDeUbicacion('optimizada, Redis GEO', async () => nuevoRepo().repo);

describe('optimizada: lo propio de Redis', () => {
  it('guarda las coordenadas originales, sin la cuantización del geohash', async () => {
    const { repo, claves } = nuevoRepo();
    const s = sistemaCon(repo);
    const chofer = randomUUID();
    const exacta = { lat: -34.603712345678, lng: -58.381612345678 };
    await s.casos.registrarUbicacion({ choferId: chofer, ...exacta });
    const [lat, lng] = ((await redis.hget(claves.posiciones, chofer)) as string).split('|').map(Number);
    expect({ lat, lng }).toEqual(exacta);
    // El índice GEO, en cambio, devuelve la posición cuantizada.
    const [[lngGeo]] = (await redis.geopos(claves.geo, chofer)) as [[string, string]];
    expect(Number(lngGeo)).not.toBe(exacta.lng);
  });

  it('un vencido no aparece aunque la purga no haya corrido, y la purga lo borra de las cuatro claves', async () => {
    const { repo, claves } = nuevoRepo();
    const reloj = new RelojFalso();
    const s = sistemaCon(repo, reloj);
    const [viejo, nuevo, polar] = [randomUUID(), randomUUID(), randomUUID()];
    await s.casos.registrarUbicacion({ choferId: viejo, ...alNorte(100) });
    await s.casos.registrarUbicacion({ choferId: polar, lat: 89, lng: 0 });
    reloj.avanzar(VIGENCIA_MS + 1);
    await s.casos.registrarUbicacion({ choferId: nuevo, ...alNorte(200) });

    expect((await s.casos.buscarCandidatos({ origen: OBELISCO, radioMetros: 5000, limite: 10 })).map((c) => c.choferId)).toEqual([nuevo]);
    expect(await redis.hexists(claves.posiciones, viejo)).toBe(1);

    const borrados = await repo.purgarVencidos(new Date(reloj.ahora().getTime() - VIGENCIA_MS));
    expect(borrados).toBe(2);
    for (const chofer of [viejo, polar]) {
      expect(await redis.hexists(claves.posiciones, chofer)).toBe(0);
      expect(await redis.zscore(claves.vistos, chofer)).toBeNull();
      expect(await redis.zscore(claves.geo, chofer)).toBeNull();
      expect(await redis.sismember(claves.fueraGeo, chofer)).toBe(0);
    }
    expect(await redis.hexists(claves.posiciones, nuevo)).toBe(1);
  });

  it('un chofer que cruza al rango de Redis sale del conjunto fuera-geo, y viceversa', async () => {
    const { repo, claves } = nuevoRepo();
    const s = sistemaCon(repo);
    const chofer = randomUUID();
    await s.casos.registrarUbicacion({ choferId: chofer, lat: LATITUD_MAX_GEO + 0.01, lng: 0 });
    expect(await redis.sismember(claves.fueraGeo, chofer)).toBe(1);
    expect(await redis.zscore(claves.geo, chofer)).toBeNull();
    s.reloj.avanzar(1);
    await s.casos.registrarUbicacion({ choferId: chofer, lat: LATITUD_MAX_GEO - 0.01, lng: 0 });
    expect(await redis.sismember(claves.fueraGeo, chofer)).toBe(0);
    expect(await redis.zscore(claves.geo, chofer)).not.toBeNull();
  });

  it('cola del historial llena: la posición se actualiza igual y el descarte se cuenta', async () => {
    const { repo, claves } = nuevoRepo(5);
    const s = sistemaCon(repo);
    const choferes = Array.from({ length: 8 }, () => randomUUID());
    for (const [i, chofer] of choferes.entries()) await s.casos.registrarUbicacion({ choferId: chofer, ...alNorte(100 + i) });

    expect(await redis.xlen(claves.historial)).toBe(5);
    expect(await redis.get(claves.descartados)).toBe('3');
    const encontrados = await s.casos.buscarCandidatos({ origen: OBELISCO, radioMetros: 5000, limite: 100 });
    expect(encontrados.map((c) => c.choferId).sort()).toEqual([...choferes].sort());
  });

  it('Redis caído → 503 sin detalles, al guardar y al buscar (falla cerrado)', async () => {
    const caido = crearRedis('redis://127.0.0.1:1/0', loggerSilencioso);
    try {
      const repo = new RepositorioUbicacionesGeo(caido, clavesUbicacion('test:caido:'), { maxCola: 10, logger: loggerSilencioso });
      const s = sistemaCon(repo);
      const guardar = s.casos.registrarUbicacion({ choferId: randomUUID(), ...OBELISCO });
      await expect(guardar).rejects.toBeInstanceOf(ErrorHttp);
      await expect(guardar).rejects.toMatchObject({ estado: 503, codigo: 'UBICACION_NO_DISPONIBLE' });
      await expect(s.casos.buscarCandidatos({ origen: OBELISCO, radioMetros: 1000, limite: 5 })).rejects.toMatchObject({ estado: 503 });
    } finally {
      caido.disconnect();
    }
  });
});
