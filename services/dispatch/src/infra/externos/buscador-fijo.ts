import type { BuscadorCandidatos } from '../../dominio/puertos/index.js';

/**
 * Para demos sin location (`DISPATCH_BUSCADOR=fijo`) y para los tests: devuelve siempre la misma lista
 * de choferes, en orden, como si fueran los más cercanos. Igual pasan por el filtro de flotas y zonas.
 */
export class BuscadorCandidatosFijo implements BuscadorCandidatos {
  constructor(public choferes: string[]) {}

  async buscar(_origen: unknown, { limite }: { limite: number }) {
    return { candidatos: this.choferes.slice(0, limite), completo: this.choferes.length >= limite };
  }
}
