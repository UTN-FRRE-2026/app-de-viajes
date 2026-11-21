import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { verificadorJwksLocal, type Rol, type VerificadorToken } from '@viajes/platform';

const OPCIONES = { issuer: 'viajes-identity-test', audience: 'viajes' };

/** Par RS256 de prueba: firmamos como lo haría identity y verificamos con un JWKS local. */
export async function crearEmisorTokens() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  const verificador: VerificadorToken = verificadorJwksLocal({ keys: [jwk] }, OPCIONES);

  /** `vence`: cualquier duración de jose (`5m`, `2s`). `fleetId`: solo el admin_flota, como en identity. */
  async function firmar(sub: string, rol: Rol, vence = '5m', fleetId?: string): Promise<string> {
    return new SignJWT(fleetId ? { rol, fleetId } : { rol })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject(sub)
      .setIssuer(OPCIONES.issuer)
      .setAudience(OPCIONES.audience)
      .setIssuedAt()
      .setExpirationTime(vence)
      .sign(privateKey);
  }

  async function auth(sub: string, rol: Rol, vence?: string): Promise<{ Authorization: string }> {
    return { Authorization: `Bearer ${await firmar(sub, rol, vence)}` };
  }

  /** Un admin_flota con su `fleetId` en el token. */
  async function authFlota(sub: string, fleetId: string): Promise<{ Authorization: string }> {
    return { Authorization: `Bearer ${await firmar(sub, 'admin_flota', '5m', fleetId)}` };
  }

  return { verificador, firmar, auth, authFlota };
}
