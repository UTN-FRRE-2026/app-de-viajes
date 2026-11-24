import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { crearPrisma } from '../../src/infra/db/cliente.js';
import { RepositorioUbicacionesIngenuo } from '../../src/infra/db/repositorio-ingenuo.js';
import { purgarHistorial } from '../../src/infra/db/retencion.js';
import { URL_BD_TEST } from '../soporte/preparar-bd.js';

/** Retención del historial (`pings`) contra Postgres: borra solo lo vencido, en lotes. */
const prisma = crearPrisma(URL_BD_TEST, 5);

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE pings');
});
afterAll(async () => {
  await prisma.$disconnect();
});

const AHORA = new Date('2026-11-25T12:00:00.000Z');
const reloj = { ahora: () => AHORA };
const HORA = 3_600_000;
const RETENCION = 720 * HORA;
const OBELISCO = { lat: -34.6037, lng: -58.3816 };

/** Un ping con `recorded_at` a `msAtras` de AHORA, como lo escribe cualquiera de las dos estrategias. */
async function ping(choferId: string, msAtras: number, streamId: string | null = null) {
  const fila = await prisma.ping.create({
    data: { choferId, lat: OBELISCO.lat, lng: OBELISCO.lng, registradoEn: new Date(AHORA.getTime() - msAtras), streamId },
    select: { id: true },
  });
  return fila.id;
}

const restantes = async () =>
  (await prisma.ping.findMany({ select: { choferId: true, registradoEn: true }, orderBy: { id: 'asc' } })).map((p) => ({
    choferId: p.choferId,
    msAtras: AHORA.getTime() - p.registradoEn.getTime(),
  }));

const buscar = (repo: RepositorioUbicacionesIngenuo) =>
  repo.cercanos({ origen: OBELISCO, radioMetros: 5000, limite: 50, desde: new Date(AHORA.getTime() - 30_000) });

describe('retención del historial', () => {
  it('borra solo los vencidos, en lotes, y la búsqueda de la ingenua devuelve lo mismo', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    // Vencidos: más viejos que el corte (720 h).
    for (const c of [a, b]) for (const extra of [1, 60_000, 2 * HORA, 24 * HORA]) await ping(c, RETENCION + extra);
    // Vigentes para la búsqueda (últimos 30 s), recientes, y justo en el corte (no vencido: es `<`).
    await ping(a, 5_000);
    await ping(b, 10_000);
    await ping(a, 2 * HORA);
    await ping(b, RETENCION);
    await ping(a, RETENCION - 1);

    const repo = new RepositorioUbicacionesIngenuo(prisma);
    const antes = await buscar(repo);
    expect(antes.map((c) => c.choferId).sort()).toEqual([a, b].sort());

    // Lotes de 3: 8 vencidos son tres lotes (3 + 3 + 2); el último, incompleto, termina la pasada.
    const borrados = await purgarHistorial(prisma, { retencionMs: RETENCION, reloj, lote: 3 })();
    expect(borrados).toBe(8);
    const quedan = await restantes();
    expect(quedan).toHaveLength(5);
    expect(quedan.every((p) => p.msAtras <= RETENCION)).toBe(true);
    expect(await buscar(repo)).toEqual(antes);

    // Una segunda pasada no encuentra nada.
    expect(await purgarHistorial(prisma, { retencionMs: RETENCION, reloj, lote: 3 })()).toBe(0);
  });

  it('un ping viejo insertado después de uno reciente se borra en la misma pasada', async () => {
    const c = randomUUID();
    // La optimizada puede escribir tarde un ping viejo (cola recuperada): su id queda después de los recientes.
    const reciente = await ping(c, 1_000, '1-0');
    const viejoPrimero = await ping(c, RETENCION + HORA, '2-0');
    const otroReciente = await ping(c, 500, '3-0');
    const viejoTarde = await ping(c, RETENCION + 2 * HORA, '4-0');
    expect(viejoTarde > reciente && viejoTarde > otroReciente).toBe(true);

    // Lote de 1: la selección por recorded_at encuentra los dos viejos aunque haya recientes con id menor.
    expect(await purgarHistorial(prisma, { retencionMs: RETENCION, reloj, lote: 1 })()).toBe(2);
    const ids = (await prisma.ping.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((p) => p.id);
    expect(ids).toEqual([reciente, otroReciente]);
    expect(ids).not.toContain(viejoPrimero);
  });

  it('el tope de lotes corta la pasada; la siguiente sigue con lo que quedó, del más viejo al más nuevo', async () => {
    const c = randomUUID();
    for (let i = 1; i <= 7; i++) await ping(c, RETENCION + i * HORA);
    await ping(c, 1_000);

    const purgar = purgarHistorial(prisma, { retencionMs: RETENCION, reloj, lote: 2, maxLotes: 2 });
    expect(await purgar()).toBe(4);
    // Quedan los 3 vencidos más nuevos (1, 2 y 3 h después del corte) y el reciente.
    expect((await restantes()).map((p) => (p.msAtras - RETENCION) / HORA).sort((x, y) => x - y)).toEqual([
      (1_000 - RETENCION) / HORA,
      1,
      2,
      3,
    ]);
    expect(await purgar()).toBe(3);
    expect(await purgar()).toBe(0);
    expect(await restantes()).toEqual([{ choferId: c, msAtras: 1_000 }]);
  });

  it('el corte sale del reloj: con la retención mínima (1 h) no se toca nada de la última hora', async () => {
    const c = randomUUID();
    await ping(c, HORA - 1);
    await ping(c, HORA + 1);
    expect(await purgarHistorial(prisma, { retencionMs: HORA, reloj })()).toBe(1);
    expect(await restantes()).toEqual([{ choferId: c, msAtras: HORA - 1 }]);
  });
});
