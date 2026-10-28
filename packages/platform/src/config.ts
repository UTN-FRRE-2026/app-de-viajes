import { z } from 'zod';

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
