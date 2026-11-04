import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { verificadorJwksLocal } from '@viajes/platform';
import { calculateJwkThumbprint, decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';
import { EmisorJwt } from '../../src/infra/externos/emisor-jwt.js';
import { RelojFalso } from '../soporte/memoria.js';

const OPCIONES = { issuer: 'viajes-identity-test', audience: 'viajes', ttlSegundos: 900 };

function crearEmisor(reloj: RelojFalso | { ahora: () => Date } = { ahora: () => new Date() }) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return new EmisorJwt(privateKey, OPCIONES, reloj, { nuevo: () => randomUUID() });
}

describe('emisor JWT', () => {
  it('emite RS256 con kid, issuer, audience, exp y jti', async () => {
    const reloj = new RelojFalso();
    const emisor = crearEmisor(reloj);
    const sub = randomUUID();
    const { token, expiraEnSegundos } = await emisor.emitir({ sub, rol: 'pasajero' });

    expect(expiraEnSegundos).toBe(900);
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'RS256', kid: emisor.clavesPublicas()[0]?.kid, typ: 'JWT' });
    const claims = decodeJwt(token);
    expect(claims).toMatchObject({ sub, rol: 'pasajero', iss: OPCIONES.issuer, aud: OPCIONES.audience });
    expect(claims.exp).toBe((claims.iat as number) + 900);
    expect(claims.jti).toEqual(expect.any(String));
    expect(claims).not.toHaveProperty('fleetId');
  });

  it('el kid es el thumbprint RFC 7638 de la clave pública', async () => {
    const [clave] = crearEmisor().clavesPublicas();
    expect(clave?.kid).toBe(await calculateJwkThumbprint({ kty: 'RSA', n: clave?.n, e: clave?.e }, 'sha256'));
  });

  it('solo publica campos públicos', () => {
    const [clave] = crearEmisor().clavesPublicas();
    expect(Object.keys(clave ?? {}).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
  });

  it('el verificador compartido acepta el token y conserva fleetId', async () => {
    const emisor = crearEmisor();
    const verificar = verificadorJwksLocal({ keys: emisor.clavesPublicas() }, OPCIONES);
    const sub = randomUUID();
    const { token } = await emisor.emitir({ sub, rol: 'admin_flota', fleetId: 'flota-1' });
    await expect(verificar(token)).resolves.toEqual({ id: sub, rol: 'admin_flota', fleetId: 'flota-1' });
  });

  it('el verificador compartido rechaza un token vencido', async () => {
    const reloj = new RelojFalso(new Date(Date.now() - 3_600_000));
    const emisor = crearEmisor(reloj);
    const verificar = verificadorJwksLocal({ keys: emisor.clavesPublicas() }, OPCIONES);
    const { token } = await emisor.emitir({ sub: randomUUID(), rol: 'chofer' });
    await expect(verificar(token)).rejects.toThrow();
  });
});
