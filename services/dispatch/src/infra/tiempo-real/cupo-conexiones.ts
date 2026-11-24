import type { Redis } from 'ioredis';

/**
 * El cupo de streams SSE por usuario, **compartido entre instancias** de dispatch. Cada stream ocupa
 * un lugar con vencimiento: el latido lo renueva y el cierre lo suelta. Si una instancia muere sin
 * soltar sus lugares, vencen solos (no queda un usuario bloqueado para siempre).
 *
 * `StreamsEventos` cuenta además en su propio proceso, antes de cualquier await: eso hace atómico el
 * límite dentro de una instancia aunque este cupo no responda.
 */
export interface CupoConexiones {
  /** Toma un lugar para la conexión `id`. false si el usuario ya tiene `maximo` abiertas. */
  tomar(usuarioId: string, id: string, maximo: number, ttlMs: number): Promise<boolean>;
  /**
   * Corre el vencimiento del lugar (con cada latido). false si el lugar ya no está: venció (Redis no
   * respondió más que el TTL) o se perdió (Redis se reinició sin datos). Quien llama lo vuelve a tomar.
   */
  renovar(usuarioId: string, id: string, ttlMs: number): Promise<boolean>;
  soltar(usuarioId: string, id: string): Promise<void>;
}

// Un ZSET por usuario: miembro = conexión, puntaje = cuándo vence. Con la hora de Redis (TIME), no la de
// cada instancia: dos máquinas con el reloj corrido no se pisan los vencimientos. Un solo script:
// limpiar los vencidos, contar y agregar no se intercalan con otro pedido.
const AHORA = `local t = redis.call('TIME'); local ahora = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)`;
const TOMAR = `${AHORA}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ahora)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ahora + tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`;
// Primero se limpian los vencidos: un lugar vencido pudo dejar de contarse en un `TOMAR` de otra
// instancia, así que no se revive acá (se vuelve a tomar, respetando el límite).
const RENOVAR = `${AHORA}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ahora)
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], 'XX', ahora + tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`;

export function cupoConexionesRedis(redis: Redis, prefijo: string): CupoConexiones {
  const clave = (usuarioId: string) => `${prefijo}${usuarioId}`;
  return {
    async tomar(usuarioId, id, maximo, ttlMs) {
      return (await redis.eval(TOMAR, 1, clave(usuarioId), id, ttlMs, maximo)) === 1;
    },
    async renovar(usuarioId, id, ttlMs) {
      return (await redis.eval(RENOVAR, 1, clave(usuarioId), id, ttlMs)) === 1;
    },
    async soltar(usuarioId, id) {
      await redis.zrem(clave(usuarioId), id);
    },
  };
}
