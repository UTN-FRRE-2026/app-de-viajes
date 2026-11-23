import { describe, expect, it } from 'vitest';
import { ErrorApi } from '../src/api/errores';
import { ClavesDeOperacion } from '../src/api/operacion';
import { estadoPosicion, leerCoordenadas, posicionParaEnviar, type Fijacion } from '../src/ubicacion/posicion';

describe('posición para enviar', () => {
  const ahora = Date.parse('2026-11-23T12:00:30.000Z');
  const gps = (edadMs: number): Fijacion => ({ lat: -34.6, lng: -58.38, tomadaEn: ahora - edadMs, fuente: 'gps' });

  it('una posición GPS de 10 s se envía; una de 16 s no (deja de ser reciente a los 15 s)', () => {
    expect(posicionParaEnviar(gps(10_000), ahora)).toEqual({ lat: -34.6, lng: -58.38 });
    expect(posicionParaEnviar(gps(15_000), ahora)).not.toBeNull();
    expect(posicionParaEnviar(gps(16_000), ahora)).toBeNull();
    expect(estadoPosicion(gps(16_000), ahora)).toEqual({ tipo: 'vieja', edadMs: 16_000 });
  });

  it('la manual (demo) se envía mientras esté puesta, sin importar cuándo se cargó', () => {
    const manual: Fijacion = { lat: -34.6, lng: -58.38, tomadaEn: ahora - 600_000, fuente: 'manual' };
    expect(posicionParaEnviar(manual, ahora)).toEqual({ lat: -34.6, lng: -58.38 });
  });

  it('sin posición no envía nada', () => {
    expect(posicionParaEnviar(null, ahora)).toBeNull();
  });

  it('lee coordenadas con coma o punto y rechaza las fuera de rango', () => {
    expect(leerCoordenadas('-34,6037', '-58.3816')).toEqual({ lat: -34.6037, lng: -58.3816 });
    expect(leerCoordenadas('91', '0')).toBeNull();
    expect(leerCoordenadas('', '0')).toBeNull();
  });
});

describe('ClavesDeOperacion', () => {
  let n = 0;
  const claves = () => new ClavesDeOperacion(() => `clave-${++n}`);

  it('con un resultado incierto conserva la clave para el reintento; con éxito la descarta', async () => {
    const c = claves();
    const usadas: string[] = [];
    await expect(c.ejecutar('disponible:true', async (k) => (usadas.push(k), Promise.reject(new ErrorApi(0, 'RED', 'sin red'))))).rejects.toThrow();
    await expect(
      c.ejecutar('disponible:true', async (k) => (usadas.push(k), Promise.reject(new ErrorApi(409, 'CLAVE_IDEMPOTENCIA_EN_CURSO', 'en curso')))),
    ).rejects.toThrow();
    await c.ejecutar('disponible:true', async (k) => usadas.push(k));
    await c.ejecutar('disponible:true', async (k) => usadas.push(k));
    expect(usadas[0]).toBe(usadas[1]);
    expect(usadas[1]).toBe(usadas[2]);
    expect(usadas[3]).not.toBe(usadas[2]);
  });

  it('con un error definitivo descarta la clave, y otro objetivo lleva otra', async () => {
    const c = claves();
    const k1 = c.para('disponible:true');
    await expect(c.ejecutar('disponible:true', async () => Promise.reject(new ErrorApi(409, 'CHOFER_NO_ACTIVO', 'no')))).rejects.toThrow();
    expect(c.para('disponible:true')).not.toBe(k1);
    expect(c.para('disponible:false')).not.toBe(c.para('disponible:true'));
  });
});
