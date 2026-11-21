import { problemasDeParametros, type ValoresTarifa } from '../../dominio/tarifas/parametros.js';

/**
 * La semilla: los `TARIFA_*` del entorno. Solo se usan para crear la versión 1 si todavía no existe;
 * después manda lo que configure el admin. Si no cumplen los invariantes, lanza al componer y el
 * servicio no arranca.
 */
export function semillaDesdeConfig(valores: ValoresTarifa): ValoresTarifa {
  const problemas = problemasDeParametros({ ...valores, version: 'semilla', moneda: 'ARS' });
  if (problemas.length > 0) throw new Error(`tarifa inválida: ${problemas.join('; ')}`);
  return Object.freeze({ ...valores });
}
