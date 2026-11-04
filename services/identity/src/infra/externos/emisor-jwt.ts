import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import type { GeneradorId, Reloj } from '@viajes/kernel';
import { SignJWT } from 'jose';
import type { ClaimsToken, ClavePublica, EmisorTokens, TokenEmitido } from '../../dominio/puertos/index.js';

const ALGORITMO = 'RS256';

export interface OpcionesEmisor {
  issuer: string;
  audience: string;
  ttlSegundos: number;
}

/** Firma con la clave privada. Lo único que sale de acá es el token y la parte pública (n, e). */
export class EmisorJwt implements EmisorTokens {
  private readonly clavePublica: ClavePublica;

  constructor(
    private readonly clavePrivada: KeyObject,
    private readonly opciones: OpcionesEmisor,
    private readonly reloj: Reloj,
    private readonly ids: GeneradorId,
  ) {
    const { n, e } = createPublicKey(clavePrivada).export({ format: 'jwk' });
    if (!n || !e) throw new Error('la clave privada no es RSA');
    // kid: thumbprint RFC 7638 (miembros obligatorios en orden lexicográfico, sin espacios).
    const kid = createHash('sha256').update(JSON.stringify({ e, kty: 'RSA', n })).digest('base64url');
    this.clavePublica = { kty: 'RSA', n, e, kid, alg: ALGORITMO, use: 'sig' };
  }

  async emitir({ sub, rol, fleetId }: ClaimsToken): Promise<TokenEmitido> {
    const ahora = Math.floor(this.reloj.ahora().getTime() / 1000);
    const token = await new SignJWT({ rol, ...(fleetId ? { fleetId } : {}) })
      .setProtectedHeader({ alg: ALGORITMO, kid: this.clavePublica.kid, typ: 'JWT' })
      .setSubject(sub)
      .setIssuer(this.opciones.issuer)
      .setAudience(this.opciones.audience)
      .setIssuedAt(ahora)
      .setExpirationTime(ahora + this.opciones.ttlSegundos)
      // Queda listo para la denylist de revocación (pendiente).
      .setJti(this.ids.nuevo())
      .sign(this.clavePrivada);
    return { token, expiraEnSegundos: this.opciones.ttlSegundos };
  }

  clavesPublicas(): ClavePublica[] {
    return [{ ...this.clavePublica }];
  }
}
