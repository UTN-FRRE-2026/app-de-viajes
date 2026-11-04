import { createPrivateKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';

const BITS_MINIMOS_RSA = 2048;

/** PEM PKCS8 en base64 (una línea, cómodo para .env y secretos). No se acepta una clave débil. */
const clavePrivadaRsa = z.string().transform((valor, ctx): KeyObject => {
  try {
    const clave = createPrivateKey(Buffer.from(valor, 'base64').toString('utf8'));
    const bits = clave.asymmetricKeyDetails?.modulusLength ?? 0;
    if (clave.asymmetricKeyType === 'rsa' && bits >= BITS_MINIMOS_RSA) return clave;
  } catch {
    // Cae al mensaje de abajo: nunca se repite el valor recibido.
  }
  ctx.addIssue({
    code: 'custom',
    message: `debe ser una clave RSA de ${BITS_MINIMOS_RSA} bits o más, en PEM PKCS8 y base64 (npm run claves -w @viajes/identity)`,
  });
  return z.NEVER;
});

export const EsquemaConfig = z
  .object({
    PUERTO: z.coerce.number().int().positive().default(3001),
    NIVEL_LOG: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    IDENTITY_PERSISTENCIA: z.enum(['postgres', 'memoria']).default('postgres'),
    // No se usa DATABASE_URL: en el .env compartido apunta a la base de dispatch.
    IDENTITY_DATABASE_URL: z.string().url().optional(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    REDIS_URL: z.string().url().optional(),
    JWT_ISSUER: z.string().min(1),
    JWT_AUDIENCE: z.string().min(1),
    JWT_TTL_SEGUNDOS: z.coerce.number().int().min(60).max(3600).default(900),
    IDENTITY_JWT_CLAVE_PRIVADA_B64: clavePrivadaRsa,
    // Los mínimos son el piso de OWASP para argon2id: se puede subir, no bajar.
    ARGON2_MEMORIA_KIB: z.coerce.number().int().min(19_456).default(19_456),
    ARGON2_ITERACIONES: z.coerce.number().int().min(2).default(2),
    ARGON2_PARALELISMO: z.coerce.number().int().min(1).default(1),
    IDENTITY_LOGIN_MAX_POR_EMAIL: z.coerce.number().int().min(1).default(5),
    IDENTITY_LOGIN_MAX_POR_IP: z.coerce.number().int().min(1).default(30),
    IDENTITY_LOGIN_VENTANA_SEGUNDOS: z.coerce.number().int().min(1).default(900),
    APAGADO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  })
  .refine((c) => c.IDENTITY_PERSISTENCIA !== 'postgres' || c.IDENTITY_DATABASE_URL, {
    path: ['IDENTITY_DATABASE_URL'],
    message: 'es obligatoria cuando IDENTITY_PERSISTENCIA=postgres',
  })
  .refine((c) => c.IDENTITY_PERSISTENCIA !== 'postgres' || c.REDIS_URL, {
    path: ['REDIS_URL'],
    message: 'es obligatoria cuando IDENTITY_PERSISTENCIA=postgres (límite de intentos de login)',
  });

export type Config = z.infer<typeof EsquemaConfig>;
