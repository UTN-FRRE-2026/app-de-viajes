import { TarifaInvalida } from '../errores/index.js';
import type { ProveedorTarifas, RepositorioTarifas } from '../puertos/index.js';
import { problemasDeParametros, type TarifaVigente, type ValoresTarifa } from '../tarifas/parametros.js';

export interface DependenciasTarifasAdmin {
  repoTarifas: RepositorioTarifas;
  /** Los `TARIFA_*` del entorno: solo se usan para crear la versión 1 si todavía no existe. */
  semillaTarifa: ValoresTarifa;
  tarifas: ProveedorTarifas;
}

/** La vigente; si todavía no hay ninguna, la crea con la semilla (seguro ante arranques simultáneos). */
async function vigenteOSembrar({ repoTarifas, semillaTarifa }: DependenciasTarifasAdmin): Promise<TarifaVigente> {
  const actual = await repoTarifas.vigente();
  if (actual) return actual;
  await repoTarifas.sembrar(semillaTarifa);
  const sembrada = await repoTarifas.vigente();
  if (!sembrada) throw new Error('tarifas: no hay versión vigente después de sembrar');
  return sembrada;
}

/** GET /admin/tarifas */
export function obtenerTarifa(deps: DependenciasTarifasAdmin) {
  return () => vigenteOSembrar(deps);
}

export interface EntradaConfigurar {
  valores: ValoresTarifa;
  /** Sale del token, nunca del body. */
  adminId: string;
}

/**
 * PUT /admin/tarifas: reemplaza la tarifa completa y devuelve la versión nueva. La versión, la
 * auditoría y (si hay) el registro de la Idempotency-Key se escriben en una sola transacción.
 * Recién después del COMMIT se avisa al caché; si ese aviso falla, la estimación igual lee la versión
 * vigente desde Postgres.
 */
export function configurarTarifa(deps: DependenciasTarifasAdmin) {
  return async ({ valores, adminId }: EntradaConfigurar): Promise<TarifaVigente> => {
    const problemas = problemasDeParametros({ ...valores, version: 'nueva', moneda: 'ARS' });
    if (problemas.length > 0) throw new TarifaInvalida(problemas);

    // Si es la primera vez, la versión 1 queda como semilla y esta edición es la 2: el historial
    // empieza en lo que había antes del primer cambio.
    const anterior = await vigenteOSembrar(deps);
    const nueva = await deps.repoTarifas.reemplazar(valores, adminId);
    await deps.tarifas.tarifaCambiada?.(anterior.version, nueva).catch(() => {});
    return nueva;
  };
}
