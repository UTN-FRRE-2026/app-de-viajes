import type { PrismaClient } from '../db/generated/client.js';
import type { BusEventos, EventoEntregable, HistorialEventos, RelayEventos } from './tipos.js';

interface FilaOutbox {
  seq: bigint;
  type: string;
  payload: Record<string, unknown>;
  recipients: string[];
}

const aEntregable = (f: FilaOutbox): EventoEntregable => ({
  seq: Number(f.seq),
  tipo: f.type,
  payload: f.payload,
  destinatarios: f.recipients,
});

/**
 * El relay del outbox. En una transacción:
 * 1. toma un lote de eventos sin publicar, en orden, con `FOR UPDATE SKIP LOCKED`: si hay dos
 *    instancias de dispatch, cada una toma filas distintas y ninguna espera a la otra;
 * 2. los publica en Redis;
 * 3. los marca publicados y confirma.
 *
 * Entrega **al menos una vez**: si el proceso muere entre publicar y confirmar, el lote se vuelve a
 * publicar. El stream SSE descarta los repetidos por `seq`. Si Redis falla, no se marca nada y el
 * próximo ciclo reintenta.
 */
export function relayOutboxPrisma(prisma: PrismaClient, bus: BusEventos, lote = 100): RelayEventos {
  return () =>
    prisma.$transaction(async (tx) => {
      const filas = await tx.$queryRaw<FilaOutbox[]>`
        SELECT seq, type, payload, recipients::text[] AS recipients
        FROM outbox
        WHERE published_at IS NULL
        ORDER BY seq
        LIMIT ${lote}::int
        FOR UPDATE SKIP LOCKED`;
      if (filas.length === 0) return 0;
      for (const f of filas) {
        if (f.recipients.length > 0) await bus.publicar(aEntregable(f));
      }
      await tx.$executeRaw`
        UPDATE outbox SET published_at = now()
        WHERE seq = ANY(${filas.map((f) => f.seq)}::bigint[])`;
      return filas.length;
    });
}

/**
 * Lo que se perdió un cliente desconectado, leído del mismo outbox (que se conserva). Incluye
 * eventos todavía sin publicar: el stream descarta el repetido cuando el relay lo publique.
 */
export class HistorialEventosPrisma implements HistorialEventos {
  constructor(private readonly prisma: PrismaClient) {}

  async desde(usuarioId: string, desde: number, limite: number): Promise<EventoEntregable[]> {
    const filas = await this.prisma.$queryRaw<FilaOutbox[]>`
      SELECT seq, type, payload, recipients::text[] AS recipients
      FROM outbox
      WHERE recipients @> ARRAY[${usuarioId}::uuid] AND seq > ${desde}::bigint
      ORDER BY seq
      LIMIT ${limite}::int`;
    return filas.map(aEntregable);
  }
}
