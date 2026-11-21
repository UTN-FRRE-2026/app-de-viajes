import { ViajeFueraDeRango } from '../errores/index.js';
import type { ParametrosTarifa } from './parametros.js';

/** Lo que devuelve el puerto de mapas: enteros no negativos. */
export interface Recorrido {
  metros: number;
  segundos: number;
}

export interface DesgloseTarifa {
  bajadaCentavos: number;
  /** Distancia más tiempo, redondeados una sola vez (ver `calcularTarifa`). */
  recorridoCentavos: number;
  /** Bajada más recorrido, antes de aplicar el mínimo. */
  subtotalCentavos: number;
  minimoCentavos: number;
  /** true si el subtotal quedó por debajo del mínimo y se cobra el mínimo. */
  minimoAplicado: boolean;
}

export interface Tarifa {
  totalCentavos: number;
  desglose: DesgloseTarifa;
}

/** Denominador común: metros → km (÷1000) y segundos → minutos (÷60). 1000 × 60 / 10 = 6000. */
const DENOMINADOR = 6000n;

function exigirEnteroNoNegativo(valor: number, campo: string): bigint {
  if (!Number.isSafeInteger(valor) || valor < 0) throw new RangeError(`${campo}: tiene que ser un entero no negativo`);
  return BigInt(valor);
}

/**
 * La única función de tarifa: la usa la estimación y la va a usar la tarifa final (PR 3).
 *
 *   recorrido = metros × centavosPorKm / 1000 + segundos × centavosPorMinuto / 60
 *   total     = max(minimo, bajada + recorrido)
 *
 * Todo en enteros (BigInt), sin coma flotante en ningún paso. El recorrido se redondea **una sola
 * vez**, a centavo entero y mitad hacia arriba: distancia y tiempo se suman sobre el denominador
 * común 6000 antes de dividir. Redondear cada parte por separado podría sumar un centavo de más.
 *
 * Con 0 m y 0 s el resultado es max(mínimo, bajada).
 *
 * No rechaza recorridos largos: eso es `exigirDentroDeRango`, que en este PR se aplica a la estimación.
 * Un viaje que ya terminó siempre tiene que poder cobrarse.
 */
export function calcularTarifa(p: ParametrosTarifa, recorrido: Recorrido): Tarifa {
  const metros = exigirEnteroNoNegativo(recorrido.metros, 'metros');
  const segundos = exigirEnteroNoNegativo(recorrido.segundos, 'segundos');

  const numerador = metros * BigInt(p.centavosPorKm) * 6n + segundos * BigInt(p.centavosPorMinuto) * 100n;
  // Mitad hacia arriba para enteros no negativos: floor((2n + d) / 2d).
  const recorridoCentavos = (2n * numerador + DENOMINADOR) / (2n * DENOMINADOR);
  const subtotal = BigInt(p.bajadaCentavos) + recorridoCentavos;
  const minimo = BigInt(p.minimoCentavos);
  const minimoAplicado = subtotal < minimo;
  const total = minimoAplicado ? minimo : subtotal;

  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('la tarifa no entra en un entero seguro');
  return {
    totalCentavos: Number(total),
    desglose: {
      bajadaCentavos: p.bajadaCentavos,
      recorridoCentavos: Number(recorridoCentavos),
      subtotalCentavos: Number(subtotal),
      minimoCentavos: p.minimoCentavos,
      minimoAplicado,
    },
  };
}

/** Un recorrido de más de `maxMetros` no se estima (422). Justo en el máximo, sí. Hoy lo usa la estimación. */
export function exigirDentroDeRango(p: ParametrosTarifa, recorrido: Recorrido): void {
  if (recorrido.metros > p.maxMetros) throw new ViajeFueraDeRango(p.maxMetros);
}
