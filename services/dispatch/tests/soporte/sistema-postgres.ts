import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { crearLogger } from '@viajes/platform';
import { componer } from '../../src/composicion.js';
import { EsquemaConfig } from '../../src/config/index.js';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { RepositorioDespachoPrisma } from '../../src/infra/db/repositorio-prisma.js';
import { BuscadorCandidatosFijo } from '../../src/infra/externos/buscador-fijo.js';
import { conDemoraTrasLeer } from './demora.js';
import { URL_BD_TEST } from './preparar-bd.js';
import { crearEmisorTokens } from './tokens.js';

export function configTest(extra: Record<string, string> = {}) {
  return EsquemaConfig.parse({
    DISPATCH_PERSISTENCIA: 'postgres',
    DATABASE_URL: URL_BD_TEST,
    DB_POOL_MAX: '20',
    JWKS_URL: 'http://identity.invalid/.well-known/jwks.json',
    JWT_ISSUER: 'viajes-identity-test',
    JWT_AUDIENCE: 'viajes',
    OFERTAS_SIMULTANEAS: '50',
    ...extra,
  });
}

/**
 * Levanta dispatch completo (HTTP + casos de uso + Prisma) contra la base de test,
 * escuchando en un puerto real para que los pedidos concurrentes sean de verdad concurrentes.
 */
export async function levantarDispatch({ demoraTrasLeerMs = 0 } = {}) {
  const tokens = await crearEmisorTokens();
  const prisma = crearPrisma(URL_BD_TEST, 20);
  const buscador = new BuscadorCandidatosFijo([]);
  const sistema = componer(configTest(), crearLogger('dispatch-test', 'silent'), {
    verificador: tokens.verificador,
    buscador,
    repo: demoraTrasLeerMs
      ? conDemoraTrasLeer(new RepositorioDespachoPrisma(prisma), demoraTrasLeerMs)
      : new RepositorioDespachoPrisma(prisma),
  });

  const servidor: Server = await new Promise((resolver) => {
    const s = sistema.app.listen(0, () => resolver(s));
  });
  const { port } = servidor.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    prisma,
    buscador,
    casos: sistema.casos,
    ...tokens,
    async limpiar() {
      await prisma.$executeRawUnsafe('TRUNCATE outbox, driver_active_assignment, offers, ride_requests');
    },
    async cerrar() {
      await new Promise<void>((r) => servidor.close(() => r()));
      await prisma.$disconnect();
    },
  };
}

export const ORIGEN = { lat: -34.6037, lng: -58.3816 };
export const DESTINO = { lat: -34.5875, lng: -58.4207 };
