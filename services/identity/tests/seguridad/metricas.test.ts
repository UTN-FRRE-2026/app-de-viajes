import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CON_METRICAS, levantarIdentity, TOKEN_METRICAS, type Identity } from '../soporte/sistema.js';

let d: Identity;

beforeAll(async () => {
  d = await levantarIdentity();
});
afterAll(async () => {
  await d.cerrar();
});

/** Valor de una serie con esas etiquetas (en cualquier orden), o undefined si no está. */
function serie(texto: string, nombre: string, etiquetas: Record<string, string>): number | undefined {
  const condiciones = Object.entries(etiquetas)
    .map(([k, v]) => `(?=[^}]*\\b${k}="${v.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}")`)
    .join('');
  const m = new RegExp(`^${nombre}\\{${condiciones}[^}]*\\} (\\S+)$`, 'm').exec(texto);
  return m ? Number(m[1]) : undefined;
}

const metricas = () => request(d.url).get('/metrics').set(CON_METRICAS);

describe('GET /metrics', () => {
  it('sin token, con otro token o con otro esquema → 401, siempre con el mismo mensaje', async () => {
    const respuestas = await Promise.all([
      request(d.url).get('/metrics'),
      request(d.url).get('/metrics').set('Authorization', 'Bearer otro-token-que-no-es-el-de-metricas-0000'),
      request(d.url).get('/metrics').set('Authorization', `Basic ${TOKEN_METRICAS}`),
      request(d.url).get('/metrics').set('Authorization', `Bearer ${TOKEN_METRICAS}x`),
    ]);
    for (const res of respuestas) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'TOKEN_METRICAS_INVALIDO', message: 'Falta el token de métricas o no es válido' });
    }
  });

  it('con el token: formato de Prometheus, lag, memoria y la etiqueta servicio', async () => {
    const res = await metricas();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(serie(res.text, 'event_loop_lag_ms', { quantile: '0.99', servicio: 'identity' })).toBeGreaterThanOrEqual(0);
    expect(serie(res.text, 'event_loop_lag_max_ms', { servicio: 'identity' })).toBeGreaterThanOrEqual(0);
    expect(serie(res.text, 'process_resident_memory_bytes', { servicio: 'identity' })).toBeGreaterThan(0);
    expect(res.text).not.toContain(TOKEN_METRICAS);
  });

  it('mide los pedidos por ruta y estado; lo que no llega a una ruta queda como sin_ruta', async () => {
    await request(d.url).post('/login').send({}).expect(400);
    await request(d.url).get('/no-existe-esta-ruta').expect(404);
    const res = await metricas();
    expect(
      serie(res.text, 'http_request_duration_seconds_count', { metodo: 'POST', ruta: '/login', estado: '400', servicio: 'identity' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      serie(res.text, 'http_request_duration_seconds_count', { metodo: 'GET', ruta: 'sin_ruta', estado: '404' }),
    ).toBeGreaterThanOrEqual(1);
    expect(res.text).not.toContain('/no-existe-esta-ruta');
  });
});
