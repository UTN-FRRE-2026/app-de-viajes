import { z } from 'zod';

const listaUuids = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.uuid()));

export const EsquemaConfig = z
  .object({
    PUERTO: z.coerce.number().int().positive().default(3005),
    NIVEL_LOG: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DISPATCH_PERSISTENCIA: z.enum(['postgres', 'memoria']).default('postgres'),
    DATABASE_URL: z.string().url().optional(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    JWKS_URL: z.string().url(),
    JWT_ISSUER: z.string().min(1),
    JWT_AUDIENCE: z.string().min(1),
    OFERTAS_SIMULTANEAS: z.coerce.number().int().min(1).max(50).default(3),
    OFERTA_TTL_SEGUNDOS: z.coerce.number().int().min(1).default(15),
    BARRIDO_INTERVALO_MS: z.coerce.number().int().min(100).default(2000),
    APAGADO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    DISPATCH_CANDIDATOS_DEMO: listaUuids,
  })
  .refine((c) => c.DISPATCH_PERSISTENCIA !== 'postgres' || c.DATABASE_URL, {
    path: ['DATABASE_URL'],
    message: 'es obligatoria cuando DISPATCH_PERSISTENCIA=postgres',
  });

export type Config = z.infer<typeof EsquemaConfig>;
