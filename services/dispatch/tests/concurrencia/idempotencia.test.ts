import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clave, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';

/**
 * Deduplicación (PLAN 5.1): veinte pedidos iguales en simultáneo, con la misma Idempotency-Key.
 * Uno se procesa; el resto recibe 409 «en curso» (llegó mientras el primero estaba en vuelo)
 * o la respuesta guardada (llegó después). Ninguno llega al caso de uso.
 * Comprobado sacando el cerrojo de Redis: fallan los dos tests.
 */
let d: Awaited<ReturnType<typeof levantarDispatch>>;

beforeAll(async () => {
  // La demora mantiene al primero en vuelo mientras llegan los demás (ver tests/soporte/demora.ts).
  d = await levantarDispatch({ demoraTrasLeerMs: 100 });
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiar();
});

/** Ver asignacion-unica.test.ts: sin conexiones abiertas de antemano, no hay carrera real. */
const abrirConexiones = (n: number) =>
  Promise.all(Array.from({ length: n }, () => d.prisma.$queryRaw`SELECT 1 AS ok FROM pg_sleep(0.05)`));

type Respuesta = request.Response;

/** Cada respuesta es el original, un reintento con la respuesta guardada o un 409 por estar en curso. */
function clasificar(respuestas: Respuesta[], estadoOk: number) {
  const procesadas = respuestas.filter((r) => r.status === estadoOk && !r.headers['idempotent-replayed']);
  const repetidas = respuestas.filter((r) => r.status === estadoOk && r.headers['idempotent-replayed'] === 'true');
  const enCurso = respuestas.filter((r) => r.status === 409 && r.body.error.code === 'CLAVE_IDEMPOTENCIA_EN_CURSO');
  return { procesadas, repetidas, enCurso, otras: respuestas.length - procesadas.length - repetidas.length - enCurso.length };
}

describe('deduplicación con Idempotency-Key', () => {
  it('20 pedidos iguales para crear la solicitud: uno se procesa y el resto se descarta', async () => {
    d.buscador.choferes = [randomUUID()];
    const busquedas = vi.spyOn(d.buscador, 'buscar');
    const auth = await d.auth(randomUUID(), 'pasajero');
    const encabezados = clave();
    await abrirConexiones(20);
    const respuestas = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(d.url).post('/solicitudes').set(encabezados).set(auth).send({ origen: ORIGEN, destino: DESTINO }),
      ),
    );

    const { procesadas, repetidas, otras } = clasificar(respuestas, 201);
    expect(procesadas).toHaveLength(1);
    expect(otras).toBe(0); // ninguno llegó al dominio (sería 409 SOLICITUD_ACTIVA_EXISTENTE)
    for (const r of repetidas) expect(r.text).toBe(procesadas[0]!.text);
    // Lo que el cerrojo agrega: los duplicados no llegan al caso de uso, así que no repiten lo que pasa
    // fuera de la base (acá, la búsqueda en location; en el cobro, la llamada al proveedor de pagos).
    // Sin el cerrojo, la clave primaria igual impide la segunda solicitud, pero recién al confirmar.
    expect(busquedas).toHaveBeenCalledTimes(1);
    busquedas.mockRestore();

    expect(await d.prisma.solicitudViaje.count()).toBe(1);
    expect(await d.prisma.eventoOutbox.count({ where: { tipo: 'RideRequested' } })).toBe(1);
    expect(await d.prisma.registroIdempotencia.count()).toBe(1);
  });

  it('20 reintentos simultáneos de finalizar: un solo RideCompleted y ningún 409 del dominio', async () => {
    const chofer = randomUUID();
    d.buscador.choferes = [chofer];
    const creada = await request(d.url)
      .post('/solicitudes')
      .set(clave())
      .set(await d.auth(randomUUID(), 'pasajero'))
      .send({ origen: ORIGEN, destino: DESTINO });
    const oferta = await d.prisma.oferta.findFirstOrThrow({ where: { solicitudId: creada.body.id } });
    const comoChofer = await d.auth(chofer, 'chofer');
    await request(d.url).post(`/ofertas/${oferta.id}/aceptar`).set(clave()).set(comoChofer).send({}).expect(200);
    for (const accion of ['en-camino', 'iniciar']) {
      await request(d.url).post(`/solicitudes/${creada.body.id}/${accion}`).set(clave()).set(comoChofer).send({}).expect(200);
    }

    // La misma finalización, reintentada 20 veces a la vez (por ejemplo, la app sin señal).
    const encabezados = clave();
    await abrirConexiones(20);
    const respuestas = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(d.url).post(`/solicitudes/${creada.body.id}/finalizar`).set(encabezados).set(comoChofer).send({}),
      ),
    );

    const { procesadas, enCurso, otras } = clasificar(respuestas, 200);
    expect(procesadas).toHaveLength(1);
    // Con la demora de 100 ms, los demás llegan con el primero en vuelo: el cerrojo los frena.
    expect(enCurso.length).toBeGreaterThan(0);
    // Sin el cerrojo entrarían al caso de uso y el FOR UPDATE los frenaría con 409 TRANSICION_INVALIDA.
    expect(otras).toBe(0);
    expect(await d.prisma.eventoOutbox.count({ where: { tipo: 'RideCompleted' } })).toBe(1);
  });
});
