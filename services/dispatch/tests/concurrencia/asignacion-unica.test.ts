import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clave, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';

/**
 * Problema 6.3 contra Postgres real. En memoria esto no prueba nada: lo que garantiza
 * la asignación única es el FOR UPDATE y la restricción única de la base.
 */
let d: Awaited<ReturnType<typeof levantarDispatch>>;

beforeAll(async () => {
  // Ver tests/soporte/demora.ts: sin la demora, la carrera casi nunca se da y el test no prueba nada.
  d = await levantarDispatch({ demoraTrasLeerMs: 15 });
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
});

async function crearSolicitud(pasajeroId: string, choferes: string[]) {
  d.buscador.choferes = choferes;
  const res = await request(d.url)
    .post('/solicitudes').set(clave())
    .set(await d.auth(pasajeroId, 'pasajero'))
    .send({ origen: ORIGEN, destino: DESTINO });
  expect(res.status).toBe(201);
  const ofertas = await d.prisma.oferta.findMany({ where: { solicitudId: res.body.id } });
  return { solicitudId: res.body.id as string, ofertas };
}

async function aceptar(ofertaId: string, choferId: string) {
  return request(d.url).post(`/ofertas/${ofertaId}/aceptar`).set(clave()).set(await d.auth(choferId, 'chofer')).send({});
}

async function cancelar(solicitudId: string, pasajeroId: string) {
  return request(d.url).post(`/solicitudes/${solicitudId}/cancelar`).set(clave()).set(await d.auth(pasajeroId, 'pasajero')).send({});
}

describe('asignación única (6.3)', () => {
  it('50 choferes aceptan la misma solicitud a la vez: exactamente 1×200 y 49×409', async () => {
    const choferes = Array.from({ length: 50 }, () => randomUUID());
    const { solicitudId, ofertas } = await crearSolicitud(randomUUID(), choferes);
    expect(ofertas).toHaveLength(50);

    // Los tokens se firman antes, para que los 50 pedidos salgan juntos.
    const encabezados = await Promise.all(ofertas.map((o) => d.auth(o.choferId, 'chofer')));
    const respuestas = await Promise.all(
      ofertas.map((o, i) => request(d.url).post(`/ofertas/${o.id}/aceptar`).set(clave()).set(encabezados[i]!).send({})),
    );

    const ok = respuestas.filter((r) => r.status === 200);
    const conflictos = respuestas.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflictos).toHaveLength(49);
    expect(new Set(conflictos.map((r) => r.body.error.code))).toEqual(new Set(['SOLICITUD_NO_DISPONIBLE']));

    // Y la base lo confirma, no solo las respuestas.
    const ganador = ok[0]!.body.choferId as string;
    const solicitud = await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: solicitudId } });
    expect(solicitud).toMatchObject({ estado: 'ASIGNADO', choferId: ganador });
    expect(await d.prisma.asignacionActiva.findMany()).toEqual([
      expect.objectContaining({ choferId: ganador, solicitudId }),
    ]);
    const estados = await d.prisma.oferta.groupBy({ by: ['estado'], where: { solicitudId }, _count: true });
    expect(Object.fromEntries(estados.map((e) => [e.estado, e._count]))).toEqual({ ACEPTADA: 1, CANCELADA: 49 });
    expect(await d.prisma.eventoOutbox.count({ where: { tipo: 'TripAssigned' } })).toBe(1);
  });

  it('un chofer acepta dos solicitudes distintas a la vez: una sola gana (20 repeticiones)', async () => {
    for (let i = 0; i < 20; i++) {
      const chofer = randomUUID();
      const a = await crearSolicitud(randomUUID(), [chofer]);
      const b = await crearSolicitud(randomUUID(), [chofer]);

      const [ra, rb] = await Promise.all([aceptar(a.ofertas[0]!.id, chofer), aceptar(b.ofertas[0]!.id, chofer)]);
      const estados = [ra.status, rb.status].sort();
      expect(estados).toEqual([200, 409]);
      const perdedora = ra.status === 409 ? ra : rb;
      expect(perdedora.body.error.code).toBe('CHOFER_CON_VIAJE_ACTIVO');

      expect(await d.prisma.asignacionActiva.count({ where: { choferId: chofer } })).toBe(1);
      // La perdedora quedó intacta: el rollback no dejó nada a medias.
      const idPerdedora = ra.status === 409 ? a.solicitudId : b.solicitudId;
      const sPerdedora = await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: idPerdedora } });
      expect(sPerdedora).toMatchObject({ estado: 'BUSCANDO', choferId: null });
    }
  });

  it('cancelar contra aceptar a la vez: siempre termina cancelada y sin chofer bloqueado (20 repeticiones)', async () => {
    const resultados = { ganoCancelacion: 0, ganoAceptacion: 0 };

    for (let i = 0; i < 20; i++) {
      const pasajero = randomUUID();
      const chofer = randomUUID();
      const { solicitudId, ofertas } = await crearSolicitud(pasajero, [chofer]);

      const [rCancelar, rAceptar] = await Promise.all([cancelar(solicitudId, pasajero), aceptar(ofertas[0]!.id, chofer)]);

      expect(rCancelar.status).toBe(200);
      expect([200, 409]).toContain(rAceptar.status);

      const s = await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: solicitudId } });
      expect(s.estado).toBe('CANCELADO_PASAJERO');
      expect(await d.prisma.asignacionActiva.count({ where: { solicitudId } })).toBe(0);

      const cancelado = await d.prisma.eventoOutbox.findFirstOrThrow({
        where: { tipo: 'RideCancelled', payload: { path: ['solicitudId'], equals: solicitudId } },
      });
      const asignados = await d.prisma.eventoOutbox.count({
        where: { tipo: 'TripAssigned', payload: { path: ['solicitudId'], equals: solicitudId } },
      });
      if (rAceptar.status === 200) {
        // (b) ganó la aceptación: la cancelación canceló un viaje asignado y liberó al chofer.
        resultados.ganoAceptacion++;
        expect(asignados).toBe(1);
        expect(cancelado.payload).toMatchObject({ estabaAsignada: true, choferId: chofer });
      } else {
        // (a) ganó la cancelación: la aceptación encontró la solicitud cancelada.
        resultados.ganoCancelacion++;
        expect(rAceptar.body.error.code).toBe('SOLICITUD_NO_DISPONIBLE');
        expect(asignados).toBe(0);
        expect(cancelado.payload).toMatchObject({ estabaAsignada: false });
      }
    }
    expect(resultados.ganoAceptacion + resultados.ganoCancelacion).toBe(20);
  });

  it('un pasajero que pide 10 viajes a la vez obtiene uno solo', async () => {
    const pasajero = randomUUID();
    d.buscador.choferes = [randomUUID()];
    const encabezado = await d.auth(pasajero, 'pasajero');
    const respuestas = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(d.url).post('/solicitudes').set(clave()).set(encabezado).send({ origen: ORIGEN, destino: DESTINO }),
      ),
    );
    expect(respuestas.filter((r) => r.status === 201)).toHaveLength(1);
    const rechazos = respuestas.filter((r) => r.status === 409);
    expect(rechazos).toHaveLength(9);
    expect(rechazos.every((r) => r.body.error.code === 'SOLICITUD_ACTIVA_EXISTENTE')).toBe(true);
    expect(await d.prisma.solicitudViaje.count({ where: { pasajeroId: pasajero } })).toBe(1);
  });
});

describe('ciclo del viaje bajo concurrencia', () => {
  /** Viaje aceptado y llevado hasta EN_CURSO por su chofer. */
  async function viajeEnCurso() {
    const pasajero = randomUUID();
    const chofer = randomUUID();
    const { solicitudId, ofertas } = await crearSolicitud(pasajero, [chofer]);
    expect((await aceptar(ofertas[0]!.id, chofer)).status).toBe(200);
    const comoChofer = await d.auth(chofer, 'chofer');
    for (const accion of ['en-camino', 'iniciar']) {
      expect((await request(d.url).post(`/solicitudes/${solicitudId}/${accion}`).set(clave()).set(comoChofer).send({})).status).toBe(200);
    }
    return { solicitudId, chofer, comoChofer };
  }

  const eventosDe = (tipo: string, solicitudId: string) =>
    d.prisma.eventoOutbox.count({ where: { tipo, payload: { path: ['solicitudId'], equals: solicitudId } } });

  /**
   * Deja `n` conexiones del pool de Postgres abiertas para que las transacciones simultáneas
   * arranquen juntas. Sin esto, la primera toma la conexión libre que dejó el paso anterior y
   * termina antes de que las demás terminen de abrir la suya (abrir una tarda decenas de ms):
   * no hay carrera y el test pasaría aunque faltara el FOR UPDATE (lo comprobamos sacándolo).
   * El pg_sleep obliga a que las `n` consultas estén abiertas a la vez, cada una en su conexión.
   */
  const abrirConexiones = (n: number) =>
    Promise.all(Array.from({ length: n }, () => d.prisma.$queryRaw`SELECT 1 AS ok FROM pg_sleep(0.05)`));

  it('20 finalizaciones simultáneas del mismo viaje: 1×200 y 19×409, un solo RideCompleted', async () => {
    const { solicitudId, comoChofer } = await viajeEnCurso();
    await abrirConexiones(20);
    const respuestas = await Promise.all(
      Array.from({ length: 20 }, () => request(d.url).post(`/solicitudes/${solicitudId}/finalizar`).set(clave()).set(comoChofer).send({})),
    );
    expect(respuestas.filter((r) => r.status === 200)).toHaveLength(1);
    const conflictos = respuestas.filter((r) => r.status === 409);
    expect(conflictos).toHaveLength(19);
    expect(new Set(conflictos.map((r) => r.body.error.code))).toEqual(new Set(['TRANSICION_INVALIDA']));

    expect(await eventosDe('RideCompleted', solicitudId)).toBe(1);
    expect(await d.prisma.asignacionActiva.count()).toBe(0);
  });

  it('finalizar contra la cancelación del operador: gana uno solo y el chofer queda libre (20 repeticiones)', async () => {
    const operador = await d.auth(randomUUID(), 'operador');
    const ganadores = { finalizar: 0, cancelar: 0 };

    for (let i = 0; i < 20; i++) {
      const { solicitudId, comoChofer } = await viajeEnCurso();
      await abrirConexiones(2);
      const [rFin, rCancel] = await Promise.all([
        request(d.url).post(`/solicitudes/${solicitudId}/finalizar`).set(clave()).set(comoChofer).send({}),
        request(d.url).post(`/solicitudes/${solicitudId}/cancelar`).set(clave()).set(operador).send({ motivo: 'reclamo del pasajero' }),
      ]);
      expect([rFin.status, rCancel.status].sort()).toEqual([200, 409]);

      const s = await d.prisma.solicitudViaje.findUniqueOrThrow({ where: { id: solicitudId } });
      const completados = await eventosDe('RideCompleted', solicitudId);
      const cancelados = await eventosDe('RideCancelled', solicitudId);
      if (rFin.status === 200) {
        ganadores.finalizar++;
        expect(s.estado).toBe('COMPLETADA');
        expect(rCancel.body.error.code).toBe('SOLICITUD_NO_CANCELABLE');
        expect([completados, cancelados]).toEqual([1, 0]);
      } else {
        ganadores.cancelar++;
        expect(s.estado).toBe('CANCELADO_OPERADOR');
        expect(rFin.body.error.code).toBe('TRANSICION_INVALIDA');
        expect([completados, cancelados]).toEqual([0, 1]);
      }
      expect(await d.prisma.asignacionActiva.count({ where: { solicitudId } })).toBe(0);
    }
    expect(ganadores.finalizar + ganadores.cancelar).toBe(20);
  });
});
