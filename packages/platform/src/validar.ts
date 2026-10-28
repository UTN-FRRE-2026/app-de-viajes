import type { RequestHandler } from 'express';
import type { z } from 'zod';

interface Esquemas {
  body?: z.ZodType;
  params?: z.ZodType;
  query?: z.ZodType;
}

/**
 * Valida y reemplaza body/params/query por la versión parseada.
 * Si falla, el ZodError llega al middleware de errores y se responde 400.
 */
export function validar(esquemas: Esquemas): RequestHandler {
  return (req, _res, next) => {
    if (esquemas.body) req.body = esquemas.body.parse(req.body ?? {});
    if (esquemas.params) req.params = esquemas.params.parse(req.params) as typeof req.params;
    if (esquemas.query) {
      // En Express 5 `req.query` es un getter: se redefine en vez de asignar.
      Object.defineProperty(req, 'query', { value: esquemas.query.parse(req.query), writable: true });
    }
    next();
  };
}
