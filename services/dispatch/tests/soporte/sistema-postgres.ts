import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  almacenIdempotenciaSql,
  cerrojoRedis,
  crearLogger,
  purgarIdempotenciaSql,
  type AlmacenIdempotencia,
  type CerrojoEnVuelo,
} from '@viajes/platform';
import { Redis } from 'ioredis';
import { componer } from '../../src/composicion.js';
import { EsquemaConfig } from '../../src/config/index.js';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { RepositorioDespachoPrisma } from '../../src/infra/db/repositorio-prisma.js';
import { RepositorioFlotasPrisma, type OpcionesFlotasPrisma } from '../../src/infra/db/flotas-prisma.js';
import { RepositorioTarifasPrisma, type OpcionesTarifasPrisma } from '../../src/infra/db/tarifas-prisma.js';
import { cacheTarifasRedis, type CacheTarifas } from '../../src/infra/tarifas/proveedor-tarifas.js';
import { BuscadorCandidatosFijo } from '../../src/infra/externos/buscador-fijo.js';
import { BusEventosRedis } from '../../src/infra/tiempo-real/bus-redis.js';
import { HistorialEventosPrisma, relayOutboxPrisma } from '../../src/infra/tiempo-real/outbox-prisma.js';
import { PosicionesRedis } from '../../src/infra/tiempo-real/posiciones-redis.js';
import { conDemoraTrasLeer } from './demora.js';
import { DirectorioFalso } from './directorio-falso.js';
import { PagosFalso } from './pagos-falso.js';
import { URL_BD_TEST } from './preparar-bd.js';
import { crearEmisorTokens } from './tokens.js';

/** Un secreto distinto en cada corrida: los tests nunca usan ni muestran el del .env. */
export const TOKEN_METRICAS = randomBytes(32).toString('base64url');
export const CON_METRICAS = { Authorization: `Bearer ${TOKEN_METRICAS}` };

/** Base 13: identity vacía la 15 y location la 14. */
export const URL_REDIS_TEST = process.env.DISPATCH_REDIS_URL_TEST ?? 'redis://localhost:6379/13';

/** Una Idempotency-Key nueva: cada operación distinta lleva la suya, como haría un cliente real. */
export const clave = () => ({ 'Idempotency-Key': randomUUID() });

export function configTest(extra: Record<string, string> = {}) {
  return EsquemaConfig.parse({
    DISPATCH_PERSISTENCIA: 'postgres',
    DATABASE_URL: URL_BD_TEST,
    REDIS_URL: URL_REDIS_TEST,
    DB_POOL_MAX: '20',
    JWKS_URL: 'http://identity.invalid/.well-known/jwks.json',
    JWT_ISSUER: 'viajes-identity-test',
    JWT_AUDIENCE: 'viajes',
    OFERTAS_SIMULTANEAS: '50',
    DISPATCH_BUSCADOR: 'fijo',
    METRICAS_TOKEN: TOKEN_METRICAS,
    // Los tests reemplazan el directorio de identity (DirectorioFalso): esta URL no se usa.
    IDENTITY_URL: 'http://identity.invalid',
    IDENTITY_TOKEN_SERVICIO: TOKEN_METRICAS,
    ...extra,
  });
}

type Idempotencia = { almacen: AlmacenIdempotencia; cerrojo: CerrojoEnVuelo };

/** Tarifa en Postgres y caché en Redis, como en producción. `cache` recibe el real y puede devolver otro. */
export interface OpcionesTarifasTest {
  /** Variables de entorno de dispatch: por ejemplo, otros `TARIFA_*` para la semilla. */
  config?: Record<string, string>;
  repo?: OpcionesTarifasPrisma;
  cache?: (real: CacheTarifas) => CacheTarifas | null;
  /** Para simular un reinicio: el mismo prefijo de caché que otro dispatch levantado antes. */
  prefijoCache?: string;
}

/**
 * Levanta dispatch completo (HTTP + casos de uso + Prisma + Redis) contra la base de test,
 * escuchando en un puerto real para que los pedidos concurrentes sean de verdad concurrentes.
 * `idempotencia` recibe los adaptadores reales y puede devolver otros, para simular que Redis
 * no responde o que el cerrojo venció.
 */
export async function levantarDispatch({
  demoraTrasLeerMs = 0,
  idempotencia = (reales) => reales,
  tarifas = {},
  flotas = {},
  extra = {},
}: {
  demoraTrasLeerMs?: number;
  idempotencia?: (reales: Idempotencia) => Idempotencia;
  tarifas?: OpcionesTarifasTest;
  /** Flotas en Postgres; por ejemplo, una demora con el chofer bloqueado para superponer activaciones. */
  flotas?: OpcionesFlotasPrisma;
  /** Otras variables de entorno de dispatch (por ejemplo, PAGOS_TIMEOUT_MS). */
  extra?: Record<string, string>;
} = {}) {
  const tokens = await crearEmisorTokens();
  const prisma = crearPrisma(URL_BD_TEST, 20);
  const redis = new Redis(URL_REDIS_TEST, { maxRetriesPerRequest: 1 });
  const buscador = new BuscadorCandidatosFijo([]);
  const pagos = new PagosFalso();
  const logger = crearLogger('dispatch-test', 'silent');
  // Un prefijo por dispatch levantado: dos dispatch del mismo test no se mezclan los eventos.
  const bus = new BusEventosRedis(redis, `dispatch-test:eventos:${randomUUID()}:`, logger);
  // Lo mismo con los canales de posición: el test publica como location, con este prefijo.
  const prefijoPosiciones = `dispatch-test:location:${randomUUID().slice(0, 8)}:`;
  const posiciones = new PosicionesRedis(redis, prefijoPosiciones, logger);
  const repoTarifas = new RepositorioTarifasPrisma(prisma, tarifas.repo);
  // Un prefijo por dispatch levantado: los tests no ven el caché de otra corrida.
  const prefijoCache = tarifas.prefijoCache ?? `dispatch-test:tarifas:${randomUUID()}:`;
  const cacheReal = cacheTarifasRedis(redis, { prefijo: prefijoCache, ttlSegundos: 60, timeoutMs: 200 });
  const repoFlotas = new RepositorioFlotasPrisma(prisma, flotas);
  const directorio = new DirectorioFalso();
  const config = configTest({ ...tarifas.config, ...extra });
  const sistema = componer(config, logger, {
    verificador: tokens.verificador,
    buscador,
    repo: demoraTrasLeerMs
      ? conDemoraTrasLeer(new RepositorioDespachoPrisma(prisma), demoraTrasLeerMs)
      : new RepositorioDespachoPrisma(prisma),
    idempotencia: idempotencia({
      almacen: almacenIdempotenciaSql(prisma),
      cerrojo: cerrojoRedis(redis, 'dispatch:idempotencia:'),
    }),
    repoTarifas,
    cacheTarifas: tarifas.cache ? tarifas.cache(cacheReal) : cacheReal,
    pagos,
    repoFlotas,
    directorio,
    eventos: { bus, historial: new HistorialEventosPrisma(prisma), relay: relayOutboxPrisma(prisma, bus), posiciones },
  });

  const servidor: Server = await new Promise((resolver) => {
    const s = sistema.app.listen(0, () => resolver(s));
  });
  const { port } = servidor.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    prisma,
    redis,
    buscador,
    pagos,
    bus,
    prefijoPosiciones,
    casos: sistema.casos,
    casosFlotas: sistema.casosFlotas,
    directorio,
    /** Publica lo pendiente del outbox, como hace el servidor cada RELAY_INTERVALO_MS. */
    relay: sistema.relayEventos,
    /** La purga de claves de idempotencia, con la retención de la config (24 h por defecto). */
    purgarIdempotencia: purgarIdempotenciaSql(prisma, { retencionMs: config.IDEMPOTENCIA_RETENCION_HORAS * 3_600_000 }),
    streams: sistema.streams,
    app: sistema.app,
    repoTarifas,
    prefijoCache,
    ...tokens,
    async limpiar() {
      await prisma.$executeRawUnsafe('TRUNCATE outbox, driver_active_assignment, offers, payments, ride_requests, idempotency_keys');
    },
    async limpiarFlotas() {
      await prisma.$executeRawUnsafe('TRUNCATE drivers, fleets, idempotency_keys');
    },
    /** Deja la base sin tarifa (la próxima lectura vuelve a sembrar) y borra el caché de este dispatch. */
    async limpiarTarifas() {
      await prisma.$executeRawUnsafe('TRUNCATE fare_current, fare_changes, fare_versions');
      const claves = await redis.keys(`${prefijoCache}*`);
      if (claves.length > 0) await redis.del(...claves);
    },
    async cerrar() {
      sistema.streams.cerrarTodos();
      await bus.cerrar();
      await posiciones.cerrar();
      await new Promise<void>((r) => servidor.close(() => r()));
      await prisma.$disconnect();
      redis.disconnect();
    },
  };
}

export const ORIGEN = { lat: -34.6037, lng: -58.3816 };
export const DESTINO = { lat: -34.5875, lng: -58.4207 };
