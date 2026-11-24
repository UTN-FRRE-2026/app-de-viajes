import type { Server } from 'node:http';
import type { Logger } from './logger.js';

interface OpcionesApagado {
  servidor: Server;
  logger: Logger;
  /**
   * Se ejecutan al empezar, antes de drenar: para cortar las conexiones que no terminan solas
   * (SSE). Si no, el servidor esperaría hasta el timeout. El cliente se reconecta a otra instancia.
   */
  alEmpezar?: Array<() => void>;
  /** Se ejecutan en orden después de drenar los pedidos (cerrar Prisma, Redis, Rabbit...). */
  alCerrar: Array<() => Promise<void> | void>;
  timeoutMs: number;
}

/**
 * Con SIGTERM/SIGINT: deja de aceptar conexiones, espera los pedidos en curso,
 * cierra los recursos y sale. Si tarda más que el timeout, lo registra y sale con 1.
 */
export function registrarApagadoOrdenado({ servidor, logger, alEmpezar = [], alCerrar, timeoutMs }: OpcionesApagado): void {
  let apagando = false;

  const apagar = async (senal: string) => {
    if (apagando) return;
    apagando = true;
    logger.info({ senal }, 'apagado: dejo de aceptar conexiones y drenando pedidos');

    const limite = setTimeout(() => {
      logger.error({ timeoutMs }, 'apagado: se venció el timeout, salgo forzado');
      process.exit(1);
    }, timeoutMs);
    limite.unref();

    for (const cortar of alEmpezar) cortar();
    // Una conexión keep-alive que estaba atendiendo un pedido queda ociosa al responder, y `close` la
    // esperaría hasta su timeout: se cierran las ociosas cada 100 ms mientras se drena.
    const barrerOciosas = setInterval(() => servidor.closeIdleConnections(), 100);
    await new Promise<void>((resolver) => {
      servidor.close(() => resolver());
      servidor.closeIdleConnections();
    });
    clearInterval(barrerOciosas);
    logger.info('apagado: pedidos drenados, cerrando recursos');
    for (const cerrar of alCerrar) await cerrar();
    logger.info('apagado: listo');
    process.exit(0);
  };

  process.on('SIGTERM', () => void apagar('SIGTERM'));
  process.on('SIGINT', () => void apagar('SIGINT'));
}
