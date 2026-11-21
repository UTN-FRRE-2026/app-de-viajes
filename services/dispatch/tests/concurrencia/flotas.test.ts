import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { preparadorFlotas } from '../soporte/flotas.js';
import { clave, levantarDispatch } from '../soporte/sistema-postgres.js';

/**
 * Carrera G contra Postgres real. En memoria esto no prueba nada: lo que garantiza el límite es el
 * UPDATE condicional de `fleets`, el CHECK `fleets_cupo_check` y el FOR UPDATE del chofer.
 * `trasBloquearChofer` demora cada transacción con el chofer ya bloqueado y antes de tocar la flota:
 * así las activaciones se superponen de verdad (ver docs/flotas.md, «Cómo se sabe que el test detecta
 * la falta de la protección»).
 */
let d: Awaited<ReturnType<typeof levantarDispatch>>;
let preparar: ReturnType<typeof preparadorFlotas>;

beforeAll(async () => {
  d = await levantarDispatch({ flotas: { trasBloquearChofer: () => new Promise((r) => setTimeout(r, 50)) } });
  preparar = preparadorFlotas(d.casosFlotas, d.directorio);
});
afterAll(async () => {
  await d.cerrar();
});
beforeEach(async () => {
  await d.limpiarFlotas();
});

const admin = randomUUID();

async function activar(flotaId: string, choferId: string, encabezados = clave()) {
  return request(d.url)
    .post(`/flota/choferes/${choferId}/activar`)
    .set(encabezados)
    .set(await d.authFlota(admin, flotaId))
    .send({});
}

async function desactivar(flotaId: string, choferId: string) {
  return request(d.url)
    .post(`/flota/choferes/${choferId}/desactivar`)
    .set(clave())
    .set(await d.authFlota(admin, flotaId))
    .send({});
}

/** Lo que dice Postgres, no la respuesta HTTP: el contador y los choferes activos de verdad. */
async function enPostgres(flotaId: string) {
  const [fila] = await d.prisma.$queryRaw<{ activos: bigint; contador: number; maximo: number }[]>`
    SELECT (SELECT count(*) FROM drivers WHERE fleet_id = ${flotaId}::uuid AND active) AS activos,
           active_count AS contador, max_active AS maximo
    FROM fleets WHERE id = ${flotaId}::uuid`;
  return { activos: Number(fila?.activos), contador: fila?.contador, maximo: fila?.maximo };
}

describe('carrera G: el límite de choferes activos por flota', () => {
  it('50 activaciones simultáneas de choferes distintos con límite 10: quedan exactamente 10 activos', async () => {
    const flota = await preparar.flota(10);
    const choferes = await preparar.choferes(flota.id, 50);

    const respuestas = await Promise.all(choferes.map((c) => activar(flota.id, c)));

    const ok = respuestas.filter((r) => r.status === 200);
    const llenos = respuestas.filter((r) => r.status === 409);
    expect(ok).toHaveLength(10);
    expect(llenos).toHaveLength(40);
    for (const r of llenos) expect(r.body.error.code).toBe('LIMITE_FLOTA_ALCANZADO');
    for (const r of ok) expect(r.body).toMatchObject({ activo: true, flotaId: flota.id });

    // En Postgres: 10 activos y el contador igual a 10.
    expect(await enPostgres(flota.id)).toEqual({ activos: 10, contador: 10, maximo: 10 });
    // Los que respondieron 200 son exactamente los activos.
    const activos = await d.prisma.choferFlota.findMany({ where: { flotaId: flota.id, activo: true }, select: { id: true } });
    expect(activos.map((c) => c.id).sort()).toEqual(ok.map((r) => r.body.id).sort());
    // Solo las activaciones que salieron bien registran su Idempotency-Key.
    expect(await d.prisma.registroIdempotencia.count()).toBe(10);
  });

  it('dos pedidos simultáneos para el mismo chofer, con claves distintas, ocupan un solo cupo', async () => {
    const flota = await preparar.flota(10);
    const [chofer] = await preparar.choferes(flota.id, 1);

    const [a, b] = await Promise.all([activar(flota.id, chofer!), activar(flota.id, chofer!)]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.activo && b.body.activo).toBe(true);
    expect(await enPostgres(flota.id)).toEqual({ activos: 1, contador: 1, maximo: 10 });
  });

  it('20 pedidos simultáneos con la misma clave: un solo efecto y una sola clave registrada', async () => {
    const flota = await preparar.flota(10);
    const [chofer] = await preparar.choferes(flota.id, 1);
    const encabezados = clave();

    const respuestas = await Promise.all(Array.from({ length: 20 }, () => activar(flota.id, chofer!, encabezados)));

    const codigos = respuestas.map((r) => r.status);
    expect(codigos.every((c) => c === 200 || c === 409)).toBe(true);
    expect(codigos.filter((c) => c === 200).length).toBeGreaterThanOrEqual(1);
    for (const r of respuestas.filter((x) => x.status === 409)) expect(r.body.error.code).toBe('CLAVE_IDEMPOTENCIA_EN_CURSO');
    expect(await enPostgres(flota.id)).toEqual({ activos: 1, contador: 1, maximo: 10 });
    expect(await d.prisma.registroIdempotencia.count()).toBe(1);
  });

  it('activaciones y desactivaciones mezcladas: el contador siempre coincide con los activos', async () => {
    const flota = await preparar.flota(5);
    const choferes = await preparar.choferes(flota.id, 12);
    // La mitad arranca activa, hasta el límite.
    for (const c of choferes.slice(0, 5)) expect((await activar(flota.id, c)).status).toBe(200);

    const operaciones = choferes.flatMap((c, i) => (i % 2 === 0 ? [desactivar(flota.id, c), activar(flota.id, c)] : [activar(flota.id, c)]));
    const respuestas = await Promise.all(operaciones);

    expect(respuestas.every((r) => r.status === 200 || (r.status === 409 && r.body.error.code === 'LIMITE_FLOTA_ALCANZADO'))).toBe(true);
    const estado = await enPostgres(flota.id);
    expect(estado.contador).toBe(estado.activos);
    expect(estado.activos).toBeLessThanOrEqual(5);
  });

  it('dos flotas a la vez: llenar la A no consume el cupo de la B', async () => {
    const [a, b] = [await preparar.flota(3), await preparar.flota(3)];
    const deA = await preparar.choferes(a.id, 10);
    const deB = await preparar.choferes(b.id, 2);

    const respuestas = await Promise.all([...deA.map((c) => activar(a.id, c)), ...deB.map((c) => activar(b.id, c))]);

    expect(respuestas.slice(10).map((r) => r.status)).toEqual([200, 200]);
    expect(await enPostgres(a.id)).toEqual({ activos: 3, contador: 3, maximo: 3 });
    expect(await enPostgres(b.id)).toEqual({ activos: 2, contador: 2, maximo: 3 });
  });
});
