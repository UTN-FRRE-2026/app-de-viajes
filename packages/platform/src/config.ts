import { z } from 'zod';

const DIRECCION = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]*:[0-9a-fA-F:.]*)(?:\/\d{1,3})?$/;

/**
 * `CONFIAR_EN_PROXY`: las IP (o redes en CIDR), separadas por coma, de los proxies cuyo
 * `X-Forwarded-For` se cree. Detrás del nginx del Compose es la IP fija del contenedor `web`. Sin la
 * variable no se confía en nadie y `req.ip` es la dirección de la conexión: así nadie que llegue
 * directo al servicio puede inventarse otra IP para evadir un límite por IP. A propósito no acepta
 * `true` ni rangos con nombre (`uniquelocal`): sería confiar en cualquiera de la red.
 */
export const proxyConfiable = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z
    .string()
    .refine((v) => v.split(',').every((parte) => DIRECCION.test(parte.trim())), 'una o más IP o redes (CIDR), separadas por coma')
    .transform((v) => v.split(',').map((parte) => parte.trim()))
    .optional(),
);

/**
 * Compose pasa una variable que no está en el .env como texto vacío (`${VAR:-}`), y `z.coerce.number()`
 * convertiría "" (y también "  ", porque Number(" ") es 0) en 0: un `.default()` no se aplica. Vacío o
 * solo espacios cuenta como ausente y se usa el valor por defecto. Un "0" escrito a propósito sigue valiendo 0.
 */
export const vacioComoAusente = <T extends z.ZodType>(esquema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), esquema);

/**
 * Valida el entorno al arrancar. Si falta o está mal una variable, el proceso
 * termina con código 1 y nombra la variable: mejor no arrancar que arrancar roto.
 */
export function cargarConfig<T extends z.ZodType>(esquema: T, entorno: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const resultado = esquema.safeParse(entorno);
  if (resultado.success) return resultado.data;

  for (const problema of resultado.error.issues) {
    const variable = problema.path.join('.') || '(entorno)';
    console.error(`[config] variable ${variable}: ${problema.message}`);
  }
  process.exit(1);
}

/**
 * `LOG_PEDIDOS`: `no` apaga la línea por pedido (ver middlewareLogPedidos). Solo para el entorno de
 * carga, donde 500 choferes dan 250 pings/s y las mediciones se tomaron sin ese log. Vacía o
 * ausente: `si`.
 */
export const logPedidos = vacioComoAusente(z.enum(['si', 'no']).default('si')).transform((v) => v === 'si');
