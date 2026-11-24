import type { Reloj } from '@viajes/kernel';
import type { TramoDeViaje, TramosDeViaje } from '../../dominio/puertos/index.js';
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

/** Margen de cada tramo de viaje, a los dos lados: la diferencia de reloj entre location y dispatch. */
export const MARGEN_TRAMO_MS = 120_000;

/** Choferes por consulta a dispatch (`TRAMOS_CHOFERES_MAX` de contracts). */
export const CHOFERES_POR_CONSULTA = 1000;

export interface OpcionesClasificacion {
  /** Cuánto se conserva un ping sin viaje, desde su `recorded_at`. */
  sinViajeMs: number;
  reloj: Reloj;
  tramos: TramosDeViaje;
  lote?: number;
  maxLotes?: number;
  margenMs?: number;
  choferesPorConsulta?: number;
  /** Se llama si dispatch falla: el lote se conserva y la pasada termina. */
  alFallar?: (err: unknown) => void;
}

interface FilaSinClasificar {
  id: string;
  driver_id: string;
  recorded_at: Date;
}

/**
 * Retención por viaje: los pings de un viaje se conservan hasta la retención total (30 días) y los
 * demás, `sinViajeMs` (24 h). Cada ping lleva su marca (`en_viaje`): NULL hasta que se clasifica.
 *
 * Por lote:
 * 1. elige los sin clasificar con `recorded_at` anterior a «ahora − sinViajeMs», por (recorded_at, id),
 *    sobre el índice parcial de los sin clasificar. Un ping viejo escrito tarde (historial en lotes de
 *    la optimizada) entra en la próxima pasada, porque se elige por su `recorded_at`;
 * 2. le pregunta a dispatch los tramos de esos choferes, en grupos de hasta 1000, **fuera de toda
 *    transacción** de location, con el rango ampliado por el margen (un solo timestamp también da un
 *    rango válido). Si un grupo falla, el lote entero se conserva y la pasada termina;
 * 3. en una transacción: marca `en_viaje` los que cubre un tramo (± margen) y borra los demás del lote.
 *    Dos instancias con el mismo lote llegan a lo mismo: marcar y borrar son idempotentes.
 * Devuelve cuántos borró.
 */
export function clasificarHistorial(
  prisma: PrismaClient,
  {
    sinViajeMs,
    reloj,
    tramos,
    lote = 5000,
    maxLotes = 20,
    margenMs = MARGEN_TRAMO_MS,
    choferesPorConsulta = CHOFERES_POR_CONSULTA,
    alFallar,
  }: OpcionesClasificacion,
) {
  return async (): Promise<number> => {
    const corte = new Date(reloj.ahora().getTime() - sinViajeMs);
    let total = 0;
    for (let i = 0; i < maxLotes; i++) {
      const filas = await prisma.$queryRaw<FilaSinClasificar[]>`
        SELECT id::text AS id, driver_id, recorded_at
        FROM pings
        WHERE en_viaje IS NULL AND recorded_at < ${corte}
        ORDER BY recorded_at, id
        LIMIT ${lote}::int`;
      if (filas.length === 0) break;

      // Rango del lote (viene ordenado por recorded_at), ampliado con el mismo margen que se usa para
      // clasificar. Con un solo timestamp, desde < hasta igual.
      const desde = new Date((filas[0] as FilaSinClasificar).recorded_at.getTime() - margenMs);
      const hasta = new Date((filas.at(-1) as FilaSinClasificar).recorded_at.getTime() + margenMs);
      const choferes = [...new Set(filas.map((f) => f.driver_id))];

      let encontrados: TramoDeViaje[] = [];
      try {
        for (let j = 0; j < choferes.length; j += choferesPorConsulta) {
          encontrados = encontrados.concat(await tramos.tramos(choferes.slice(j, j + choferesPorConsulta), desde, hasta));
        }
      } catch (err) {
        alFallar?.(err);
        return total;
      }

      const ids = filas.map((f) => f.id);
      const json = JSON.stringify(
        encontrados.map((t) => ({ chofer: t.choferId, inicio: t.inicio.toISOString(), fin: t.fin?.toISOString() ?? null })),
      );
      const [, borrados] = await prisma.$transaction([
        prisma.$executeRaw`
          UPDATE pings p SET en_viaje = true
          WHERE p.id = ANY(${ids}::bigint[])
            AND p.en_viaje IS NULL
            AND EXISTS (
              SELECT 1
              FROM jsonb_to_recordset(${json}::jsonb) AS t(chofer uuid, inicio timestamptz, fin timestamptz)
              WHERE t.chofer = p.driver_id
                AND p.recorded_at >= t.inicio - ${margenMs}::float8 * interval '1 millisecond'
                AND (t.fin IS NULL OR p.recorded_at <= t.fin + ${margenMs}::float8 * interval '1 millisecond')
            )`,
        prisma.$executeRaw`DELETE FROM pings WHERE id = ANY(${ids}::bigint[]) AND en_viaje IS NULL`,
      ]);
      total += borrados;
      if (filas.length < lote) break;
    }
    return total;
  };
}
