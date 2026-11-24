import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clave, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';

/**
 * ADR 0012, filas 6 y 13: la cancelación del operador contra una aceptación, dos (o tres)
 * cancelaciones simultáneas del mismo viaje y «en camino» contra la cancelación del pasajero.
 *
 * Lo que lo hace pasar: todos estos casos de uso toman el MISMO `FOR UPDATE` de la solicitud
 * (`obtenerSolicitudParaActualizar`), así que se ejecutan de a uno; el segundo ve el estado nuevo y la
 * entidad rechaza la transición (409). Si gana la aceptación, la cancelación libera al chofer en su
 * misma transacción. Sin el lock, las dos transacciones leen el mismo estado y la última escritura pisa
 * a la primera (dos RideCancelled, o un viaje EN_CAMINO sin chofer reservado).
 *
 * La demora con la solicitud bloqueada y `abrirConexiones` (como en asignacion-unica.test.ts) hacen que
 * las transacciones arranquen juntas de verdad.
 */
let d: Awaited<ReturnType<typeof levantarDispatch>>;

beforeAll(async () => {
  d = await levantarDispatch({ demoraTrasLeerMs: 15 });
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
});

const REPETICIONES = 20;
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function crearSolicitud(pasajero: string, chofer: string) {
  d.buscador.choferes = [chofer];
  const res = await request(d.url)
    .post('/solicitudes')
    .set(clave())
    .set(await d.auth(pasajero, 'pasajero'))
    .send({ origen: ORIGEN, destino: DESTINO });
  expect(res.status).toBe(201);
  const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId: res.body.id } });
  return { solicitudId: res.body.id as string, ofertaId: oferta.id };
}

/** Una solicitud ya aceptada (ASIGNADO), con su pasajero, su chofer y sus tokens. */
async function viajeAsignado() {
  const pasajero = randomUUID();
  const chofer = randomUUID();
  const { solicitudId, ofertaId } = await crearSolicitud(pasajero, chofer);
  const comoChofer = await d.auth(chofer, 'chofer');
  expect((await request(d.url).post(`/ofertas/${ofertaId}/aceptar`).set(clave()).set(comoChofer).send({})).status).toBe(200);
  return { solicitudId, pasajero, chofer, comoChofer, comoPasajero: await d.auth(pasajero, 'pasajero') };
}

const cancelar = (solicitudId: string, encabezado: Record<string, string>, motivo?: string) =>
  request(d.url)
    .post(`/solicitudes/${solicitudId}/cancelar`)
    .set(clave())
    .set(encabezado)
    .send(motivo ? { motivo } : {});

const eventos = (tipo: string, solicitudId: string) =>
  d.prisma.eventoOutbox.count({ where: { tipo, payload: { path: ['solicitudId'], equals: solicitudId } } });

/** Ver asignacion-unica.test.ts: deja `n` conexiones del pool abiertas para que las transacciones arranquen juntas. */
const abrirConexiones = (n: number) =>
  Promise.all(Array.from({ length: n }, () => d.prisma.$queryRaw`SELECT 1 AS ok FROM pg_sleep(0.05)`));

describe('aceptar contra la cancelación del operador (fila 6)', () => {
  it(`siempre termina CANCELADO_OPERADOR y sin chofer bloqueado (${REPETICIONES} repeticiones)`, async () => {
    const operador = await d.auth(randomUUID(), 'operador');
    const ganadores = { aceptacion: 0, cancelacion: 0 };

    for (let i = 0; i < REPETICIONES; i++) {
      const chofer = randomUUID();
      const { solicitudId, ofertaId } = await crearSolicitud(randomUUID(), chofer);
      const comoChofer = await d.auth(chofer, 'chofer');
      await abrirConexiones(2);

      const [rCancelar, rAceptar] = await Promise.all([
        cancelar(solicitudId, operador, 'el pasajero llamó para cancelar'),
        request(d.url).post(`/ofertas/${ofertaId}/aceptar`).set(clave()).set(comoChofer).send({}),
      ]);

      // La cancelación del operador siempre puede (BUSCANDO o ASIGNADO): nunca pierde.
      expect(rCancelar.status).toBe(200);
      expect([200, 409]).toContain(rAceptar.status);

      const s = await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: solicitudId } });
      expect(s.estado).toBe('CANCELADO_OPERADOR');
      // El chofer nunca queda reservado por un viaje cancelado.
      expect(await d.prisma.asignacionActiva.count({ where: { choferId: chofer } })).toBe(0);
      expect(await eventos('RideCancelled', solicitudId)).toBe(1);
      const oferta = await d.prisma.oferta.findUniqueOrThrow({ where: { id: ofertaId } });

      if (rAceptar.status === 200) {
        // Ganó la aceptación: la cancelación canceló un viaje asignado y liberó al chofer.
        ganadores.aceptacion++;
        expect(await eventos('TripAssigned', solicitudId)).toBe(1);
        expect(oferta.estado).toBe('ACEPTADA');
      } else {
        // Ganó la cancelación: la aceptación encontró la solicitud cancelada y su oferta, cancelada.
        ganadores.cancelacion++;
        expect(rAceptar.body.error.code).toBe('SOLICITUD_NO_DISPONIBLE');
        expect(await eventos('TripAssigned', solicitudId)).toBe(0);
        expect(oferta.estado).toBe('CANCELADA');
      }
    }
    expect(ganadores.aceptacion + ganadores.cancelacion).toBe(REPETICIONES);
  });
});

describe('dos acciones sobre el mismo viaje (fila 13)', () => {
  it(`pasajero, chofer y operador cancelan a la vez un viaje asignado: gana uno solo (${REPETICIONES} repeticiones)`, async () => {
    const operador = await d.auth(randomUUID(), 'operador');
    const estadoDe = ['CANCELADO_PASAJERO', 'CANCELADO_CHOFER', 'CANCELADO_OPERADOR'];

    for (let i = 0; i < REPETICIONES; i++) {
      const { solicitudId, chofer, comoChofer, comoPasajero } = await viajeAsignado();
      await abrirConexiones(3);

      const respuestas = await Promise.all([
        cancelar(solicitudId, comoPasajero),
        cancelar(solicitudId, comoChofer, 'se rompió el auto'),
        cancelar(solicitudId, operador, 'reclamo'),
      ]);

      const ganadora = respuestas.findIndex((r) => r.status === 200);
      expect(respuestas.filter((r) => r.status === 200)).toHaveLength(1);
      const perdedoras = respuestas.filter((r) => r.status !== 200);
      expect(perdedoras.map((r) => r.status)).toEqual([409, 409]);
      for (const r of perdedoras) expect(r.body.error.code).toBe('SOLICITUD_NO_CANCELABLE');

      // En la base: el estado de quien ganó, un solo RideCancelled y el chofer libre.
      const s = await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: solicitudId } });
      expect(s.estado).toBe(estadoDe[ganadora]);
      expect(await eventos('RideCancelled', solicitudId)).toBe(1);
      expect(await d.prisma.asignacionActiva.count({ where: { choferId: chofer } })).toBe(0);
    }
  });

  it(`«en camino» contra la cancelación del pasajero: nunca queda EN_CAMINO sin chofer reservado (${REPETICIONES} repeticiones)`, async () => {
    const ganadores = { enCaminoPrimero: 0, cancelacionPrimero: 0 };

    for (let i = 0; i < REPETICIONES; i++) {
      const { solicitudId, chofer, comoChofer, comoPasajero } = await viajeAsignado();
      await abrirConexiones(2);

      // Se alternan: la mitad de las veces sale primero la cancelación y «en camino» unos ms después,
      // todavía dentro de la transacción de la otra. Sin el lock, en ese orden «en camino» lee ASIGNADO,
      // escribe después y deja el viaje EN_CAMINO con el chofer ya liberado.
      const enCamino = () => request(d.url).post(`/solicitudes/${solicitudId}/en-camino`).set(clave()).set(comoChofer).send({}).then((r) => r);
      const cancelacion = () => cancelar(solicitudId, comoPasajero).then((r) => r);
      const [antes, despues] = i % 2 === 0 ? [cancelacion, enCamino] : [enCamino, cancelacion];
      const pAntes = antes();
      await esperar(5);
      const [rAntes, rDespues] = await Promise.all([pAntes, despues()]);
      const [rEnCamino, rCancelar] = i % 2 === 0 ? [rDespues, rAntes] : [rAntes, rDespues];

      // El pasajero puede cancelar en ASIGNADO y en EN_CAMINO: la cancelación siempre gana al final.
      expect(rCancelar.status).toBe(200);
      const s = await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: solicitudId } });
      expect(s.estado).toBe('CANCELADO_PASAJERO');
      expect(await d.prisma.asignacionActiva.count({ where: { choferId: chofer } })).toBe(0);
      expect(await eventos('RideCancelled', solicitudId)).toBe(1);

      if (rEnCamino.status === 200) {
        // En camino confirmó primero; la cancelación lo vio EN_CAMINO.
        ganadores.enCaminoPrimero++;
        expect(rEnCamino.body.estado).toBe('EN_CAMINO');
        expect(await eventos('DriverEnRoute', solicitudId)).toBe(1);
      } else {
        // La cancelación confirmó primero; en camino vio CANCELADO_PASAJERO.
        ganadores.cancelacionPrimero++;
        expect(rEnCamino.status).toBe(409);
        expect(rEnCamino.body.error.code).toBe('TRANSICION_INVALIDA');
        expect(await eventos('DriverEnRoute', solicitudId)).toBe(0);
      }
    }
    expect(ganadores.enCaminoPrimero + ganadores.cancelacionPrimero).toBe(REPETICIONES);
  });
});
