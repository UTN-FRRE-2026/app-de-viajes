import { ErrorDeDominio, type TipoError } from '@viajes/kernel';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { requestIdActual } from './contexto.js';
import type { Logger } from './logger.js';

/** Errores propios de la capa HTTP (autenticación, autorización, validación). */
export class ErrorHttp extends Error {
  constructor(
    readonly estado: number,
    readonly codigo: string,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

const estadoPorTipo: Record<TipoError, number> = {
  NO_ENCONTRADO: 404,
  CONFLICTO: 409,
  INVALIDO: 422,
  PROHIBIDO: 403,
};

function cuerpo(code: string, message: string) {
  return { error: { code, message, requestId: requestIdActual() } };
}

export function middlewareNoEncontrado(): RequestHandler {
  return (_req, res) => {
    res.status(404).json(cuerpo('RUTA_NO_ENCONTRADA', 'La ruta no existe'));
  };
}

/** Único lugar donde un error se convierte en respuesta. Nunca devuelve el stack. */
export function middlewareErrores(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    if (err instanceof ErrorDeDominio) {
      res.status(estadoPorTipo[err.tipo]).json(cuerpo(err.codigo, err.message));
      return;
    }
    if (err instanceof ErrorHttp) {
      res.status(err.estado).json(cuerpo(err.codigo, err.message));
      return;
    }
    if (err instanceof ZodError) {
      const detalle = err.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ');
      res.status(400).json(cuerpo('VALIDACION', detalle));
      return;
    }
    // Errores que arma body-parser (JSON mal formado, cuerpo demasiado grande).
    const tipoParser = (err as { type?: string }).type;
    if (tipoParser === 'entity.too.large') {
      res.status(413).json(cuerpo('CUERPO_DEMASIADO_GRANDE', 'El cuerpo supera el límite permitido'));
      return;
    }
    if (tipoParser === 'entity.parse.failed') {
      res.status(400).json(cuerpo('JSON_INVALIDO', 'El cuerpo no es JSON válido'));
      return;
    }

    logger.error({ err }, 'error no controlado');
    res.status(500).json(cuerpo('INTERNO', 'Error interno'));
  };
}
