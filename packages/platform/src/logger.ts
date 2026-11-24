import { pino, type DestinationStream, type Logger } from 'pino';
import { requestIdActual } from './contexto.js';

export type { Logger };

/**
 * Una línea JSON por evento, con el requestId del pedido en curso si lo hay. `destino`, solo para los
 * tests que leen el log; por defecto, la salida estándar.
 */
export function crearLogger(servicio: string, nivel = 'info', destino?: DestinationStream): Logger {
  const opciones = {
    name: servicio,
    level: nivel,
    mixin() {
      const requestId = requestIdActual();
      return requestId ? { requestId } : {};
    },
  };
  return destino ? pino(opciones, destino) : pino(opciones);
}
