import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';

let d: Awaited<ReturnType<typeof levantarDispatch>>;

beforeAll(async () => {
  d = await levantarDispatch();
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
});

const cuerpo = { origen: ORIGEN, destino: DESTINO };

describe('autenticación y autorización', () => {
  it('sin token → 401 con el formato de error único', async () => {
    const res = await request(d.url).post('/solicitudes').send(cuerpo);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'NO_AUTENTICADO', message: expect.any(String), requestId: expect.any(String) } });
  });

  it('token firmado con otra clave → 401', async () => {
    const otro = await (await import('../soporte/tokens.js')).crearEmisorTokens();
    const res = await request(d.url).post('/solicitudes').set(await otro.auth(randomUUID(), 'pasajero')).send(cuerpo);
    expect(res.status).toBe(401);
  });

  it('un chofer no puede pedir viajes → 403', async () => {
    const res = await request(d.url).post('/solicitudes').set(await d.auth(randomUUID(), 'chofer')).send(cuerpo);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROL_NO_PERMITIDO');
  });

  it('un pasajero no puede aceptar ofertas → 403', async () => {
    const res = await request(d.url).post(`/ofertas/${randomUUID()}/aceptar`).set(await d.auth(randomUUID(), 'pasajero')).send({});
    expect(res.status).toBe(403);
  });
});

describe('validación (lista blanca)', () => {
  it('clave extra en el body → 400', async () => {
    const res = await request(d.url)
      .post('/solicitudes')
      .set(await d.auth(randomUUID(), 'pasajero'))
      .send({ ...cuerpo, choferId: randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDACION');
  });

  it('__proto__ en el body → 400 (no se cuela en el objeto)', async () => {
    const crudo = `{"origen":{"lat":-34.6,"lng":-58.4},"destino":{"lat":-34.5,"lng":-58.4},"__proto__":{"admin":true}}`;
    const res = await request(d.url)
      .post('/solicitudes')
      .set(await d.auth(randomUUID(), 'pasajero'))
      .set('content-type', 'application/json')
      .send(crudo);
    expect(res.status).toBe(400);
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
  });

  it('coordenadas fuera de rango → 400', async () => {
    const res = await request(d.url)
      .post('/solicitudes')
      .set(await d.auth(randomUUID(), 'pasajero'))
      .send({ origen: { lat: 120, lng: 0 }, destino: DESTINO });
    expect(res.status).toBe(400);
  });

  it('id que no es uuid → 400 (no llega al SQL)', async () => {
    const res = await request(d.url).get(`/solicitudes/1' OR '1'='1`).set(await d.auth(randomUUID(), 'pasajero'));
    expect(res.status).toBe(400);
  });

  it('body demasiado grande → 413', async () => {
    const res = await request(d.url)
      .post('/solicitudes')
      .set(await d.auth(randomUUID(), 'pasajero'))
      .send({ ...cuerpo, relleno: 'x'.repeat(20_000) });
    expect(res.status).toBe(413);
  });
});

describe('acceso a recursos ajenos (IDOR)', () => {
  it('leer la solicitud de otro pasajero → 404', async () => {
    d.buscador.choferes = [randomUUID()];
    const creada = await request(d.url).post('/solicitudes').set(await d.auth(randomUUID(), 'pasajero')).send(cuerpo);
    const res = await request(d.url).get(`/solicitudes/${creada.body.id}`).set(await d.auth(randomUUID(), 'pasajero'));
    expect(res.status).toBe(404);
  });

  it('cancelar la solicitud de otro pasajero → 404 y no cambia nada', async () => {
    d.buscador.choferes = [randomUUID()];
    const creada = await request(d.url).post('/solicitudes').set(await d.auth(randomUUID(), 'pasajero')).send(cuerpo);
    const res = await request(d.url)
      .post(`/solicitudes/${creada.body.id}/cancelar`)
      .set(await d.auth(randomUUID(), 'pasajero'))
      .send({});
    expect(res.status).toBe(404);
    const s = await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: creada.body.id } });
    expect(s.estado).toBe('BUSCANDO');
  });

  it('aceptar la oferta de otro chofer → 404', async () => {
    d.buscador.choferes = [randomUUID()];
    const creada = await request(d.url).post('/solicitudes').set(await d.auth(randomUUID(), 'pasajero')).send(cuerpo);
    const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId: creada.body.id } });
    const res = await request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(await d.auth(randomUUID(), 'chofer')).send({});
    expect(res.status).toBe(404);
    expect(await d.prisma.asignacionActiva.count()).toBe(0);
  });
});
