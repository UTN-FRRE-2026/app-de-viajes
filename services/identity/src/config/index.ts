import { createPrivateKey, type KeyObject } from 'node:crypto';
import { proxyConfiable, tokenMetricas, vacioComoAusente } from '@viajes/platform';
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
    // Detrás del nginx del Compose: su IP, para tomar la del cliente de X-Forwarded-For. Vacío: no se confía en nadie.
    CONFIAR_EN_PROXY: proxyConfiable,
    NIVEL_LOG: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    IDENTITY_PERSISTENCIA: z.enum(['postgres', 'memoria']).default('postgres'),
    // No se usa DATABASE_URL: en el .env compartido apunta a la base de dispatch.
    IDENTITY_DATABASE_URL: z.string().url().optional(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    REDIS_URL: z.string().url().optional(),
    JWT_ISSUER: z.string().min(1),
    JWT_AUDIENCE: z.string().min(1),
    JWT_TTL_SEGUNDOS: z.coerce.number().int().min(60).max(3600).default(900),
    // Cada rotación renueva el plazo: es lo máximo que se puede estar sin usar la app antes de volver a entrar.
    IDENTITY_REFRESH_TTL_SEGUNDOS: z.coerce.number().int().min(900).max(2_592_000).default(604_800),
    IDENTITY_JWT_CLAVE_PRIVADA_B64: clavePrivadaRsa,
    // Los mínimos son el piso de OWASP para argon2id: se puede subir, no bajar.
    ARGON2_MEMORIA_KIB: z.coerce.number().int().min(19_456).default(19_456),
    ARGON2_ITERACIONES: z.coerce.number().int().min(2).default(2),
    ARGON2_PARALELISMO: z.coerce.number().int().min(1).default(1),
    // Vacías en el Compose si no están en el .env (vacioComoAusente): 5 y 30. El e2e sube la de la IP.
    IDENTITY_LOGIN_MAX_POR_EMAIL: vacioComoAusente(z.coerce.number().int().min(1).default(5)),
    IDENTITY_LOGIN_MAX_POR_IP: vacioComoAusente(z.coerce.number().int().min(1).default(30)),
    IDENTITY_LOGIN_VENTANA_SEGUNDOS: z.coerce.number().int().min(1).default(900),
    // Idempotency-Key del registro. Los mismos nombres y valores que en dispatch: el .env es compartido.
    IDEMPOTENCIA_EN_VUELO_SEGUNDOS: z.coerce.number().int().min(5).max(300).default(30),
    IDEMPOTENCIA_RETENCION_HORAS: z.coerce.number().int().min(1).max(720).default(24),
    IDEMPOTENCIA_PURGA_INTERVALO_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
    APAGADO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    // Bearer de GET /metrics (Alloy). El mismo en los tres servicios: el .env es compartido.
    METRICAS_TOKEN: tokenMetricas,
    // Secreto compartido con dispatch para /interno/*. Nunca se loguea ni se devuelve.
    IDENTITY_TOKEN_SERVICIO: z.string().min(32, 'tiene que tener al menos 32 caracteres').max(256),
  })
  .refine((c) => c.IDENTITY_PERSISTENCIA !== 'postgres' || c.IDENTITY_DATABASE_URL, {
    path: ['IDENTITY_DATABASE_URL'],
    message: 'es obligatoria cuando IDENTITY_PERSISTENCIA=postgres',
  })
  .refine((c) => c.IDENTITY_PERSISTENCIA !== 'postgres' || c.REDIS_URL, {
    path: ['REDIS_URL'],
    message: 'es obligatoria cuando IDENTITY_PERSISTENCIA=postgres (límite de intentos de login e Idempotency-Key)',
  });

export type Config = z.infer<typeof EsquemaConfig>;
