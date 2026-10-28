import type { Server } from 'node:http';
import type { Logger } from './logger.js';

interface OpcionesApagado {
  servidor: Server;
  logger: Logger;
  /** Se ejecutan en orden después de drenar los pedidos (cerrar Prisma, Redis, Rabbit...). */
  alCerrar: Array<() => Promise<void> | void>;
  timeoutMs: number;
}

/**
 * Con SIGTERM/SIGINT: deja de aceptar conexiones, espera los pedidos en curso,
 * cierra los recursos y sale. Si tarda más que el timeout, lo registra y sale con 1.
 */
export function registrarApagadoOrdenado({ servidor, logger, alCerrar, timeoutMs }: OpcionesApagado): void {
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

    await new Promise<void>((resolver) => {
      servidor.close(() => resolver());
      servidor.closeIdleConnections();
    });
    logger.info('apagado: pedidos drenados, cerrando recursos');
    for (const cerrar of alCerrar) await cerrar();
    logger.info('apagado: listo');
    process.exit(0);
  };

  process.on('SIGTERM', () => void apagar('SIGTERM'));
  process.on('SIGINT', () => void apagar('SIGINT'));
}
