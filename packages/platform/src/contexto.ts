import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

interface ContextoPedido {
  requestId: string;
}

const almacen = new AsyncLocalStorage<ContextoPedido>();

export function requestIdActual(): string | undefined {
  return almacen.getStore()?.requestId;
}

/** Toma el x-request-id que puso el gateway (o genera uno) y lo deja disponible en todo el pedido. */
export function middlewareRequestId(): RequestHandler {
  return (req, res, next) => {
    const recibido = req.header('x-request-id');
    const requestId = recibido && /^[\w-]{1,100}$/.test(recibido) ? recibido : randomUUID();
    res.setHeader('x-request-id', requestId);
    almacen.run({ requestId }, next);
  };
}
