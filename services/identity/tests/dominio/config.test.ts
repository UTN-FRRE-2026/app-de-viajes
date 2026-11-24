import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EsquemaConfig } from '../../src/config/index.js';

const claveB64 = (modulusLength: number) => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength });
  return Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
};

const CLAVE = claveB64(2048);
const base = {
  IDENTITY_PERSISTENCIA: 'memoria',
  JWT_ISSUER: 'viajes-identity',
  JWT_AUDIENCE: 'viajes',
  IDENTITY_JWT_CLAVE_PRIVADA_B64: CLAVE,
  METRICAS_TOKEN: 'm'.repeat(40),
  IDENTITY_TOKEN_SERVICIO: 's'.repeat(40),
};

const variablesConError = (entorno: Record<string, string | undefined>) => {
  const r = EsquemaConfig.safeParse(entorno);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('configuración', () => {
  it('con lo mínimo arranca con los parámetros de OWASP y el puerto 3001', () => {
    const c = EsquemaConfig.parse(base);
    expect(c).toMatchObject({ PUERTO: 3001, ARGON2_MEMORIA_KIB: 19_456, ARGON2_ITERACIONES: 2, ARGON2_PARALELISMO: 1 });
  });

  it('sin token de métricas, o con uno corto, nombra la variable', () => {
    expect(variablesConError({ ...base, METRICAS_TOKEN: undefined })).toEqual(['METRICAS_TOKEN']);
    expect(variablesConError({ ...base, METRICAS_TOKEN: 'corto' })).toEqual(['METRICAS_TOKEN']);
  });

  it('sin token de servicio, o con uno corto, nombra la variable', () => {
    expect(variablesConError({ ...base, IDENTITY_TOKEN_SERVICIO: undefined })).toEqual(['IDENTITY_TOKEN_SERVICIO']);
    expect(variablesConError({ ...base, IDENTITY_TOKEN_SERVICIO: 'corto' })).toEqual(['IDENTITY_TOKEN_SERVICIO']);
  });

  it('sin clave privada nombra la variable', () => {
    expect(variablesConError({ ...base, IDENTITY_JWT_CLAVE_PRIVADA_B64: undefined })).toEqual(['IDENTITY_JWT_CLAVE_PRIVADA_B64']);
  });

  it('una clave inválida se rechaza y el mensaje no repite el valor', () => {
    const r = EsquemaConfig.safeParse({ ...base, IDENTITY_JWT_CLAVE_PRIVADA_B64: 'c2VjcmV0by1tdXktc2VjcmV0bw==' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain('c2VjcmV0by1tdXktc2VjcmV0bw');
  });

  it('una clave RSA de menos de 2048 bits se rechaza', () => {
    expect(variablesConError({ ...base, IDENTITY_JWT_CLAVE_PRIVADA_B64: claveB64(1024) })).toEqual(['IDENTITY_JWT_CLAVE_PRIVADA_B64']);
  });

  it.each([
    ['ARGON2_MEMORIA_KIB', '1024'],
    ['ARGON2_ITERACIONES', '1'],
    ['ARGON2_PARALELISMO', '0'],
  ])('no deja bajar %s del piso', (variable, valor) => {
    expect(variablesConError({ ...base, [variable]: valor })).toEqual([variable]);
  });

  it('los límites de login vacíos (Compose los pasa así si no están en el .env) usan el valor por defecto, nunca 0', () => {
    const c = EsquemaConfig.parse({ ...base, IDENTITY_LOGIN_MAX_POR_EMAIL: '', IDENTITY_LOGIN_MAX_POR_IP: ' ' });
    expect(c).toMatchObject({ IDENTITY_LOGIN_MAX_POR_EMAIL: 5, IDENTITY_LOGIN_MAX_POR_IP: 30 });
  });

  it('con postgres exige su propia base y Redis', () => {
    expect(variablesConError({ ...base, IDENTITY_PERSISTENCIA: 'postgres' })).toEqual(['IDENTITY_DATABASE_URL', 'REDIS_URL']);
  });

  it('DATABASE_URL de dispatch no sirve como base de identity', () => {
    const entorno = { ...base, IDENTITY_PERSISTENCIA: 'postgres', REDIS_URL: 'redis://localhost:6379', DATABASE_URL: 'postgresql://x@y/dispatch' };
    expect(variablesConError(entorno)).toEqual(['IDENTITY_DATABASE_URL']);
  });
});
