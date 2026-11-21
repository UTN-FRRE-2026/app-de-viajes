import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { relayOutboxPrisma } from '../../src/infra/tiempo-real/outbox-prisma.js';
import type { BusEventos, EventoEntregable } from '../../src/infra/tiempo-real/tipos.js';
import { levantarDispatch } from '../soporte/sistema-postgres.js';

/**
 * Varias instancias de dispatch corren el relay a la vez sobre el mismo outbox. Con
 * `FOR UPDATE SKIP LOCKED` cada una toma filas distintas: ningún evento se publica dos veces y
 * ninguna espera a otra. Comprobado sacando el lock: el test falla.
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
});

/** Un bus que solo cuenta, y tarda un poco en publicar: así las transacciones de los relays se pisan. */
function busContador() {
  const publicados: number[] = [];
  const bus: BusEventos = {
    publicar: async (e: EventoEntregable) => {
      await new Promise((r) => setTimeout(r, 2));
      publicados.push(e.seq);
    },
    suscribir: async () => async () => {},
    cerrar: async () => {},
  };
  return { bus, publicados };
}

describe('relay del outbox', () => {
  it('4 relays a la vez sobre 300 eventos: cada uno se publica exactamente una vez', async () => {
    const pasajero = randomUUID();
    await d.prisma.$executeRaw`
      INSERT INTO outbox (id, type, payload, recipients)
      SELECT gen_random_uuid(), 'NoDriversFound',
             jsonb_build_object('solicitudId', gen_random_uuid(), 'pasajeroId', ${pasajero}::text),
             ARRAY[${pasajero}::uuid]
      FROM generate_series(1, 300)`;

    const { bus, publicados } = busContador();
    const relay = relayOutboxPrisma(d.prisma, bus, 20);
    const correr = async () => {
      while ((await relay()) > 0);
    };
    await Promise.all([correr(), correr(), correr(), correr()]);

    expect(publicados).toHaveLength(300);
    expect(new Set(publicados).size).toBe(300);
    expect(await d.prisma.eventoOutbox.count({ where: { publicadoEn: null } })).toBe(0);
  });

  it('si Redis falla, no se marca nada y el próximo ciclo vuelve a publicar', async () => {
    const pasajero = randomUUID();
    await d.prisma.$executeRaw`
      INSERT INTO outbox (id, type, payload, recipients)
      VALUES (gen_random_uuid(), 'NoDriversFound', jsonb_build_object('pasajeroId', ${pasajero}::text), ARRAY[${pasajero}::uuid])`;
    const roto: BusEventos = { publicar: () => Promise.reject(new Error('redis caído')), suscribir: async () => async () => {}, cerrar: async () => {} };
    await expect(relayOutboxPrisma(d.prisma, roto)()).rejects.toThrow('redis caído');
    expect(await d.prisma.eventoOutbox.count({ where: { publicadoEn: null } })).toBe(1);

    const { bus, publicados } = busContador();
    expect(await relayOutboxPrisma(d.prisma, bus)()).toBe(1);
    expect(publicados).toHaveLength(1);
  });
});
