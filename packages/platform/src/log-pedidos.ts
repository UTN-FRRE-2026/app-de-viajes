import type { RequestHandler } from 'express';
import { requestIdActual } from './contexto.js';
import type { Logger } from './logger.js';
import { rutaDe } from './metricas.js';

/** Las sondas del Compose y de Alloy: cada pocos segundos, siempre iguales. Solo se loguean si fallan. */
const SONDAS = new Set(['/health', '/ready', '/metrics']);

/**
 * Una línea por pedido al terminar de responder: método, ruta (el patrón, no la URL: sin ids ni la
 * búsqueda del panel en el log), estado, duración, `requestId`, usuario e IP. Con el `requestId`
 * (también en el encabezado `x-request-id` y en el cuerpo de cada error) se encuentra el pedido que
 * originó un error del log, o al revés (bloque 4).
 *
 * 5xx en `error`, 4xx en `warn` y el resto en `info`. Se monta después del requestId: el id se toma al
 * entrar, porque el evento `finish` puede dispararse fuera del contexto del pedido.
 */
export function middlewareLogPedidos(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const inicio = process.hrtime.bigint();
    const requestId = requestIdActual();
    res.once('finish', () => {
      const estado = res.statusCode;
      if (estado < 400 && SONDAS.has(req.path)) return;
      const linea = {
        requestId,
        metodo: req.method,
        ruta: rutaDe(req),
        estado,
        duracionMs: Math.round(Number(process.hrtime.bigint() - inicio) / 1e4) / 100,
        usuarioId: req.usuario?.id,
        rol: req.usuario?.rol,
        ip: req.ip,
      };
      if (estado >= 500) logger.error(linea, 'pedido');
      else if (estado >= 400) logger.warn(linea, 'pedido');
      else logger.info(linea, 'pedido');
    });
    next();
  };
}
