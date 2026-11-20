import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alNorte, OBELISCO } from '../soporte/memoria.js';
import { levantarLocation, TOKEN_SERVICIO, type Location } from '../soporte/sistema.js';

let d: Location;

beforeAll(async () => {
  d = await levantarLocation();
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
});

const informar = (cabeceras: Record<string, string>, cuerpo: unknown) =>
  request(d.url).post('/ubicaciones').set(cabeceras).send(cuerpo as object);
const candidatos = (query: Record<string, string | number>, cabeceras: Record<string, string> = d.servicio) =>
  request(d.url).get('/interno/candidatos').query(query).set(cabeceras);

describe('POST /ubicaciones', () => {
  it('un chofer informa su posición → 204, guardada a su nombre', async () => {
    const chofer = randomUUID();
    const res = await informar(await d.auth(chofer, 'chofer'), alNorte(300));
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    const filas = await d.prisma.ping.findMany();
    expect(filas).toHaveLength(1);
    expect(filas[0]?.choferId).toBe(chofer);
  });

  it('sin token → 401 con el formato de error único', async () => {
    const res = await request(d.url).post('/ubicaciones').send(alNorte(300));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'NO_AUTENTICADO', message: expect.any(String), requestId: expect.any(String) } });
  });

  it.each(['pasajero', 'operador', 'admin', 'admin_flota'] as const)('rol %s → 403', async (rol) => {
    const res = await informar(await d.auth(randomUUID(), rol), alNorte(300));
    expect(res.status).toBe(403);
    expect(await d.prisma.ping.count()).toBe(0);
  });

  it('choferId en el body → 400: nadie informa la posición de otro', async () => {
    const otro = randomUUID();
    const res = await informar(await d.auth(randomUUID(), 'chofer'), { ...alNorte(300), choferId: otro });
    expect(res.status).toBe(400);
    expect(await d.prisma.ping.count()).toBe(0);
  });

  it.each([
    ['latitud fuera de rango', { lat: 91, lng: 0 }],
    ['longitud fuera de rango', { lat: 0, lng: -181 }],
    ['coordenada como texto', { lat: '-34.6', lng: '-58.4' }],
    ['falta lng', { lat: -34.6 }],
    ['clave extra', { ...OBELISCO, precision: 5 }],
  ])('%s → 400', async (_caso, cuerpo) => {
    expect((await informar(await d.auth(randomUUID(), 'chofer'), cuerpo)).status).toBe(400);
    expect(await d.prisma.ping.count()).toBe(0);
  });

  it('__proto__ en el body → 400 y no contamina el objeto', async () => {
    const res = await request(d.url)
      .post('/ubicaciones')
      .set(await d.auth(randomUUID(), 'chofer'))
      .set('content-type', 'application/json')
      .send('{"lat":-34.6,"lng":-58.4,"__proto__":{"choferId":"otro"}}');
    expect(res.status).toBe(400);
    expect(({} as Record<string, unknown>)['choferId']).toBeUndefined();
  });

  it('el token de servicio no sirve para informar una posición → 401', async () => {
    expect((await informar(d.servicio, alNorte(300))).status).toBe(401);
  });
});

describe('GET /interno/candidatos', () => {
  it('devuelve el contrato: ordenados, con distancia entera y fecha ISO', async () => {
    const [cerca, lejos] = [randomUUID(), randomUUID()];
    await informar(await d.auth(lejos, 'chofer'), alNorte(2000)).expect(204);
    await informar(await d.auth(cerca, 'chofer'), alNorte(150)).expect(204);

    const res = await candidatos({ lat: OBELISCO.lat, lng: OBELISCO.lng });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      candidatos: [
        { choferId: cerca, distanciaMetros: expect.any(Number), actualizadaEn: expect.stringMatching(/Z$/) },
        { choferId: lejos, distanciaMetros: expect.any(Number), actualizadaEn: expect.stringMatching(/Z$/) },
      ],
    });
  });

  it('límite y radio se aplican; lat=0 y lng=0 son válidos', async () => {
    await informar(await d.auth(randomUUID(), 'chofer'), alNorte(150)).expect(204);
    expect((await candidatos({ lat: OBELISCO.lat, lng: OBELISCO.lng, radioMetros: 100 })).body).toEqual({ candidatos: [] });
    expect((await candidatos({ lat: 0, lng: 0 })).status).toBe(200);
  });

  it.each([
    ['sin el encabezado', {}],
    ['con un token distinto', { 'X-Token-Servicio': `${TOKEN_SERVICIO}x` }],
    ['con un token vacío', { 'X-Token-Servicio': '' }],
  ])('%s → 401', async (_caso, cabeceras) => {
    const res = await candidatos({ lat: OBELISCO.lat, lng: OBELISCO.lng }, cabeceras);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_SERVICIO_INVALIDO');
    expect(res.text).not.toContain(TOKEN_SERVICIO);
  });

  it('el JWT de un usuario no abre la ruta interna → 401', async () => {
    const res = await candidatos({ lat: OBELISCO.lat, lng: OBELISCO.lng }, await d.auth(randomUUID(), 'admin'));
    expect(res.status).toBe(401);
  });

  it.each([
    ['sin lat', { lng: -58.4 }],
    ['lat vacía', { lat: '', lng: -58.4 }],
    ['lat no numérica', { lat: 'norte', lng: -58.4 }],
    ['lat fuera de rango', { lat: 95, lng: -58.4 }],
    ['límite 0', { lat: -34.6, lng: -58.4, limite: 0 }],
    ['límite mayor al máximo', { lat: -34.6, lng: -58.4, limite: 101 }],
    ['límite decimal', { lat: -34.6, lng: -58.4, limite: 2.5 }],
    ['radio mayor al máximo', { lat: -34.6, lng: -58.4, radioMetros: 50_001 }],
    ['parámetro desconocido', { lat: -34.6, lng: -58.4, flota: 'x' }],
  ])('%s → 400', async (_caso, query) => {
    expect((await candidatos(query)).status).toBe(400);
  });

  it('un parámetro repetido → 400', async () => {
    const res = await request(d.url).get('/interno/candidatos?lat=-34.6&lat=-34.7&lng=-58.4').set(d.servicio);
    expect(res.status).toBe(400);
  });
});

describe('salud', () => {
  it('/health responde y /ready chequea Postgres y migraciones', async () => {
    expect((await request(d.url).get('/health')).status).toBe(200);
    const res = await request(d.url).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ estado: 'listo', chequeos: { postgres: 'ok', migraciones: 'ok' } });
  });
});

describe('encabezados de seguridad (CSP y helmet)', () => {
  it.each(['/health', '/no-existe'])('%s → CSP que niega todo, nosniff y sin x-powered-by', async (ruta) => {
    const res = await request(d.url).get(ruta);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'",
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
