import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { purgarIdempotenciaPrisma } from '../../src/infra/db/idempotencia-prisma.js';
import { clave, DESTINO, levantarDispatch, ORIGEN } from '../soporte/sistema-postgres.js';

/** La purga de `idempotency_keys`, contra Postgres. Retención por defecto: 24 h. */
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

const HORA = 3_600_000;

/** `cantidad` registros creados hace `horas`. */
async function registros(cantidad: number, horas: number) {
  for (let i = 0; i < cantidad; i++) {
    await d.prisma.$executeRaw`
      INSERT INTO idempotency_keys (scope, key, request_hash, status_code, response, created_at)
      VALUES ('test', ${randomUUID()}, ${'0'.repeat(64)}, 200, '{}'::json, now() - ${horas}::float8 * interval '1 hour')`;
  }
}
const quedan = () => d.prisma.registroIdempotencia.count();

describe('purga de las claves de idempotencia', () => {
  it('borra solo lo más viejo que la retención', async () => {
    await registros(3, 25);
    await registros(2, 23);
    await registros(1, 0);
    expect(await d.purgarIdempotencia()).toBe(3);
    expect(await quedan()).toBe(3);
    // Una segunda pasada no encuentra nada.
    expect(await d.purgarIdempotencia()).toBe(0);
  });

  it('por lotes: sigue hasta que no queda nada, con un tope de lotes por pasada', async () => {
    await registros(7, 30);
    expect(await purgarIdempotenciaPrisma(d.prisma, { retencionMs: 24 * HORA, lote: 3 })()).toBe(7);

    await registros(7, 30);
    const corta = purgarIdempotenciaPrisma(d.prisma, { retencionMs: 24 * HORA, lote: 3, maxLotes: 2 });
    expect(await corta()).toBe(6);
    expect(await corta()).toBe(1);
  });

  it('varias instancias a la vez borran cada registro una vez, sin errores', async () => {
    await registros(60, 30);
    const purga = purgarIdempotenciaPrisma(d.prisma, { retencionMs: 24 * HORA, lote: 5 });
    const borrados = await Promise.all(Array.from({ length: 4 }, () => purga()));
    expect(borrados.reduce((a, b) => a + b, 0)).toBe(60);
    expect(await quedan()).toBe(0);
  });

  it('una clave dentro de la retención sigue reponiendo la respuesta; vencida y purgada, ya no', async () => {
    const pasajero = await d.auth(randomUUID(), 'pasajero');
    const encabezados = clave();
    d.buscador.choferes = [randomUUID()];
    const pedir = () =>
      request(d.url).post('/solicitudes').set(encabezados).set(pasajero).send({ origen: ORIGEN, destino: DESTINO });
    expect((await pedir()).status).toBe(201);

    await d.purgarIdempotencia();
    const repetido = await pedir();
    expect(repetido.status).toBe(201);
    expect(repetido.headers['idempotent-replayed']).toBe('true');

    await d.prisma.$executeRaw`UPDATE idempotency_keys SET created_at = now() - interval '25 hours'`;
    expect(await d.purgarIdempotencia()).toBe(1);
    // Pasada la retención, la clave ya no protege: el pedido se procesa de nuevo (y choca con la solicitud activa).
    const otraVez = await pedir();
    expect(otraVez.headers['idempotent-replayed']).toBeUndefined();
    expect(otraVez.status).toBe(409);
  });
});
