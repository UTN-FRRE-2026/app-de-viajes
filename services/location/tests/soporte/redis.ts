import { randomUUID } from 'node:crypto';
import { crearLogger } from '@viajes/platform';
import { Redis } from 'ioredis';
import { clavesUbicacion } from '../../src/infra/redis/claves.js';
import { RepositorioUbicacionesGeo } from '../../src/infra/redis/repositorio-geo.js';

/** Base 14: identity usa la 15 y la vacía entera en cada test. Acá cada suite usa su propio prefijo. */
export const URL_REDIS_TEST = process.env.LOCATION_REDIS_URL_TEST ?? 'redis://localhost:6379/14';

export const prefijoUnico = () => `test:${randomUUID().slice(0, 8)}:`;

export const loggerSilencioso = crearLogger('location-test', 'silent');

export function crearRedisTest(): Redis {
  return new Redis(URL_REDIS_TEST, { maxRetriesPerRequest: 1 });
}

/** Repositorio optimizado aislado: prefijo propio, así los tests no se pisan entre sí. */
export function repositorioGeoTest(redis: Redis, maxCola = 1_000_000) {
  const claves = clavesUbicacion(prefijoUnico());
  return { claves, repo: new RepositorioUbicacionesGeo(redis, claves, { maxCola, logger: loggerSilencioso }) };
}

/** Borra todas las claves de un prefijo (solo en la base de tests). */
export async function borrarPrefijo(redis: Redis, prefijo: string) {
  let cursor = '0';
  do {
    const [siguiente, claves] = await redis.scan(cursor, 'MATCH', `${prefijo}*`, 'COUNT', 500);
    if (claves.length) await redis.del(...claves);
    cursor = siguiente;
  } while (cursor !== '0');
}
