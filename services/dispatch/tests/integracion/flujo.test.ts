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
  it('pedir → aceptar → en camino → iniciar → finalizar libera al chofer', async () => {
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

    const comoChofer = await d.auth(chofer, 'chofer');
    for (const [accion, estado] of [
      ['en-camino', 'EN_CAMINO'],
      ['iniciar', 'EN_CURSO'],
      ['finalizar', 'COMPLETADA'],
    ] as const) {
      const res = await request(d.url).post(`/solicitudes/${creada.body.id}/${accion}`).set(comoChofer).send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ estado, choferId: chofer });
      // El chofer queda reservado hasta finalizar, y se libera en la misma transacción.
      expect(await d.prisma.asignacionActiva.count()).toBe(estado === 'COMPLETADA' ? 0 : 1);
    }

    const otraVez = await request(d.url).post(`/solicitudes/${creada.body.id}/finalizar`).set(comoChofer).send({});
    expect(otraVez.status).toBe(409);
    expect(otraVez.body.error.code).toBe('TRANSICION_INVALIDA');

    // Los eventos quedaron en el outbox con el requestId del pedido que los generó.
    const eventos = await d.prisma.eventoOutbox.findMany({ orderBy: { creadoEn: 'asc' } });
    expect(eventos.map((e) => e.tipo)).toEqual([
      'RideRequested',
      'OfferCreated',
      'TripAssigned',
      'DriverEnRoute',
      'TripStarted',
      'RideCompleted',
    ]);
    expect(eventos[0]?.requestId).toBe(creada.headers['x-request-id']);
  });

  it('el operador cancela un viaje en curso con motivo: se guarda y el chofer queda libre', async () => {
    const pasajero = randomUUID();
    const chofer = randomUUID();
    d.buscador.choferes = [chofer];
    const creada = await request(d.url)
      .post('/solicitudes')
      .set(await d.auth(pasajero, 'pasajero'))
      .send({ origen: ORIGEN, destino: DESTINO });
    const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId: creada.body.id } });
    const comoChofer = await d.auth(chofer, 'chofer');
    await request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(comoChofer).send({});
    await request(d.url).post(`/solicitudes/${creada.body.id}/en-camino`).set(comoChofer).send({});
    await request(d.url).post(`/solicitudes/${creada.body.id}/iniciar`).set(comoChofer).send({});

    const operador = await d.auth(randomUUID(), 'operador');
    const sinMotivo = await request(d.url).post(`/solicitudes/${creada.body.id}/cancelar`).set(operador).send({});
    expect(sinMotivo.status).toBe(422);
    expect(sinMotivo.body.error.code).toBe('MOTIVO_REQUERIDO');

    const res = await request(d.url)
      .post(`/solicitudes/${creada.body.id}/cancelar`)
      .set(operador)
      .send({ motivo: 'Choque leve, el pasajero sigue en otro auto' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ estado: 'CANCELADO_OPERADOR', motivoCancelacion: 'Choque leve, el pasajero sigue en otro auto' });

    const fila = await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: creada.body.id } });
    expect(fila).toMatchObject({ estado: 'CANCELADO_OPERADOR', motivoCancelacion: 'Choque leve, el pasajero sigue en otro auto' });
    expect(await d.prisma.asignacionActiva.count()).toBe(0);
  });

  it('la base rechaza CANCELADO_OPERADOR sin motivo aunque el código se equivoque (CHECK)', async () => {
    const pasajero = randomUUID();
    d.buscador.choferes = [randomUUID()];
    const creada = await request(d.url)
      .post('/solicitudes')
      .set(await d.auth(pasajero, 'pasajero'))
      .send({ origen: ORIGEN, destino: DESTINO });
    await expect(
      d.prisma.solicitudViaje.update({ where: { id: creada.body.id }, data: { estado: 'CANCELADO_OPERADOR' } }),
    ).rejects.toThrow(/ride_requests_cancelado_operador_con_motivo_check/);
    await expect(
      d.prisma.solicitudViaje.update({ where: { id: creada.body.id }, data: { estado: 'EN_CURSO' } }),
    ).rejects.toThrow(/ride_requests_con_chofer_check/);
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
