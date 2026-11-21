import { createHash } from 'node:crypto';
import type { ProveedorTarifas } from '../../dominio/puertos/index.js';
import { problemasDeParametros, type ParametrosTarifa } from '../../dominio/tarifas/parametros.js';

export type ValoresTarifa = Omit<ParametrosTarifa, 'version' | 'moneda'>;

/**
 * Tarifa fija, leída del `.env` al arrancar. La versión es una huella de los valores: si cambian,
 * cambia la versión. En el PR 2 la reemplaza la configuración del admin, versionada en Postgres,
 * y estos valores quedan como semilla inicial.
 *
 * Si los valores no cumplen los invariantes, lanza al componer: el servicio no arranca.
 */
export function tarifasDesdeConfig(valores: ValoresTarifa): ProveedorTarifas {
  const huella = createHash('sha256').update(JSON.stringify(valores)).digest('hex').slice(0, 12);
  const parametros: ParametrosTarifa = Object.freeze({ ...valores, version: `env-${huella}`, moneda: 'ARS' });
  const problemas = problemasDeParametros(parametros);
  if (problemas.length > 0) throw new Error(`tarifa inválida: ${problemas.join('; ')}`);
  return { vigente: async () => parametros };
}
