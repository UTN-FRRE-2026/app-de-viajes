import { fileURLToPath } from 'node:url';
import type { Reloj } from '@viajes/kernel';
import {
  contadorTasaMemoria,
  contadorTasaRedis,
  crearApp,
  crearMetricas,
  iniciarBarrido,
  limitarTasa,
  verificadorJwks,
  type ChequeoListo,
  type ContadorTasa,
  type Logger,
  type VerificadorToken,
} from '@viajes/platform';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import type { Config } from './config/index.js';
import { crearCasosDeUso, type CasosDeUso } from './dominio/casos-uso/index.js';
import type { PublicadorPosiciones, RepositorioUbicaciones, TramosDeViaje } from './dominio/puertos/index.js';
import { crearPrisma } from './infra/db/cliente.js';
import type { PrismaClient } from './infra/db/generated/client.js';
import { RepositorioUbicacionesIngenuo } from './infra/db/repositorio-ingenuo.js';
import { clasificarHistorial, purgarHistorial } from './infra/db/retencion.js';
import { TramosDeViajeDispatch } from './infra/externos/tramos-dispatch.js';
import { chequeosBase, conTiempoLimite } from './infra/db/salud.js';
import { relojSistema } from './infra/externos/sistema.js';
import { registrarMetricaPings, registrarMetricaPublicacion, registrarMetricasLocation } from './infra/http/metricas.js';
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
  /** Contador del límite de tasa: uno propio (tests). Por defecto, Redis en la optimizada y memoria en las otras. */
  contadorTasa?: ContadorTasa;
  verificador?: VerificadorToken;
  repo?: RepositorioUbicaciones;
  reloj?: Reloj;
  /** Solo optimizada: para simular caídas de Postgres en el historial. */
  escritorHistorial?: EscritorHistorial;
  /** Los viajes de dispatch para la retención por viaje: uno propio, o `null` para no clasificar. */
  tramos?: TramosDeViaje | null;
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
  /** Arranca lo que corre en segundo plano (consumidor del historial, purga y retención del historial). */
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
  // Un solo proceso de location: en memoria la cuenta es exacta. Con Redis (optimizada), compartida.
  let contadorTasa: ContadorTasa = reemplazos.contadorTasa ?? contadorTasaMemoria();

  // Retención del historial: la misma tabla `pings` en las dos estrategias con Postgres.
  // Retención por viaje: los pings sin viaje duran menos. Hace falta preguntarle a dispatch; sin URL o
  // sin token no se clasifica y todos duran la retención total (falla cerrado: nunca se borra de más).
  const tramos: TramosDeViaje | null =
    reemplazos.tramos !== undefined
      ? reemplazos.tramos
      : config.DISPATCH_URL && config.DISPATCH_TOKEN_SERVICIO
        ? new TramosDeViajeDispatch({ urlBase: config.DISPATCH_URL, tokenServicio: config.DISPATCH_TOKEN_SERVICIO, timeoutMs: config.DISPATCH_TIMEOUT_MS })
        : null;
  let detenerRetencion = async () => {};
  const iniciarRetencion = (prisma: PrismaClient) => {
    const purgar = purgarHistorial(prisma, {
      retencionMs: config.LOCATION_HISTORIAL_RETENCION_HORAS * 3_600_000,
      reloj,
      lote: config.LOCATION_HISTORIAL_RETENCION_LOTE,
    });
    const intervalo = config.LOCATION_HISTORIAL_RETENCION_INTERVALO_MS;
    const detenerPurga = iniciarBarrido(purgar, intervalo, logger, 'historial de ubicaciones vencido');
    let detenerClasificacion = async () => {};
    if (tramos) {
      const clasificar = clasificarHistorial(prisma, {
        sinViajeMs: config.LOCATION_HISTORIAL_SIN_VIAJE_HORAS * 3_600_000,
        reloj,
        tramos,
        lote: config.LOCATION_HISTORIAL_RETENCION_LOTE,
        alFallar: (err) =>
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'retención: dispatch no respondió; los pings sin clasificar se conservan'),
      });
      detenerClasificacion = iniciarBarrido(clasificar, intervalo, logger, 'pings sin viaje vencidos');
    } else {
      logger.info('retención: sin DISPATCH_URL o DISPATCH_TOKEN_SERVICIO, los pings sin viaje se conservan hasta la retención total');
    }
    detenerRetencion = async () => {
      await Promise.all([detenerPurga(), detenerClasificacion()]);
    };
  };

  if (reemplazos.repo) {
    repo = reemplazos.repo;
  } else if (config.UBICACION_ESTRATEGIA === 'memoria') {
    repo = new RepositorioUbicacionesMemoria();
  } else if (config.UBICACION_ESTRATEGIA === 'ingenua') {
    const prisma = crearPrisma(config.LOCATION_DATABASE_URL as string, config.DB_POOL_MAX);
    repo = new RepositorioUbicacionesIngenuo(prisma);
    chequeos = chequeosBase(prisma, carpetaMigraciones);
    iniciar = () => iniciarRetencion(prisma);
    cerrar = async () => {
      await detenerRetencion();
      await prisma.$disconnect();
    };
  } else {
    // Optimizada: posiciones en Redis; Postgres solo para el historial, escrito en lotes.
    const prisma = crearPrisma(config.LOCATION_DATABASE_URL as string, config.DB_POOL_MAX);
    const redis = crearRedis(config.REDIS_URL as string, logger);
    const bloqueante = crearRedisBloqueante(redis, logger);
    const claves = clavesUbicacion(config.LOCATION_REDIS_PREFIJO);
    const geo = new RepositorioUbicacionesGeo(redis, claves, { maxCola: config.LOCATION_HISTORIAL_MAX, logger });
    contadorTasa = reemplazos.contadorTasa ?? contadorTasaRedis(redis, `${config.LOCATION_REDIS_PREFIJO}tasa:`);
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
      iniciarRetencion(prisma);
      // nosemgrep: ajinabraham.njsscan.eval.eval_node.eval_nodejs -- setInterval con una función, no con un texto: no evalúa nada.
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
      await detenerRetencion();
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
    rutas: rutasUbicacion(
      casos,
      verificador,
      config.LOCATION_TOKEN_SERVICIO,
      limitarTasa({ contador: contadorTasa, nombre: 'ubicaciones', maximo: config.LIMITE_UBICACIONES_POR_MINUTO, ventanaMs: 60_000, logger }),
      registrarMetricaPings(metricas, config.UBICACION_ESTRATEGIA),
    ),
    chequeos,
    metricas: { metricas, token: config.METRICAS_TOKEN },
    confiarEnProxy: config.CONFIAR_EN_PROXY,
    logPedidos: config.LOG_PEDIDOS,
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
