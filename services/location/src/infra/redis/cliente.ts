import type { Logger } from '@viajes/platform';
import { Redis } from 'ioredis';

/** Falla rápido: si Redis no responde, el pedido contesta 503 enseguida en vez de quedar colgado. */
export function crearRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 2000, commandTimeout: 1000 });
  redis.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis: error de conexión'));
  return redis;
}

/**
 * Conexión propia para la lectura bloqueante del historial (XREADGROUP BLOCK): mientras espera,
 * la conexión no atiende otros comandos, así que no puede ser la misma que usan los pedidos HTTP.
 * Sin timeout por comando, porque la espera es intencional y la acota el propio BLOCK.
 */
export function crearRedisBloqueante(base: Redis, logger: Logger): Redis {
  const redis = base.duplicate({ commandTimeout: undefined, maxRetriesPerRequest: null });
  redis.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis (historial): error de conexión'));
  return redis;
}
