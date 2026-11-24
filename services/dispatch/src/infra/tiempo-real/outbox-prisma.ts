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

export interface OpcionesPurgaOutbox {
  /** Cuánto se conserva un evento ya publicado. */
  retencionMs: number;
  /** Filas por DELETE: lotes chicos, para no bloquear la tabla ni generar una transacción enorme. */
  lote?: number;
  /** Lotes por pasada, como mucho. Si queda más, sigue en la próxima. */
  maxLotes?: number;
}

/**
 * Borra los eventos **ya publicados** más viejos que la retención. El outbox se conserva para reponer
 * lo que se perdió un cliente desconectado (`Last-Event-ID`); pasada la retención, ese cliente ya no
 * necesita la reposición: al reconectar relee el estado (ADR 0007). Sin esto, la tabla crece con cada
 * evento para siempre.
 *
 * - Nunca borra uno sin publicar: el relay todavía lo tiene que mandar.
 * - Por lotes, los más viejos primero (índice por `published_at`), con `FOR UPDATE SKIP LOCKED`: con
 *   varias instancias, cada una borra filas distintas, y ninguna espera al relay.
 * - La hora es la de la base (`now()`), la misma que puso `published_at`.
 *
 * Devuelve cuántos borró.
 */
export function purgarOutboxPrisma(prisma: PrismaClient, { retencionMs, lote = 1000, maxLotes = 20 }: OpcionesPurgaOutbox) {
  return async (): Promise<number> => {
    let total = 0;
    for (let i = 0; i < maxLotes; i++) {
      const borrados = await prisma.$executeRaw`
        DELETE FROM outbox
        WHERE seq IN (
          SELECT seq
          FROM outbox
          WHERE published_at IS NOT NULL
            AND published_at < now() - ${retencionMs}::float8 * interval '1 millisecond'
          ORDER BY published_at
          LIMIT ${lote}::int
          FOR UPDATE SKIP LOCKED
        )`;
      total += borrados;
      if (borrados < lote) break;
    }
    return total;
  };
}

/**
 * Lo que se perdió un cliente desconectado, leído del mismo outbox (que se conserva OUTBOX_RETENCION_HORAS). Incluye
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
