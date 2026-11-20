import { fileURLToPath } from 'node:url';
import type { Reloj } from '@viajes/kernel';
import { crearApp, verificadorJwks, type ChequeoListo, type Logger, type VerificadorToken } from '@viajes/platform';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type { Config } from './config/index.js';
import { crearCasosDeUso, type CasosDeUso } from './dominio/casos-uso/index.js';
import type { RepositorioUbicaciones } from './dominio/puertos/index.js';
import { crearPrisma } from './infra/db/cliente.js';
import { RepositorioUbicacionesIngenuo } from './infra/db/repositorio-ingenuo.js';
import { chequeosBase, conTiempoLimite } from './infra/db/salud.js';
import { relojSistema } from './infra/externos/sistema.js';
import { rutaMetricas } from './infra/http/metricas.js';
import { rutasUbicacion } from './infra/http/rutas.js';
import { RepositorioUbicacionesMemoria } from './infra/memoria/repositorio-memoria.js';
import { clavesUbicacion } from './infra/redis/claves.js';
import { crearRedis, crearRedisBloqueante } from './infra/redis/cliente.js';
import {
  ConsumidorHistorial,
  EscritorHistorialPrisma,
  type EscritorHistorial,
} from './infra/redis/historial.js';
import { RepositorioUbicacionesGeo } from './infra/redis/repositorio-geo.js';

/** Reemplazos para tests: cualquier adaptador se puede inyectar desde afuera. */
export interface Reemplazos {
  verificador?: VerificadorToken;
  repo?: RepositorioUbicaciones;
  reloj?: Reloj;
  /** Solo optimizada: para simular caídas de Postgres en el historial. */
  escritorHistorial?: EscritorHistorial;
}

export interface Sistema {
  app: Express;
  casos: CasosDeUso;
  repo: RepositorioUbicaciones;
  /** Solo optimizada. */
  historial?: ConsumidorHistorial;
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
  const casos = crearCasosDeUso({ repo, reloj, vigenciaMs });

  const verificador =
    reemplazos.verificador ??
    verificadorJwks(config.JWKS_URL, { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE });

  const consumidor = historial;
  const metricas = rutaMetricas(config.UBICACION_ESTRATEGIA, consumidor ? () => consumidor.estado() : undefined);
  const app = crearApp({
    logger,
    rutas: rutasUbicacion(casos, verificador, config.LOCATION_TOKEN_SERVICIO, metricas),
    chequeos,
  });
  return { app, casos, repo, historial, iniciar, cerrar };
}
