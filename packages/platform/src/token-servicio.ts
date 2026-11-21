import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { ErrorHttp } from './errores.js';

const huella = (valor: string) => createHash('sha256').update(valor).digest();

const EncabezadoToken = z.string().min(1).max(256);

/**
 * Rutas internas entre servicios (dispatch → location, dispatch → identity): exigen un secreto
 * compartido en un encabezado (`x-token-servicio`, el mismo nombre que `ENCABEZADO_TOKEN_SERVICIO` de
 * `contracts`).
 * - Se comparan las huellas SHA-256 en tiempo constante: el tiempo de respuesta no dice cuántos
 *   caracteres acertó quien prueba.
 * - Sin el encabezado, o con uno distinto, siempre 401 con el mismo mensaje. Nunca se loguea el valor.
 * - El JWT de un usuario no sirve acá: estas rutas no son para clientes.
 */
export function exigirTokenServicio(secreto: string, encabezado = 'x-token-servicio'): RequestHandler {
  const esperado = huella(secreto);
  return (req, _res, next) => {
    const recibido = EncabezadoToken.safeParse(req.header(encabezado));
    if (!recibido.success || !timingSafeEqual(huella(recibido.data), esperado)) {
      throw new ErrorHttp(401, 'TOKEN_SERVICIO_INVALIDO', 'Falta el token de servicio o no es válido');
    }
    next();
  };
}
