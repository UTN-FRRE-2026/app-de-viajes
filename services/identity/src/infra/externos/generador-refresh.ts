import { createHash, randomBytes } from 'node:crypto';
import type { GeneradorRefresh, SecretoRefresh } from '../../dominio/puertos/index.js';

/**
 * 256 bits aleatorios: no hace falta sal ni un hash lento, porque no hay nada que adivinar.
 * Se guarda el SHA-256 para que una copia de la base no sirva para renovar sesiones.
 */
export const generadorRefresh: GeneradorRefresh = {
  nuevo(): SecretoRefresh {
    const token = randomBytes(32).toString('base64url');
    return { token, huella: generadorRefresh.huella(token) };
  },
  huella(token: string): string {
    return createHash('sha256').update(token).digest('base64url');
  },
};
