import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clave, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';

/**
 * Doble cobro, contra Postgres real. Veinte pedidos de cobro del mismo viaje a la vez (cada uno con
 * su propia Idempotency-Key: son reintentos distintos, no el mismo) más el barrido. Dos garantías:
 * - el proveedor recibe siempre la misma clave (el id del cobro), así que cobra una sola vez;
 * - el resultado se registra con el cobro bloqueado (FOR UPDATE) y solo si sigue PENDIENTE: un solo
 *   PaymentCaptured.
 * Comprobado sacando cada una: los dos tests fallan.
 */
let d: Awaited<ReturnType<typeof levantarDispatch>>;

beforeAll(async () => {
  d = await levantarDispatch();
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
  d.pagos.cobrados.clear();
  d.pagos.llamadas.length = 0;
});

/** Ver asignacion-unica.test.ts: sin conexiones abiertas de antemano, no hay carrera real. */
const abrirConexiones = (n: number) =>
  Promise.all(Array.from({ length: n }, () => d.prisma.$queryRaw`SELECT 1 AS ok FROM pg_sleep(0.05)`));

async function viajeCompletado() {
  const pasajero = randomUUID();
  const chofer = randomUUID();
  d.buscador.choferes = [chofer];
  const comoChofer = await d.auth(chofer, 'chofer');
  const comoPasajero = await d.auth(pasajero, 'pasajero');
  const creada = await request(d.url).post('/solicitudes').set(clave()).set(comoPasajero).send({ origen: ORIGEN, destino: DESTINO });
  const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId: creada.body.id } });
  await request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(clave()).set(comoChofer).send({}).expect(200);
  for (const accion of ['en-camino', 'iniciar', 'finalizar']) {
    await request(d.url).post(`/solicitudes/${creada.body.id}/${accion}`).set(clave()).set(comoChofer).send({}).expect(200);
  }
  return { id: creada.body.id as string, comoPasajero };
}

describe('cobro sin duplicar', () => {
  it('20 pedidos de cobro y el barrido a la vez: el proveedor cobra una vez y hay un solo PaymentCaptured', async () => {
    const { id, comoPasajero } = await viajeCompletado();
    // El proveedor tarda: todos llegan a esperarlo a la vez y vuelven juntos a registrar el resultado.
    d.pagos.modo = { demoraMs: 50 };
    await abrirConexiones(21);
    const [respuestas] = await Promise.all([
      Promise.all(
        Array.from({ length: 20 }, () => request(d.url).post(`/solicitudes/${id}/cobrar`).set(clave()).set(comoPasajero).send({})),
      ),
      d.casos.cobrarPendientes(),
    ]);

    expect(respuestas.map((r) => r.status)).toEqual(Array(20).fill(200));
    expect(new Set(respuestas.map((r) => r.body.estado))).toEqual(new Set(['APROBADO']));
    expect(new Set(respuestas.map((r) => r.body.referencia)).size).toBe(1);

    // El proveedor: muchas llamadas, todas con la misma clave, un solo cobro de verdad.
    expect(new Set(d.pagos.llamadas.map((l) => l.clave)).size).toBe(1);
    expect(d.pagos.cobrados.size).toBe(1);
    expect(await d.prisma.eventoOutbox.count({ where: { tipo: 'PaymentCaptured' } })).toBe(1);
    expect(await d.prisma.cobro.findUniqueOrThrow({ where: { solicitudId: id } })).toMatchObject({ estado: 'APROBADO' });
  });

  it('20 finalizaciones simultáneas: un solo cobro', async () => {
    const pasajero = randomUUID();
    const chofer = randomUUID();
    d.buscador.choferes = [chofer];
    const comoChofer = await d.auth(chofer, 'chofer');
    const creada = await request(d.url)
      .post('/solicitudes')
      .set(clave())
      .set(await d.auth(pasajero, 'pasajero'))
      .send({ origen: ORIGEN, destino: DESTINO });
    const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId: creada.body.id } });
    await request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(clave()).set(comoChofer).send({}).expect(200);
    for (const accion of ['en-camino', 'iniciar']) {
      await request(d.url).post(`/solicitudes/${creada.body.id}/${accion}`).set(clave()).set(comoChofer).send({}).expect(200);
    }
    await abrirConexiones(20);
    const respuestas = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(d.url).post(`/solicitudes/${creada.body.id}/finalizar`).set(clave()).set(comoChofer).send({}),
      ),
    );
    expect(respuestas.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await d.prisma.cobro.count({ where: { solicitudId: creada.body.id } })).toBe(1);
  });
});
