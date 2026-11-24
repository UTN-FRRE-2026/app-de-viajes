import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RepositorioUbicaciones } from '../../src/dominio/puertos/index.js';
import { resultadoPing } from '../../src/infra/http/metricas.js';
import { alNorte } from '../soporte/memoria.js';
import { levantarLocation, type Location } from '../soporte/sistema.js';

/** Valor de `location_pings_total` para `de` y `resultado`, o undefined si la serie no está. */
async function pings(d: Location, de: 'chofer' | 'pasajero', resultado: string): Promise<number | undefined> {
  const res = await request(d.url).get('/metrics').set(d.conMetricas);
  expect(res.status).toBe(200);
  const linea = res.text
    .split('\n')
    .find((l) => l.startsWith('location_pings_total{') && l.includes(`de="${de}"`) && l.includes(`resultado="${resultado}"`));
  if (!linea) return undefined;
  expect(linea).toContain('estrategia="ingenua"');
  expect(linea).toContain('servicio="location"');
  return Number(linea.slice(linea.lastIndexOf(' ') + 1));
}

describe('resultadoPing', () => {
  it.each([
    [204, 'aceptado'],
    [400, 'rechazado'],
    [401, 'rechazado'],
    [403, 'rechazado'],
    [429, 'limitado'],
    [500, 'error'],
    [503, 'error'],
  ] as const)('%i → %s', (estado, esperado) => {
    expect(resultadoPing(estado)).toBe(esperado);
  });
});

describe('location_pings_total', () => {
  let d: Location;

  beforeAll(async () => {
    d = await levantarLocation({}, { LIMITE_UBICACIONES_POR_MINUTO: '2' });
  });
  afterAll(async () => {
    await d.cerrar();
  });

  it('todas las series existen en 0 desde el primer scrape', async () => {
    for (const de of ['chofer', 'pasajero'] as const) {
      for (const resultado of ['aceptado', 'limitado', 'rechazado', 'error']) {
        expect(await pings(d, de, resultado)).toBe(0);
      }
    }
  });

  it('cuenta cada ping por resultado: aceptado, limitado (429) y rechazado (401, 400)', async () => {
    const chofer = await d.auth(randomUUID(), 'chofer');
    const estados: number[] = [];
    for (let i = 0; i < 3; i++) {
      estados.push((await request(d.url).post('/ubicaciones').set(chofer).send(alNorte(300 + i))).status);
    }
    expect(estados).toEqual([204, 204, 429]);
    expect((await request(d.url).post('/ubicaciones').send(alNorte(300))).status).toBe(401);
    expect((await request(d.url).post('/ubicaciones').set(await d.auth(randomUUID(), 'chofer')).send({ lat: 91, lng: 0 })).status).toBe(400);

    // El pasajero: Redis está en los tests, así que la publicación sale y responde 204.
    const pasajero = await d.auth(randomUUID(), 'pasajero');
    expect((await request(d.url).post('/ubicaciones/pasajero').set(pasajero).send(alNorte(100))).status).toBe(204);

    expect(await pings(d, 'chofer', 'aceptado')).toBe(2);
    expect(await pings(d, 'chofer', 'limitado')).toBe(1);
    expect(await pings(d, 'chofer', 'rechazado')).toBe(2);
    expect(await pings(d, 'chofer', 'error')).toBe(0);
    expect(await pings(d, 'pasajero', 'aceptado')).toBe(1);
    expect(await pings(d, 'pasajero', 'rechazado')).toBe(0);
  });

  it('las otras rutas no cuentan como pings', async () => {
    const antes = await pings(d, 'chofer', 'rechazado');
    await request(d.url).get('/interno/candidatos').query({ lat: -34.6, lng: -58.4 });
    await request(d.url).get('/health');
    expect(await pings(d, 'chofer', 'rechazado')).toBe(antes);
  });
});

describe('location_pings_total con el guardado caído', () => {
  let d: Location;
  const caido: RepositorioUbicaciones = {
    guardar: () => Promise.reject(new Error('Postgres caído')),
    cercanos: () => Promise.resolve([]),
  };

  beforeAll(async () => {
    d = await levantarLocation({ repo: caido });
  });
  afterAll(async () => {
    await d.cerrar();
  });

  it('un ping que no se pudo guardar → 500, contado como error', async () => {
    const res = await request(d.url).post('/ubicaciones').set(await d.auth(randomUUID(), 'chofer')).send(alNorte(300));
    expect(res.status).toBe(500);
    expect(await pings(d, 'chofer', 'error')).toBe(1);
    expect(await pings(d, 'chofer', 'aceptado')).toBe(0);
  });
});
