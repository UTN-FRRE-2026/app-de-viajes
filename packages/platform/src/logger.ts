import { pino, type Logger } from 'pino';
import { requestIdActual } from './contexto.js';

export type { Logger };

/** Una línea JSON por evento, con el requestId del pedido en curso si lo hay. */
export function crearLogger(servicio: string, nivel = 'info'): Logger {
  return pino({
    name: servicio,
    level: nivel,
    mixin() {
      const requestId = requestIdActual();
      return requestId ? { requestId } : {};
    },
  });
}
