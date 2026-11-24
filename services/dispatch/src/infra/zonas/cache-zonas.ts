import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { conTiempoLimite } from '../tarifas/proveedor-tarifas.js';
import { EsquemaMapaZonas, type MapaZonas } from './mapa-zonas.js';

/**
 * Caché del mapa de zonas, por generación. La generación es un token al azar en una clave aparte: cada
 * cambio de zonas pone uno nuevo, y lo guardado con el anterior deja de leerse (queda hasta su TTL).
 *
 * Por qué alcanza con eso: quien lee, lee **primero** la generación y **después** Postgres, y guarda lo
 * que leyó con la generación que leyó. Un cambio cambia la generación después de su COMMIT. Entonces lo
 * guardado con una generación incluye todos los cambios que la pusieron (o que pusieron alguna
 * anterior), y si un pedido lento guarda una foto vieja, la guarda con una generación que ya nadie lee.
 */
export interface CacheZonas {
  /** La generación vigente (la crea si no hay) y el mapa guardado con ella, o null (MISS). */
  leer(): Promise<{ generacion: string; mapa: MapaZonas | null }>;
  guardar(generacion: string, mapa: MapaZonas): Promise<void>;
  /** Una generación nueva: desde acá, la próxima lectura es un MISS y vuelve a Postgres. */
  invalidar(): Promise<void>;
}

function mapaValido(texto: string | null): MapaZonas | null {
  if (!texto) return null;
  try {
    const r = EsquemaMapaZonas.safeParse(JSON.parse(texto));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * En Redis: `<prefijo>generacion` (sin TTL) y `<prefijo>mapa:<generacion>` (JSON, con TTL). El TTL es
 * la red de seguridad: si una invalidación falla, o si alguien cambia zonas por SQL, el mapa viejo se
 * usa como mucho ese tiempo. Cada operación tiene un tiempo límite corto: si Redis tarda o no responde,
 * se lee Postgres. Lo que vuelve se valida: una entrada rota cuenta como MISS.
 */
export function cacheZonasRedis(redis: Redis, opciones: { prefijo: string; ttlSegundos: number; timeoutMs: number }): CacheZonas {
  const claveGeneracion = `${opciones.prefijo}generacion`;
  const claveMapa = (generacion: string) => `${opciones.prefijo}mapa:${generacion}`;

  async function generacionVigente(): Promise<string> {
    const actual = await redis.get(claveGeneracion);
    if (actual) return actual;
    // Primera lectura (o Redis vacío): se crea una. Si otro la creó a la vez, gana la suya.
    const nueva = randomUUID();
    if ((await redis.set(claveGeneracion, nueva, 'NX')) === 'OK') return nueva;
    const otra = await redis.get(claveGeneracion);
    if (!otra) throw new Error('zonas: no se pudo leer la generación del caché');
    return otra;
  }

  return {
    async leer() {
      return conTiempoLimite(
        (async () => {
          const generacion = await generacionVigente();
          return { generacion, mapa: mapaValido(await redis.get(claveMapa(generacion))) };
        })(),
        opciones.timeoutMs,
      );
    },
    async guardar(generacion, mapa) {
      await conTiempoLimite(redis.set(claveMapa(generacion), JSON.stringify(mapa), 'EX', opciones.ttlSegundos), opciones.timeoutMs);
    },
    async invalidar() {
      await conTiempoLimite(redis.set(claveGeneracion, randomUUID()), opciones.timeoutMs);
    },
  };
}

/**
 * En memoria, con las mismas reglas que el de Redis (sin TTL): para los tests, y para un dispatch con
 * una sola réplica que no quiera usar Redis para esto. No se comparte entre procesos.
 */
export function cacheZonasMemoria(): CacheZonas & { readonly mapas: Map<string, MapaZonas> } {
  let generacion = randomUUID();
  const mapas = new Map<string, MapaZonas>();
  return {
    mapas,
    async leer() {
      const guardado = mapas.get(generacion);
      // Una copia: quien lee no puede cambiar lo guardado.
      return { generacion, mapa: guardado ? structuredClone(guardado) : null };
    },
    async guardar(g, mapa) {
      mapas.set(g, structuredClone(mapa));
    },
    async invalidar() {
      mapas.delete(generacion);
      generacion = randomUUID();
    },
  };
}
