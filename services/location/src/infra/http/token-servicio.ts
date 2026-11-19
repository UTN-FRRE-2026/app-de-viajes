import { createHash, timingSafeEqual } from 'node:crypto';
import { ENCABEZADO_TOKEN_SERVICIO } from '@viajes/contracts';
import { ErrorHttp } from '@viajes/platform';
import type { RequestHandler } from 'express';
import { z } from 'zod';

const huella = (valor: string) => createHash('sha256').update(valor).digest();

const EncabezadoToken = z.string().min(1).max(256);

/**
 * Rutas internas (dispatch → location): exigen el secreto compartido en `X-Token-Servicio`.
 * - Se comparan las huellas SHA-256 en tiempo constante: el tiempo de respuesta no dice cuántos
 *   caracteres acertó quien prueba.
 * - Sin el encabezado, o con uno distinto, siempre 401 con el mismo mensaje. Nunca se loguea el valor.
 * - El JWT de un usuario no sirve acá: estas rutas no son para clientes.
 */
export function exigirTokenServicio(secreto: string): RequestHandler {
  const esperado = huella(secreto);
  return (req, _res, next) => {
    const recibido = EncabezadoToken.safeParse(req.header(ENCABEZADO_TOKEN_SERVICIO));
    if (!recibido.success || !timingSafeEqual(huella(recibido.data), esperado)) {
      throw new ErrorHttp(401, 'TOKEN_SERVICIO_INVALIDO', 'Falta el token de servicio o no es válido');
    }
    next();
  };
}
