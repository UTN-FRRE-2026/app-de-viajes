import type { Reloj } from '@viajes/kernel';
import type { PrismaClient } from './generated/client.js';

export interface OpcionesRetencion {
  /** Cuánto se conserva cada ping, desde su `recorded_at`. */
  retencionMs: number;
  reloj: Reloj;
  /** Filas por DELETE. */
  lote?: number;
  /** Tope de lotes por pasada: acota cuánto trabaja una pasada aunque haya mucho atraso. */
  maxLotes?: number;
}

/**
 * Retención del historial de ubicaciones (`pings`, escrito por las dos estrategias). Borra los pings
 * con `recorded_at` anterior a `ahora - retencionMs`, en lotes:
 * - elige primero los vencidos por `recorded_at`, los ordena por (recorded_at, id) y recién ahí aplica
 *   el LIMIT, sobre el índice (recorded_at, id). Un ping viejo que entró tarde (el historial en lotes
 *   de la optimizada) se borra en la misma pasada, aunque tenga un id más alto que uno reciente;
 * - nunca toca un ping reciente: la búsqueda de la ingenua solo lee los últimos segundos;
 * - `FOR UPDATE SKIP LOCKED`: varias instancias pueden purgar a la vez sin esperarse;
 * - termina cuando un lote borra menos de `lote` filas, o al llegar a `maxLotes`.
 * Devuelve cuántos borró.
 */
export function purgarHistorial(prisma: PrismaClient, { retencionMs, reloj, lote = 5000, maxLotes = 20 }: OpcionesRetencion) {
  return async (): Promise<number> => {
    const corte = new Date(reloj.ahora().getTime() - retencionMs);
    let total = 0;
    for (let i = 0; i < maxLotes; i++) {
      const borrados = await prisma.$executeRaw`
        DELETE FROM pings
        WHERE id IN (
          SELECT id
          FROM pings
          WHERE recorded_at < ${corte}
          ORDER BY recorded_at, id
          LIMIT ${lote}::int
          FOR UPDATE SKIP LOCKED
        )`;
      total += borrados;
      if (borrados < lote) break;
    }
    return total;
  };
}
