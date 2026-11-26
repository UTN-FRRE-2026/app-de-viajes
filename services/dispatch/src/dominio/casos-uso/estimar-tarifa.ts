import type { Coordenada } from '../entidades/index.js';
import { calcularTarifa, exigirDentroDeRango, type DesgloseTarifa } from '../tarifas/calculo.js';
import type { ProveedorTarifas, Ruta, ServicioMapas, ServicioRutas } from '../puertos/index.js';

export interface DependenciasTarifas {
  mapas: ServicioMapas;
  tarifas: ProveedorTarifas;
  /** Rutas para el mapa. Sin esto, la línea recta con el recorrido de `mapas`. */
  rutas?: ServicioRutas;
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
 * La ruta entre dos puntos para dibujarla en el mapa, sin efectos. Con el ruteo real es la misma que
 * usa la estimación (y el mismo caché), así que el número y el dibujo coinciden.
 */
export function rutaEntre(deps: DependenciasTarifas) {
  return async ({ origen, destino }: Entrada): Promise<Ruta> => {
    if (deps.rutas) return deps.rutas.ruta(origen, destino);
    const recorrido = await deps.mapas.recorrido(origen, destino);
    return {
      ...recorrido,
      puntos: [
        [origen.lat, origen.lng],
        [destino.lat, destino.lng],
      ],
      fuente: 'recta',
    };
  };
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
