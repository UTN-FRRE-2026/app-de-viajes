import { fileURLToPath } from 'node:url';
import type { Reloj } from '@viajes/kernel';
import {
  crearApp,
  crearMetricas,
  verificadorJwks,
  type ChequeoListo,
  type Logger,
  type VerificadorToken,
} from '@viajes/platform';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type { Config } from './config/index.js';
import { crearCasosDeUso, type CasosDeUso } from './dominio/casos-uso/index.js';
import type { PublicadorPosiciones, RepositorioUbicaciones } from './dominio/puertos/index.js';
import { crearPrisma } from './infra/db/cliente.js';
import { RepositorioUbicacionesIngenuo } from './infra/db/repositorio-ingenuo.js';
import { chequeosBase, conTiempoLimite } from './infra/db/salud.js';
import { relojSistema } from './infra/externos/sistema.js';
import { registrarMetricaPublicacion, registrarMetricasLocation } from './infra/http/metricas.js';
import { rutasUbicacion } from './infra/http/rutas.js';
import { RepositorioUbicacionesMemoria } from './infra/memoria/repositorio-memoria.js';
import { clavesUbicacion } from './infra/redis/claves.js';
import { crearRedis, crearRedisBloqueante } from './infra/redis/cliente.js';
import {
  ConsumidorHistorial,
  EscritorHistorialPrisma,
  type EscritorHistorial,
} from './infra/redis/historial.js';
import {
  crearRedisPublicador,
  PublicadorPosicionesRedis,
  registroPublicacion,
} from './infra/redis/publicador-posiciones.js';
import { RepositorioUbicacionesGeo } from './infra/redis/repositorio-geo.js';

/** Reemplazos para tests: cualquier adaptador se puede inyectar desde afuera. */
export interface Reemplazos {
  verificador?: VerificadorToken;
  repo?: RepositorioUbicaciones;
  reloj?: Reloj;
  /** Solo optimizada: para simular caídas de Postgres en el historial. */
  escritorHistorial?: EscritorHistorial;
  /** Posición en vivo: un publicador propio, o `null` para desactivarla. */
  publicador?: PublicadorPosiciones | null;
}

export interface Sistema {
  app: Express;
  casos: CasosDeUso;
  repo: RepositorioUbicaciones;
  /** Solo optimizada. */
  historial?: ConsumidorHistorial;
  /** El publicador de posiciones en vivo, si se armó con Redis (los tests esperan a que esté listo). */
  publicador?: PublicadorPosicionesRedis;
  /** Arranca lo que corre en segundo plano (consumidor del historial y purga). */
  iniciar: () => void;
  /** Detiene lo de segundo plano (vaciando el historial pendiente) y cierra las conexiones. */
  cerrar: () => Promise<void>;
}

const carpetaMigraciones = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

function chequeoRedis(redis: Redis): ChequeoListo {
  return { nombre: 'redis', chequear: async () => void (await redis.ping()) };
}

/** Único lugar que conoce los adaptadores concretos. La estrategia de 6.6 se elige acá. */
export function componer(config: Config, logger: Logger, reemplazos: Reemplazos = {}): Sistema {
  const reloj = reemplazos.reloj ?? relojSistema;
  const vigenciaMs = config.UBICACION_VIGENCIA_SEGUNDOS * 1000;
  let repo: RepositorioUbicaciones;
  let historial: ConsumidorHistorial | undefined;
  let chequeos: ChequeoListo[] = [];
  let iniciar = () => {};
  let cerrar = async () => {};

  if (reemplazos.repo) {
    repo = reemplazos.repo;
  } else if (config.UBICACION_ESTRATEGIA === 'memoria') {
    repo = new RepositorioUbicacionesMemoria();
  } else if (config.UBICACION_ESTRATEGIA === 'ingenua') {
    const prisma = crearPrisma(config.LOCATION_DATABASE_URL as string, config.DB_POOL_MAX);
    repo = new RepositorioUbicacionesIngenuo(prisma);
    chequeos = chequeosBase(prisma, carpetaMigraciones);
    cerrar = () => prisma.$disconnect();
  } else {
    // Optimizada: posiciones en Redis; Postgres solo para el historial, escrito en lotes.
    const prisma = crearPrisma(config.LOCATION_DATABASE_URL as string, config.DB_POOL_MAX);
    const redis = crearRedis(config.REDIS_URL as string, logger);
    const bloqueante = crearRedisBloqueante(redis, logger);
    const claves = clavesUbicacion(config.LOCATION_REDIS_PREFIJO);
    const geo = new RepositorioUbicacionesGeo(redis, claves, { maxCola: config.LOCATION_HISTORIAL_MAX, logger });
    repo = geo;
    historial = new ConsumidorHistorial(
      redis,
      bloqueante,
      claves,
      reemplazos.escritorHistorial ?? new EscritorHistorialPrisma(prisma),
      {
        lote: config.LOCATION_HISTORIAL_LOTE,
        esperaMs: config.LOCATION_HISTORIAL_ESPERA_MS,
        reclamoMs: config.LOCATION_HISTORIAL_RECLAMO_MS,
        maxCola: config.LOCATION_HISTORIAL_MAX,
      },
      logger,
    );
    // Postgres en /ready aunque los pings entren igual: si está caído, el historial se acumula en
    // Redis y conviene que se note (ver docs/location.md).
    chequeos = [...chequeosBase(prisma, carpetaMigraciones), chequeoRedis(redis)];

    let purga: NodeJS.Timeout | undefined;
    const consumidor = historial;
    iniciar = () => {
      consumidor.iniciar();
      purga = setInterval(() => {
        geo
          .purgarVencidos(new Date(reloj.ahora().getTime() - vigenciaMs))
          .catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'purga: falló'));
      }, config.LOCATION_PURGA_INTERVALO_MS);
      purga.unref();
    };
    cerrar = async () => {
      clearInterval(purga);
      await consumidor.detener();
      bloqueante.disconnect();
      redis.disconnect();
      await prisma.$disconnect();
    };
  }

  chequeos = chequeos.map((c) => conTiempoLimite(c));

  // Posición en vivo, con cualquier estrategia (Compose corre la ingenua): una conexión propia a Redis,
  // que falla rápido y no reenvía. No entra en /ready: sin Redis, los pings se siguen registrando y lo
  // único que se cae es el seguimiento (se ve en location_posiciones_publicadas_total y en el log).
  let publicador: PublicadorPosiciones | undefined;
  let publicadorRedis: PublicadorPosicionesRedis | undefined;
  let cerrarPublicador = () => {};
  if (reemplazos.publicador !== undefined) {
    publicador = reemplazos.publicador ?? undefined;
  } else if (config.REDIS_URL) {
    const conexion = crearRedisPublicador(config.REDIS_URL, logger);
    publicadorRedis = new PublicadorPosicionesRedis(conexion, {
      prefijo: config.LOCATION_REDIS_PREFIJO,
      marcaMs: 2 * vigenciaMs,
    });
    publicador = publicadorRedis;
    cerrarPublicador = () => conexion.disconnect();
  } else {
    logger.info('location: sin REDIS_URL, la posición en vivo no se publica');
  }

  const metricas = crearMetricas({ servicio: 'location' });
  const alPublicar = registroPublicacion(logger, registrarMetricaPublicacion(metricas));
  const casos = crearCasosDeUso({ repo, reloj, vigenciaMs, publicador, alPublicar });

  const verificador =
    reemplazos.verificador ??
    verificadorJwks(config.JWKS_URL, { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE });

  const consumidor = historial;
  registrarMetricasLocation(metricas, config.UBICACION_ESTRATEGIA, consumidor ? () => consumidor.estado() : undefined);
  const app = crearApp({
    logger,
    rutas: rutasUbicacion(casos, verificador, config.LOCATION_TOKEN_SERVICIO),
    chequeos,
    metricas: { metricas, token: config.METRICAS_TOKEN },
  });
  const cerrarConexiones = cerrar;
  return {
    app,
    casos,
    repo,
    historial,
    publicador: publicadorRedis,
    iniciar,
    cerrar: async () => {
      metricas.detener();
      cerrarPublicador();
      await cerrarConexiones();
    },
  };
}
