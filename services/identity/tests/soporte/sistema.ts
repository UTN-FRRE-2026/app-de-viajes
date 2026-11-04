import { generateKeyPairSync } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crearLogger } from '@viajes/platform';
import { Redis } from 'ioredis';
import { componer, type Reemplazos } from '../../src/composicion.js';
import { EsquemaConfig } from '../../src/config/index.js';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { URL_BD_TEST, URL_REDIS_TEST } from './preparar-bd.js';

export const ISSUER = 'viajes-identity-test';
export const AUDIENCE = 'viajes';
export const CONTRASENA = 'una-contrasena-de-prueba';

export function claveB64(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
}

const CLAVE = claveB64();

export function configTest(extra: Record<string, string> = {}) {
  return EsquemaConfig.parse({
    IDENTITY_PERSISTENCIA: 'postgres',
    IDENTITY_DATABASE_URL: URL_BD_TEST,
    REDIS_URL: URL_REDIS_TEST,
    DB_POOL_MAX: '20',
    JWT_ISSUER: ISSUER,
    JWT_AUDIENCE: AUDIENCE,
    IDENTITY_JWT_CLAVE_PRIVADA_B64: CLAVE,
    // Altos por defecto: solo los tests del límite lo bajan.
    IDENTITY_LOGIN_MAX_POR_EMAIL: '100000',
    IDENTITY_LOGIN_MAX_POR_IP: '100000',
    ...extra,
  });
}

/** Identity completo (HTTP, casos de uso, Prisma, argon2 y Redis reales) en un puerto real. */
export async function levantarIdentity({
  config = {},
  reemplazos = {},
}: { config?: Record<string, string>; reemplazos?: Reemplazos } = {}) {
  const configuracion = configTest(config);
  const sistema = componer(configuracion, crearLogger('identity-test', 'silent'), reemplazos);
  const prisma = crearPrisma(URL_BD_TEST, 5);
  const redis = new Redis(URL_REDIS_TEST);

  const servidor: Server = await new Promise((resolver) => {
    const s = sistema.app.listen(0, () => resolver(s));
  });
  const { port } = servidor.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    config: configuracion,
    prisma,
    redis,
    casos: sistema.casos,
    async limpiar() {
      await prisma.$executeRawUnsafe('TRUNCATE users, refresh_tokens');
      await redis.flushdb();
    },
    async cerrar() {
      await new Promise<void>((r) => servidor.close(() => r()));
      await sistema.cerrar();
      await prisma.$disconnect();
      redis.disconnect();
    },
  };
}

export type Identity = Awaited<ReturnType<typeof levantarIdentity>>;

export const datosRegistro = (extra: Record<string, unknown> = {}) => ({
  email: 'ana@viajes.test',
  contrasena: CONTRASENA,
  nombre: 'Ana',
  rol: 'pasajero',
  ...extra,
});
