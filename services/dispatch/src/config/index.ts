import { tokenMetricas } from '@viajes/platform';
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
    // Candidatos: `location` (el servicio real) o `fijo` (lista de DISPATCH_CANDIDATOS_DEMO, para demos sin location).
    DISPATCH_BUSCADOR: z.enum(['location', 'fijo']).default('location'),
    DISPATCH_CANDIDATOS_DEMO: listaUuids,
    LOCATION_URL: z.string().url().optional(),
    // Mismo secreto y mismo nombre que en location: el .env es compartido.
    LOCATION_TOKEN_SERVICIO: z.string().min(32, 'tiene que tener al menos 32 caracteres').max(256).optional(),
    LOCATION_TIMEOUT_MS: z.coerce.number().int().min(50).max(10_000).default(1000),
    DISPATCH_RADIO_BUSQUEDA_METROS: z.coerce.number().int().min(100).max(50_000).default(5000),
    // Bearer de GET /metrics (Alloy). El mismo en los tres servicios: el .env es compartido.
    METRICAS_TOKEN: tokenMetricas,
  })
  .refine((c) => c.DISPATCH_PERSISTENCIA !== 'postgres' || c.DATABASE_URL, {
    path: ['DATABASE_URL'],
    message: 'es obligatoria cuando DISPATCH_PERSISTENCIA=postgres',
  })
  .refine((c) => c.DISPATCH_BUSCADOR !== 'location' || c.LOCATION_URL, {
    path: ['LOCATION_URL'],
    message: 'es obligatoria cuando DISPATCH_BUSCADOR=location',
  })
  .refine((c) => c.DISPATCH_BUSCADOR !== 'location' || c.LOCATION_TOKEN_SERVICIO, {
    path: ['LOCATION_TOKEN_SERVICIO'],
    message: 'es obligatoria cuando DISPATCH_BUSCADOR=location',
  });

export type Config = z.infer<typeof EsquemaConfig>;
