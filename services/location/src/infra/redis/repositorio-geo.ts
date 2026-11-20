import { ErrorHttp, type Logger } from '@viajes/platform';
import type { Redis } from 'ioredis';
import { seleccionarCercanos, type Cercano, type Ping } from '../../dominio/entidades/index.js';
import type { BusquedaCercanos, RepositorioUbicaciones } from '../../dominio/puertos/index.js';
import type { ClavesUbicacion } from './claves.js';

/** Límite de latitud de Redis GEO (proyección web Mercator). Fuera de esto, GEOADD falla. */
export const LATITUD_MAX_GEO = 85.05112878;

/**
 * Margen del radio que se le pide a Redis, para no perder puntos en el borde:
 * - Redis mide sobre una esfera de 6 372 797,6 m y el dominio sobre una de 6 371 008,8 m: las
 *   distancias de Redis son un 0,028 % más largas. 0,1 % cubre ese desvío unas 3,5 veces.
 * - Redis guarda cada punto como un geohash de 52 bits: hasta ~0,34 m de error. 1 m lo cubre 3 veces.
 * Lo que entra de más lo descarta el filtro exacto del dominio (seleccionarCercanos).
 */
export const radioConMargen = (radioMetros: number) => radioMetros * 1.001 + 1;

const enRangoGeo = (lat: number) => Math.abs(lat) <= LATITUD_MAX_GEO;

/**
 * Escribe una posición y la encola para el historial, de forma atómica.
 * KEYS: posiciones, geo, vistos, fueraGeo, historial, descartados
 * ARGV: choferId, lat, lng, tsMs, maxCola, enGeo ('1' | '0')
 * - Si llega un ping más viejo que el guardado (red lenta, reintento), no pisa la posición.
 * - Si la cola del historial está llena, la posición se actualiza igual (el servicio no se corta),
 *   la entrada no se encola y se cuenta como descartada. No se recorta lo viejo: puede estar pendiente.
 * Devuelve 1 si encoló el historial y 0 si lo descartó.
 */
const GUARDAR = `
local previo = redis.call('ZSCORE', KEYS[3], ARGV[1])
if (not previo) or tonumber(ARGV[4]) >= tonumber(previo) then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2] .. '|' .. ARGV[3] .. '|' .. ARGV[4])
  redis.call('ZADD', KEYS[3], ARGV[4], ARGV[1])
  if ARGV[6] == '1' then
    redis.call('GEOADD', KEYS[2], ARGV[3], ARGV[2], ARGV[1])
    redis.call('SREM', KEYS[4], ARGV[1])
  else
    redis.call('ZREM', KEYS[2], ARGV[1])
    redis.call('SADD', KEYS[4], ARGV[1])
  end
end
if redis.call('XLEN', KEYS[5]) >= tonumber(ARGV[5]) then
  redis.call('INCR', KEYS[6])
  return 0
end
redis.call('XADD', KEYS[5], '*', 'c', ARGV[1], 'la', ARGV[2], 'ln', ARGV[3], 't', ARGV[4])
return 1`;

/**
 * Purga atómica de posiciones vencidas, de a lotes. Atómica porque entre leer los vencidos y
 * borrarlos un chofer puede volver a reportar: dentro del script nadie más escribe.
 * KEYS: posiciones, geo, vistos, fueraGeo. ARGV: desdeMs, lote. Devuelve cuántos borró.
 */
const PURGAR = `
local vencidos = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', '(' .. ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
for _, chofer in ipairs(vencidos) do
  redis.call('HDEL', KEYS[1], chofer)
  redis.call('ZREM', KEYS[2], chofer)
  redis.call('ZREM', KEYS[3], chofer)
  redis.call('SREM', KEYS[4], chofer)
end
return #vencidos`;

/** Errores de Redis: 503, sin detalles internos. Falla cerrado: sin Redis no hay posiciones. */
function noDisponible(logger: Logger, operacion: string, err: unknown): never {
  logger.warn({ err: err instanceof Error ? err.message : String(err), operacion }, 'location: redis no responde');
  throw new ErrorHttp(503, 'UBICACION_NO_DISPONIBLE', 'El servicio de ubicación no está disponible');
}

/**
 * Versión optimizada de 6.6: posición vigente en Redis (índice GEO) e historial por cola.
 * Redis encuentra los candidatos del radio; la distancia, el radio exacto, el orden y el desempate
 * los decide el dominio con las coordenadas originales, igual que en las otras estrategias.
 */
export class RepositorioUbicacionesGeo implements RepositorioUbicaciones {
  constructor(
    private readonly redis: Redis,
    private readonly claves: ClavesUbicacion,
    private readonly opciones: { maxCola: number; logger: Logger },
  ) {}

  async guardar({ choferId, posicion, registradoEn }: Ping): Promise<void> {
    const c = this.claves;
    try {
      await this.redis.eval(
        GUARDAR,
        6,
        c.posiciones,
        c.geo,
        c.vistos,
        c.fueraGeo,
        c.historial,
        c.descartados,
        choferId,
        String(posicion.lat),
        String(posicion.lng),
        String(registradoEn.getTime()),
        String(this.opciones.maxCola),
        enRangoGeo(posicion.lat) ? '1' : '0',
      );
    } catch (err) {
      noDisponible(this.opciones.logger, 'guardar', err);
    }
  }

  async cercanos({ origen, radioMetros, limite, desde }: BusquedaCercanos): Promise<Cercano[]> {
    try {
      const miembros = await this.miembrosCandidatos(origen, radioMetros);
      if (miembros.length === 0) return [];
      const valores = await this.redis.hmget(this.claves.posiciones, ...miembros);
      const posiciones: Ping[] = [];
      miembros.forEach((choferId, i) => {
        const valor = valores[i];
        if (!valor) return; // purgado entre las dos lecturas
        const [lat, lng, ts] = valor.split('|').map(Number) as [number, number, number];
        // Vencimiento: aunque la purga todavía no haya pasado, una posición vieja no aparece.
        if (ts < desde.getTime()) return;
        posiciones.push({ choferId, posicion: { lat, lng }, registradoEn: new Date(ts) });
      });
      return seleccionarCercanos(posiciones, origen, { radioMetros, limite });
    } catch (err) {
      if (err instanceof ErrorHttp) throw err;
      noDisponible(this.opciones.logger, 'cercanos', err);
    }
  }

  /**
   * Candidatos gruesos: los del índice GEO dentro del radio (con margen) más los que están fuera
   * del rango de Redis. Si el origen está fuera de ese rango, GEO no sirve: se evalúan todos.
   */
  private async miembrosCandidatos(origen: { lat: number; lng: number }, radioMetros: number): Promise<string[]> {
    const c = this.claves;
    if (!enRangoGeo(origen.lat)) return this.redis.hkeys(c.posiciones);
    const resultado = await this.redis
      .multi()
      .geosearch(c.geo, 'FROMLONLAT', origen.lng, origen.lat, 'BYRADIUS', radioConMargen(radioMetros), 'm')
      .smembers(c.fueraGeo)
      .exec();
    if (!resultado) throw new Error('transacción de búsqueda abortada');
    const [[errGeo, enGeo], [errFuera, fuera]] = resultado as [[Error | null, string[]], [Error | null, string[]]];
    if (errGeo || errFuera) throw errGeo ?? errFuera;
    return fuera.length ? [...new Set([...enGeo, ...fuera])] : enGeo;
  }

  /** Borra las posiciones vencidas de las cuatro estructuras. Devuelve cuántas borró. */
  async purgarVencidos(desde: Date, lote = 1000): Promise<number> {
    const c = this.claves;
    let total = 0;
    for (;;) {
      const borrados = Number(
        await this.redis.eval(PURGAR, 4, c.posiciones, c.geo, c.vistos, c.fueraGeo, String(desde.getTime()), String(lote)),
      );
      total += borrados;
      if (borrados < lote) return total;
    }
  }
}
