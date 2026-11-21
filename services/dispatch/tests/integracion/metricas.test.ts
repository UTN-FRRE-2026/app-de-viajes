import { randomUUID } from 'node:crypto';
import { crearLogger } from '@viajes/platform';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { componer, type Sistema } from '../../src/composicion.js';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { RepositorioDespachoPrisma } from '../../src/infra/db/repositorio-prisma.js';
import { BuscadorCandidatosFijo } from '../../src/infra/externos/buscador-fijo.js';
import { RelojFalso } from '../soporte/memoria.js';
import { URL_BD_TEST } from '../soporte/preparar-bd.js';
import { clave, CON_METRICAS, configTest, DESTINO, ORIGEN } from '../soporte/sistema-postgres.js';
import { crearEmisorTokens } from '../soporte/tokens.js';

const prisma = crearPrisma(URL_BD_TEST, 5);
const repo = new RepositorioDespachoPrisma(prisma);
const buscador = new BuscadorCandidatosFijo([]);
let reloj: RelojFalso;
let sistema: Sistema;
let auth: Awaited<ReturnType<typeof crearEmisorTokens>>['auth'];

beforeAll(async () => {
  const tokens = await crearEmisorTokens();
  auth = tokens.auth;
  reloj = new RelojFalso();
  sistema = componer(configTest(), crearLogger('dispatch-test', 'silent'), {
    verificador: tokens.verificador,
    buscador,
    reloj,
    repo,
  });
});
afterAll(async () => {
  await sistema.cerrar();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE outbox, driver_active_assignment, offers, payments, ride_requests');
});

const valor = (texto: string, linea: RegExp) => Number(linea.exec(texto)?.[1]);

describe('creadaEn y tiempo hasta la asignación con Postgres', () => {
  it('created_at se escribe con el reloj del dominio y se recupera en la lectura y en el SELECT … FOR UPDATE', async () => {
    const chofer = randomUUID();
    buscador.choferes = [chofer];
    const inicio = reloj.ahora();

    const creada = await request(sistema.app)
      .post('/solicitudes').set(clave())
      .set(await auth(randomUUID(), 'pasajero'))
      .send({ origen: ORIGEN, destino: DESTINO });
    expect(creada.status).toBe(201);
    // Interno: no sale en la respuesta.
    expect(creada.body).not.toHaveProperty('creadaEn');

    const [fila] = await prisma.$queryRaw<{ created_at: Date }[]>`
      SELECT created_at FROM ride_requests WHERE id = ${creada.body.id}::uuid`;
    expect(fila?.created_at).toEqual(inicio);

    expect((await repo.obtenerSolicitud(creada.body.id))?.creadaEn).toEqual(inicio);
    const bloqueada = await repo.enTransaccion((tx) => tx.obtenerSolicitudParaActualizar(creada.body.id));
    expect(bloqueada?.creadaEn).toEqual(inicio);
  });

  it('aceptar una oferta conocida registra el tiempo desde la solicitud hasta el COMMIT', async () => {
    const chofer = randomUUID();
    const pasajero = randomUUID();
    buscador.choferes = [chofer];

    const creada = await request(sistema.app)
      .post('/solicitudes').set(clave())
      .set(await auth(pasajero, 'pasajero'))
      .send({ origen: ORIGEN, destino: DESTINO })
      .expect(201);
    // La oferta se lee de la base: es la del chofer que devolvió el buscador.
    const oferta = await prisma.oferta.findFirstOrThrow({ where: { solicitudId: creada.body.id, choferId: chofer } });

    const antes = (await request(sistema.app).get('/metrics').set(CON_METRICAS)).text;
    const n0 = valor(antes, /^dispatch_tiempo_hasta_asignacion_seconds_count\{[^}]*\} (\S+)$/m);
    const suma0 = valor(antes, /^dispatch_tiempo_hasta_asignacion_seconds_sum\{[^}]*\} (\S+)$/m);

    reloj.avanzar(2500);
    const aceptada = await request(sistema.app).post(`/ofertas/${oferta.id}/aceptar`).set(clave()).set(await auth(chofer, 'chofer')).send({});
    expect(aceptada.status).toBe(200);
    expect(aceptada.body).toMatchObject({ estado: 'ASIGNADO', choferId: chofer });
    expect(aceptada.body).not.toHaveProperty('creadaEn');

    const despues = (await request(sistema.app).get('/metrics').set(CON_METRICAS)).text;
    expect(valor(despues, /^dispatch_tiempo_hasta_asignacion_seconds_count\{[^}]*\} (\S+)$/m)).toBe(n0 + 1);
    expect(valor(despues, /^dispatch_tiempo_hasta_asignacion_seconds_sum\{[^}]*\} (\S+)$/m) - suma0).toBeCloseTo(2.5, 6);
    expect(
      valor(despues, /^dispatch_tiempo_hasta_asignacion_seconds_bucket\{le="2",[^}]*\} (\S+)$/m) -
        valor(antes, /^dispatch_tiempo_hasta_asignacion_seconds_bucket\{le="2",[^}]*\} (\S+)$/m),
    ).toBe(0);
    expect(
      valor(despues, /^dispatch_tiempo_hasta_asignacion_seconds_bucket\{le="5",[^}]*\} (\S+)$/m) -
        valor(antes, /^dispatch_tiempo_hasta_asignacion_seconds_bucket\{le="5",[^}]*\} (\S+)$/m),
    ).toBe(1);

    const vista = await request(sistema.app).get(`/solicitudes/${creada.body.id}`).set(await auth(pasajero, 'pasajero'));
    expect(vista.status).toBe(200);
    expect(vista.body).not.toHaveProperty('creadaEn');
  });
});
