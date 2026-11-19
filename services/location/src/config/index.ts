import { z } from 'zod';

export const EsquemaConfig = z
  .object({
    PUERTO: z.coerce.number().int().positive().default(3004),
    NIVEL_LOG: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // `optimizada` (Redis GEO) se agrega en el PR de la tarea pesada, sin cambiar el contrato.
    UBICACION_ESTRATEGIA: z.enum(['ingenua', 'memoria']).default('ingenua'),
    // No se usa DATABASE_URL: en el .env compartido apunta a la base de dispatch.
    LOCATION_DATABASE_URL: z.string().url().optional(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    JWKS_URL: z.string().url(),
    JWT_ISSUER: z.string().min(1),
    JWT_AUDIENCE: z.string().min(1),
    // Secreto compartido con dispatch para /interno/*. Nunca se loguea ni se devuelve.
    LOCATION_TOKEN_SERVICIO: z.string().min(32, 'tiene que tener al menos 32 caracteres').max(256),
    UBICACION_VIGENCIA_SEGUNDOS: z.coerce.number().int().min(5).max(600).default(30),
    APAGADO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  })
  .refine((c) => c.UBICACION_ESTRATEGIA !== 'ingenua' || c.LOCATION_DATABASE_URL, {
    path: ['LOCATION_DATABASE_URL'],
    message: 'es obligatoria cuando UBICACION_ESTRATEGIA=ingenua',
  });

export type Config = z.infer<typeof EsquemaConfig>;
