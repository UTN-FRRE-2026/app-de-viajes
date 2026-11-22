import {
  canalPosicionChofer,
  canalPosicionPasajero,
  TIPO_POSICION_CHOFER,
  TIPO_POSICION_PASAJERO,
  type PosicionChoferPublicada,
  type PosicionPasajeroPublicada,
} from '@viajes/contracts';
import type { Logger } from '@viajes/platform';
import { Redis } from 'ioredis';
import type { Ping, PingPasajero } from '../../dominio/entidades/index.js';
import type { PublicadorPosiciones, QuienPublica, ResultadoPublicacion } from '../../dominio/puertos/index.js';

/** Espera máxima de la confirmación de una publicación. El 204 del ping espera, como mucho, esto. */
export const TIMEOUT_PUBLICACION_MS = 200;

/**
 * Conexión propia para publicar, separada de la que guarda las posiciones:
 * - `commandTimeout`: si Redis no confirma en 200 ms, la publicación se da por fallida. Un timeout
 *   significa que faltó la confirmación, no que no se publicó: el comando pudo haberse ejecutado igual.
 * - `enableOfflineQueue: false`: sin conexión, falla enseguida; no acumula comandos para mandarlos
 *   al reconectar (una posición vieja, mandada tarde, sería ruido).
 * - `autoResendUnfulfilledCommands: false` y `maxRetriesPerRequest: 0`: lo que se mandó y no tuvo
 *   respuesta antes de un corte falla y no se reenvía al reconectar.
 */
export function crearRedisPublicador(url: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    commandTimeout: TIMEOUT_PUBLICACION_MS,
    connectTimeout: 2000,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    maxRetriesPerRequest: 0,
  });
  redis.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis (publicador de posiciones): error de conexión'));
  return redis;
}

/**
 * Publica solo si el ping no es más viejo que la última posición publicada en ese canal (del chofer o
 * del pasajero: el mismo script para los dos), de forma
 * atómica: dos pedidos del mismo chofer que se cruzan (o dos instancias de location) no pueden
 * anunciar una posición vieja después de una nueva. A igual milisegundo publica, como el guardado.
 * KEYS: marca de la última publicada. ARGV: canal, tsMs, payload, ttlMs. Devuelve 1 si publicó.
 */
const PUBLICAR = `
local previo = redis.call('GET', KEYS[1])
if previo and tonumber(ARGV[2]) < tonumber(previo) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[4])
redis.call('PUBLISH', ARGV[1], ARGV[3])
return 1`;

export const marcaPublicada = (prefijo: string, choferId: string) => `${prefijo}publicada:${choferId}`;
/** La marca del pasajero, en su propio espacio de nombres: nunca se mezcla con la de un chofer. */
export const marcaPublicadaPasajero = (prefijo: string, pasajeroId: string) => `${prefijo}publicada-pasajero:${pasajeroId}`;

export class PublicadorPosicionesRedis implements PublicadorPosiciones {
  constructor(
    private readonly redis: Redis,
    private readonly opciones: {
      /** `LOCATION_REDIS_PREFIJO`: el del canal y el de la marca. */
      prefijo: string;
      /**
       * Vida de la marca de la última publicada: 2 × la vigencia. Mientras existe, el orden está
       * garantizado; cuando vence, un ping más viejo igual se descarta por vencido en el caso de uso.
       */
      marcaMs: number;
    },
  ) {}

  async publicar({ choferId, posicion, registradoEn }: Ping): Promise<'publicada' | 'atrasada'> {
    const mensaje: PosicionChoferPublicada = {
      tipo: TIPO_POSICION_CHOFER,
      choferId,
      lat: posicion.lat,
      lng: posicion.lng,
      actualizadaEn: registradoEn.toISOString(),
    };
    const { prefijo } = this.opciones;
    return this.publicarEnOrden(marcaPublicada(prefijo, choferId), canalPosicionChofer(prefijo, choferId), registradoEn, mensaje);
  }

  async publicarPasajero({ pasajeroId, posicion, registradoEn }: PingPasajero): Promise<'publicada' | 'atrasada'> {
    const mensaje: PosicionPasajeroPublicada = {
      tipo: TIPO_POSICION_PASAJERO,
      pasajeroId,
      lat: posicion.lat,
      lng: posicion.lng,
      actualizadaEn: registradoEn.toISOString(),
    };
    const { prefijo } = this.opciones;
    return this.publicarEnOrden(
      marcaPublicadaPasajero(prefijo, pasajeroId),
      canalPosicionPasajero(prefijo, pasajeroId),
      registradoEn,
      mensaje,
    );
  }

  /** El script de orden, igual para el chofer y el pasajero: cambian la marca, el canal y el mensaje. */
  private async publicarEnOrden(marca: string, canal: string, registradoEn: Date, mensaje: object) {
    const publicada = await this.redis.eval(
      PUBLICAR,
      1,
      marca,
      canal,
      String(registradoEn.getTime()),
      JSON.stringify(mensaje),
      String(this.opciones.marcaMs),
    );
    return Number(publicada) === 1 ? 'publicada' : 'atrasada';
  }

  /**
   * Espera a que la conexión esté lista: sin cola offline, antes de eso cada publicación falla.
   * Devuelve `false` si no lo estuvo dentro del plazo (por ejemplo, con Redis caído).
   */
  async listo(timeoutMs = 2000): Promise<boolean> {
    if (this.redis.status === 'ready') return true;
    return new Promise<boolean>((resolver) => {
      const alListo = () => terminar(true);
      const plazo = setTimeout(() => terminar(false), timeoutMs);
      const terminar = (ok: boolean) => {
        clearTimeout(plazo);
        this.redis.off('ready', alListo);
        resolver(ok);
      };
      this.redis.once('ready', alListo);
    });
  }
}

/**
 * Registro de cada resultado: lo cuenta (métrica) y, si falló, lo avisa en el log como mucho una vez
 * por minuto, con cuántas fallaron desde el último aviso. A 250 pings por segundo, un aviso por ping
 * taparía el log.
 */
export function registroPublicacion(
  logger: Logger,
  contar: (resultado: ResultadoPublicacion, de: QuienPublica) => void,
  ahoraMs: () => number = Date.now,
) {
  let ultimoAviso = Number.NEGATIVE_INFINITY;
  let sinAvisar = 0;
  return (resultado: ResultadoPublicacion, err?: unknown, de: QuienPublica = 'chofer') => {
    contar(resultado, de);
    if (resultado !== 'error') return;
    sinAvisar += 1;
    if (ahoraMs() - ultimoAviso < 60_000) return;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), fallidas: sinAvisar },
      'location: no se pudo publicar una posición en vivo',
    );
    ultimoAviso = ahoraMs();
    sinAvisar = 0;
  };
}
