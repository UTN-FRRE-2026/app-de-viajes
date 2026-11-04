import type { LoginBody } from '@viajes/contracts';
import { ErrorHttp, type Logger } from '@viajes/platform';
import type { RequestHandler } from 'express';
import type { EstadoLimite, LimitadorLogin } from '../../dominio/puertos/index.js';

/**
 * Corre después de validar el body y antes de argon2: frena el pedido antes de gastar CPU.
 * Falla cerrado: sin contador no hay protección contra fuerza bruta, así que no se verifica nada.
 * `req.ip` no mira X-Forwarded-For porque Express no tiene `trust proxy` configurado.
 */
export function limitarLogin(limitador: LimitadorLogin, logger: Logger): RequestHandler {
  return async (req, res, next) => {
    const { email } = req.body as LoginBody;
    let estado: EstadoLimite;
    try {
      estado = await limitador.contar({ email, ip: req.ip ?? 'desconocida' });
    } catch (err) {
      logger.error({ err }, 'login: no se pudo consultar el límite de intentos');
      throw new ErrorHttp(503, 'LIMITE_NO_DISPONIBLE', 'El login no está disponible en este momento');
    }

    res.setHeader('RateLimit-Limit', estado.limite);
    res.setHeader('RateLimit-Remaining', estado.restantes);
    res.setHeader('RateLimit-Reset', estado.reinicioSegundos);
    if (estado.excedido) {
      res.setHeader('Retry-After', estado.reinicioSegundos);
      throw new ErrorHttp(429, 'DEMASIADOS_INTENTOS', 'Demasiados intentos. Probá de nuevo más tarde');
    }
    next();
  };
}
