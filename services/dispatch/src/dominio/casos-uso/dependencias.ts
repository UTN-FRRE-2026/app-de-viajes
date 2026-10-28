import type { GeneradorId, Reloj } from '@viajes/kernel';
import type { BuscadorCandidatos, ParametrosDespacho, RepositorioDespacho } from '../puertos/index.js';

export interface DependenciasDespacho {
  repo: RepositorioDespacho;
  buscador: BuscadorCandidatos;
  reloj: Reloj;
  ids: GeneradorId;
  parametros: ParametrosDespacho;
}
