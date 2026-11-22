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
