import { describe, expect, it } from 'vitest';
import { EsquemaConfig } from '../../src/config/index.js';

const TOKEN = 'a'.repeat(40);
const base = {
  UBICACION_ESTRATEGIA: 'memoria',
  JWKS_URL: 'http://localhost:3001/.well-known/jwks.json',
  JWT_ISSUER: 'viajes-identity',
  JWT_AUDIENCE: 'viajes',
  LOCATION_TOKEN_SERVICIO: TOKEN,
};

const variablesConError = (entorno: Record<string, string | undefined>) => {
  const r = EsquemaConfig.safeParse(entorno);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('configuración', () => {
  it('con lo mínimo arranca en 3004, estrategia y vigencia por defecto', () => {
    expect(EsquemaConfig.parse({ ...base, UBICACION_ESTRATEGIA: undefined, LOCATION_DATABASE_URL: 'postgresql://x@y/location' })).toMatchObject({
      PUERTO: 3004,
      UBICACION_ESTRATEGIA: 'ingenua',
      UBICACION_VIGENCIA_SEGUNDOS: 30,
    });
  });

  it('sin token de servicio nombra la variable', () => {
    expect(variablesConError({ ...base, LOCATION_TOKEN_SERVICIO: undefined })).toEqual(['LOCATION_TOKEN_SERVICIO']);
  });

  it('un token de servicio corto se rechaza, y el mensaje no repite el valor', () => {
    const r = EsquemaConfig.safeParse({ ...base, LOCATION_TOKEN_SERVICIO: 'secreto-corto' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain('secreto-corto');
  });

  it('la estrategia ingenua exige su propia base, no la DATABASE_URL de dispatch', () => {
    expect(
      variablesConError({ ...base, UBICACION_ESTRATEGIA: 'ingenua', DATABASE_URL: 'postgresql://x@y/dispatch' }),
    ).toEqual(['LOCATION_DATABASE_URL']);
  });

  it('una estrategia desconocida se rechaza', () => {
    expect(variablesConError({ ...base, UBICACION_ESTRATEGIA: 'magia' })).toEqual(['UBICACION_ESTRATEGIA']);
  });
});
