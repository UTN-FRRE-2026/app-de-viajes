import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { relojPorContexto } from '../soporte/reloj.js';
import { clave, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';

/**
 * ADR 0012, filas 3 y 4: el barrido de ofertas vencidas contra una aceptación, y dos barridos (dos
 * réplicas) sobre la misma solicitud, contra Postgres real.
 *
 * Lo que lo hace pasar: el barrido toma el MISMO `FOR UPDATE` de la solicitud que la aceptación, y los
 * dos releen las ofertas después del lock; la tanda nueva sale solo si no queda ninguna vigente y si la
 * solicitud sigue BUSCANDO; `UNIQUE offers(request_id, driver_id)` es la segunda barrera.
 *
 * El barrido corre con `relojPorContexto`: ve una hora posterior al vencimiento, mientras la aceptación
 * (por HTTP) ve la hora real, con la oferta todavía vigente. Es la carrera de verdad: la aceptación llega
 * justo antes de vencer y el barrido de otra réplica justo después. La demora con la solicitud bloqueada
 * hace que las dos transacciones se superpongan.
 */
const DEMORA_MS = 300;
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tiempo = relojPorContexto();

let d: Awaited<ReturnType<typeof levantarDispatch>>;

beforeAll(async () => {
  d = await levantarDispatch({ demoraTrasLeerMs: DEMORA_MS, reloj: tiempo.reloj });
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
});

/** Una solicitud con una sola oferta, al chofer A. Después, el buscador devuelve también a B y C. */
async function solicitudConOferta() {
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  d.buscador.choferes = [a];
  const res = await request(d.url)
    .post('/solicitudes')
    .set(clave())
    .set(await d.auth(randomUUID(), 'pasajero'))
    .send({ origen: ORIGEN, destino: DESTINO });
  expect(res.status).toBe(201);
  const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId: res.body.id } });
  d.buscador.choferes = [a, b, c];
  // Un segundo después del vencimiento: para el barrido, la oferta de A ya venció.
  const vencida = new Date(oferta.venceEn.getTime() + 1000);
  return { solicitudId: res.body.id as string, oferta, choferes: { a, b, c }, vencida };
}

/** El barrido, como si corriera en otra réplica después del vencimiento. */
const barrerVencidas = (hora: Date) => tiempo.en(hora, () => d.casos.vencerOfertas());

/** Arranca `primero`, espera a que tenga la solicitud bloqueada y recién ahí arranca `segundo`. */
async function superponer<A, B>(primero: () => PromiseLike<A>, segundo: () => PromiseLike<B>) {
  // Promise.resolve llama a `then` enseguida: supertest no manda el pedido hasta que alguien lo espera.
  const p1 = Promise.resolve(primero());
  await esperar(DEMORA_MS / 2);
  const [r1, r2] = await Promise.all([p1, segundo()]);
  return { primero: r1, segundo: r2 };
}

const eventos = (tipo: string, solicitudId: string) =>
  d.prisma.eventoOutbox.count({ where: { tipo, payload: { path: ['solicitudId'], equals: solicitudId } } });

async function ofertasPorChofer(solicitudId: string) {
  const ofertas = await d.prisma.oferta.findMany({ where: { solicitudId } });
  return Object.fromEntries(ofertas.map((o) => [o.choferId, o.estado]));
}

describe('aceptar contra vencer (fila 3)', () => {
  // En este orden lo que decide es la relectura de las ofertas después del lock: con la oferta leída
  // antes (`previa`), la aceptación da 200 sobre una oferta ya vencida (comprobado). El FOR UPDATE lo
  // prueban el otro orden y los dos barridos.
  it('el barrido primero: la aceptación espera el lock, relee la oferta VENCIDA y da 409; queda la tanda nueva', async () => {
    const { solicitudId, oferta, choferes, vencida } = await solicitudConOferta();
    const comoA = await d.auth(choferes.a, 'chofer');

    const { primero, segundo } = await superponer(
      () => barrerVencidas(vencida),
      () => request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(clave()).set(comoA).send({}),
    );

    expect(primero).toBe(1);
    // Para el reloj de la aceptación la oferta seguía vigente: el 409 sale de releerla después del lock.
    expect(segundo.status).toBe(409);
    expect(segundo.body.error.code).toBe('OFERTA_VENCIDA');

    // En la base: sigue buscando, sin chofer, con la oferta de A vencida y la tanda nueva pendiente.
    expect(await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: solicitudId } })).toMatchObject({
      estado: 'BUSCANDO',
      choferId: null,
    });
    expect(await ofertasPorChofer(solicitudId)).toEqual({
      [choferes.a]: 'VENCIDA',
      [choferes.b]: 'PENDIENTE',
      [choferes.c]: 'PENDIENTE',
    });
    expect(await d.prisma.asignacionActiva.count()).toBe(0);
    expect(await eventos('OfferExpired', solicitudId)).toBe(1);
    expect(await eventos('TripAssigned', solicitudId)).toBe(0);
  });

  it('la aceptación primero: el barrido espera el lock, la ve ASIGNADO y no vence ni reofrece nada', async () => {
    const { solicitudId, oferta, choferes, vencida } = await solicitudConOferta();
    const comoA = await d.auth(choferes.a, 'chofer');

    const { primero, segundo } = await superponer(
      () => request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(clave()).set(comoA).send({}),
      () => barrerVencidas(vencida),
    );

    expect(primero.status).toBe(200);
    // El barrido encontró la solicitud con una oferta «vencida» (leyó antes del COMMIT) y esperó el lock.
    expect(segundo).toBe(1);

    expect(await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: solicitudId } })).toMatchObject({
      estado: 'ASIGNADO',
      choferId: choferes.a,
    });
    // Ni la oferta aceptada pasó a VENCIDA ni hay ofertas nuevas para una solicitud ya asignada.
    expect(await ofertasPorChofer(solicitudId)).toEqual({ [choferes.a]: 'ACEPTADA' });
    expect(await d.prisma.asignacionActiva.findMany()).toEqual([expect.objectContaining({ choferId: choferes.a, solicitudId })]);
    expect(await eventos('OfferExpired', solicitudId)).toBe(0);
    expect(await eventos('TripAssigned', solicitudId)).toBe(1);
  });
});

describe('dos barridos sobre la misma solicitud (fila 4)', () => {
  it('dos réplicas barren a la vez: un solo OfferExpired y una sola tanda nueva (5 repeticiones)', async () => {
    for (let i = 0; i < 5; i++) {
      await d.limpiar();
      const { solicitudId, choferes, vencida } = await solicitudConOferta();

      const resultados = await Promise.allSettled([barrerVencidas(vencida), barrerVencidas(vencida)]);

      // Ninguno falla: sin el lock, los dos crearían la tanda y el UNIQUE (request_id, driver_id) haría fallar a uno.
      expect(resultados.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await ofertasPorChofer(solicitudId)).toEqual({
        [choferes.a]: 'VENCIDA',
        [choferes.b]: 'PENDIENTE',
        [choferes.c]: 'PENDIENTE',
      });
      expect(await d.prisma.oferta.count({ where: { solicitudId } })).toBe(3);
      expect(await eventos('OfferExpired', solicitudId)).toBe(1);
      // La primera tanda (A) y la nueva (B y C): ninguna oferta creada dos veces.
      expect(await eventos('OfferCreated', solicitudId)).toBe(3);
      expect((await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: solicitudId } })).estado).toBe('BUSCANDO');
    }
  });
});
