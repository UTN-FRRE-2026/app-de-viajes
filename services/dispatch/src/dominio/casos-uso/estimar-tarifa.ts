import type { Coordenada } from '../entidades/index.js';
import { calcularTarifa, exigirDentroDeRango, type DesgloseTarifa } from '../tarifas/calculo.js';
import type { ProveedorTarifas, ServicioMapas } from '../puertos/index.js';

export interface DependenciasTarifas {
  mapas: ServicioMapas;
  tarifas: ProveedorTarifas;
}

export interface Entrada {
  origen: Coordenada;
  destino: Coordenada;
}

export interface Estimacion {
  tarifaCentavos: number;
  moneda: 'ARS';
  distanciaMetros: number;
  duracionSegundos: number;
  desglose: DesgloseTarifa;
  /** Con qué parámetros se calculó: la tarifa final la va a comparar con la que esté vigente al finalizar. */
  tarifaVersion: string;
}

/**
 * Estimación de la tarifa de un viaje, sin efectos: no crea nada ni guarda nada.
 * Si mapas no responde, el adaptador falla cerrado (503) y no hay estimación.
 */
export function estimarTarifa(deps: DependenciasTarifas) {
  return async ({ origen, destino }: Entrada): Promise<Estimacion> => {
    const parametros = await deps.tarifas.vigente();
    const recorrido = await deps.mapas.recorrido(origen, destino);
    exigirDentroDeRango(parametros, recorrido);
    const { totalCentavos, desglose } = calcularTarifa(parametros, recorrido);
    return {
      tarifaCentavos: totalCentavos,
      moneda: parametros.moneda,
      distanciaMetros: recorrido.metros,
      duracionSegundos: recorrido.segundos,
      desglose,
      tarifaVersion: parametros.version,
    };
  };
}
