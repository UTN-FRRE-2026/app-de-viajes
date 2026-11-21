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

/**
 * Escucha un canal de posición con una conexión de suscripción propia. Para afirmar que NO llegó
 * nada, `hasta()` publica un centinela en el mismo canal y espera a recibirlo: Redis entrega en orden,
 * así que lo que se hubiera publicado antes ya habría llegado.
 */
export async function escucharCanal(redis: Redis, canal: string) {
  const suscriptor = redis.duplicate();
  const mensajes: unknown[] = [];
  const centinelas = new Map<string, () => void>();
  suscriptor.on('message', (c: string, texto: string) => {
    if (c !== canal) return;
    const centinela = centinelas.get(texto);
    if (centinela) return centinela();
    mensajes.push(JSON.parse(texto));
  });
  await suscriptor.subscribe(canal);
  return {
    mensajes,
    /** Devuelve lo recibido hasta este momento (incluido todo lo publicado antes de llamarla). */
    async hasta(): Promise<unknown[]> {
      const marca = `centinela:${randomUUID()}`;
      const llegó = new Promise<void>((r) => centinelas.set(marca, r));
      await redis.publish(canal, marca);
      await llegó;
      centinelas.delete(marca);
      return [...mensajes];
    },
    cerrar: () => suscriptor.disconnect(),
  };
}
