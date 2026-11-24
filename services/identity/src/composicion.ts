import { fileURLToPath } from 'node:url';
import type { Reloj } from '@viajes/kernel';
import {
  AlmacenIdempotenciaMemoria,
  almacenIdempotenciaSql,
  CerrojoMemoria,
  cerrojoRedis,
  crearApp,
  crearIdempotencia,
  crearMetricas,
  purgarIdempotenciaSql,
  type AlmacenIdempotencia,
  type CerrojoEnVuelo,
  type ChequeoListo,
  type Logger,
} from '@viajes/platform';
import type { Express } from 'express';
import { Redis } from 'ioredis';
import type { Config } from './config/index.js';
import { crearCasosDeUso, type CasosDeUso } from './dominio/casos-uso/index.js';
import type {
  HasherContrasenas,
  LimitadorLogin,
  RepositorioSesiones,
  RepositorioUsuarios,
} from './dominio/puertos/index.js';
import { crearPrisma } from './infra/db/cliente.js';
import { RepositorioSesionesPrisma, RepositorioUsuariosPrisma } from './infra/db/repositorio-prisma.js';
import { chequeoRedis, chequeosBase } from './infra/db/salud.js';
import { EmisorJwt } from './infra/externos/emisor-jwt.js';
import { generadorRefresh } from './infra/externos/generador-refresh.js';
import { HasherArgon2 } from './infra/externos/hasher-argon2.js';
import { idsAleatorios, relojSistema } from './infra/externos/sistema.js';
import { rutasIdentidad } from './infra/http/rutas.js';
import { LimitadorLoginMemoria } from './infra/limite/limitador-memoria.js';
import { LimitadorLoginRedis } from './infra/limite/limitador-redis.js';
import { RepositorioSesionesMemoria, RepositorioUsuariosMemoria } from './infra/memoria/repositorio-memoria.js';

/** Reemplazos para tests: cualquier adaptador se puede inyectar desde afuera. */
export interface Reemplazos {
  repo?: RepositorioUsuarios;
  sesiones?: RepositorioSesiones;
  hasher?: HasherContrasenas;
  limitador?: LimitadorLogin;
  reloj?: Reloj;
  idempotencia?: { almacen: AlmacenIdempotencia; cerrojo: CerrojoEnVuelo };
}

export interface Sistema {
  app: Express;
  casos: CasosDeUso;
  repo: RepositorioUsuarios;
  /** Borra las claves de idempotencia vencidas; lo corre el servidor cada IDEMPOTENCIA_PURGA_INTERVALO_MS. */
  purgarIdempotencia: () => Promise<number>;
  cerrar: () => Promise<void>;
}

const carpetaMigraciones = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

/** Falla rápido: si Redis no responde, el login contesta 503 enseguida en vez de quedar colgado. */
function crearRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 2000, commandTimeout: 1000 });
  redis.on('error', (err: Error) => logger.warn({ err: err.message }, 'redis: error de conexión'));
  return redis;
}

/** Único lugar que conoce los adaptadores concretos. */
export function componer(config: Config, logger: Logger, reemplazos: Reemplazos = {}): Sistema {
  const reloj = reemplazos.reloj ?? relojSistema;
  const parametrosLimite = {
    maxPorEmail: config.IDENTITY_LOGIN_MAX_POR_EMAIL,
    maxPorIp: config.IDENTITY_LOGIN_MAX_POR_IP,
    ventanaMs: config.IDENTITY_LOGIN_VENTANA_SEGUNDOS * 1000,
  };

  let repo: RepositorioUsuarios;
  let sesiones: RepositorioSesiones;
  let limitador: LimitadorLogin;
  let chequeos: ChequeoListo[] = [];
  let cerrar = async () => {};
  let idempotencia = reemplazos.idempotencia ?? { almacen: new AlmacenIdempotenciaMemoria(), cerrojo: new CerrojoMemoria() };
  // En memoria no hace falta: el almacén vive lo que vive el proceso.
  let purgarIdempotencia = async () => 0;

  if (config.IDENTITY_PERSISTENCIA === 'memoria') {
    repo = reemplazos.repo ?? new RepositorioUsuariosMemoria();
    sesiones = reemplazos.sesiones ?? new RepositorioSesionesMemoria();
    limitador = reemplazos.limitador ?? new LimitadorLoginMemoria(parametrosLimite, reloj);
  } else {
    const prisma = crearPrisma(config.IDENTITY_DATABASE_URL as string, config.DB_POOL_MAX);
    const redis = crearRedis(config.REDIS_URL as string, logger);
    repo = reemplazos.repo ?? new RepositorioUsuariosPrisma(prisma);
    sesiones = reemplazos.sesiones ?? new RepositorioSesionesPrisma(prisma);
    limitador = reemplazos.limitador ?? new LimitadorLoginRedis(redis, parametrosLimite);
    idempotencia = reemplazos.idempotencia ?? {
      almacen: almacenIdempotenciaSql(prisma),
      cerrojo: cerrojoRedis(redis, 'identity:idempotencia:'),
    };
    purgarIdempotencia = purgarIdempotenciaSql(prisma, { retencionMs: config.IDEMPOTENCIA_RETENCION_HORAS * 3_600_000 });
    chequeos = [...chequeosBase(prisma, carpetaMigraciones), chequeoRedis(redis)];
    cerrar = async () => {
      redis.disconnect();
      await prisma.$disconnect();
    };
  }

  const casos = crearCasosDeUso({
    repo,
    sesiones,
    hasher:
      reemplazos.hasher ??
      new HasherArgon2({
        memoriaKib: config.ARGON2_MEMORIA_KIB,
        iteraciones: config.ARGON2_ITERACIONES,
        paralelismo: config.ARGON2_PARALELISMO,
      }),
    emisor: new EmisorJwt(
      config.IDENTITY_JWT_CLAVE_PRIVADA_B64,
      { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, ttlSegundos: config.JWT_TTL_SEGUNDOS },
      reloj,
      idsAleatorios,
    ),
    refresh: generadorRefresh,
    reloj,
    ids: idsAleatorios,
    refreshTtlSegundos: config.IDENTITY_REFRESH_TTL_SEGUNDOS,
  });

  const metricas = crearMetricas({ servicio: 'identity' });
  const app = crearApp({
    logger,
    rutas: rutasIdentidad(
      casos,
      limitador,
      logger,
      config.IDENTITY_TOKEN_SERVICIO,
      crearIdempotencia({ ...idempotencia, ttlEnVueloMs: config.IDEMPOTENCIA_EN_VUELO_SEGUNDOS * 1000 }),
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
    purgarIdempotencia,
    cerrar: async () => {
      metricas.detener();
      await cerrarConexiones();
    },
  };
}
