import type { BuscadorCandidatos } from '../../dominio/puertos/index.js';

/**
 * Mientras no exista location (Fase 1): devuelve siempre la misma lista de choferes,
 * en orden, sin los excluidos. Sirve para la demo y para los tests.
 */
export class BuscadorCandidatosFijo implements BuscadorCandidatos {
  constructor(public choferes: string[]) {}

  async buscar(_origen: unknown, { excluir, limite }: { excluir: string[]; limite: number }) {
    const fuera = new Set(excluir);
    return this.choferes.filter((c) => !fuera.has(c)).slice(0, limite);
  }
}
