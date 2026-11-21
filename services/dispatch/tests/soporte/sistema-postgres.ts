import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { cerrojoRedis, crearLogger, type AlmacenIdempotencia, type CerrojoEnVuelo } from '@viajes/platform';
import { Redis } from 'ioredis';
import { componer } from '../../src/composicion.js';
import { EsquemaConfig } from '../../src/config/index.js';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { AlmacenIdempotenciaPrisma } from '../../src/infra/db/idempotencia-prisma.js';
import { RepositorioDespachoPrisma } from '../../src/infra/db/repositorio-prisma.js';
import { BuscadorCandidatosFijo } from '../../src/infra/externos/buscador-fijo.js';
import { conDemoraTrasLeer } from './demora.js';
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
    ...extra,
  });
}

type Idempotencia = { almacen: AlmacenIdempotencia; cerrojo: CerrojoEnVuelo };

/**
 * Levanta dispatch completo (HTTP + casos de uso + Prisma + Redis) contra la base de test,
 * escuchando en un puerto real para que los pedidos concurrentes sean de verdad concurrentes.
 * `idempotencia` recibe los adaptadores reales y puede devolver otros, para simular que Redis
 * no responde o que el cerrojo venció.
 */
export async function levantarDispatch({
  demoraTrasLeerMs = 0,
  idempotencia = (reales) => reales,
}: { demoraTrasLeerMs?: number; idempotencia?: (reales: Idempotencia) => Idempotencia } = {}) {
  const tokens = await crearEmisorTokens();
  const prisma = crearPrisma(URL_BD_TEST, 20);
  const redis = new Redis(URL_REDIS_TEST, { maxRetriesPerRequest: 1 });
  const buscador = new BuscadorCandidatosFijo([]);
  const sistema = componer(configTest(), crearLogger('dispatch-test', 'silent'), {
    verificador: tokens.verificador,
    buscador,
    repo: demoraTrasLeerMs
      ? conDemoraTrasLeer(new RepositorioDespachoPrisma(prisma), demoraTrasLeerMs)
      : new RepositorioDespachoPrisma(prisma),
    idempotencia: idempotencia({
      almacen: new AlmacenIdempotenciaPrisma(prisma),
      cerrojo: cerrojoRedis(redis, 'dispatch:idempotencia:'),
    }),
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
    casos: sistema.casos,
    ...tokens,
    async limpiar() {
      await prisma.$executeRawUnsafe('TRUNCATE outbox, driver_active_assignment, offers, ride_requests, idempotency_keys');
    },
    async cerrar() {
      await new Promise<void>((r) => servidor.close(() => r()));
      await prisma.$disconnect();
      redis.disconnect();
    },
  };
}

export const ORIGEN = { lat: -34.6037, lng: -58.3816 };
export const DESTINO = { lat: -34.5875, lng: -58.4207 };
