import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crearLogger } from '@viajes/platform';
import { componer, type Reemplazos } from '../../src/composicion.js';
import { EsquemaConfig } from '../../src/config/index.js';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { URL_BD_TEST } from './preparar-bd.js';
import { crearEmisorTokens } from './tokens.js';

/** Un secreto distinto en cada corrida: los tests nunca usan ni muestran el del .env. */
export const TOKEN_SERVICIO = randomBytes(32).toString('base64url');

export function configTest(extra: Record<string, string> = {}) {
  return EsquemaConfig.parse({
    UBICACION_ESTRATEGIA: 'ingenua',
    LOCATION_DATABASE_URL: URL_BD_TEST,
    JWKS_URL: 'http://identity.invalid/.well-known/jwks.json',
    JWT_ISSUER: 'viajes-identity-test',
    JWT_AUDIENCE: 'viajes',
    LOCATION_TOKEN_SERVICIO: TOKEN_SERVICIO,
    ...extra,
  });
}

/** location completo (HTTP, casos de uso y estrategia ingenua contra Postgres) en un puerto real. */
export async function levantarLocation(reemplazos: Reemplazos = {}) {
  const tokens = await crearEmisorTokens();
  const sistema = componer(configTest(), crearLogger('location-test', 'silent'), {
    verificador: tokens.verificador,
    ...reemplazos,
  });
  const prisma = crearPrisma(URL_BD_TEST, 5);

  const servidor: Server = await new Promise((resolver) => {
    const s = sistema.app.listen(0, () => resolver(s));
  });
  const { port } = servidor.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    prisma,
    casos: sistema.casos,
    ...tokens,
    servicio: { 'X-Token-Servicio': TOKEN_SERVICIO },
    async limpiar() {
      await prisma.$executeRawUnsafe('TRUNCATE pings');
    },
    async cerrar() {
      await new Promise<void>((r) => servidor.close(() => r()));
      await sistema.cerrar();
      await prisma.$disconnect();
    },
  };
}

export type Location = Awaited<ReturnType<typeof levantarLocation>>;
