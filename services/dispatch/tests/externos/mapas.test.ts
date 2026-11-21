import { ErrorHttp, crearLogger } from '@viajes/platform';
import { describe, expect, it } from 'vitest';
import { MapasConTimeout } from '../../src/infra/externos/mapas-con-timeout.js';
import { distanciaRectaMetros, MapasSimulado } from '../../src/infra/externos/mapas-simulado.js';
import { MapasFalso } from '../soporte/mapas-falso.js';
import { DESTINO, ORIGEN } from '../soporte/memoria.js';

const silencioso = crearLogger('mapas-test', 'silent');

describe('MapasSimulado', () => {
  it('la línea recta entre dos puntos conocidos coincide con una cuenta independiente (±0,5 %)', () => {
    // Aproximación equirectangular, suficiente a escala de una ciudad.
    const latMedia = (((ORIGEN.lat + DESTINO.lat) / 2) * Math.PI) / 180;
    const dy = (DESTINO.lat - ORIGEN.lat) * 111_195;
    const dx = (DESTINO.lng - ORIGEN.lng) * 111_195 * Math.cos(latMedia);
    const esperado = Math.hypot(dx, dy);
    expect(Math.abs(distanciaRectaMetros(ORIGEN, DESTINO) - esperado) / esperado).toBeLessThan(0.005);
  });

  it('aplica el desvío, calcula el tiempo con la velocidad media y devuelve enteros', async () => {
    const mapas = new MapasSimulado({ factorDesvio: 1.3, velocidadKmh: 25 });
    const { metros, segundos } = await mapas.recorrido(ORIGEN, DESTINO);
    expect(metros).toBe(Math.round(distanciaRectaMetros(ORIGEN, DESTINO) * 1.3));
    expect(segundos).toBe(Math.round((metros * 3.6) / 25));
    expect(Number.isInteger(metros) && Number.isInteger(segundos)).toBe(true);
  });

  it('el mismo punto da 0 m y 0 s', async () => {
    const mapas = new MapasSimulado({ factorDesvio: 1.3, velocidadKmh: 25 });
    expect(await mapas.recorrido(ORIGEN, ORIGEN)).toEqual({ metros: 0, segundos: 0 });
  });
});

describe('MapasConTimeout: falla cerrado', () => {
  const envolver = (falso: MapasFalso, timeoutMs = 100) => new MapasConTimeout(falso, timeoutMs, silencioso);
  const noDisponible = { estado: 503, codigo: 'MAPAS_NO_DISPONIBLE' };

  it('una respuesta a tiempo pasa sin cambios', async () => {
    const falso = new MapasFalso();
    falso.modo = { recorrido: { metros: 1234, segundos: 56 }, demoraMs: 20 };
    expect(await envolver(falso).recorrido(ORIGEN, DESTINO)).toEqual({ metros: 1234, segundos: 56 });
  });

  it('si no contesta, corta en el timeout con 503 y no espera de más', async () => {
    const falso = new MapasFalso();
    falso.modo = 'colgado';
    const inicio = Date.now();
    const error = await envolver(falso, 100).recorrido(ORIGEN, DESTINO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorHttp);
    expect(error).toMatchObject(noDisponible);
    expect(Date.now() - inicio).toBeLessThan(1000);
  });

  it('una respuesta que llega después del timeout también es 503', async () => {
    const falso = new MapasFalso();
    falso.modo = { recorrido: { metros: 1, segundos: 1 }, demoraMs: 300 };
    await expect(envolver(falso, 100).recorrido(ORIGEN, DESTINO)).rejects.toMatchObject(noDisponible);
  });

  it('si el adaptador falla, 503 sin el detalle interno', async () => {
    const falso = new MapasFalso();
    falso.modo = 'falla';
    const error: unknown = await envolver(falso).recorrido(ORIGEN, DESTINO).catch((e: unknown) => e);
    expect(error).toMatchObject(noDisponible);
    expect((error as Error).message).not.toContain('caído');
  });

  it('si responde fuera de contrato (decimales o negativos), 503: no se estima con eso', async () => {
    const falso = new MapasFalso();
    falso.modo = 'fuera-de-contrato';
    await expect(envolver(falso).recorrido(ORIGEN, DESTINO)).rejects.toMatchObject(noDisponible);
  });
});
