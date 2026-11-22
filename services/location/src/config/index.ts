import { proxyConfiable, tokenMetricas } from '@viajes/platform';
import { z } from 'zod';

export const EsquemaConfig = z
  .object({
    PUERTO: z.coerce.number().int().positive().default(3004),
    // Detrás del nginx del Compose: su IP, para tomar la del cliente de X-Forwarded-For. Vacío: no se confía en nadie.
    CONFIAR_EN_PROXY: proxyConfiable,
    NIVEL_LOG: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // 6.6: `ingenua` (Postgres, referencia) y `optimizada` (Redis GEO + historial en lotes).
    UBICACION_ESTRATEGIA: z.enum(['ingenua', 'optimizada', 'memoria']).default('ingenua'),
    // No se usa DATABASE_URL: en el .env compartido apunta a la base de dispatch.
    LOCATION_DATABASE_URL: z.string().url().optional(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    // Mismo nombre que en identity: el Redis es el mismo; las claves llevan su propio prefijo.
    REDIS_URL: z.string().url().optional(),
    LOCATION_REDIS_PREFIJO: z
      .string()
      .regex(/^[a-z0-9:_-]+:$/, 'solo minúsculas, números, ":", "_" o "-", y termina en ":"')
      .default('location:'),
    JWKS_URL: z.string().url(),
    JWT_ISSUER: z.string().min(1),
    JWT_AUDIENCE: z.string().min(1),
    // Secreto compartido con dispatch para /interno/*. Nunca se loguea ni se devuelve.
    LOCATION_TOKEN_SERVICIO: z.string().min(32, 'tiene que tener al menos 32 caracteres').max(256),
    // Bearer de GET /metrics (Alloy). El mismo en los tres servicios: el .env es compartido.
    METRICAS_TOKEN: tokenMetricas,
    UBICACION_VIGENCIA_SEGUNDOS: z.coerce.number().int().min(5).max(600).default(30),
    // Versión optimizada: historial por cola y purga del índice.
    LOCATION_HISTORIAL_LOTE: z.coerce.number().int().min(1).max(5000).default(500),
    LOCATION_HISTORIAL_ESPERA_MS: z.coerce.number().int().min(50).max(10_000).default(1000),
    // Tope de la cola: a 250 pings/s son unos 33 minutos sin poder escribir en Postgres.
    LOCATION_HISTORIAL_MAX: z.coerce.number().int().min(1).default(500_000),
    LOCATION_HISTORIAL_RECLAMO_MS: z.coerce.number().int().min(1000).default(30_000),
    LOCATION_PURGA_INTERVALO_MS: z.coerce.number().int().min(1000).default(10_000),
    APAGADO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  })
  .refine((c) => c.UBICACION_ESTRATEGIA === 'memoria' || c.LOCATION_DATABASE_URL, {
    path: ['LOCATION_DATABASE_URL'],
    message: 'es obligatoria con las estrategias ingenua y optimizada (historial)',
  })
  .refine((c) => c.UBICACION_ESTRATEGIA !== 'optimizada' || c.REDIS_URL, {
    path: ['REDIS_URL'],
    message: 'es obligatoria cuando UBICACION_ESTRATEGIA=optimizada',
  });

export type Config = z.infer<typeof EsquemaConfig>;
