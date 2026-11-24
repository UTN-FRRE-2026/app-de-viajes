import { describe, expect, it } from 'vitest';
import { EsquemaConfig } from '../../src/config/index.js';

const TOKEN = 'a'.repeat(40);
const base = {
  UBICACION_ESTRATEGIA: 'memoria',
  JWKS_URL: 'http://localhost:3001/.well-known/jwks.json',
  JWT_ISSUER: 'viajes-identity',
  JWT_AUDIENCE: 'viajes',
  LOCATION_TOKEN_SERVICIO: TOKEN,
  METRICAS_TOKEN: 'm'.repeat(40),
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

  it('retención del historial: 720 h, cada 5 min y lotes de 5000 por defecto; como mínimo 1 h', () => {
    expect(EsquemaConfig.parse(base)).toMatchObject({
      LOCATION_HISTORIAL_RETENCION_HORAS: 720,
      LOCATION_HISTORIAL_RETENCION_INTERVALO_MS: 300_000,
      LOCATION_HISTORIAL_RETENCION_LOTE: 5000,
    });
    expect(EsquemaConfig.parse({ ...base, LOCATION_HISTORIAL_RETENCION_HORAS: '24' }).LOCATION_HISTORIAL_RETENCION_HORAS).toBe(24);
    // El Compose las pasa vacías si no están en el .env: valen los valores por defecto.
    expect(
      EsquemaConfig.parse({
        ...base,
        LOCATION_HISTORIAL_RETENCION_HORAS: '',
        LOCATION_HISTORIAL_RETENCION_INTERVALO_MS: '',
        LOCATION_HISTORIAL_RETENCION_LOTE: '',
      }),
    ).toMatchObject({
      LOCATION_HISTORIAL_RETENCION_HORAS: 720,
      LOCATION_HISTORIAL_RETENCION_INTERVALO_MS: 300_000,
      LOCATION_HISTORIAL_RETENCION_LOTE: 5000,
    });
    // Menos de 1 h podría alcanzar a una posición vigente (la vigencia llega a 600 s).
    for (const horas of ['0', '-1', '0.5', '8761']) {
      expect(variablesConError({ ...base, LOCATION_HISTORIAL_RETENCION_HORAS: horas }), horas).toEqual(['LOCATION_HISTORIAL_RETENCION_HORAS']);
    }
    expect(variablesConError({ ...base, LOCATION_HISTORIAL_RETENCION_LOTE: '0' })).toEqual(['LOCATION_HISTORIAL_RETENCION_LOTE']);
    expect(variablesConError({ ...base, LOCATION_HISTORIAL_RETENCION_INTERVALO_MS: '10' })).toEqual(['LOCATION_HISTORIAL_RETENCION_INTERVALO_MS']);
  });

  it('pings sin viaje: ausente o vacía, el menor entre 24 h y la retención total; nunca más que la retención', () => {
    const horas = (entorno: Record<string, string>) => EsquemaConfig.parse({ ...base, ...entorno }).LOCATION_HISTORIAL_SIN_VIAJE_HORAS;
    expect(horas({})).toBe(24);
    expect(horas({ LOCATION_HISTORIAL_SIN_VIAJE_HORAS: '' })).toBe(24);
    expect(horas({ LOCATION_HISTORIAL_RETENCION_HORAS: '12' })).toBe(12);
    expect(horas({ LOCATION_HISTORIAL_SIN_VIAJE_HORAS: '48' })).toBe(48);
    expect(horas({ LOCATION_HISTORIAL_SIN_VIAJE_HORAS: '720' })).toBe(720);
    expect(variablesConError({ ...base, LOCATION_HISTORIAL_SIN_VIAJE_HORAS: '721' })).toEqual(['LOCATION_HISTORIAL_SIN_VIAJE_HORAS']);
    expect(variablesConError({ ...base, LOCATION_HISTORIAL_RETENCION_HORAS: '12', LOCATION_HISTORIAL_SIN_VIAJE_HORAS: '24' })).toEqual([
      'LOCATION_HISTORIAL_SIN_VIAJE_HORAS',
    ]);
    expect(variablesConError({ ...base, LOCATION_HISTORIAL_SIN_VIAJE_HORAS: '0' })).toEqual(['LOCATION_HISTORIAL_SIN_VIAJE_HORAS']);
  });

  it('dispatch para la retención por viaje: opcional; vacías valen como ausentes; un token corto se rechaza', () => {
    expect(EsquemaConfig.parse({ ...base, DISPATCH_URL: '', DISPATCH_TOKEN_SERVICIO: '', DISPATCH_TIMEOUT_MS: '' })).toMatchObject({
      DISPATCH_URL: undefined,
      DISPATCH_TOKEN_SERVICIO: undefined,
      DISPATCH_TIMEOUT_MS: 1000,
    });
    expect(variablesConError({ ...base, DISPATCH_TOKEN_SERVICIO: 'corto' })).toEqual(['DISPATCH_TOKEN_SERVICIO']);
    expect(variablesConError({ ...base, DISPATCH_URL: 'no-es-url' })).toEqual(['DISPATCH_URL']);
  });

  it('sin token de servicio nombra la variable', () => {
    expect(variablesConError({ ...base, LOCATION_TOKEN_SERVICIO: undefined })).toEqual(['LOCATION_TOKEN_SERVICIO']);
  });

  it('sin token de métricas, o con uno corto, nombra la variable', () => {
    expect(variablesConError({ ...base, METRICAS_TOKEN: undefined })).toEqual(['METRICAS_TOKEN']);
    expect(variablesConError({ ...base, METRICAS_TOKEN: 'corto' })).toEqual(['METRICAS_TOKEN']);
  });

  it('un token de métricas con espacios se rechaza al arrancar, como en el Bearer, y el mensaje no repite el valor', () => {
    const largo = 'm'.repeat(40);
    for (const token of [`${largo} ${largo}`, ` ${largo}`, `${largo} `, `${largo}\t${largo}`]) {
      const r = EsquemaConfig.safeParse({ ...base, METRICAS_TOKEN: token });
      expect(r.success).toBe(false);
      expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(['METRICAS_TOKEN']);
      expect(JSON.stringify(r.error?.issues)).not.toContain(largo);
    }
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

  it('la optimizada exige Redis y también Postgres (para el historial)', () => {
    expect(variablesConError({ ...base, UBICACION_ESTRATEGIA: 'optimizada' })).toEqual(['LOCATION_DATABASE_URL', 'REDIS_URL']);
  });

  it('el prefijo de Redis tiene un formato fijo, y el de carga es válido', () => {
    const ok = { ...base, UBICACION_ESTRATEGIA: 'memoria' };
    expect(variablesConError({ ...ok, LOCATION_REDIS_PREFIJO: 'carga:location:' })).toEqual([]);
    for (const malo of ['location', '*:', 'Location:', 'a b:']) {
      expect(variablesConError({ ...ok, LOCATION_REDIS_PREFIJO: malo }), malo).toEqual(['LOCATION_REDIS_PREFIJO']);
    }
  });
});
