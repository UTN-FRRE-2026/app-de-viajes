import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crearLogger } from '@viajes/platform';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { componer, type Sistema } from '../../src/composicion.js';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { RepositorioDespachoPrisma } from '../../src/infra/db/repositorio-prisma.js';
import { URL_BD_TEST } from '../soporte/preparar-bd.js';
import { clave, DESTINO, ORIGEN, configTest } from '../soporte/sistema-postgres.js';
import { crearEmisorTokens } from '../soporte/tokens.js';

/**
 * dispatch con el adaptador HTTP real contra un location falso. Prueba lo que pide el plan
 * (sección 2 y verificación 7): si location no responde, la solicitud da 503 y no se crea el viaje.
 */
const TOKEN = 'token-de-servicio-de-prueba-con-32-caracteres-o-mas';

/** Qué contesta el location falso: choferes cercanos, un error o nada (colgado). */
let modo: { choferes: string[] } | { estado: number } | 'colgado' = { choferes: [] };
let location: Server;
let sistema: Sistema;
const prisma = crearPrisma(URL_BD_TEST, 5);
let auth: Awaited<ReturnType<typeof crearEmisorTokens>>['auth'];

beforeAll(async () => {
  location = createServer((req, res) => {
    if (req.headers['x-token-servicio'] !== TOKEN) return void res.writeHead(401).end();
    if (modo === 'colgado') return;
    if ('estado' in modo) return void res.writeHead(modo.estado).end();
    const candidatos = modo.choferes.map((choferId, i) => ({
      choferId,
      distanciaMetros: 100 * (i + 1),
      actualizadaEn: new Date().toISOString(),
    }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ candidatos }));
  });
  await new Promise<void>((r) => location.listen(0, '127.0.0.1', () => r()));

  const tokens = await crearEmisorTokens();
  auth = tokens.auth;
  const config = configTest({
    DISPATCH_BUSCADOR: 'location',
    LOCATION_URL: `http://127.0.0.1:${(location.address() as AddressInfo).port}`,
    LOCATION_TOKEN_SERVICIO: TOKEN,
    LOCATION_TIMEOUT_MS: '200',
    OFERTAS_SIMULTANEAS: '2',
  });
  sistema = componer(config, crearLogger('dispatch-test', 'silent'), {
    verificador: tokens.verificador,
    repo: new RepositorioDespachoPrisma(prisma),
  });
});
afterAll(async () => {
  location.closeAllConnections();
  await new Promise<void>((r) => location.close(() => r()));
  await sistema.cerrar();
  await prisma.$disconnect();
});
beforeEach(async () => {
  modo = { choferes: [] };
  await prisma.$executeRawUnsafe('TRUNCATE outbox, driver_active_assignment, offers, payments, ride_requests');
});

const pedirViaje = async (pasajero = randomUUID()) =>
  request(sistema.app).post('/solicitudes').set(clave()).set(await auth(pasajero, 'pasajero')).send({ origen: ORIGEN, destino: DESTINO });

describe('dispatch con location', () => {
  it('ofrece el viaje a los choferes más cercanos que devuelve location', async () => {
    const choferes = [randomUUID(), randomUUID(), randomUUID()];
    modo = { choferes };
    const res = await pedirViaje();
    expect(res.status).toBe(201);
    const ofertas = await prisma.oferta.findMany({ where: { solicitudId: res.body.id } });
    expect(ofertas.map((o) => o.choferId).sort()).toEqual(choferes.slice(0, 2).sort());
  });

  it('nadie cerca → la solicitud queda SIN_CHOFERES (no es un error)', async () => {
    const res = await pedirViaje();
    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('SIN_CHOFERES');
  });

  it.each([
    ['colgado (timeout)', 'colgado' as const],
    ['respondiendo 500', { estado: 500 }],
  ])('location %s → 503 y no se crea el viaje ni ningún evento', async (_caso, m) => {
    modo = m;
    const res = await pedirViaje();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: { code: 'UBICACION_NO_DISPONIBLE', message: expect.any(String), requestId: expect.any(String) },
    });
    expect(await prisma.solicitudViaje.count()).toBe(0);
    expect(await prisma.eventoOutbox.count()).toBe(0);
  });

  it('con location caído, /health y /ready siguen en 200: no es una dependencia de arranque', async () => {
    modo = { estado: 503 };
    expect((await request(sistema.app).get('/health')).status).toBe(200);
    expect((await request(sistema.app).get('/ready')).status).toBe(200);
  });

  it('el barrido con location caído no marca SIN_CHOFERES: reintenta en la pasada siguiente', async () => {
    const [c1, c2] = [randomUUID(), randomUUID()];
    modo = { choferes: [c1, c2] };
    const creada = await pedirViaje();
    await prisma.oferta.updateMany({ where: { solicitudId: creada.body.id }, data: { venceEn: new Date(Date.now() - 1000) } });

    modo = { estado: 500 };
    await expect(sistema.casos.vencerOfertas()).rejects.toMatchObject({ estado: 503 });
    expect((await prisma.solicitudViaje.findUniqueOrThrow({ where: { id: creada.body.id } })).estado).toBe('BUSCANDO');

    // Vuelve location: la pasada siguiente vence las ofertas y le ofrece al chofer nuevo.
    const c3 = randomUUID();
    modo = { choferes: [c1, c2, c3] };
    expect(await sistema.casos.vencerOfertas()).toBe(1);
    const pendientes = await prisma.oferta.findMany({ where: { solicitudId: creada.body.id, estado: 'PENDIENTE' } });
    expect(pendientes.map((o) => o.choferId)).toEqual([c3]);
  });
});
