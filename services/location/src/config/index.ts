import { proxyConfiable, tokenMetricas, vacioComoAusente } from '@viajes/platform';
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
    // Retención del historial (`pings`, las dos estrategias). El mínimo, 1 h, siempre supera la vigencia
    // máxima (600 s): la búsqueda nunca pierde una posición vigente. 720 h = 30 días.
    // Vacías en el Compose si no están en el .env (vacioComoAusente): toman estos valores por defecto.
    LOCATION_HISTORIAL_RETENCION_HORAS: vacioComoAusente(z.coerce.number().int().min(1).max(8760).default(720)),
    // Cada pasada borra hasta 20 lotes: 20 × 5000 cada 5 min dan un tope teórico de unos 333 pings/s
    // (no medido), por encima de los 250/s que escriben 500 choferes.
    LOCATION_HISTORIAL_RETENCION_INTERVALO_MS: vacioComoAusente(z.coerce.number().int().min(1000).default(300_000)),
    LOCATION_HISTORIAL_RETENCION_LOTE: vacioComoAusente(z.coerce.number().int().min(1).max(50_000).default(5000)),
    // Los pings de choferes sin viaje se borran antes. Ausente: el menor entre 24 h y la retención total.
    LOCATION_HISTORIAL_SIN_VIAJE_HORAS: vacioComoAusente(z.coerce.number().int().min(1).max(8760).optional()),
    // Para saber qué ping fue de un viaje, location le pregunta a dispatch (POST /interno/tramos-viaje).
    // Sin URL o sin token, no clasifica: los pings sin viaje se conservan hasta la retención total.
    DISPATCH_URL: vacioComoAusente(z.string().url().optional()),
    DISPATCH_TOKEN_SERVICIO: vacioComoAusente(z.string().min(32, 'tiene que tener al menos 32 caracteres').max(256).optional()),
    DISPATCH_TIMEOUT_MS: vacioComoAusente(z.coerce.number().int().min(50).max(10_000).default(1000)),
    APAGADO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  })
  .refine((c) => c.UBICACION_ESTRATEGIA === 'memoria' || c.LOCATION_DATABASE_URL, {
    path: ['LOCATION_DATABASE_URL'],
    message: 'es obligatoria con las estrategias ingenua y optimizada (historial)',
  })
  .refine((c) => c.UBICACION_ESTRATEGIA !== 'optimizada' || c.REDIS_URL, {
    path: ['REDIS_URL'],
    message: 'es obligatoria cuando UBICACION_ESTRATEGIA=optimizada',
  })
  .refine((c) => c.LOCATION_HISTORIAL_SIN_VIAJE_HORAS === undefined || c.LOCATION_HISTORIAL_SIN_VIAJE_HORAS <= c.LOCATION_HISTORIAL_RETENCION_HORAS, {
    path: ['LOCATION_HISTORIAL_SIN_VIAJE_HORAS'],
    message: 'no puede ser mayor que LOCATION_HISTORIAL_RETENCION_HORAS',
  })
  // Ausente: el menor entre 24 h y la retención total (con una retención de 12 h, también 12 h).
  .transform((c) => ({
    ...c,
    LOCATION_HISTORIAL_SIN_VIAJE_HORAS: c.LOCATION_HISTORIAL_SIN_VIAJE_HORAS ?? Math.min(24, c.LOCATION_HISTORIAL_RETENCION_HORAS),
  }));

export type Config = z.infer<typeof EsquemaConfig>;
