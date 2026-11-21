import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clave, CON_METRICAS, levantarDispatch, TOKEN_METRICAS } from '../soporte/sistema-postgres.js';

let d: Awaited<ReturnType<typeof levantarDispatch>>;

beforeAll(async () => {
  d = await levantarDispatch();
});
afterAll(async () => {
  await d.cerrar();
});

/** Valor de una serie con esas etiquetas (en cualquier orden), o undefined si no está. */
function serie(texto: string, nombre: string, etiquetas: Record<string, string> = {}): number | undefined {
  const condiciones = Object.entries(etiquetas)
    .map(([k, v]) => `(?=[^}]*\\b${k}="${v.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}")`)
    .join('');
  const m = new RegExp(`^${nombre}\\{${condiciones}[^}]*\\} (\\S+)$`, 'm').exec(texto);
  return m ? Number(m[1]) : undefined;
}

const metricas = () => request(d.url).get('/metrics').set(CON_METRICAS);

describe('GET /metrics de dispatch', () => {
  it('sin token, con un JWT de usuario o con otro token → 401', async () => {
    expect((await request(d.url).get('/metrics')).status).toBe(401);
    // El router de dispatch autentica con JWT todo lo que pasa por él: /metrics va antes y no lo acepta.
    expect((await request(d.url).get('/metrics').set(await d.auth(randomUUID(), 'operador'))).status).toBe(401);
    expect((await request(d.url).get('/metrics').set('Authorization', `Bearer ${TOKEN_METRICAS.slice(1)}`)).status).toBe(401);
  });

  it('con el token: comunes con servicio=dispatch y las de negocio desde el arranque', async () => {
    const res = await metricas();
    expect(res.status).toBe(200);
    expect(serie(res.text, 'event_loop_lag_ms', { quantile: '0.99', servicio: 'dispatch' })).toBeGreaterThanOrEqual(0);
    expect(serie(res.text, 'dispatch_solicitudes_total', { resultado: 'con_ofertas' })).toBe(0);
    expect(serie(res.text, 'dispatch_solicitudes_total', { resultado: 'sin_choferes' })).toBe(0);
    expect(res.text).toMatch(/^dispatch_tiempo_hasta_asignacion_seconds_count\{servicio="dispatch"\} 0$/m);
    expect(res.text).not.toContain(TOKEN_METRICAS);
  });

  it('la ruta va como patrón, nunca con el id (si no, cada pedido sería una serie nueva)', async () => {
    const id = randomUUID();
    await request(d.url).get(`/solicitudes/${id}`).set(await d.auth(randomUUID(), 'pasajero')).expect(404);
    const res = await metricas();
    expect(
      serie(res.text, 'http_request_duration_seconds_count', { metodo: 'GET', ruta: '/solicitudes/:id', estado: '404' }),
    ).toBeGreaterThanOrEqual(1);
    expect(res.text).not.toContain(id);
  });

  it('un 401 del JWT, antes de llegar a una ruta, queda como sin_ruta', async () => {
    await request(d.url).post('/solicitudes').set(clave()).send({}).expect(401);
    const res = await metricas();
    expect(
      serie(res.text, 'http_request_duration_seconds_count', { metodo: 'POST', ruta: 'sin_ruta', estado: '401' }),
    ).toBeGreaterThanOrEqual(1);
  });
});
