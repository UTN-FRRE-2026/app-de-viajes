import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearLogger } from '@viajes/platform';
import { componer } from '../../src/composicion.js';
import { DESTINO, configTest, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';
import { crearEmisorTokens } from '../soporte/tokens.js';

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

describe('flujo con Postgres', () => {
  it('pedir → aceptar → terminar libera al chofer', async () => {
    const pasajero = randomUUID();
    const chofer = randomUUID();
    d.buscador.choferes = [chofer];

    const creada = await request(d.url)
      .post('/solicitudes')
      .set(await d.auth(pasajero, 'pasajero'))
      .send({ origen: ORIGEN, destino: DESTINO });
    expect(creada.status).toBe(201);
    expect(creada.headers['x-request-id']).toBeTruthy();

    const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId: creada.body.id } });
    const aceptada = await request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(await d.auth(chofer, 'chofer')).send({});
    expect(aceptada.status).toBe(200);
    expect(aceptada.body).toMatchObject({ estado: 'ASIGNADO', choferId: chofer });

    // El chofer asignado puede ver la solicitud.
    const vista = await request(d.url).get(`/solicitudes/${creada.body.id}`).set(await d.auth(chofer, 'chofer'));
    expect(vista.status).toBe(200);

    expect(await d.casos.liberarChofer({ solicitudId: creada.body.id })).toEqual({ liberado: true });
    expect(await d.casos.liberarChofer({ solicitudId: creada.body.id })).toEqual({ liberado: false });
    expect(await d.prisma.asignacionActiva.count()).toBe(0);

    // Los eventos quedaron en el outbox con el requestId del pedido que los generó.
    const eventos = await d.prisma.eventoOutbox.findMany({ orderBy: { creadoEn: 'asc' } });
    expect(eventos.map((e) => e.tipo)).toEqual(['RideRequested', 'OfferCreated', 'TripAssigned', 'RideCompleted']);
    expect(eventos[0]?.requestId).toBe(creada.headers['x-request-id']);
  });

  it('el barrido vence ofertas en Postgres y pasa al siguiente chofer', async () => {
    const [c1, c2] = [randomUUID(), randomUUID()];
    d.buscador.choferes = [c1, c2];
    const pasajero = randomUUID();
    const creada = await request(d.url)
      .post('/solicitudes')
      .set(await d.auth(pasajero, 'pasajero'))
      .send({ origen: ORIGEN, destino: DESTINO });

    // Con OFERTAS_SIMULTANEAS=50 se ofreció a los dos; forzamos el vencimiento de c1 en la base.
    await d.prisma.oferta.updateMany({ where: { solicitudId: creada.body.id }, data: { venceEn: new Date(Date.now() - 1000) } });
    d.buscador.choferes = [c1, c2, randomUUID()];
    expect(await d.casos.vencerOfertas()).toBe(1);

    const ofertas = await d.prisma.oferta.findMany({ where: { solicitudId: creada.body.id } });
    expect(ofertas.filter((o) => o.estado === 'VENCIDA')).toHaveLength(2);
    expect(ofertas.filter((o) => o.estado === 'PENDIENTE')).toHaveLength(1);
  });

  it('/ready responde 200 con la base accesible y las migraciones aplicadas', async () => {
    const { verificador } = await crearEmisorTokens();
    const sistema = componer(configTest(), crearLogger('t', 'silent'), { verificador });
    const res = await request(sistema.app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.chequeos).toEqual({ postgres: 'ok', migraciones: 'ok' });
    expect((await request(sistema.app).get('/health')).status).toBe(200);
    await sistema.cerrar();
  });
});
