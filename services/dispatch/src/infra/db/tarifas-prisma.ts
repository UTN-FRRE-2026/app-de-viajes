import { idempotenciaPendiente, idempotenciaRegistrada, requestIdActual } from '@viajes/platform';
import type { RepositorioTarifas } from '../../dominio/puertos/index.js';
import { AUTOR_SEMILLA, type TarifaVigente, type ValoresTarifa } from '../../dominio/tarifas/parametros.js';
import { Prisma, type PrismaClient } from './generated/client.js';
import { registrarEnTransaccion } from './idempotencia-prisma.js';

interface FilaTarifa {
  version: number;
  currency: string;
  base_fare_cents: number;
  per_km_cents: number;
  per_minute_cents: number;
  minimum_cents: number;
  max_meters: number;
  created_by: string;
  created_at: Date;
}

const etiqueta = (n: number) => `v${n}`;
/** `v3` → 3; cualquier otra cosa → null (nunca llega a la consulta). */
const numeroDe = (version: string) => {
  const m = /^v([1-9][0-9]{0,8})$/.exec(version);
  return m ? Number(m[1]) : null;
};

function aTarifa(f: FilaTarifa): TarifaVigente {
  return {
    version: etiqueta(f.version),
    moneda: 'ARS',
    bajadaCentavos: f.base_fare_cents,
    centavosPorKm: f.per_km_cents,
    centavosPorMinuto: f.per_minute_cents,
    minimoCentavos: f.minimum_cents,
    maxMetros: f.max_meters,
    actualizadaPor: f.created_by,
    actualizadaEn: f.created_at,
  };
}

/** Para la auditoría: los cinco valores, siempre en el mismo orden. */
const valoresDe = (v: ValoresTarifa): ValoresTarifa => ({
  bajadaCentavos: v.bajadaCentavos,
  centavosPorKm: v.centavosPorKm,
  centavosPorMinuto: v.centavosPorMinuto,
  minimoCentavos: v.minimoCentavos,
  maxMetros: v.maxMetros,
});

export interface OpcionesTarifasPrisma {
  /**
   * Solo para tests: corre dentro de la transacción del cambio, después de escribir y antes del
   * COMMIT. Sirve para forzar un rollback o para que dos ediciones se superpongan.
   */
  dentroDelCambio?: () => Promise<void>;
}

const OPCIONES_TX = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 10_000,
  timeout: 10_000,
};

/**
 * Tarifa global versionada en Postgres (migración 20261122000000_tarifas).
 *
 * Concurrencia: `reemplazar` bloquea la única fila de `fare_current` (FOR UPDATE). Dos admins que
 * editan a la vez se serializan: el segundo espera, relee la vigente que dejó el primero y crea la
 * versión siguiente. El historial queda encadenado (lo exige también un CHECK de la base).
 */
export class RepositorioTarifasPrisma implements RepositorioTarifas {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly opciones: OpcionesTarifasPrisma = {},
  ) {}

  async versionVigente() {
    const [fila] = await this.prisma.$queryRaw<{ version: number }[]>`SELECT version FROM fare_current WHERE id`;
    return fila ? etiqueta(fila.version) : null;
  }

  async porVersion(version: string) {
    const n = numeroDe(version);
    if (n === null) return null;
    const [fila] = await this.prisma.$queryRaw<FilaTarifa[]>`SELECT * FROM fare_versions WHERE version = ${n}`;
    return fila ? aTarifa(fila) : null;
  }

  async vigente() {
    const [fila] = await this.prisma.$queryRaw<FilaTarifa[]>`
      SELECT v.* FROM fare_current c JOIN fare_versions v ON v.version = c.version WHERE c.id`;
    return fila ? aTarifa(fila) : null;
  }

  /**
   * La versión 1 solo se crea si no existe. Con dos arranques simultáneos, el segundo INSERT espera
   * al primero y termina en conflicto: no escribe nada. Una vez creada, un `.env` distinto no la pisa.
   * No registra la Idempotency-Key: eso va solo en la transacción de `reemplazar`.
   */
  async sembrar(valores: ValoresTarifa) {
    const v = valoresDe(valores);
    await this.prisma.$transaction(async (tx) => {
      const creada = await tx.$queryRaw<{ version: number }[]>`
        INSERT INTO fare_versions (version, base_fare_cents, per_km_cents, per_minute_cents, minimum_cents, max_meters, created_by)
        VALUES (1, ${v.bajadaCentavos}, ${v.centavosPorKm}, ${v.centavosPorMinuto}, ${v.minimoCentavos}, ${v.maxMetros}, ${AUTOR_SEMILLA})
        ON CONFLICT (version) DO NOTHING
        RETURNING version`;
      if (creada.length === 0) return;
      await tx.$executeRaw`
        INSERT INTO fare_changes (version, previous_version, changed_by, previous_values, new_values, request_id)
        VALUES (1, NULL, ${AUTOR_SEMILLA}, NULL, ${JSON.stringify(v)}::jsonb, ${requestIdActual() ?? null})`;
      await tx.$executeRaw`INSERT INTO fare_current (id, version) VALUES (true, 1) ON CONFLICT (id) DO NOTHING`;
    }, OPCIONES_TX);
  }

  async reemplazar(valores: ValoresTarifa, autor: string) {
    const v = valoresDe(valores);
    // Si el pedido HTTP trae Idempotency-Key, el registro va en esta misma transacción.
    const idempotencia = idempotenciaPendiente();
    const tarifa = await this.prisma.$transaction(async (tx) => {
      // Primero el lock, solo sobre `fare_current`. Con un JOIN en la misma consulta, en READ COMMITTED
      // el segundo admin, al despertar, reevalúa el JOIN contra la versión vieja y no recibe ninguna fila.
      const [vigente] = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM fare_current WHERE id FOR UPDATE`;
      const [actual] = vigente
        ? await tx.$queryRaw<FilaTarifa[]>`SELECT * FROM fare_versions WHERE version = ${vigente.version}`
        : [];
      const anterior = actual ? valoresDe(aTarifa(actual)) : null;
      const nueva = (actual?.version ?? 0) + 1;

      const [fila] = await tx.$queryRaw<FilaTarifa[]>`
        INSERT INTO fare_versions (version, base_fare_cents, per_km_cents, per_minute_cents, minimum_cents, max_meters, created_by)
        VALUES (${nueva}, ${v.bajadaCentavos}, ${v.centavosPorKm}, ${v.centavosPorMinuto}, ${v.minimoCentavos}, ${v.maxMetros}, ${autor})
        RETURNING *`;
      await tx.$executeRaw`
        INSERT INTO fare_changes (version, previous_version, changed_by, previous_values, new_values, request_id)
        VALUES (${nueva}, ${actual?.version ?? null}, ${autor},
                ${anterior ? JSON.stringify(anterior) : null}::jsonb, ${JSON.stringify(v)}::jsonb, ${requestIdActual() ?? null})`;
      await tx.$executeRaw`
        INSERT INTO fare_current (id, version, updated_at) VALUES (true, ${nueva}, now())
        ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, updated_at = EXCLUDED.updated_at`;

      await this.opciones.dentroDelCambio?.();
      const resultado = aTarifa(fila as FilaTarifa);
      if (idempotencia) await registrarEnTransaccion(tx, idempotencia, resultado);
      return resultado;
    }, OPCIONES_TX);
    if (idempotencia) idempotenciaRegistrada();
    return tarifa;
  }
}
