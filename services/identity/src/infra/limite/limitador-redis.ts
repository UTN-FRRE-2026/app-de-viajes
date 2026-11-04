import type { Redis } from 'ioredis';
import type { EstadoLimite, LimitadorLogin } from '../../dominio/puertos/index.js';
import { huellaEmail, resumir, type ParametrosLimite } from './comun.js';

const PREFIJO = 'identity:login';

// INCR y PEXPIRE juntos: si se cayera el proceso entre los dos, la clave quedaría sin vencimiento
// y la cuenta bloqueada para siempre. Lua corre de forma atómica en Redis.
// Ventana fija: los intentos rechazados no la extienden.
const CONTAR = `
local resultado = {}
for _, clave in ipairs(KEYS) do
  local valor = redis.call('INCR', clave)
  if valor == 1 then redis.call('PEXPIRE', clave, ARGV[1]) end
  resultado[#resultado + 1] = valor
  resultado[#resultado + 1] = redis.call('PTTL', clave)
end
return resultado`;

export class LimitadorLoginRedis implements LimitadorLogin {
  constructor(
    private readonly redis: Redis,
    private readonly parametros: ParametrosLimite,
  ) {}

  async contar({ email, ip }: { email: string; ip: string }): Promise<EstadoLimite> {
    const { maxPorEmail, maxPorIp, ventanaMs } = this.parametros;
    const claves = [this.claveEmail(email), `${PREFIJO}:ip:${ip}`];
    const [valorEmail, ttlEmail, valorIp, ttlIp] = (await this.redis.eval(
      CONTAR,
      claves.length,
      ...claves,
      ventanaMs,
    )) as [number, number, number, number];
    return resumir([
      { valor: valorEmail, limite: maxPorEmail, ttlMs: ttlEmail },
      { valor: valorIp, limite: maxPorIp, ttlMs: ttlIp },
    ]);
  }

  async reiniciar(email: string): Promise<void> {
    await this.redis.del(this.claveEmail(email));
  }

  private claveEmail(email: string): string {
    return `${PREFIJO}:email:${huellaEmail(email)}`;
  }
}
