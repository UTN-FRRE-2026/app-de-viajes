import { proxyConfiable, tokenMetricas } from '@viajes/platform';
import { z } from 'zod';
import { TOPE_IMPORTE_CENTAVOS, TOPE_MAX_METROS } from '../dominio/tarifas/parametros.js';

/**
 * Compose pasa una variable que no está en el .env como texto vacío, y `z.coerce.number()` convertiría
 * "" (y también "  ", porque Number(" ") es 0) en 0: una tarifa en cero sin ningún aviso. Vacío o solo
 * espacios cuenta como ausente: se usa el valor por defecto. Un "0" escrito a propósito sigue valiendo 0.
 */
const vacioComoAusente = <T extends z.ZodType>(esquema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), esquema);

const centavos = (porDefecto: number) =>
  vacioComoAusente(z.coerce.number().int().min(0).max(TOPE_IMPORTE_CENTAVOS).default(porDefecto));

const listaUuids = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.uuid()));

export const EsquemaConfig = z
  .object({
    PUERTO: z.coerce.number().int().positive().default(3005),
    // Detrás del nginx del Compose: su IP, para tomar la del cliente de X-Forwarded-For. Vacío: no se confía en nadie.
    CONFIAR_EN_PROXY: proxyConfiable,
    NIVEL_LOG: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DISPATCH_PERSISTENCIA: z.enum(['postgres', 'memoria']).default('postgres'),
    DATABASE_URL: z.string().url().optional(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    // Cerrojo de la Idempotency-Key. El mismo Redis que identity y location; las claves llevan prefijo.
    REDIS_URL: z.string().url().optional(),
    // Lo que puede quedar tomado el cerrojo si el proceso se cae a mitad de un pedido.
    IDEMPOTENCIA_EN_VUELO_SEGUNDOS: z.coerce.number().int().min(5).max(300).default(30),
    // Cuánto se guarda cada respuesta para los reintentos (como mínimo), y cada cuánto se borra lo vencido.
    IDEMPOTENCIA_RETENCION_HORAS: z.coerce.number().int().min(1).max(720).default(24),
    IDEMPOTENCIA_PURGA_INTERVALO_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
    JWKS_URL: z.string().url(),
    JWT_ISSUER: z.string().min(1),
    JWT_AUDIENCE: z.string().min(1),
    OFERTAS_SIMULTANEAS: z.coerce.number().int().min(1).max(50).default(3),
    OFERTA_TTL_SEGUNDOS: z.coerce.number().int().min(1).default(15),
    BARRIDO_INTERVALO_MS: z.coerce.number().int().min(100).default(2000),
    // Tiempo real (SSE): cada cuánto el relay publica lo nuevo del outbox (es la demora máxima de un
    // evento), y cuántos streams puede tener abiertos cada usuario.
    RELAY_INTERVALO_MS: z.coerce.number().int().min(20).max(5000).default(100),
    SSE_MAX_POR_USUARIO: z.coerce.number().int().min(1).max(20).default(3),
    // La posición del chofer en vivo: los canales `<prefijo>posicion:<choferId>` que publica location.
    // Mismo nombre, misma regla y mismo valor que en location: el .env es compartido.
    LOCATION_REDIS_PREFIJO: z
      .string()
      .regex(/^[a-z0-9:_-]+:$/, 'solo minúsculas, números, ":", "_" o "-", y termina en ":"')
      .default('location:'),
    APAGADO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    // Candidatos: `location` (el servicio real) o `fijo` (lista de DISPATCH_CANDIDATOS_DEMO, para demos sin location).
    DISPATCH_BUSCADOR: z.enum(['location', 'fijo']).default('location'),
    DISPATCH_CANDIDATOS_DEMO: listaUuids,
    LOCATION_URL: z.string().url().optional(),
    // Mismo secreto y mismo nombre que en location: el .env es compartido.
    LOCATION_TOKEN_SERVICIO: z.string().min(32, 'tiene que tener al menos 32 caracteres').max(256).optional(),
    LOCATION_TIMEOUT_MS: z.coerce.number().int().min(50).max(10_000).default(1000),
    DISPATCH_RADIO_BUSQUEDA_METROS: z.coerce.number().int().min(100).max(50_000).default(5000),
    // Flotas: el alta de un chofer pregunta a identity (GET /interno/usuarios/:id) si la cuenta existe y
    // es de chofer. Mismo secreto y mismo nombre que en identity: el .env es compartido.
    IDENTITY_URL: z.string().url(),
    IDENTITY_TOKEN_SERVICIO: z.string().min(32, 'tiene que tener al menos 32 caracteres').max(256),
    IDENTITY_TIMEOUT_MS: z.coerce.number().int().min(50).max(10_000).default(1000),
    // Bearer de GET /metrics (Alloy). El mismo en los tres servicios: el .env es compartido.
    METRICAS_TOKEN: tokenMetricas,
    // Tarifa (docs/tarifas.md). Centavos enteros. Los importes los define el equipo: estos valores
    // por defecto son DE EJEMPLO. En el PR 2 los configura el admin y estos quedan como semilla.
    TARIFA_BAJADA_CENTAVOS: centavos(150_000),
    TARIFA_CENTAVOS_POR_KM: centavos(80_000),
    TARIFA_CENTAVOS_POR_MINUTO: centavos(15_000),
    TARIFA_MINIMO_CENTAVOS: centavos(250_000),
    TARIFA_MAX_METROS: vacioComoAusente(z.coerce.number().int().min(1).max(TOPE_MAX_METROS).default(100_000)),
    // Mapas simulado: línea recta × desvío, a velocidad media constante. Una aproximación, no un ruteo.
    MAPAS_FACTOR_DESVIO: vacioComoAusente(z.coerce.number().min(1).max(3).default(1.3)),
    MAPAS_VELOCIDAD_KMH: vacioComoAusente(z.coerce.number().int().min(5).max(120).default(25)),
    // Si mapas no contesta en este tiempo, la estimación responde 503 (falla cerrado).
    MAPAS_TIMEOUT_MS: vacioComoAusente(z.coerce.number().int().min(50).max(10_000).default(1000)),
    // Caché en Redis de los parámetros de cada versión de tarifa. Las versiones no cambian: el TTL
    // solo limpia las que dejaron de usarse.
    TARIFAS_CACHE_TTL_SEGUNDOS: vacioComoAusente(z.coerce.number().int().min(60).max(86_400).default(3600)),
    // Demora artificial del simulado, solo para demostrar el timeout. 0 en uso normal.
    MAPAS_LATENCIA_SIMULADA_MS: vacioComoAusente(z.coerce.number().int().min(0).max(30_000).default(0)),
    // Pagos simulado. Si no contesta en PAGOS_TIMEOUT_MS, el cobro queda PENDIENTE (falla cerrado) y
    // el barrido lo reintenta con la misma clave.
    PAGOS_TIMEOUT_MS: vacioComoAusente(z.coerce.number().int().min(50).max(10_000).default(1000)),
    PAGOS_LATENCIA_SIMULADA_MS: vacioComoAusente(z.coerce.number().int().min(0).max(30_000).default(0)),
    // Para demostrar un rechazo: los cobros de más de este importe se rechazan. Vacío: aprueba todo.
    PAGOS_RECHAZAR_DESDE_CENTAVOS: vacioComoAusente(z.coerce.number().int().min(0).max(TOPE_IMPORTE_CENTAVOS).optional()),
  })
  .refine((c) => c.DISPATCH_PERSISTENCIA !== 'postgres' || c.DATABASE_URL, {
    path: ['DATABASE_URL'],
    message: 'es obligatoria cuando DISPATCH_PERSISTENCIA=postgres',
  })
  .refine((c) => c.DISPATCH_PERSISTENCIA !== 'postgres' || c.REDIS_URL, {
    path: ['REDIS_URL'],
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
